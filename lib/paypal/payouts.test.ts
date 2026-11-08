import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bounty, Claim, Decision, Payout, Settings, Verdict } from "../types";
import { PayPalError } from "./client";
import {
  assertPayoutAllowed,
  bountyStatusForPayout,
  buildSenderBatchId,
  mapBatchToPayoutStatus,
  maskEmail,
  PayoutError,
  PayoutRefusedError,
  refreshPayoutStatus,
  sendBountyPayout,
  type PayoutContext,
} from "./payouts";

// ---------------------------------------------------------------------------
// In-memory fakes for the database and the PayPal client (no network, no SQLite)
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const events: string[] = [];
  const tables: Record<string, Row[]> = {};
  let counter = 0;

  const matches = (row: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === "object" && "in" in value
        ? (value as { in: unknown[] }).in.includes(row[key])
        : row[key] === value,
    );
  const find = (table: string, where?: Record<string, unknown>) =>
    (tables[table] ?? []).find((r) => matches(r, where)) ?? null;

  type Args = { where?: Record<string, unknown>; data?: Row; orderBy?: unknown };
  const prisma = {
    decision: {
      findUnique: async ({ where }: Args) => find("decision", where),
      findFirst: async ({ where }: Args) =>
        (tables.decision ?? [])
          .filter((r) => matches(r, where))
          .sort(
            (a, b) =>
              (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime() ||
              String(b.id).localeCompare(String(a.id)),
          )[0] ?? null,
    },
    bounty: {
      findUnique: async ({ where }: Args) => find("bounty", where),
      updateMany: async ({ where, data }: Args) => {
        const rows = (tables.bounty ?? []).filter((r) => matches(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
    claim: { findUnique: async ({ where }: Args) => find("claim", where) },
    verdict: { findUnique: async ({ where }: Args) => find("verdict", where) },
    settings: { findUnique: async ({ where }: Args) => find("settings", where) },
    payout: {
      findMany: async ({ where }: Args) => (tables.payout ?? []).filter((r) => matches(r, where)),
      findUnique: async ({ where }: Args) => find("payout", where),
      create: async ({ data }: Args) => {
        events.push("db:payout.create");
        if ((tables.payout ?? []).some((r) => r.senderBatchId === data?.senderBatchId)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row: Row = {
          id: `payout-${++counter}`,
          payoutBatchId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        (tables.payout ??= []).push(row);
        return row;
      },
      update: async ({ where, data }: Args) => {
        const row = find("payout", where);
        if (!row) throw new Error("not found");
        return Object.assign(row, data, { updatedAt: new Date() });
      },
      updateMany: async ({ where, data }: Args) => {
        const rows = (tables.payout ?? []).filter((r) => matches(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
  };

  type Handler = (path: string, options: { method?: string; body?: unknown; requestId?: string }) => unknown;
  const state = { handler: (async () => ({})) as Handler };
  const paypalFetch = vi.fn(async (path: string, options: Parameters<Handler>[1] = {}) => {
    events.push(`paypal:${options.method ?? "GET"} ${path}`);
    return state.handler(path, options);
  });
  const assertPayPalConfig = vi.fn();

  return { events, tables, prisma, state, paypalFetch, assertPayPalConfig, reset: () => { events.length = 0; counter = 0; for (const k of Object.keys(tables)) delete tables[k]; } };
});

vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  prisma: fake.prisma,
}));

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  paypalFetch: fake.paypalFetch,
  assertPayPalConfig: fake.assertPayPalConfig,
}));

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const NOW = new Date("2026-11-08T00:00:00Z");

function seedDb(overrides: { paused?: boolean; amountCents?: number; bountyStatus?: string } = {}) {
  fake.reset();
  fake.tables.bounty = [
    {
      id: "b1", repo: "acme/widgets", issueNumber: 12, title: "Add slugify", amountCents: overrides.amountCents ?? 2500,
      criteria: "- x", status: overrides.bountyStatus ?? "open", fundingOrderId: "ORD1", fundingCaptureId: "CAP1", createdAt: NOW,
    },
  ];
  fake.tables.claim = [
    { id: "c1", bountyId: "b1", githubUser: "alice", paypalEmail: "alice.payee@example.com", createdAt: NOW },
  ];
  fake.tables.verdict = [
    {
      id: "v1", bountyId: "b1", prNumber: 7, prUrl: "https://example.com/pr/7", prAuthor: "Alice", ciPassed: true,
      mergedByMaintainer: true, meetsCriteria: true, confidence: 0.95, unmetCriteria: "[]", summary: "ok",
      injectionFlags: "[]", model: "test", createdAt: NOW,
    },
  ];
  fake.tables.decision = [
    { id: "d1", bountyId: "b1", verdictId: "v1", outcome: "auto_pay", ruleFired: "test", decidedBy: "policy", createdAt: NOW },
  ];
  fake.tables.settings = [
    { id: "default", autoPayCapCents: 5000, contributorDailyCapCents: 10000, monthlyBudgetCents: 50000, paused: overrides.paused ?? false },
  ];
  fake.tables.payout = [];
}

const payoutRow = (extra: Record<string, unknown> = {}) => {
  const row = {
    id: "p1", bountyId: "b1", senderBatchId: "bounty-b1-pr-7", payoutBatchId: "BATCH1", amountCents: 2500,
    status: "PENDING", receiverMasked: "alice***@example.com", createdAt: NOW, updatedAt: NOW, ...extra,
  };
  fake.tables.payout.push(row);
  return row;
};

const createdResponse = (batchId = "BATCH1") => ({ batch_header: { payout_batch_id: batchId, batch_status: "PENDING" } });

const batchResponse = (opts: {
  batchId?: string; senderBatchId?: string; batchStatus?: string; itemStatus?: string | null;
  amount?: string; receiver?: string; items?: boolean;
}) => ({
  batch_header: {
    payout_batch_id: opts.batchId ?? "BATCH1",
    batch_status: opts.batchStatus ?? "SUCCESS",
    sender_batch_header: { sender_batch_id: opts.senderBatchId ?? "bounty-b1-pr-7" },
  },
  items:
    opts.items === false
      ? []
      : [
          {
            transaction_status: opts.itemStatus === null ? undefined : (opts.itemStatus ?? "SUCCESS"),
            payout_item: {
              sender_item_id: `${opts.senderBatchId ?? "bounty-b1-pr-7"}-item-1`,
              receiver: opts.receiver ?? "alice.payee@example.com",
              amount: { currency: "USD", value: opts.amount ?? "25.00" },
            },
          },
        ],
});

const paypalError = (status: number, name: string, extra: Partial<ConstructorParameters<typeof PayPalError>[0]> = {}) =>
  new PayPalError({ status, name, message: `${name} message`, debugId: "dbg1", details: [], ...extra });

const rowOf = (table: string, id: string) => fake.tables[table].find((r) => r.id === id)!;

/** The options passed to the Nth paypalFetch call (an empty object when it was called without any). */
const sentOptions = (index: number) => fake.paypalFetch.mock.calls[index][1] ?? {};

beforeEach(() => {
  seedDb();
  fake.paypalFetch.mockClear();
  fake.assertPayPalConfig.mockReset();
  fake.state.handler = async () => ({});
});

// ---------------------------------------------------------------------------
// assertPayoutAllowed (pure)
// ---------------------------------------------------------------------------

function baseCtx(): PayoutContext {
  const bounty: Bounty = {
    id: "b1", repo: "acme/widgets", issueNumber: 12, title: "t", amountUsd: 25, criteria: "c", status: "open",
    fundingOrderId: "ORD1", fundingCaptureId: "CAP1", createdAt: NOW.toISOString(),
  };
  const claim: Claim = { id: "c1", bountyId: "b1", githubUser: "alice", paypalEmail: "alice@example.com", createdAt: NOW.toISOString() };
  const verdict: Verdict = {
    id: "v1", bountyId: "b1", prNumber: 7, prUrl: "u", prAuthor: "alice", ciPassed: true, mergedByMaintainer: true,
    meetsCriteria: true, confidence: 0.9, unmetCriteria: [], summary: "s", injectionFlags: [], model: "m", createdAt: NOW.toISOString(),
  };
  const decision: Decision = { id: "d1", bountyId: "b1", verdictId: "v1", outcome: "auto_pay", ruleFired: "r", decidedBy: "policy", createdAt: NOW.toISOString() };
  const settings: Settings = { autoPayCapUsd: 50, contributorDailyCapUsd: 100, monthlyBudgetUsd: 500, paused: false };
  return { bounty, claim, verdict, decision, latestDecisionId: "d1", settings, existingPayouts: [] };
}

const payout = (status: string): Payout => ({
  id: "p", bountyId: "b1", senderBatchId: "x", payoutBatchId: null, amountUsd: 25, status,
  receiverMasked: "a***", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
});

describe("assertPayoutAllowed", () => {
  it("allows a funded bounty with an auto_pay decision, a matching claim and no payout", () => {
    expect(assertPayoutAllowed(baseCtx())).toEqual({ ok: true });
  });

  it("allows a maintainer's auto_pay decision (a needs_approval case, approved later)", () => {
    const ctx = baseCtx();
    ctx.decision = { ...ctx.decision!, decidedBy: "maintainer" };
    expect(assertPayoutAllowed(ctx)).toEqual({ ok: true });
  });

  it("compares GitHub usernames case-insensitively", () => {
    const ctx = baseCtx();
    ctx.claim = { ...ctx.claim!, githubUser: "ALICE" };
    expect(assertPayoutAllowed(ctx)).toEqual({ ok: true });
  });

  const refusals: [string, (c: PayoutContext) => void, string][] = [
    ["settings missing", (c) => { c.settings = null; }, "SETTINGS_MISSING"],
    ["paused", (c) => { c.settings = { ...c.settings!, paused: true }; }, "PAUSED"],
    ["no decision", (c) => { c.decision = null; }, "NO_DECISION"],
    ["decision for another bounty", (c) => { c.decision = { ...c.decision!, bountyId: "other" }; }, "DECISION_WRONG_BOUNTY"],
    ["decision needs_approval", (c) => { c.decision = { ...c.decision!, outcome: "needs_approval" }; }, "DECISION_NOT_AUTO_PAY"],
    ["decision blocked", (c) => { c.decision = { ...c.decision!, outcome: "blocked" }; }, "DECISION_NOT_AUTO_PAY"],
    ["a newer decision exists", (c) => { c.latestDecisionId = "d2"; }, "DECISION_SUPERSEDED"],
    ["verdict missing", (c) => { c.verdict = null; }, "VERDICT_MISMATCH"],
    ["verdict for another bounty", (c) => { c.verdict = { ...c.verdict!, bountyId: "other" }; }, "VERDICT_MISMATCH"],
    ["decision points at another verdict", (c) => { c.decision = { ...c.decision!, verdictId: "v9" }; }, "VERDICT_MISMATCH"],
    ["no claim", (c) => { c.claim = null; }, "NO_CLAIM"],
    ["claim for another bounty", (c) => { c.claim = { ...c.claim!, bountyId: "other" }; }, "NO_CLAIM"],
    ["claimant is not the PR author", (c) => { c.claim = { ...c.claim!, githubUser: "mallory" }; }, "CLAIM_AUTHOR_MISMATCH"],
    ["claim email invalid", (c) => { c.claim = { ...c.claim!, paypalEmail: "not-an-email" }; }, "CLAIM_EMAIL_INVALID"],
    ["pending payout exists", (c) => { c.existingPayouts = [payout("PENDING")]; }, "PAYOUT_ALREADY_EXISTS"],
    ["successful payout exists", (c) => { c.existingPayouts = [payout("SUCCESS")]; }, "PAYOUT_ALREADY_EXISTS"],
    ["unclaimed payout exists", (c) => { c.existingPayouts = [payout("UNCLAIMED")]; }, "PAYOUT_ALREADY_EXISTS"],
    ["not funded (no capture id)", (c) => { c.bounty = { ...c.bounty, fundingCaptureId: null }; }, "BOUNTY_NOT_FUNDED"],
    ["status awaiting_funding", (c) => { c.bounty = { ...c.bounty, status: "awaiting_funding" }; }, "BOUNTY_STATUS_NOT_PAYABLE"],
    ["status paid", (c) => { c.bounty = { ...c.bounty, status: "paid" }; }, "BOUNTY_STATUS_NOT_PAYABLE"],
    ["status rejected", (c) => { c.bounty = { ...c.bounty, status: "rejected" }; }, "BOUNTY_STATUS_NOT_PAYABLE"],
    ["status refunded", (c) => { c.bounty = { ...c.bounty, status: "refunded" }; }, "BOUNTY_STATUS_NOT_PAYABLE"],
    ["status failed", (c) => { c.bounty = { ...c.bounty, status: "failed" }; }, "BOUNTY_STATUS_NOT_PAYABLE"],
    ["zero amount", (c) => { c.bounty = { ...c.bounty, amountUsd: 0 }; }, "BAD_AMOUNT"],
  ];

  it.each(refusals)("refuses: %s", (_name, mutate, reason) => {
    const ctx = baseCtx();
    mutate(ctx);
    expect(assertPayoutAllowed(ctx)).toEqual({ ok: false, reason });
  });

  it.each(["FAILED", "RETURNED", "BLOCKED"])("does not treat a %s payout as blocking", (status) => {
    const ctx = baseCtx();
    ctx.existingPayouts = [payout(status)];
    expect(assertPayoutAllowed(ctx)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

describe("helpers", () => {
  it("builds the sender batch id from bounty and PR, with a retry suffix only after failures", () => {
    expect(buildSenderBatchId("b1", 7)).toBe("bounty-b1-pr-7");
    expect(buildSenderBatchId("b1", 7, 0)).toBe("bounty-b1-pr-7");
    expect(buildSenderBatchId("b1", 7, 2)).toBe("bounty-b1-pr-7-retry2");
  });

  it("masks emails", () => {
    expect(maskEmail("sb-abcdefghij@personal.example.com")).toBe("sb-ab***@personal.example.com");
    expect(maskEmail("abcdef@x.com")).toBe("abc***@x.com"); // short local part: at most half is shown
    expect(maskEmail("a@x.com")).toBe("***@x.com");
  });
});

// ---------------------------------------------------------------------------
// sendBountyPayout
// ---------------------------------------------------------------------------

describe("sendBountyPayout", () => {
  it("records the payout row BEFORE calling PayPal, then stores the batch id", async () => {
    fake.state.handler = async () => createdResponse("BATCH1");

    const result = await sendBountyPayout({ decisionId: "d1" });

    expect(fake.events).toEqual(["db:payout.create", "paypal:POST /v1/payments/payouts"]);
    expect(result).toEqual({ payoutId: "payout-1", payoutBatchId: "BATCH1", status: "PENDING", replayed: false });
    expect(rowOf("payout", "payout-1")).toMatchObject({
      bountyId: "b1", senderBatchId: "bounty-b1-pr-7", payoutBatchId: "BATCH1", amountCents: 2500, status: "PENDING",
      receiverMasked: "alice***@example.com",
    });
  });

  it("sends exactly what the database says: batch id, request id, amount and receiver", async () => {
    fake.state.handler = async () => createdResponse();

    await sendBountyPayout({ decisionId: "d1" });

    const path = fake.paypalFetch.mock.calls[0][0];
    const options = sentOptions(0);
    expect(path).toBe("/v1/payments/payouts");
    expect(options.requestId).toBe("bounty-b1-pr-7");
    expect(options.body).toEqual({
      sender_batch_header: expect.objectContaining({ sender_batch_id: "bounty-b1-pr-7", recipient_type: "EMAIL" }),
      items: [
        {
          amount: { value: "25.00", currency: "USD" },
          receiver: "alice.payee@example.com",
          note: expect.stringContaining("acme/widgets#12"),
          sender_item_id: "bounty-b1-pr-7-item-1",
        },
      ],
    });
  });

  it("takes the amount from the bounty row, not from anything else", async () => {
    seedDb({ amountCents: 4005 });
    fake.state.handler = async () => createdResponse();

    await sendBountyPayout({ decisionId: "d1" });

    const body = sentOptions(0).body as { items: { amount: { value: string } }[] };
    expect(body.items[0].amount.value).toBe("40.05");
    expect(rowOf("payout", "payout-1").amountCents).toBe(4005);
  });

  it.each([
    ["an unknown decision", () => {}, "missing-id", "NO_DECISION"],
    ["paused settings", () => seedDb({ paused: true }), "d1", "PAUSED"],
    ["a closed bounty", () => seedDb({ bountyStatus: "rejected" }), "d1", "BOUNTY_STATUS_NOT_PAYABLE"],
  ])("refuses %s without writing or paying anything", async (_name, setup, decisionId, reason) => {
    setup();

    const error = await sendBountyPayout({ decisionId }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PayoutRefusedError);
    expect((error as PayoutRefusedError).reason).toBe(reason);
    expect(fake.tables.payout).toEqual([]);
    expect(fake.paypalFetch).not.toHaveBeenCalled();
  });

  it("refuses an older decision once a newer one exists for the bounty", async () => {
    fake.tables.decision.push({
      id: "d2", bountyId: "b1", verdictId: "v1", outcome: "blocked", ruleFired: "later", decidedBy: "maintainer",
      createdAt: new Date(NOW.getTime() + 60_000),
    });

    const error = await sendBountyPayout({ decisionId: "d1" }).catch((e: unknown) => e);

    expect((error as PayoutRefusedError).reason).toBe("DECISION_SUPERSEDED");
    expect(fake.paypalFetch).not.toHaveBeenCalled();
  });

  it("fails before writing anything when PayPal is not configured", async () => {
    fake.assertPayPalConfig.mockImplementation(() => { throw new Error("PAYPAL_ENVIRONMENT must be SANDBOX"); });

    await expect(sendBountyPayout({ decisionId: "d1" })).rejects.toThrow(/SANDBOX/);

    expect(fake.tables.payout).toEqual([]);
    expect(fake.paypalFetch).not.toHaveBeenCalled();
  });

  it("a concurrent duplicate fails at the database and returns the existing payout, paying nothing", async () => {
    const existing = payoutRow({ payoutBatchId: null });
    // Simulate the race: this call read the payouts before the other call inserted its row.
    const realFindMany = fake.prisma.payout.findMany;
    fake.prisma.payout.findMany = async () => [];

    try {
      const result = await sendBountyPayout({ decisionId: "d1" });

      expect(result).toEqual({ payoutId: existing.id, payoutBatchId: null, status: "PENDING", replayed: true });
      expect(fake.paypalFetch).not.toHaveBeenCalled();
      expect(fake.tables.payout).toHaveLength(1);
    } finally {
      fake.prisma.payout.findMany = realFindMany;
    }
  });

  it("calling again for the same decision returns the existing payout and pays nothing", async () => {
    payoutRow({ payoutBatchId: "BATCH1", status: "SUCCESS" });

    const result = await sendBountyPayout({ decisionId: "d1" });

    expect(result).toEqual({ payoutId: "p1", payoutBatchId: "BATCH1", status: "SUCCESS", replayed: true });
    expect(fake.events).toEqual([]);
  });

  it("a fresh PENDING payout with no batch id yet is returned as in flight, not re-sent", async () => {
    payoutRow({ payoutBatchId: null, createdAt: new Date() });

    const result = await sendBountyPayout({ decisionId: "d1" });

    expect(result.replayed).toBe(true);
    expect(fake.paypalFetch).not.toHaveBeenCalled();
  });

  it("a stale PENDING payout with no batch id (we crashed) re-sends the SAME request and stores the id", async () => {
    payoutRow({ payoutBatchId: null, createdAt: new Date(Date.now() - 5 * 60_000) });
    fake.state.handler = async () => createdResponse("BATCH9");

    const result = await sendBountyPayout({ decisionId: "d1" });

    expect(fake.paypalFetch).toHaveBeenCalledTimes(1);
    expect(sentOptions(0).requestId).toBe("bounty-b1-pr-7");
    expect(result).toMatchObject({ payoutId: "p1", payoutBatchId: "BATCH9", replayed: false });
    expect(fake.tables.payout).toHaveLength(1);
  });

  describe("when PayPal says the batch id was already used", () => {
    const duplicate = () =>
      paypalError(400, "USER_BUSINESS_ERROR", {
        links: [{ href: "https://api-m.sandbox.paypal.com/v1/payments/payouts/BATCHX", rel: "original" }],
      });

    it("looks up the existing batch and stores it instead of failing", async () => {
      fake.state.handler = async (path, options) => {
        if (options.method === "POST") throw duplicate();
        expect(path).toBe("/v1/payments/payouts/BATCHX");
        return batchResponse({ batchId: "BATCHX", batchStatus: "PENDING", itemStatus: "PENDING" });
      };

      const result = await sendBountyPayout({ decisionId: "d1" });

      expect(result).toMatchObject({ payoutBatchId: "BATCHX", status: "PENDING", replayed: false });
      expect(rowOf("payout", "payout-1").payoutBatchId).toBe("BATCHX");
    });

    it("refuses to adopt a batch that is not this payout (wrong amount) and leaves the row PENDING", async () => {
      fake.state.handler = async (_path, options) => {
        if (options.method === "POST") throw duplicate();
        return batchResponse({ batchId: "BATCHX", amount: "999.00" });
      };

      const error = await sendBountyPayout({ decisionId: "d1" }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PayoutError);
      expect((error as PayoutError).code).toBe("PAYOUT_NEEDS_RECONCILIATION");
      expect(rowOf("payout", "payout-1")).toMatchObject({ status: "PENDING", payoutBatchId: null });
    });

    it("refuses to adopt a batch with a different sender_batch_id", async () => {
      fake.state.handler = async (_path, options) => {
        if (options.method === "POST") throw duplicate();
        return batchResponse({ batchId: "BATCHX", senderBatchId: "someone-elses-batch" });
      };

      const error = await sendBountyPayout({ decisionId: "d1" }).catch((e: unknown) => e);

      expect((error as PayoutError).code).toBe("PAYOUT_NEEDS_RECONCILIATION");
      expect(rowOf("payout", "payout-1").payoutBatchId).toBeNull();
    });

    it("a duplicate error with no link cannot be proven safe: row stays PENDING for a person", async () => {
      fake.state.handler = async () => {
        throw paypalError(400, "USER_BUSINESS_ERROR", {
          message: "Batch with given sender_batch_id already exists",
        });
      };

      const error = await sendBountyPayout({ decisionId: "d1" }).catch((e: unknown) => e);

      expect((error as PayoutError).code).toBe("PAYOUT_NEEDS_RECONCILIATION");
      expect(rowOf("payout", "payout-1").status).toBe("PENDING");
    });
  });

  describe("when PayPal rejects or fails the create call", () => {
    it("marks the row FAILED on a clear rejection, rethrows, and a retry uses a -retry1 batch id", async () => {
      fake.state.handler = async () => {
        throw paypalError(400, "INSUFFICIENT_FUNDS");
      };

      const error = await sendBountyPayout({ decisionId: "d1" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PayPalError);
      expect(rowOf("payout", "payout-1").status).toBe("FAILED");

      // Money did not move, so a new attempt is allowed: new batch id, new row.
      fake.state.handler = async () => createdResponse("BATCH2");
      const retry = await sendBountyPayout({ decisionId: "d1" });

      expect(sentOptions(fake.paypalFetch.mock.calls.length - 1).requestId).toBe("bounty-b1-pr-7-retry1");
      expect(retry).toMatchObject({ payoutId: "payout-2", payoutBatchId: "BATCH2", replayed: false });
    });

    it.each([
      ["a PayPal 500", () => paypalError(500, "INTERNAL_SERVER_ERROR")],
      ["a network error", () => new TypeError("fetch failed")],
    ])("%s leaves the row PENDING (the payout may exist) and reports an unknown outcome", async (_n, makeError) => {
      fake.state.handler = async () => {
        throw makeError();
      };

      const error = await sendBountyPayout({ decisionId: "d1" }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PayoutError);
      expect((error as PayoutError).code).toBe("PAYOUT_OUTCOME_UNKNOWN");
      expect(rowOf("payout", "payout-1").status).toBe("PENDING");
    });
  });
});

// ---------------------------------------------------------------------------
// refreshPayoutStatus
// ---------------------------------------------------------------------------

describe("status mapping helpers", () => {
  it("maps the item status, or the batch status when there is no item", () => {
    expect(mapBatchToPayoutStatus("SUCCESS", "success")).toBe("SUCCESS");
    expect(mapBatchToPayoutStatus("PENDING", "UNCLAIMED")).toBe("UNCLAIMED");
    expect(mapBatchToPayoutStatus("DENIED", null)).toBe("FAILED");
    expect(mapBatchToPayoutStatus("CANCELED", null)).toBe("FAILED");
    expect(mapBatchToPayoutStatus("PROCESSING", null)).toBe("PENDING");
  });

  it("only SUCCESS pays a bounty and only FAILED / RETURNED / BLOCKED fail it", () => {
    expect(bountyStatusForPayout("SUCCESS")).toBe("paid");
    for (const s of ["FAILED", "RETURNED", "BLOCKED"]) expect(bountyStatusForPayout(s)).toBe("failed");
    for (const s of ["PENDING", "UNCLAIMED", "ONHOLD", "REFUNDED", "REVERSED", "WEIRD"]) {
      expect(bountyStatusForPayout(s)).toBeNull();
    }
  });
});

describe("refreshPayoutStatus", () => {
  const cases: [string, string, string][] = [
    // PayPal item status, expected payout status, expected bounty status
    ["SUCCESS", "SUCCESS", "paid"],
    ["PENDING", "PENDING", "open"],
    ["UNCLAIMED", "UNCLAIMED", "open"],
    ["ONHOLD", "ONHOLD", "open"],
    ["FAILED", "FAILED", "failed"],
    ["RETURNED", "RETURNED", "failed"],
    ["BLOCKED", "BLOCKED", "failed"],
    ["REFUNDED", "REFUNDED", "open"],
    ["REVERSED", "REVERSED", "open"],
  ];

  it.each(cases)("item %s -> payout %s, bounty %s", async (itemStatus, payoutStatus, bountyStatus) => {
    payoutRow();
    fake.state.handler = async () => batchResponse({ itemStatus, batchStatus: "SUCCESS" });

    const result = await refreshPayoutStatus("p1");

    expect(result).toMatchObject({ payoutId: "p1", payoutBatchId: "BATCH1", status: payoutStatus });
    expect(rowOf("payout", "p1").status).toBe(payoutStatus);
    expect(rowOf("bounty", "b1").status).toBe(bountyStatus);
    expect(fake.paypalFetch.mock.calls[0][0]).toBe("/v1/payments/payouts/BATCH1");
  });

  it("with no item yet, a DENIED batch fails the payout and a PROCESSING batch keeps it pending", async () => {
    payoutRow();
    fake.state.handler = async () => batchResponse({ batchStatus: "PROCESSING", items: false });
    expect((await refreshPayoutStatus("p1")).status).toBe("PENDING");
    expect(rowOf("bounty", "b1").status).toBe("open");

    fake.state.handler = async () => batchResponse({ batchStatus: "DENIED", items: false });
    expect((await refreshPayoutStatus("p1")).status).toBe("FAILED");
    expect(rowOf("bounty", "b1").status).toBe("failed");
  });

  it("never moves a bounty out of a later state", async () => {
    for (const later of ["paid", "rejected", "refunded"]) {
      seedDb({ bountyStatus: later });
      payoutRow();
      fake.state.handler = async () => batchResponse({ itemStatus: "FAILED" });

      await refreshPayoutStatus("p1");

      expect(rowOf("bounty", "b1").status).toBe(later);
    }
  });

  it("is repeatable: refreshing a SUCCESS payout again changes nothing", async () => {
    payoutRow();
    fake.state.handler = async () => batchResponse({ itemStatus: "SUCCESS" });

    await refreshPayoutStatus("p1");
    const again = await refreshPayoutStatus("p1");

    expect(again.status).toBe("SUCCESS");
    expect(rowOf("bounty", "b1").status).toBe("paid");
  });

  it("stores an unknown PayPal item status as-is and leaves the bounty alone", async () => {
    payoutRow();
    fake.state.handler = async () => batchResponse({ itemStatus: "weird_new_status" });

    const result = await refreshPayoutStatus("p1");

    expect(result.status).toBe("WEIRD_NEW_STATUS");
    expect(rowOf("bounty", "b1").status).toBe("open");
  });

  it("does nothing at PayPal for a payout that has no batch id yet", async () => {
    payoutRow({ payoutBatchId: null });

    const result = await refreshPayoutStatus("p1");

    expect(result).toMatchObject({ payoutId: "p1", payoutBatchId: null, status: "PENDING" });
    expect(fake.paypalFetch).not.toHaveBeenCalled();
  });

  it("throws for an unknown payout id", async () => {
    await expect(refreshPayoutStatus("nope")).rejects.toThrow(/not found/i);
  });
});

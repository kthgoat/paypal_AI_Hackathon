import { beforeEach, describe, expect, it, vi } from "vitest";

import { PolicyDataError, recordPolicyDecision } from "./decisions";
import { events, fakePrisma, resetFakeDb, seedBasics, tables } from "./testing/fake-db";

vi.mock("./db", async (importOriginal) => {
  const { fakePrisma } = await import("./testing/fake-db");
  return { ...(await importOriginal<typeof import("./db")>()), prisma: fakePrisma };
});

const NOW = new Date("2026-11-15T12:00:00Z");
const bountyStatus = () => tables.bounty[0].status;
const lastDecision = () => tables.decision.at(-1)!;

beforeEach(() => seedBasics());

describe("recordPolicyDecision", () => {
  it("auto_pay: appends a policy decision and leaves the bounty 'open' for the payout step", async () => {
    const decision = await recordPolicyDecision("v1", NOW);

    expect(decision).toMatchObject({ bountyId: "b1", verdictId: "v1", outcome: "auto_pay", ruleFired: "all_checks_passed", decidedBy: "policy" });
    expect(tables.decision).toHaveLength(1);
    expect(bountyStatus()).toBe("open");
  });

  it("needs_approval: a bounty over the auto-pay cap becomes 'awaiting_approval'", async () => {
    seedBasics({ amountCents: 8000 }); // $80 > $50 cap

    const decision = await recordPolicyDecision("v1", NOW);

    expect(decision).toMatchObject({ outcome: "needs_approval", ruleFired: "over_auto_pay_cap", decidedBy: "policy" });
    expect(bountyStatus()).toBe("awaiting_approval");
  });

  it("needs_approval from a flagged verdict, from any live state", async () => {
    for (const status of ["open", "claimed", "in_review"]) {
      seedBasics({ injectionFlags: JSON.stringify(["ignore the rules"]), bountyStatus: status });
      await recordPolicyDecision("v1", NOW);
      expect(lastDecision()).toMatchObject({ outcome: "needs_approval", ruleFired: "injection_flagged" });
      expect(bountyStatus()).toBe("awaiting_approval");
    }
  });

  it("counts existing pending payouts toward the contributor's daily cap", async () => {
    // A $30 bounty is under the $50 auto-pay cap, but $71 already pending + $30 = $101 > the $100 daily cap.
    tables.payout.push({
      id: "p0", bountyId: "b1", senderBatchId: "x", payoutBatchId: "B", amountCents: 7100, status: "PENDING",
      receiverMasked: "a***", createdAt: new Date("2026-11-15T09:00:00Z"), updatedAt: NOW,
    });

    const decision = await recordPolicyDecision("v1", NOW);

    expect(decision).toMatchObject({ outcome: "needs_approval", ruleFired: "contributor_daily_cap" });
  });

  it("does not count a failed payout as spend", async () => {
    tables.payout.push({
      id: "p0", bountyId: "b1", senderBatchId: "x", payoutBatchId: "B", amountCents: 99000, status: "FAILED",
      receiverMasked: "a***", createdAt: new Date("2026-11-15T09:00:00Z"), updatedAt: NOW,
    });

    expect((await recordPolicyDecision("v1", NOW)).outcome).toBe("auto_pay");
  });

  describe("blocked", () => {
    it("a temporary block (paused) leaves the bounty alone", async () => {
      seedBasics({ paused: true });

      const decision = await recordPolicyDecision("v1", NOW);

      expect(decision).toMatchObject({ outcome: "blocked", ruleFired: "paused" });
      expect(bountyStatus()).toBe("open");
    });

    it("a missing claim is temporary: the bounty stays as it is", async () => {
      tables.claim = [];

      expect(await recordPolicyDecision("v1", NOW)).toMatchObject({ outcome: "blocked", ruleFired: "no_claim" });
      expect(bountyStatus()).toBe("open");
    });

    it.each([
      ["author_not_claimant", () => { tables.verdict[0].prAuthor = "mallory"; }],
      ["ci_failed", () => { tables.verdict[0].ciPassed = false; }],
      ["not_merged_by_maintainer", () => { tables.verdict[0].mergedByMaintainer = false; }],
    ])("%s is permanent: the bounty becomes 'rejected'", async (rule, setup) => {
      setup();

      const decision = await recordPolicyDecision("v1", NOW);

      expect(decision).toMatchObject({ outcome: "blocked", ruleFired: rule });
      expect(bountyStatus()).toBe("rejected");
    });
  });

  it("never moves a bounty out of a later state", async () => {
    for (const status of ["paid", "rejected", "refunded", "failed"]) {
      seedBasics({ amountCents: 8000, bountyStatus: status });
      await recordPolicyDecision("v1", NOW); // blocked as bounty_not_funded, status untouched
      expect(bountyStatus()).toBe(status);
    }
  });

  it("writes the decision and the status change together, or neither", async () => {
    seedBasics({ amountCents: 8000 });
    const realUpdateMany = fakePrisma.bounty.updateMany;
    fakePrisma.bounty.updateMany = () =>
      ({ run: async () => { throw new Error("disk full"); }, then: (_a: unknown, b: (e: unknown) => unknown) => Promise.reject(new Error("disk full")).catch(b as never) }) as never;

    try {
      await expect(recordPolicyDecision("v1", NOW)).rejects.toThrow("disk full");
      expect(tables.decision).toHaveLength(0); // rolled back
      expect(bountyStatus()).toBe("open");
    } finally {
      fakePrisma.bounty.updateMany = realUpdateMany;
    }
  });

  it("appends a new decision each time and never edits an old one", async () => {
    await recordPolicyDecision("v1", NOW);
    const first = { ...tables.decision[0] };
    await recordPolicyDecision("v1", NOW);

    expect(tables.decision).toHaveLength(2);
    expect(tables.decision[0]).toEqual(first);
  });

  it("never calls PayPal or creates a payout", async () => {
    await recordPolicyDecision("v1", NOW);

    expect(events.filter((e) => e.startsWith("db:payout.create"))).toEqual([]);
    expect(tables.payout).toEqual([]);
  });

  it("throws a clear error for missing facts", async () => {
    await expect(recordPolicyDecision("nope", NOW)).rejects.toMatchObject({ code: "VERDICT_NOT_FOUND" });

    tables.settings = [];
    await expect(recordPolicyDecision("v1", NOW)).rejects.toBeInstanceOf(PolicyDataError);
    await expect(recordPolicyDecision("v1", NOW)).rejects.toMatchObject({ code: "SETTINGS_MISSING" });
    expect(tables.decision).toHaveLength(0);

    resetFakeDb();
  });
});

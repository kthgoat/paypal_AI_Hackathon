import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalError, approveBounty, rejectBounty } from "./approvals";
import { PayPalError } from "./paypal/client";
import { sendBountyPayout } from "./paypal/payouts";
import { events, seedBasics, tables } from "./testing/fake-db";

vi.mock("./db", async (importOriginal) => {
  const { fakePrisma } = await import("./testing/fake-db");
  return { ...(await importOriginal<typeof import("./db")>()), prisma: fakePrisma };
});

vi.mock("./paypal/payouts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./paypal/payouts")>()),
  sendBountyPayout: vi.fn(),
}));

const sendMock = vi.mocked(sendBountyPayout);
const PAYOUT = { payoutId: "pay1", payoutBatchId: "BATCH1", status: "PENDING", replayed: false };

const bountyStatus = () => tables.bounty[0].status;
const maintainerDecisions = () => tables.decision.filter((d) => d.decidedBy === "maintainer");

/** An $80 bounty (over the $50 cap) that the policy engine held for approval. */
function seedAwaiting(over: Parameters<typeof seedBasics>[0] = {}) {
  seedBasics({ amountCents: 8000, bountyStatus: "awaiting_approval", ...over });
  tables.decision = [
    {
      id: "d1", bountyId: "b1", verdictId: "v1", outcome: "needs_approval", ruleFired: "over_auto_pay_cap",
      decidedBy: "policy", createdAt: new Date("2026-01-02T00:00:00Z"),
    },
  ];
}

beforeEach(() => {
  seedAwaiting();
  sendMock.mockReset();
  sendMock.mockImplementation(async () => {
    events.push("payout:send");
    return { ...PAYOUT };
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
});

async function rejection(promise: Promise<unknown>): Promise<ApprovalError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApprovalError);
  return error as ApprovalError;
}

describe("approveBounty", () => {
  it("appends a maintainer 'auto_pay' decision, THEN pays against that decision", async () => {
    const result = await approveBounty("b1");

    expect(events.filter((e) => e === "db:decision.create" || e === "payout:send")).toEqual(["db:decision.create", "payout:send"]);
    expect(result.decision).toMatchObject({
      id: "maintainer-approve-d1", bountyId: "b1", verdictId: "v1", outcome: "auto_pay",
      ruleFired: "maintainer_approved", decidedBy: "maintainer",
    });
    expect(sendMock).toHaveBeenCalledWith({ decisionId: "maintainer-approve-d1" });
    expect(result.payout).toEqual(PAYOUT);
    // The policy decision is untouched: decisions are append-only.
    expect(tables.decision[0]).toMatchObject({ id: "d1", outcome: "needs_approval", decidedBy: "policy" });
  });

  it("does not move the bounty out of 'awaiting_approval' (the payout settling does that)", async () => {
    await approveBounty("b1");

    expect(bountyStatus()).toBe("awaiting_approval");
  });

  it("a double click returns the same payout and records only one approval", async () => {
    sendMock.mockResolvedValueOnce({ ...PAYOUT }).mockResolvedValueOnce({ ...PAYOUT, replayed: true });

    const first = await approveBounty("b1");
    const second = await approveBounty("b1");

    expect(maintainerDecisions()).toHaveLength(1);
    expect(second.decision.id).toBe(first.decision.id);
    expect(second.payout).toMatchObject({ payoutId: "pay1", replayed: true });
    expect(sendMock.mock.calls.map((c) => c[0])).toEqual([
      { decisionId: "maintainer-approve-d1" },
      { decisionId: "maintainer-approve-d1" },
    ]);
  });

  it("two simultaneous approvals still produce one decision (the primary key decides)", async () => {
    const [a, b] = await Promise.all([approveBounty("b1"), approveBounty("b1")]);

    expect(maintainerDecisions()).toHaveLength(1);
    expect(a.decision.id).toBe(b.decision.id);
    expect(sendMock).toHaveBeenCalledTimes(2); // sendBountyPayout itself is idempotent
  });

  it("retrying after a payout error pays against the SAME approval", async () => {
    sendMock.mockRejectedValueOnce(
      new PayPalError({ status: 400, name: "INSUFFICIENT_FUNDS", message: "no money", debugId: "d", details: [] }),
    );

    await expect(approveBounty("b1")).rejects.toBeInstanceOf(PayPalError);
    expect(maintainerDecisions()).toHaveLength(1); // the approval was recorded before paying

    const retry = await approveBounty("b1");

    expect(maintainerDecisions()).toHaveLength(1);
    expect(retry.payout).toEqual(PAYOUT);
    expect(sendMock).toHaveBeenLastCalledWith({ decisionId: "maintainer-approve-d1" });
  });

  it("lets the maintainer override the soft rules: low confidence, injection flags, caps, monthly budget", async () => {
    seedAwaiting({ injectionFlags: JSON.stringify(["ignore the rules"]), confidence: 0.3 });
    tables.settings[0].monthlyBudgetCents = 100; // far below the bounty amount
    tables.settings[0].contributorDailyCapCents = 100;

    const result = await approveBounty("b1");

    expect(result.decision.outcome).toBe("auto_pay");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  describe("refuses with 409 and the rule when the policy engine now says 'blocked'", () => {
    const hardBlocks: [string, () => void, string][] = [
      ["payouts are paused", () => { tables.settings[0].paused = true; }, "paused"],
      ["the bounty is not funded", () => { tables.bounty[0].fundingCaptureId = null; }, "bounty_not_funded"],
      ["there is no claim", () => { tables.claim = []; }, "no_claim"],
      ["the claimant is not the PR author", () => { tables.claim[0].githubUser = "mallory"; }, "author_not_claimant"],
      ["CI did not pass", () => { tables.verdict[0].ciPassed = false; }, "ci_failed"],
      ["the PR was not merged by a maintainer", () => { tables.verdict[0].mergedByMaintainer = false; }, "not_merged_by_maintainer"],
    ];

    it.each(hardBlocks)("%s", async (_name, setup, rule) => {
      setup();

      const error = await rejection(approveBounty("b1"));

      expect(error).toMatchObject({ status: 409, code: "APPROVAL_BLOCKED", rule });
      expect(maintainerDecisions()).toHaveLength(0);
      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  describe("refuses with 409 when the bounty is not waiting for approval", () => {
    it.each(["open", "claimed", "in_review", "paid", "rejected", "failed", "refunded"])("status '%s'", async (status) => {
      seedAwaiting({ bountyStatus: status });

      expect(await rejection(approveBounty("b1"))).toMatchObject({ status: 409, code: "INVALID_BOUNTY_STATE" });
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("when the newest decision is not 'needs_approval'", async () => {
      tables.decision.push({
        id: "d2", bountyId: "b1", verdictId: "v1", outcome: "blocked", ruleFired: "paused", decidedBy: "policy",
        createdAt: new Date("2026-01-03T00:00:00Z"),
      });

      expect(await rejection(approveBounty("b1"))).toMatchObject({ status: 409, code: "NOT_AWAITING_APPROVAL" });
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("when there is no decision at all", async () => {
      tables.decision = [];

      expect(await rejection(approveBounty("b1"))).toMatchObject({ status: 409, code: "NOT_AWAITING_APPROVAL" });
    });

    it("after the maintainer already rejected it", async () => {
      await rejectBounty("b1");

      expect(await rejection(approveBounty("b1"))).toMatchObject({ status: 409, code: "INVALID_BOUNTY_STATE" });
      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  it("returns 404 for an unknown bounty", async () => {
    expect(await rejection(approveBounty("nope"))).toMatchObject({ status: 404, code: "BOUNTY_NOT_FOUND" });
  });

  it("logs the maintainer's note (truncated) but stores it nowhere on the decision", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    info.mockClear(); // the spy is shared, so forget calls from earlier tests

    const { decision } = await approveBounty("b1", "x".repeat(600));

    const logged = info.mock.calls.find((c) => c[0] === "[approvals] maintainer decision")![1] as { note: string };
    expect(logged.note).toHaveLength(500);
    expect(JSON.stringify(decision)).not.toContain("xxxx");
  });
});

describe("rejectBounty", () => {
  it("appends a maintainer 'blocked' decision and sets the bounty to 'rejected', without paying", async () => {
    const { decision } = await rejectBounty("b1", "not what we asked for");

    expect(decision).toMatchObject({
      id: "maintainer-reject-d1", bountyId: "b1", verdictId: "v1", outcome: "blocked",
      ruleFired: "maintainer_rejected", decidedBy: "maintainer",
    });
    expect(bountyStatus()).toBe("rejected");
    expect(sendMock).not.toHaveBeenCalled();
    expect(tables.decision[0]).toMatchObject({ id: "d1", outcome: "needs_approval" });
  });

  it("a repeat returns the same rejection and changes nothing", async () => {
    const first = await rejectBounty("b1");
    const second = await rejectBounty("b1");

    expect(second.decision.id).toBe(first.decision.id);
    expect(maintainerDecisions()).toHaveLength(1);
    expect(bountyStatus()).toBe("rejected");
  });

  it("can reject even while payouts are paused", async () => {
    tables.settings[0].paused = true;

    await rejectBounty("b1");

    expect(bountyStatus()).toBe("rejected");
  });

  it("refuses with 409 once the bounty has been approved", async () => {
    await approveBounty("b1");

    expect(await rejection(rejectBounty("b1"))).toMatchObject({ status: 409, code: "NOT_AWAITING_APPROVAL" });
    expect(bountyStatus()).toBe("awaiting_approval");
  });

  it.each(["open", "paid", "failed"])("refuses with 409 for a bounty in '%s'", async (status) => {
    seedAwaiting({ bountyStatus: status });

    expect(await rejection(rejectBounty("b1"))).toMatchObject({ status: 409, code: "INVALID_BOUNTY_STATE" });
    expect(maintainerDecisions()).toHaveLength(0);
  });

  it("returns 404 for an unknown bounty", async () => {
    expect(await rejection(rejectBounty("nope"))).toMatchObject({ status: 404, code: "BOUNTY_NOT_FOUND" });
  });
});

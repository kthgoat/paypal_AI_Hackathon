import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrContext, type PrContext } from "./github/pr-context";
import { MAX_AUTO_RETRIES, processMergeEvent, processPendingEvents, safeErrorMessage, STALE_CLAIM_MS } from "./orchestrator";
import { PayoutRefusedError, refreshPayoutStatus, sendBountyPayout } from "./paypal/payouts";
import { review } from "./reviewer";
import { seedBasics, tables } from "./testing/fake-db";

vi.mock("./db", async (importOriginal) => {
  const { fakePrisma } = await import("./testing/fake-db");
  return { ...(await importOriginal<typeof import("./db")>()), prisma: fakePrisma };
});
vi.mock("./github/pr-context", () => ({ getPrContext: vi.fn() }));
vi.mock("./reviewer", () => ({ review: vi.fn() }));
vi.mock("./paypal/payouts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./paypal/payouts")>()),
  sendBountyPayout: vi.fn(),
  refreshPayoutStatus: vi.fn(),
}));

const getContext = vi.mocked(getPrContext);
const reviewPr = vi.mocked(review);
const sendPayout = vi.mocked(sendBountyPayout);
const refresh = vi.mocked(refreshPayoutStatus);

const noWait = { sleep: async () => {}, payoutPollIntervalMs: 3000 };

const prContext = (over: Partial<PrContext> = {}): PrContext => ({
  repo: "acme/widgets", prNumber: 7, title: "Add slugify", body: "Closes #12", author: "alice", merged: true,
  mergedBy: "maintainer", mergedByMaintainer: true, baseBranch: "main", defaultBranch: "main", mergedIntoDefaultBranch: true,
  mergeCommitSha: "b".repeat(40), headSha: "a".repeat(40), linkedIssues: [12], ci: "passed", ciSummary: "3 checks passed",
  files: [], filesTruncated: false, diff: "+x", diffTruncated: false, ...over,
});

const goodReview = { meetsCriteria: true, confidence: 0.95, unmetCriteria: [], summary: "Meets the criteria", injectionFlags: [], model: "gemini-test" };

function addEvent(over: Record<string, unknown> = {}) {
  tables.gitHubMergeEvent ??= [];
  tables.gitHubMergeEvent.push({
    deliveryId: "d1", repo: "acme/widgets", prNumber: 7, prUrl: "https://github.com/acme/widgets/pull/7", prAuthor: "alice",
    mergeSha: "b".repeat(40), receivedAt: new Date("2026-02-01T00:00:00Z"), status: "received", attempts: 0, lastError: null,
    claimedAt: null, processedAt: null, verdictId: null, ...over,
  });
}
const event = (id = "d1") => tables.gitHubMergeEvent.find((e) => e.deliveryId === id)!;

function setup(over: Parameters<typeof seedBasics>[0] = {}) {
  seedBasics(over);
  tables.verdict = []; // the orchestrator makes its own
  addEvent();
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  getContext.mockReset().mockResolvedValue(prContext());
  reviewPr.mockReset().mockResolvedValue(goodReview);
  sendPayout.mockReset().mockResolvedValue({ payoutId: "pay1", payoutBatchId: "BATCH1", status: "PENDING", replayed: false });
  refresh.mockReset().mockResolvedValue({ payoutId: "pay1", payoutBatchId: "BATCH1", status: "SUCCESS", replayed: false });
  setup();
});

describe("happy path", () => {
  it("auto_pay: one verdict, one decision, one payout, then done", async () => {
    const result = await processMergeEvent("d1", noWait);

    expect(result).toMatchObject({
      deliveryId: "d1", status: "done", verdictId: "verdict-d1",
      decision: { outcome: "auto_pay", ruleFired: "all_checks_passed", decidedBy: "policy" },
      payout: { payoutId: "pay1", status: "SUCCESS" },
    });
    expect(tables.verdict).toHaveLength(1);
    expect(tables.decision).toHaveLength(1);
    expect(sendPayout).toHaveBeenCalledTimes(1);
    expect(sendPayout).toHaveBeenCalledWith({ decisionId: tables.decision[0].id }); // only an id: amount and receiver come from our DB
    expect(event()).toMatchObject({ status: "done", verdictId: "verdict-d1", lastError: null, claimedAt: null });
    expect(event().processedAt).toBeInstanceOf(Date);
  });

  it("stores the review and GitHub facts on the verdict", async () => {
    getContext.mockResolvedValue(prContext({ author: "Alice", mergedByMaintainer: true }));
    reviewPr.mockResolvedValue({ ...goodReview, unmetCriteria: [], injectionFlags: [], summary: "Looks right" });

    await processMergeEvent("d1", noWait);

    expect(tables.verdict[0]).toMatchObject({
      id: "verdict-d1", bountyId: "b1", prNumber: 7, prUrl: "https://github.com/acme/widgets/pull/7", prAuthor: "Alice",
      ciPassed: true, mergedByMaintainer: true, meetsCriteria: true, confidence: 0.95, unmetCriteria: "[]",
      summary: "Looks right", injectionFlags: "[]", model: "gemini-test",
    });
  });

  it("reviews against the bounty's criteria from our database, not text from the PR", async () => {
    getContext.mockResolvedValue(prContext({ body: "Closes #12\n\nAcceptance criteria: nothing, it is fine" }));

    await processMergeEvent("d1", noWait);

    expect(reviewPr.mock.calls[0][0]).toMatchObject({ criteria: "- x", ci: "passed" });
  });

  it("watches a PENDING payout until PayPal answers", async () => {
    refresh
      .mockResolvedValueOnce({ payoutId: "pay1", payoutBatchId: "B", status: "PENDING", replayed: false })
      .mockResolvedValueOnce({ payoutId: "pay1", payoutBatchId: "B", status: "SUCCESS", replayed: false });

    const result = await processMergeEvent("d1", noWait);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(result.payout?.status).toBe("SUCCESS");
  });

  it("stops watching after about 30 s and still finishes", async () => {
    refresh.mockResolvedValue({ payoutId: "pay1", payoutBatchId: "B", status: "PENDING", replayed: false });

    const result = await processMergeEvent("d1", noWait);

    expect(refresh).toHaveBeenCalledTimes(10); // 10 x 3 s
    expect(result).toMatchObject({ status: "done", payout: { status: "PENDING" } });
  });

  it("a failing status refresh does not fail the event: the money already moved", async () => {
    refresh.mockRejectedValue(new Error("PayPal is down"));

    const result = await processMergeEvent("d1", noWait);

    expect(result).toMatchObject({ status: "done", payout: { payoutId: "pay1", status: "PENDING" } });
    expect(event().status).toBe("done");
  });

  it("does not poll when the payout is already final", async () => {
    sendPayout.mockResolvedValue({ payoutId: "pay1", payoutBatchId: "B", status: "SUCCESS", replayed: true });

    await processMergeEvent("d1", noWait);

    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("policy keeps the final say", () => {
  it("over the auto-pay cap: needs approval, no payout", async () => {
    setup({ amountCents: 8000 });

    const result = await processMergeEvent("d1", noWait);

    expect(result).toMatchObject({ status: "done", decision: { outcome: "needs_approval", ruleFired: "over_auto_pay_cap" } });
    expect(result.payout).toBeUndefined();
    expect(sendPayout).not.toHaveBeenCalled();
    expect(tables.bounty[0].status).toBe("awaiting_approval");
  });

  it("an injection flag: needs approval, no payout", async () => {
    reviewPr.mockResolvedValue({ ...goodReview, injectionFlags: ['ignore_instructions: "ignore previous instructions"'] });

    const result = await processMergeEvent("d1", noWait);

    expect(result.decision).toMatchObject({ outcome: "needs_approval", ruleFired: "injection_flagged" });
    expect(sendPayout).not.toHaveBeenCalled();
  });

  it("CI failed: blocked and rejected, no payout", async () => {
    getContext.mockResolvedValue(prContext({ ci: "failed", ciSummary: "1 of 3 checks failed" }));

    const result = await processMergeEvent("d1", noWait);

    expect(result.decision).toMatchObject({ outcome: "blocked", ruleFired: "ci_failed" });
    expect(sendPayout).not.toHaveBeenCalled();
    expect(tables.bounty[0].status).toBe("rejected");
    expect(tables.verdict[0].ciPassed).toBe(false);
  });

  it("merged by someone without write access: blocked, no payout", async () => {
    getContext.mockResolvedValue(prContext({ mergedByMaintainer: false }));

    const result = await processMergeEvent("d1", noWait);

    expect(result.decision).toMatchObject({ outcome: "blocked", ruleFired: "not_merged_by_maintainer" });
    expect(sendPayout).not.toHaveBeenCalled();
  });

  it("a PR by someone who is not the claimant cannot collect by writing 'Closes #12'", async () => {
    getContext.mockResolvedValue(prContext({ author: "mallory" }));

    const result = await processMergeEvent("d1", noWait);

    expect(result.decision).toMatchObject({ outcome: "blocked", ruleFired: "author_not_claimant" });
    expect(sendPayout).not.toHaveBeenCalled();
    expect(tables.bounty[0].status).toBe("rejected");
  });

  it("a paused system pays nothing", async () => {
    setup({ paused: true });

    const result = await processMergeEvent("d1", noWait);

    expect(result.decision).toMatchObject({ outcome: "blocked", ruleFired: "paused" });
    expect(sendPayout).not.toHaveBeenCalled();
  });

  it.each([
    ["the model says no", { ...goodReview, meetsCriteria: false, unmetCriteria: ["tests"] }],
    ["the model is unsure", { ...goodReview, confidence: 0.5 }],
    [
      "the reviewer is unavailable",
      { meetsCriteria: false, confidence: 0, unmetCriteria: [], summary: "Review unavailable: the model did not answer within 30s", injectionFlags: [], model: "none" },
    ],
  ])("never auto-pays when %s", async (_name, verdict) => {
    reviewPr.mockResolvedValue(verdict);

    const result = await processMergeEvent("d1", noWait);

    expect(result.decision?.outcome).toBe("needs_approval");
    expect(sendPayout).not.toHaveBeenCalled();
    expect(result.status).toBe("done");
  });

  it("a reviewer that throws is an error to retry, never a payout", async () => {
    reviewPr.mockRejectedValue(new Error("unexpected"));

    const result = await processMergeEvent("d1", noWait);

    expect(result.status).toBe("failed");
    expect(sendPayout).not.toHaveBeenCalled();
    expect(tables.verdict).toHaveLength(0);
  });
});

describe("waiting for CI", () => {
  it("pending CI: waiting_ci, with no review, verdict or decision yet", async () => {
    getContext.mockResolvedValue(prContext({ ci: "pending", ciSummary: "no checks reported yet" }));

    const result = await processMergeEvent("d1", noWait);

    expect(result).toMatchObject({ status: "waiting_ci", reason: "CI not finished: no checks reported yet" });
    expect(event()).toMatchObject({ status: "waiting_ci", claimedAt: null });
    expect(reviewPr).not.toHaveBeenCalled();
    expect(tables.verdict).toHaveLength(0);
    expect(tables.decision).toHaveLength(0);
  });

  it("is picked up again once CI finishes, and then pays once", async () => {
    getContext.mockResolvedValueOnce(prContext({ ci: "pending" }));
    await processMergeEvent("d1", noWait);

    const results = await processPendingEvents(noWait); // CI is green now

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "done", decision: { outcome: "auto_pay" } });
    expect(sendPayout).toHaveBeenCalledTimes(1);
  });
});

describe("skipping events that are not bounty PRs", () => {
  it.each([
    ["no closing reference", { linkedIssues: [] }, /does not say it closes an issue/],
    ["a closing reference with no bounty", { linkedIssues: [99] }, /No bounty for acme\/widgets #99/],
    ["a PR that is not merged", { merged: false }, /not merged/],
    ["a PR merged into a non-default branch", { baseBranch: "release", mergedIntoDefaultBranch: false }, /"release", not the default branch "main"/],
  ])("%s", async (_name, ctx, reason) => {
    getContext.mockResolvedValue(prContext(ctx));

    const result = await processMergeEvent("d1", noWait);

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(reason);
    expect(event()).toMatchObject({ status: "skipped", claimedAt: null });
    expect(event().lastError).toMatch(reason);
    expect(reviewPr).not.toHaveBeenCalled();
    expect(sendPayout).not.toHaveBeenCalled();
    expect(tables.verdict).toHaveLength(0);
  });

  it("matches the repo case-insensitively", async () => {
    tables.bounty[0].repo = "Acme/Widgets";

    expect((await processMergeEvent("d1", noWait)).status).toBe("done");
  });

  it("ignores a bounty with the same issue number in another repo", async () => {
    tables.bounty[0].repo = "other/repo";

    expect((await processMergeEvent("d1", noWait)).status).toBe("skipped");
  });

  it("skips a PR that closes two bounties instead of guessing", async () => {
    tables.bounty.push({ ...tables.bounty[0], id: "b2", issueNumber: 13 });
    getContext.mockResolvedValue(prContext({ linkedIssues: [12, 13] }));

    const result = await processMergeEvent("d1", noWait);

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/closes 2 bounties/);
    expect(sendPayout).not.toHaveBeenCalled();
  });
});

describe("running it more than once", () => {
  it("processing twice makes one verdict, one decision and one payout", async () => {
    const first = await processMergeEvent("d1", noWait);
    const second = await processMergeEvent("d1", noWait);

    expect(first.status).toBe("done");
    expect(second).toMatchObject({ status: "done", verdictId: "verdict-d1" });
    expect(tables.verdict).toHaveLength(1);
    expect(tables.decision).toHaveLength(1);
    expect(sendPayout).toHaveBeenCalledTimes(1);
    expect(reviewPr).toHaveBeenCalledTimes(1);
    expect(getContext).toHaveBeenCalledTimes(1); // the second call did no work at all
  });

  it("two workers at once: one does the work, the other backs off", async () => {
    const [a, b] = await Promise.all([processMergeEvent("d1", noWait), processMergeEvent("d1", noWait)]);

    expect([a.status, b.status].sort()).toEqual(["busy", "done"]);
    expect(tables.verdict).toHaveLength(1);
    expect(tables.decision).toHaveLength(1);
    expect(sendPayout).toHaveBeenCalledTimes(1);
  });

  it("processing a skipped event again does nothing", async () => {
    getContext.mockResolvedValue(prContext({ linkedIssues: [] }));
    await processMergeEvent("d1", noWait);
    getContext.mockClear();

    const again = await processMergeEvent("d1", noWait);

    expect(again).toMatchObject({ status: "skipped", reason: expect.stringMatching(/does not say/) });
    expect(getContext).not.toHaveBeenCalled();
  });

  it("an unknown delivery is reported, not created", async () => {
    expect(await processMergeEvent("nope", noWait)).toEqual({ deliveryId: "nope", status: "not_found" });
    expect(tables.gitHubMergeEvent).toHaveLength(1);
  });

  it("a payout error fails the event; the retry reuses the verdict and decision and pays once", async () => {
    sendPayout.mockRejectedValueOnce(new Error("PayPal timeout"));

    const first = await processMergeEvent("d1", noWait);
    expect(first.status).toBe("failed");
    expect(event()).toMatchObject({ status: "failed", attempts: 1, verdictId: "verdict-d1" });
    expect(event().lastError).toMatch(/PayPal timeout/);

    const second = await processMergeEvent("d1", noWait);

    expect(second).toMatchObject({ status: "done", payout: { status: "SUCCESS" } });
    expect(tables.verdict).toHaveLength(1);
    expect(tables.decision).toHaveLength(1);
    expect(reviewPr).toHaveBeenCalledTimes(1); // not reviewed again
    expect(sendPayout).toHaveBeenCalledTimes(2); // sendBountyPayout itself replays an existing payout, so this is still one transfer
    expect(sendPayout).toHaveBeenNthCalledWith(2, { decisionId: tables.decision[0].id });
    expect(event()).toMatchObject({ status: "done", attempts: 1, lastError: null });
  });

  it("a refused payout is reported on the event", async () => {
    sendPayout.mockRejectedValue(new PayoutRefusedError("DECISION_SUPERSEDED"));

    const result = await processMergeEvent("d1", noWait);

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/PayoutRefusedError/);
  });

  it("recovers a verdict written by a run that crashed before linking it", async () => {
    tables.verdict = [
      {
        id: "verdict-d1", bountyId: "b1", prNumber: 7, prUrl: "u", prAuthor: "alice", ciPassed: true, mergedByMaintainer: true,
        meetsCriteria: true, confidence: 0.95, unmetCriteria: "[]", summary: "from the crashed run", injectionFlags: "[]",
        model: "gemini-test", createdAt: new Date(),
      },
    ];

    const result = await processMergeEvent("d1", noWait);

    expect(result.status).toBe("done");
    expect(reviewPr).not.toHaveBeenCalled();
    expect(tables.verdict).toHaveLength(1);
    expect(event().verdictId).toBe("verdict-d1");
  });

  it("recovers a decision written by a run that crashed before the payout", async () => {
    await processMergeEvent("d1", noWait);
    Object.assign(event(), { status: "failed", processedAt: null }); // as if the run died right after the decision
    sendPayout.mockClear();

    await processMergeEvent("d1", noWait);

    expect(tables.decision).toHaveLength(1);
    expect(sendPayout).toHaveBeenCalledTimes(1);
  });
});

describe("failures", () => {
  it("an error becomes failed with attempts + 1 and a reason that holds no secret", async () => {
    process.env.GITHUB_TOKEN = "ghp_supersecrettokenvalue1234567890";
    getContext.mockRejectedValue(new Error(`GitHub said no for Bearer ghp_supersecrettokenvalue1234567890`));

    const result = await processMergeEvent("d1", noWait);

    expect(result.status).toBe("failed");
    expect(event()).toMatchObject({ status: "failed", attempts: 1, claimedAt: null });
    expect(String(event().lastError)).toContain("GitHub said no");
    expect(String(event().lastError)).not.toContain("ghp_supersecret");
    expect(JSON.stringify(result)).not.toContain("ghp_supersecret");
    delete process.env.GITHUB_TOKEN;
  });

  it("attempts keep counting across failures", async () => {
    getContext.mockRejectedValue(new Error("boom"));

    await processMergeEvent("d1", noWait);
    await processMergeEvent("d1", noWait);

    expect(event()).toMatchObject({ status: "failed", attempts: 2 });
  });
});

describe("stale claims", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  it("takes over a claim left by a crashed run", async () => {
    Object.assign(event(), { status: "processing", claimedAt: minutesAgo(STALE_CLAIM_MS / 60_000 + 1) });

    expect((await processMergeEvent("d1", noWait)).status).toBe("done");
  });

  it("leaves a fresh claim alone", async () => {
    Object.assign(event(), { status: "processing", claimedAt: minutesAgo(1) });

    expect(await processMergeEvent("d1", noWait)).toMatchObject({ status: "busy" });
    expect(getContext).not.toHaveBeenCalled();
  });
});

describe("processPendingEvents", () => {
  it("handles received and waiting_ci events oldest first, and leaves finished ones alone", async () => {
    addEvent({ deliveryId: "d-waiting", prNumber: 8, mergeSha: "c".repeat(40), receivedAt: new Date("2026-01-15T00:00:00Z"), status: "waiting_ci" });
    addEvent({ deliveryId: "d-done", prNumber: 9, mergeSha: "d".repeat(40), receivedAt: new Date("2026-01-01T00:00:00Z"), status: "done" });
    addEvent({ deliveryId: "d-skipped", prNumber: 10, mergeSha: "e".repeat(40), receivedAt: new Date("2026-01-02T00:00:00Z"), status: "skipped" });
    getContext.mockResolvedValue(prContext({ linkedIssues: [] })); // keep the work trivial: every event is skipped

    const results = await processPendingEvents(noWait);

    expect(results.map((r) => r.deliveryId)).toEqual(["d-waiting", "d1"]);
    expect(results.every((r) => r.status === "skipped")).toBe(true);
    expect(event("d-done").status).toBe("done");
  });

  it("retries failed events until they have failed MAX_AUTO_RETRIES times", async () => {
    addEvent({ deliveryId: "d-retry", prNumber: 8, mergeSha: "c".repeat(40), status: "failed", attempts: MAX_AUTO_RETRIES - 1 });
    addEvent({ deliveryId: "d-gave-up", prNumber: 9, mergeSha: "d".repeat(40), status: "failed", attempts: MAX_AUTO_RETRIES });
    getContext.mockResolvedValue(prContext({ linkedIssues: [] }));

    const ids = (await processPendingEvents(noWait)).map((r) => r.deliveryId);

    expect(ids).toContain("d-retry");
    expect(ids).not.toContain("d-gave-up");
  });

  it("picks up a stale processing claim", async () => {
    Object.assign(event(), { status: "processing", claimedAt: new Date(Date.now() - STALE_CLAIM_MS - 1000) });

    expect((await processPendingEvents(noWait)).map((r) => r.deliveryId)).toEqual(["d1"]);
  });

  it("running it twice in a row pays once", async () => {
    await processPendingEvents(noWait);
    const second = await processPendingEvents(noWait);

    expect(second).toEqual([]);
    expect(sendPayout).toHaveBeenCalledTimes(1);
  });

  it("one bad event does not stop the rest", async () => {
    addEvent({ deliveryId: "d2", prNumber: 8, mergeSha: "c".repeat(40), receivedAt: new Date("2026-03-01T00:00:00Z") });
    getContext.mockRejectedValueOnce(new Error("boom"));

    const results = await processPendingEvents(noWait);

    expect(results.map((r) => r.status)).toEqual(["failed", "done"]);
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 4; i++) addEvent({ deliveryId: `x${i}`, prNumber: 20 + i, mergeSha: String(i).repeat(40), receivedAt: new Date(`2026-03-0${i + 1}T00:00:00Z`) });
    getContext.mockResolvedValue(prContext({ linkedIssues: [] }));

    expect(await processPendingEvents({ ...noWait, limit: 2 })).toHaveLength(2);
  });
});

describe("safeErrorMessage", () => {
  it.each([
    ["a GitHub token", "bad ghp_abcdefghijklmnopqrstuv here"],
    ["a fine-grained token", "bad github_pat_11ABCDEFG0123456789_abcdefghijk here"],
    ["a Google key", "key AIzaSyA-1234567890abcdefghijklmnop here"],
    ["a bearer header", "Authorization: Bearer abcdef123456 here"],
  ])("redacts %s", (_name, text) => {
    const message = safeErrorMessage(new Error(text));

    expect(message).toContain("[redacted]");
    expect(message).not.toMatch(/ghp_abc|github_pat_11|AIzaSyA|abcdef123456/);
  });

  it("redacts the configured secrets by value", () => {
    process.env.LLM_API_KEY = "my-odd-shaped-key-value";

    expect(safeErrorMessage(new Error("failed with my-odd-shaped-key-value"))).not.toContain("my-odd-shaped-key-value");
    delete process.env.LLM_API_KEY;
  });

  it("keeps it to one short line", () => {
    const message = safeErrorMessage(new Error(`line one\nline two ${"x".repeat(1000)}`));

    expect(message).not.toContain("\n");
    expect(message.length).toBeLessThanOrEqual(300);
  });
});

import { describe, expect, it } from "vitest";

import {
  decide,
  MIN_CONFIDENCE,
  PERMANENT_BLOCK_RULES,
  POLICY_RULES,
  spendTotals,
  type PolicyInput,
  type SpendRow,
} from "./policy";

const NOW = new Date("2026-11-15T12:00:00Z");

/** A bounty that passes every rule: $30, funded, claimed by the PR author, caps $50/$100/$500. */
function goodInput(): PolicyInput {
  return {
    bounty: {
      id: "b1", repo: "acme/widgets", issueNumber: 1, title: "t", amountUsd: 30, criteria: "c", status: "open",
      fundingOrderId: "ORD", fundingCaptureId: "CAP", createdAt: NOW.toISOString(),
    },
    claim: { id: "c1", bountyId: "b1", githubUser: "alice", paypalEmail: "a@example.com", createdAt: NOW.toISOString() },
    verdict: {
      id: "v1", bountyId: "b1", prNumber: 5, prUrl: "u", prAuthor: "alice", ciPassed: true, mergedByMaintainer: true,
      meetsCriteria: true, confidence: 0.95, unmetCriteria: [], summary: "s", injectionFlags: [], model: "m",
      createdAt: NOW.toISOString(),
    },
    settings: { autoPayCapUsd: 50, contributorDailyCapUsd: 100, monthlyBudgetUsd: 500, paused: false },
    spend: { contributorLast24hCents: 0, monthCents: 0 },
  };
}

type Mutate = (i: PolicyInput) => void;
const R = POLICY_RULES;

describe("decide: a clean bounty", () => {
  it("auto-pays when every check passes", () => {
    expect(decide(goodInput())).toEqual({ outcome: "auto_pay", ruleFired: R.ALL_CHECKS_PASSED });
  });
});

describe("decide: one case per rule", () => {
  const cases: [string, Mutate, "blocked" | "needs_approval", string][] = [
    ["1 paused", (i) => { i.settings.paused = true; }, "blocked", R.PAUSED],
    ["2 no capture id", (i) => { i.bounty.fundingCaptureId = null; }, "blocked", R.BOUNTY_NOT_FUNDED],
    ["2 awaiting_funding", (i) => { i.bounty.status = "awaiting_funding"; }, "blocked", R.BOUNTY_NOT_FUNDED],
    ["2 already paid", (i) => { i.bounty.status = "paid"; }, "blocked", R.BOUNTY_NOT_FUNDED],
    ["2 rejected", (i) => { i.bounty.status = "rejected"; }, "blocked", R.BOUNTY_NOT_FUNDED],
    ["2 refunded", (i) => { i.bounty.status = "refunded"; }, "blocked", R.BOUNTY_NOT_FUNDED],
    ["2 failed", (i) => { i.bounty.status = "failed"; }, "blocked", R.BOUNTY_NOT_FUNDED],
    ["3 no claim", (i) => { i.claim = null; }, "blocked", R.NO_CLAIM],
    ["3 author is not the claimant", (i) => { i.verdict.prAuthor = "mallory"; }, "blocked", R.AUTHOR_NOT_CLAIMANT],
    ["4 CI failed", (i) => { i.verdict.ciPassed = false; }, "blocked", R.CI_FAILED],
    ["4 not merged by a maintainer", (i) => { i.verdict.mergedByMaintainer = false; }, "blocked", R.NOT_MERGED_BY_MAINTAINER],
    ["5 injection flagged", (i) => { i.verdict.injectionFlags = ["ignore previous instructions"]; }, "needs_approval", R.INJECTION_FLAGGED],
    ["6 criteria not met", (i) => { i.verdict.meetsCriteria = false; }, "needs_approval", R.CRITERIA_NOT_MET],
    ["6 low confidence", (i) => { i.verdict.confidence = 0.5; }, "needs_approval", R.LOW_CONFIDENCE],
    ["6 confidence is NaN", (i) => { i.verdict.confidence = Number.NaN; }, "needs_approval", R.LOW_CONFIDENCE],
    ["7 over the auto-pay cap", (i) => { i.bounty.amountUsd = 80; }, "needs_approval", R.OVER_AUTO_PAY_CAP],
    ["8 contributor daily cap", (i) => { i.spend.contributorLast24hCents = 8_000; }, "needs_approval", R.CONTRIBUTOR_DAILY_CAP],
    ["9 monthly budget", (i) => { i.spend.monthCents = 48_000; }, "needs_approval", R.MONTHLY_BUDGET],
  ];

  it.each(cases)("%s", (_name, mutate, outcome, ruleFired) => {
    const input = goodInput();
    mutate(input);
    expect(decide(input)).toEqual({ outcome, ruleFired });
  });

  it("accepts every live bounty status", () => {
    for (const status of ["open", "claimed", "in_review", "awaiting_approval"] as const) {
      const input = goodInput();
      input.bounty.status = status;
      expect(decide(input).outcome).toBe("auto_pay");
    }
  });
});

describe("decide: rule order (the first matching rule wins)", () => {
  // Every case breaks the named rule AND at least one later rule.
  const cases: [string, Mutate, string][] = [
    ["paused beats everything", (i) => {
      i.settings.paused = true; i.bounty.fundingCaptureId = null; i.claim = null; i.verdict.ciPassed = false;
      i.verdict.injectionFlags = ["x"]; i.bounty.amountUsd = 999;
    }, R.PAUSED],
    ["unfunded beats a missing claim", (i) => { i.bounty.fundingCaptureId = null; i.claim = null; }, R.BOUNTY_NOT_FUNDED],
    ["missing claim beats failed CI", (i) => { i.claim = null; i.verdict.ciPassed = false; }, R.NO_CLAIM],
    ["wrong author beats failed CI", (i) => { i.verdict.prAuthor = "mallory"; i.verdict.ciPassed = false; }, R.AUTHOR_NOT_CLAIMANT],
    ["failed CI beats not-merged", (i) => { i.verdict.ciPassed = false; i.verdict.mergedByMaintainer = false; }, R.CI_FAILED],
    ["not-merged beats injection", (i) => { i.verdict.mergedByMaintainer = false; i.verdict.injectionFlags = ["x"]; }, R.NOT_MERGED_BY_MAINTAINER],
    ["failed CI beats injection", (i) => { i.verdict.ciPassed = false; i.verdict.injectionFlags = ["x"]; }, R.CI_FAILED],
    ["injection beats criteria-not-met", (i) => { i.verdict.injectionFlags = ["x"]; i.verdict.meetsCriteria = false; }, R.INJECTION_FLAGGED],
    ["injection beats over-cap", (i) => { i.verdict.injectionFlags = ["x"]; i.bounty.amountUsd = 80; }, R.INJECTION_FLAGGED],
    ["criteria-not-met beats low confidence", (i) => { i.verdict.meetsCriteria = false; i.verdict.confidence = 0.1; }, R.CRITERIA_NOT_MET],
    ["low confidence beats over-cap", (i) => { i.verdict.confidence = 0.1; i.bounty.amountUsd = 80; }, R.LOW_CONFIDENCE],
    ["over-cap beats the daily cap", (i) => { i.bounty.amountUsd = 80; i.spend.contributorLast24hCents = 50_000; }, R.OVER_AUTO_PAY_CAP],
    ["daily cap beats the monthly budget", (i) => {
      i.spend.contributorLast24hCents = 8_000; i.spend.monthCents = 49_000;
    }, R.CONTRIBUTOR_DAILY_CAP],
  ];

  it.each(cases)("%s", (_name, mutate, ruleFired) => {
    const input = goodInput();
    mutate(input);
    expect(decide(input).ruleFired).toBe(ruleFired);
  });
});

describe("decide: boundaries", () => {
  it("allows an amount exactly at the auto-pay cap, and refuses one cent over", () => {
    const input = goodInput();
    input.bounty.amountUsd = 50;
    expect(decide(input)).toEqual({ outcome: "auto_pay", ruleFired: R.ALL_CHECKS_PASSED });
    input.bounty.amountUsd = 50.01;
    expect(decide(input)).toEqual({ outcome: "needs_approval", ruleFired: R.OVER_AUTO_PAY_CAP });
  });

  it("allows confidence of exactly 0.8, and refuses anything just below", () => {
    const input = goodInput();
    input.verdict.confidence = MIN_CONFIDENCE;
    expect(decide(input).outcome).toBe("auto_pay");
    input.verdict.confidence = 0.7999;
    expect(decide(input)).toEqual({ outcome: "needs_approval", ruleFired: R.LOW_CONFIDENCE });
  });

  it("allows landing exactly on the contributor's daily cap, and refuses one cent over", () => {
    const input = goodInput(); // $30 bounty, $100 daily cap
    input.spend.contributorLast24hCents = 7_000; // 70 + 30 = exactly 100
    expect(decide(input).outcome).toBe("auto_pay");
    input.spend.contributorLast24hCents = 7_001;
    expect(decide(input)).toEqual({ outcome: "needs_approval", ruleFired: R.CONTRIBUTOR_DAILY_CAP });
  });

  it("allows landing exactly on the monthly budget, and refuses one cent over", () => {
    const input = goodInput(); // $30 bounty, $500 budget
    input.spend.monthCents = 47_000; // 470 + 30 = exactly 500
    expect(decide(input).outcome).toBe("auto_pay");
    input.spend.monthCents = 47_001;
    expect(decide(input)).toEqual({ outcome: "needs_approval", ruleFired: R.MONTHLY_BUDGET });
  });

  it("compares dollars in whole cents, so float noise cannot tip a limit", () => {
    const input = goodInput();
    input.settings.autoPayCapUsd = 0.3;
    input.bounty.amountUsd = 0.1 + 0.2; // 0.30000000000000004
    expect(decide(input).outcome).toBe("auto_pay");
  });

  it("matches the claimant to the PR author case-insensitively (and ignores stray spaces)", () => {
    for (const [claimUser, prAuthor] of [["Alice", "alice"], ["alice", "ALICE"], [" alice ", "Alice"]]) {
      const input = goodInput();
      input.claim!.githubUser = claimUser;
      input.verdict.prAuthor = prAuthor;
      expect(decide(input).outcome).toBe("auto_pay");
    }
  });
});

describe("PERMANENT_BLOCK_RULES", () => {
  it("lists exactly the blocks a later change cannot fix", () => {
    expect([...PERMANENT_BLOCK_RULES].sort()).toEqual(
      [R.AUTHOR_NOT_CLAIMANT, R.CI_FAILED, R.NOT_MERGED_BY_MAINTAINER].sort(),
    );
  });
});

describe("spendTotals", () => {
  const row = (over: Partial<SpendRow>): SpendRow => ({
    githubUser: "alice", amountCents: 1_000, status: "SUCCESS", createdAt: new Date("2026-11-15T10:00:00Z"), ...over,
  });

  it("counts paid and pending payouts, but not FAILED / RETURNED / BLOCKED", () => {
    const rows = [
      row({ status: "SUCCESS", amountCents: 100 }),
      row({ status: "PENDING", amountCents: 200 }),
      row({ status: "UNCLAIMED", amountCents: 400 }),
      row({ status: "ONHOLD", amountCents: 800 }),
      row({ status: "FAILED", amountCents: 10_000 }),
      row({ status: "RETURNED", amountCents: 20_000 }),
      row({ status: "BLOCKED", amountCents: 40_000 }),
    ];
    expect(spendTotals(rows, "alice", NOW)).toEqual({ contributorLast24hCents: 1_500, monthCents: 1_500 });
  });

  it("counts only this contributor in the 24 h figure but everyone in the month figure", () => {
    const rows = [row({ githubUser: "alice", amountCents: 300 }), row({ githubUser: "bob", amountCents: 700 })];
    expect(spendTotals(rows, "alice", NOW)).toEqual({ contributorLast24hCents: 300, monthCents: 1_000 });
  });

  it("matches the contributor case-insensitively", () => {
    expect(spendTotals([row({ githubUser: "Alice", amountCents: 300 })], "ALICE", NOW).contributorLast24hCents).toBe(300);
  });

  it("uses a rolling 24 hours: just inside counts, exactly 24 h ago does not", () => {
    const inside = row({ createdAt: new Date(NOW.getTime() - 24 * 3600_000 + 1), amountCents: 100 });
    const edge = row({ createdAt: new Date(NOW.getTime() - 24 * 3600_000), amountCents: 200 });
    expect(spendTotals([inside, edge], "alice", NOW).contributorLast24hCents).toBe(100);
  });

  it("uses the UTC calendar month", () => {
    const rows = [
      row({ createdAt: new Date("2026-10-31T23:59:59Z"), amountCents: 100 }), // October
      row({ createdAt: new Date("2026-11-01T00:00:00Z"), amountCents: 200 }), // first instant of November
      row({ createdAt: new Date("2026-12-01T00:00:00Z"), amountCents: 400 }), // December
    ];
    expect(spendTotals(rows, "nobody", NOW).monthCents).toBe(200);
  });

  it("counts a 24 h payout that falls in last month toward the contributor but not the month", () => {
    const early = new Date("2026-11-01T02:00:00Z");
    const rows = [row({ createdAt: new Date("2026-10-31T23:00:00Z"), amountCents: 500 })];
    expect(spendTotals(rows, "alice", early)).toEqual({ contributorLast24hCents: 500, monthCents: 0 });
  });

  it("ignores payouts with no claimant for the contributor figure", () => {
    const totals = spendTotals([row({ githubUser: null, amountCents: 900 })], "alice", NOW);
    expect(totals).toEqual({ contributorLast24hCents: 0, monthCents: 900 });
  });

  it("reads from a Prisma-like client, asking only for non-failed payouts since the earlier window start", async () => {
    const calls: unknown[] = [];
    const db = {
      payout: {
        findMany: async (args: unknown) => {
          calls.push(args);
          return [
            {
              amountCents: 700, status: "PENDING", createdAt: new Date("2026-11-15T09:00:00Z"),
              bounty: { claim: { githubUser: "alice" } },
            },
            { amountCents: 300, status: "SUCCESS", createdAt: new Date("2026-11-02T09:00:00Z"), bounty: { claim: null } },
          ];
        },
      },
    };

    const totals = await spendTotals(db, "alice", NOW);

    expect(totals).toEqual({ contributorLast24hCents: 700, monthCents: 1_000 });
    expect(calls[0]).toMatchObject({
      where: { createdAt: { gte: new Date("2026-11-01T00:00:00Z") }, status: { notIn: ["FAILED", "RETURNED", "BLOCKED"] } },
    });
  });
});

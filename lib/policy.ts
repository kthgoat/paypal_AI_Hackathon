// The policy engine: plain code that decides whether a bounty payout is allowed.
//
// decide() is a PURE function (no database, no network, no clock) so every rule is easy to
// test. The caller loads the facts and passes them in, including the spend totals.
//
// An LLM reviewer can only feed this engine facts (the Verdict). It can never approve a
// payout itself: the most it can do is push a payout to 'needs_approval'.

import { FAILED_PAYOUT_STATUSES } from "./payout-status";
import type { Bounty, BountyStatus, Claim, DecisionOutcome, Settings, Verdict } from "./types";

// ---------------------------------------------------------------------------
// Rule codes (stored in Decision.ruleFired)
// ---------------------------------------------------------------------------

export const POLICY_RULES = {
  // blocked
  PAUSED: "paused",
  BOUNTY_NOT_FUNDED: "bounty_not_funded",
  NO_CLAIM: "no_claim",
  AUTHOR_NOT_CLAIMANT: "author_not_claimant",
  CI_FAILED: "ci_failed",
  NOT_MERGED_BY_MAINTAINER: "not_merged_by_maintainer",
  // needs_approval
  INJECTION_FLAGGED: "injection_flagged",
  CRITERIA_NOT_MET: "criteria_not_met",
  LOW_CONFIDENCE: "low_confidence",
  OVER_AUTO_PAY_CAP: "over_auto_pay_cap",
  CONTRIBUTOR_DAILY_CAP: "contributor_daily_cap",
  MONTHLY_BUDGET: "monthly_budget",
  // auto_pay
  ALL_CHECKS_PASSED: "all_checks_passed",
  // written by the maintainer approvals route, not by decide()
  MAINTAINER_APPROVED: "maintainer_approved",
  MAINTAINER_REJECTED: "maintainer_rejected",
} as const;

export type PolicyRule = (typeof POLICY_RULES)[keyof typeof POLICY_RULES];

/** Blocked for these rules means the bounty can never be paid, so it becomes 'rejected'. */
export const PERMANENT_BLOCK_RULES: readonly PolicyRule[] = [
  POLICY_RULES.AUTHOR_NOT_CLAIMANT,
  POLICY_RULES.CI_FAILED,
  POLICY_RULES.NOT_MERGED_BY_MAINTAINER,
];

/** The reviewer must be at least this confident. Exactly 0.8 passes. */
export const MIN_CONFIDENCE = 0.8;

/**
 * Bounty states a decision can still be made in: funded and not yet closed. 'awaiting_approval'
 * is included so a maintainer's approval can re-check the same bounty. Anything else (not funded,
 * paid, rejected, refunded, failed) is blocked.
 */
const DECIDABLE_STATUSES: readonly BountyStatus[] = ["open", "claimed", "in_review", "awaiting_approval"];

// ---------------------------------------------------------------------------
// decide()
// ---------------------------------------------------------------------------

export interface SpendTotals {
  /** This contributor's non-failed payouts created in the last 24 hours, in cents. */
  contributorLast24hCents: number;
  /** Everyone's non-failed payouts created this calendar month (UTC), in cents. */
  monthCents: number;
}

export interface PolicyInput {
  bounty: Bounty;
  claim: Claim | null;
  verdict: Verdict;
  settings: Settings;
  spend: SpendTotals;
}

export interface PolicyResult {
  outcome: DecisionOutcome;
  ruleFired: PolicyRule;
}

// Same arithmetic as usdToCents in lib/db.ts, kept local so this file never imports the database.
const toCents = (usd: number) => Math.round(usd * 100);

/** Rules in order, first match wins. */
export function decide(input: PolicyInput): PolicyResult {
  const { bounty, claim, verdict, settings, spend } = input;
  const R = POLICY_RULES;
  const blocked = (ruleFired: PolicyRule): PolicyResult => ({ outcome: "blocked", ruleFired });
  const needsApproval = (ruleFired: PolicyRule): PolicyResult => ({ outcome: "needs_approval", ruleFired });

  // 1. Kill switch.
  if (settings.paused) return blocked(R.PAUSED);

  // 2. The bounty must be funded and still live.
  if (!bounty.fundingCaptureId || !DECIDABLE_STATUSES.includes(bounty.status)) {
    return blocked(R.BOUNTY_NOT_FUNDED);
  }

  // 3. Someone must have claimed it, and they must be the PR's author (GitHub names ignore case).
  if (!claim) return blocked(R.NO_CLAIM);
  if (claim.githubUser.trim().toLowerCase() !== verdict.prAuthor.trim().toLowerCase()) {
    return blocked(R.AUTHOR_NOT_CLAIMANT);
  }

  // 4. Hard facts about the pull request.
  if (!verdict.ciPassed) return blocked(R.CI_FAILED);
  if (!verdict.mergedByMaintainer) return blocked(R.NOT_MERGED_BY_MAINTAINER);

  // 5-6. Anything the reviewer is unsure about goes to a human. (`!(x >= y)` also catches NaN.)
  if (verdict.injectionFlags.length > 0) return needsApproval(R.INJECTION_FLAGGED);
  if (!verdict.meetsCriteria) return needsApproval(R.CRITERIA_NOT_MET);
  if (!(verdict.confidence >= MIN_CONFIDENCE)) return needsApproval(R.LOW_CONFIDENCE);

  // 7-9. Money limits. Landing exactly on a limit is allowed; one cent over is not.
  const amount = toCents(bounty.amountUsd);
  if (amount > toCents(settings.autoPayCapUsd)) return needsApproval(R.OVER_AUTO_PAY_CAP);
  if (spend.contributorLast24hCents + amount > toCents(settings.contributorDailyCapUsd)) {
    return needsApproval(R.CONTRIBUTOR_DAILY_CAP);
  }
  if (spend.monthCents + amount > toCents(settings.monthlyBudgetUsd)) {
    return needsApproval(R.MONTHLY_BUDGET);
  }

  // 10.
  return { outcome: "auto_pay", ruleFired: R.ALL_CHECKS_PASSED };
}

// ---------------------------------------------------------------------------
// spendTotals()
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** One payout joined to its contributor (the claim's GitHub user on the payout's bounty). */
export interface SpendRow {
  githubUser: string | null;
  amountCents: number;
  status: string;
  createdAt: Date;
}

/** The slice of the Prisma client spendTotals needs. The real `prisma` satisfies it. */
export interface SpendDb {
  payout: {
    findMany(args: {
      where: { createdAt: { gte: Date }; status: { notIn: string[] } };
      include: { bounty: { include: { claim: true } } };
    }): PromiseLike<
      {
        amountCents: number;
        status: string;
        createdAt: Date;
        bounty: { claim: { githubUser: string } | null };
      }[]
    >;
  };
}

function totalsFromRows(rows: SpendRow[], contributor: string, now: Date): SpendTotals {
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const nextMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const dayStart = now.getTime() - DAY_MS;
  const who = contributor.trim().toLowerCase();

  let contributorLast24hCents = 0;
  let monthCents = 0;
  for (const row of rows) {
    if (FAILED_PAYOUT_STATUSES.has(row.status)) continue; // money that never arrived is not spend
    const at = row.createdAt.getTime();
    if (at >= monthStart && at < nextMonthStart) monthCents += row.amountCents;
    if (who && at > dayStart && row.githubUser?.trim().toLowerCase() === who) {
      contributorLast24hCents += row.amountCents;
    }
  }
  return { contributorLast24hCents, monthCents };
}

/**
 * Spend so far, in cents. Counts paid AND pending payouts, but not FAILED / RETURNED / BLOCKED.
 * A payout counts from the moment it is created.
 *
 * Pass the payout rows (pure, for tests) or the Prisma client (loads what it needs).
 */
export function spendTotals(rows: SpendRow[], contributor: string, now: Date): SpendTotals;
export function spendTotals(db: SpendDb, contributor: string, now: Date): Promise<SpendTotals>;
export function spendTotals(
  source: SpendRow[] | SpendDb,
  contributor: string,
  now: Date,
): SpendTotals | Promise<SpendTotals> {
  if (Array.isArray(source)) return totalsFromRows(source, contributor, now);

  // The 24 h window can start before the first of the month, so read from whichever is earlier.
  const since = new Date(
    Math.min(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), now.getTime() - DAY_MS),
  );
  return Promise.resolve(
    source.payout.findMany({
      where: { createdAt: { gte: since }, status: { notIn: [...FAILED_PAYOUT_STATUSES] } },
      include: { bounty: { include: { claim: true } } },
    }),
  ).then((payouts) =>
    totalsFromRows(
      payouts.map((p) => ({
        githubUser: p.bounty.claim?.githubUser ?? null,
        amountCents: p.amountCents,
        status: p.status,
        createdAt: p.createdAt,
      })),
      contributor,
      now,
    ),
  );
}

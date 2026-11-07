import type { Bounty, Decision, Payout, Settings, Verdict } from "./types";

// keep paypal emails out of browser data
export interface DashboardSnapshot {
  bounties: Bounty[];
  contributors: { bountyId: string; githubUser: string }[];
  verdicts: Verdict[];
  decisions: Decision[];
  payouts: Payout[];
  settings: Settings;
  asOf: string;
}

export interface LedgerRow {
  id: string;
  title: string;
  repo: string;
  issue: number;
  contributor: string;
  amount: number;
  status: string;
  verdict?: Verdict;
  decision?: Decision;
  payout?: Payout;
}

function latest<T extends { createdAt: string }>(rows: T[]): T | undefined {
  return rows.reduce<T | undefined>(
    (result, row) =>
      !result || row.createdAt > result.createdAt ? row : result,
    undefined,
  );
}

export function ledgerRows(data: DashboardSnapshot): LedgerRow[] {
  return data.bounties.map((bounty) => ({
    id: bounty.id,
    title: bounty.title,
    repo: bounty.repo,
    issue: bounty.issueNumber,
    contributor:
      data.contributors.find((claim) => claim.bountyId === bounty.id)
        ?.githubUser ?? "Unclaimed",
    amount: bounty.amountUsd,
    status: bounty.status,
    verdict: latest(
      data.verdicts.filter((verdict) => verdict.bountyId === bounty.id),
    ),
    decision: latest(
      data.decisions.filter((decision) => decision.bountyId === bounty.id),
    ),
    payout: latest(
      data.payouts.filter((payout) => payout.bountyId === bounty.id),
    ),
  }));
}

export function summarize(data: DashboardSnapshot) {
  const month = data.asOf.slice(0, 7);
  const successful = data.payouts.filter(
    (payout) => payout.status === "SUCCESS",
  );
  const cents = successful
    .filter((payout) => payout.updatedAt.startsWith(month))
    .reduce((total, payout) => total + Math.round(payout.amountUsd * 100), 0);
  const pending = data.bounties.filter(
    (bounty) => bounty.status === "awaiting_approval",
  );
  return {
    spent: cents / 100,
    paidCount: successful.length,
    pendingCount: pending.length,
    pendingAmount:
      pending.reduce(
        (total, bounty) => total + Math.round(bounty.amountUsd * 100),
        0,
      ) / 100,
    activeCount: data.bounties.filter((bounty) =>
      ["open", "claimed", "in_review"].includes(bounty.status),
    ).length,
    budgetRemaining: data.settings.monthlyBudgetUsd - cents / 100,
  };
}

export function approvalBlocker(
  row: LedgerRow,
  paused: boolean,
): string | undefined {
  if (paused) return "Payouts are paused. Resume before approving.";
  if (!row.verdict) return "Waiting for a reviewer verdict.";
  if (!row.verdict.ciPassed) return "Required CI checks must pass.";
  if (!row.verdict.mergedByMaintainer)
    return "A maintainer must merge the PR first.";
  if (row.verdict.injectionFlags.length)
    return "Flagged instructions require investigation before approval.";
  if (row.decision?.outcome === "blocked")
    return "The policy engine blocked this payout.";
  if (
    row.payout &&
    ["PENDING", "SUCCESS", "UNCLAIMED", "ONHOLD"].includes(row.payout.status)
  )
    return "A payout already exists for this bounty.";
}

export const money = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);

export const statusLabel = (value: string) =>
  ({
    awaiting_funding: "Awaiting funding",
    open: "Open",
    claimed: "Claimed",
    in_review: "In review",
    awaiting_approval: "Needs approval",
    paid: "Paid",
    rejected: "Rejected",
    refunded: "Refunded",
    failed: "Failed",
  })[value] ?? value;

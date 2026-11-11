// Turns a Verdict into a Decision by running the policy engine, and records it.
//
// This file never calls PayPal. It only writes a Decision row (and moves the bounty's status).
// Paying is a separate step (lib/paypal/payouts.ts), and it only happens for an allowing Decision.
//
// Decisions are append-only: to change an outcome, write a NEW Decision. The newest one counts.

import { prisma, toBounty, toClaim, toDecision, toSettings, toVerdict } from "./db";
import { decide, PERMANENT_BLOCK_RULES, spendTotals, type PolicyInput, type PolicyResult } from "./policy";
import type { BountyStatus, Decision } from "./types";

/** The facts a decision needs are missing from the database. */
export class PolicyDataError extends Error {
  readonly code: "VERDICT_NOT_FOUND" | "BOUNTY_NOT_FOUND" | "SETTINGS_MISSING";
  constructor(code: PolicyDataError["code"], message: string) {
    super(message);
    this.name = "PolicyDataError";
    this.code = code;
  }
}

/** The newest Decision for a bounty: the only one that counts (same ordering as payouts.ts). */
export function latestDecisionRow(bountyId: string) {
  return prisma.decision.findFirst({
    where: { bountyId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

/** Loads everything decide() needs for a verdict, including spend totals. Amounts come from the database. */
export async function loadPolicyInput(verdictId: string, now: Date = new Date()): Promise<PolicyInput> {
  const verdictRow = await prisma.verdict.findUnique({ where: { id: verdictId } });
  if (!verdictRow) throw new PolicyDataError("VERDICT_NOT_FOUND", "Verdict not found");

  const [bountyRow, claimRow, settingsRow] = await Promise.all([
    prisma.bounty.findUnique({ where: { id: verdictRow.bountyId } }),
    prisma.claim.findUnique({ where: { bountyId: verdictRow.bountyId } }),
    prisma.settings.findUnique({ where: { id: "default" } }),
  ]);
  if (!bountyRow) throw new PolicyDataError("BOUNTY_NOT_FOUND", "Bounty not found");
  if (!settingsRow) throw new PolicyDataError("SETTINGS_MISSING", "Payout settings are missing");

  const claim = claimRow ? toClaim(claimRow) : null;
  return {
    bounty: toBounty(bountyRow),
    claim,
    verdict: toVerdict(verdictRow),
    settings: toSettings(settingsRow),
    spend: await spendTotals(prisma, claim?.githubUser ?? "", now),
  };
}

/** How the bounty's status should move for a result, or null to leave it alone. */
function statusMove(result: PolicyResult): { to: BountyStatus; from: BountyStatus[] } | null {
  if (result.outcome === "needs_approval") {
    return { to: "awaiting_approval", from: ["open", "claimed", "in_review"] };
  }
  if (result.outcome === "blocked" && PERMANENT_BLOCK_RULES.includes(result.ruleFired)) {
    return { to: "rejected", from: ["open", "claimed", "in_review", "awaiting_approval"] };
  }
  // auto_pay leaves the bounty as it is, for the payout step. A temporary block (paused,
  // unfunded, no claim yet) leaves it as it is too, so it can be decided again later.
  return null;
}

/**
 * Runs the policy engine on a verdict and appends the resulting Decision (decidedBy 'policy').
 * The Decision and the status change are written together, and the status only moves forward
 * from a live state: a paid or already-rejected bounty is never touched.
 */
export async function recordPolicyDecision(verdictId: string, now: Date = new Date()): Promise<Decision> {
  const input = await loadPolicyInput(verdictId, now);
  const result = decide(input);

  const create = prisma.decision.create({
    data: {
      bountyId: input.bounty.id,
      verdictId,
      outcome: result.outcome,
      ruleFired: result.ruleFired,
      decidedBy: "policy",
    },
  });

  const move = statusMove(result);
  if (!move) return toDecision(await create);

  const [row] = await prisma.$transaction([
    create,
    prisma.bounty.updateMany({
      where: { id: input.bounty.id, status: { in: move.from } },
      data: { status: move.to },
    }),
  ]);
  return toDecision(row);
}

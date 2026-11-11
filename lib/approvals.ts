// Maintainer approvals: a human says yes or no to a payout the policy engine held.
//
// Rules this file keeps:
//  - Decisions are append-only. An approval is a NEW Decision (decidedBy 'maintainer', outcome
//    'auto_pay'); a rejection is a NEW Decision with outcome 'blocked'. Nothing is edited.
//  - The approval Decision's id is derived from the decision being approved
//    (`maintainer-approve-<decisionId>`). The primary key therefore makes a double click
//    idempotent: the second insert fails at the database and we reuse the first.
//  - Approving still runs the policy engine. A maintainer can override the soft rules that
//    produced 'needs_approval' (caps, low confidence, flags) but never a hard block (paused,
//    unfunded, wrong author, failed CI...).
//  - The payout response is NOT proof of payment: its status is usually PENDING. The payout is
//    settled later by refreshPayoutStatus().

import { isUniqueViolation } from "./db-errors";
import { prisma, toDecision } from "./db";
import { latestDecisionRow, loadPolicyInput } from "./decisions";
import type { Decision as DecisionDbRow } from "./generated/prisma/client";
import { decide, POLICY_RULES } from "./policy";
import { sendBountyPayout, type PayoutResult } from "./paypal/payouts";
import type { Decision } from "./types";

export class ApprovalError extends Error {
  readonly status: number;
  readonly code: "BOUNTY_NOT_FOUND" | "INVALID_BOUNTY_STATE" | "NOT_AWAITING_APPROVAL" | "APPROVAL_BLOCKED";
  /** The policy rule that blocked an approval, e.g. 'paused'. */
  readonly rule?: string;

  constructor(status: number, code: ApprovalError["code"], message: string, rule?: string) {
    super(message);
    this.name = "ApprovalError";
    this.status = status;
    this.code = code;
    this.rule = rule;
  }
}

const approvalDecisionId = (decisionId: string) => `maintainer-approve-${decisionId}`;
const rejectionDecisionId = (decisionId: string) => `maintainer-reject-${decisionId}`;

const isMaintainerApproval = (d: DecisionDbRow) =>
  d.decidedBy === "maintainer" && d.outcome === "auto_pay" && d.ruleFired === POLICY_RULES.MAINTAINER_APPROVED;
const isMaintainerRejection = (d: DecisionDbRow) =>
  d.decidedBy === "maintainer" && d.outcome === "blocked" && d.ruleFired === POLICY_RULES.MAINTAINER_REJECTED;

/** The maintainer's note is accepted and logged for the audit trail; Decision has no column for it. */
function logNote(action: string, bountyId: string, decisionId: string, note?: string) {
  console.info("[approvals] maintainer decision", {
    action,
    bountyId,
    decisionId,
    note: note ? note.slice(0, 500) : undefined,
  });
}

async function loadAwaitingApproval(bountyId: string) {
  const bounty = await prisma.bounty.findUnique({ where: { id: bountyId } });
  if (!bounty) throw new ApprovalError(404, "BOUNTY_NOT_FOUND", "Bounty not found");
  return bounty;
}

const notAwaiting = (status: string) =>
  new ApprovalError(409, "INVALID_BOUNTY_STATE", `Bounty is '${status}', not 'awaiting_approval'`);

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

export async function approveBounty(
  bountyId: string,
  note?: string,
): Promise<{ decision: Decision; payout: PayoutResult }> {
  const bounty = await loadAwaitingApproval(bountyId);
  if (bounty.status !== "awaiting_approval") throw notAwaiting(bounty.status);

  const newest = await latestDecisionRow(bountyId);
  if (!newest) throw new ApprovalError(409, "NOT_AWAITING_APPROVAL", "The bounty has no decision to approve");

  // A repeat (double click, or a retry after a payout error): reuse the approval already recorded.
  // sendBountyPayout is idempotent, so this returns the same payout instead of paying twice.
  if (isMaintainerApproval(newest)) {
    return { decision: toDecision(newest), payout: await sendBountyPayout({ decisionId: newest.id }) };
  }

  if (newest.outcome !== "needs_approval") {
    throw new ApprovalError(
      409,
      "NOT_AWAITING_APPROVAL",
      `The newest decision is '${newest.outcome}', not 'needs_approval'`,
    );
  }

  // Re-check against today's facts. Soft rules (caps, low confidence, flags) are exactly what the
  // maintainer is overriding; a hard block (paused, unfunded, wrong author...) cannot be overridden.
  const recheck = decide(await loadPolicyInput(newest.verdictId));
  if (recheck.outcome === "blocked") {
    throw new ApprovalError(409, "APPROVAL_BLOCKED", `Cannot approve: blocked by rule '${recheck.ruleFired}'`, recheck.ruleFired);
  }

  const id = approvalDecisionId(newest.id);
  let row: DecisionDbRow;
  try {
    row = await prisma.decision.create({
      data: {
        id,
        bountyId,
        verdictId: newest.verdictId,
        outcome: "auto_pay",
        ruleFired: POLICY_RULES.MAINTAINER_APPROVED,
        decidedBy: "maintainer",
      },
    });
  } catch (err) {
    // Another request approved the same decision a moment ago: use its row.
    const existing = isUniqueViolation(err) ? await prisma.decision.findUnique({ where: { id } }) : null;
    if (!existing) throw err;
    row = existing;
  }
  logNote("approve", bountyId, row.id, note);

  return { decision: toDecision(row), payout: await sendBountyPayout({ decisionId: row.id }) };
}

// ---------------------------------------------------------------------------
// Reject
// ---------------------------------------------------------------------------

export async function rejectBounty(bountyId: string, note?: string): Promise<{ decision: Decision }> {
  const bounty = await loadAwaitingApproval(bountyId);
  const newest = await latestDecisionRow(bountyId);

  // A repeat of a rejection that already happened: report it again, change nothing.
  if (newest && isMaintainerRejection(newest) && bounty.status === "rejected") {
    return { decision: toDecision(newest) };
  }

  if (bounty.status !== "awaiting_approval") throw notAwaiting(bounty.status);
  if (!newest || newest.outcome !== "needs_approval") {
    throw new ApprovalError(
      409,
      "NOT_AWAITING_APPROVAL",
      `The newest decision is '${newest?.outcome ?? "none"}', not 'needs_approval'`,
    );
  }

  const id = rejectionDecisionId(newest.id);
  try {
    // The decision and the status change are written together.
    const [row] = await prisma.$transaction([
      prisma.decision.create({
        data: {
          id,
          bountyId,
          verdictId: newest.verdictId,
          outcome: "blocked",
          ruleFired: POLICY_RULES.MAINTAINER_REJECTED,
          decidedBy: "maintainer",
        },
      }),
      prisma.bounty.updateMany({
        where: { id: bountyId, status: "awaiting_approval" },
        data: { status: "rejected" },
      }),
    ]);
    logNote("reject", bountyId, row.id, note);
    return { decision: toDecision(row) };
  } catch (err) {
    const existing = isUniqueViolation(err) ? await prisma.decision.findUnique({ where: { id } }) : null;
    if (!existing) throw err;
    return { decision: toDecision(existing) };
  }
}

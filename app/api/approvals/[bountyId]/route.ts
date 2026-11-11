import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, handleRouteError } from "@/lib/api";
import { ApprovalError, approveBounty, rejectBounty } from "@/lib/approvals";
import { checkMaintainerKey } from "@/lib/auth";

const bodySchema = z.strictObject({
  action: z.enum(["approve", "reject"]),
  /** Logged for the audit trail. Not stored (Decision has no column for it). */
  note: z.string().trim().max(500).optional(),
});

/**
 * POST /api/approvals/[bountyId]   header: x-maintainer-key   body: { action, note? }
 *
 * A maintainer approves or rejects a payout the policy engine held ('awaiting_approval').
 *
 *  approve -> 200 { decision, payout }   payout.status is usually PENDING: it is NOT proof of
 *             payment. Poll POST /api/payouts/[payoutId]/refresh until it settles.
 *  reject  -> 200 { decision }           the bounty becomes 'rejected'.
 *
 * Both are safe to repeat (a double click returns the same result).
 */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/approvals/[bountyId]">) {
  try {
    const denied = checkMaintainerKey(req);
    if (denied) return denied;

    const { bountyId } = await ctx.params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return apiError(400, "INVALID_REQUEST", 'Request body must be JSON like { "action": "approve" }');
    }
    const body = bodySchema.parse(raw);

    return NextResponse.json(
      body.action === "approve"
        ? await approveBounty(bountyId, body.note)
        : await rejectBounty(bountyId, body.note),
    );
  } catch (err) {
    if (err instanceof ApprovalError) {
      return apiError(err.status, err.code, err.message, { rule: err.rule });
    }
    return handleRouteError(err);
  }
}

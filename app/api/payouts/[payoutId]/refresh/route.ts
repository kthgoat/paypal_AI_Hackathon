import { NextResponse, type NextRequest } from "next/server";

import { apiError, handleRouteError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { refreshPayoutStatus } from "@/lib/paypal/payouts";

// This route needs no key, and each real refresh is a call to PayPal. So repeated calls for the
// same payout within a couple of seconds just return the stored state (a per-server throttle).
const MIN_GAP_MS = 2_000;
const lastRefresh = new Map<string, number>();

/**
 * POST /api/payouts/[payoutId]/refresh   (no key needed)
 *
 * Asks PayPal for the payout's current state and updates our row. On SUCCESS the bounty becomes
 * 'paid'; on FAILED / RETURNED / BLOCKED it becomes 'failed'.
 *
 * 200 { payout: { payoutId, payoutBatchId, status }, bountyStatus }
 * Call it every few seconds for a PENDING payout, then reload the ledger.
 */
export async function POST(_req: NextRequest, ctx: RouteContext<"/api/payouts/[payoutId]/refresh">) {
  try {
    const { payoutId } = await ctx.params;

    const row = await prisma.payout.findUnique({ where: { id: payoutId } });
    if (!row) return apiError(404, "PAYOUT_NOT_FOUND", "Payout not found");

    const now = Date.now();
    const recent = now - (lastRefresh.get(payoutId) ?? 0) < MIN_GAP_MS;
    if (!recent) {
      if (lastRefresh.size > 1_000) lastRefresh.clear();
      lastRefresh.set(payoutId, now);
    }

    const result = recent
      ? { payoutId: row.id, payoutBatchId: row.payoutBatchId, status: row.status }
      : await refreshPayoutStatus(payoutId);
    const bounty = await prisma.bounty.findUnique({ where: { id: row.bountyId } });

    return NextResponse.json({
      payout: { payoutId: result.payoutId, payoutBatchId: result.payoutBatchId, status: result.status },
      bountyStatus: bounty?.status ?? null,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

import { NextResponse, type NextRequest } from "next/server";

import { apiError, handleRouteError } from "@/lib/api";
import { prisma, toBounty } from "@/lib/db";
import { createFundingOrder, getFundingOrder } from "@/lib/paypal/orders";

// Order states where the buyer can still pay, so we hand the same order back.
const PAYABLE_ORDER_STATUSES = new Set(["CREATED", "PAYER_ACTION_REQUIRED", "APPROVED"]);

/**
 * POST /api/bounties/[id]/fund
 *
 * Creates (or re-uses) the PayPal order that funds a bounty. The amount comes from the
 * bounty row in our database; the request body is ignored.
 *
 * 200 { orderId, approveUrl }   approveUrl is for manual testing; the PayPal button only needs orderId.
 */
export async function POST(_req: NextRequest, ctx: RouteContext<"/api/bounties/[id]/fund">) {
  try {
    const { id } = await ctx.params;

    const row = await prisma.bounty.findUnique({ where: { id } });
    if (!row) return apiError(404, "BOUNTY_NOT_FOUND", "Bounty not found");
    if (row.status !== "awaiting_funding") {
      return apiError(
        409,
        "INVALID_BOUNTY_STATE",
        `Bounty is '${row.status}', only a bounty in 'awaiting_funding' can be funded`,
      );
    }

    // If we already created an order for this bounty, don't create a second one while the
    // first can still be paid (double clicks, reopened checkout).
    let attempt = "1";
    if (row.fundingOrderId) {
      const previous = await getFundingOrder(row.fundingOrderId);
      if (previous && PAYABLE_ORDER_STATUSES.has(previous.status)) {
        return NextResponse.json({ orderId: previous.orderId, approveUrl: previous.approveUrl });
      }
      if (previous?.status === "COMPLETED") {
        return apiError(
          409,
          "ORDER_ALREADY_COMPLETED",
          `Order ${previous.orderId} is already paid. Call POST /api/bounties/${id}/fund/capture with it to finish.`,
        );
      }
      // The previous order is expired or voided: start a new one under a new idempotency key.
      attempt = row.fundingOrderId;
    }

    const { orderId, approveUrl } = await createFundingOrder(toBounty(row), attempt);

    const saved = await prisma.bounty.updateMany({
      where: { id, status: "awaiting_funding" },
      data: { fundingOrderId: orderId },
    });
    if (saved.count === 0) {
      return apiError(409, "INVALID_BOUNTY_STATE", "Bounty changed while the order was being created");
    }

    return NextResponse.json({ orderId, approveUrl });
  } catch (err) {
    return handleRouteError(err);
  }
}

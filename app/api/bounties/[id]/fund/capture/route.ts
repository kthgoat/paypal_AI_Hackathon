import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, handleRouteError } from "@/lib/api";
import { prisma } from "@/lib/db";
import {
  captureFundingOrder,
  isOrderAlreadyCaptured,
  lookupFundingCapture,
  ORDER_ID_PATTERN,
  verifyFundingCapture,
  type CaptureResult,
} from "@/lib/paypal/orders";

const bodySchema = z.object({
  orderId: z.string().regex(ORDER_ID_PATTERN, "not a valid PayPal order id"),
});

/**
 * POST /api/bounties/[id]/fund/capture   body: { orderId }
 *
 * Captures the buyer's approved payment, verifies PayPal received exactly what the
 * bounty asked for, and only then opens the bounty.
 *
 * 200 { status: 'open', captureId }
 *
 * Safe to retry: a repeat of a successful capture returns the same 200, and an order PayPal
 * has already captured is read back and verified instead of captured twice.
 */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/bounties/[id]/fund/capture">) {
  try {
    const { id } = await ctx.params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return apiError(400, "INVALID_REQUEST", "Request body must be JSON like { \"orderId\": \"...\" }");
    }
    const { orderId } = bodySchema.parse(raw);

    const row = await prisma.bounty.findUnique({ where: { id } });
    if (!row) return apiError(404, "BOUNTY_NOT_FOUND", "Bounty not found");

    // A retry of a capture that already succeeded: report the same result, change nothing.
    if (row.status === "open" && row.fundingOrderId === orderId && row.fundingCaptureId) {
      return NextResponse.json({ status: "open", captureId: row.fundingCaptureId });
    }
    if (row.status !== "awaiting_funding") {
      return apiError(
        409,
        "INVALID_BOUNTY_STATE",
        `Bounty is '${row.status}', only a bounty in 'awaiting_funding' can be funded`,
      );
    }
    if (row.fundingOrderId !== orderId) {
      return apiError(409, "ORDER_MISMATCH", "This order does not belong to this bounty");
    }

    // Capture. If PayPal says it was already captured (e.g. our earlier response was lost),
    // read the order back and verify it exactly as if we had just captured it.
    let capture: CaptureResult | null;
    try {
      capture = await captureFundingOrder(orderId);
    } catch (err) {
      if (!isOrderAlreadyCaptured(err)) throw err;
      capture = await lookupFundingCapture(orderId);
    }

    // Never trust the browser or even PayPal's status alone: compare everything against our row.
    const check = capture
      ? verifyFundingCapture(capture, { bountyId: row.id, amountCents: row.amountCents })
      : ({ ok: false, reason: "order not found at PayPal" } as const);
    const captureId = capture?.captureId ?? null;

    if (!check.ok || !captureId) {
      const reason = check.ok ? "no capture id" : check.reason;
      // Money may have been received for the wrong thing: needs a human to reconcile.
      console.error("[SERIOUS] Funding capture failed verification; bounty NOT opened", {
        bountyId: row.id,
        orderId,
        captureId,
        reason,
        expectedAmountCents: row.amountCents,
        captured: capture && {
          status: capture.status,
          captureStatus: capture.captureStatus,
          amount: capture.amount,
          currency: capture.currency,
          customId: capture.customId,
        },
      });
      return apiError(422, "CAPTURE_VERIFICATION_FAILED", reason);
    }

    // One conditional update: record the capture and open the bounty together, and only if
    // it is still waiting for this exact order (so a concurrent request cannot double-open).
    const opened = await prisma.bounty.updateMany({
      where: { id: row.id, status: "awaiting_funding", fundingOrderId: orderId },
      data: { status: "open", fundingCaptureId: captureId },
    });
    if (opened.count === 0) {
      const current = await prisma.bounty.findUnique({ where: { id: row.id } });
      if (current?.status === "open" && current.fundingCaptureId === captureId) {
        return NextResponse.json({ status: "open", captureId }); // a concurrent request finished first
      }
      console.error("[SERIOUS] Funding captured and verified but the bounty could not be opened", {
        bountyId: row.id,
        orderId,
        captureId,
        currentStatus: current?.status ?? null,
      });
      return apiError(409, "INVALID_BOUNTY_STATE", "Bounty changed while the payment was being captured");
    }

    return NextResponse.json({ status: "open", captureId });
  } catch (err) {
    return handleRouteError(err);
  }
}

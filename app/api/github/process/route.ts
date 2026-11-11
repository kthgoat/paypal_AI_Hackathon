import { NextResponse, type NextRequest } from "next/server";

import { handleRouteError } from "@/lib/api";
import { checkMaintainerKey } from "@/lib/auth";
import { processPendingEvents } from "@/lib/orchestrator";

// A review (up to 30 s) plus watching a payout (up to 30 s) can take a while.
export const maxDuration = 120;

/**
 * POST /api/github/process   header: x-maintainer-key
 *
 * Processes every merged-PR event that is waiting (received, waiting_ci, a retryable failure, or a
 * crashed claim), oldest first, and returns what happened to each. Use it when a demo should not
 * depend on webhook timing. Running it again is safe: finished events are never touched twice.
 *
 *  200 { processed: [{ deliveryId, status, reason?, verdictId?, decision?, payout? }] }
 */
export async function POST(req: NextRequest) {
  try {
    const denied = checkMaintainerKey(req);
    if (denied) return denied;

    return NextResponse.json({ processed: await processPendingEvents() });
  } catch (err) {
    return handleRouteError(err);
  }
}

import { NextResponse, type NextRequest } from "next/server";

import { handleRouteError } from "@/lib/api";
import { checkMaintainerKey } from "@/lib/auth";
import { discoverMergedPrEvents } from "@/lib/github/discover";
import { processPendingEvents } from "@/lib/orchestrator";

// A review (up to 30 s) plus watching a payout (up to 30 s) can take a while.
export const maxDuration = 120;

/**
 * POST /api/github/process   header: x-maintainer-key
 *
 * 1. Looks on GitHub for PRs merged after an open, funded, claimed bounty was created that say they
 *    close its issue, and records a merge event for each new one (the same row the webhook stores).
 * 2. Processes every merged-PR event that is waiting (received, waiting_ci, a retryable failure, or
 *    a crashed claim), oldest first, and returns what happened to each.
 *
 * Use it when a demo should not depend on webhook timing. Running it again is safe: events are
 * recorded once and finished events are never touched twice.
 *
 *  200 { discovered, discoveryError?, processed: [{ deliveryId, status, reason?, verdictId?, decision?, payout? }] }
 *      discoveryError is set when GitHub could not be checked; existing events were still processed.
 */
export async function POST(req: NextRequest) {
  try {
    const denied = checkMaintainerKey(req);
    if (denied) return denied;

    // No webhook can reach a local server, so first look on GitHub for merged PRs that close an
    // open, funded, claimed bounty and record them. It never throws: if GitHub cannot be checked,
    // existing events are still processed and the reason comes back as discoveryError.
    const discovery = await discoverMergedPrEvents();
    const processed = await processPendingEvents();

    return NextResponse.json({
      discovered: discovery.discovered,
      ...(discovery.error ? { discoveryError: discovery.error } : {}),
      processed,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

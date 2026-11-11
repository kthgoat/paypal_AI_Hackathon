import { connection, NextResponse, type NextRequest } from "next/server";

import { apiError, handleRouteError } from "@/lib/api";
import { checkMaintainerKey } from "@/lib/auth";
import { readSettings, settingsPatchSchema, updateSettings } from "@/lib/settings";

const NO_STORE = { "Cache-Control": "no-store" };
const missing = () => apiError(503, "SETTINGS_MISSING", "Payout settings are missing. Run the seed script.");

/** GET /api/settings  (no key needed) -> { autoPayCapUsd, contributorDailyCapUsd, monthlyBudgetUsd, paused } */
export async function GET() {
  await connection();
  try {
    const settings = await readSettings();
    return settings ? NextResponse.json(settings, { headers: NO_STORE }) : missing();
  } catch (err) {
    return handleRouteError(err);
  }
}

/**
 * PATCH /api/settings   header: x-maintainer-key   body: any of
 * { autoPayCapUsd, contributorDailyCapUsd, monthlyBudgetUsd, paused }
 *
 * Amounts are dollars, greater than 0, at most 10,000, with at most 2 decimals.
 * Returns the updated settings.
 */
export async function PATCH(req: NextRequest) {
  try {
    const denied = checkMaintainerKey(req);
    if (denied) return denied;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return apiError(400, "INVALID_REQUEST", 'Request body must be JSON like { "paused": true }');
    }
    const updated = await updateSettings(settingsPatchSchema.parse(raw));
    return updated ? NextResponse.json(updated, { headers: NO_STORE }) : missing();
  } catch (err) {
    return handleRouteError(err);
  }
}

// Shared by lib/policy.ts (spend totals) and lib/paypal/payouts.ts (retry rules).
// Kept in its own tiny module so the policy engine stays free of database and PayPal imports.

/** Payout states where the money did NOT reach the contributor. They do not count as spend. */
export const FAILED_PAYOUT_STATUSES: ReadonlySet<string> = new Set(["FAILED", "RETURNED", "BLOCKED"]);

// Shared helpers for API route handlers: one error shape, no stack traces in responses.
//
// Every error response looks like: { error: { code, message } }
// (PayPal failures also carry paypalName and debugId.)

import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { PolicyDataError } from "./decisions";
import { PayPalConfigError, PayPalError } from "./paypal/client";
import { PayoutError, PayoutRefusedError } from "./paypal/payouts";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    paypalName?: string;
    debugId?: string | null;
    /** PayPal's issue codes, e.g. ORDER_NOT_APPROVED or INSTRUMENT_DECLINED. */
    paypalIssues?: string[];
    /** The policy rule or payout refusal reason behind the error, e.g. 'paused'. */
    rule?: string;
  };
}

export function apiError(
  status: number,
  code: string,
  message: string,
  extra: { paypalName?: string; debugId?: string | null; paypalIssues?: string[]; rule?: string } = {},
): NextResponse<ApiErrorBody> {
  return NextResponse.json({ error: { code, message, ...extra } }, { status });
}

/** Maps anything thrown inside a route handler to a consistent error response. */
export function handleRouteError(err: unknown): NextResponse<ApiErrorBody> {
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return apiError(400, "INVALID_REQUEST", message);
  }
  if (err instanceof PayPalError) {
    const paypalIssues = err.details.flatMap((d) => (d.issue ? [d.issue] : []));
    console.error("[paypal] API error", {
      status: err.status,
      name: err.paypalName,
      issues: paypalIssues,
      debugId: err.debugId,
    });
    return apiError(502, "PAYPAL_ERROR", err.message, {
      paypalName: err.paypalName,
      debugId: err.debugId,
      paypalIssues,
    });
  }
  if (err instanceof PayPalConfigError) {
    console.error("[paypal] configuration error:", err.message);
    return apiError(500, "PAYPAL_NOT_CONFIGURED", err.message);
  }
  if (err instanceof PayoutRefusedError) {
    return apiError(409, "PAYOUT_REFUSED", err.message, { rule: err.reason });
  }
  if (err instanceof PayoutError) {
    // OUTCOME_UNKNOWN: the request may not have reached PayPal. NEEDS_RECONCILIATION: a person must look.
    return apiError(err.code === "PAYOUT_OUTCOME_UNKNOWN" ? 502 : 409, err.code, err.message);
  }
  if (err instanceof PolicyDataError) {
    return err.code === "SETTINGS_MISSING"
      ? apiError(503, err.code, err.message)
      : apiError(404, err.code, err.message);
  }
  console.error("[api] unexpected error", err);
  return apiError(500, "INTERNAL_ERROR", "Unexpected error");
}

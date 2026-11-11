// PayPal Orders v2: fund a bounty with Checkout (create + capture). Sandbox only.
//
// The amount ALWAYS comes from our own bounty record, never from the browser.

import { createHash } from "node:crypto";

import { z } from "zod";

import { usdToCents } from "../db";
import type { Bounty } from "../types";
import { paypalFetch, PayPalConfigError, PayPalError } from "./client";

/** PayPal truncates descriptions beyond 127 characters. */
const DESCRIPTION_MAX = 127;

/** Order ids are short alphanumeric strings. Validate before putting one in a URL path. */
export const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// Money helpers (string <-> integer cents, no floats)
// ---------------------------------------------------------------------------

/** 2500 -> "25.00" */
export function formatUsdCents(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** "25.00" -> 2500. Returns null for anything that is not a plain 0-2 decimal USD amount. */
export function parseUsdToCents(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

function truncate(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("").trimEnd();
}

/**
 * Where PayPal sends the buyer after the redirect flow (APP_URL, default http://localhost:3000).
 * Returns the origin only, e.g. "https://bountypilot.example". The PayPal JS button popup
 * flow does not use these URLs, but the plain approve-link flow fails without them.
 */
function appBaseUrl(): string {
  const raw = process.env.APP_URL?.trim() || "http://localhost:3000";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PayPalConfigError("APP_URL must be a valid URL such as http://localhost:3000");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PayPalConfigError("APP_URL must start with http:// or https://");
  }
  return url.origin;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const captureSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  amount: z.object({ currency_code: z.string(), value: z.string() }).optional(),
  custom_id: z.string().optional(),
});

const orderSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
  purchase_units: z
    .array(
      z.looseObject({
        custom_id: z.string().optional(),
        payments: z.looseObject({ captures: z.array(captureSchema).optional() }).optional(),
      }),
    )
    .optional(),
});

type PayPalOrder = z.infer<typeof orderSchema>;

function parseOrder(data: unknown): PayPalOrder {
  const parsed = orderSchema.safeParse(data);
  if (!parsed.success) throw new Error("Unexpected order response from PayPal");
  return parsed.data;
}

/**
 * The link the buyer opens to approve the payment. PayPal returns 'payer-action' when the
 * order was created with a payment_source (our case) and 'approve' otherwise.
 */
function approveUrlOf(order: PayPalOrder): string | null {
  return (
    order.links?.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href ?? null
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Creates a PayPal order that funds the bounty.
 *
 * Idempotency key: `fund-<bountyId>-<attempt>-<hash of the request body>`.
 *  - Repeating the same call returns the same order (a double click cannot create two).
 *  - A new `attempt` creates a fresh order (used after an order has expired).
 *  - The body hash changes the key whenever the request changes (amount, title, return
 *    URLs), so PayPal never replays a stale order for a different request.
 */
export async function createFundingOrder(
  bounty: Pick<Bounty, "id" | "title" | "amountUsd">,
  attempt: string = "1",
): Promise<{ orderId: string; approveUrl: string | null }> {
  const cents = usdToCents(bounty.amountUsd);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error("Bounty amount must be a positive amount");
  }

  const base = appBaseUrl();
  const bountyParam = encodeURIComponent(bounty.id);
  const body = {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: bounty.id,
        custom_id: bounty.id,
        description: truncate(`Bounty: ${bounty.title}`, DESCRIPTION_MAX),
        amount: { currency_code: "USD", value: formatUsdCents(cents) },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "BountyPilot",
          shipping_preference: "NO_SHIPPING", // bounties are not shipped goods
          user_action: "PAY_NOW", // the button says Pay Now: approval is the payment
          return_url: `${base}/dev/funding-return?bountyId=${bountyParam}`,
          cancel_url: `${base}/dev/funding-return?cancelled=1&bountyId=${bountyParam}`,
        },
      },
    },
  };

  const bodyHash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 8);
  const order = parseOrder(
    await paypalFetch("/v2/checkout/orders", {
      method: "POST",
      requestId: `fund-${bounty.id}-${attempt}-${bodyHash}`,
      body,
    }),
  );

  return { orderId: order.id, approveUrl: approveUrlOf(order) };
}

// ---------------------------------------------------------------------------
// Look up
// ---------------------------------------------------------------------------

/** Fetches an order. Returns null when PayPal no longer has it (404). */
export async function getFundingOrder(
  orderId: string,
): Promise<{ orderId: string; status: string; approveUrl: string | null } | null> {
  const order = await fetchOrder(orderId);
  return order && { orderId: order.id, status: order.status, approveUrl: approveUrlOf(order) };
}

async function fetchOrder(orderId: string): Promise<PayPalOrder | null> {
  assertOrderId(orderId);
  try {
    return parseOrder(await paypalFetch(`/v2/checkout/orders/${orderId}`));
  } catch (err) {
    if (err instanceof PayPalError && err.status === 404) return null;
    throw err;
  }
}

function assertOrderId(orderId: string): void {
  if (!ORDER_ID_PATTERN.test(orderId)) throw new Error("Invalid PayPal order id");
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export interface CaptureResult {
  /** Order status, e.g. COMPLETED. */
  status: string;
  /** Status of the capture itself. COMPLETED means the money has arrived; PENDING does not. */
  captureStatus: string | null;
  captureId: string | null;
  /** Decimal string exactly as PayPal returned it, e.g. "25.00". */
  amount: string | null;
  currency: string | null;
  customId: string | null;
}

function toCaptureResult(order: PayPalOrder): CaptureResult {
  const unit = order.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  return {
    status: order.status,
    captureStatus: capture?.status ?? null,
    captureId: capture?.id ?? null,
    amount: capture?.amount?.value ?? null,
    currency: capture?.amount?.currency_code ?? null,
    customId: capture?.custom_id ?? unit?.custom_id ?? null,
  };
}

/** Captures the buyer's approved payment. */
export async function captureFundingOrder(orderId: string): Promise<CaptureResult> {
  assertOrderId(orderId);
  const order = parseOrder(
    // No PayPal-Request-Id here on purpose: a retry after a failure (e.g. the buyer had not
    // approved yet) must reach PayPal fresh. A repeat after success is handled by
    // ORDER_ALREADY_CAPTURED + lookupFundingCapture() in the route.
    await paypalFetch(`/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      body: {},
    }),
  );
  return toCaptureResult(order);
}

/** True when PayPal rejected a capture because the order was already captured. */
export function isOrderAlreadyCaptured(err: unknown): boolean {
  return (
    err instanceof PayPalError &&
    err.status === 422 &&
    err.details.some((d) => d.issue === "ORDER_ALREADY_CAPTURED")
  );
}

/** Reads back an order that was already captured (e.g. a retried request). */
export async function lookupFundingCapture(orderId: string): Promise<CaptureResult | null> {
  const order = await fetchOrder(orderId);
  return order && toCaptureResult(order);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Checks that what PayPal captured is exactly what we asked for. The bounty may only be
 * opened when this returns ok. Anything else means money arrived for the wrong thing.
 */
export function verifyFundingCapture(
  capture: CaptureResult,
  expected: { bountyId: string; amountCents: number },
): { ok: true } | { ok: false; reason: string } {
  if (capture.status !== "COMPLETED") {
    return { ok: false, reason: `order status is ${capture.status}, expected COMPLETED` };
  }
  if (!capture.captureId) {
    return { ok: false, reason: "no capture found on the order" };
  }
  if (capture.captureStatus !== "COMPLETED") {
    return { ok: false, reason: `capture status is ${capture.captureStatus}, expected COMPLETED` };
  }
  if (capture.currency !== "USD") {
    return { ok: false, reason: `currency is ${capture.currency}, expected USD` };
  }
  const capturedCents = capture.amount === null ? null : parseUsdToCents(capture.amount);
  if (capturedCents !== expected.amountCents) {
    return {
      ok: false,
      reason: `captured amount is ${capture.amount}, expected ${formatUsdCents(expected.amountCents)}`,
    };
  }
  if (capture.customId !== expected.bountyId) {
    return { ok: false, reason: "custom_id does not match this bounty" };
  }
  return { ok: true };
}

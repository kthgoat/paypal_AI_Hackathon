// Minimal PayPal REST client. Plain fetch, no SDK. SANDBOX ONLY. Server-side only.
//
// - getAccessToken(): client-credentials token, cached in memory until 60 s before it expires.
// - paypalFetch(): adds auth + JSON headers, retries once on 401, throws PayPalError on non-2xx.
//
// Credentials and tokens are never logged or included in error messages.

import { z } from "zod";

// Hardcoded on purpose: this app can only ever talk to the PayPal SANDBOX.
const BASE_URL = "https://api-m.sandbox.paypal.com";
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Missing credentials or a non-sandbox environment. The message names variables only. */
export class PayPalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayPalConfigError";
  }
}

export interface PayPalErrorDetail {
  issue?: string;
  description?: string;
  field?: string;
  location?: string;
  [key: string]: unknown;
}

/** A non-2xx response from PayPal, with PayPal's own error fields parsed out. */
export class PayPalError extends Error {
  readonly status: number;
  /** PayPal's error `name`, e.g. UNPROCESSABLE_ENTITY (not Error.name). */
  readonly paypalName: string;
  /** PayPal's `debug_id`: quote it when contacting PayPal support. */
  readonly debugId: string | null;
  readonly details: PayPalErrorDetail[];

  constructor(init: {
    status: number;
    name: string;
    message: string;
    debugId: string | null;
    details: PayPalErrorDetail[];
  }) {
    super(init.message);
    this.name = "PayPalError";
    this.status = init.status;
    this.paypalName = init.name;
    this.debugId = init.debugId;
    this.details = init.details;
  }
}

const asString = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function toPayPalError(res: Response, data: unknown): PayPalError {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return new PayPalError({
    status: res.status,
    // REST errors use name/message/debug_id; the OAuth endpoint uses error/error_description.
    name: asString(d.name) ?? asString(d.error) ?? "UNKNOWN_ERROR",
    message:
      asString(d.message) ??
      asString(d.error_description) ??
      `PayPal request failed with HTTP ${res.status}`,
    debugId: asString(d.debug_id) ?? res.headers.get("paypal-debug-id"),
    details: Array.isArray(d.details) ? (d.details as PayPalErrorDetail[]) : [],
  });
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) }; // not JSON (e.g. an HTML error page)
  }
}

// ---------------------------------------------------------------------------
// Config guards
// ---------------------------------------------------------------------------

function assertSandbox(): void {
  if (process.env.PAYPAL_ENVIRONMENT?.trim().toUpperCase() !== "SANDBOX") {
    throw new PayPalConfigError(
      "PAYPAL_ENVIRONMENT must be SANDBOX. This app only talks to the PayPal sandbox.",
    );
  }
}

function readCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const missing = [
    !clientId && "PAYPAL_CLIENT_ID",
    !clientSecret && "PAYPAL_CLIENT_SECRET",
  ].filter(Boolean);
  if (!clientId || !clientSecret) {
    throw new PayPalConfigError(`Missing environment variables: ${missing.join(", ")}`);
  }
  return { clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// Access token (cached in memory)
// ---------------------------------------------------------------------------

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

let cached: { token: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

/** Forget the cached token (used after a 401, and by tests). */
export function resetTokenCache(): void {
  cached = null;
  inflight = null;
}

async function fetchToken(): Promise<string> {
  const { clientId, clientSecret } = readCredentials();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await readJson(res);
  if (!res.ok) throw toPayPalError(res, data);

  const parsed = tokenResponseSchema.safeParse(data);
  if (!parsed.success) throw new Error("Unexpected response from the PayPal token endpoint");

  cached = {
    token: parsed.data.access_token,
    expiresAt: Date.now() + Math.max(parsed.data.expires_in * 1000 - TOKEN_REFRESH_MARGIN_MS, 0),
  };
  return parsed.data.access_token;
}

/** Returns a valid bearer token. Concurrent callers share one in-flight request. */
export async function getAccessToken(): Promise<string> {
  assertSandbox();
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  if (inflight) return inflight;

  const request: Promise<string> = fetchToken().finally(() => {
    if (inflight === request) inflight = null;
  });
  inflight = request;
  return request;
}

// ---------------------------------------------------------------------------
// Authenticated requests
// ---------------------------------------------------------------------------

export interface PayPalFetchOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Sent as the PayPal-Request-Id header so a retried request is not applied twice. */
  requestId?: string;
}

/** Calls the sandbox API and returns the parsed JSON body. Throws PayPalError on non-2xx. */
export async function paypalFetch<T = unknown>(
  path: string,
  options: PayPalFetchOptions = {},
): Promise<T> {
  if (!path.startsWith("/")) throw new Error("paypalFetch path must start with '/'");

  const send = async (): Promise<Response> => {
    const token = await getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (options.requestId) headers["PayPal-Request-Id"] = options.requestId;

    return fetch(`${BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  };

  let res = await send();
  if (res.status === 401) {
    // The token may have been revoked or expired early: refresh it and retry once.
    resetTokenCache();
    res = await send();
  }

  const data = await readJson(res);
  if (!res.ok) throw toPayPalError(res, data);
  return data as T;
}

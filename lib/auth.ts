// Maintainer authentication for the routes that can move money or change settings.
//
// A maintainer types the key into the dashboard and the browser sends it as the
// `x-maintainer-key` header. The key lives only in the server's MAINTAINER_KEY environment
// variable: it must never be a NEXT_PUBLIC_ variable or appear in the browser bundle.

import { createHash, timingSafeEqual } from "node:crypto";

import type { NextResponse } from "next/server";

import { apiError, type ApiErrorBody } from "./api";

/** A shorter key is too easy to guess, so the server refuses to run maintainer actions with it. */
export const MIN_MAINTAINER_KEY_LENGTH = 16;

/** Constant-time comparison: hash both sides so the lengths always match, then compare. */
function safeEqual(a: string, b: string): boolean {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}

/** Returns an error response if the request is not from a maintainer, or null if it is. */
export function checkMaintainerKey(req: Request): NextResponse<ApiErrorBody> | null {
  const expected = process.env.MAINTAINER_KEY ?? "";
  if (expected.length < MIN_MAINTAINER_KEY_LENGTH) {
    console.error(
      `[auth] MAINTAINER_KEY is missing or shorter than ${MIN_MAINTAINER_KEY_LENGTH} characters; maintainer actions are disabled`,
    );
    return apiError(
      500,
      "MAINTAINER_KEY_NOT_CONFIGURED",
      "Maintainer actions are disabled: the server has no valid MAINTAINER_KEY.",
    );
  }

  const provided = req.headers.get("x-maintainer-key") ?? "";
  if (!safeEqual(provided, expected)) {
    return apiError(401, "UNAUTHORIZED", "Missing or invalid x-maintainer-key header.");
  }
  return null;
}

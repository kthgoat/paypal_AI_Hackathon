import { NextResponse } from "next/server";
import { apiError } from "@/lib/api";
import { MIN_MAINTAINER_KEY_LENGTH } from "@/lib/auth";
import { createMaintainerSession, isLocalSessionRequest, SESSION_COOKIE, SESSION_SECONDS } from "@/lib/maintainer-session";

export async function POST(req: Request) {
  if (!isLocalSessionRequest(req)) {
    return apiError(403, "LOCAL_SESSION_DISABLED", "Automatic maintainer access is available only on a configured localhost server.");
  }
  const key = process.env.MAINTAINER_KEY ?? "";
  if (key.length < MIN_MAINTAINER_KEY_LENGTH) {
    return apiError(503, "MAINTAINER_KEY_NOT_CONFIGURED", "Set MAINTAINER_KEY in .env.local and restart the server.");
  }
  const response = NextResponse.json({ connected: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(SESSION_COOKIE, createMaintainerSession(key), {
    httpOnly: true, sameSite: "strict", path: "/api", maxAge: SESSION_SECONDS,
    secure: new URL(req.url).protocol === "https:",
  });
  return response;
}

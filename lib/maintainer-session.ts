import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "bp-local-maintainer";
export const SESSION_SECONDS = 4 * 60 * 60;

// automatic sessions are opt-in and restricted to same-origin loopback requests
export function isLocalSessionRequest(req: Request): boolean {
  if (process.env.LOCAL_MAINTAINER_SESSION !== "true") return false;
  const url = new URL(req.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return false;
  const host = req.headers.get("host");
  if (!host) return false;
  let browserOrigin: URL;
  try { browserOrigin = new URL(`${url.protocol}//${host}`); } catch { return false; }
  if (browserOrigin.host !== host || !["localhost", "127.0.0.1", "[::1]"].includes(browserOrigin.hostname)) return false;
  if (req.headers.get("origin") !== browserOrigin.origin) return false;
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin";
}

function signature(payload: string, key: string) {
  return createHmac("sha256", key).update(`local-maintainer:${payload}`).digest("hex");
}

export function createMaintainerSession(key: string, now = Date.now()) {
  const payload = `${Math.floor(now / 1000) + SESSION_SECONDS}.${randomBytes(24).toString("hex")}`;
  return `${payload}.${signature(payload, key)}`;
}

export function hasMaintainerSession(req: Request, key: string, now = Date.now()): boolean {
  if (!isLocalSessionRequest(req)) return false;
  const token = req.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token || !/^\d+\.[a-f0-9]{48}\.[a-f0-9]{64}$/.test(token)) return false;
  const [expires, nonce, supplied] = token.split(".");
  if (Number(expires) <= Math.floor(now / 1000)) return false;
  const expected = signature(`${expires}.${nonce}`, key);
  return timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
}

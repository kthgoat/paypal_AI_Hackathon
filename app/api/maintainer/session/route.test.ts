import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { checkMaintainerKey } from "@/lib/auth";
import { SESSION_COOKIE, SESSION_SECONDS } from "@/lib/maintainer-session";

const KEY = "test-local-maintainer-key-1234";
const ORIGIN = "http://127.0.0.1:3011";

function request(headers: Record<string, string> = {}, origin = ORIGIN) {
  return new Request(`${origin}/api/maintainer/session`, {
    method: "POST", headers: { host: new URL(origin).host, origin, "sec-fetch-site": "same-origin", ...headers },
  });
}

beforeEach(() => {
  vi.stubEnv("MAINTAINER_KEY", KEY);
  vi.stubEnv("LOCAL_MAINTAINER_SESSION", "true");
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("automatic local maintainer session", () => {
  it("sets a restricted signed cookie and accepts it on maintainer routes", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: true });
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=strict");
    expect(cookie).toContain("Path=/api");
    expect(cookie).toContain(`Max-Age=${SESSION_SECONDS}`);
    expect(cookie).not.toContain(KEY);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(checkMaintainerKey(request({ cookie: cookie.split(";")[0] }))).toBeNull();
  });

  it("does not enable automatic access without the local opt-in", async () => {
    vi.stubEnv("LOCAL_MAINTAINER_SESSION", "false");
    expect((await POST(request())).status).toBe(403);
  });

  it.each([
    { origin: "https://attacker.example" },
    { origin: "" },
    { host: "attacker.example" },
    { "sec-fetch-site": "cross-site" },
  ] as Record<string, string>[])("rejects a cross-origin or mismatched request: %j", async (headers) => {
    const response = await POST(request(headers));
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refuses public hosts even with matching headers", async () => {
    expect((await POST(request({}, "https://demo.example"))).status).toBe(403);
  });

  it("requires a configured server key", async () => {
    vi.stubEnv("MAINTAINER_KEY", "");
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects expired, tampered, and cross-origin session cookies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
    const response = await POST(request());
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    const token = cookie.slice(SESSION_COOKIE.length + 1);
    const tampered = `${SESSION_COOKIE}=${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    expect(checkMaintainerKey(request({ cookie: tampered }))?.status).toBe(401);
    expect(checkMaintainerKey(request({ cookie, origin: "https://attacker.example" }))?.status).toBe(401);
    vi.advanceTimersByTime((SESSION_SECONDS + 1) * 1000);
    expect(checkMaintainerKey(request({ cookie }))?.status).toBe(401);
  });

  it("invalidates a session when the key changes or local mode is disabled", async () => {
    const response = await POST(request());
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    vi.stubEnv("MAINTAINER_KEY", "a-different-maintainer-key-1234");
    expect(checkMaintainerKey(request({ cookie }))?.status).toBe(401);
    vi.stubEnv("MAINTAINER_KEY", KEY);
    vi.stubEnv("LOCAL_MAINTAINER_SESSION", "false");
    expect(checkMaintainerKey(request({ cookie }))?.status).toBe(401);
  });

  it("sets Secure for https localhost", async () => {
    const response = await POST(request({}, "https://localhost:3011"));
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });
});

it("accepts the browser's loopback host when Next normalizes the internal URL", async () => {
  vi.stubEnv("MAINTAINER_KEY", KEY);
  vi.stubEnv("LOCAL_MAINTAINER_SESSION", "true");
  const req = new Request("http://localhost:3011/api/maintainer/session", {
    method: "POST", headers: { host: "127.0.0.1:3011", origin: ORIGIN, "sec-fetch-site": "same-origin" },
  });
  expect((await POST(req)).status).toBe(200);
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { connectMaintainer, decideBounty, pausePayouts, readDashboard, refreshPayout } from "./dashboard-client";

afterEach(() => vi.unstubAllGlobals());

describe("live dashboard requests", () => {
  it("sends approval and rejection without exposing the server key", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ decision: {}, payout: { status: "PENDING" } }));
    vi.stubGlobal("fetch", fetch);
    for (const action of ["approve", "reject"] as const) {
      await decideBounty("bounty/one", action);
      expect(fetch).toHaveBeenLastCalledWith("/api/approvals/bounty%2Fone", {
        cache: "no-store", method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    }
  });

  it("patches pause and resume without changing other settings", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetch);
    for (const paused of [true, false]) {
      await pausePayouts(paused);
      expect(fetch).toHaveBeenLastCalledWith("/api/settings", expect.objectContaining({
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused }),
      }));
    }
  });

  it("refreshes payout status separately from reading the ledger, without a key", async () => {
    const pending = { payout: { status: "PENDING" } };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(pending)).mockResolvedValueOnce(Response.json({ bounties: [] }));
    vi.stubGlobal("fetch", fetch);
    expect(await refreshPayout("payout/one")).toEqual(pending);
    await readDashboard();
    expect(fetch.mock.calls).toEqual([
      ["/api/payouts/payout%2Fone/refresh", { cache: "no-store", method: "POST" }],
      ["/api/dashboard", { cache: "no-store" }],
    ]);
  });

  it.each([
    [401, { error: { code: "UNAUTHORIZED", message: "Invalid maintainer key" } }, "Invalid maintainer key"],
    [409, { error: { code: "APPROVAL_BLOCKED", message: "Cannot approve: paused" } }, "Cannot approve: paused"],
    [503, { error: "Ledger is not initialized" }, "Ledger is not initialized"],
  ])("surfaces a %i backend error", async (status, body, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status })));
    await expect(decideBounty("one", "approve")).rejects.toThrow(message);
  });

  it("reports non-json server errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unavailable", { status: 502 })));
    await expect(readDashboard()).rejects.toThrow("Request failed (502)");
  });
});

it("establishes an http-only session without sending a secret from the browser", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ connected: true }));
  vi.stubGlobal("fetch", fetch);
  await expect(connectMaintainer()).resolves.toEqual({ connected: true });
  expect(fetch).toHaveBeenCalledWith("/api/maintainer/session", { cache: "no-store", method: "POST" });
});

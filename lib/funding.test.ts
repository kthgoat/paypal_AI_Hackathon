import { afterEach, describe, expect, it, vi } from "vitest";
import { captureBountyOrder, createBountyOrder, FundingError } from "./funding";

afterEach(() => vi.unstubAllGlobals());

function mockResponse(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("bounty funding checkout contract", () => {
  it("returns the backend order without sending a client-controlled amount", async () => {
    const fetchMock = mockResponse({ orderId: "ORDER123", approveUrl: "https://example.com" });
    await expect(createBountyOrder("bounty-1")).resolves.toBe("ORDER123");
    expect(fetchMock).toHaveBeenCalledWith("/api/bounties/bounty-1/fund", { method: "POST" });
  });

  it("captures the approved order using the matching bounty route", async () => {
    const fetchMock = mockResponse({ status: "open", captureId: "CAPTURE123" });
    await expect(captureBountyOrder("bounty-1", "ORDER123")).resolves.toBe("CAPTURE123");
    expect(fetchMock).toHaveBeenCalledWith("/api/bounties/bounty-1/fund/capture", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: '{"orderId":"ORDER123"}',
    });
  });

  it.each([
    { status: "pending", captureId: "CAPTURE123" },
    { status: "open" },
    { status: "open", captureId: "" },
  ])("does not report success for an unconfirmed capture: %j", async (body) => {
    mockResponse(body);
    await expect(captureBountyOrder("bounty-1", "ORDER123")).rejects.toThrow();
  });

  it("preserves PayPal decline details so checkout can restart", async () => {
    mockResponse({ error: { code: "PAYPAL_ERROR", message: "Declined", paypalIssues: ["INSTRUMENT_DECLINED"] } }, 502);
    await expect(captureBountyOrder("bounty-1", "ORDER123")).rejects.toMatchObject({
      code: "PAYPAL_ERROR", paypalIssues: ["INSTRUMENT_DECLINED"],
    });
  });

  it("preserves verification failures instead of marking the bounty funded", async () => {
    mockResponse({ error: { code: "CAPTURE_VERIFICATION_FAILED", message: "capture status is PENDING" } }, 422);
    await expect(captureBountyOrder("bounty-1", "ORDER123")).rejects.toBeInstanceOf(FundingError);
  });

  it("handles a non-JSON server failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Bad gateway", { status: 502 })));
    await expect(createBountyOrder("bounty-1")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

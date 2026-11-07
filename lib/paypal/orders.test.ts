import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetTokenCache, PayPalError } from "./client";
import {
  captureFundingOrder,
  createFundingOrder,
  formatUsdCents,
  getFundingOrder,
  isOrderAlreadyCaptured,
  parseUsdToCents,
  verifyFundingCapture,
  type CaptureResult,
} from "./orders";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const tokenResponse = () => json({ access_token: "token-1", expires_in: 3600 });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("PAYPAL_ENVIRONMENT", "SANDBOX");
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-client-id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  resetTokenCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("money helpers", () => {
  it("formats cents as a 2-decimal string", () => {
    expect(formatUsdCents(2500)).toBe("25.00");
    expect(formatUsdCents(5)).toBe("0.05");
    expect(formatUsdCents(1999)).toBe("19.99");
  });

  it("parses decimal strings to cents and rejects anything odd", () => {
    expect(parseUsdToCents("25.00")).toBe(2500);
    expect(parseUsdToCents("25")).toBe(2500);
    expect(parseUsdToCents("25.5")).toBe(2550);
    expect(parseUsdToCents("0.05")).toBe(5);
    for (const bad of ["", "-1.00", "1.234", "1,00", "abc", "1e3", " 1.00"]) {
      expect(parseUsdToCents(bad)).toBeNull();
    }
  });
});

describe("createFundingOrder", () => {
  it("builds the order from the bounty record and returns the payer-action link", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      json(
        {
          id: "ORDER123",
          status: "PAYER_ACTION_REQUIRED",
          links: [
            { rel: "self", href: "https://api.sandbox.paypal.com/v2/checkout/orders/ORDER123" },
            { rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER123" },
          ],
        },
        201,
      ),
    );

    const result = await createFundingOrder({ id: "bounty1", title: "Add slugify", amountUsd: 25 });

    expect(result).toEqual({
      orderId: "ORDER123",
      approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER123",
    });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders");
    expect(init.headers["PayPal-Request-Id"]).toMatch(/^fund-bounty1-1-[0-9a-f]{8}$/);
    expect(JSON.parse(init.body)).toEqual({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: "bounty1",
          custom_id: "bounty1",
          description: "Bounty: Add slugify",
          amount: { currency_code: "USD", value: "25.00" },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "BountyPilot",
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: "http://localhost:3000/dev/funding-return?bountyId=bounty1",
            cancel_url: "http://localhost:3000/dev/funding-return?cancelled=1&bountyId=bounty1",
          },
        },
      },
    });
  });

  it("still accepts the older approve link, and puts a custom attempt in the request id", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      json({ id: "O2", status: "CREATED", links: [{ rel: "approve", href: "https://x/y" }] }, 201),
    );

    const result = await createFundingOrder({ id: "b", title: "t", amountUsd: 1.5 }, "OLDORDER");

    expect(result.approveUrl).toBe("https://x/y");
    expect(fetchMock.mock.calls[1][1].headers["PayPal-Request-Id"]).toMatch(
      /^fund-b-OLDORDER-[0-9a-f]{8}$/,
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).purchase_units[0].amount.value).toBe("1.50");
  });

  it("uses APP_URL (origin only) for the return and cancel URLs", async () => {
    vi.stubEnv("APP_URL", "https://bountypilot.example/some/path/");
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json({ id: "O4", status: "PAYER_ACTION_REQUIRED" }, 201));

    await createFundingOrder({ id: "b 1", title: "t", amountUsd: 5 });

    const ctx = JSON.parse(fetchMock.mock.calls[1][1].body).payment_source.paypal.experience_context;
    expect(ctx.return_url).toBe("https://bountypilot.example/dev/funding-return?bountyId=b%201");
    expect(ctx.cancel_url).toBe(
      "https://bountypilot.example/dev/funding-return?cancelled=1&bountyId=b%201",
    );
  });

  it("defaults APP_URL to localhost and rejects a malformed one without calling PayPal", async () => {
    vi.stubEnv("APP_URL", "");
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json({ id: "O5", status: "PAYER_ACTION_REQUIRED" }, 201));
    await createFundingOrder({ id: "b", title: "t", amountUsd: 5 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).payment_source.paypal.experience_context.return_url).toBe(
      "http://localhost:3000/dev/funding-return?bountyId=b",
    );

    fetchMock.mockClear();
    vi.stubEnv("APP_URL", "not a url");
    await expect(createFundingOrder({ id: "b", title: "t", amountUsd: 5 })).rejects.toThrow(/APP_URL/);
    vi.stubEnv("APP_URL", "ftp://example.com");
    await expect(createFundingOrder({ id: "b", title: "t", amountUsd: 5 })).rejects.toThrow(/APP_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the idempotency key stable for identical requests but changes it when the request changes", async () => {
    const created = () => json({ id: "OX", status: "PAYER_ACTION_REQUIRED" }, 201);
    const requestIdOf = async (bounty: { id: string; title: string; amountUsd: number }) => {
      fetchMock.mockClear();
      resetTokenCache();
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(created());
      await createFundingOrder(bounty);
      return fetchMock.mock.calls[1][1].headers["PayPal-Request-Id"] as string;
    };

    const first = await requestIdOf({ id: "b", title: "t", amountUsd: 5 });
    const again = await requestIdOf({ id: "b", title: "t", amountUsd: 5 });
    const otherAmount = await requestIdOf({ id: "b", title: "t", amountUsd: 6 });
    vi.stubEnv("APP_URL", "https://other.example");
    const otherUrl = await requestIdOf({ id: "b", title: "t", amountUsd: 5 });

    expect(again).toBe(first); // a double click maps to one order
    expect(otherAmount).not.toBe(first); // a changed request is never replayed from the old one
    expect(otherUrl).not.toBe(first);
  });

  it("truncates a long description to PayPal's 127 characters", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json({ id: "O3", status: "CREATED" }, 201));

    await createFundingOrder({ id: "b", title: "x".repeat(300), amountUsd: 10 });

    const description = JSON.parse(fetchMock.mock.calls[1][1].body).purchase_units[0].description;
    expect(Array.from(description)).toHaveLength(127);
    expect(description.startsWith("Bounty: xxx")).toBe(true);
  });

  it("refuses a zero or negative amount", async () => {
    await expect(createFundingOrder({ id: "b", title: "t", amountUsd: 0 })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("captureFundingOrder / getFundingOrder", () => {
  it("returns the capture fields from purchase_units[0].payments.captures[0]", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      json(
        {
          id: "ORDER123",
          status: "COMPLETED",
          purchase_units: [
            {
              payments: {
                captures: [
                  {
                    id: "CAP1",
                    status: "COMPLETED",
                    amount: { currency_code: "USD", value: "25.00" },
                    custom_id: "bounty1",
                  },
                ],
              },
            },
          ],
        },
        201,
      ),
    );

    expect(await captureFundingOrder("ORDER123")).toEqual({
      status: "COMPLETED",
      captureStatus: "COMPLETED",
      captureId: "CAP1",
      amount: "25.00",
      currency: "USD",
      customId: "bounty1",
    });
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER123/capture",
    );
  });

  it("rejects order ids that could alter the URL path", async () => {
    await expect(captureFundingOrder("../../v1/payments")).rejects.toThrow();
    await expect(getFundingOrder("a/b")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getFundingOrder returns null for an order PayPal no longer has", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json({ name: "RESOURCE_NOT_FOUND", message: "gone" }, 404));

    expect(await getFundingOrder("GONE1")).toBeNull();
  });

  it("recognises ORDER_ALREADY_CAPTURED", () => {
    const already = new PayPalError({
      status: 422,
      name: "UNPROCESSABLE_ENTITY",
      message: "x",
      debugId: null,
      details: [{ issue: "ORDER_ALREADY_CAPTURED" }],
    });
    const other = new PayPalError({
      status: 422,
      name: "UNPROCESSABLE_ENTITY",
      message: "x",
      debugId: null,
      details: [{ issue: "INSTRUMENT_DECLINED" }],
    });
    expect(isOrderAlreadyCaptured(already)).toBe(true);
    expect(isOrderAlreadyCaptured(other)).toBe(false);
    expect(isOrderAlreadyCaptured(new Error("x"))).toBe(false);
  });
});

describe("verifyFundingCapture", () => {
  const good: CaptureResult = {
    status: "COMPLETED",
    captureStatus: "COMPLETED",
    captureId: "CAP1",
    amount: "25.00",
    currency: "USD",
    customId: "bounty1",
  };
  const expected = { bountyId: "bounty1", amountCents: 2500 };

  it("accepts an exact match", () => {
    expect(verifyFundingCapture(good, expected)).toEqual({ ok: true });
  });

  it.each([
    ["order not completed", { status: "APPROVED" }],
    ["capture still pending", { captureStatus: "PENDING" }],
    ["no capture", { captureId: null, captureStatus: null }],
    ["wrong currency", { currency: "EUR" }],
    ["amount too low", { amount: "24.99" }],
    ["amount too high", { amount: "25.01" }],
    ["amount not a number", { amount: "lots" }],
    ["missing amount", { amount: null }],
    ["different bounty", { customId: "someone-elses-bounty" }],
    ["missing custom_id", { customId: null }],
  ] as [string, Partial<CaptureResult>][])("rejects: %s", (_name, override) => {
    const result = verifyFundingCapture({ ...good, ...override }, expected);
    expect(result.ok).toBe(false);
  });
});

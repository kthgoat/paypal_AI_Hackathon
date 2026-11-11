import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAccessToken,
  paypalFetch,
  PayPalConfigError,
  PayPalError,
  resetTokenCache,
} from "./client";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const tokenResponse = (token = "token-1", expiresIn = 3600) =>
  json({ access_token: token, expires_in: expiresIn, token_type: "Bearer" });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("PAYPAL_ENVIRONMENT", "SANDBOX");
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-client-id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-client-secret");
  resetTokenCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("getAccessToken", () => {
  it("requests a client-credentials token from the sandbox and caches it", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse("token-1"));

    expect(await getAccessToken()).toBe("token-1");
    expect(await getAccessToken()).toBe("token-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(init.body).toBe("grant_type=client_credentials");
    const expectedBasic = Buffer.from("test-client-id:test-client-secret").toString("base64");
    expect(init.headers.Authorization).toBe(`Basic ${expectedBasic}`);
  });

  it("shares one request between concurrent callers", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse("token-1"));

    const tokens = await Promise.all([getAccessToken(), getAccessToken(), getAccessToken()]);

    expect(tokens).toEqual(["token-1", "token-1", "token-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes the token 60 seconds before it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
    fetchMock
      .mockResolvedValueOnce(tokenResponse("token-1", 3600))
      .mockResolvedValueOnce(tokenResponse("token-2", 3600));

    expect(await getAccessToken()).toBe("token-1");

    // 1 ms before the refresh margin (3600 s - 60 s): still cached.
    vi.setSystemTime(new Date("2026-11-06T00:00:00Z").getTime() + 3_540_000 - 1);
    expect(await getAccessToken()).toBe("token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // At the margin: refreshed.
    vi.setSystemTime(new Date("2026-11-06T00:00:00Z").getTime() + 3_540_000);
    expect(await getAccessToken()).toBe("token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when PAYPAL_ENVIRONMENT is not SANDBOX, without calling PayPal", async () => {
    vi.stubEnv("PAYPAL_ENVIRONMENT", "LIVE");
    await expect(getAccessToken()).rejects.toBeInstanceOf(PayPalConfigError);

    vi.stubEnv("PAYPAL_ENVIRONMENT", "");
    await expect(getAccessToken()).rejects.toBeInstanceOf(PayPalConfigError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names missing credentials but never their values", async () => {
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
    const error = await getAccessToken().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PayPalConfigError);
    expect((error as Error).message).toContain("PAYPAL_CLIENT_SECRET");
    expect((error as Error).message).not.toContain("test-client-id");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("paypalFetch", () => {
  it("sends the bearer token, JSON headers, body and PayPal-Request-Id", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse("token-1"))
      .mockResolvedValueOnce(json({ id: "ORDER1" }, 201));

    const result = await paypalFetch<{ id: string }>("/v2/checkout/orders", {
      method: "POST",
      body: { intent: "CAPTURE" },
      requestId: "req-1",
    });

    expect(result).toEqual({ id: "ORDER1" });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer token-1");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["PayPal-Request-Id"]).toBe("req-1");
    expect(JSON.parse(init.body)).toEqual({ intent: "CAPTURE" });
  });

  it("on 401 clears the token and retries exactly once", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse("token-1"))
      .mockResolvedValueOnce(json({ name: "AUTHENTICATION_FAILURE", message: "expired" }, 401))
      .mockResolvedValueOnce(tokenResponse("token-2"))
      .mockResolvedValueOnce(json({ ok: true }));

    expect(await paypalFetch("/v2/checkout/orders/ORDER1")).toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe("Bearer token-2");
  });

  it("does not retry a second 401", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse("token-1"))
      .mockResolvedValueOnce(json({ name: "AUTHENTICATION_FAILURE", message: "nope" }, 401))
      .mockResolvedValueOnce(tokenResponse("token-2"))
      .mockResolvedValueOnce(json({ name: "AUTHENTICATION_FAILURE", message: "nope" }, 401));

    const error = await paypalFetch("/v2/checkout/orders/ORDER1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PayPalError);
    expect((error as PayPalError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("parses PayPal's error body into a PayPalError", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      json(
        {
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed.",
          debug_id: "abc123",
          details: [{ issue: "ORDER_ALREADY_CAPTURED", description: "Order already captured." }],
        },
        422,
      ),
    );

    const error = await paypalFetch("/v2/checkout/orders/ORDER1/capture", {
      method: "POST",
      body: {},
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PayPalError);
    const e = error as PayPalError;
    expect(e.status).toBe(422);
    expect(e.paypalName).toBe("UNPROCESSABLE_ENTITY");
    expect(e.message).toBe("The requested action could not be performed.");
    expect(e.debugId).toBe("abc123");
    expect(e.details[0].issue).toBe("ORDER_ALREADY_CAPTURED");
  });

  it("parses the OAuth error shape and tolerates non-JSON bodies", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: "invalid_client", error_description: "Client Authentication failed" }, 401),
    );
    const oauthError = await getAccessToken().catch((e: unknown) => e);
    expect(oauthError).toBeInstanceOf(PayPalError);
    expect((oauthError as PayPalError).paypalName).toBe("invalid_client");
    expect((oauthError as PayPalError).message).toBe("Client Authentication failed");

    resetTokenCache();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("<html>Bad gateway</html>", { status: 502 }));
    const htmlError = await paypalFetch("/v2/checkout/orders/ORDER1").catch((e: unknown) => e);
    expect(htmlError).toBeInstanceOf(PayPalError);
    expect((htmlError as PayPalError).status).toBe(502);
  });
});

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readSettings, updateSettings } from "@/lib/settings";

import { GET, PATCH } from "./route";

vi.mock("@/lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings")>()),
  readSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

// connection() only works inside a real Next.js request, so stub it for these unit tests.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

const KEY = "route-test-maintainer-key-0002";
const read = vi.mocked(readSettings);
const update = vi.mocked(updateSettings);
const SETTINGS = { autoPayCapUsd: 50, contributorDailyCapUsd: 100, monthlyBudgetUsd: 500, paused: false };

function patch(body: unknown, headers: Record<string, string> = { "x-maintainer-key": KEY }, rawBody?: string) {
  return PATCH(
    new NextRequest("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: rawBody ?? JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("MAINTAINER_KEY", KEY);
  read.mockReset();
  update.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/settings", () => {
  it("needs no key and returns the settings in dollars, uncached", async () => {
    read.mockResolvedValue(SETTINGS);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SETTINGS);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("503 when the settings row is missing", async () => {
    read.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("SETTINGS_MISSING");
  });
});

describe("PATCH /api/settings", () => {
  it.each([
    ["no key", {}],
    ["a wrong key", { "x-maintainer-key": "wrong-wrong-wrong-wrong" }],
  ])("401 with %s, and nothing is changed", async (_name, headers) => {
    const response = await patch({ paused: true }, headers);

    expect(response.status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty body", {}],
    ["a negative amount", { autoPayCapUsd: -1 }],
    ["zero", { monthlyBudgetUsd: 0 }],
    ["more than the maximum", { monthlyBudgetUsd: 10_000.01 }],
    ["three decimals", { contributorDailyCapUsd: 1.234 }],
    ["an unknown field", { paused: true, extra: 1 }],
    ["a string for paused", { paused: "true" }],
  ])("400 for %s", async (_name, body) => {
    const response = await patch(body);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    expect(update).not.toHaveBeenCalled();
  });

  it("400 for a body that is not JSON", async () => {
    expect((await patch(null, undefined, "nope")).status).toBe(400);
  });

  it("applies a valid patch and returns the updated settings", async () => {
    update.mockResolvedValue({ ...SETTINGS, paused: true, autoPayCapUsd: 75.5 });

    const response = await patch({ paused: true, autoPayCapUsd: 75.5 });

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ paused: true, autoPayCapUsd: 75.5 });
    expect(await response.json()).toEqual({ ...SETTINGS, paused: true, autoPayCapUsd: 75.5 });
  });

  it("503 when the settings row is missing", async () => {
    update.mockResolvedValue(null);

    expect((await patch({ paused: true })).status).toBe(503);
  });
});

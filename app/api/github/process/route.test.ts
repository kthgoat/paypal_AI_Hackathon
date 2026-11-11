import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processPendingEvents } from "@/lib/orchestrator";

import { POST } from "./route";

vi.mock("@/lib/orchestrator", () => ({ processPendingEvents: vi.fn() }));

const KEY = "route-test-maintainer-key-0001";
const process = vi.mocked(processPendingEvents);

const call = (headers: Record<string, string> = { "x-maintainer-key": KEY }) =>
  POST(new NextRequest("http://localhost/api/github/process", { method: "POST", headers }));

beforeEach(() => {
  vi.stubEnv("MAINTAINER_KEY", KEY);
  process.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/github/process", () => {
  it.each([
    ["no key", {}],
    ["a wrong key", { "x-maintainer-key": "definitely-not-the-key-000" }],
  ])("401 with %s, and nothing is processed", async (_name, headers) => {
    const response = await call(headers);

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHORIZED");
    expect(process).not.toHaveBeenCalled();
  });

  it("500 when the server has no maintainer key configured, and nothing is processed", async () => {
    vi.stubEnv("MAINTAINER_KEY", "");

    const response = await call();

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("MAINTAINER_KEY_NOT_CONFIGURED");
    expect(process).not.toHaveBeenCalled();
  });

  it("with the key, processes the pending events and returns what happened", async () => {
    const processed = [
      { deliveryId: "d1", status: "done", verdictId: "verdict-d1", decision: { id: "x", outcome: "auto_pay", ruleFired: "all_checks_passed", decidedBy: "policy" } },
      { deliveryId: "d2", status: "waiting_ci", reason: "CI not finished: no checks reported yet" },
    ];
    process.mockResolvedValue(processed as never);

    const response = await call();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed });
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("an empty queue is a 200 with an empty list", async () => {
    process.mockResolvedValue([]);

    const response = await call();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed: [] });
  });

  it("500 with the error shape when processing blows up", async () => {
    process.mockRejectedValue(new Error("database is locked"));

    const response = await call();

    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  });
});

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discoverMergedPrEvents } from "@/lib/github/discover";
import { processPendingEvents } from "@/lib/orchestrator";

import { POST } from "./route";

vi.mock("@/lib/orchestrator", () => ({ processPendingEvents: vi.fn() }));
vi.mock("@/lib/github/discover", () => ({ discoverMergedPrEvents: vi.fn() }));

const KEY = "route-test-maintainer-key-0001";
const process = vi.mocked(processPendingEvents);
const discover = vi.mocked(discoverMergedPrEvents);

const call = (headers: Record<string, string> = { "x-maintainer-key": KEY }) =>
  POST(new NextRequest("http://localhost/api/github/process", { method: "POST", headers }));

beforeEach(() => {
  vi.stubEnv("MAINTAINER_KEY", KEY);
  process.mockReset().mockResolvedValue([]);
  discover.mockReset().mockResolvedValue({ discovered: 0, reposChecked: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/github/process: authentication", () => {
  it.each([
    ["no key", {}],
    ["a wrong key", { "x-maintainer-key": "definitely-not-the-key-000" }],
  ])("401 with %s, and neither GitHub nor the queue is touched", async (_name, headers) => {
    const response = await call(headers);

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHORIZED");
    expect(discover).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });

  it("500 when the server has no maintainer key configured, and neither GitHub nor the queue is touched", async () => {
    vi.stubEnv("MAINTAINER_KEY", "");

    const response = await call();

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("MAINTAINER_KEY_NOT_CONFIGURED");
    expect(discover).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });
});

describe("POST /api/github/process", () => {
  it("with the key, looks for new merged PRs first, then processes the queue, and returns both", async () => {
    const order: string[] = [];
    discover.mockImplementation(async () => {
      order.push("discover");
      return { discovered: 1, reposChecked: 1 };
    });
    const processed = [
      { deliveryId: "d1", status: "done", verdictId: "verdict-d1", decision: { id: "x", outcome: "auto_pay", ruleFired: "all_checks_passed", decidedBy: "policy" } },
      { deliveryId: "d2", status: "waiting_ci", reason: "CI not finished: no checks reported yet" },
    ];
    process.mockImplementation(async () => {
      order.push("process");
      return processed as never;
    });

    const response = await call();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ discovered: 1, processed });
    expect(order).toEqual(["discover", "process"]);
  });

  it("an empty queue and nothing new is a 200 with discovered 0 and an empty list", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ discovered: 0, processed: [] });
  });

  it("when GitHub cannot be checked, existing events are still processed and the reason comes back", async () => {
    discover.mockResolvedValue({ discovered: 0, reposChecked: 0, error: "GitHub GET /repos/acme/widgets/pulls failed with 403 (permission or rate limit)" });
    process.mockResolvedValue([{ deliveryId: "d1", status: "done" }] as never);

    const response = await call();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      discovered: 0,
      discoveryError: "GitHub GET /repos/acme/widgets/pulls failed with 403 (permission or rate limit)",
      processed: [{ deliveryId: "d1", status: "done" }],
    });
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("omits discoveryError when discovery worked", async () => {
    expect(Object.keys(await (await call()).json())).not.toContain("discoveryError");
  });

  it("500 with the error shape when processing blows up", async () => {
    process.mockRejectedValue(new Error("database is locked"));

    const response = await call();

    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  });
});

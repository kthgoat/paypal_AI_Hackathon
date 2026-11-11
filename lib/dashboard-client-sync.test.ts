import { afterEach, describe, expect, it, vi } from "vitest";

import { describeSync, processMergedPrs } from "./dashboard-client";

afterEach(() => vi.unstubAllGlobals());

describe("describeSync", () => {
  it("says so when nothing is waiting", () => {
    expect(describeSync([])).toBe("No merged PRs are waiting to be processed.");
  });

  it("counts one event", () => {
    expect(describeSync([{ status: "done" }])).toBe("Processed 1 merged PR event: 1 done.");
  });

  it("counts several events by status", () => {
    expect(describeSync([{ status: "done" }, { status: "waiting_ci" }, { status: "done" }, { status: "failed" }])).toBe(
      "Processed 4 merged PR events: 2 done, 1 waiting for CI, 1 failed.",
    );
  });

  it("passes an unknown status through", () => {
    expect(describeSync([{ status: "something_new" }])).toBe("Processed 1 merged PR event: 1 something_new.");
  });
});

describe("processMergedPrs", () => {
  it("POSTs to /api/github/process with no key header (the local session cookie is what authorises it)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ processed: [{ deliveryId: "d1", status: "done" }] })));
    vi.stubGlobal("fetch", fetchMock);

    expect(await processMergedPrs()).toEqual({ processed: [{ deliveryId: "d1", status: "done" }] });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/github/process");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/maintainer-key/i);
  });

  it("throws the server's message on an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Missing or invalid x-maintainer-key header." } }), { status: 401 })),
    );

    await expect(processMergedPrs()).rejects.toThrow("Missing or invalid x-maintainer-key header.");
  });
});

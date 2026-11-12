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

describe("describeSync with the GitHub check", () => {
  it("reports what was found and what happened to it", () => {
    expect(describeSync([{ status: "done" }], { discovered: 1 })).toBe("Found 1 new merged PR. Processed 1 merged PR event: 1 done.");
  });

  it("pluralises", () => {
    expect(describeSync([{ status: "done" }, { status: "done" }], { discovered: 2 })).toBe(
      "Found 2 new merged PRs. Processed 2 merged PR events: 2 done.",
    );
  });

  it("says so when GitHub was checked and there is nothing new and nothing waiting", () => {
    expect(describeSync([], { discovered: 0 })).toBe("No new merged PRs found for open bounties, and none are waiting to be processed.");
  });

  it("says GitHub could not be checked, and still reports what was processed", () => {
    expect(describeSync([{ status: "done" }], { discovered: 0, discoveryError: "GitHub GET /repos/a/b/pulls failed with 403 (permission or rate limit)" })).toBe(
      "Could not check GitHub for merged PRs (GitHub GET /repos/a/b/pulls failed with 403 (permission or rate limit)). Processed 1 merged PR event: 1 done.",
    );
  });

  it("says GitHub could not be checked when nothing was waiting either", () => {
    expect(describeSync([], { discoveryError: "GITHUB_TOKEN is not set" })).toBe(
      "Could not check GitHub for merged PRs (GITHUB_TOKEN is not set). No events were waiting to be processed.",
    );
  });

  it("keeps the old wording when no discovery info is passed", () => {
    expect(describeSync([])).toBe("No merged PRs are waiting to be processed.");
  });
});

describe("processMergedPrs", () => {
  it("POSTs to /api/github/process with no key header (the local session cookie is what authorises it)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ discovered: 1, processed: [{ deliveryId: "d1", status: "done" }] })));
    vi.stubGlobal("fetch", fetchMock);

    expect(await processMergedPrs()).toEqual({ discovered: 1, processed: [{ deliveryId: "d1", status: "done" }] });

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

import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { processMergeEvent } from "@/lib/orchestrator";
import { resetFakeDb, tables } from "@/lib/testing/fake-db";

import { POST } from "./route";

vi.mock("@/lib/db", async (importOriginal) => {
  const { fakePrisma } = await import("@/lib/testing/fake-db");
  return { ...(await importOriginal<typeof import("@/lib/db")>()), prisma: fakePrisma };
});
vi.mock("@/lib/orchestrator", () => ({ processMergeEvent: vi.fn() }));

// after() only works inside a Next request; here we run the callback by hand and keep it to inspect.
const scheduled: (() => Promise<void> | void)[] = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<void> | void) => scheduled.push(task),
}));

const SECRET = "webhook-test-secret-0001";
const process_ = vi.mocked(processMergeEvent);

const payload = (over: { merged?: boolean; action?: string } = {}) => ({
  action: over.action ?? "closed",
  repository: { full_name: "Acme/Widgets" },
  pull_request: {
    number: 7, merged: over.merged ?? true, html_url: "https://github.com/acme/widgets/pull/7",
    user: { login: "alice" }, merge_commit_sha: "b".repeat(40),
  },
});

function send(body: unknown, { event = "pull_request", delivery = "delivery-1", signWith = SECRET } = {}) {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", signWith).update(raw).digest("hex")}`;
  return POST(
    new Request("http://localhost/api/github/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": signature, "x-github-event": event, "x-github-delivery": delivery },
      body: raw,
    }),
  );
}

beforeEach(() => {
  resetFakeDb();
  scheduled.length = 0;
  process_.mockReset().mockResolvedValue({ deliveryId: "delivery-1", status: "done" });
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/github/webhook: processing", () => {
  it("stores a merged PR, answers 201 first, and only then schedules processing", async () => {
    const response = await send(payload());

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: "received", deliveryId: "delivery-1" });
    expect(tables.gitHubMergeEvent).toHaveLength(1);
    expect(tables.gitHubMergeEvent[0]).toMatchObject({ deliveryId: "delivery-1", repo: "acme/widgets", status: "received" });

    expect(process_).not.toHaveBeenCalled(); // nothing ran before the response
    expect(scheduled).toHaveLength(1);
    await scheduled[0]();
    expect(process_).toHaveBeenCalledWith("delivery-1");
  });

  it("a processing error after the response never throws out of the scheduled task", async () => {
    process_.mockRejectedValue(new Error("database is locked"));
    await send(payload());

    await expect(scheduled[0]()).resolves.toBeUndefined();
  });

  it.each([
    ["a bad signature", () => send(payload(), { signWith: "wrong-secret" })],
    ["a ping", () => send({ zen: "hi" }, { event: "ping" })],
    ["another event type", () => send({}, { event: "issues" })],
    ["a PR closed without merging", () => send(payload({ merged: false }))],
    ["a PR that was opened", () => send(payload({ action: "opened" }))],
  ])("schedules nothing for %s", async (_name, go) => {
    await go();

    expect(scheduled).toHaveLength(0);
    expect(tables.gitHubMergeEvent ?? []).toHaveLength(0);
  });

  it("a replayed delivery is reported as a duplicate and processed no second time", async () => {
    await send(payload());
    scheduled.length = 0;

    const again = await send(payload());

    expect(await again.json()).toEqual({ status: "duplicate" });
    expect(scheduled).toHaveLength(0);
    expect(tables.gitHubMergeEvent).toHaveLength(1);
  });
});

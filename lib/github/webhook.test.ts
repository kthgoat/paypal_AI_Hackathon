import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/github/webhook/route";
import { prisma } from "../db";
import { Prisma } from "../generated/prisma/client";
import { verifyWebhookSignature } from "./webhook";

vi.mock("../db", () => ({ prisma: { gitHubMergeEvent: { create: vi.fn() } } }));
// The route now schedules processing with after(), which only works inside a Next request.
// What it schedules is tested in app/api/github/webhook/route.test.ts.
vi.mock("../orchestrator", () => ({ processMergeEvent: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));

const secret = "test-webhook-secret";
const payload = {
  action: "closed",
  repository: { full_name: "Example/Demo" },
  pull_request: {
    number: 12,
    merged: true,
    html_url: "https://github.com/Example/Demo/pull/12",
    user: { login: "contributor" },
    merge_commit_sha: "a".repeat(40),
  },
};

function request(value: unknown = payload, headers: Record<string, string> = {}) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return new Request("http://localhost/api/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      ...headers,
    },
    body,
  });
}

beforeEach(() => {
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", secret);
  vi.mocked(prisma.gitHubMergeEvent.create).mockReset().mockResolvedValue({} as never);
});
afterEach(() => vi.unstubAllEnvs());

describe("GitHub webhook", () => {
  it("matches GitHub's published UTF-8 signature test vector", () => {
    expect(verifyWebhookSignature(
      Buffer.from("Hello, World!"),
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      "It's a Secret to Everybody",
    )).toBe(true);
  });

  it("rejects modified bytes and malformed signatures", () => {
    const bytes = Buffer.from("hello 🌍");
    const signature = `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;
    expect(verifyWebhookSignature(bytes, signature, secret)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from("hello 🌍 "), signature, secret)).toBe(false);
    for (const invalid of [null, "", "sha1=123", "sha256=zz", `sha256=${"z".repeat(64)}`]) {
      expect(verifyWebhookSignature(bytes, invalid, secret)).toBe(false);
    }
  });

  it("fails closed when the secret is missing", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    expect((await POST(request())).status).toBe(503);
    expect(prisma.gitHubMergeEvent.create).not.toHaveBeenCalled();
  });

  it("rejects unsigned requests before parsing or saving", async () => {
    expect((await POST(request("invalid JSON", { "x-hub-signature-256": "" }))).status).toBe(401);
    expect(prisma.gitHubMergeEvent.create).not.toHaveBeenCalled();
  });

  it("requires delivery headers and valid JSON", async () => {
    expect((await POST(request(payload, { "x-github-delivery": "" }))).status).toBe(400);
    expect((await POST(request("{"))).status).toBe(400);
    expect((await POST(request({ action: "closed" }))).status).toBe(400);
  });

  it("acknowledges ping and ignores unrelated events", async () => {
    expect(await (await POST(request({}, { "x-github-event": "ping" }))).json()).toEqual({ status: "pong" });
    expect(await (await POST(request({}, { "x-github-event": "push" }))).json()).toEqual({ status: "ignored" });
    expect(prisma.gitHubMergeEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    { ...payload, action: "opened" },
    { ...payload, pull_request: { ...payload.pull_request, merged: false } },
  ])("ignores PRs that were not merged", async (value) => {
    expect(await (await POST(request(value))).json()).toEqual({ status: "ignored" });
    expect(prisma.gitHubMergeEvent.create).not.toHaveBeenCalled();
  });

  it("persists merged PR metadata before acknowledging receipt", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(prisma.gitHubMergeEvent.create).toHaveBeenCalledWith({ data: {
      deliveryId: "delivery-1", repo: "example/demo", prNumber: 12,
      prUrl: payload.pull_request.html_url, prAuthor: "contributor", mergeSha: "a".repeat(40),
    } });
  });

  it("rejects a merged PR without a merge commit", async () => {
    const response = await POST(request({ ...payload, pull_request: { ...payload.pull_request, merge_commit_sha: null } }));
    expect(response.status).toBe(400);
    expect(prisma.gitHubMergeEvent.create).not.toHaveBeenCalled();
  });

  it("acknowledges database uniqueness conflicts as duplicates", async () => {
    vi.mocked(prisma.gitHubMergeEvent.create).mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed", { code: "P2002", clientVersion: "7.10.1" },
    ));
    expect(await (await POST(request())).json()).toEqual({ status: "duplicate" });
  });

  it("returns a failure when persistence fails so the delivery can be retried", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(prisma.gitHubMergeEvent.create).mockRejectedValue(new Error("Database unavailable"));
      expect((await POST(request())).status).toBe(500);
    } finally { log.mockRestore(); }
  });
});

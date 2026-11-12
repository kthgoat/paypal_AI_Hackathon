import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "../generated/prisma/client";
import { fakePrisma, seedBasics, tables } from "../testing/fake-db";
import { discoverMergedPrEvents, MAX_PRS_PER_REPO } from "./discover";

vi.mock("../db", async (importOriginal) => {
  const { fakePrisma } = await import("../testing/fake-db");
  return { ...(await importOriginal<typeof import("../db")>()), prisma: fakePrisma };
});

const TOKEN = "ghp_discover_test_token_123";
const SHA = "b".repeat(40);
// seedBasics: bounty b1 = acme/widgets#12, open, funded, claimed, created 2026-01-01
const AFTER = "2026-02-01T00:00:00Z";
const BEFORE = "2025-12-01T00:00:00Z";

const pull = (over: Record<string, unknown> = {}) => ({
  number: 7,
  html_url: "https://github.com/acme/widgets/pull/7",
  body: "Adds slugify.\n\nCloses #12",
  merged_at: AFTER,
  merge_commit_sha: SHA,
  user: { login: "alice" },
  ...over,
});

let responses: Record<string, () => Response>;
let calls: { url: string; headers: Record<string, string> }[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const events = () => (tables.gitHubMergeEvent ?? []) as Record<string, unknown>[];

beforeEach(() => {
  seedBasics();
  calls = [];
  responses = { "/repos/acme/widgets/pulls": () => json([pull()]) };
  process.env.GITHUB_TOKEN = TOKEN;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url: String(input), headers: init?.headers as Record<string, string> });
      return (responses[url.pathname] ?? (() => json({ message: "Not Found" }, 404)))();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.GITHUB_TOKEN;
});

describe("discoverMergedPrEvents: recording", () => {
  it("records the same event the webhook would have stored, for a merged PR that closes an open bounty's issue", async () => {
    const result = await discoverMergedPrEvents();

    expect(result).toEqual({ discovered: 1, reposChecked: 1 });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      deliveryId: `sync-acme-widgets-pr7-${SHA.slice(0, 12)}`,
      repo: "acme/widgets",
      prNumber: 7,
      prUrl: "https://github.com/acme/widgets/pull/7",
      prAuthor: "alice",
      mergeSha: SHA,
      status: "received",
    });
  });

  it("lower-cases the repo and the sha, like the webhook does, but calls GitHub with the repo as stored", async () => {
    tables.bounty[0].repo = "Acme/Widgets";
    responses = { "/repos/Acme/Widgets/pulls": () => json([pull({ merge_commit_sha: "B".repeat(40) })]) };

    await discoverMergedPrEvents();

    expect(events()[0]).toMatchObject({ repo: "acme/widgets", mergeSha: SHA });
    expect(new URL(calls[0].url).pathname).toBe("/repos/Acme/Widgets/pulls");
  });

  it("asks for the most recent closed PRs, one call per repo, with the token only in the header", async () => {
    await discoverMergedPrEvents();

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/repos/acme/widgets/pulls");
    expect(Object.fromEntries(url.searchParams)).toEqual({ state: "closed", sort: "updated", direction: "desc", per_page: String(MAX_PRS_PER_REPO) });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].url).not.toContain(TOKEN);
  });

  it("records every matching PR", async () => {
    tables.bounty.push({ ...tables.bounty[0], id: "b2", issueNumber: 13 });
    tables.claim.push({ id: "c2", bountyId: "b2", githubUser: "bob", paypalEmail: "x@example.com", createdAt: new Date() });
    responses["/repos/acme/widgets/pulls"] = () =>
      json([pull(), pull({ number: 8, body: "Closes #13", merge_commit_sha: "c".repeat(40), user: { login: "bob" } })]);

    expect((await discoverMergedPrEvents()).discovered).toBe(2);
    expect(events().map((e) => e.prNumber)).toEqual([7, 8]);
  });

  it("a PR that closes two eligible bounties still becomes one event (the orchestrator decides what to do)", async () => {
    tables.bounty.push({ ...tables.bounty[0], id: "b2", issueNumber: 13 });
    tables.claim.push({ id: "c2", bountyId: "b2", githubUser: "alice", paypalEmail: "x@example.com", createdAt: new Date() });
    responses["/repos/acme/widgets/pulls"] = () => json([pull({ body: "Closes #12, closes #13" })]);

    expect((await discoverMergedPrEvents()).discovered).toBe(1);
  });

  it("makes one call per repo, however many bounties it has", async () => {
    tables.bounty.push({ ...tables.bounty[0], id: "b2", issueNumber: 13 }, { ...tables.bounty[0], id: "b3", repo: "other/repo", issueNumber: 1 });
    tables.claim.push(
      { id: "c2", bountyId: "b2", githubUser: "alice", paypalEmail: "x@example.com", createdAt: new Date() },
      { id: "c3", bountyId: "b3", githubUser: "alice", paypalEmail: "x@example.com", createdAt: new Date() },
    );
    responses["/repos/other/repo/pulls"] = () => json([]);

    const result = await discoverMergedPrEvents();

    expect(result.reposChecked).toBe(2);
    expect(calls.map((c) => new URL(c.url).pathname).sort()).toEqual(["/repos/acme/widgets/pulls", "/repos/other/repo/pulls"]);
  });
});

describe("discoverMergedPrEvents: which PRs and bounties count", () => {
  it.each([
    ["is not merged (closed only)", { merged_at: null, merge_commit_sha: null }],
    ["was merged before the bounty was created", { merged_at: BEFORE }],
    ["closes a different issue", { body: "Closes #99" }],
    ["only mentions the issue", { body: "Related to #12" }],
    ["has no body", { body: null }],
    ["closes the issue in another repo", { body: "Closes other/repo#12" }],
    ["has a malformed merge commit", { merge_commit_sha: "not-a-sha" }],
    ["has a malformed author login", { user: { login: "../../x" } }],
    ["has an http url", { html_url: "http://github.com/acme/widgets/pull/7" }],
    ["has an unparseable merge time", { merged_at: "yesterday-ish" }],
  ])("ignores a PR that %s", async (_name, over) => {
    responses["/repos/acme/widgets/pulls"] = () => json([pull(over)]);

    expect((await discoverMergedPrEvents()).discovered).toBe(0);
    expect(events()).toHaveLength(0);
  });

  it("skips one odd item without hiding the good ones next to it", async () => {
    responses["/repos/acme/widgets/pulls"] = () => json([{ garbage: true }, null, pull()]);

    expect((await discoverMergedPrEvents()).discovered).toBe(1);
  });

  it.each([
    ["is not open (awaiting_funding)", { status: "awaiting_funding" }],
    ["is paid", { status: "paid" }],
    ["is awaiting approval", { status: "awaiting_approval" }],
    ["is rejected", { status: "rejected" }],
    ["is open but has no funding capture", { fundingCaptureId: null }],
  ])("checks nothing for a bounty that %s", async (_name, over) => {
    Object.assign(tables.bounty[0], over);

    expect(await discoverMergedPrEvents()).toEqual({ discovered: 0, reposChecked: 0 });
    expect(calls).toHaveLength(0);
  });

  it("checks nothing for an open, funded bounty that has no claim", async () => {
    tables.claim = [];

    expect(await discoverMergedPrEvents()).toEqual({ discovered: 0, reposChecked: 0 });
    expect(calls).toHaveLength(0);
  });

  it("checks nothing when there are no bounties at all", async () => {
    tables.bounty = [];
    tables.claim = [];

    expect(await discoverMergedPrEvents()).toEqual({ discovered: 0, reposChecked: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("discoverMergedPrEvents: duplicates", () => {
  it("running it twice records the event once", async () => {
    await discoverMergedPrEvents();
    const second = await discoverMergedPrEvents();

    expect(second.discovered).toBe(0);
    expect(events()).toHaveLength(1);
  });

  it("does not record a merge the webhook already stored under another delivery id", async () => {
    tables.gitHubMergeEvent = [
      {
        deliveryId: "github-delivery-xyz", repo: "acme/widgets", prNumber: 7, prUrl: "u", prAuthor: "alice", mergeSha: SHA,
        receivedAt: new Date(), status: "done", attempts: 0, lastError: null, claimedAt: null, processedAt: new Date(), verdictId: "v",
      },
    ];

    expect((await discoverMergedPrEvents()).discovered).toBe(0);
    expect(events()).toHaveLength(1);
  });

  it("does not touch an event that is already done, skipped or failed", async () => {
    await discoverMergedPrEvents();
    events()[0].status = "skipped";

    await discoverMergedPrEvents();

    expect(events()).toHaveLength(1);
    expect(events()[0].status).toBe("skipped");
  });

  it("a unique-constraint race (another writer got there first) is not an error and not counted", async () => {
    vi.spyOn(fakePrisma.gitHubMergeEvent, "create").mockImplementation(() => {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "fake" });
    });

    expect(await discoverMergedPrEvents()).toEqual({ discovered: 0, reposChecked: 1 });
  });
});

describe("discoverMergedPrEvents: it never throws and changes nothing but events", () => {
  it.each([
    ["a 403", () => json({ message: "Resource not accessible" }, 403), /failed with 403 \(permission or rate limit\)/],
    ["a 404", () => json({ message: "Not Found" }, 404), /failed with 404/],
    ["a 500", () => json({ message: "boom" }, 500), /failed with 500/],
    ["a non-array body", () => json({ message: "weird" }), /unexpected response/],
  ])("%s becomes a short error", async (_name, respond, message) => {
    responses["/repos/acme/widgets/pulls"] = respond;

    const result = await discoverMergedPrEvents();

    expect(result).toMatchObject({ discovered: 0, reposChecked: 0 });
    expect(result.error).toMatch(message);
    expect(result.error).not.toContain(TOKEN);
  });

  it("a network failure becomes an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    expect((await discoverMergedPrEvents()).error).toMatch(/network error/);
  });

  it("a timeout becomes an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" })));

    expect((await discoverMergedPrEvents()).error).toMatch(/timed out/);
  });

  it("a missing token is reported and GitHub is not called", async () => {
    delete process.env.GITHUB_TOKEN;

    const result = await discoverMergedPrEvents();

    expect(result.error).toBe("GITHUB_TOKEN is not set");
    expect(calls).toHaveLength(0);
  });

  it("one repo failing does not stop the next one", async () => {
    tables.bounty.push({ ...tables.bounty[0], id: "b2", repo: "zzz/other", issueNumber: 5 });
    tables.claim.push({ id: "c2", bountyId: "b2", githubUser: "alice", paypalEmail: "x@example.com", createdAt: new Date() });
    responses["/repos/acme/widgets/pulls"] = () => json({ message: "nope" }, 403);
    responses["/repos/zzz/other/pulls"] = () => json([pull({ number: 9, body: "Closes #5", html_url: "https://github.com/zzz/other/pull/9", merge_commit_sha: "d".repeat(40) })]);

    const result = await discoverMergedPrEvents();

    expect(result.discovered).toBe(1);
    expect(result.reposChecked).toBe(1);
    expect(result.error).toMatch(/\/repos\/acme\/widgets\/pulls failed with 403/);
    expect(events()[0]).toMatchObject({ repo: "zzz/other", prNumber: 9 });
  });

  it("a database failure reading bounties is reported, not thrown", async () => {
    vi.spyOn(fakePrisma.bounty, "findMany").mockImplementation(() => {
      throw new Error("database is locked");
    });

    const result = await discoverMergedPrEvents();

    expect(result.error).toMatch(/could not read open bounties/);
    expect(calls).toHaveLength(0);
  });

  it("leaves bounties, claims, payouts, decisions and verdicts exactly as they were", async () => {
    const before = structuredClone({ bounty: tables.bounty, claim: tables.claim, payout: tables.payout, decision: tables.decision, verdict: tables.verdict, settings: tables.settings });

    await discoverMergedPrEvents();
    await discoverMergedPrEvents();

    expect({ bounty: tables.bounty, claim: tables.claim, payout: tables.payout, decision: tables.decision, verdict: tables.verdict, settings: tables.settings }).toEqual(before);
  });
});

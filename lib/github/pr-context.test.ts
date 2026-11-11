import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { evaluateCi, getPrContext, GitHubError, MAX_DIFF_BYTES, parseLinkedIssues, truncateUtf8 } from "./pr-context";

const TOKEN = "ghp_test_token_value_123";
const HEAD = "a".repeat(40);

describe("parseLinkedIssues", () => {
  it.each([
    ["Closes #12", [12]],
    ["closes #12", [12]],
    ["FIXES #7 and resolves #9", [7, 9]],
    ["Fixed #3.", [3]],
    ["resolved: #4", [4]],
    ["Closes acme/widgets#12", [12]],
    ["Closes ACME/Widgets#12", [12]],
    ["fixes https://github.com/acme/widgets/issues/21", [21]],
    ["Closes #5, closes #5", [5]],
    ["Closes #30 Closes #2", [2, 30]],
  ])("%j -> %j", (body, expected) => {
    expect(parseLinkedIssues(body, "acme/widgets")).toEqual(expected);
  });

  it.each([
    "Related to #12",
    "See #12 for context",
    "Closes other/repo#12",
    "Fixes https://github.com/other/repo/issues/8",
    "Closes #0",
    "disclosed #5",
    "",
  ])("ignores %j", (body) => {
    expect(parseLinkedIssues(body, "acme/widgets")).toEqual([]);
  });

  it("copes with a missing body", () => {
    expect(parseLinkedIssues(null, "acme/widgets")).toEqual([]);
  });
});

describe("evaluateCi", () => {
  const run = (status: string, conclusion: string | null) => ({ status, conclusion });

  it.each([
    ["all green", [run("completed", "success"), run("completed", "skipped"), run("completed", "neutral")], null, "passed"],
    ["one failure", [run("completed", "success"), run("completed", "failure")], null, "failed"],
    ["cancelled counts as failed", [run("completed", "cancelled")], null, "failed"],
    ["timed out counts as failed", [run("completed", "timed_out")], null, "failed"],
    ["queued", [run("completed", "success"), run("queued", null)], null, "pending"],
    ["in progress", [run("in_progress", null)], null, "pending"],
    ["failure beats pending", [run("in_progress", null), run("completed", "failure")], null, "failed"],
    ["no checks at all", [], null, "pending"],
    ["no runs, empty commit status", [], { state: "pending", total_count: 0 }, "pending"],
    ["status success only", [], { state: "success", total_count: 2 }, "passed"],
    ["status failure", [run("completed", "success")], { state: "failure", total_count: 1 }, "failed"],
    ["status error", [], { state: "error", total_count: 1 }, "failed"],
    ["status pending", [run("completed", "success")], { state: "pending", total_count: 1 }, "pending"],
    ["an unknown conclusion is not a pass", [run("completed", "something_new")], null, "pending"],
  ])("%s -> %s", (_name, runs, combined, expected) => {
    expect(evaluateCi(runs, combined).ci).toBe(expected);
  });
});

describe("truncateUtf8", () => {
  it("leaves short text alone", () => {
    expect(truncateUtf8("héllo", 100)).toEqual({ text: "héllo", truncated: false });
  });

  it("cuts to the byte limit without leaving half a character", () => {
    const result = truncateUtf8("ééééé", 5); // each é is 2 bytes
    expect(result).toEqual({ text: "éé", truncated: true });
  });
});

// ---------------------------------------------------------------------------
// getPrContext, with fetch mocked
// ---------------------------------------------------------------------------

type Handler = Response | (() => Response);
let routes: Record<string, Handler>;
let calls: { path: string; headers: Record<string, string> }[];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const basePr = {
  title: "Add slugify",
  body: "Adds the helper.\n\nCloses #12",
  merged: true,
  user: { login: "alice" },
  merged_by: { login: "maintainer" },
  merge_commit_sha: "b".repeat(40),
  base: { ref: "main" },
  head: { sha: HEAD },
};

function defaultRoutes(): Record<string, Handler> {
  return {
    "/repos/acme/widgets/pulls/7": () => json(basePr),
    "/repos/acme/widgets": () => json({ default_branch: "main" }),
    "/repos/acme/widgets/collaborators/maintainer/permission": () => json({ permission: "write", role_name: "maintain" }),
    [`/repos/acme/widgets/commits/${HEAD}/check-runs`]: () =>
      json({ total_count: 2, check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "success" }] }),
    [`/repos/acme/widgets/commits/${HEAD}/status`]: () => json({ state: "pending", total_count: 0 }),
    "/repos/acme/widgets/pulls/7/files": () =>
      json([{ filename: "src/slugify.ts", status: "added", additions: 10, deletions: 0 }, { filename: "src/slugify.test.ts", status: "added", additions: 20, deletions: 0 }]),
    "diff:/repos/acme/widgets/pulls/7": () => new Response("diff --git a/src/slugify.ts b/src/slugify.ts\n+export const slugify = () => {}\n"),
  };
}

beforeEach(() => {
  calls = [];
  routes = defaultRoutes();
  process.env.GITHUB_TOKEN = TOKEN;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = init?.headers as Record<string, string>;
      calls.push({ path: url.pathname, headers });
      const wantsDiff = headers.Accept === "application/vnd.github.diff";
      const handler = routes[wantsDiff ? `diff:${url.pathname}` : url.pathname];
      if (!handler) return json({ message: "Not Found" }, 404);
      return typeof handler === "function" ? handler() : handler.clone();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_TOKEN;
});

describe("getPrContext", () => {
  it("collects the facts the orchestrator needs", async () => {
    const ctx = await getPrContext("acme/widgets", 7);

    expect(ctx).toMatchObject({
      repo: "acme/widgets",
      prNumber: 7,
      title: "Add slugify",
      author: "alice",
      merged: true,
      mergedBy: "maintainer",
      mergedByMaintainer: true,
      baseBranch: "main",
      defaultBranch: "main",
      mergedIntoDefaultBranch: true,
      mergeCommitSha: "b".repeat(40),
      headSha: HEAD,
      linkedIssues: [12],
      ci: "passed",
      diffTruncated: false,
    });
    expect(ctx.files.map((f) => f.filename)).toEqual(["src/slugify.ts", "src/slugify.test.ts"]);
    expect(ctx.diff).toContain("export const slugify");
  });

  it("sends the token only in the Authorization header and reads CI from the PR's head commit", async () => {
    await getPrContext("acme/widgets", 7);

    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) {
      expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.path).not.toContain(TOKEN);
    }
    expect(calls.map((c) => c.path)).toContain(`/repos/acme/widgets/commits/${HEAD}/check-runs`);
    expect(calls.map((c) => c.path)).not.toContain(`/repos/acme/widgets/commits/${"b".repeat(40)}/check-runs`);
  });

  it("says when the PR was merged into a branch other than the default", async () => {
    routes["/repos/acme/widgets/pulls/7"] = () => json({ ...basePr, base: { ref: "release" } });

    const ctx = await getPrContext("acme/widgets", 7);

    expect(ctx).toMatchObject({ baseBranch: "release", defaultBranch: "main", mergedIntoDefaultBranch: false });
  });

  it("reports an unmerged PR", async () => {
    routes["/repos/acme/widgets/pulls/7"] = () => json({ ...basePr, merged: false, merged_by: null, merge_commit_sha: null });

    const ctx = await getPrContext("acme/widgets", 7);

    expect(ctx).toMatchObject({ merged: false, mergedBy: null, mergedByMaintainer: false, mergeCommitSha: null });
  });

  it.each([
    ["admin", { permission: "admin", role_name: "admin" }, true],
    ["maintain", { permission: "write", role_name: "maintain" }, true],
    ["write", { permission: "write", role_name: "write" }, true],
    ["triage", { permission: "read", role_name: "triage" }, false],
    ["read", { permission: "read", role_name: "read" }, false],
    ["legacy answer without role_name: write", { permission: "write" }, true],
    ["legacy answer without role_name: read", { permission: "read" }, false],
    ["none", { permission: "none", role_name: "none" }, false],
  ])("merged_by permission %s -> mergedByMaintainer %s", async (_name, answer, expected) => {
    routes["/repos/acme/widgets/collaborators/maintainer/permission"] = () => json(answer);

    expect((await getPrContext("acme/widgets", 7)).mergedByMaintainer).toBe(expected);
  });

  it("a 404 on the permission lookup means 'not a collaborator'", async () => {
    routes["/repos/acme/widgets/collaborators/maintainer/permission"] = () => json({ message: "Not Found" }, 404);

    expect((await getPrContext("acme/widgets", 7)).mergedByMaintainer).toBe(false);
  });

  it("a 403 on the permission lookup is an error, not 'not a maintainer'", async () => {
    routes["/repos/acme/widgets/collaborators/maintainer/permission"] = () => json({ message: "Resource not accessible" }, 403);

    const error = await getPrContext("acme/widgets", 7).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(403);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("does not look up permissions for a login that is not a valid username", async () => {
    routes["/repos/acme/widgets/pulls/7"] = () => json({ ...basePr, merged_by: { login: "../../orgs/x" } });

    const ctx = await getPrContext("acme/widgets", 7);

    expect(ctx.mergedByMaintainer).toBe(false);
    expect(calls.some((c) => c.path.includes("collaborators"))).toBe(false);
  });

  it("ci is failed when a check run failed, even if another is still running", async () => {
    routes[`/repos/acme/widgets/commits/${HEAD}/check-runs`] = () =>
      json({ total_count: 2, check_runs: [{ status: "in_progress", conclusion: null }, { status: "completed", conclusion: "failure" }] });

    expect((await getPrContext("acme/widgets", 7)).ci).toBe("failed");
  });

  it("ci is pending when there are no checks at all", async () => {
    routes[`/repos/acme/widgets/commits/${HEAD}/check-runs`] = () => json({ total_count: 0, check_runs: [] });

    expect((await getPrContext("acme/widgets", 7)).ci).toBe("pending");
  });

  it("ci is failed when the commit status failed", async () => {
    routes[`/repos/acme/widgets/commits/${HEAD}/status`] = () => json({ state: "failure", total_count: 1 });

    expect((await getPrContext("acme/widgets", 7)).ci).toBe("failed");
  });

  it("cuts a large diff to about 30 KB but keeps every file name", async () => {
    routes["diff:/repos/acme/widgets/pulls/7"] = () => new Response("+" + "x".repeat(MAX_DIFF_BYTES * 3));

    const ctx = await getPrContext("acme/widgets", 7);

    expect(ctx.diffTruncated).toBe(true);
    expect(Buffer.byteLength(ctx.diff)).toBeLessThanOrEqual(MAX_DIFF_BYTES);
    expect(ctx.diff.length).toBeGreaterThan(MAX_DIFF_BYTES - 10);
    expect(ctx.files).toHaveLength(2);
  });

  it("fails clearly without a token", async () => {
    delete process.env.GITHUB_TOKEN;

    await expect(getPrContext("acme/widgets", 7)).rejects.toThrow("GITHUB_TOKEN is not set");
  });

  it.each([
    ["a path-like repo", "acme/widgets/../../x", 7],
    ["a repo without an owner", "widgets", 7],
    ["a zero PR number", "acme/widgets", 0],
    ["a fractional PR number", "acme/widgets", 1.5],
  ])("rejects %s before calling GitHub", async (_name, repo, pr) => {
    await expect(getPrContext(repo, pr)).rejects.toThrow(GitHubError);
    expect(calls).toHaveLength(0);
  });

  it("turns a GitHub failure into an error that does not contain the token", async () => {
    routes["/repos/acme/widgets/pulls/7"] = () => json({ message: "Bad credentials" }, 401);

    const error = await getPrContext("acme/widgets", 7).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(401);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("turns a network failure into a GitHubError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    await expect(getPrContext("acme/widgets", 7)).rejects.toThrow(/network error/);
  });
});

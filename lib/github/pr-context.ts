// Reads everything the orchestrator needs to know about a merged PR from the GitHub REST API.
// Plain fetch with GITHUB_TOKEN; the token is only ever sent in the Authorization header and is
// never put into an error message or a log line.
//
// Trust: GitHub tells us who merged and what CI said, so those facts are trusted. The PR title,
// body, file names and diff are written by the PR author and are returned only as data for the
// reviewer (inside <untrusted> tags), never as instructions.

import { z } from "zod";

const API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;

/** How much of the diff the reviewer sees. */
export const MAX_DIFF_BYTES = 30 * 1024;
const MAX_FILES = 300;
const MAX_CHECK_PAGES = 3;

export type CiState = "passed" | "failed" | "pending";

export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface PrContext {
  repo: string;
  prNumber: number;
  title: string;
  body: string;
  author: string;
  merged: boolean;
  mergedBy: string | null;
  mergedByMaintainer: boolean;
  baseBranch: string;
  defaultBranch: string;
  mergedIntoDefaultBranch: boolean;
  mergeCommitSha: string | null;
  /** The PR's last commit: the one that was reviewed and whose checks gated the merge. */
  headSha: string;
  /** Issue numbers in this repo named by "closes/fixes/resolves #N" in the PR body. Untrusted: see the orchestrator. */
  linkedIssues: number[];
  ci: CiState;
  /** One short line about the checks, e.g. "3 check runs passed". */
  ciSummary: string;
  files: ChangedFile[];
  filesTruncated: boolean;
  /** Unified diff, cut to MAX_DIFF_BYTES. */
  diff: string;
  diffTruncated: boolean;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]|\[bot\])*$/;
const SHA_PATTERN = /^[a-fA-F0-9]{7,64}$/;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:([\w.-]+\/[\w.-]+)#(\d+)|#(\d+)|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+))/gi;

/** Issue numbers in `repo` that the PR body says it closes. References to other repos are ignored. */
export function parseLinkedIssues(body: string | null | undefined, repo: string): number[] {
  const numbers = new Set<number>();
  for (const match of (body ?? "").matchAll(CLOSING_KEYWORD)) {
    const [, crossRepo, crossNumber, sameNumber, urlRepo, urlNumber] = match;
    const targetRepo = crossRepo ?? urlRepo;
    if (targetRepo && targetRepo.toLowerCase() !== repo.toLowerCase()) continue;
    const n = Number(crossNumber ?? sameNumber ?? urlNumber);
    if (Number.isSafeInteger(n) && n > 0) numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b);
}

export interface CheckRunLike {
  status: string;
  conclusion: string | null;
}
export interface CombinedStatusLike {
  state: string;
  total_count: number;
}

const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);
const PASSED_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Failed if any check run or commit status failed or was cancelled; pending if anything is still
 * queued or running, or if there are no checks at all; otherwise passed. Failure wins over pending.
 */
export function evaluateCi(checkRuns: CheckRunLike[], combined: CombinedStatusLike | null): { ci: CiState; summary: string } {
  const statusCount = combined?.total_count ?? 0;
  const total = checkRuns.length + statusCount;
  if (total === 0) return { ci: "pending", summary: "no checks reported yet" };

  const failedRuns = checkRuns.filter((r) => r.status === "completed" && (r.conclusion === null || FAILED_CONCLUSIONS.has(r.conclusion)));
  const unfinishedRuns = checkRuns.filter((r) => r.status !== "completed");
  const unknownRuns = checkRuns.filter(
    (r) => r.status === "completed" && r.conclusion !== null && !FAILED_CONCLUSIONS.has(r.conclusion) && !PASSED_CONCLUSIONS.has(r.conclusion),
  );
  const statusFailed = statusCount > 0 && (combined?.state === "failure" || combined?.state === "error");
  const statusPending = statusCount > 0 && combined?.state === "pending";

  if (failedRuns.length > 0 || statusFailed) {
    return { ci: "failed", summary: `${failedRuns.length + (statusFailed ? 1 : 0)} of ${total} checks failed or were cancelled` };
  }
  if (unfinishedRuns.length > 0 || statusPending || unknownRuns.length > 0) {
    return { ci: "pending", summary: `${unfinishedRuns.length + (statusPending ? 1 : 0) + unknownRuns.length} of ${total} checks not finished` };
  }
  return { ci: "passed", summary: `${total} checks passed` };
}

/** Keeps at most `maxBytes` of UTF-8 text, without leaving half a character at the end. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  return { text: bytes.subarray(0, maxBytes).toString("utf8").replace(/�+$/, ""), truncated: true };
}

// ---------------------------------------------------------------------------
// GitHub calls
// ---------------------------------------------------------------------------

function authHeaders(accept: string): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) throw new GitHubError("GITHUB_TOKEN is not set");
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "bountypilot",
  };
}

async function request(path: string, accept = "application/vnd.github+json"): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { headers: authHeaders(accept), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof GitHubError) throw err;
    throw new GitHubError(`GitHub request failed (${err instanceof Error && err.name === "TimeoutError" ? "timed out" : "network error"})`);
  }
  return response;
}

async function getJson<S extends z.ZodType>(path: string, schema: S, okStatuses: number[] = []): Promise<z.output<S> | null> {
  const response = await request(path);
  if (okStatuses.includes(response.status)) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    const hint = response.status === 403 || response.status === 429 ? " (permission or rate limit)" : "";
    throw new GitHubError(`GitHub GET ${path.split("?")[0]} failed with ${response.status}${hint}`, response.status);
  }
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new GitHubError(`GitHub GET ${path.split("?")[0]} returned an unexpected response`);
  return parsed.data;
}

/** Reads at most `maxBytes` (plus one chunk) of a response body, so a huge diff is never held in memory. */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

const prSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  merged: z.boolean(),
  user: z.object({ login: z.string() }),
  merged_by: z.object({ login: z.string() }).nullable(),
  merge_commit_sha: z.string().nullable(),
  base: z.object({ ref: z.string() }),
  head: z.object({ sha: z.string() }),
});
const repoSchema = z.object({ default_branch: z.string().min(1) });
const permissionSchema = z.object({ permission: z.string().optional(), role_name: z.string().optional() });
const checkRunsSchema = z.object({
  total_count: z.number(),
  check_runs: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })),
});
const combinedStatusSchema = z.object({ state: z.string(), total_count: z.number() });
const filesSchema = z.array(
  z.object({ filename: z.string(), status: z.string(), additions: z.number().default(0), deletions: z.number().default(0) }),
);

const MAINTAINER_ROLES = new Set(["admin", "maintain", "write"]);

async function isMaintainer(repo: string, login: string | null): Promise<boolean> {
  if (!login || !LOGIN_PATTERN.test(login)) return false;
  const permission = await getJson(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, permissionSchema, [404]);
  // 404 means "not a collaborator". A 403 is NOT treated as "no": it throws, because it means our
  // token cannot see permissions, and answering "not a maintainer" would reject real payments.
  if (!permission) return false;
  return MAINTAINER_ROLES.has(permission.role_name ?? permission.permission ?? "");
}

async function readCi(repo: string, headSha: string): Promise<{ ci: CiState; summary: string }> {
  const checkRuns: CheckRunLike[] = [];
  for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
    const data = await getJson(`/repos/${repo}/commits/${headSha}/check-runs?per_page=100&page=${page}`, checkRunsSchema);
    checkRuns.push(...(data?.check_runs ?? []));
    if (!data || checkRuns.length >= data.total_count) break;
    if (page === MAX_CHECK_PAGES) {
      // More runs than we read: we cannot say they all passed.
      return { ci: "pending", summary: `more than ${checkRuns.length} check runs, not all read` };
    }
  }
  const combined = await getJson(`/repos/${repo}/commits/${headSha}/status`, combinedStatusSchema);
  return evaluateCi(checkRuns, combined);
}

async function readFiles(repo: string, prNumber: number): Promise<{ files: ChangedFile[]; truncated: boolean }> {
  const files: ChangedFile[] = [];
  for (let page = 1; page <= Math.ceil(MAX_FILES / 100); page++) {
    const data = (await getJson(`/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`, filesSchema)) ?? [];
    files.push(...data);
    if (data.length < 100) return { files, truncated: false };
  }
  return { files: files.slice(0, MAX_FILES), truncated: true };
}

async function readDiff(repo: string, prNumber: number): Promise<{ diff: string; truncated: boolean }> {
  const response = await request(`/repos/${repo}/pulls/${prNumber}`, "application/vnd.github.diff");
  if (!response.ok) {
    await response.body?.cancel();
    throw new GitHubError(`GitHub GET /repos/${repo}/pulls/${prNumber} (diff) failed with ${response.status}`, response.status);
  }
  const { text, truncated } = truncateUtf8(await readLimited(response, MAX_DIFF_BYTES), MAX_DIFF_BYTES);
  return { diff: text, truncated };
}

export async function getPrContext(repo: string, prNumber: number): Promise<PrContext> {
  if (!REPO_PATTERN.test(repo)) throw new GitHubError("Invalid repository name");
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new GitHubError("Invalid pull request number");

  const pr = await getJson(`/repos/${repo}/pulls/${prNumber}`, prSchema);
  if (!pr) throw new GitHubError("Pull request not found");
  if (!SHA_PATTERN.test(pr.head.sha)) throw new GitHubError("GitHub returned an invalid head commit");

  const [repoInfo, mergedByMaintainer, ci, files, diff] = await Promise.all([
    getJson(`/repos/${repo}`, repoSchema),
    isMaintainer(repo, pr.merged_by?.login ?? null),
    readCi(repo, pr.head.sha),
    readFiles(repo, prNumber),
    readDiff(repo, prNumber),
  ]);
  if (!repoInfo) throw new GitHubError("Repository not found");

  return {
    repo,
    prNumber,
    title: pr.title,
    body: pr.body ?? "",
    author: pr.user.login,
    merged: pr.merged,
    mergedBy: pr.merged_by?.login ?? null,
    mergedByMaintainer,
    baseBranch: pr.base.ref,
    defaultBranch: repoInfo.default_branch,
    mergedIntoDefaultBranch: pr.base.ref === repoInfo.default_branch,
    mergeCommitSha: pr.merge_commit_sha,
    headSha: pr.head.sha,
    linkedIssues: parseLinkedIssues(pr.body, repo),
    ci: ci.ci,
    ciSummary: ci.summary,
    files: files.files,
    filesTruncated: files.truncated,
    diff: diff.diff,
    diffTruncated: diff.truncated,
  };
}

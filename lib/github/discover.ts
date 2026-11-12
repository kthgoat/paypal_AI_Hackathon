// Finds merged PRs for open bounties when no webhook can reach this server (e.g. localhost), and
// records the same GitHubMergeEvent row the webhook would have stored. It only RECORDS events:
// the orchestrator still re-reads the PR from GitHub and policy still decides, so finding a PR
// here authorises nothing. A wrong result can at worst add an inbox row that is later skipped,
// held for approval or blocked.
//
// Which PRs: only those for bounties that are `open` (funded), have a claim, and only PRs merged
// AFTER the bounty was created, whose body says "closes #N" for one of those bounties' issues.
// Repos and issue numbers come from OUR database, never from a request.
//
// Cost: one GitHub call per repo (the 30 most recently updated closed PRs).

import { z } from "zod";

import { prisma } from "../db";
import { isUniqueViolation } from "../db-errors";
import { GitHubError, parseLinkedIssues } from "./pr-context";

const API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_PRS_PER_REPO = 30;

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export interface DiscoveryResult {
  /** Merge events newly recorded by this call. */
  discovered: number;
  /** How many repos were checked on GitHub. */
  reposChecked: number;
  /** Set if GitHub could not be checked (all or some repos). Short, with no secrets. */
  error?: string;
}

const pullSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url({ protocol: /^https$/ }),
  body: z.string().nullable(),
  merged_at: z.string().nullable(),
  merge_commit_sha: z.string().regex(/^[a-fA-F0-9]{40,64}$/).nullable(),
  user: z.object({ login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]|\[bot\])*$/).max(100) }),
});

async function listClosedPulls(repo: string): Promise<unknown[]> {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) throw new GitHubError("GITHUB_TOKEN is not set");

  const path = `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${MAX_PRS_PER_REPO}`;
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bountypilot",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GitHubError(`GitHub request failed (${err instanceof Error && err.name === "TimeoutError" ? "timed out" : "network error"})`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    const hint = response.status === 403 || response.status === 429 ? " (permission or rate limit)" : "";
    throw new GitHubError(`GitHub GET /repos/${repo}/pulls failed with ${response.status}${hint}`, response.status);
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new GitHubError(`GitHub GET /repos/${repo}/pulls returned an unexpected response`);
  return body;
}

interface EligibleBounty {
  issueNumber: number;
  createdAt: Date;
}

/** Open, funded bounties that have a claim, grouped by repo (lower-cased). The repo name is kept as stored, for the API call. */
async function eligibleBountiesByRepo(): Promise<Map<string, { repo: string; bounties: EligibleBounty[] }>> {
  const open = (await prisma.bounty.findMany({ where: { status: "open" } })).filter((b) => b.fundingCaptureId);
  const claims = await prisma.claim.findMany({ where: { bountyId: { in: open.map((b) => b.id) } } });
  const claimed = new Set(claims.map((c) => c.bountyId));

  const byRepo = new Map<string, { repo: string; bounties: EligibleBounty[] }>();
  for (const bounty of open) {
    if (!claimed.has(bounty.id) || !REPO_PATTERN.test(bounty.repo)) continue;
    const key = bounty.repo.toLowerCase();
    const entry = byRepo.get(key) ?? { repo: bounty.repo, bounties: [] };
    entry.bounties.push({ issueNumber: bounty.issueNumber, createdAt: bounty.createdAt });
    byRepo.set(key, entry);
  }
  return byRepo;
}

/** Records the event unless this repo + PR + merge commit is already known. Returns true if a new row was written. */
async function recordEvent(repo: string, pr: z.infer<typeof pullSchema> & { merge_commit_sha: string }): Promise<boolean> {
  const mergeSha = pr.merge_commit_sha.toLowerCase();
  const lowerRepo = repo.toLowerCase();

  // The webhook may have stored this merge already, under a different delivery id.
  const known = await prisma.gitHubMergeEvent.findFirst({ where: { repo: lowerRepo, prNumber: pr.number, mergeSha } });
  if (known) return false;

  try {
    await prisma.gitHubMergeEvent.create({
      data: {
        deliveryId: `sync-${lowerRepo.replace("/", "-")}-pr${pr.number}-${mergeSha.slice(0, 12)}`,
        repo: lowerRepo,
        prNumber: pr.number,
        prUrl: pr.html_url,
        prAuthor: pr.user.login,
        mergeSha,
      },
    });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false; // lost a race with the webhook or another sync
    throw err;
  }
}

/** Never throws: a GitHub or database problem comes back as `error`, so existing events can still be processed. */
export async function discoverMergedPrEvents(): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { discovered: 0, reposChecked: 0 };
  const failures: string[] = [];

  let byRepo: Awaited<ReturnType<typeof eligibleBountiesByRepo>>;
  try {
    byRepo = await eligibleBountiesByRepo();
  } catch (err) {
    return { ...result, error: `could not read open bounties (${err instanceof Error ? err.name : "error"})` };
  }

  for (const { repo, bounties } of byRepo.values()) {
    try {
      const pulls = await listClosedPulls(repo);
      result.reposChecked += 1;

      for (const raw of pulls) {
        const parsed = pullSchema.safeParse(raw); // one odd item must not hide the rest
        if (!parsed.success || !parsed.data.merged_at || !parsed.data.merge_commit_sha) continue;
        const pr = { ...parsed.data, merge_commit_sha: parsed.data.merge_commit_sha };
        const mergedAt = Date.parse(pr.merged_at ?? "");
        if (Number.isNaN(mergedAt)) continue;

        // Merged after the bounty was created, and says it closes that bounty's issue.
        const closes = new Set(parseLinkedIssues(pr.body, repo));
        const relevant = bounties.some((b) => closes.has(b.issueNumber) && mergedAt > b.createdAt.getTime());
        if (!relevant) continue;

        if (await recordEvent(repo, pr)) result.discovered += 1;
      }
    } catch (err) {
      failures.push(err instanceof GitHubError ? err.message : `could not record events (${err instanceof Error ? err.name : "error"})`);
    }
  }

  if (failures.length > 0) result.error = failures.join("; ");
  return result;
}

// Connects a merged GitHub PR to a policy decision and, only if policy says auto_pay, a PayPal payout.
//
//   GitHubMergeEvent (stored by the webhook)  ->  getPrContext  ->  review  ->  Verdict
//     ->  recordPolicyDecision  ->  (auto_pay only) sendBountyPayout  ->  refreshPayoutStatus
//
// Event status flow:
//   received --claim--> processing --> done        (verdict + decision recorded, payout sent if auto_pay)
//                                  --> skipped     (not a bounty PR; reason in lastError)
//                                  --> waiting_ci  (checks still running; picked up again later)
//                                  --> failed      (an error; attempts + 1, lastError says why)
//   failed / waiting_ci / a stale processing claim can be claimed again.
//
// Safe to run twice: the claim is one conditional UPDATE, the Verdict id is derived from the
// delivery id, the policy Decision is looked up before it is written, and sendBountyPayout
// replays an existing payout instead of paying again.
//
// Trust: the bounty (criteria, amount) and the claim (receiver) come from our database. GitHub
// supplies who merged, CI and the diff; none of it can change an amount or a receiver.

import { prisma, serialiseStringList, toDecision } from "./db";
import { isUniqueViolation } from "./db-errors";
import { recordPolicyDecision } from "./decisions";
import { getPrContext, type PrContext } from "./github/pr-context";
import { refreshPayoutStatus, sendBountyPayout, type PayoutResult } from "./paypal/payouts";
import { review } from "./reviewer";
import type { Decision } from "./types";

export type EventStatus = "received" | "processing" | "waiting_ci" | "done" | "skipped" | "failed";

export interface ProcessResult {
  deliveryId: string;
  /** The event's status afterwards; "busy" means another worker holds it, "not_found" means no such event. */
  status: EventStatus | "busy" | "not_found";
  /** Why it was skipped, is waiting, or failed. */
  reason?: string;
  verdictId?: string;
  decision?: { id: string; outcome: Decision["outcome"]; ruleFired: string; decidedBy: Decision["decidedBy"] };
  payout?: { payoutId: string; status: string; replayed: boolean };
}

export interface ProcessOptions {
  /** How long to watch a new payout for PayPal's answer. Default 30 s. */
  payoutPollMs?: number;
  payoutPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** A "processing" claim older than this is a crashed run and may be taken over. */
export const STALE_CLAIM_MS = 10 * 60_000;
/** processPendingEvents retries a failed event until it has failed this many times. */
export const MAX_AUTO_RETRIES = 5;
const DEFAULT_PENDING_LIMIT = 20;
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;

const CLAIMABLE: EventStatus[] = ["received", "waiting_ci", "failed"];
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Errors stored on the event must never carry a secret
// ---------------------------------------------------------------------------

const SECRET_ENV_NAMES = ["GITHUB_TOKEN", "LLM_API_KEY", "GITHUB_WEBHOOK_SECRET", "PAYPAL_CLIENT_SECRET", "MAINTAINER_KEY", "DEMO_ADMIN_SECRET"];
const SECRET_SHAPES = [/gh[pousr]_[A-Za-z0-9]{16,}/g, /github_pat_[A-Za-z0-9_]{16,}/g, /AIza[\w-]{20,}/g, /Bearer\s+[\w.~+/=-]{8,}/gi];

export function safeErrorMessage(err: unknown): string {
  let text = err instanceof Error ? `${err.name}: ${err.message}` : "Unknown error";
  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value && value.length >= 6) text = text.split(value).join("[redacted]");
  }
  for (const shape of SECRET_SHAPES) text = text.replace(shape, "[redacted]");
  return text.replace(/\s+/g, " ").slice(0, 300);
}

// ---------------------------------------------------------------------------
// processMergeEvent
// ---------------------------------------------------------------------------

type EventRow = NonNullable<Awaited<ReturnType<typeof prisma.gitHubMergeEvent.findUnique>>>;

/** Moves the event on from "processing". Does nothing if the claim was lost, so a slow run cannot overwrite a newer one. */
async function release(deliveryId: string, data: Record<string, unknown>): Promise<void> {
  await prisma.gitHubMergeEvent.updateMany({ where: { deliveryId, status: "processing" }, data: { claimedAt: null, ...data } });
}

export async function processMergeEvent(deliveryId: string, options: ProcessOptions = {}): Promise<ProcessResult> {
  const now = options.now ?? (() => new Date());

  // 1. Claim it. One conditional UPDATE: if it changes no row, someone else has it (or it is finished).
  const claimed = await prisma.gitHubMergeEvent.updateMany({
    where: {
      deliveryId,
      OR: [{ status: { in: CLAIMABLE } }, { status: "processing", claimedAt: { lt: new Date(now().getTime() - STALE_CLAIM_MS) } }],
    },
    data: { status: "processing", claimedAt: now() },
  });
  if (claimed.count === 0) {
    const row = await prisma.gitHubMergeEvent.findUnique({ where: { deliveryId } });
    if (!row) return { deliveryId, status: "not_found" };
    if (row.status === "processing") return { deliveryId, status: "busy" };
    return { deliveryId, status: row.status as EventStatus, reason: row.lastError ?? undefined, verdictId: row.verdictId ?? undefined };
  }

  const event = await prisma.gitHubMergeEvent.findUniqueOrThrow({ where: { deliveryId } });
  try {
    const result = await run(event, options);
    console.info("[orchestrator] event processed", { deliveryId, status: result.status, outcome: result.decision?.outcome, rule: result.decision?.ruleFired });
    return result;
  } catch (err) {
    const reason = safeErrorMessage(err);
    await release(deliveryId, { status: "failed", attempts: { increment: 1 }, lastError: reason });
    console.error("[orchestrator] event failed", { deliveryId, reason });
    return { deliveryId, status: "failed", reason, verdictId: event.verdictId ?? undefined };
  }
}

async function skip(deliveryId: string, reason: string, now: Date): Promise<ProcessResult> {
  await release(deliveryId, { status: "skipped", lastError: reason, processedAt: now });
  return { deliveryId, status: "skipped", reason };
}

async function run(event: EventRow, options: ProcessOptions): Promise<ProcessResult> {
  const { deliveryId } = event;
  const now = options.now ?? (() => new Date());

  // 2. What does GitHub say about this PR right now?
  const ctx = await getPrContext(event.repo, event.prNumber);
  if (!ctx.merged) return skip(deliveryId, "The PR is not merged", now());
  if (!ctx.mergedIntoDefaultBranch) {
    return skip(deliveryId, `Merged into "${ctx.baseBranch}", not the default branch "${ctx.defaultBranch}"`, now());
  }

  // 3. Which bounty? Only a bounty in OUR database for a closing reference in the PR. The body is
  //    written by the contributor, so naming an issue proves nothing by itself: policy still
  //    requires the PR author to be the bounty's claimant.
  if (ctx.linkedIssues.length === 0) return skip(deliveryId, "The PR does not say it closes an issue", now());
  const candidates = (await prisma.bounty.findMany({ where: { issueNumber: { in: ctx.linkedIssues } } })).filter(
    (b) => b.repo.toLowerCase() === event.repo.toLowerCase(),
  );
  if (candidates.length === 0) return skip(deliveryId, `No bounty for ${event.repo} ${ctx.linkedIssues.map((n) => `#${n}`).join(", ")}`, now());
  if (candidates.length > 1) {
    return skip(deliveryId, `The PR closes ${candidates.length} bounties (${candidates.map((b) => `#${b.issueNumber}`).join(", ")}); only one bounty per PR is handled`, now());
  }
  const bounty = candidates[0];

  // 4. CI still running (or not reported yet): come back later. No verdict yet, so nothing is wasted.
  if (ctx.ci === "pending" && !event.verdictId) {
    const reason = `CI not finished: ${ctx.ciSummary}`;
    await release(deliveryId, { status: "waiting_ci", lastError: reason });
    return { deliveryId, status: "waiting_ci", reason };
  }

  // 5. The Verdict. Reuse it if an earlier run already made it.
  const verdictId = event.verdictId ?? (await makeVerdict(event, ctx, bounty));

  // 6. The policy Decision. Reuse it if an earlier run already made it.
  const existing = await prisma.decision.findFirst({
    where: { verdictId, decidedBy: "policy" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const decision = existing ? toDecision(existing) : await recordPolicyDecision(verdictId);
  const summary = { id: decision.id, outcome: decision.outcome, ruleFired: decision.ruleFired, decidedBy: decision.decidedBy };

  // 7. Only an auto_pay decision pays. Anything else waits for a maintainer or ends here.
  let payout: PayoutResult | undefined;
  if (decision.outcome === "auto_pay") {
    payout = await sendBountyPayout({ decisionId: decision.id });
    payout = await watchPayout(payout, options);
  }

  await release(deliveryId, { status: "done", verdictId, processedAt: now(), lastError: null });
  return {
    deliveryId,
    status: "done",
    verdictId,
    decision: summary,
    payout: payout && { payoutId: payout.payoutId, status: payout.status, replayed: payout.replayed },
  };
}

async function makeVerdict(event: EventRow, ctx: PrContext, bounty: { id: string; criteria: string }): Promise<string> {
  const verdictId = `verdict-${event.deliveryId}`;

  // A crashed earlier run may have written it without linking it: do not review (or write) twice.
  if (!(await prisma.verdict.findUnique({ where: { id: verdictId } }))) {
    const result = await review({
      criteria: bounty.criteria, // from our database, never from the PR
      ci: ctx.ci,
      pr: { title: ctx.title, body: ctx.body, files: ctx.files, diff: ctx.diff, diffTruncated: ctx.diffTruncated },
    });
    try {
      await prisma.verdict.create({
        data: {
          id: verdictId,
          bountyId: bounty.id,
          prNumber: event.prNumber,
          prUrl: event.prUrl,
          prAuthor: ctx.author,
          ciPassed: ctx.ci === "passed",
          mergedByMaintainer: ctx.mergedByMaintainer,
          meetsCriteria: result.meetsCriteria,
          confidence: result.confidence,
          unmetCriteria: serialiseStringList(result.unmetCriteria),
          summary: result.summary,
          injectionFlags: serialiseStringList(result.injectionFlags),
          model: result.model,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // lost a race to ourselves: the verdict exists, which is all we need
    }
  }

  await prisma.gitHubMergeEvent.updateMany({ where: { deliveryId: event.deliveryId, status: "processing" }, data: { verdictId } });
  return verdictId;
}

/** Watches a PENDING payout for up to ~30 s. A failed refresh stops the watching; it never fails the event. */
async function watchPayout(first: PayoutResult, options: ProcessOptions): Promise<PayoutResult> {
  const sleep = options.sleep ?? defaultSleep;
  const interval = options.payoutPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let waited = 0;
  let payout = first;
  while (payout.status === "PENDING" && waited < (options.payoutPollMs ?? DEFAULT_POLL_MS)) {
    await sleep(interval);
    waited += interval;
    try {
      payout = await refreshPayoutStatus(payout.payoutId);
    } catch (err) {
      console.error("[orchestrator] could not refresh payout status", { payoutId: payout.payoutId, reason: safeErrorMessage(err) });
      break;
    }
  }
  return payout;
}

// ---------------------------------------------------------------------------
// processPendingEvents
// ---------------------------------------------------------------------------

/** Handles received and waiting_ci events (and retries failed ones, up to MAX_AUTO_RETRIES), oldest first. */
export async function processPendingEvents(options: ProcessOptions & { limit?: number } = {}): Promise<ProcessResult[]> {
  const now = (options.now ?? (() => new Date()))();
  const rows = await prisma.gitHubMergeEvent.findMany({
    where: {
      OR: [
        { status: { in: ["received", "waiting_ci"] } },
        { status: "failed", attempts: { lt: MAX_AUTO_RETRIES } },
        { status: "processing", claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
      ],
    },
    orderBy: { receivedAt: "asc" },
    take: options.limit ?? DEFAULT_PENDING_LIMIT,
  });

  const results: ProcessResult[] = [];
  for (const row of rows) results.push(await processMergeEvent(row.deliveryId, options));
  return results;
}

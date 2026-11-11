// Bounty payouts through PayPal Payouts. Sandbox only. Server-side only.
//
// SAFETY MODEL: money only leaves through sendBountyPayout(), and only when
// assertPayoutAllowed() says yes. That means an allowing Decision row exists for this
// exact bounty, the latest decision for the bounty is that one, the claim belongs to the
// PR author, nothing is paused, and the bounty has not been paid. The amount always comes
// from the bounty row and the receiver always from its Claim. No caller-supplied value
// (request body, PR text, model output) can change who is paid or how much.

import { z } from "zod";

import {
  prisma,
  toBounty,
  toClaim,
  toDecision,
  toPayout,
  toSettings,
  toVerdict,
} from "../db";
import { isUniqueViolation } from "../db-errors";
import type { Payout as PayoutDbRow } from "../generated/prisma/client";
import { FAILED_PAYOUT_STATUSES } from "../payout-status";
import type { Bounty, BountyStatus, Claim, Decision, Payout, Settings, Verdict } from "../types";
import { assertPayPalConfig, paypalFetch, PayPalError } from "./client";
import { formatUsdCents } from "./orders";

// ---------------------------------------------------------------------------
// Refusals (pure guard)
// ---------------------------------------------------------------------------

export type PayoutRefusalReason =
  | "SETTINGS_MISSING"
  | "PAUSED"
  | "NO_DECISION"
  | "DECISION_WRONG_BOUNTY"
  | "DECISION_NOT_AUTO_PAY"
  | "DECISION_SUPERSEDED"
  | "VERDICT_MISMATCH"
  | "NO_CLAIM"
  | "CLAIM_AUTHOR_MISMATCH"
  | "CLAIM_EMAIL_INVALID"
  | "PAYOUT_ALREADY_EXISTS"
  | "BOUNTY_NOT_FUNDED"
  | "BOUNTY_STATUS_NOT_PAYABLE"
  | "BAD_AMOUNT";

export const PAYOUT_REFUSAL_MESSAGES: Record<PayoutRefusalReason, string> = {
  SETTINGS_MISSING: "Payout settings are missing, so payouts are refused.",
  PAUSED: "Payouts are paused.",
  NO_DECISION: "No such decision. A payout needs an existing policy decision that allows it.",
  DECISION_WRONG_BOUNTY: "The decision belongs to a different bounty.",
  DECISION_NOT_AUTO_PAY: "The decision does not allow a payout (its outcome is not 'auto_pay').",
  DECISION_SUPERSEDED: "A newer decision exists for this bounty, so this one no longer counts.",
  VERDICT_MISMATCH: "The decision's verdict is missing or belongs to a different bounty.",
  NO_CLAIM: "The bounty has no claim, so there is nobody to pay.",
  CLAIM_AUTHOR_MISMATCH: "The claimant is not the author of the verified pull request.",
  CLAIM_EMAIL_INVALID: "The claim's PayPal email address is not valid.",
  PAYOUT_ALREADY_EXISTS: "A payout already exists for this bounty.",
  BOUNTY_NOT_FUNDED: "The bounty has not been funded.",
  BOUNTY_STATUS_NOT_PAYABLE: "The bounty is not in a state that can be paid.",
  BAD_AMOUNT: "The bounty amount is not a positive amount.",
};

/** Bounty states a payout can start from. Everything else is closed or not yet funded. */
const PAYABLE_BOUNTY_STATUSES: readonly BountyStatus[] = [
  "open",
  "claimed",
  "in_review",
  "awaiting_approval",
];

const emailSchema = z.email();

export interface PayoutContext {
  bounty: Bounty;
  claim: Claim | null;
  verdict: Verdict | null;
  decision: Decision | null;
  /** The id of the newest decision for this bounty. Only the newest one counts. */
  latestDecisionId: string | null;
  settings: Settings | null;
  existingPayouts: Payout[];
}

export type PayoutCheck = { ok: true } | { ok: false; reason: PayoutRefusalReason };

/**
 * Pure guard: no network, no database. Returns ok, or the FIRST reason a payout is refused.
 * 'auto_pay' is the only allowing outcome. A 'needs_approval' decision is allowed to pay only
 * after a maintainer records a newer decision with decidedBy 'maintainer' and outcome 'auto_pay'.
 */
export function assertPayoutAllowed(ctx: PayoutContext): PayoutCheck {
  const { bounty, claim, verdict, decision, settings } = ctx;
  const refuse = (reason: PayoutRefusalReason): PayoutCheck => ({ ok: false, reason });

  if (!settings) return refuse("SETTINGS_MISSING");
  if (settings.paused) return refuse("PAUSED");

  if (!decision) return refuse("NO_DECISION");
  if (decision.bountyId !== bounty.id) return refuse("DECISION_WRONG_BOUNTY");
  if (decision.outcome !== "auto_pay") return refuse("DECISION_NOT_AUTO_PAY");
  if (ctx.latestDecisionId !== decision.id) return refuse("DECISION_SUPERSEDED");

  if (!verdict || verdict.bountyId !== bounty.id || verdict.id !== decision.verdictId) {
    return refuse("VERDICT_MISMATCH");
  }

  if (!claim || claim.bountyId !== bounty.id) return refuse("NO_CLAIM");
  // GitHub usernames are case-insensitive.
  if (claim.githubUser.trim().toLowerCase() !== verdict.prAuthor.trim().toLowerCase()) {
    return refuse("CLAIM_AUTHOR_MISMATCH");
  }
  if (!emailSchema.safeParse(claim.paypalEmail.trim()).success) return refuse("CLAIM_EMAIL_INVALID");

  if (ctx.existingPayouts.some((p) => !FAILED_PAYOUT_STATUSES.has(p.status))) {
    return refuse("PAYOUT_ALREADY_EXISTS");
  }

  if (!bounty.fundingCaptureId) return refuse("BOUNTY_NOT_FUNDED");
  if (!PAYABLE_BOUNTY_STATUSES.includes(bounty.status)) return refuse("BOUNTY_STATUS_NOT_PAYABLE");
  if (!(bounty.amountUsd > 0)) return refuse("BAD_AMOUNT");

  return { ok: true };
}

/** Thrown by sendBountyPayout when the guard says no. Carries a machine-readable reason. */
export class PayoutRefusedError extends Error {
  readonly reason: PayoutRefusalReason;
  constructor(reason: PayoutRefusalReason) {
    super(PAYOUT_REFUSAL_MESSAGES[reason]);
    this.name = "PayoutRefusedError";
    this.reason = reason;
  }
}

/** The payout may or may not have happened, so a human must look. Never retried blindly. */
export class PayoutError extends Error {
  readonly code: "PAYOUT_OUTCOME_UNKNOWN" | "PAYOUT_NEEDS_RECONCILIATION";
  constructor(code: PayoutError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PayoutError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * `bounty-<bountyId>-pr-<prNumber>`: derived from the bounty and PR, so retries can never
 * pay twice (PayPal rejects a reused sender_batch_id for 30 days, and our own Payout row has a
 * unique senderBatchId). After a payout FAILED, a new attempt gets `-retry<N>`.
 */
export function buildSenderBatchId(bountyId: string, prNumber: number, failedAttempts = 0): string {
  const base = `bounty-${bountyId}-pr-${prNumber}`;
  return failedAttempts > 0 ? `${base}-retry${failedAttempts}` : base;
}

/** Keeps up to 5 characters (never more than half): sb-abcdefghij@personal.example.com -> sb-ab***@personal.example.com */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const keep = Math.min(5, Math.floor(local.length / 2));
  return `${local.slice(0, keep)}***@${domain}`;
}

const truncate = (text: string, max: number) => Array.from(text).slice(0, max).join("").trimEnd();

const BATCH_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;

/** A PENDING row with no PayPal batch id older than this is treated as a crashed attempt. */
const STALE_PENDING_MS = 60_000;

export interface PayoutResult {
  payoutId: string;
  payoutBatchId: string | null;
  status: string;
  /** True when this call found an existing payout and did NOT send money. */
  replayed: boolean;
}

type PayoutRow = PayoutDbRow;

const toResult = (row: PayoutRow, replayed: boolean): PayoutResult => ({
  payoutId: row.id,
  payoutBatchId: row.payoutBatchId,
  status: row.status,
  replayed,
});

// ---------------------------------------------------------------------------
// PayPal response shapes
// ---------------------------------------------------------------------------

const amountSchema = z.object({ currency: z.string().optional(), value: z.string().optional() });

const createResponseSchema = z.looseObject({
  batch_header: z.looseObject({ payout_batch_id: z.string(), batch_status: z.string().optional() }),
});

const batchSchema = z.looseObject({
  batch_header: z.looseObject({
    payout_batch_id: z.string(),
    batch_status: z.string(),
    sender_batch_header: z.looseObject({ sender_batch_id: z.string().optional() }).optional(),
  }),
  items: z
    .array(
      z.looseObject({
        transaction_status: z.string().optional(),
        payout_item: z
          .looseObject({
            sender_item_id: z.string().optional(),
            receiver: z.string().optional(),
            amount: amountSchema.optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

type PayPalBatch = z.infer<typeof batchSchema>;

async function fetchBatch(batchId: string): Promise<PayPalBatch> {
  if (!BATCH_ID_PATTERN.test(batchId)) throw new Error("Invalid PayPal payout batch id");
  const parsed = batchSchema.safeParse(await paypalFetch(`/v1/payments/payouts/${batchId}`));
  if (!parsed.success) throw new Error("Unexpected payout batch response from PayPal");
  return parsed.data;
}

// ---------------------------------------------------------------------------
// sendBountyPayout
// ---------------------------------------------------------------------------

interface PayoutJob {
  row: PayoutRow;
  senderBatchId: string;
  amountCents: number;
  receiver: string;
  note: string;
}

export async function sendBountyPayout(input: { decisionId: string }): Promise<PayoutResult> {
  // 1. Load everything from OUR database. Nothing about the payout comes from the caller.
  const decisionRow = await prisma.decision.findUnique({ where: { id: input.decisionId } });
  if (!decisionRow) throw new PayoutRefusedError("NO_DECISION");

  const [bountyRow, claimRow, verdictRow, settingsRow, payoutRows, latestDecisionRow] =
    await Promise.all([
      prisma.bounty.findUnique({ where: { id: decisionRow.bountyId } }),
      prisma.claim.findUnique({ where: { bountyId: decisionRow.bountyId } }),
      prisma.verdict.findUnique({ where: { id: decisionRow.verdictId } }),
      prisma.settings.findUnique({ where: { id: "default" } }),
      prisma.payout.findMany({ where: { bountyId: decisionRow.bountyId } }),
      prisma.decision.findFirst({
        where: { bountyId: decisionRow.bountyId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    ]);
  if (!bountyRow) throw new Error("Decision references a bounty that does not exist");

  const bounty = toBounty(bountyRow);
  const claim = claimRow ? toClaim(claimRow) : null;
  const verdict = verdictRow ? toVerdict(verdictRow) : null;

  // 2. The guard.
  const check = assertPayoutAllowed({
    bounty,
    claim,
    verdict,
    decision: toDecision(decisionRow),
    latestDecisionId: latestDecisionRow?.id ?? null,
    settings: settingsRow ? toSettings(settingsRow) : null,
    existingPayouts: payoutRows.map(toPayout),
  });

  // verdict and claim are non-null whenever the guard passes or reports an existing payout,
  // because those checks come first.
  const failedAttempts = payoutRows.filter((p) => FAILED_PAYOUT_STATUSES.has(p.status)).length;
  const senderBatchId = verdict ? buildSenderBatchId(bounty.id, verdict.prNumber, failedAttempts) : "";

  if (!check.ok) {
    if (check.reason === "PAYOUT_ALREADY_EXISTS") {
      // Idempotent retry: the same decision/PR already has a payout. Return it, pay nothing.
      const existing = payoutRows.find((p) => p.senderBatchId === senderBatchId);
      if (existing) return resumeOrReplay(existing, bountyRow, claim);
    }
    throw new PayoutRefusedError(check.reason);
  }
  if (!claim || !verdict) throw new Error("unreachable: guard passed without claim or verdict");

  // 3. Fail before writing anything if PayPal is not configured for the sandbox.
  assertPayPalConfig();

  // 4. Record the payout BEFORE calling PayPal. The unique senderBatchId means a second
  //    concurrent call fails here, at the database, and gets the existing payout back.
  let row: PayoutRow;
  try {
    row = await prisma.payout.create({
      data: {
        bountyId: bounty.id,
        senderBatchId,
        amountCents: bountyRow.amountCents,
        status: "PENDING",
        receiverMasked: maskEmail(claim.paypalEmail.trim()),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await prisma.payout.findUnique({ where: { senderBatchId } });
      if (existing) return toResult(existing, true);
    }
    throw err;
  }

  return submitToPayPal({
    row,
    senderBatchId,
    amountCents: bountyRow.amountCents,
    receiver: claim.paypalEmail.trim(),
    note: truncate(`Bounty payout: ${bounty.repo}#${bounty.issueNumber} ${bounty.title}`, 200),
  });
}

/**
 * An existing payout for this decision. Normally just return it. If it never got a PayPal
 * batch id and is stale (we crashed between writing the row and hearing back), send the SAME
 * request again: PayPal's PayPal-Request-Id / sender_batch_id make that safe.
 */
async function resumeOrReplay(
  row: PayoutRow,
  bountyRow: { amountCents: number; repo: string; issueNumber: number; title: string },
  claim: Claim | null,
): Promise<PayoutResult> {
  const stale = Date.now() - row.createdAt.getTime() > STALE_PENDING_MS;
  if (row.payoutBatchId || row.status !== "PENDING" || !stale || !claim) {
    return toResult(row, true);
  }
  assertPayPalConfig();
  return submitToPayPal({
    row,
    senderBatchId: row.senderBatchId,
    amountCents: bountyRow.amountCents,
    receiver: claim.paypalEmail.trim(),
    note: truncate(`Bounty payout: ${bountyRow.repo}#${bountyRow.issueNumber} ${bountyRow.title}`, 200),
  });
}

async function submitToPayPal(job: PayoutJob): Promise<PayoutResult> {
  const { row, senderBatchId } = job;
  try {
    const created = createResponseSchema.parse(
      await paypalFetch("/v1/payments/payouts", {
        method: "POST",
        requestId: senderBatchId, // same id as the batch: a repeated request is not paid twice
        body: {
          sender_batch_header: {
            sender_batch_id: senderBatchId,
            email_subject: "You have received a BountyPilot bounty payout",
            recipient_type: "EMAIL",
          },
          items: [
            {
              amount: { value: formatUsdCents(job.amountCents), currency: "USD" },
              receiver: job.receiver,
              note: job.note,
              sender_item_id: `${senderBatchId}-item-1`,
            },
          ],
        },
      }),
    );
    const payoutBatchId = created.batch_header.payout_batch_id;
    try {
      return await recordBatchId(row, payoutBatchId);
    } catch (err) {
      // PayPal accepted the payout but we could not store its id. Make sure it is never lost.
      console.error("[SERIOUS] PayPal accepted a payout but its batch id could not be stored", {
        payoutId: row.id,
        senderBatchId,
        payoutBatchId,
      });
      throw err;
    }
  } catch (err) {
    return handleCreateFailure(err, job);
  }
}

async function recordBatchId(row: PayoutRow, payoutBatchId: string): Promise<PayoutResult> {
  if (!BATCH_ID_PATTERN.test(payoutBatchId)) {
    throw new PayoutError("PAYOUT_NEEDS_RECONCILIATION", "PayPal returned an unexpected batch id");
  }
  const updated = await prisma.payout.update({ where: { id: row.id }, data: { payoutBatchId } });
  return toResult(updated, false);
}

/** The id of the original batch, taken from the links in a duplicate-batch error. */
function batchIdFromLinks(err: PayPalError): string | null {
  for (const link of err.links) {
    const match = /\/v1\/payments\/payouts\/([A-Za-z0-9]{1,64})(?:[/?#]|$)/.exec(link.href);
    if (match) return match[1];
  }
  return null;
}

/** Heuristic: PayPal's exact error name for a reused batch id is not documented. Err on the safe side. */
function looksLikeDuplicateBatch(err: PayPalError): boolean {
  const text = [
    err.paypalName,
    err.message,
    ...err.details.map((d) => `${d.issue ?? ""} ${d.description ?? ""} ${d.field ?? ""}`),
  ].join(" ");
  return /sender_batch_id|duplicate|already\s+(exists|used|processed)/i.test(text);
}

async function handleCreateFailure(err: unknown, job: PayoutJob): Promise<PayoutResult> {
  const { row } = job;

  if (err instanceof PayPalError && err.status >= 400 && err.status < 500) {
    const originalBatchId = batchIdFromLinks(err);

    // PayPal says this batch id was already used: adopt the existing batch if it is really ours.
    if (originalBatchId) {
      const batch = await fetchBatch(originalBatchId);
      if (batchMatchesJob(batch, job)) return recordBatchId(row, originalBatchId);
      console.error("[SERIOUS] PayPal reports a batch for this sender_batch_id that does not match", {
        payoutId: row.id,
        senderBatchId: job.senderBatchId,
        existingBatchId: originalBatchId,
      });
      throw new PayoutError(
        "PAYOUT_NEEDS_RECONCILIATION",
        "PayPal already has a different batch for this payout id. A person must check it.",
        { cause: err },
      );
    }

    // Looks like a duplicate but gave us no link: we cannot prove the money did not move.
    // Leave the row PENDING (it blocks further payouts) and ask a person to look.
    if (looksLikeDuplicateBatch(err)) {
      console.error("[SERIOUS] Payout batch id reported as already used, but no original batch link", {
        payoutId: row.id,
        senderBatchId: job.senderBatchId,
        paypalName: err.paypalName,
        debugId: err.debugId,
      });
      throw new PayoutError(
        "PAYOUT_NEEDS_RECONCILIATION",
        "PayPal says this payout id was already used. A person must find the original batch.",
        { cause: err },
      );
    }

    // A clear rejection (validation, insufficient funds, auth...): nothing was sent.
    await prisma.payout.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { status: "FAILED" },
    });
    throw err;
  }

  if (err instanceof PayoutError) throw err;

  // 5xx, timeout, network error, or an unreadable response: the payout MAY have been created.
  // Do not mark it failed. A later call re-sends the same request id and settles it.
  console.error("[payout] outcome unknown; row left PENDING", {
    payoutId: row.id,
    senderBatchId: job.senderBatchId,
    error: err instanceof Error ? err.name : "unknown",
  });
  throw new PayoutError(
    "PAYOUT_OUTCOME_UNKNOWN",
    "The payout request may or may not have reached PayPal. Retrying the same decision is safe.",
    { cause: err },
  );
}

/** Only adopt an existing batch if it is demonstrably this payout. */
function batchMatchesJob(batch: PayPalBatch, job: PayoutJob): boolean {
  if (batch.batch_header.sender_batch_header?.sender_batch_id !== job.senderBatchId) return false;
  const item = batch.items?.[0];
  if (!item?.payout_item) return true; // items not listed yet: the batch id match is all we have
  const { amount, receiver } = item.payout_item;
  if (amount?.value !== undefined && amount.value !== formatUsdCents(job.amountCents)) return false;
  if (amount?.currency !== undefined && amount.currency !== "USD") return false;
  if (receiver !== undefined && receiver.toLowerCase() !== job.receiver.toLowerCase()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// refreshPayoutStatus
// ---------------------------------------------------------------------------

/** Our Payout.status from PayPal's batch: the item's transaction_status wins. */
export function mapBatchToPayoutStatus(batchStatus: string, itemStatus: string | null): string {
  if (itemStatus) return itemStatus.toUpperCase();
  const batch = batchStatus.toUpperCase();
  if (batch === "DENIED" || batch === "CANCELED") return "FAILED";
  return "PENDING";
}

/** What the bounty should become for a payout status, or null to leave it alone. */
export function bountyStatusForPayout(payoutStatus: string): BountyStatus | null {
  if (payoutStatus === "SUCCESS") return "paid";
  if (FAILED_PAYOUT_STATUSES.has(payoutStatus)) return "failed";
  return null; // PENDING, UNCLAIMED, ONHOLD...: not paid yet, not failed either
}

/**
 * Reads the batch from PayPal and copies the item's status onto our Payout row. On SUCCESS the
 * bounty becomes 'paid'; on FAILED / RETURNED / BLOCKED it becomes 'failed' so a person looks.
 */
export async function refreshPayoutStatus(payoutId: string): Promise<PayoutResult> {
  const row = await prisma.payout.findUnique({ where: { id: payoutId } });
  if (!row) throw new Error("Payout not found");
  if (!row.payoutBatchId) return toResult(row, false); // nothing at PayPal to read yet

  const batch = await fetchBatch(row.payoutBatchId);
  const item =
    batch.items?.find((i) => i.payout_item?.sender_item_id === `${row.senderBatchId}-item-1`) ??
    batch.items?.[0];
  const status = mapBatchToPayoutStatus(batch.batch_header.batch_status, item?.transaction_status ?? null);

  let current = row;
  if (status !== row.status) {
    // Compare-and-swap on the status we read, so two refreshes cannot overwrite each other.
    const swapped = await prisma.payout.updateMany({
      where: { id: row.id, status: row.status },
      data: { status },
    });
    if (swapped.count === 1) {
      current = { ...row, status };
      if (row.status === "SUCCESS" && status !== "SUCCESS") {
        console.error("[SERIOUS] A payout that had succeeded is now", status, { payoutId: row.id });
      }
    } else {
      current = (await prisma.payout.findUnique({ where: { id: row.id } })) ?? row;
    }
  }

  const target = bountyStatusForPayout(current.status);
  if (target) {
    // Only move the bounty forward from a state that can still be paid, never over a later one.
    await prisma.bounty.updateMany({
      where: { id: row.bountyId, status: { in: [...PAYABLE_BOUNTY_STATUSES] } },
      data: { status: target },
    });
  }

  return toResult(current, false);
}

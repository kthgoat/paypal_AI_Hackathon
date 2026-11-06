import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { z } from "zod";

import {
  PrismaClient,
  type Bounty as BountyRow,
  type Claim as ClaimRow,
  type Decision as DecisionRow,
  type Payout as PayoutRow,
  type Settings as SettingsRow,
  type Verdict as VerdictRow,
} from "./generated/prisma/client";
import type {
  Bounty,
  BountyStatus,
  Claim,
  Decision,
  DecisionOutcome,
  Payout,
  Settings,
  Verdict,
} from "./types";

// ---------------------------------------------------------------------------
// Prisma client singleton
// ---------------------------------------------------------------------------
// Prisma 7 needs a driver adapter. When we move to Postgres (hosting), only
// createClient() changes: swap in @prisma/adapter-pg and set the provider in
// prisma/schema.prisma.

function createClient(): PrismaClient {
  const adapter = new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL ?? "file:./dev.db",
  });
  return new PrismaClient({ adapter });
}

// Next.js dev hot reload re-evaluates modules; cache the client on globalThis
// so we don't open a new connection on every reload.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// ---------------------------------------------------------------------------
// Money: the database stores integer cents, lib/types.ts uses dollars
// ---------------------------------------------------------------------------
// Integer cents avoid float rounding and behave the same on SQLite and Postgres
// (SQLite has no true DECIMAL type).

export function usdToCents(usd: number): number {
  return Math.round(usd * 100);
}

export function centsToUsd(cents: number): number {
  return cents / 100;
}

// ---------------------------------------------------------------------------
// JSON-encoded string lists (unmetCriteria, injectionFlags)
// ---------------------------------------------------------------------------
// Stored as strings so the schema is identical on SQLite and Postgres.

const stringListSchema = z.array(z.string());

export function serialiseStringList(list: string[]): string {
  return JSON.stringify(list);
}

/** Throws if the stored value is not a JSON array of strings (a bug, not user input). */
export function parseStringList(raw: string): string[] {
  return stringListSchema.parse(JSON.parse(raw));
}

// ---------------------------------------------------------------------------
// Row -> lib/types.ts mappers
// ---------------------------------------------------------------------------

const BOUNTY_STATUSES: readonly BountyStatus[] = [
  "awaiting_funding",
  "open", // funded
  "claimed",
  "in_review",
  "awaiting_approval",
  "paid",
  "rejected",
  "refunded",
  "failed",
];
const DECISION_OUTCOMES: readonly DecisionOutcome[] = [
  "auto_pay",
  "needs_approval",
  "blocked",
];
const DECIDERS: readonly Decision["decidedBy"][] = ["policy", "maintainer"];

function oneOf<T extends string>(allowed: readonly T[], value: string, field: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid ${field} in database: "${value}"`);
}

export function toBounty(row: BountyRow): Bounty {
  return {
    id: row.id,
    repo: row.repo,
    issueNumber: row.issueNumber,
    title: row.title,
    amountUsd: centsToUsd(row.amountCents),
    criteria: row.criteria,
    status: oneOf(BOUNTY_STATUSES, row.status, "bounty status"),
    fundingOrderId: row.fundingOrderId,
    fundingCaptureId: row.fundingCaptureId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toClaim(row: ClaimRow): Claim {
  return {
    id: row.id,
    bountyId: row.bountyId,
    githubUser: row.githubUser,
    paypalEmail: row.paypalEmail,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toVerdict(row: VerdictRow): Verdict {
  return {
    id: row.id,
    bountyId: row.bountyId,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    prAuthor: row.prAuthor,
    ciPassed: row.ciPassed,
    mergedByMaintainer: row.mergedByMaintainer,
    meetsCriteria: row.meetsCriteria,
    confidence: row.confidence,
    unmetCriteria: parseStringList(row.unmetCriteria),
    summary: row.summary,
    injectionFlags: parseStringList(row.injectionFlags),
    model: row.model,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    bountyId: row.bountyId,
    verdictId: row.verdictId,
    outcome: oneOf(DECISION_OUTCOMES, row.outcome, "decision outcome"),
    ruleFired: row.ruleFired,
    decidedBy: oneOf(DECIDERS, row.decidedBy, "decidedBy"),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toPayout(row: PayoutRow): Payout {
  return {
    id: row.id,
    bountyId: row.bountyId,
    senderBatchId: row.senderBatchId,
    payoutBatchId: row.payoutBatchId,
    amountUsd: centsToUsd(row.amountCents),
    status: row.status,
    receiverMasked: row.receiverMasked,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toSettings(row: SettingsRow): Settings {
  return {
    autoPayCapUsd: centsToUsd(row.autoPayCapCents),
    contributorDailyCapUsd: centsToUsd(row.contributorDailyCapCents),
    monthlyBudgetUsd: centsToUsd(row.monthlyBudgetCents),
    paused: row.paused,
  };
}

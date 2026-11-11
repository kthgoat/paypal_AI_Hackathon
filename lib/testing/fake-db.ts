// An in-memory stand-in for the Prisma client, for unit tests only (never imported by app code).
//
// Supports just what our decision / approval / settings code calls. Like the real client, model
// calls are lazy: nothing runs until awaited or passed to $transaction, and $transaction rolls
// every change back if any operation fails (e.g. a unique-constraint violation).

import { Prisma } from "../generated/prisma/client";

export type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
interface Args {
  where?: Where;
  data?: Row;
  orderBy?: Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[];
  take?: number;
  include?: { bounty?: { include?: { claim?: boolean } } };
}

export const tables: Record<string, Row[]> = {};
export const events: string[] = [];
let counter = 0;
let clock = Date.now();

export function resetFakeDb(): void {
  events.length = 0;
  counter = 0;
  clock = Date.now();
  for (const key of Object.keys(tables)) delete tables[key];
}

interface Op<T> extends PromiseLike<T> {
  run(): Promise<T>;
}

function lazy<T>(fn: () => Promise<T>): Op<T> {
  return {
    run: fn,
    then: (onFulfilled, onRejected) => fn().then(onFulfilled, onRejected),
  };
}

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((w) => matches(row, w));
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as { in?: unknown[]; notIn?: unknown[]; gte?: Date; lt?: Date | number };
      if (c.in) return c.in.includes(row[key]);
      if (c.notIn) return !c.notIn.includes(row[key]);
      if (c.gte) return row[key] instanceof Date && row[key].getTime() >= c.gte.getTime();
      if (c.lt !== undefined) {
        // A null date is never "older than" anything.
        if (c.lt instanceof Date) return row[key] instanceof Date && row[key].getTime() < c.lt.getTime();
        return typeof row[key] === "number" && row[key] < c.lt;
      }
    }
    return row[key] === condition;
  });
}

/** Applies Prisma-style data: plain values replace, { increment: n } adds. */
function applyData(row: Row, data: Row = {}): Row {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && !(value instanceof Date) && "increment" in value) {
      row[key] = ((row[key] as number) ?? 0) + (value as { increment: number }).increment;
    } else {
      row[key] = value;
    }
  }
  return row;
}

function sortRows(rows: Row[], orderBy: Args["orderBy"]): Row[] {
  const keys = ([] as Record<string, "asc" | "desc">[]).concat(orderBy ?? []);
  if (keys.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const order of keys) {
      const [field, dir] = Object.entries(order)[0];
      const x = a[field] instanceof Date ? (a[field] as Date).getTime() : (a[field] as number | string);
      const y = b[field] instanceof Date ? (b[field] as Date).getTime() : (b[field] as number | string);
      if (x === y) continue;
      return (x < y ? -1 : 1) * (dir === "asc" ? 1 : -1);
    }
    return 0;
  });
}

const rowsOf = (table: string) => (tables[table] ??= []);
const find = (table: string, where?: Where) => rowsOf(table).find((r) => matches(r, where)) ?? null;
const newestFirst = (a: Row, b: Row) =>
  (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime() || String(b.id).localeCompare(String(a.id));

/** Prisma's unique-constraint error, which is what our code catches. */
const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "fake" });

const UNIQUE_FIELDS: Record<string, string[]> = {
  decision: ["id"], bounty: ["id"], claim: ["id", "bountyId"], verdict: ["id"], payout: ["id", "senderBatchId"], settings: ["id"], gitHubMergeEvent: ["deliveryId"],
};

function model(table: string) {
  return {
    findUnique: ({ where }: Args) => lazy(async () => find(table, where)),
    findUniqueOrThrow: ({ where }: Args) =>
      lazy(async () => {
        const row = find(table, where);
        if (!row) throw Object.assign(new Error("No record found"), { code: "P2025" });
        return row;
      }),
    findFirst: ({ where }: Args) =>
      lazy(async () => rowsOf(table).filter((r) => matches(r, where)).sort(newestFirst)[0] ?? null),
    findMany: ({ where, include, orderBy, take }: Args = {}) =>
      lazy(async () =>
        sortRows(rowsOf(table).filter((r) => matches(r, where)), orderBy)
          .slice(0, take)
          .map((r) => {
            if (!include?.bounty) return r;
            const bounty = find("bounty", { id: r.bountyId });
            const claim = include.bounty.include?.claim ? find("claim", { bountyId: r.bountyId }) : undefined;
            return { ...r, bounty: { ...bounty, ...(include.bounty.include?.claim ? { claim } : {}) } };
          }),
      ),
    create: ({ data }: Args) =>
      lazy(async () => {
        events.push(`db:${table}.create`);
        const row: Row = { id: `${table}-${++counter}`, createdAt: new Date(++clock), ...data };
        if (table === "payout") Object.assign(row, { payoutBatchId: null, updatedAt: new Date(), ...data });
        if (table === "gitHubMergeEvent") {
          delete row.id;
          Object.assign(row, {
            receivedAt: new Date(++clock), status: "received", attempts: 0, lastError: null, claimedAt: null,
            processedAt: null, verdictId: null, ...data,
          });
        }
        for (const field of UNIQUE_FIELDS[table] ?? []) {
          if (rowsOf(table).some((r) => r[field] === row[field])) throw uniqueViolation();
        }
        rowsOf(table).push(row);
        return row;
      }),
    update: ({ where, data }: Args) =>
      lazy(async () => {
        const row = find(table, where);
        if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
        return applyData(row, data);
      }),
    updateMany: ({ where, data }: Args) =>
      lazy(async () => {
        const rows = rowsOf(table).filter((r) => matches(r, where));
        rows.forEach((r) => applyData(r, data));
        events.push(`db:${table}.updateMany(${rows.length})`);
        return { count: rows.length };
      }),
  };
}

export const fakePrisma = {
  decision: model("decision"),
  bounty: model("bounty"),
  claim: model("claim"),
  verdict: model("verdict"),
  settings: model("settings"),
  payout: model("payout"),
  gitHubMergeEvent: model("gitHubMergeEvent"),
  /** Runs the operations in order; if one fails, every change made so far is undone. */
  $transaction: async (ops: Op<unknown>[]) => {
    const snapshot = structuredClone(tables);
    try {
      const results: unknown[] = [];
      for (const op of ops) results.push(await op.run());
      return results;
    } catch (err) {
      for (const key of Object.keys(tables)) delete tables[key];
      Object.assign(tables, snapshot);
      throw err;
    }
  },
};

/** A funded, claimed bounty with a passing verdict: the starting point for most tests. */
export function seedBasics(
  over: { amountCents?: number; bountyStatus?: string; paused?: boolean; injectionFlags?: string; confidence?: number } = {},
): void {
  const early = new Date("2026-01-01T00:00:00Z");
  resetFakeDb();
  tables.bounty = [
    {
      id: "b1", repo: "acme/widgets", issueNumber: 12, title: "Add slugify", amountCents: over.amountCents ?? 3000,
      criteria: "- x", status: over.bountyStatus ?? "open", fundingOrderId: "ORD1", fundingCaptureId: "CAP1", createdAt: early,
    },
  ];
  tables.claim = [{ id: "c1", bountyId: "b1", githubUser: "alice", paypalEmail: "alice.payee@example.com", createdAt: early }];
  tables.verdict = [
    {
      id: "v1", bountyId: "b1", prNumber: 7, prUrl: "https://example.com/pr/7", prAuthor: "Alice", ciPassed: true,
      mergedByMaintainer: true, meetsCriteria: true, confidence: over.confidence ?? 0.95, unmetCriteria: "[]",
      summary: "ok", injectionFlags: over.injectionFlags ?? "[]", model: "test", createdAt: early,
    },
  ];
  tables.decision = [];
  tables.payout = [];
  tables.settings = [
    { id: "default", autoPayCapCents: 5000, contributorDailyCapCents: 10000, monthlyBudgetCents: 50000, paused: over.paused ?? false },
  ];
}

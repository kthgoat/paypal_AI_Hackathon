// Seeds demo data. Run with: npm run seed
//
// Idempotent: every write is an upsert with an empty `update`, so running it
// twice changes nothing, and it never overwrites edits made through the app.

// PLACEHOLDER: set this to the GitHub user/org that owns the demo repo.
// (Changing it later creates new bounty rows: the upsert key includes the repo.)
const DEMO_OWNER = "TBD-OWNER";
const DEMO_REPO = `${DEMO_OWNER}/bountypilot-demo`;

const DEMO_BOUNTIES = [
  {
    issueNumber: 1,
    title: "Add slugify helper",
    amountUsd: 30,
    criteria: [
      "- Exports `slugify(input: string): string` from `src/slugify.ts`",
      "- Lowercases the input and replaces runs of non-alphanumeric characters with a single hyphen",
      "- Includes unit tests (empty string, punctuation, leading/trailing spaces) and CI passes",
    ].join("\n"),
  },
  {
    issueNumber: 2,
    title: "Add date range formatter",
    amountUsd: 200,
    criteria: [
      "- Exports `formatDateRange(start: Date, end: Date): string` from `src/dateRange.ts`",
      "- Same-day ranges print one date; other ranges print `start – end`",
      "- Throws a clear error when `end` is before `start`, with unit tests and CI passing",
    ].join("\n"),
  },
  {
    issueNumber: 3,
    title: "Fix trim edge case",
    amountUsd: 40,
    criteria: [
      "- `trim()` returns an empty string for input that is only whitespace",
      "- Non-breaking spaces (\\u00A0) are trimmed along with tabs and newlines",
      "- Adds a regression test for each case and CI passes",
    ].join("\n"),
  },
];

async function main() {
  // Load .env.local before the DB module reads DATABASE_URL (hence the dynamic import).
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local: lib/db.ts falls back to file:./dev.db
  }
  const { prisma, usdToCents } = await import("../lib/db");

  try {
    await prisma.settings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        autoPayCapCents: usdToCents(50),
        contributorDailyCapCents: usdToCents(100),
        monthlyBudgetCents: usdToCents(500),
        paused: false,
      },
      update: {},
    });

    for (const b of DEMO_BOUNTIES) {
      // Seed bounties are already funded ('open' = funded), with placeholder PayPal IDs.
      const fundingOrderId = `SEED-ORDER-${b.issueNumber}`;
      const fundingCaptureId = `SEED-CAPTURE-${b.issueNumber}`;

      await prisma.bounty.upsert({
        where: { repo_issueNumber: { repo: DEMO_REPO, issueNumber: b.issueNumber } },
        create: {
          repo: DEMO_REPO,
          issueNumber: b.issueNumber,
          title: b.title,
          amountCents: usdToCents(b.amountUsd),
          criteria: b.criteria,
          status: "open",
          fundingOrderId,
          fundingCaptureId,
        },
        update: {},
      });

      // Backfill rows seeded before funding existed. Only touches a still-'open'
      // bounty that has no funding IDs, so real funding data is never overwritten.
      await prisma.bounty.updateMany({
        where: {
          repo: DEMO_REPO,
          issueNumber: b.issueNumber,
          status: "open",
          fundingOrderId: null,
          fundingCaptureId: null,
        },
        data: { fundingOrderId, fundingCaptureId },
      });
    }

    const [settings, bounties] = await Promise.all([
      prisma.settings.count(),
      prisma.bounty.count(),
    ]);
    console.log(`Seed complete: ${settings} settings row, ${bounties} bounties.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

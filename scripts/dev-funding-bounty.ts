// Dev helper for manually testing bounty funding. Touches ONLY the test bounty
// test/funding-check#99 ($25) by default; it never changes the seed or any seeded bounty.
//
//   npx tsx scripts/dev-funding-bounty.ts            create it if missing (status awaiting_funding), then show it
//   npx tsx scripts/dev-funding-bounty.ts --show     just show its status and funding ids
//   npx tsx scripts/dev-funding-bounty.ts --reset    put it back to awaiting_funding and clear its funding ids
//                                                    (refuses if it already holds a capture id, unless --force)
//   npx tsx scripts/dev-funding-bounty.ts --issue=100 create a separate test bounty, preserving earlier payments
//   npx tsx scripts/dev-funding-bounty.ts --remove-funded --issue=101
//       remove completed standalone funding-check tests locally, then create a fresh test

// Makes this file a module, so its top-level names don't clash with other scripts (e.g. prisma/seed.ts).
export {};

const TEST_REPO = "test/funding-check";
const TEST_ISSUE = Number(process.argv.find((arg) => arg.startsWith("--issue="))?.slice("--issue=".length) ?? 99);

async function main() {
  if (!Number.isSafeInteger(TEST_ISSUE) || TEST_ISSUE <= 0) {
    throw new Error("--issue must be a positive integer, for example --issue=100");
  }
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local: lib/db.ts falls back to file:./dev.db
  }
  const { prisma, usdToCents } = await import("../lib/db");
  const key = { repo_issueNumber: { repo: TEST_REPO, issueNumber: TEST_ISSUE } };

  try {
    if (process.argv.includes("--remove-funded")) {
      const removed = await prisma.bounty.deleteMany({
        where: {
          repo: TEST_REPO,
          status: "open",
          fundingCaptureId: { not: null },
          claim: { is: null },
          verdicts: { none: {} },
          decisions: { none: {} },
          payouts: { none: {} },
        },
      });
      console.log(`Removed ${removed.count} funded funding-check tests from the local database.`);
    }
    if (process.argv.includes("--reset")) {
      const existing = await prisma.bounty.findUnique({ where: key });
      if (existing?.fundingCaptureId && !process.argv.includes("--force")) {
        console.error(
          "Refusing to reset: this bounty already holds a PayPal capture id. Use --reset --force to reset it anyway.",
        );
        process.exitCode = 1;
        return;
      }
      // Only ever the test bounty (repo + issue number), never any other row.
      await prisma.bounty.updateMany({
        where: { repo: TEST_REPO, issueNumber: TEST_ISSUE },
        data: { status: "awaiting_funding", fundingOrderId: null, fundingCaptureId: null },
      });
    }
    if (!process.argv.includes("--show")) {
      await prisma.bounty.upsert({
        where: key,
        create: {
          repo: TEST_REPO,
          issueNumber: TEST_ISSUE,
          title: TEST_ISSUE === 99 ? "Funding check" : `Funding check #${TEST_ISSUE}`,
          amountCents: usdToCents(25),
          criteria: "- Test bounty used to check PayPal funding",
          status: "awaiting_funding",
        },
        update: {},
      });
    }

    const b = await prisma.bounty.findUnique({ where: key });
    if (!b) {
      console.log("Test bounty does not exist yet. Run without --show to create it.");
      return;
    }
    console.log(`id:               ${b.id}`);
    console.log(`status:           ${b.status}`);
    console.log(`amount:           $${(b.amountCents / 100).toFixed(2)}`);
    console.log(`fundingOrderId:   ${b.fundingOrderId ?? "null"}`);
    console.log(`fundingCaptureId: ${b.fundingCaptureId ?? "null"}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

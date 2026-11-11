// Dev helper for manually testing bounty funding. Touches ONLY test bounties; it never changes the
// seed or any seeded bounty. By default that is test/funding-check#99 ($25); --issue=N picks another
// funding-check issue number. With --policy-check it is test/policy-check#98 ($80, over the $50
// auto-pay cap) instead.
//
//   npx tsx scripts/dev-funding-bounty.ts            create it if missing (status awaiting_funding), then show it
//   npx tsx scripts/dev-funding-bounty.ts --show     just show its status and funding ids
//   npx tsx scripts/dev-funding-bounty.ts --reset    put it back to awaiting_funding and clear its funding ids
//                                                    (refuses if it already holds a capture id, unless --force)
//   npx tsx scripts/dev-funding-bounty.ts --issue=100 create a separate test bounty, preserving earlier payments
//   npx tsx scripts/dev-funding-bounty.ts --remove-funded --issue=101
//       remove completed standalone funding-check tests locally, then create a fresh test
//   add --policy-check to create / --show / --reset to work on test/policy-check#98 instead
//   (--policy-check always uses issue 98, so it can't be combined with --issue or --remove-funded)

// Makes this file a module, so its top-level names don't clash with other scripts (e.g. prisma/seed.ts).
export {};

const POLICY_CHECK = process.argv.includes("--policy-check");
const TEST_REPO = POLICY_CHECK ? "test/policy-check" : "test/funding-check";
const TEST_ISSUE = POLICY_CHECK
  ? 98
  : Number(process.argv.find((arg) => arg.startsWith("--issue="))?.slice("--issue=".length) ?? 99);
const TEST_AMOUNT_USD = POLICY_CHECK ? 80 : 25;
const TEST_TITLE = POLICY_CHECK ? "Policy check" : TEST_ISSUE === 99 ? "Funding check" : `Funding check #${TEST_ISSUE}`;

async function main() {
  if (!Number.isSafeInteger(TEST_ISSUE) || TEST_ISSUE <= 0) {
    throw new Error("--issue must be a positive integer, for example --issue=100");
  }
  if (POLICY_CHECK && (process.argv.includes("--remove-funded") || process.argv.some((arg) => arg.startsWith("--issue=")))) {
    throw new Error("--policy-check always works on test/policy-check#98; don't combine it with --issue or --remove-funded");
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
          title: TEST_TITLE,
          amountCents: usdToCents(TEST_AMOUNT_USD),
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

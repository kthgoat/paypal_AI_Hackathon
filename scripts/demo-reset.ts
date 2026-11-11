// Clears the LOCAL ledger for the demo repo so a demo can be recorded from a clean start.
//
//   npx tsx scripts/demo-reset.ts          dry run: shows what would be deleted, deletes nothing
//   npx tsx scripts/demo-reset.ts --yes    deletes it (one transaction: all or nothing)
//
// Only rows for kthgoat/bountypilot-demo are touched: its bounties and their claims, verdicts,
// decisions and payouts, plus its GitHubMergeEvents. Other repos' rows, Settings and the schema
// are never touched, and nothing is sent to PayPal or GitHub: money that was already moved at
// PayPal stays moved, only OUR record of it is removed.
//
// To get the seeded demo bounties back afterwards, run: npm run seed

// Makes this file a module, so its top-level names don't clash with other scripts.
export {};

const DEMO_REPO = "kthgoat/bountypilot-demo";

async function main() {
  const confirmed = process.argv.includes("--yes");

  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local: lib/db.ts falls back to file:./dev.db
  }
  const { prisma } = await import("../lib/db");

  try {
    // Repo names are matched case-insensitively here (SQLite cannot do it in the query).
    const isDemoRepo = (repo: string) => repo.toLowerCase() === DEMO_REPO;
    const bounties = (await prisma.bounty.findMany({ where: {} })).filter((b) => isDemoRepo(b.repo));
    const bountyIds = bounties.map((b) => b.id);
    const events = (await prisma.gitHubMergeEvent.findMany({ where: {} })).filter((e) => isDemoRepo(e.repo));
    const deliveryIds = events.map((e) => e.deliveryId);

    const counts = {
      payouts: await prisma.payout.count({ where: { bountyId: { in: bountyIds } } }),
      decisions: await prisma.decision.count({ where: { bountyId: { in: bountyIds } } }),
      verdicts: await prisma.verdict.count({ where: { bountyId: { in: bountyIds } } }),
      claims: await prisma.claim.count({ where: { bountyId: { in: bountyIds } } }),
      mergeEvents: events.length,
      bounties: bounties.length,
    };
    const funded = bounties.filter((b) => b.fundingCaptureId).length;

    console.log(`Repo: ${DEMO_REPO}`);
    for (const [name, n] of Object.entries(counts)) console.log(`  ${name.padEnd(12)} ${n}`);
    if (funded > 0) {
      console.log(`  (${funded} of these bounties were funded at PayPal; that money is NOT touched, only our record is removed)`);
    }

    if (!confirmed) {
      console.log("\nDry run: nothing was deleted. Add --yes to delete these rows.");
      return;
    }
    if (bounties.length === 0 && events.length === 0) {
      console.log("\nNothing to delete.");
      return;
    }

    // Children first, so no foreign key is ever violated. All or nothing.
    await prisma.$transaction([
      prisma.payout.deleteMany({ where: { bountyId: { in: bountyIds } } }),
      prisma.decision.deleteMany({ where: { bountyId: { in: bountyIds } } }),
      prisma.verdict.deleteMany({ where: { bountyId: { in: bountyIds } } }),
      prisma.claim.deleteMany({ where: { bountyId: { in: bountyIds } } }),
      prisma.gitHubMergeEvent.deleteMany({ where: { deliveryId: { in: deliveryIds } } }),
      prisma.bounty.deleteMany({ where: { id: { in: bountyIds } } }),
    ]);
    console.log("\nDeleted. The ledger for this repo is now empty. (npm run seed brings the seeded demo bounties back.)");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exitCode = 1;
});

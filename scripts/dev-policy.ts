// Dev helper for trying the policy engine and approvals against the PayPal SANDBOX.
// Touches ONLY the test bounty test/policy-check#98 ($80, created by
// `npx tsx scripts/dev-funding-bounty.ts --policy-check` and funded in the browser).
// It never prints the receiver email.
//
//   npx tsx scripts/dev-policy.ts prepare   add a Claim and a passing Verdict (needs the bounty funded: 'open' + capture id)
//   npx tsx scripts/dev-policy.ts decide    run recordPolicyDecision() on that verdict and show the Decision and bounty status
//   npx tsx scripts/dev-policy.ts show      print the bounty, its decisions (oldest first) and its payouts
//
// After `decide`, approve it through the API: POST /api/approvals/<bountyId> with the x-maintainer-key header.

// Makes this file a module, so its top-level names don't clash with other scripts.
export {};

const TEST_REPO = "test/policy-check";
const TEST_ISSUE = 98;
const CLAIM_USER = "test-contributor";
const VERDICT_ID = "dev-policy-verdict";

async function main() {
  const command = process.argv[2] ?? "show";

  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local: lib/db.ts falls back to file:./dev.db
  }

  // Imported after the env is ready, because lib/db.ts reads DATABASE_URL on import.
  const { prisma } = await import("../lib/db");
  const { recordPolicyDecision } = await import("../lib/decisions");

  try {
    const bounty = await prisma.bounty.findUnique({
      where: { repo_issueNumber: { repo: TEST_REPO, issueNumber: TEST_ISSUE } },
    });
    if (!bounty) {
      console.error("STOP: the test bounty does not exist. Run: npx tsx scripts/dev-funding-bounty.ts --policy-check");
      process.exitCode = 1;
      return;
    }

    if (command === "prepare") {
      if (!bounty.fundingCaptureId || !["open", "awaiting_approval"].includes(bounty.status)) {
        console.error(
          `STOP: the test bounty must be funded ('open' with a capture id), but it is '${bounty.status}' ` +
            `with ${bounty.fundingCaptureId ? "a" : "no"} capture id.`,
        );
        process.exitCode = 1;
        return;
      }
      const receiver = process.env.PAYPAL_TEST_RECEIVER;
      if (!receiver) {
        console.error("PAYPAL_TEST_RECEIVER is not set in .env.local.");
        process.exitCode = 1;
        return;
      }
      await prisma.claim.upsert({
        where: { bountyId: bounty.id },
        create: { bountyId: bounty.id, githubUser: CLAIM_USER, paypalEmail: receiver },
        update: { githubUser: CLAIM_USER, paypalEmail: receiver },
      });
      await prisma.verdict.upsert({
        where: { id: VERDICT_ID },
        create: {
          id: VERDICT_ID,
          bountyId: bounty.id,
          prNumber: 2,
          prUrl: "https://example.com/test-contributor/pull/2",
          prAuthor: CLAIM_USER,
          ciPassed: true,
          mergedByMaintainer: true,
          meetsCriteria: true,
          confidence: 0.95,
          unmetCriteria: "[]",
          summary: "Dev test verdict: everything passes, so only the $80 amount holds it back",
          injectionFlags: "[]",
          model: "dev-script",
        },
        update: {},
      });
      console.log(`Prepared test bounty ${bounty.id}: claim (${CLAIM_USER}) and passing verdict ${VERDICT_ID}.`);
      return;
    }

    if (command === "decide") {
      const decision = await recordPolicyDecision(VERDICT_ID);
      const after = await prisma.bounty.findUniqueOrThrow({ where: { id: bounty.id } });
      console.log(`decision: outcome=${decision.outcome} ruleFired=${decision.ruleFired} decidedBy=${decision.decidedBy}`);
      console.log(`bounty:   $${(after.amountCents / 100).toFixed(2)} status=${after.status}`);
      return;
    }

    if (command !== "show") {
      console.error("Unknown command. Use: prepare | decide | show");
      process.exitCode = 1;
      return;
    }

    const current = await prisma.bounty.findUniqueOrThrow({ where: { id: bounty.id } });
    console.log(
      `bounty ${current.id}: $${(current.amountCents / 100).toFixed(2)} status=${current.status} capture=${current.fundingCaptureId ?? "null"}`,
    );
    const decisions = await prisma.decision.findMany({ where: { bountyId: bounty.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    if (decisions.length === 0) console.log("no decisions");
    for (const d of decisions) {
      console.log(`decision ${d.id}: ${d.outcome} (${d.ruleFired}) by ${d.decidedBy} at ${d.createdAt.toISOString()}`);
    }
    const payouts = await prisma.payout.findMany({ where: { bountyId: bounty.id }, orderBy: { createdAt: "asc" } });
    if (payouts.length === 0) console.log("no payouts");
    for (const p of payouts) {
      console.log(
        `payout ${p.id}: $${(p.amountCents / 100).toFixed(2)} status=${p.status} batch=${p.payoutBatchId ?? "null"} to ${p.receiverMasked}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exitCode = 1;
});

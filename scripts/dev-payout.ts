// Dev helper for trying the bounty payout service against the PayPal SANDBOX.
// Touches ONLY the test bounty test/funding-check#99 (the one scripts/dev-funding-bounty.ts funds).
// It never prints the receiver email.
//
//   npx tsx scripts/dev-payout.ts prepare         add a Claim, Verdict and 'auto_pay' Decision to the funded test bounty
//   npx tsx scripts/dev-payout.ts send            sendBountyPayout() for that decision (run it twice to see the replay)
//   npx tsx scripts/dev-payout.ts refresh         poll PayPal until the payout is no longer PENDING (up to ~60 s)
//   npx tsx scripts/dev-payout.ts show            print the test bounty's status and its payout rows
//   npx tsx scripts/dev-payout.ts refuse-paused   show the 'paused' refusal using a THROWAWAY COPY of the db

// (The import below also makes this file a module, so its names don't clash with other scripts.)
import { copyFileSync, rmSync } from "node:fs";

const TEST_REPO = "test/funding-check";
const TEST_ISSUE = 99;
const CLAIM_USER = "test-contributor";
const VERDICT_ID = "dev-payout-verdict";
const DECISION_ID = "dev-payout-decision";
const THROWAWAY_DB = "dev-paused-check.db";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const command = process.argv[2] ?? "show";

  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local: lib/db.ts falls back to file:./dev.db
  }

  // The paused-refusal demo runs on a copy, so the real settings row is never touched.
  if (command === "refuse-paused") {
    const original = (process.env.DATABASE_URL ?? "file:./dev.db").replace(/^file:/, "");
    copyFileSync(original, THROWAWAY_DB);
    process.env.DATABASE_URL = `file:./${THROWAWAY_DB}`;
  }

  // Imported after the env is ready, because lib/db.ts reads DATABASE_URL on import.
  const { prisma } = await import("../lib/db");
  const { refreshPayoutStatus, sendBountyPayout, PayoutRefusedError } = await import("../lib/paypal/payouts");
  const { executeSendBountyPayout } = await import("../lib/paypal/payout-tool");

  try {
    const bounty = await prisma.bounty.findUnique({
      where: { repo_issueNumber: { repo: TEST_REPO, issueNumber: TEST_ISSUE } },
    });
    if (!bounty) {
      console.error("STOP: the test bounty does not exist. Run scripts/dev-funding-bounty.ts first.");
      process.exitCode = 1;
      return;
    }

    if (command === "prepare") {
      // Precondition: the bounty must already be funded.
      if (bounty.status !== "open" || !bounty.fundingCaptureId) {
        console.error(
          `STOP: the test bounty must be 'open' with a capture id, but it is '${bounty.status}' ` +
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
          prNumber: 1,
          prUrl: "https://example.com/test-contributor/pull/1",
          prAuthor: CLAIM_USER,
          ciPassed: true,
          mergedByMaintainer: true,
          meetsCriteria: true,
          confidence: 0.95,
          unmetCriteria: "[]",
          summary: "Dev test verdict",
          injectionFlags: "[]",
          model: "dev-script",
        },
        update: {},
      });
      await prisma.decision.upsert({
        where: { id: DECISION_ID },
        create: {
          id: DECISION_ID,
          bountyId: bounty.id,
          verdictId: VERDICT_ID,
          outcome: "auto_pay",
          ruleFired: "dev_test",
          decidedBy: "policy",
        },
        update: {},
      });
      console.log(`Prepared test bounty ${bounty.id}: claim (${CLAIM_USER}), verdict ${VERDICT_ID}, decision ${DECISION_ID} (auto_pay).`);
      return;
    }

    if (command === "send") {
      try {
        console.log(JSON.stringify(await sendBountyPayout({ decisionId: DECISION_ID }), null, 2));
      } catch (err) {
        if (err instanceof PayoutRefusedError) {
          console.log(`REFUSED: ${err.reason}: ${err.message}`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
      return;
    }

    if (command === "refresh") {
      const payout = await prisma.payout.findFirst({
        where: { bountyId: bounty.id },
        orderBy: { createdAt: "desc" },
      });
      if (!payout) {
        console.error("No payout exists for the test bounty yet. Run `send` first.");
        process.exitCode = 1;
        return;
      }
      for (let i = 0; i < 20; i++) {
        const result = await refreshPayoutStatus(payout.id);
        console.log(`[${i * 3}s] payout status: ${result.status}`);
        if (result.status !== "PENDING") return;
        await sleep(3000);
      }
      console.log("Still PENDING after ~60 s. Run `refresh` again later.");
      return;
    }

    if (command === "refuse-paused") {
      await prisma.settings.update({ where: { id: "default" }, data: { paused: true } });
      console.log("(on a throwaway copy of the database; the real settings row is untouched)");
      // Through the tool, so this is exactly what the agent would receive.
      console.log(JSON.stringify(await executeSendBountyPayout({ decisionId: DECISION_ID }), null, 2));
      return;
    }

    if (command !== "show") {
      console.error("Unknown command. Use: prepare | send | refresh | show | refuse-paused");
      process.exitCode = 1;
      return;
    }

    // show
    const current = await prisma.bounty.findUniqueOrThrow({ where: { id: bounty.id } });
    console.log(`bounty ${current.id}: status=${current.status} capture=${current.fundingCaptureId ?? "null"}`);
    const payouts = await prisma.payout.findMany({ where: { bountyId: bounty.id }, orderBy: { createdAt: "asc" } });
    if (payouts.length === 0) console.log("no payouts");
    for (const p of payouts) {
      console.log(
        `payout ${p.id}\n  senderBatchId:  ${p.senderBatchId}\n  payoutBatchId:  ${p.payoutBatchId ?? "null"}\n` +
          `  amount:         $${(p.amountCents / 100).toFixed(2)}\n  status:         ${p.status}\n` +
          `  receiverMasked: ${p.receiverMasked}\n  createdAt:      ${p.createdAt.toISOString()}\n  updatedAt:      ${p.updatedAt.toISOString()}`,
      );
    }
  } finally {
    await prisma.$disconnect();
    if (command === "refuse-paused") rmSync(THROWAWAY_DB, { force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exitCode = 1;
});

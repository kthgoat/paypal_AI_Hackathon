// Dev helper for trying the merge processor against ONE real merged PR in the PayPal/GitHub SANDBOX
// setup, without a webhook. It touches only: the bounty for that PR's repo + linked issue (created
// if missing), that bounty's claim, one GitHubMergeEvent, and whatever processing of that event creates.
// It never prints the receiver email, any key, or the diff.
//
//   npx tsx scripts/dev-orchestrate.ts context <owner/repo> <pr>     read the PR from GitHub and print what we learn (changes nothing)
//   npx tsx scripts/dev-orchestrate.ts prepare <owner/repo> <pr> [--amount=25] [--criteria="- a\n- b"]
//                                                                  create the dev bounty for the PR's "Closes #N" issue (awaiting_funding),
//                                                                  titled with that GitHub issue's title (re-running refreshes the title)
//                                                                  and a claim for the PR author, paid to PAYPAL_TEST_RECEIVER
//   npx tsx scripts/dev-orchestrate.ts event <owner/repo> <pr>       store one GitHubMergeEvent for the real PR (what the webhook would store)
//   npx tsx scripts/dev-orchestrate.ts process <owner/repo> <pr>     run processMergeEvent on that event and print the result
//   npx tsx scripts/dev-orchestrate.ts show <owner/repo> <pr>        print the bounty, event, verdict, decisions and payouts
//
// Funding the bounty is the existing flow: POST /api/bounties/<id>/fund, approve in the browser,
// then POST /api/bounties/<id>/fund/capture.

// Makes this file a module, so its top-level names don't clash with other scripts.
export {};

const [command = "show", repoArg, prArg, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** The issue's title from GitHub, using GITHUB_TOKEN (sent only in the Authorization header, never printed). */
async function fetchIssueTitle(repo: string, issueNumber: number): Promise<string> {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository name");
  const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bountypilot",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub GET /repos/${repo}/issues/${issueNumber} failed with ${response.status}`);
  const title = (((await response.json()) as { title?: unknown }).title ?? "").toString().replace(/\s+/g, " ").trim().slice(0, 200);
  if (!title) throw new Error(`Issue ${repo}#${issueNumber} has no title`);
  return title;
}

async function main() {
  if (!["context", "prepare", "event", "process", "show"].includes(command) || !repoArg || !prArg) {
    console.error("Usage: npx tsx scripts/dev-orchestrate.ts <context|prepare|event|process|show> <owner/repo> <pr-number> [--amount=25] [--criteria=...]");
    process.exitCode = 1;
    return;
  }
  const repo = repoArg;
  const prNumber = Number(prArg);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error("pr-number must be a positive integer");
  const deliveryId = `dev-${repo.replace("/", "-").toLowerCase()}-pr${prNumber}`;

  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local: lib/db.ts falls back to file:./dev.db
  }
  const { prisma, usdToCents } = await import("../lib/db");
  const { getPrContext } = await import("../lib/github/pr-context");
  const { processMergeEvent } = await import("../lib/orchestrator");

  try {
    if (command === "context") {
      const ctx = await getPrContext(repo, prNumber);
      console.log(`title:               ${JSON.stringify(ctx.title)}`);
      console.log(`author / merged by:  ${ctx.author} / ${ctx.mergedBy ?? "(nobody)"}`);
      console.log(`merged:              ${ctx.merged}`);
      console.log(`mergedByMaintainer:  ${ctx.mergedByMaintainer}`);
      console.log(`base / default:      ${ctx.baseBranch} / ${ctx.defaultBranch} (into default: ${ctx.mergedIntoDefaultBranch})`);
      console.log(`merge commit:        ${ctx.mergeCommitSha ?? "null"}`);
      console.log(`linked issues:       ${ctx.linkedIssues.map((n) => `#${n}`).join(", ") || "(none)"}`);
      console.log(`ci:                  ${ctx.ci} (${ctx.ciSummary})`);
      console.log(`files (${ctx.files.length}${ctx.filesTruncated ? "+" : ""}):`);
      for (const f of ctx.files.slice(0, 15)) console.log(`  ${f.filename} (${f.status} +${f.additions} -${f.deletions})`);
      console.log(`diff:                ${Buffer.byteLength(ctx.diff)} bytes${ctx.diffTruncated ? " (truncated)" : ""}`);
      return;
    }

    if (command === "prepare") {
      const ctx = await getPrContext(repo, prNumber);
      if (ctx.linkedIssues.length !== 1) {
        console.error(`STOP: the PR body must close exactly one issue ("Closes #N"); found: ${ctx.linkedIssues.join(", ") || "none"}.`);
        process.exitCode = 1;
        return;
      }
      const issueNumber = ctx.linkedIssues[0];
      const receiver = process.env.PAYPAL_TEST_RECEIVER;
      if (!receiver) {
        console.error("PAYPAL_TEST_RECEIVER is not set.");
        process.exitCode = 1;
        return;
      }
      const amount = Number(flag("amount") ?? 25);
      if (!(amount > 0 && amount <= 1000)) throw new Error("--amount must be between 0 and 1000 (dollars)");

      // The Windows npx shim drops everything after a newline in an argument, so accept a literal \n instead.
      const criteria = flag("criteria")?.split("\\n").join("\n");
      const title = await fetchIssueTitle(repo, issueNumber); // the issue's own title, not a made-up one
      const bounty = await prisma.bounty.upsert({
        where: { repo_issueNumber: { repo, issueNumber } },
        create: {
          repo,
          issueNumber,
          title,
          amountCents: usdToCents(amount),
          criteria: criteria ?? "- The change resolves the linked issue\n- The change includes working code",
          status: "awaiting_funding",
        },
        // Re-running refreshes the title from GitHub. Criteria change only with --criteria (dev bounty only).
        update: criteria ? { title, criteria } : { title },
      });
      await prisma.claim.upsert({
        where: { bountyId: bounty.id },
        create: { bountyId: bounty.id, githubUser: ctx.author, paypalEmail: receiver },
        update: {},
      });
      console.log(`bounty ${bounty.id}: ${repo}#${issueNumber} ${JSON.stringify(bounty.title)} $${(bounty.amountCents / 100).toFixed(2)} status=${bounty.status}`);
      console.log(`criteria:\n${bounty.criteria}`);
      console.log(`claim: ${ctx.author} (paid to PAYPAL_TEST_RECEIVER)`);
      return;
    }

    if (command === "event") {
      const ctx = await getPrContext(repo, prNumber);
      if (!ctx.merged || !ctx.mergeCommitSha) {
        console.error("STOP: that PR is not merged.");
        process.exitCode = 1;
        return;
      }
      const existing = await prisma.gitHubMergeEvent.findUnique({ where: { deliveryId } });
      if (existing) {
        console.log(`event ${deliveryId} already exists (status ${existing.status}).`);
        return;
      }
      await prisma.gitHubMergeEvent.create({
        data: {
          deliveryId,
          repo: repo.toLowerCase(),
          prNumber,
          prUrl: `https://github.com/${repo}/pull/${prNumber}`,
          prAuthor: ctx.author,
          mergeSha: ctx.mergeCommitSha.toLowerCase(),
        },
      });
      console.log(`stored event ${deliveryId} (status received).`);
      return;
    }

    if (command === "process") {
      const result = await processMergeEvent(deliveryId);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // show
    const event = await prisma.gitHubMergeEvent.findUnique({ where: { deliveryId } });
    console.log(
      event
        ? `event ${deliveryId}: status=${event.status} attempts=${event.attempts} verdict=${event.verdictId ?? "null"} lastError=${event.lastError ?? "null"}`
        : `no event ${deliveryId}`,
    );
    const bounties = (await prisma.bounty.findMany({ where: {} })).filter((b) => b.repo.toLowerCase() === repo.toLowerCase());
    for (const b of bounties) {
      console.log(`bounty ${b.id}: ${b.repo}#${b.issueNumber} $${(b.amountCents / 100).toFixed(2)} status=${b.status} funded=${Boolean(b.fundingCaptureId)}`);
      for (const v of await prisma.verdict.findMany({ where: { bountyId: b.id } })) {
        console.log(
          `verdict ${v.id}: meets=${v.meetsCriteria} confidence=${v.confidence} ci=${v.ciPassed} maintainerMerge=${v.mergedByMaintainer} model=${v.model}\n` +
            `  summary: ${v.summary}\n  unmet: ${v.unmetCriteria}\n  injectionFlags: ${v.injectionFlags}`,
        );
      }
      for (const d of await prisma.decision.findMany({ where: { bountyId: b.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })) {
        console.log(`decision ${d.id}: ${d.outcome} (${d.ruleFired}) by ${d.decidedBy}`);
      }
      for (const p of await prisma.payout.findMany({ where: { bountyId: b.id } })) {
        console.log(`payout ${p.id}: $${(p.amountCents / 100).toFixed(2)} status=${p.status} batch=${p.payoutBatchId ?? "null"} to ${p.receiverMasked}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exitCode = 1;
});

import { apiError, handleRouteError } from "../../../../lib/api";
import { prisma } from "../../../../lib/db";
import { after } from "next/server";
import { Prisma } from "../../../../lib/generated/prisma/client";
import { processMergeEvent } from "../../../../lib/orchestrator";
import { mergedPullRequestSchema, pullRequestEventSchema, verifyWebhookSignature } from "../../../../lib/github/webhook";

// The work scheduled with after() below can take a while (a review, then watching a payout).
export const maxDuration = 120;

export async function POST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret?.trim()) {
    return apiError(503, "GITHUB_NOT_CONFIGURED", "Set GITHUB_WEBHOOK_SECRET before receiving webhooks");
  }

  try {
    const body = new Uint8Array(await request.arrayBuffer());
    if (!verifyWebhookSignature(body, request.headers.get("x-hub-signature-256"), secret)) {
      return apiError(401, "INVALID_SIGNATURE", "Invalid GitHub webhook signature");
    }
    const deliveryId = request.headers.get("x-github-delivery");
    const event = request.headers.get("x-github-event");
    if (!deliveryId || deliveryId.length > 128 || !event) {
      return apiError(400, "INVALID_HEADERS", "GitHub event and delivery headers are required");
    }

    // GitHub sends a ping when the webhook is first configured.
    if (event === "ping") return Response.json({ status: "pong" });
    if (event !== "pull_request") return Response.json({ status: "ignored" });

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      return apiError(400, "INVALID_REQUEST", "Expected a UTF-8 JSON payload");
    }
    const { action, pull_request: pr } = pullRequestEventSchema.parse(payload);
    if (action !== "closed" || !pr.merged) return Response.json({ status: "ignored" });

    const merged = mergedPullRequestSchema.parse(payload);
    const data = {
      deliveryId,
      repo: merged.repository.full_name.toLowerCase(),
      prNumber: merged.pull_request.number,
      prUrl: merged.pull_request.html_url,
      prAuthor: merged.pull_request.user.login,
      mergeSha: merged.pull_request.merge_commit_sha.toLowerCase(),
    };
    try {
      await prisma.gitHubMergeEvent.create({ data });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return Response.json({ status: "duplicate" });
      }
      throw error;
    }
    console.info("[github] Merged PR recorded", { deliveryId, repo: data.repo, prNumber: data.prNumber });
    // Review, decide and (only if policy says auto_pay) pay AFTER GitHub has its 201, so the
    // delivery never waits on GitHub, the model or PayPal. If this is lost (a restart), the event
    // stays 'received' and POST /api/github/process picks it up.
    after(async () => {
      try {
        await processMergeEvent(deliveryId);
      } catch (error) {
        console.error("[github] Could not process merged PR", { deliveryId, reason: error instanceof Error ? error.name : "unknown" });
      }
    });
    return Response.json({ status: "received", deliveryId }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

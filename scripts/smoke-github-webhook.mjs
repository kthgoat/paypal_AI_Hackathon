// Sends a signed, synthetic merged-PR event to your LOCAL app. No GitHub or PayPal API calls.
// Run twice with the same delivery id to exercise persistent duplicate protection.
import { createHmac } from "node:crypto";

const secret = process.env.GITHUB_WEBHOOK_SECRET;
if (!secret?.trim()) {
  console.error("Set GITHUB_WEBHOOK_SECRET in .env.local first.");
  process.exit(1);
}

const base = new URL(process.env.APP_URL || "http://localhost:3000");
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
  console.error("This test only sends to localhost. Set APP_URL to your local app URL.");
  process.exit(1);
}

const deliveryId = process.argv[2] || "local-webhook-test-1";
const body = JSON.stringify({
  action: "closed",
  repository: { full_name: "bountypilot/webhook-test" },
  pull_request: {
    number: 1,
    merged: true,
    html_url: "https://github.com/bountypilot/webhook-test/pull/1",
    user: { login: "local-test-contributor" },
    merge_commit_sha: "a".repeat(40),
  },
});

try {
  const response = await fetch(new URL("/api/github/webhook", base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  console.log(`HTTP ${response.status}: ${await response.text()}`);
  if (!response.ok) process.exitCode = 1;
} catch {
  console.error("Could not reach the webhook. Start npm run dev and check APP_URL.");
  process.exitCode = 1;
}

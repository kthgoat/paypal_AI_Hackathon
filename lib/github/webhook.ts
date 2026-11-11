import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// Verify the original bytes, before parsing JSON or trusting any payload fields.
export function verifyWebhookSignature(body: Uint8Array, signature: string | null, secret: string): boolean {
  if (!secret || !signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

export const pullRequestEventSchema = z.object({
  action: z.string(),
  pull_request: z.object({ merged: z.boolean() }),
});

export const mergedPullRequestSchema = z.object({
  action: z.literal("closed"),
  repository: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
  pull_request: z.object({
    number: z.number().int().positive(),
    merged: z.literal(true),
    html_url: z.url({ protocol: /^https$/ }),
    user: z.object({ login: z.string().min(1).max(100) }),
    merge_commit_sha: z.string().regex(/^[a-fA-F0-9]{40,64}$/),
  }),
});

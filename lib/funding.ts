import { z } from "zod";

export class FundingError extends Error {
  constructor(message: string, public code: string, public paypalIssues: string[] = []) {
    super(message);
  }
}

const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    paypalIssues: z.array(z.string()).optional(),
  }),
});

async function post(path: string, body?: { orderId: string }): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(data);
    if (parsed.success) {
      const { code, message, paypalIssues } = parsed.data.error;
      throw new FundingError(message, code, paypalIssues);
    }
    throw new FundingError("The payment service could not respond. Please try again.", "INVALID_RESPONSE");
  }
  return data;
}

export async function createBountyOrder(bountyId: string): Promise<string> {
  const data = await post(`/api/bounties/${encodeURIComponent(bountyId)}/fund`);
  return z.object({ orderId: z.string().min(1) }).parse(data).orderId;
}

export async function captureBountyOrder(bountyId: string, orderId: string): Promise<string> {
  const data = await post(`/api/bounties/${encodeURIComponent(bountyId)}/fund/capture`, { orderId });
  return z.object({ status: z.literal("open"), captureId: z.string().min(1) }).parse(data).captureId;
}

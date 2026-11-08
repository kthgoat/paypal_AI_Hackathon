// The guarded payout tool, as a framework-agnostic definition for the agent to wrap.
//
//   const t = sendBountyPayoutTool;
//   // Vercel AI SDK:  tool({ description: t.description, inputSchema: t.inputSchema, execute: t.execute })
//
// The model can only say WHICH decision to act on. It cannot choose the amount or the
// recipient (both come from our database), and the payout only happens if that decision
// already allows it. execute() never throws: the model always gets a short JSON result.

import { z } from "zod";

import { PayPalConfigError, PayPalError } from "./client";
import {
  PAYOUT_REFUSAL_MESSAGES,
  PayoutError,
  PayoutRefusedError,
  sendBountyPayout,
  type PayoutRefusalReason,
} from "./payouts";

/** strictObject: any extra field (say, `amount` or `receiver`) is rejected, not ignored. */
export const sendBountyPayoutInputSchema = z.strictObject({
  decisionId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "decisionId must be an existing decision id")
    .describe("The id of the policy Decision that allows this payout."),
});

export type SendBountyPayoutToolResult =
  | {
      ok: true;
      payoutId: string;
      payoutBatchId: string | null;
      status: string;
      /** True when this decision had already been paid and nothing new was sent. */
      alreadySent: boolean;
    }
  | { ok: false; refused: true; reason: PayoutRefusalReason; message: string }
  | {
      ok: false;
      refused: false;
      error: { code: string; message: string; paypalName?: string; debugId?: string | null };
    };

export async function executeSendBountyPayout(input: unknown): Promise<SendBountyPayoutToolResult> {
  const parsed = sendBountyPayoutInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      refused: false,
      error: {
        code: "INVALID_INPUT",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    };
  }

  try {
    const result = await sendBountyPayout({ decisionId: parsed.data.decisionId });
    return {
      ok: true,
      payoutId: result.payoutId,
      payoutBatchId: result.payoutBatchId,
      status: result.status,
      alreadySent: result.replayed,
    };
  } catch (err) {
    if (err instanceof PayoutRefusedError) {
      return { ok: false, refused: true, reason: err.reason, message: PAYOUT_REFUSAL_MESSAGES[err.reason] };
    }
    if (err instanceof PayoutError) {
      return { ok: false, refused: false, error: { code: err.code, message: err.message } };
    }
    if (err instanceof PayPalError) {
      console.error("[payout-tool] PayPal rejected the payout", {
        status: err.status,
        name: err.paypalName,
        debugId: err.debugId,
      });
      return {
        ok: false,
        refused: false,
        error: { code: "PAYPAL_ERROR", message: err.message, paypalName: err.paypalName, debugId: err.debugId },
      };
    }
    if (err instanceof PayPalConfigError) {
      console.error("[payout-tool] PayPal is not configured:", err.message);
      return { ok: false, refused: false, error: { code: "PAYPAL_NOT_CONFIGURED", message: err.message } };
    }
    // Anything else is a bug: log it for us, give the model nothing to chew on.
    console.error("[payout-tool] unexpected error", err);
    return { ok: false, refused: false, error: { code: "INTERNAL_ERROR", message: "Unexpected error" } };
  }
}

export const sendBountyPayoutTool = {
  name: "send_bounty_payout",
  description:
    "Pays a verified bounty to the contributor through PayPal. The payment goes out ONLY if a policy " +
    "decision already allows it: pass the id of an existing Decision whose outcome is 'auto_pay' " +
    "(recorded by the policy engine, or by a maintainer after approving a 'needs_approval' case). " +
    "You cannot choose the amount or the recipient: both come from the bounty and its claim in the " +
    "database. If the policy does not allow the payout, the tool refuses and returns a reason code; " +
    "do not retry with different arguments. Calling it again for a decision that was already paid is " +
    "safe: it returns the existing payout and never pays twice.",
  inputSchema: sendBountyPayoutInputSchema,
  execute: executeSendBountyPayout,
} as const;

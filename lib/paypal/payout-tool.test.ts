import { beforeEach, describe, expect, it, vi } from "vitest";

import { PayPalConfigError, PayPalError } from "./client";
import { executeSendBountyPayout, sendBountyPayoutTool } from "./payout-tool";
import { PayoutError, PayoutRefusedError, sendBountyPayout } from "./payouts";

vi.mock("./payouts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./payouts")>()),
  sendBountyPayout: vi.fn(),
}));

const sendMock = vi.mocked(sendBountyPayout);

beforeEach(() => {
  sendMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("send_bounty_payout tool definition", () => {
  it("has the agreed name, says it only pays when a policy decision allows it, and takes only a decisionId", () => {
    expect(sendBountyPayoutTool.name).toBe("send_bounty_payout");
    expect(sendBountyPayoutTool.description).toMatch(/ONLY if a policy decision already allows/);
    expect(sendBountyPayoutTool.inputSchema.safeParse({ decisionId: "abc123" }).success).toBe(true);
  });

  it("rejects extra fields such as an amount or a receiver", () => {
    for (const extra of [{ amount: 1 }, { receiver: "x@y.com" }, { amountUsd: 1, email: "x@y.com" }]) {
      expect(sendBountyPayoutTool.inputSchema.safeParse({ decisionId: "abc", ...extra }).success).toBe(false);
    }
  });
});

describe("executeSendBountyPayout", () => {
  it.each([[undefined], [null], [{}], [{ decisionId: "" }], [{ decisionId: 42 }], [{ decisionId: "../x" }]])(
    "returns INVALID_INPUT for %j without touching payouts",
    async (input) => {
      const result = await executeSendBountyPayout(input);

      expect(result).toMatchObject({ ok: false, refused: false, error: { code: "INVALID_INPUT" } });
      expect(sendMock).not.toHaveBeenCalled();
    },
  );

  it("passes only the decision id through and returns a short success result", async () => {
    sendMock.mockResolvedValue({ payoutId: "p1", payoutBatchId: "B1", status: "PENDING", replayed: false });

    const result = await executeSendBountyPayout({ decisionId: "d1" });

    expect(sendMock).toHaveBeenCalledWith({ decisionId: "d1" });
    expect(result).toEqual({ ok: true, payoutId: "p1", payoutBatchId: "B1", status: "PENDING", alreadySent: false });
  });

  it("reports alreadySent when the payout already existed", async () => {
    sendMock.mockResolvedValue({ payoutId: "p1", payoutBatchId: "B1", status: "SUCCESS", replayed: true });

    expect(await executeSendBountyPayout({ decisionId: "d1" })).toMatchObject({ ok: true, alreadySent: true });
  });

  it("returns a refusal with its reason code, not an error", async () => {
    sendMock.mockRejectedValue(new PayoutRefusedError("PAUSED"));

    const result = await executeSendBountyPayout({ decisionId: "d1" });

    expect(result).toEqual({ ok: false, refused: true, reason: "PAUSED", message: "Payouts are paused." });
  });

  it("maps payout, PayPal and config failures to error codes without a stack", async () => {
    sendMock.mockRejectedValueOnce(new PayoutError("PAYOUT_OUTCOME_UNKNOWN", "may or may not have been sent"));
    expect(await executeSendBountyPayout({ decisionId: "d1" })).toMatchObject({
      error: { code: "PAYOUT_OUTCOME_UNKNOWN" },
    });

    sendMock.mockRejectedValueOnce(
      new PayPalError({ status: 400, name: "INSUFFICIENT_FUNDS", message: "no money", debugId: "dbg", details: [] }),
    );
    expect(await executeSendBountyPayout({ decisionId: "d1" })).toMatchObject({
      error: { code: "PAYPAL_ERROR", paypalName: "INSUFFICIENT_FUNDS", debugId: "dbg" },
    });

    sendMock.mockRejectedValueOnce(new PayPalConfigError("PAYPAL_ENVIRONMENT must be SANDBOX"));
    expect(await executeSendBountyPayout({ decisionId: "d1" })).toMatchObject({
      error: { code: "PAYPAL_NOT_CONFIGURED" },
    });
  });

  it("hides unexpected errors from the model: generic message, no stack, nothing thrown", async () => {
    sendMock.mockRejectedValue(new Error("SQLITE_BUSY: secret internal detail at C:\\app\\db.ts:42"));

    const result = await executeSendBountyPayout({ decisionId: "d1" });
    const json = JSON.stringify(result);

    expect(result).toEqual({ ok: false, refused: false, error: { code: "INTERNAL_ERROR", message: "Unexpected error" } });
    expect(json).not.toMatch(/SQLITE|secret|stack|db\.ts/);
  });
});

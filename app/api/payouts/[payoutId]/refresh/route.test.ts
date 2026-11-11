import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PayPalError } from "@/lib/paypal/client";
import { refreshPayoutStatus } from "@/lib/paypal/payouts";
import { seedBasics, tables } from "@/lib/testing/fake-db";

import { POST } from "./route";

vi.mock("@/lib/db", async (importOriginal) => {
  const { fakePrisma } = await import("@/lib/testing/fake-db");
  return { ...(await importOriginal<typeof import("@/lib/db")>()), prisma: fakePrisma };
});

vi.mock("@/lib/paypal/payouts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/paypal/payouts")>()),
  refreshPayoutStatus: vi.fn(),
}));

const refresh = vi.mocked(refreshPayoutStatus);
const call = (payoutId: string) =>
  POST(new NextRequest(`http://localhost/api/payouts/${payoutId}/refresh`, { method: "POST" }), {
    params: Promise.resolve({ payoutId }),
  });

const payoutRow = (id: string) => ({
  id, bountyId: "b1", senderBatchId: `batch-${id}`, payoutBatchId: "BATCH1", amountCents: 3000, status: "PENDING",
  receiverMasked: "a***", createdAt: new Date(), updatedAt: new Date(),
});

beforeEach(() => {
  seedBasics();
  refresh.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/payouts/[payoutId]/refresh", () => {
  it("needs no key, refreshes from PayPal and reports the payout and bounty status", async () => {
    tables.payout.push(payoutRow("pay-a"));
    refresh.mockImplementation(async () => {
      tables.bounty[0].status = "paid"; // what the real refresh does on SUCCESS
      return { payoutId: "pay-a", payoutBatchId: "BATCH1", status: "SUCCESS", replayed: false };
    });

    const response = await call("pay-a");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      payout: { payoutId: "pay-a", payoutBatchId: "BATCH1", status: "SUCCESS" },
      bountyStatus: "paid",
    });
    expect(refresh).toHaveBeenCalledWith("pay-a");
  });

  it("404 for an unknown payout, without calling PayPal", async () => {
    const response = await call("pay-missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "PAYOUT_NOT_FOUND", message: "Payout not found" } });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a second call within a couple of seconds returns the stored state instead of calling PayPal again", async () => {
    tables.payout.push(payoutRow("pay-b"));
    refresh.mockResolvedValue({ payoutId: "pay-b", payoutBatchId: "BATCH1", status: "PENDING", replayed: false });

    await call("pay-b");
    const second = await call("pay-b");

    expect(refresh).toHaveBeenCalledTimes(1);
    expect((await second.json()).payout).toEqual({ payoutId: "pay-b", payoutBatchId: "BATCH1", status: "PENDING" });
  });

  it("502 with PayPal's name when PayPal fails", async () => {
    tables.payout.push(payoutRow("pay-c"));
    refresh.mockRejectedValue(
      new PayPalError({ status: 503, name: "SERVICE_UNAVAILABLE", message: "later", debugId: "dbg", details: [] }),
    );

    const response = await call("pay-c");

    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatchObject({ code: "PAYPAL_ERROR", paypalName: "SERVICE_UNAVAILABLE" });
  });
});

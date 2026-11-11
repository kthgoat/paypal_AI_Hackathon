import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalError, approveBounty, rejectBounty } from "@/lib/approvals";
import { PayPalError } from "@/lib/paypal/client";
import { PayoutRefusedError } from "@/lib/paypal/payouts";

import { POST } from "./route";

vi.mock("@/lib/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/approvals")>()),
  approveBounty: vi.fn(),
  rejectBounty: vi.fn(),
}));

const KEY = "route-test-maintainer-key-0001";
const approve = vi.mocked(approveBounty);
const reject = vi.mocked(rejectBounty);

const DECISION = {
  id: "maintainer-approve-d1", bountyId: "b1", verdictId: "v1", outcome: "auto_pay" as const,
  ruleFired: "maintainer_approved", decidedBy: "maintainer" as const, createdAt: "2026-11-08T00:00:00.000Z",
};
const PAYOUT = { payoutId: "p1", payoutBatchId: "BATCH1", status: "PENDING", replayed: false };

function call(body: unknown, headers: Record<string, string> = { "x-maintainer-key": KEY }, rawBody?: string) {
  const request = new NextRequest("http://localhost/api/approvals/b1", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody ?? JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ bountyId: "b1" }) });
}

beforeEach(() => {
  vi.stubEnv("MAINTAINER_KEY", KEY);
  approve.mockReset();
  reject.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/approvals/[bountyId]: authentication", () => {
  it.each([
    ["no key", {}],
    ["a wrong key", { "x-maintainer-key": "definitely-not-the-key-000" }],
  ])("401 with %s, and nothing is approved", async (_name, headers) => {
    const response = await call({ action: "approve" }, headers);

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHORIZED");
    expect(approve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it("checks the key before looking at the body", async () => {
    const response = await call(null, {}, "this is not json");

    expect(response.status).toBe(401);
  });

  it("refuses everything when the server has no valid MAINTAINER_KEY", async () => {
    vi.stubEnv("MAINTAINER_KEY", "");

    const response = await call({ action: "approve" });

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("MAINTAINER_KEY_NOT_CONFIGURED");
    expect(approve).not.toHaveBeenCalled();
  });
});

describe("POST /api/approvals/[bountyId]: validation", () => {
  it.each([
    ["an unknown action", { action: "delete" }],
    ["no action", {}],
    ["an amount smuggled in", { action: "approve", amountUsd: 1 }],
    ["a receiver smuggled in", { action: "approve", receiver: "x@y.com" }],
    ["a note that is too long", { action: "approve", note: "x".repeat(501) }],
    ["a non-string note", { action: "approve", note: 5 }],
  ])("400 for %s", async (_name, body) => {
    const response = await call(body);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    expect(approve).not.toHaveBeenCalled();
  });

  it("400 for a body that is not JSON", async () => {
    const response = await call(null, undefined, "not json");

    expect(response.status).toBe(400);
  });
});

describe("POST /api/approvals/[bountyId]: actions", () => {
  it("approve returns { decision, payout } and passes the bounty id and note through", async () => {
    approve.mockResolvedValue({ decision: DECISION, payout: PAYOUT });

    const response = await call({ action: "approve", note: "looks good" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decision: DECISION, payout: PAYOUT });
    expect(approve).toHaveBeenCalledWith("b1", "looks good");
  });

  it("reject returns { decision }", async () => {
    const decision = { ...DECISION, outcome: "blocked" as const, ruleFired: "maintainer_rejected" };
    reject.mockResolvedValue({ decision });

    const response = await call({ action: "reject" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decision });
    expect(reject).toHaveBeenCalledWith("b1", undefined);
    expect(approve).not.toHaveBeenCalled();
  });
});

describe("POST /api/approvals/[bountyId]: errors use { error: { code, message } }", () => {
  it("409 for a bounty in the wrong state", async () => {
    approve.mockRejectedValue(new ApprovalError(409, "INVALID_BOUNTY_STATE", "Bounty is 'paid', not 'awaiting_approval'"));

    const response = await call({ action: "approve" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "INVALID_BOUNTY_STATE", message: "Bounty is 'paid', not 'awaiting_approval'" },
    });
  });

  it("409 with the rule when a hard block (e.g. paused) refuses the approval", async () => {
    approve.mockRejectedValue(new ApprovalError(409, "APPROVAL_BLOCKED", "Cannot approve: blocked by rule 'paused'", "paused"));

    const response = await call({ action: "approve" });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({ code: "APPROVAL_BLOCKED", rule: "paused" });
  });

  it("404 for an unknown bounty", async () => {
    approve.mockRejectedValue(new ApprovalError(404, "BOUNTY_NOT_FOUND", "Bounty not found"));

    expect((await call({ action: "approve" })).status).toBe(404);
  });

  it("409 with the reason when the payout step refuses", async () => {
    approve.mockRejectedValue(new PayoutRefusedError("PAUSED"));

    const response = await call({ action: "approve" });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({ code: "PAYOUT_REFUSED", rule: "PAUSED" });
  });

  it("502 with PayPal's name and debug id when PayPal rejects the payout, and no stack", async () => {
    approve.mockRejectedValue(
      new PayPalError({ status: 400, name: "INSUFFICIENT_FUNDS", message: "no money", debugId: "dbg1", details: [] }),
    );

    const response = await call({ action: "approve" });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toMatchObject({ code: "PAYPAL_ERROR", paypalName: "INSUFFICIENT_FUNDS", debugId: "dbg1" });
    expect(JSON.stringify(body)).not.toMatch(/stack| at /);
  });

  it("500 with a generic message for anything unexpected", async () => {
    approve.mockRejectedValue(new Error("SQLITE_BUSY secret detail"));

    const response = await call({ action: "approve" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "Unexpected error" } });
  });
});

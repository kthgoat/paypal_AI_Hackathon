import { describe, expect, it } from "vitest";
import { createDemoSnapshot } from "../fixtures/dashboard";
import { approvalBlocker, ledgerRows, summarize } from "./dashboard";

describe("dashboard spending", () => {
  it("counts only successful payouts in the snapshot month, using cents", () => {
    const data = createDemoSnapshot();
    const payout = data.payouts[0];
    data.payouts = [
      { ...payout, amountUsd: 0.1 },
      { ...payout, id: "second", amountUsd: 0.2 },
      { ...payout, id: "pending", amountUsd: 200, status: "PENDING" },
      { ...payout, id: "failed", amountUsd: 50, status: "FAILED" },
      {
        ...payout,
        id: "old",
        amountUsd: 100,
        updatedAt: "2026-10-31T23:00:00.000Z",
      },
    ];
    expect(summarize(data).spent).toBe(0.3);
    expect(summarize(data).budgetRemaining).toBe(499.7);
  });

  it("shows a budget overrun instead of concealing it at zero", () => {
    const data = createDemoSnapshot();
    data.settings.monthlyBudgetUsd = 20;
    expect(summarize(data).budgetRemaining).toBe(-10);
  });
});

describe("approval display safeguards", () => {
  it("holds failed CI, unverified merges, injection flags and paused payouts", () => {
    const row = ledgerRows(createDemoSnapshot())[1];
    expect(approvalBlocker(row, false)).toBeUndefined();
    expect(approvalBlocker(row, true)).toMatch(/paused/);
    expect(approvalBlocker({ ...row, verdict: undefined }, false)).toMatch(
      /Waiting/,
    );
    expect(
      approvalBlocker(
        { ...row, verdict: { ...row.verdict!, ciPassed: false } },
        false,
      ),
    ).toMatch(/CI/);
    expect(
      approvalBlocker(
        { ...row, verdict: { ...row.verdict!, mergedByMaintainer: false } },
        false,
      ),
    ).toMatch(/merge/);
    expect(approvalBlocker(ledgerRows(createDemoSnapshot())[2], false)).toMatch(
      /Flagged/,
    );
  });

  it("uses the latest verdict and decision rather than array position", () => {
    const data = createDemoSnapshot();
    data.verdicts.unshift({
      ...data.verdicts[1],
      id: "latest",
      createdAt: "2026-11-08T00:00:00.000Z",
      ciPassed: false,
    });
    data.decisions.unshift({
      ...data.decisions[1],
      id: "latest-decision",
      createdAt: "2026-11-08T00:00:00.000Z",
      outcome: "blocked",
    });
    const row = ledgerRows(data)[1];
    expect(row.verdict?.id).toBe("latest");
    expect(row.decision?.id).toBe("latest-decision");
    expect(approvalBlocker(row, false)).toMatch(/CI/);
  });

  it("holds an existing pending payout rather than allowing duplicate submission", () => {
    const data = createDemoSnapshot();
    const row = ledgerRows(data)[1];
    expect(
      approvalBlocker(
        { ...row, payout: { ...data.payouts[0], status: "PENDING" } },
        false,
      ),
    ).toMatch(/already exists/);
  });
});

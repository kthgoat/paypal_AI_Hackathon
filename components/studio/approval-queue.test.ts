import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDemoSnapshot } from "@/fixtures/dashboard";
import { ledgerRows } from "@/lib/dashboard";
import ApprovalQueue, { type ApprovalQueueProps } from "./approval-queue";

function buttons(overrides: Partial<ApprovalQueueProps> = {}) {
  const markup = renderToStaticMarkup(createElement(ApprovalQueue, {
    rows: [ledgerRows(createDemoSnapshot())[1]], paused: false,
    demo: false, busy: false, canAct: true,
    onApprove: () => {}, onReject: () => {}, onReview: () => {}, ...overrides,
  }));
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => ({
    text: match[2].replace(/<[^>]*>/g, ""), disabled: /disabled=/.test(match[1]),
  }));
}

describe("approval controls", () => {
  it("enables live approve and reject when a maintainer key is entered", () => {
    expect(buttons()).toEqual(expect.arrayContaining([
      { text: "Approve", disabled: false }, { text: "Reject", disabled: false },
    ]));
  });

  it("lets a maintainer reject flagged work while payouts are paused", () => {
    const result = buttons({ rows: [ledgerRows(createDemoSnapshot())[2]], paused: true });
    expect(result).toContainEqual({ text: "Reject", disabled: false });
    expect(result).toContainEqual({ text: "Held for review", disabled: true });
  });

  it.each([{ canAct: false }, { busy: true }])("disables mutations when locked: %j", (props) => {
    expect(buttons(props).filter((button) => button.text !== "Review verdict ").every((button) => button.disabled)).toBe(true);
  });

  it("prevents rejecting an already-approved payout still awaiting settlement", () => {
    const row = ledgerRows(createDemoSnapshot())[1];
    row.decision = { ...row.decision!, outcome: "auto_pay", decidedBy: "maintainer" };
    expect(buttons({ rows: [row] })).toContainEqual({ text: "Reject", disabled: true });
  });
});

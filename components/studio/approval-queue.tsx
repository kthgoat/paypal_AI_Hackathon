"use client";

import { ArrowUpRight, Check, ShieldAlert } from "lucide-react";
import { approvalBlocker, money, type LedgerRow } from "@/lib/dashboard";

export interface ApprovalQueueProps {
  rows: LedgerRow[];
  paused: boolean;
  demo: boolean;
  busy: boolean;
  canAct: boolean;
  onReject: (id: string) => void;
  onReview: (id: string) => void;
  onApprove: (id: string) => void;
}

export default function ApprovalQueue({
  rows,
  paused,
  demo,
  busy,
  canAct,
  onReject,
  onReview,
  onApprove,
}: ApprovalQueueProps) {
  const pending = rows.filter((row) => row.status === "awaiting_approval");
  if (!pending.length)
    return (
      <div className="bp-empty">
        <Check size={24} />
        <h3>All caught up</h3>
        <p>There are no bounties waiting for approval.</p>
      </div>
    );
  return (
    <div className="bp-approval-list">
      {pending.map((row) => {
        const flagged = Boolean(row.verdict?.injectionFlags.length);
        const blocker = approvalBlocker(row, paused);
        const reason = blocker ?? (!canAct ? "Enter your maintainer key to act." : undefined);
        return (
          <article
            className={`bp-approval-card ${flagged ? "is-flagged" : ""}`}
            key={row.id}
          >
            <div className="bp-approval-top">
              <span className={`bp-tag ${flagged ? "danger" : "warning"}`}>
                {flagged && <ShieldAlert size={13} />}
                {flagged ? "Security review" : "Approval required"}
              </span>
              <strong>{money(row.amount)}</strong>
            </div>
            <h3>{row.title}</h3>
            <p className="bp-muted">
              #{row.issue} · @{row.contributor}
            </p>
            <p className="bp-approval-summary">
              {row.verdict?.summary ?? "Waiting for reviewer results."}
            </p>
            <div className="bp-approval-bottom">
              <button
                className="bp-text-button"
                onClick={() => onReview(row.id)}
              >
                Review verdict <ArrowUpRight size={14} />
              </button>
              <button className="bp-button bp-button-white bp-button-small"
                disabled={busy || !canAct || !row.verdict || row.decision?.outcome !== "needs_approval"}
                onClick={() => onReject(row.id)}>Reject</button>
              <button className="bp-button bp-button-small"
                disabled={busy || !canAct || Boolean(blocker)}
                aria-describedby={reason ? `approval-reason-${row.id}` : undefined}
                title={reason} onClick={() => onApprove(row.id)}>
                {flagged ? "Held for review" : demo ? "Approve demo" : "Approve"}
                {!flagged && <Check size={14} />}
              </button>
            </div>
            {reason && <p id={`approval-reason-${row.id}`} className="bp-approval-reason">{reason}</p>}
          </article>
        );
      })}
    </div>
  );
}

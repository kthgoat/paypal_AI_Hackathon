"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  CircleDollarSign,
  Clock3,
  Code2,
  Download,
  ExternalLink,
  GitBranch,
  GitMerge,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  Menu,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldAlert,
  SlidersHorizontal,
  Table2,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { createDemoSnapshot } from "@/fixtures/dashboard";
import {
  approvalBlocker,
  ledgerRows,
  money,
  statusLabel,
  summarize,
  type DashboardSnapshot,
  type LedgerRow,
} from "@/lib/dashboard";
import ApprovalQueue from "./approval-queue";
import {
  connectMaintainer,
  decideBounty,
  describeSync,
  pausePayouts,
  processMergedPrs,
  readDashboard,
  refreshPayout,
} from "@/lib/dashboard-client";

const AnalyticsStudio = dynamic(() => import("./analytics-studio"), {
  ssr: false,
  loading: () => (
    <div className="bp-empty">
      <LoaderCircle className="bp-spin" />
      <p>Loading AG Studio…</p>
    </div>
  ),
});
type View =
  "overview" | "approvals" | "ledger" | "studio" | "audit" | "guardrails";
const views = [
  { id: "overview" as const, label: "Overview", icon: LayoutDashboard },
  { id: "approvals" as const, label: "Approval queue", icon: ListChecks },
  { id: "ledger" as const, label: "Bounty ledger", icon: Table2 },
  { id: "studio" as const, label: "AG Studio", icon: Table2 },
  { id: "audit" as const, label: "Audit log", icon: Activity },
  { id: "guardrails" as const, label: "Guardrails", icon: ShieldCheck },
];

export default function Dashboard() {
  const [data, setData] = useState<DashboardSnapshot>(createDemoSnapshot);
  const [demo, setDemo] = useState(true);
  const [view, setView] = useState<View>("overview");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [maintainerReady, setMaintainerReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const actionLock = useRef(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const rows = useMemo(() => ledgerRows(data), [data]);
  const metrics = useMemo(() => summarize(data), [data]);
  const selectedRow = rows.find((row) => row.id === selected);
  const selectView = (next: View) => {
    setView(next);
    setMobileMenu(false);
  };

  useEffect(() => {
    if (!selected) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.getElementById("bp-dialog-close")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
      if (event.key === "Tab") {
        const focusable = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".bp-dialog button:not(:disabled), .bp-dialog a[href]",
          ),
        );
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [selected]);

  useEffect(() => {
    if (!mobileMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileMenu(false);
        document.getElementById("bp-menu-toggle")?.focus();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileMenu]);

  async function loadLedger() {
    if (actionLock.current || loading) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const snapshot = await readDashboard();
      setData(snapshot);
      setDemo(false);
      setQuery("");
      setStatus("all");
      setSelected(null);
      try {
        await connectMaintainer();
        setMaintainerReady(true);
        setNotice("Connected to the local ledger. Maintainer controls are ready.");
      } catch (err) {
        setMaintainerReady(false);
        setError(err instanceof Error ? err.message : "Could not connect maintainer controls.");
        setNotice("Ledger connected. Maintainer controls are unavailable.");
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load the ledger.",
      );
    } finally {
      setLoading(false);
    }
  }

  function resetDemo() {
    if (actionLock.current || loading) return;
    setMaintainerReady(false);
    setData(createDemoSnapshot());
    setDemo(true);
    setQuery("");
    setStatus("all");
    setError("");
    setSelected(null);
    setNotice(
      "Sample data reset. Demo actions do not send payments or update your database.",
    );
  }

  async function approve(id: string) {
    const row = rows.find((item) => item.id === id);
    if (actionLock.current || !row || row.status !== "awaiting_approval") return;
    const blocker = approvalBlocker(row, data.settings.paused);
    if (blocker) {
      setError(blocker);
      return;
    }
    if (!demo) {
      await liveAction(
        () => decideBounty(id, "approve"),
        "Approval recorded. Check the payout status below; approval alone does not confirm payment.",
      );
      return;
    }
    const now = new Date().toISOString();
    setData((previous) => ({
      ...previous,
      bounties: previous.bounties.map((bounty) =>
        bounty.id === id ? { ...bounty, status: "in_review" } : bounty,
      ),
      decisions: [
        ...previous.decisions,
        {
          id: `demo-approval-${id}`,
          bountyId: id,
          verdictId: row.verdict!.id,
          outcome: "needs_approval",
          ruleFired:
            "Maintainer approved; awaiting backend payout processing (demo)",
          decidedBy: "maintainer",
          createdAt: now,
        },
      ],
      payouts: [
        ...previous.payouts,
        {
          id: `demo-pending-${id}`,
          bountyId: id,
          senderBatchId: `DEMO-${id}-${row.verdict!.prNumber}`,
          payoutBatchId: null,
          amountUsd: row.amount,
          status: "PENDING",
          receiverMasked: "Verified demo recipient",
          createdAt: now,
          updatedAt: now,
        },
      ],
    }));
    setNotice(
      `Demo approval recorded for ${money(row.amount)}. Payout is pending; no money was sent.`,
    );
    setSelected(null);
  }

  async function liveAction(action: () => Promise<unknown>, message: string) {
    if (actionLock.current || loading) return;
    if (!maintainerReady) {
      setError("Connect the ledger to enable maintainer controls.");
      return;
    }
    actionLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await connectMaintainer();
      await action();
      setNotice(message);
      try {
        setData(await readDashboard());
      } catch {
        setError("Action recorded, but the ledger could not reload. Refresh the ledger before continuing.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The action failed.");
      // reload after errors too: the server may have recorded a decision
      try { setData(await readDashboard()); } catch { /* keep the last snapshot */ }
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }

  async function reject(id: string) {
    const row = rows.find((item) => item.id === id);
    if (actionLock.current || !row || row.status !== "awaiting_approval" || row.decision?.outcome !== "needs_approval") return;
    if (!demo) {
      await liveAction(() => decideBounty(id, "reject"), "Bounty rejected. No payout was created.");
      return;
    }
    setData((previous) => ({
      ...previous,
      bounties: previous.bounties.map((bounty) => bounty.id === id ? { ...bounty, status: "rejected" } : bounty),
      decisions: [...previous.decisions, {
        id: `demo-reject-${id}`, bountyId: id, verdictId: row.verdict!.id,
        outcome: "blocked", ruleFired: "Maintainer rejected (demo)", decidedBy: "maintainer",
        createdAt: new Date().toISOString(),
      }],
    }));
    setNotice("Demo bounty rejected. No money was sent.");
  }

  async function togglePause() {
    const paused = !data.settings.paused;
    if (!demo) {
      await liveAction(() => pausePayouts(paused), paused ? "Payouts paused." : "Payouts resumed.");
      return;
    }
    setData((previous) => ({ ...previous, settings: { ...previous.settings, paused } }));
    setNotice(paused ? "Demo payouts paused." : "Demo payouts resumed.");
  }

  async function refreshPayments() {
    if (actionLock.current || loading || demo) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const unsettled = data.payouts.filter((payout) => ["PENDING", "UNCLAIMED", "ONHOLD"].includes(payout.status));
      const results = await Promise.allSettled(unsettled.map((payout) => refreshPayout(payout.id)));
      setData(await readDashboard());
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      setNotice("Payout statuses refreshed from PayPal.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh payout statuses.");
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }

  // Reviews and decides every merged PR that is waiting (and pays only what policy auto-approves),
  // so a demo never depends on webhook timing. Can take a while: the review is an AI call.
  async function syncMergedPrs() {
    if (actionLock.current || loading || demo) return;
    if (!maintainerReady) {
      setError("Connect the ledger to enable maintainer controls.");
      return;
    }
    actionLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await connectMaintainer();
      const { processed } = await processMergedPrs();
      setData(await readDashboard());
      setNotice(describeSync(processed));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sync merged PRs.");
      // reload after errors too: some events may have been processed before the failure
      try { setData(await readDashboard()); } catch { /* keep the last snapshot */ }
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }

  function exportLedger() {
    // block spreadsheet formulas in csv exports
    const cell = (value: string | number) =>
      `"${String(value)
        .replace(/^[=+@\-\t\r]/, "'$&")
        .replaceAll('"', '""')}"`;
    const csv = [
      ["Issue", "Bounty", "Contributor", "Amount USD", "Status", "Rule"],
      ...rows.map((row) => [
        `#${row.issue}`,
        row.title,
        row.contributor,
        row.amount,
        statusLabel(row.status),
        row.decision?.ruleFired ?? "",
      ]),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8;" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `bountypilot-${demo ? "demo" : "ledger"}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const filtered = rows.filter(
    (row) =>
      (status === "all" || row.status === status) &&
      `${row.title} ${row.contributor} ${row.repo} #${row.issue}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const approvalProps = {
    rows,
    paused: data.settings.paused,
    demo,
    busy: busy || loading,
    canAct: demo || maintainerReady,
    onReject: reject,
    onReview: setSelected,
    onApprove: approve,
  };
  const titles: Record<View, [string, string]> = {
    overview: [
      "Payout overview",
      "Project spending and payments awaiting review.",
    ],
    approvals: [
      "Approval queue",
      "Review the work and the reason each payment was held.",
    ],
    ledger: [
      "Bounty ledger",
      "Bounties, contributors, and payment status.",
    ],
    studio: [
      "Reports",
      "Edit tables and charts using the bounty ledger.",
    ],
    audit: [
      "Audit log",
      "Reviewer results and payment decisions.",
    ],
    guardrails: ["Guardrails", "Spending limits and payment requirements."],
  };

  return (
    <div className="bp-app">
      {mobileMenu && <button className="bp-nav-backdrop" aria-label="Close navigation"
        onClick={() => setMobileMenu(false)} />}
      <aside id="bp-sidebar" inert={Boolean(selectedRow)} className={`bp-sidebar ${mobileMenu ? "is-open" : ""}`}>
        <button className="bp-icon-button bp-nav-close" aria-label="Close navigation"
          onClick={() => setMobileMenu(false)}><X size={19} /></button>
        <Link href="/" className="bp-brand">
          <span className="bp-brand-mark">
            <GitBranch size={23} />
          </span>
          BountyPilot
        </Link>
        <div className="bp-workspace">
          <span className="bp-project-avatar">BP</span>
          <div>
            <strong>Demo project</strong>
            <small>Maintainer workspace</small>
          </div>
        </div>
        <div className="bp-nav-label">WORKSPACE</div>
        <nav aria-label="Dashboard navigation">
          {views.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`bp-nav-item ${view === id ? "active" : ""}`}
              aria-current={view === id ? "page" : undefined}
              onClick={() => selectView(id)}
            >
              <Icon size={18} />
              {label}
              {id === "approvals" && metrics.pendingCount > 0 && (
                <span className="bp-nav-count">{metrics.pendingCount}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="bp-sidebar-bottom">
          <div className="bp-profile">
            <span className="bp-profile-avatar">M</span>
            <div>
              <strong>Moe</strong>
              <small>Maintainer · demo profile</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="bp-shell" inert={Boolean(selectedRow)}>
        <header className="bp-topbar">
          <div className="bp-breadcrumb">
            <button
              className="bp-icon-button bp-menu-toggle"
              id="bp-menu-toggle"
              aria-label="Toggle navigation"
              aria-expanded={mobileMenu}
              aria-controls="bp-sidebar"
              onClick={() => setMobileMenu(!mobileMenu)}
            >
              <Menu size={19} />
            </button>
            <span>Workspace</span>
            <span>/</span>
            <strong>{views.find((item) => item.id === view)?.label}</strong>
          </div>
          <div className="bp-topbar-right">
            <span className="bp-environment">
              <span />
              PayPal sandbox
            </span>
            <a
              href="https://github.com/kthgoat/paypal_AI_Hackathon"
              target="_blank"
              rel="noreferrer"
              className="bp-icon-button"
              aria-label="Open project repository"
            >
              <Code2 size={19} />
            </a>
          </div>
        </header>
        <main className="bp-main">
          <div className="bp-page-heading">
            <div>
              <h1>{titles[view][0]}</h1>
              <p>{titles[view][1]}</p>
            </div>
            <button
              className="bp-button bp-button-white"
              onClick={exportLedger}
            >
              <Download size={15} />
              Export ledger
            </button>
          </div>
          <div className="bp-demo-banner">
            <div>
              <span className={`bp-tag ${demo ? "neutral" : "success"}`}>
                {demo ? "DEMO DATA" : "LOCAL LEDGER"}
              </span>
              <p>
                {demo
                  ? "Sample bounties. Approvals are simulated."
                  : "Project database · live controls"}
              </p>
            </div>
            <div className="bp-banner-actions">
              <button
                onClick={resetDemo}
                className="bp-text-button"
                disabled={loading || busy}
              >
                <RefreshCw size={13} />
                Reset demo
              </button>
              <button
                className="bp-text-button"
                onClick={loadLedger}
                disabled={loading || busy}
              >
                {loading ? (
                  <LoaderCircle size={13} className="bp-spin" />
                ) : (
                  <ArrowUpRight size={13} />
                )}
                {demo ? "Connect ledger" : "Refresh ledger"}
              </button>
            </div>
          </div>
          {!demo && (
            <div className="bp-maintainer-controls">
              <span className={`bp-tag ${maintainerReady ? "success" : "warning"}`}>
                {maintainerReady ? "Maintainer connected" : "Maintainer unavailable"}
              </span>
              <button className="bp-button bp-button-white" disabled={busy || loading}
                onClick={refreshPayments}><RefreshCw size={14} /> Check payout status</button>
              <button className="bp-button bp-button-white" disabled={busy || loading || !maintainerReady}
                onClick={syncMergedPrs}><GitMerge size={14} /> Sync merged PRs</button>
              <p>Approve sends a PayPal payout; reject creates no payout.</p>
            </div>
          )}
          {busy && <p role="status" className="bp-muted">Updating ledger…</p>}
          {notice && (
            <div role="status" className="bp-message">
              <Check size={16} />
              {notice}
              <button
                aria-label="Dismiss message"
                onClick={() => setNotice("")}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {error && (
            <div role="alert" className="bp-message bp-error">
              <ShieldAlert size={16} />
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={14} />
              </button>
            </div>
          )}
          {(view === "overview" || view === "ledger") && (
            <section className="bp-metrics" aria-label="Project totals">
              <Metric
                icon={Wallet}
                label="Paid this month"
                value={money(metrics.spent)}
                detail={`${metrics.paidCount} successful payout${metrics.paidCount === 1 ? "" : "s"} in ledger`}
                accent="green"
              />
              <Metric
                icon={Clock3}
                label="Awaiting approval"
                value={money(metrics.pendingAmount)}
                detail={`${metrics.pendingCount} bounties awaiting review`}
                accent="amber"
              />
              <Metric
                icon={CircleDollarSign}
                label="Budget remaining"
                value={money(metrics.budgetRemaining)}
                detail={`of ${money(data.settings.monthlyBudgetUsd)} monthly budget`}
                accent="blue"
              />
              <Metric
                icon={GitBranch}
                label="Active bounties"
                value={String(metrics.activeCount)}
                detail="Open, claimed, or in review"
                accent="purple"
              />
            </section>
          )}
          {view === "overview" && (
            <>
              <div className="bp-overview-row">
                <section className="bp-panel bp-budget-panel">
                  <div className="bp-section-heading">
                    <div>
                      <h2>Monthly budget</h2>
                      <p>
                        Monthly project budget ·{" "}
                        {new Date(data.asOf).toLocaleDateString("en-US", {
                          month: "long",
                          year: "numeric",
                          timeZone: "UTC",
                        })}
                      </p>
                    </div>
                    <span className="bp-tag neutral">USD</span>
                  </div>
                  <div className="bp-budget-value">
                    {money(metrics.spent)}{" "}
                    <span>/ {money(data.settings.monthlyBudgetUsd)}</span>
                  </div>
                  <div
                    className="bp-budget-track"
                    role="progressbar"
                    aria-label="Monthly budget spent"
                    aria-valuenow={metrics.spent}
                    aria-valuemin={0}
                    aria-valuemax={Math.max(
                      metrics.spent,
                      data.settings.monthlyBudgetUsd,
                    )}
                  >
                    <span
                      style={{
                        width: `${data.settings.monthlyBudgetUsd > 0 ? Math.min(100, (metrics.spent / data.settings.monthlyBudgetUsd) * 100) : 0}%`,
                      }}
                    />
                  </div>
                  <div className="bp-budget-legend">
                    <span>
                      <i />
                      Paid this month
                    </span>
                    <span>
                      <i />
                      Remaining budget
                    </span>
                  </div>
                  <div className="bp-budget-foot">
                    <ShieldCheck size={15} />
                    Auto-pay up to {money(data.settings.autoPayCapUsd)}. Larger
                    payouts require approval.
                  </div>
                </section>
                <section
                  className={`bp-control-card ${data.settings.paused ? "is-paused" : ""}`}
                >
                  <h2>
                    {data.settings.paused
                      ? "Payouts paused"
                      : "Payouts enabled"}
                  </h2>
                  <p>
                    {demo
                      ? "Pause to hold approvals. Resume when you’re ready to process payments."
                      : "Pause new payouts or resume them when you are ready."}
                  </p>
                  <button
                    className="bp-button bp-button-white"
                    disabled={busy || loading || (!demo && !maintainerReady)}
                    onClick={togglePause}
                  >
                    {data.settings.paused ? (
                      <Play size={14} />
                    ) : (
                      <Pause size={14} />
                    )}
                    {data.settings.paused
                      ? (demo ? "Resume demo payouts" : "Resume payouts")
                      : (demo ? "Pause demo payouts" : "Pause payouts")}
                  </button>
                  <div className="bp-control-state">
                    <span className={data.settings.paused ? "paused" : ""} />
                    {data.settings.paused
                      ? "New payouts on hold"
                      : "Policy checks required"}
                  </div>
                </section>
              </div>
            </>
          )}
          {(view === "overview" || view === "approvals") && (
            <section className="bp-approval-section">
              <div className="bp-section-heading">
                <div className="bp-inline-title">
                  <h2>Pending approvals</h2>
                  <span className="bp-count">{metrics.pendingCount}</span>
                </div>
                {view === "overview" && (
                  <button
                    className="bp-text-button"
                    onClick={() => selectView("approvals")}
                  >
                    View queue <ArrowRight size={14} />
                  </button>
                )}
              </div>
              <ApprovalQueue {...approvalProps} />
            </section>
          )}
          {(view === "overview" || view === "ledger") && (
            <section className="bp-panel bp-ledger-panel">
              <div className="bp-section-heading">
                <div>
                  <h2>Bounty ledger</h2>
                </div>
                <span className="bp-muted bp-small">
                  {rows.length} bounties
                </span>
              </div>
              <div className="bp-ledger-filters">
                <label className="bp-search">
                  <Search size={16} />
                  <input
                    aria-label="Search bounties"
                    placeholder="Search bounties or contributors…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <label className="bp-status-filter">
                  <SlidersHorizontal size={14} />
                  <select
                    aria-label="Filter bounty status"
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                  >
                    <option value="all">All statuses</option>
                    {Array.from(new Set(rows.map((row) => row.status))).map(
                      (value) => (
                        <option key={value} value={value}>
                          {statusLabel(value)}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              </div>
              <div className="bp-table-scroll">
                <table className="bp-table">
                  <thead>
                    <tr>
                      <th>Bounty</th>
                      <th>Contributor</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <button
                            className="bp-bounty-link"
                            onClick={() => setSelected(row.id)}
                          >
                            {row.title}
                          </button>
                          <small>
                            {row.repo} · #{row.issue}
                          </small>
                        </td>
                        <td>
                          <span className="bp-contributor">
                            <span
                              className={`bp-avatar avatar-${row.contributor.length % 3}`}
                            >
                              {row.contributor.slice(0, 2).toUpperCase()}
                            </span>
                            {row.contributor === "Unclaimed"
                              ? "Unclaimed"
                              : `@${row.contributor}`}
                          </span>
                        </td>
                        <td className="bp-amount">{money(row.amount)}</td>
                        <td>
                          <Status row={row} />
                        </td>
                        <td>
                          <button
                            className="bp-icon-button"
                            aria-label={`Review ${row.title}`}
                            onClick={() => setSelected(row.id)}
                          >
                            <ArrowUpRight size={17} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!filtered.length && (
                  <div className="bp-empty">
                    <Search size={24} />
                    <h3>No matching bounties</h3>
                    <p>Try another search or status.</p>
                    <button
                      className="bp-text-button"
                      onClick={() => {
                        setQuery("");
                        setStatus("all");
                      }}
                    >
                      Clear filters
                    </button>
                  </div>
                )}
              </div>
              <div className="bp-table-footer">
                <span>
                  {filtered.length} of {rows.length} bounties
                </span>
                <span>
                  <ShieldCheck size={13} />
                  Recipient emails stay private
                </span>
              </div>
            </section>
          )}
          {view === "studio" && (
            <>
              <div className="bp-studio-note">
                <div>
                  <strong>AG Studio</strong>
                  <p>
                    Add tables and charts, or edit the report below.
                  </p>
                </div>
              </div>
              <AnalyticsStudio data={data} approvalProps={approvalProps} />
            </>
          )}
          {view === "audit" && (
            <section className="bp-panel">
              <div className="bp-section-heading">
                <div>
                  <h2>Decision history</h2>
                    <p>What happened, which rule applied, and who approved it.</p>
                </div>
                <Activity size={18} />
              </div>
              {!data.decisions.length ? (
                <div className="bp-empty">
                  <Activity />
                  <h3>No decisions yet</h3>
                  <p>Reviewer and policy decisions will appear here.</p>
                </div>
              ) : (
                <div className="bp-audit-list">
                  {[...data.decisions]
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    .map((decision) => (
                      <article className="bp-audit-item" key={decision.id}>
                        <span
                          className={`bp-audit-icon ${decision.outcome === "auto_pay" ? "success" : "warning"}`}
                        >
                          {decision.outcome === "auto_pay" ? (
                            <CheckCheck size={18} />
                          ) : (
                            <ShieldAlert size={18} />
                          )}
                        </span>
                        <div>
                          <h3>
                            {data.bounties.find(
                              (bounty) => bounty.id === decision.bountyId,
                            )?.title ?? decision.bountyId}
                          </h3>
                          <p>{decision.ruleFired}</p>
                          <small>
                            {decision.decidedBy === "policy"
                              ? "Policy engine"
                              : "Maintainer"}{" "}
                            ·{" "}
                            {new Date(decision.createdAt).toLocaleString(
                              "en-SG",
                              { timeZone: "Asia/Singapore" },
                            )}{" "}
                            SGT
                          </small>
                        </div>
                        <button
                          className="bp-text-button"
                          onClick={() => setSelected(decision.bountyId)}
                        >
                          View verdict <ArrowUpRight size={14} />
                        </button>
                      </article>
                    ))}
                </div>
              )}
            </section>
          )}
          {view === "guardrails" && (
            <>
              <section className="bp-panel">
                <div className="bp-section-heading">
                  <div>
                    <h2>Your payout policy</h2>
                    <p>
                      Read from{" "}
                      {demo ? "sample settings" : "the project ledger"}. Changes
                      belong to the backend policy engine.
                    </p>
                  </div>
                  <ShieldCheck size={20} />
                </div>
                <div className="bp-policy-grid">
                  {[
                    [
                      "Auto-pay cap",
                      money(data.settings.autoPayCapUsd),
                      "Larger bounties need maintainer approval.",
                    ],
                    [
                      "Daily contributor cap",
                      money(data.settings.contributorDailyCapUsd),
                      "Limits daily spending per contributor.",
                    ],
                    [
                      "Monthly project budget",
                      money(data.settings.monthlyBudgetUsd),
                      "Payments over budget must wait.",
                    ],
                    [
                      "Payout status",
                      data.settings.paused ? "Paused" : "Active",
                      "Pausing prevents new payouts; submitted payouts can still settle.",
                    ],
                  ].map(([label, value, description]) => (
                    <div className="bp-policy-item" key={label}>
                      <span>{label}</span>
                      <strong>{value}</strong>
                      <p>{description}</p>
                    </div>
                  ))}
                </div>
              </section>
              <div className="bp-principles">
                {[
                  [
                    GitBranch,
                    "Verified work first",
                    "A maintainer merges the linked PR into the default branch and all required CI checks pass.",
                  ],
                  [
                    ShieldAlert,
                    "Untrusted text stays untrusted",
                    "Flagged PR instructions hold the payment for investigation; they cannot override policy.",
                  ],
                  [
                    Users,
                    "Registered recipients only",
                    "Pay only the contributor’s claimed PayPal address, never an email found in a PR.",
                  ],
                  [
                    BookOpen,
                    "Decision records",
                    "Verdicts and policy rules are recorded. A pending payout is never counted as paid.",
                  ],
                ].map(([Icon, title, description]) => {
                  const I = Icon as typeof ShieldCheck;
                  return (
                    <article
                      className="bp-panel bp-principle"
                      key={String(title)}
                    >
                      <I size={21} />
                      <h3>{String(title)}</h3>
                      <p>{String(description)}</p>
                    </article>
                  );
                })}
              </div>
            </>
          )}
          <footer className="bp-footer">
            <span>
              <GitBranch size={13} />
              BountyPilot
            </span>
            <span>Powered by PayPal sandbox & AG Studio</span>
          </footer>
        </main>
      </div>
      {selectedRow && (
        <div
          className="bp-modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setSelected(null);
          }}
        >
          <section
            className="bp-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bp-dialog-title"
          >
            <div className="bp-dialog-header">
              <span className="bp-eyebrow">
                BOUNTY REVIEW · #{selectedRow.issue}
              </span>
              <button
                id="bp-dialog-close"
                className="bp-icon-button"
                aria-label="Close review"
                onClick={() => setSelected(null)}
              >
                <X size={19} />
              </button>
            </div>
            {busy && <p role="status" className="bp-muted bp-small">Updating ledger…</p>}
            {error && <div role="alert" className="bp-message bp-error">{error}</div>}
            {notice && <div role="status" className="bp-message">{notice}</div>}
            <h2 id="bp-dialog-title">{selectedRow.title}</h2>
            <div className="bp-dialog-meta">
              <Status row={selectedRow} />
              <strong>{money(selectedRow.amount)}</strong>
              <span>@{selectedRow.contributor}</span>
            </div>
            <h3>Acceptance criteria</h3>
            <p className="bp-criteria">
              {
                data.bounties.find((bounty) => bounty.id === selectedRow.id)
                  ?.criteria
              }
            </p>
            <h3>Reviewer verdict</h3>
            <p>
              {selectedRow.verdict?.summary ??
                "This bounty has not been reviewed yet."}
            </p>
            {selectedRow.verdict && (
              <>
                <div className="bp-verdict-checks">
                  <span
                    className={selectedRow.verdict.ciPassed ? "good" : "bad"}
                  >
                    {selectedRow.verdict.ciPassed ? (
                      <Check size={14} />
                    ) : (
                      <X size={14} />
                    )}
                    CI {selectedRow.verdict.ciPassed ? "passed" : "failed"}
                  </span>
                  <span
                    className={
                      selectedRow.verdict.mergedByMaintainer ? "good" : "bad"
                    }
                  >
                    {selectedRow.verdict.mergedByMaintainer ? (
                      <Check size={14} />
                    ) : (
                      <X size={14} />
                    )}
                    Maintainer merge{" "}
                    {selectedRow.verdict.mergedByMaintainer
                      ? "verified"
                      : "unverified"}
                  </span>
                  <span>
                    {Math.round(selectedRow.verdict.confidence * 100)}%
                    confidence
                  </span>
                </div>
                <p className="bp-muted bp-small">
                  Criteria{" "}
                  {selectedRow.verdict.meetsCriteria ? "met" : "not met"} ·{" "}
                  {selectedRow.verdict.model}
                </p>
                {selectedRow.verdict.unmetCriteria.length > 0 && (
                  <ul className="bp-unmet">
                    {selectedRow.verdict.unmetCriteria.map((criterion) => (
                      <li key={criterion}>{criterion}</li>
                    ))}
                  </ul>
                )}
                {selectedRow.verdict.injectionFlags.length > 0 && (
                  <div className="bp-injection">
                    <ShieldAlert size={18} />
                    <div>
                      <strong>Prompt-injection attempt flagged</strong>
                      {selectedRow.verdict.injectionFlags.map((flag) => (
                        <p key={flag}>{flag}</p>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
            {selectedRow.decision && (
              <>
                <h3>Policy decision</h3>
                <p>{selectedRow.decision.ruleFired}</p>
              </>
            )}
            {selectedRow.payout && (
              <div className="bp-payout-receipt">
                <ArrowDownLeft size={18} />
                <div>
                  <strong>Payout: {selectedRow.payout.status}</strong>
                  <p>
                    {selectedRow.payout.receiverMasked} ·{" "}
                    {selectedRow.payout.payoutBatchId ??
                      "Awaiting payout batch"}
                  </p>
                </div>
              </div>
            )}
            <div className="bp-dialog-actions">
              {selectedRow.verdict && !demo && (
                <a
                  className="bp-text-button"
                  href={selectedRow.verdict.prUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  View pull request <ExternalLink size={14} />
                </a>
              )}
              {selectedRow.status === "awaiting_approval" && (
                <button className="bp-button bp-button-white"
                  disabled={busy || loading || (!demo && !maintainerReady) || !selectedRow.verdict || selectedRow.decision?.outcome !== "needs_approval"}
                  onClick={() => reject(selectedRow.id)}>Reject</button>
              )}
              {selectedRow.status === "awaiting_approval" && (
                <button
                  className="bp-button"
                  disabled={
                    busy || loading || (!demo && !maintainerReady) ||
                    Boolean(approvalBlocker(selectedRow, data.settings.paused))
                  }
                  onClick={() => approve(selectedRow.id)}
                >
                  {demo ? "Approve demo payout" : `Approve ${money(selectedRow.amount)}`} <ArrowRight size={14} />
                </button>
              )}
            </div>
            {selectedRow.status === "awaiting_approval" && (
              <p className="bp-muted bp-small">
                {approvalBlocker(selectedRow, data.settings.paused) ??
                  (demo ? "Demo approval queues a simulated payout. No money is sent." :
                    !maintainerReady ? "Reconnect the ledger to enable maintainer controls." : "Approval sends a payout. Check payout status to confirm payment.")}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
  accent,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  detail: string;
  accent: string;
}) {
  return (
    <article className="bp-metric">
      <div className="bp-metric-top">
        <span>{label}</span>
        <span className={`bp-metric-icon ${accent}`}>
          <Icon size={17} />
        </span>
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function Status({ row }: { row: LedgerRow }) {
  const flagged = Boolean(row.verdict?.injectionFlags.length);
  return (
    <span
      className={`bp-tag ${row.status === "paid" ? "success" : row.payout?.status === "PENDING" ? "blue" : flagged ? "danger" : row.status === "awaiting_approval" ? "warning" : "neutral"}`}
    >
      <span className="bp-status-dot" />
      {row.payout?.status === "PENDING"
        ? "Payout pending"
        : flagged && row.status === "awaiting_approval"
          ? "Held for review"
          : statusLabel(row.status)}
    </span>
  );
}

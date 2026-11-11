import type { DashboardSnapshot } from "./dashboard";

export async function dashboardRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body?.error;
    throw new Error(
      (typeof error === "string" ? error : error?.message) ??
        `Request failed (${response.status}).`,
    );
  }
  return body as T;
}

export const readDashboard = () => dashboardRequest<DashboardSnapshot>("/api/dashboard");

export function decideBounty(id: string, action: "approve" | "reject") {
  return dashboardRequest(`/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

export function pausePayouts(paused: boolean) {
  return dashboardRequest("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paused }),
  });
}

export function refreshPayout(id: string) {
  return dashboardRequest(`/api/payouts/${encodeURIComponent(id)}/refresh`, { method: "POST" });
}

export interface SyncedEvent {
  deliveryId: string;
  status: string;
  reason?: string;
}

/** Processes every merged-PR event that is waiting (the maintainer session satisfies the key check). */
export function processMergedPrs() {
  return dashboardRequest<{ processed: SyncedEvent[] }>("/api/github/process", { method: "POST" });
}

const SYNC_LABELS: Record<string, string> = {
  done: "done",
  skipped: "skipped",
  waiting_ci: "waiting for CI",
  failed: "failed",
  busy: "already being processed",
};

/** "Processed 2 merged PR events: 1 done, 1 waiting for CI." */
export function describeSync(processed: Pick<SyncedEvent, "status">[]): string {
  if (processed.length === 0) return "No merged PRs are waiting to be processed.";
  const counts = new Map<string, number>();
  for (const { status } of processed) counts.set(status, (counts.get(status) ?? 0) + 1);
  const parts = [...counts].map(([status, n]) => `${n} ${SYNC_LABELS[status] ?? status}`);
  return `Processed ${processed.length} merged PR ${processed.length === 1 ? "event" : "events"}: ${parts.join(", ")}.`;
}

export function connectMaintainer() {
  return dashboardRequest<{ connected: boolean }>("/api/maintainer/session", { method: "POST" });
}

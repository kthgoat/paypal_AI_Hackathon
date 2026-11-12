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

export interface SyncResponse {
  /** New merged-PR events found on GitHub by this call. */
  discovered?: number;
  /** Set when GitHub could not be checked; existing events were still processed. */
  discoveryError?: string;
  processed: SyncedEvent[];
}

/** Finds new merged PRs on GitHub, then processes every merged-PR event that is waiting (the maintainer session satisfies the key check). */
export function processMergedPrs() {
  return dashboardRequest<SyncResponse>("/api/github/process", { method: "POST" });
}

const SYNC_LABELS: Record<string, string> = {
  done: "done",
  skipped: "skipped",
  waiting_ci: "waiting for CI",
  failed: "failed",
  busy: "already being processed",
};

/**
 * "Found 1 new merged PR. Processed 1 merged PR event: 1 done."
 * Pass the response's `discovered` / `discoveryError` to include the GitHub check in the message.
 */
export function describeSync(
  processed: Pick<SyncedEvent, "status">[],
  discovery?: Pick<SyncResponse, "discovered" | "discoveryError">,
): string {
  const sentences: string[] = [];
  const discovered = discovery?.discovered ?? 0;

  if (discovery?.discoveryError) sentences.push(`Could not check GitHub for merged PRs (${discovery.discoveryError}).`);
  if (discovered > 0) sentences.push(`Found ${discovered} new merged ${discovered === 1 ? "PR" : "PRs"}.`);

  if (processed.length > 0) {
    const counts = new Map<string, number>();
    for (const { status } of processed) counts.set(status, (counts.get(status) ?? 0) + 1);
    const parts = [...counts].map(([status, n]) => `${n} ${SYNC_LABELS[status] ?? status}`);
    sentences.push(`Processed ${processed.length} merged PR ${processed.length === 1 ? "event" : "events"}: ${parts.join(", ")}.`);
  } else if (discovery?.discoveryError) {
    sentences.push("No events were waiting to be processed.");
  } else if (discovery) {
    sentences.push("No new merged PRs found for open bounties, and none are waiting to be processed.");
  } else {
    sentences.push("No merged PRs are waiting to be processed.");
  }
  return sentences.join(" ");
}

export function connectMaintainer() {
  return dashboardRequest<{ connected: boolean }>("/api/maintainer/session", { method: "POST" });
}

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

export function decideBounty(id: string, action: "approve" | "reject", key: string) {
  return dashboardRequest(`/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-maintainer-key": key },
    body: JSON.stringify({ action }),
  });
}

export function pausePayouts(paused: boolean, key: string) {
  return dashboardRequest("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-maintainer-key": key },
    body: JSON.stringify({ paused }),
  });
}

export function refreshPayout(id: string) {
  return dashboardRequest(`/api/payouts/${encodeURIComponent(id)}/refresh`, { method: "POST" });
}

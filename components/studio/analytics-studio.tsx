"use client";

import { createContext, useContext, useMemo } from "react";
import {
  AgStudio,
  createWidgets,
  type AgWidgetDefinition,
} from "ag-studio-react";
import {
  AgStudioLicenseManager,
  studioTheme,
  type AgDefaultRegistry,
  type AgDefaultWidgetDefinition,
  type AgReportState,
  type AgWidgetDataFormat,
} from "ag-studio";
import {
  ledgerRows,
  statusLabel,
  type DashboardSnapshot,
} from "@/lib/dashboard";
import ApprovalQueue, { type ApprovalQueueProps } from "./approval-queue";

const license = process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY;
if (license) AgStudioLicenseManager.setLicenseKey(license);

const ApprovalContext = createContext<ApprovalQueueProps | null>(null);

function ApprovalWidget() {
  const props = useContext(ApprovalContext);
  return props ? (
    <div className="bp-studio-approval">
      <ApprovalQueue {...props} />
    </div>
  ) : null;
}

interface ApprovalState {
  type: "bounty-approvals";
  dataMapping: Record<string, never>;
  format?: AgWidgetDataFormat<unknown>;
}
type ApprovalDefinition = AgWidgetDefinition<"bounty-approvals", ApprovalState>;
interface BountyRegistry extends Omit<AgDefaultRegistry, "widgets"> {
  widgets: readonly (AgDefaultWidgetDefinition | ApprovalDefinition)[];
}

const widgets = createWidgets<BountyRegistry>({
  additionalTypes: [
    {
      id: "bounty-approvals",
      label: "Bounty approval queue",
      comp: ApprovalWidget,
      dataMapping: {},
      defaultSize: { width: 420, height: 480 },
      minSize: { width: 300, height: 220 },
      form: (params) => params.createDefaults({ dataMappingItems: [] }),
      ai: {
        description:
          "Maintainer approval queue. Shows verdicts and policy holds; never executes a payment itself.",
      },
    },
  ],
  menu: [
    { label: "BountyPilot", widgetIds: ["bounty-approvals"] },
    {
      label: "Explore",
      widgetIds: [
        "grid",
        "bar-chart-grouped",
        "value",
        "line-chart",
        "donut-chart",
      ],
    },
  ],
});

const initialState: AgReportState<BountyRegistry> = {
  selectedPageId: "overview",
  pages: [
    {
      id: "overview",
      layout: {
        minWidth: 320,
        height: 780,
        backgroundColor: "#f6f8fa",
        widgetPadding: 12,
      },
      widgets: {
        ledger: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "bounties.title" },
              { id: "bounties.contributor" },
              { id: "bounties.amount" },
              { id: "bounties.status" },
            ],
          },
          format: { title: { text: "Bounty ledger", enabled: true } },
        },
        contributors: {
          type: "bar-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: "bounties.contributor" }],
            valueKey: [{ id: "bounties.paid", aggregation: "sum" }],
          },
          format: {
            title: { text: "Paid per contributor (USD)", enabled: true },
          },
        },
        approvals: {
          type: "bounty-approvals",
          dataMapping: {},
          format: { title: { text: "Approval queue", enabled: true } },
        },
      },
      widgetLayout: {
        ledger: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 18 },
        contributors: { xTrack: 0, yTrack: 18, xSpan: 12, ySpan: 26 },
        approvals: { xTrack: 12, yTrack: 18, xSpan: 12, ySpan: 26 },
      },
    },
  ],
  panels: { data: { collapsed: true }, filters: { collapsed: true } },
};

const theme = studioTheme.withParams({
  accentColor: "#53697e",
  backgroundColor: "#ffffff",
  textColor: "#24292f",
  borderColor: "#dfe3e8",
  fontFamily: "Arial, sans-serif",
  fontSize: 13,
  studioCanvasBackgroundColor: "#f6f8fa",
  studioWidgetTitleFontSize: 14,
  studioWidgetTitleTextColor: "#24292f",
  studioWidgetBorder: { width: 1, color: "#dfe3e8" },
});

export default function AnalyticsStudio({
  data,
  approvalProps,
}: {
  data: DashboardSnapshot;
  approvalProps: ApprovalQueueProps;
}) {
  const sources = useMemo(
    () => ({
      sources: [
        {
          id: "bounties",
          data: ledgerRows(data).map((row) => ({
            title: row.title,
            contributor: row.contributor,
            amount: row.amount,
            status:
              row.verdict?.injectionFlags.length &&
              row.status === "awaiting_approval"
                ? "Held for review"
                : row.payout?.status === "PENDING"
                  ? "Payout pending"
                  : statusLabel(row.status),
            paid:
              data.payouts
                .filter(
                  (payout) =>
                    payout.bountyId === row.id && payout.status === "SUCCESS",
                )
                .reduce(
                  (sum, payout) => sum + Math.round(payout.amountUsd * 100),
                  0,
                ) / 100,
            rule: row.decision?.ruleFired ?? "Not reviewed",
            repo: row.repo,
            issue: row.issue,
          })),
        },
      ],
    }),
    [data],
  );
  return (
    <ApprovalContext.Provider value={approvalProps}>
      <div className="bp-studio-wrap">
        <AgStudio<BountyRegistry>
          style={{ height: "100%", width: "100%" }}
          data={sources}
          widgets={widgets}
          initialState={initialState}
          theme={theme}
          mode="edit"
          loadThemeGoogleFonts={false}
        />
      </div>
    </ApprovalContext.Provider>
  );
}

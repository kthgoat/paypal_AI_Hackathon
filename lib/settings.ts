// Payout settings (caps, budget, kill switch). The database stores cents; the API speaks dollars.

import { z } from "zod";

import { prisma, toSettings, usdToCents } from "./db";
import type { Settings } from "./types";

/** The largest amount a maintainer can set for a cap or budget. */
export const MAX_SETTING_USD = 10_000;

const hasAtMostTwoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

const dollars = z
  .number()
  .positive()
  .max(MAX_SETTING_USD)
  .refine(hasAtMostTwoDecimals, "must have at most 2 decimal places");

/** PATCH body: any subset of the settings, at least one, and nothing else. */
export const settingsPatchSchema = z
  .strictObject({
    autoPayCapUsd: dollars.optional(),
    contributorDailyCapUsd: dollars.optional(),
    monthlyBudgetUsd: dollars.optional(),
    paused: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, "Provide at least one setting to change");

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export async function readSettings(): Promise<Settings | null> {
  const row = await prisma.settings.findUnique({ where: { id: "default" } });
  return row ? toSettings(row) : null;
}

/** Applies a validated patch. Returns the new settings, or null if the settings row is missing. */
export async function updateSettings(patch: SettingsPatch): Promise<Settings | null> {
  const data = {
    ...(patch.autoPayCapUsd !== undefined && { autoPayCapCents: usdToCents(patch.autoPayCapUsd) }),
    ...(patch.contributorDailyCapUsd !== undefined && {
      contributorDailyCapCents: usdToCents(patch.contributorDailyCapUsd),
    }),
    ...(patch.monthlyBudgetUsd !== undefined && { monthlyBudgetCents: usdToCents(patch.monthlyBudgetUsd) }),
    ...(patch.paused !== undefined && { paused: patch.paused }),
  };
  const { count } = await prisma.settings.updateMany({ where: { id: "default" }, data });
  return count === 0 ? null : readSettings();
}

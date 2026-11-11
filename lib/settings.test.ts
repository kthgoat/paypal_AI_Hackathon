import { beforeEach, describe, expect, it, vi } from "vitest";

import { readSettings, settingsPatchSchema, updateSettings } from "./settings";
import { seedBasics, tables } from "./testing/fake-db";

vi.mock("./db", async (importOriginal) => {
  const { fakePrisma } = await import("./testing/fake-db");
  return { ...(await importOriginal<typeof import("./db")>()), prisma: fakePrisma };
});

beforeEach(() => seedBasics());

describe("settingsPatchSchema", () => {
  it.each([
    [{ paused: true }],
    [{ paused: false }],
    [{ autoPayCapUsd: 75 }],
    [{ autoPayCapUsd: 0.01 }],
    [{ monthlyBudgetUsd: 10_000 }], // the maximum is allowed
    [{ contributorDailyCapUsd: 19.99 }],
    [{ autoPayCapUsd: 0.1 + 0.2 }], // float noise is not a third decimal
    [{ autoPayCapUsd: 50, contributorDailyCapUsd: 100, monthlyBudgetUsd: 500, paused: false }],
  ])("accepts %j", (body) => {
    expect(settingsPatchSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    { why: "an empty patch", body: {} },
    { why: "zero", body: { autoPayCapUsd: 0 } },
    { why: "a negative amount", body: { autoPayCapUsd: -5 } },
    { why: "more than the maximum", body: { monthlyBudgetUsd: 10_000.01 } },
    { why: "a huge amount", body: { contributorDailyCapUsd: 1e9 } },
    { why: "three decimal places", body: { autoPayCapUsd: 10.123 } },
    { why: "a string amount", body: { autoPayCapUsd: "50" } },
    { why: "null", body: { autoPayCapUsd: null } },
    { why: "NaN", body: { autoPayCapUsd: Number.NaN } },
    { why: "Infinity", body: { autoPayCapUsd: Number.POSITIVE_INFINITY } },
    { why: "a non-boolean paused", body: { paused: "yes" } },
    { why: "an unknown field", body: { paused: true, amountUsd: 5 } },
    { why: "an attempt to set the row id", body: { id: "other" } },
  ])("rejects $why", ({ body }) => {
    expect(settingsPatchSchema.safeParse(body).success).toBe(false);
  });
});

describe("readSettings / updateSettings", () => {
  it("reads settings in dollars", async () => {
    expect(await readSettings()).toEqual({
      autoPayCapUsd: 50, contributorDailyCapUsd: 100, monthlyBudgetUsd: 500, paused: false,
    });
  });

  it("stores dollars as integer cents and changes only the fields given", async () => {
    const updated = await updateSettings({ autoPayCapUsd: 75.5, paused: true });

    expect(updated).toEqual({ autoPayCapUsd: 75.5, contributorDailyCapUsd: 100, monthlyBudgetUsd: 500, paused: true });
    expect(tables.settings[0]).toMatchObject({
      autoPayCapCents: 7550, contributorDailyCapCents: 10000, monthlyBudgetCents: 50000, paused: true,
    });
  });

  it("rounds float noise to whole cents", async () => {
    await updateSettings({ monthlyBudgetUsd: 0.1 + 0.2 });

    expect(tables.settings[0].monthlyBudgetCents).toBe(30);
  });

  it("returns null when the settings row does not exist", async () => {
    tables.settings = [];

    expect(await updateSettings({ paused: true })).toBeNull();
    expect(await readSettings()).toBeNull();
  });
});

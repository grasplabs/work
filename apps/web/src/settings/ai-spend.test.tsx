// @vitest-environment happy-dom
import type { ModelMonthSpend } from "@grasp-os/shared/models";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { SpendCard } from "./ai-spend.tsx";

// Settings › AI and spend, its Spend card, on what core's `models.spend()`
// answers: the month's days are the company's own (`2025-10-31`), so the
// first can be the last of the month before (a company behind UTC) and the
// last the first of the month after (one ahead of it). What the chart says
// is read from its table, the numbers a screen reader gets.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** The month `month` as core counts it, with these days, all of it chat. */
const monthOf = (
  month: string,
  days: { date: string; amount: number }[]
): ModelMonthSpend => {
  const total = days.reduce((sum, day) => sum + day.amount, 0);
  return { month, total, days, chat: total, workflows: [], more: false };
};

/** The Spend card on `spend`, as the page draws it. */
const shown = async (spend: ModelMonthSpend): Promise<void> => {
  const rootRoute = createRootRoute({
    component: () => (
      <SpendCard
        settings={{
          state: "ready",
          data: {
            models: [],
            month: spend.month,
            bindings: { listed: [], more: false },
          },
        }}
        spend={{ state: "ready", data: spend }}
      />
    ),
  });
  // Connected to core, which the card reads nothing more from itself.
  const core = { connected: true, onConnected: () => () => {} };
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory(),
    context: { core },
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
};

/** The chart's days, as its table names them. */
const chartDays = (): string[] =>
  [...document.querySelectorAll("table")]
    .filter(
      (table) =>
        table.caption?.textContent === "Spend so far this month, day by day"
    )
    .flatMap((table) => [...table.querySelectorAll("tbody tr")])
    .map((row) => row.querySelector("th")?.textContent ?? "");

/** What React warned about while the card was drawn. */
const warned = (): string[] => {
  const said: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    said.push(args.map(String).join(" "));
  });
  return said;
};

describe("Settings › AI and spend, Spend", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("says nothing was spent, with no chart, before any spend", async () => {
    await shown(monthOf("2026-11", []));
    expect(document.body.textContent).toContain("Spent this month$0.00");
    expect(chartDays()).toStrictEqual([]);
  });

  it("charts a single day by its day and month", async () => {
    await shown(monthOf("2026-11", [{ date: "2026-11-01", amount: 2 }]));
    expect(chartDays()).toStrictEqual(["Nov 1"]);
  });

  it("names the last day of the month before where the company is behind UTC", async () => {
    // New York, November 2025: its first day starts on the 31st of October.
    await shown(
      monthOf("2025-11", [
        { date: "2025-10-31", amount: 0.25 },
        { date: "2025-11-01", amount: 1 },
        { date: "2025-11-02", amount: 0 },
      ])
    );
    expect(chartDays()).toStrictEqual(["Oct 31", "Nov 1", "Nov 2"]);
  });

  it("tells the 1st of the month after from the month's own 1st where the company is ahead of UTC", async () => {
    const said = warned();
    // Amsterdam, the last evening of March 2025: 32 days, the last the 1st
    // of April.
    const march = Array.from({ length: 31 }, (_, index) => ({
      date: `2025-03-${String(index + 1).padStart(2, "0")}`,
      amount: 1,
    }));
    await shown(
      monthOf("2025-03", [...march, { date: "2025-04-01", amount: 0.5 }])
    );
    const days = chartDays();
    expect(days).toHaveLength(32);
    expect(new Set(days).size).toBe(32);
    expect(days[0]).toBe("Mar 1");
    expect(days.slice(-2)).toStrictEqual(["Mar 31", "Apr 1"]);
    expect(said.filter((each) => each.includes("same key"))).toStrictEqual([]);
  });

  it("keeps each day on its own date wherever the reader is", async () => {
    const zone = process.env.TZ;
    // West of UTC, a date read as a moment would fall on the day before.
    process.env.TZ = "America/Los_Angeles";
    try {
      await shown(monthOf("2026-11", [{ date: "2026-11-01", amount: 2 }]));
      expect(chartDays()).toStrictEqual(["Nov 1"]);
    } finally {
      if (zone === undefined) {
        Reflect.deleteProperty(process.env, "TZ");
      } else {
        process.env.TZ = zone;
      }
    }
  });

  it("says the spend can't be read when its days come in another form", async () => {
    // Days as plain amounts, the form before they carried their dates, as
    // an older core would answer.
    const spend = { ...monthOf("2026-11", []), total: 1.5 };
    Reflect.set(spend, "days", [0.5, 1]);
    await shown(spend);
    expect(chartDays()).toStrictEqual([]);
    expect(document.body.textContent).toContain(
      "This month's spend came in a form this page can't read."
    );
  });
});

// @vitest-environment happy-dom
import type {
  ModelBindingSpend,
  ModelMonthSpend,
} from "@grasp-os/shared/models";
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

/** The Spend card on `spend`, and these Apps' model bindings, as the page draws it. */
const shown = async (
  spend: ModelMonthSpend,
  bindings: ModelBindingSpend[] = []
): Promise<void> => {
  const rootRoute = createRootRoute({
    component: () => (
      <SpendCard
        settings={{
          state: "ready",
          data: {
            models: [],
            month: spend.month,
            bindings: { listed: bindings, more: false },
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

/** The card taken away, and the page emptied for the next one. */
const closed = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
};

/** Where it went, row by row: each row's name, and its amount as written. */
const barRows = (): string[] =>
  [...document.querySelectorAll("[data-slot=chart-bar-list] li")].map(
    (row) =>
      `${row.children[0]?.textContent ?? ""}: ${row.children[1]?.textContent ?? ""}`
  );

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
    closed();
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

  it("names each row of where it went apart: an App's bindings by alias and model, and workflows of one name by their ID", async () => {
    const said = warned();
    const spend: ModelMonthSpend = {
      month: "2026-11",
      total: 10,
      days: [{ date: "2026-11-01", amount: 10 }],
      chat: 1,
      workflows: [
        {
          appId: null,
          appName: null,
          workflowId: "report-a",
          name: "Weekly report",
          amount: 2,
          runs: 3,
        },
        {
          appId: null,
          appName: null,
          workflowId: "report-b",
          name: "Weekly report",
          amount: 1.5,
          runs: 3,
        },
      ],
      more: false,
    };
    await shown(spend, [
      {
        appId: "desk",
        appName: "Support desk",
        alias: "triage",
        model: "mistral/mistral-large-latest",
        thisMonth: 2.5,
      },
      {
        appId: "desk",
        appName: "Support desk",
        alias: "reply",
        model: "anthropic/claude-sonnet-4-6",
        thisMonth: 1.25,
      },
      {
        appId: "chat-app",
        appName: "Chat",
        alias: "answer",
        model: null,
        thisMonth: 0.75,
      },
    ]);
    expect(barRows()).toStrictEqual([
      "Support desk (triage, mistral/mistral-large-latest): $2.50",
      "Weekly report (3 runs), ID report-a: $2.00",
      "Weekly report (3 runs), ID report-b: $1.50",
      "Support desk (reply, anthropic/claude-sonnet-4-6): $1.25",
      "Chat: $1.00",
      "Other: $1.00",
      "Chat (answer): $0.75",
    ]);
    expect(said.filter((each) => each.includes("same key"))).toStrictEqual([]);
  });

  it("writes amounts under a cent as they are, in every language", async () => {
    const tiny = {
      ...monthOf("2026-11", [
        { date: "2026-11-01", amount: 0.0004 },
        { date: "2026-11-02", amount: 0.0008 },
      ]),
    };
    const written: Record<string, string> = {};
    await shown(tiny);
    // The month's figure, and where it ends, too: never "$0.00".
    expect(document.body.textContent).toMatch(
      /Spent this month\$0\.0012(?<ending>About \$0\.\d+ by the end of the month)?/u
    );
    closed();
    for (const locale of ["en", "de", "nl", "fr", "es"]) {
      i18n.loadAndActivate({ locale, messages: {} });
      try {
        // oxlint-disable-next-line no-await-in-loop -- one card at a time
        await shown(tiny);
        // Each language's own space before or after the sign, read as one.
        written[locale] = (barRows()[0] ?? "").replaceAll(/\s/gu, " ");
      } finally {
        closed();
        i18n.loadAndActivate({ locale: "en", messages: {} });
      }
    }
    expect(written).toStrictEqual({
      en: "Chat: $0.0012",
      de: "Chat: 0,0012 $",
      nl: "Chat: US$ 0,0012",
      fr: "Chat: 0,0012 $US",
      es: "Chat: 0,0012 US$",
    });
  });

  it("says which month it counts: the UTC month", async () => {
    await shown(monthOf("2026-11", [{ date: "2026-11-01", amount: 2 }]));
    expect(document.body.textContent).toContain(
      "Counted over November 2026 in UTC, in US dollars, as the models are priced."
    );
  });
});

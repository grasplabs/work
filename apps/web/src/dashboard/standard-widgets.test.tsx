import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { formatEuro } from "../format.ts";
import { returnTotals } from "./returns.ts";
import type { GoalProgress, TeamProgress, WorkflowReturn } from "./returns.ts";
import {
  GoalListView,
  ReturnChartView,
  TeamListView,
} from "./standard-widgets.tsx";
import { WidgetFull } from "./widget-block.tsx";

// The return, goals and teams widgets with work in them, on the board and
// in full, before core fills them: the totals they add up, a return that
// is negative (the model costs more than the hours it took), and a
// workflow with hours by hand but no return yet, and one whose hours aren't
// known, which these widgets leave out.

/** A router for the widgets' links to their workflows: none of its routes is shown. */
const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory(),
});

const row = (
  name: string,
  fields: Partial<WorkflowReturn> & Pick<WorkflowReturn, "stage" | "basis">
): WorkflowReturn => ({
  workflow: { app: "invoices", name, teamId: "finance", goalId: "close" },
  hoursBefore: null,
  hoursAfter: null,
  before: null,
  after: null,
  back: null,
  cut: null,
  ...fields,
});

const live = row("Match invoices", {
  stage: "live",
  basis: "measured",
  hoursBefore: 20,
  hoursAfter: 5,
  before: 4000,
  after: 1000,
  back: 3000,
  cut: 0.75,
});
const testing = row("Chase payments", {
  stage: "testing",
  basis: "expected",
  before: 2000,
  after: 800,
  back: 1200,
});
const unknown = row("File receipts", { stage: "check", basis: "unknown" });
const drawn = row("Draft replies", {
  stage: "check",
  basis: "observed",
  before: 1000,
});
const costly = row("Translate letters", {
  stage: "live",
  basis: "measured",
  before: 500,
  after: 700,
  back: -200,
});
const rows = [live, testing, unknown, drawn, costly];

const goal: GoalProgress = {
  id: "close",
  title: "Close the month in a day",
  rows: [live, testing],
  live: 1,
  back: 3000,
  coming: 1200,
};

const team = (
  fields: Partial<TeamProgress> & Pick<TeamProgress, "id" | "name">
): TeamProgress => ({
  level: "notStarted",
  workflows: 0,
  mapped: 0,
  redesign: 0,
  testing: 0,
  live: 0,
  share: null,
  cost: 0,
  measured: 0,
  expected: 0,
  handled: 0,
  alone: 0,
  needsHelp: false,
  ...fields,
});
const teams = [
  team({
    id: "finance",
    name: "Finance",
    level: "live",
    workflows: 4,
    mapped: 1,
    testing: 1,
    live: 2,
    share: 0.5,
    cost: 6500,
    measured: 2800,
    expected: 1200,
    handled: 120,
    alone: 96,
  }),
  team({ id: "legal", name: "Legal", needsHelp: true }),
];

/** The widget's text as a person reads it, on the board or in full. */
const textOf = (widget: ReactNode, full = false): string =>
  renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <RouterContextProvider router={router}>
        <WidgetFull value={full}>{widget}</WidgetFull>
      </RouterContextProvider>
    </I18nProvider>
  )
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/gu, " ")
    .trim();

describe("the return widget", () => {
  it("adds up what is live, what is coming and what the known hours cost by hand", () => {
    expect(returnTotals(rows)).toStrictEqual({
      back: 2800,
      liveCount: 2,
      coming: 1200,
      comingCount: 1,
      byHand: 7500,
    });
  });

  it("shows the measured and expected returns on the board", () => {
    const text = textOf(<ReturnChartView rows={rows} />);
    expect(text).toContain(formatEuro(2800));
    expect(text).toContain(formatEuro(1200));
  });

  it("lists the counted workflows in full: a negative return as it is, none yet as a dash, no hours left out", () => {
    const text = textOf(<ReturnChartView rows={rows} />, true);
    expect(text).toContain("Match invoices");
    expect(text).toContain(formatEuro(-200));
    expect(text).toMatch(/Draft replies €1,000 — —/u);
    expect(text).not.toContain("File receipts");
  });
});

describe("the goals widget", () => {
  it("shows a goal and what its workflows bring back, on the board and in full", () => {
    const board = textOf(<GoalListView goals={[goal]} />);
    const full = textOf(<GoalListView goals={[goal]} />, true);
    expect(board).toContain("Close the month in a day");
    expect(full).toContain("Close the month in a day");
    expect(full).toContain("Match invoices");
  });
});

describe("the teams widget", () => {
  it("shows each team, one far along and one not started, on the board and in full", () => {
    const board = textOf(<TeamListView rows={rows} teams={teams} />);
    const full = textOf(<TeamListView rows={rows} teams={teams} />, true);
    expect(board).toContain("Finance");
    expect(board).toContain("Legal");
    expect(full).toContain("Finance");
    expect(full).toContain("Legal");
  });
});

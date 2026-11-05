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
import type { GoalProgress, WorkflowReturn } from "./returns.ts";
import { GoalListView, ReturnChartView } from "./standard-widgets.tsx";
import { WidgetFull } from "./widget-block.tsx";

// The return and goals widgets with work in them, on the board and
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
  workflow: { id: `wf-${name}`, name, goalId: "close" },
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

/** The widget's markup, on the board or in full. */
const markupOf = (widget: ReactNode, full = false): string =>
  renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <RouterContextProvider router={router}>
        <WidgetFull value={full}>{widget}</WidgetFull>
      </RouterContextProvider>
    </I18nProvider>
  );

/** A link in markup, and where it goes. */
const linkHref = /<a [^>]*href="(?<href>[^"]*)"/gu;

/** Where the widget's links go, in order. */
const linksOf = (widget: ReactNode, full = false): string[] =>
  [...markupOf(widget, full).matchAll(linkHref)].map(
    ({ groups }) => groups?.href ?? ""
  );

/** The widget's text as a person reads it, on the board or in full. */
const textOf = (widget: ReactNode, full = false): string =>
  markupOf(widget, full)
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
    expect(linksOf(<ReturnChartView rows={[live]} />, true)).toStrictEqual([
      "/workflows/wf-Match%20invoices",
    ]);
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

  it("links each of a goal's workflows in full to its page, by its ID", () => {
    expect(linksOf(<GoalListView goals={[goal]} />, true)).toStrictEqual([
      "/workflows/wf-Match%20invoices",
      "/workflows/wf-Chase%20payments",
    ]);
  });
});

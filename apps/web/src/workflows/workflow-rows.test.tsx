// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { OverviewRow, TriggersByWorkflow } from "./overview.ts";
import { WorkflowRows } from "./workflow-rows.tsx";

// The Workflows page's table: a row a workflow, what needs the reader
// first, each saying how it stands now, whose it is, how its last 7 days
// went, when it last ran and what starts it next, and opening the workflow
// within Grasp.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const row = (name: string, change: Partial<OverviewRow>): OverviewRow => ({
  id: `wf-${name.toLowerCase()}`,
  name,
  phase: "running",
  paused: false,
  blocked: null,
  role: null,
  process: null,
  owner: "Ada Lovelace",
  runs: 12,
  version: 3,
  waiting: 0,
  failed: 0,
  lastRun: "2026-11-20T09:00:00.000Z",
  ...change,
});

const rows = [
  row("Complaints", { phase: "needsYou", failed: 2 }),
  row("Refunds", { phase: "needsYou", waiting: 1, role: "user", runs: 3 }),
  row("Archive", {}),
  row("Expenses", { paused: true, owner: "Grace Hopper" }),
  row("Intake", {
    phase: "building",
    blocked: { kind: "email", why: "waiting" },
  }),
  row("Billing", {
    phase: "building",
    owner: null,
    runs: null,
    version: null,
    lastRun: null,
  }),
  row("Ledger", { runs: null, lastRun: null }),
  row("Claims", {
    phase: "building",
    blocked: { kind: "schedule", why: "refused" },
  }),
  row("Payroll", {}),
];

const triggers: TriggersByWorkflow = new Map([
  [
    "wf-archive",
    [
      { kind: "webhook", address: null, nextAt: null, blocked: "waiting" },
      { kind: "email", address: "archive", nextAt: null, blocked: null },
      { kind: "email", address: "returns", nextAt: null, blocked: null },
    ],
  ],
  [
    "wf-claims",
    [
      {
        kind: "schedule",
        address: null,
        nextAt: "2030-01-07T08:00:00.000Z",
        blocked: "refused",
      },
    ],
  ],
  ["wf-expenses", []],
  [
    "wf-intake",
    [{ kind: "email", address: null, nextAt: null, blocked: "waiting" }],
  ],
  ["wf-ledger", []],
  [
    "wf-payroll",
    [
      {
        kind: "schedule",
        address: null,
        nextAt: "2031-03-03T08:00:00.000Z",
        blocked: null,
      },
      {
        kind: "schedule",
        address: null,
        nextAt: "2030-02-04T08:00:00.000Z",
        blocked: null,
      },
    ],
  ],
]);

let root: Root | undefined;

/** The table, as the Workflows page shows it to an admin or not; where the router stands is returned. */
const shown = async ({ admin = false }: { admin?: boolean } = {}) => {
  const rootRoute = createRootRoute();
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <WorkflowRows admin={admin} builds rows={rows} triggers={triggers} />
    ),
  });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflow",
    component: () => "A workflow's page",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, page]),
    history: createMemoryHistory(),
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
  return router;
};

/** The table's row of the workflow called `name`, cell by cell. */
const cellsOf = (name: string): string[] => {
  const found = [...document.querySelectorAll("tbody tr")].find(
    (each) => each.querySelector("th")?.textContent === name
  );
  if (found === undefined) {
    throw new TypeError(`No row for ${name}`);
  }
  return [...found.querySelectorAll("th, td")].map(
    (cell) => cell.textContent ?? ""
  );
};

describe("the Workflows page's table", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("heads its columns and lists the workflows in the order given, each opening its page", async () => {
    await shown();

    expect(
      [...document.querySelectorAll("thead th")].map((each) => each.textContent)
    ).toStrictEqual([
      "Workflow",
      "Now",
      "Owner",
      "Last 7 days",
      "Last run",
      "Next",
    ]);
    expect(
      [...document.querySelectorAll("tbody th a")].map((link) =>
        link.getAttribute("href")
      )
    ).toStrictEqual(rows.map(({ id }) => `/workflows/${id}`));
  });

  it("says how each workflow stands now, and what it asks of the reader", async () => {
    await shown();

    expect(rows.map(({ name }) => cellsOf(name)[1])).toStrictEqual([
      "Needs a fix",
      "Needs you1 waiting for a decision",
      "On",
      "Paused",
      "Waiting for an admin to allow its email trigger",
      "Not live yet",
      "On, not used yet",
      "Its trigger can't start it",
      "On",
    ]);
  });

  it("gives each workflow's owner, its last 7 days with what failed, and its last run", async () => {
    await shown();

    expect(cellsOf("Complaints").slice(2, 4)).toStrictEqual([
      "Ada Lovelace",
      "12 done · 2 failed",
    ]);
    expect(cellsOf("Refunds")[3]).toBe("3 of yours done");
    expect(cellsOf("Billing").slice(2, 5)).toStrictEqual([
      "",
      "0 done",
      "No runs yet",
    ]);
  });

  it("says what starts each workflow next", async () => {
    await shown();

    expect(rows.map(({ name }) => cellsOf(name)[5])).toStrictEqual([
      "",
      "",
      "On each email to archive, and 1 more",
      "When resumed",
      "When an admin allows it",
      "",
      "By hand",
      "",
      expect.stringMatching(/2030.*, and 1 more$/u),
    ]);
  });

  it("tells an admin a trigger waiting for one starts when they allow it", async () => {
    await shown({ admin: true });

    expect(cellsOf("Intake")[5]).toBe("When you allow it");
  });

  it("stacks each workflow as a card with the same facts", async () => {
    await shown();
    const card = [
      ...document.querySelectorAll('[aria-label="Workflows"] a'),
    ].find(
      (each) =>
        each.closest("table") === null &&
        each.textContent?.startsWith("Complaints")
    );

    expect(card?.getAttribute("href")).toBe("/workflows/wf-complaints");
    expect(card?.textContent).toContain("Needs a fix");
    expect(card?.textContent).toContain("Owner Ada Lovelace");
    expect(card?.textContent).toContain("Last 7 days 12 done · 2 failed");
  });

  it("opens a workflow from its row, within Grasp", async () => {
    const router = await shown();

    await act(async () => {
      document
        .querySelector<HTMLAnchorElement>(
          'tbody th a[href="/workflows/wf-archive"]'
        )
        ?.click();
      await Promise.resolve();
    });

    expect(router.state.location.pathname).toBe("/workflows/wf-archive");
    expect(document.body.textContent).toContain("A workflow's page");
  });
});

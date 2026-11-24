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

import type {
  OverviewRow,
  ToolsByWorkflow,
  TriggersByWorkflow,
} from "./overview.ts";
import { WorkflowRows } from "./workflow-rows.tsx";

// The Workflows page's rows: the workflows stand under their phases, each
// phase counted; a row says how the workflow stands, whose it is, what
// starts it, the tools it works in and how its week went, and opens the
// workflow within Grasp.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const row = (name: string, change: Partial<OverviewRow>): OverviewRow => ({
  id: `wf-${name.toLowerCase()}`,
  name,
  phase: "running",
  paused: false,
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
  row("Refunds", { phase: "needsYou", waiting: 1 }),
  row("Archive", {}),
  row("Expenses", { paused: true, owner: "Grace Hopper" }),
  row("Billing", {
    phase: "building",
    owner: null,
    runs: null,
    version: null,
    lastRun: null,
  }),
];

const tools: ToolsByWorkflow = new Map([
  [
    "wf-archive",
    [
      { name: "Microsoft 365", brand: "microsoft" },
      { name: "Acme CRM", brand: undefined },
    ],
  ],
]);

const triggers: TriggersByWorkflow = new Map([
  [
    "wf-archive",
    [
      { kind: "email", address: "archive", nextAt: null },
      { kind: "schedule", address: null, nextAt: "2026-11-23T08:00:00.000Z" },
    ],
  ],
  ["wf-expenses", []],
]);

let root: Root | undefined;

/** The rows, as the Workflows page shows them; where the router stands is returned. */
const shown = async ({ unread = false }: { unread?: boolean } = {}) => {
  const rootRoute = createRootRoute();
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <WorkflowRows
        rows={rows}
        tools={tools}
        triggers={unread ? undefined : triggers}
      />
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

/** The link that opens the workflow called `name`: its name, on its row. */
const linkOf = (name: string): HTMLAnchorElement => {
  const found = [...document.querySelectorAll("a")].find(
    (each) => each.textContent === name
  );
  if (found === undefined) {
    throw new TypeError(`No row for ${name}`);
  }
  return found;
};

/** The row of the workflow called `name`: all it says, around its link. */
const rowOf = (name: string): HTMLElement => {
  const found = linkOf(name).closest<HTMLElement>("[data-slot=item]");
  if (found === null) {
    throw new TypeError(`No row around ${name}`);
  }
  return found;
};

describe("the Workflows page's rows", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("gathers the workflows under their phases, each counted, what needs the reader first", async () => {
    await shown();
    const groups = [...document.querySelectorAll("section, [role=region]")]
      .filter((each) => each.querySelector("a") !== null)
      .map((group) => ({
        heading: group.querySelector("h2")?.textContent,
        workflows: [...group.querySelectorAll("a")].map(
          (link) => link.getAttribute("href") ?? ""
        ),
      }));

    expect(groups).toStrictEqual([
      {
        heading: "Needs you",
        workflows: ["/workflows/wf-complaints", "/workflows/wf-refunds"],
      },
      {
        heading: "Running",
        workflows: ["/workflows/wf-archive", "/workflows/wf-expenses"],
      },
      { heading: "Building", workflows: ["/workflows/wf-billing"] },
    ]);
  });

  it("says how each workflow stands, in words beside its mark", async () => {
    await shown();

    expect(rowOf("Complaints").textContent).toContain("2 failed");
    expect(rowOf("Refunds").textContent).toContain("1 waiting");
    expect(rowOf("Archive").textContent).toContain("Ada Lovelace · v3 · Live");
  });

  it("says a paused workflow is paused, and one with no version is not live yet", async () => {
    await shown();

    expect(rowOf("Expenses").textContent).toContain("Paused");
    expect(rowOf("Billing").textContent).toContain("Not live yet");
  });

  it("draws a workflow's route: what starts it, then the tools it works in, then its week", async () => {
    await shown();
    const archive = rowOf("Archive");

    expect(archive.textContent).toContain("Mail to archive, and 1 more");
    expect(
      archive
        .querySelector('[data-slot="brand-icon-group"]')
        ?.getAttribute("aria-label")
    ).toBe("Microsoft 365 and Acme CRM");
    // Microsoft's own mark, and Acme CRM's first letter: it has none.
    expect(
      [...archive.querySelectorAll('[data-slot="brand-icon"]')].map((tile) =>
        tile.querySelector("svg") === null ? tile.textContent : "mark"
      )
    ).toStrictEqual(["mark", "A"]);
    expect(archive.textContent).toContain("12 this week");
  });

  it("says a workflow nothing starts is started by hand, and one that never ran has no runs yet", async () => {
    await shown();

    expect(rowOf("Expenses").textContent).toContain("By hand");
    expect(rowOf("Billing").textContent).toContain("No runs yet");
  });

  it("says nothing of what starts a workflow until that is read", async () => {
    await shown({ unread: true });

    expect(rowOf("Expenses").textContent).not.toContain("By hand");
  });

  it("opens a workflow from its row, within Grasp", async () => {
    const router = await shown();

    await act(async () => {
      linkOf("Archive").click();
      await Promise.resolve();
    });

    expect(router.state.location.pathname).toBe("/workflows/wf-archive");
    expect(document.body.textContent).toContain("A workflow's page");
  });
});

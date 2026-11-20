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

import type { OverviewRow, ToolsByWorkflow } from "./overview.ts";
import { WorkflowsByPhase } from "./workflows-table.tsx";

// The Workflows page's table: the workflows stand under their phases, each
// phase counted; a row says whose the workflow is, the tools it reaches
// and its runs this week, and opens the workflow within Grasp.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** A window `narrow` says is a phone's or not. */
const windowIs = (narrow: boolean): void => {
  Reflect.set(window, "matchMedia", (query: string) => ({
    matches: narrow && query.includes("width <"),
    media: query,
    onchange: null,
    addEventListener: () => {
      // Nothing changes during a test.
    },
    removeEventListener: () => {
      // Nothing to stop.
    },
    dispatchEvent: () => false,
  }));
};

const row = (name: string, change: Partial<OverviewRow>): OverviewRow => ({
  id: `wf-${name.toLowerCase()}`,
  name,
  phase: "running",
  paused: false,
  process: null,
  owner: "Ada Lovelace",
  runs: 12,
  ...change,
});

const rows = [
  row("Complaints", { phase: "needsYou" }),
  row("Archive", {}),
  row("Expenses", { paused: true, owner: "Grace Hopper" }),
  row("Billing", { phase: "toBuild", owner: null, runs: null }),
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

let root: Root | undefined;

/** The table of `rows`, as the Workflows page shows it; where the router stands is returned. */
const shown = async (given: { narrow?: boolean } = {}) => {
  windowIs(given.narrow === true);
  const rootRoute = createRootRoute();
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <WorkflowsByPhase rows={rows} tools={tools} />,
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

/** The row of the workflow called `name`. */
const rowOf = (name: string): HTMLTableRowElement => {
  const found = [...document.querySelectorAll("tbody tr")].find(
    (each) => each.querySelector("a")?.textContent?.startsWith(name) === true
  );
  if (!(found instanceof HTMLTableRowElement)) {
    throw new TypeError(`No row for ${name}`);
  }
  return found;
};

describe("the Workflows page's table", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("gathers the workflows under their phases, each counted, what needs the reader first", async () => {
    await shown();
    const lines = [...document.querySelectorAll("tbody tr")].map((line) => {
      const heading = line.querySelector('[data-slot="data-table-group"]');
      return heading === null
        ? `- ${line.querySelector("a")?.textContent}`
        : heading.textContent;
    });

    expect(lines).toStrictEqual([
      "Needs you1, needs attention",
      "- Complaints",
      "Running2",
      "- Archive",
      "- ExpensesPaused",
      "To build1",
      "- Billing",
    ]);
  });

  it("says whose a workflow is, the tools it reaches and its runs this week", async () => {
    await shown();
    const archive = rowOf("Archive");

    expect(archive.textContent).toContain("Ada Lovelace");
    expect(
      archive
        .querySelector('[data-slot="brand-icon-group"]')
        ?.getAttribute("aria-label")
    ).toBe("Microsoft and Acme CRM");
    expect(archive.lastElementChild?.textContent).toBe("12");
  });

  it("leaves empty what core doesn't say: no owner, no tools, no runs yet", async () => {
    await shown();
    const cells = [...rowOf("Billing").querySelectorAll("th, td")].map(
      (cell) => cell.textContent
    );

    expect(cells).toStrictEqual(["Billing", "", "", ""]);
  });

  it("shows the owner's face alone on a phone, still named", async () => {
    await shown({ narrow: true });
    const archive = rowOf("Archive");

    expect(archive.textContent).not.toContain("Ada Lovelace");
    expect(archive.querySelector('[aria-label="Ada Lovelace"]')).not.toBeNull();
  });

  it("opens a workflow from its row, within Grasp", async () => {
    const router = await shown();
    const link = rowOf("Archive").querySelector("a");

    expect(link?.getAttribute("href")).toBe("/workflows/wf-archive");

    await act(async () => {
      link?.click();
      await Promise.resolve();
    });

    expect(router.state.location.pathname).toBe("/workflows/wf-archive");
    expect(document.body.textContent).toContain("A workflow's page");
  });
});

// @vitest-environment happy-dom
import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { ResourceWorkflowSummary } from "@grasp-os/shared/workflows";
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

import { WorkflowsTable } from "./workflows-table.tsx";

// The Workflows page's table: each count of a workflow's runs links to
// them, on the Runs tab of the page that lists them.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const independent: ResourceWorkflowSummary = {
  type: "resource",
  workflowId: workflowResourceIdSchema.parse("wf-1"),
  name: "Intake",
  version: 1,
  owner: { userId: "u1", name: "Ada" },
  lastRun: null,
  waiting: 2,
  failed: 1,
  handled: 0,
};

let root: Root | undefined;

/** The table of `rows`, as the Workflows page shows it. */
const shown = async (rows: ResourceWorkflowSummary[]): Promise<void> => {
  const rootRoute = createRootRoute();
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <WorkflowsTable rows={rows} />,
  });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflow",
    validateSearch: (search: Record<string, unknown>) =>
      search.tab === "runs" ? { tab: "runs" as const } : {},
  });
  const core = {
    withSession: async (): Promise<never> => {
      await Promise.resolve();
      throw new Error("Nothing is changed in this test");
    },
  };
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, page]),
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

describe("the Workflows page's table", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("links an independent workflow's waiting and failed runs to its page's Runs tab", async () => {
    await shown([independent]);
    const links = [...document.querySelectorAll("a")]
      .filter((link) => /waiting|failed/u.test(link.textContent ?? ""))
      .map((link) => link.getAttribute("href"));

    expect(links).toStrictEqual([
      "/workflows/wf-1?tab=runs",
      "/workflows/wf-1?tab=runs",
    ]);
  });
});

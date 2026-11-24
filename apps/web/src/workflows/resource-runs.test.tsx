// @vitest-environment happy-dom
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ResourceRuns } from "./resource-runs.tsx";

// A workflow's runs with the run the address names (`?run=`): one core
// lists for the reader opens once, beside the list where the page is
// wide, in a sheet where it is narrow, never first in one then the other;
// one it doesn't list (no such run, another workflow's, another person's,
// or past the runs listed) opens nothing, says so in one sentence and
// leaves the address. Core's workflowResources are the boundary, faked.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Lets every reply already on its way arrive. */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await Promise.resolve();
  }
};

const done: WorkflowResourceRun = {
  id: "run-1",
  workflowId: "workflow-1",
  version: 1,
  manifestHash: "manifest",
  buildHash: "build",
  principal: "ada",
  status: "completed",
  createdAt: "2026-10-30T09:00:00.000Z",
  endedAt: "2026-10-30T09:01:00.000Z",
};

/** The page `width` wide, as a browser measures its boxes. */
const pageWidth = (width: number): void => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ width, height: 600 })
  );
};

/** The runs, `asked` named by the address: how often core read a run, and closes asked. */
const shown = async (asked: string) => {
  const reads: string[] = [];
  let closes = 0;
  const workflowResources = {
    run: async (_workflow: string, id: string) => {
      await Promise.resolve();
      reads.push(id);
      return done;
    },
    get: async () => await Promise.resolve({ role: "user" }),
    runFiles: async () => await Promise.resolve(null),
  };
  const core = {
    withSession: async <T,>(
      action: (session: {
        workflowResources: typeof workflowResources;
      }) => Promise<T>
    ): Promise<T> => await action({ workflowResources }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <ResourceRuns
        admin={false}
        names={{ people: new Map(), me: "ada" }}
        onCloseRun={() => {
          closes += 1;
        }}
        openRun={asked}
        runs={[done]}
        workflow="workflow-1"
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory(),
    context: { core },
  });
  await act(async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
  await act(async () => {
    await settled();
  });
  return { reads, closes: () => closes };
};

const panel = (): Element | null =>
  document.querySelector(
    '[aria-label^="The run started"]:not([role="dialog"])'
  );

const notFound = "That run wasn't found, or isn't yours to see.";

describe("a workflow's runs, with a run named by the address", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("opens a listed run once, in a sheet on a phone, never beside the list first", async () => {
    pageWidth(390);
    const { reads } = await shown("run-1");

    expect({
      reads,
      inSheet: panel()?.closest('[role="dialog"]') !== null,
    }).toStrictEqual({ reads: ["run-1"], inSheet: true });
  });

  it("opens a listed run once, beside the list on a wide page", async () => {
    pageWidth(1200);
    const { reads } = await shown("run-1");

    expect({
      reads,
      beside: panel() !== null && panel()?.closest('[role="dialog"]') === null,
    }).toStrictEqual({ reads: ["run-1"], beside: true });
  });

  it("opens nothing, beside or in a sheet, while its list isn't shown", async () => {
    pageWidth(0);
    const { reads } = await shown("run-1");

    expect({
      reads,
      panel: panel(),
      dialog: document.querySelector('[role="dialog"]'),
    }).toStrictEqual({ reads: [], panel: null, dialog: null });
  });

  it("says a run it doesn't list wasn't found or isn't theirs, reads nothing and leaves the address", async () => {
    pageWidth(1200);
    const { reads, closes } = await shown("run-of-someone-else");

    expect({
      reads,
      closes: closes(),
      panel: panel(),
      said: document.body.textContent.includes(notFound),
    }).toStrictEqual({ reads: [], closes: 1, panel: null, said: true });
  });
});

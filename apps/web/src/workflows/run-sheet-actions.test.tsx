// @vitest-environment happy-dom
import type { RunFileListing } from "@grasp-os/shared/run-files";
import type {
  WorkflowResourceRun,
  WorkflowRole,
} from "@grasp-os/shared/workflow-resources";
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
import { afterEach, describe, expect, it } from "vite-plus/test";

import { RunSheet } from "./run-detail.tsx";

// What a reader can do with a run opened beside the page, against core's
// workflowResources as the page reaches them over RPC, faked: a builder
// stops a run that hasn't ended, after being asked, and only that run; a
// user is offered nothing to stop; the run's finished files link to
// core's download route, and nothing is shown where core lists none.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Lets every reply already on its way arrive. */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await Promise.resolve();
  }
};

const running: WorkflowResourceRun = {
  id: "run-1",
  workflowId: "workflow-1",
  version: 2,
  manifestHash: "manifest",
  buildHash: "build",
  principal: "ada",
  status: "running",
  createdAt: "2026-10-30T09:00:00.000Z",
  endedAt: null,
};

/** Run `running` opened for a reader with `role`, core listing `files`: what core was asked to stop. */
const opened = async (role: WorkflowRole, files: RunFileListing[] | null) => {
  let current = running;
  const stopped: { workflow: string; run: string }[] = [];
  const workflowResources = {
    run: async () => await Promise.resolve(current),
    get: async () => await Promise.resolve({ role }),
    runFiles: async () => await Promise.resolve(files),
    terminateRun: async (workflow: string, run: string) => {
      await Promise.resolve();
      stopped.push({ workflow, run });
      current = {
        ...current,
        status: "cancelled",
        endedAt: "2026-10-30T09:05:00.000Z",
      };
      return current;
    },
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
      <RunSheet
        admin={false}
        names={{ people: new Map(), me: "ada" }}
        onClose={() => {}}
        opened={running}
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
  // The role, the run and its files, each read once.
  await act(async () => {
    await settled();
  });
  return { stopped };
};

/** The button whose text is `text`. */
const button = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent.trim() === text
  );

/** Presses the button whose text is `text`, and lets what it does settle. */
const press = async (text: string): Promise<void> => {
  await act(async () => {
    button(text)?.click();
    await settled();
  });
};

describe("a run opened beside the page", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("lets a builder stop a run that hasn't ended, after asking, and stops exactly that run", async () => {
    const { stopped } = await opened("builder", null);
    await press("Stop");
    const asked = document.body.textContent.includes("Stop this run?");
    await press("Stop the run");

    expect({
      asked,
      stopped,
      cancelled: document.body.textContent.includes("Cancelled"),
      stopOffered: button("Stop") !== undefined,
    }).toStrictEqual({
      asked: true,
      stopped: [{ workflow: "workflow-1", run: "run-1" }],
      cancelled: true,
      // An ended run has nothing to stop.
      stopOffered: false,
    });
  });

  it("offers a user of the workflow nothing to stop", async () => {
    await opened("user", null);

    expect(button("Stop")).toBeUndefined();
  });

  it("links each finished file to core's download route, and shows no files where core lists none", async () => {
    await opened("user", [
      {
        id: "file-1",
        name: "Report.pdf",
        type: "application/pdf",
        size: 2048,
        finishedAt: "2026-10-30T09:01:00.000Z",
      },
    ]);
    const links = [...document.querySelectorAll("a[download]")].map((link) => ({
      name: link.getAttribute("aria-label"),
      href: link.getAttribute("href"),
    }));
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await opened("user", null);

    expect({
      links,
      noneListed: document.body.textContent.includes("Files it wrote"),
    }).toStrictEqual({
      links: [
        {
          name: "Download Report.pdf",
          href: "/api/run-files/workflow-1/run-1/file-1/content",
        },
      ],
      noneListed: false,
    });
  });
});

// @vitest-environment happy-dom
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
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

import { RunPage } from "./run-page.tsx";

// A run's page follows its run while it goes on: it reads the run again
// until it ends, so a step's wait for its AI provider, begun or ended,
// shows and goes though the run's status stays running, and its end shows
// once it comes. Core's `workflowResources.run` is the boundary, faked.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const running: WorkflowResourceRun = {
  id: "run-1",
  workflowId: "workflow-1",
  version: 1,
  manifestHash: "manifest",
  buildHash: "build",
  principal: "ada",
  status: "running",
  createdAt: "2026-10-31T09:00:00.000Z",
  endedAt: null,
};

const wait = {
  since: "2026-10-31T09:00:30.000Z",
  provider: "anthropic",
  trouble: "refused",
} as const;

/** What core says of the run now. */
let now: WorkflowResourceRun = running;

const core = {
  withSession: async <T,>(
    action: (session: {
      workflowResources: {
        run: (workflow: string, id: string) => Promise<WorkflowResourceRun>;
        get: () => Promise<{ role: "user" }>;
        runFiles: () => Promise<null>;
      };
    }) => Promise<T>
  ): Promise<T> =>
    await action({
      workflowResources: {
        run: async () => {
          await Promise.resolve();
          return now;
        },
        get: async () => await Promise.resolve({ role: "user" }),
        runFiles: async () => await Promise.resolve(null),
      },
    }),
};

const Page = () => (
  <RunPage
    admin={false}
    decision={undefined}
    name="Invoice intake"
    names={{ me: "ada", people: new Map() }}
    opened={running}
    workflow="workflow-1"
  />
);

/** The page's text, as a person reads it. */
const pageText = (): string => document.body.textContent ?? "";

let root: Root | undefined;

describe("a run's page, following its run", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    now = running;
    document.body.replaceChildren();
  });

  it("says a step waits for its AI provider while core says so, no more once the wait ends, and that it is done once it ends", async () => {
    const router = createRouter({
      routeTree: createRootRoute({ component: Page }),
      history: createMemoryHistory(),
      context: { core },
    });
    const host = document.createElement("div");
    document.body.append(host);
    await act(async () => {
      root = createRoot(host);
      root.render(
        <I18nProvider i18n={i18n}>
          <SidebarProvider>
            <RouterProvider router={router} />
          </SidebarProvider>
        </I18nProvider>
      );
      await router.load();
    });
    const waitingLine =
      "Waiting for Anthropic, which is refusing the key, since";
    const before = pageText().includes(waitingLine);

    now = { ...running, aiProvider: wait };
    await vi.waitFor(
      () => {
        expect(pageText()).toContain(waitingLine);
      },
      { timeout: 5000 }
    );
    now = {
      ...running,
      status: "completed",
      endedAt: "2026-10-31T09:01:00.000Z",
    };
    await vi.waitFor(
      () => {
        expect(pageText()).toContain("Done");
      },
      { timeout: 5000 }
    );

    expect({
      before,
      after: pageText().includes(waitingLine),
    }).toStrictEqual({ before: false, after: false });
  });
});

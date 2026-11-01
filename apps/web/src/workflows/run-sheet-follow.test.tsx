// @vitest-environment happy-dom
import type { WorkflowRunTrace } from "@grasp-os/shared/workflow-diagrams";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RunSheet } from "./run-detail.tsx";
import { followedState } from "./traces.tsx";

// A builder's open run sheet, its facts following the run as its steps
// do (traces.tsx): read again each time where the run is moves, as its
// trace says it (`followedState`). A step's wait for its AI provider,
// begun or ended, moves it though the run's status stays running, so the
// sheet's line on the wait comes and goes with it. Core's
// `workflowResources.run` is the boundary, faked.

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

/** The run's trace as its steps read it: running, waiting or not. */
const traceOf = (waiting: boolean): WorkflowRunTrace => ({
  runId: running.id,
  version: 1,
  status: "running",
  diagram: { tasks: [] },
  tasks: [],
  steps: [],
  complete: true,
  detailsRemoved: false,
  ...(waiting ? { aiProvider: wait } : {}),
});

/** Where the run is as its steps last read it: what the sheet is given. */
const followed = {
  state: followedState(traceOf(false)),
  listeners: new Set<() => void>(),
};

/** The steps read the run's trace again: the sheet is told where it is. */
const traced = (trace: WorkflowRunTrace): void => {
  followed.state = followedState(trace);
  for (const listener of followed.listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  followed.listeners.add(listener);
  return () => {
    followed.listeners.delete(listener);
  };
};

const followedNow = (): string => followed.state;

/** What core says of the run now. */
let now: WorkflowResourceRun = running;

const core = {
  withSession: async <T,>(
    action: (session: {
      workflowResources: {
        run: (workflow: string, id: string) => Promise<WorkflowResourceRun>;
      };
    }) => Promise<T>
  ): Promise<T> =>
    await action({
      workflowResources: {
        run: async () => {
          await Promise.resolve();
          return now;
        },
      },
    }),
};

/** The open sheet, given where the run is as its steps last read it. */
const OpenSheet = () => {
  const status = useSyncExternalStore(subscribe, followedNow);
  return (
    <RunSheet
      admin={false}
      names={{ me: "ada", people: new Map() }}
      onClose={() => {
        // Stays open.
      }}
      opened={running}
      status={status}
      workflow="workflow-1"
    />
  );
};

/** The sheet's text, as a person reads it. */
const sheetText = (): string => document.body.textContent ?? "";

let root: Root | undefined;

describe("an open run sheet, following its run", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("says a step waits for its AI provider once its trace says so, and no more once the wait ends, its status running throughout", async () => {
    const router = createRouter({
      routeTree: createRootRoute({ component: OpenSheet }),
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
    const waitingLine = "Waiting for Anthropic, which is refusing the key";
    const before = sheetText().includes(waitingLine);

    now = { ...running, aiProvider: wait };
    await act(async () => {
      traced(traceOf(true));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(sheetText()).toContain(waitingLine);
    });
    now = running;
    await act(async () => {
      traced(traceOf(false));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(sheetText()).not.toContain(waitingLine);
    });

    expect(before).toBeFalsy();
  });
});

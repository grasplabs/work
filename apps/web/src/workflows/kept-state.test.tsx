// @vitest-environment happy-dom
import type { WorkflowState } from "@grasp-os/shared/workflow-resources";
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
import { afterEach, describe, expect, it } from "vite-plus/test";

import { KeptState } from "./kept-state.tsx";

// What a workflow keeps between its runs, on its page, against core's
// workflowResources as the page reaches them over RPC, faked: anyone with
// a role sees each key and value; nothing is reset until a builder
// confirms; and anyone who doesn't build it is offered no reset.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Lets every reply already on its way arrive. */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await Promise.resolve();
  }
};

const kept: WorkflowState = {
  entries: [
    {
      key: "cursor",
      value: { after: "inv-41" },
      runId: "run-1",
      updatedAt: "2026-11-04T09:00:00.000Z",
    },
  ],
  bytes: 1500,
};

/** The section, for a reader who builds it or not. */
const shown = async (editable: boolean) => {
  const asked: string[] = [];
  const workflowResources = {
    resetState: async (id: string): Promise<WorkflowState> => {
      await Promise.resolve();
      asked.push(id);
      return { entries: [], bytes: 0 };
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: {
        workflowResources: typeof workflowResources;
      }) => Promise<T>
    ): Promise<T> => await action({ workflowResources }),
  };
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <KeptState editable={editable} loaded={kept} workflow="workflow-1" />
      ),
    }),
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
    await settled();
  });
  return { asked };
};

/** Presses the button whose text is `text` (the last one: a dialog's own comes last). */
const press = async (text: string): Promise<void> => {
  await act(async () => {
    [...document.querySelectorAll("button")]
      .findLast((each) => each.textContent.trim() === text)
      ?.click();
    await settled();
  });
};

describe("what a workflow keeps between its runs, on its page", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("shows each key and value, and resets them only once a builder confirms", async () => {
    const { asked } = await shown(true);
    const text = document.body.textContent;
    await press("Reset what it keeps");
    const beforeConfirming = [...asked];
    await press("Reset");

    expect({
      shows: ["cursor", '{"after":"inv-41"}', "2 KB of 64 KB"].every((part) =>
        text.includes(part)
      ),
      beforeConfirming,
      asked,
      emptied: document.body.textContent.includes("Nothing is kept yet."),
    }).toStrictEqual({
      shows: true,
      beforeConfirming: [],
      asked: ["workflow-1"],
      emptied: true,
    });
  });

  it("offers someone who doesn't build it no reset", async () => {
    await shown(false);

    expect({
      shows: document.body.textContent.includes("cursor"),
      offersReset: document.body.textContent.includes("Reset"),
    }).toStrictEqual({ shows: true, offersReset: false });
  });
});

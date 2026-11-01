// @vitest-environment happy-dom
import type { WorkflowRole } from "@grasp-os/shared/workflow-resources";
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

import { DeleteWorkflow } from "./delete-workflow.tsx";

// Deleting a workflow from its page, against core's workflowResources as
// the page reaches them over RPC, faked: nothing is deleted until the
// builder confirms; an admin may release its name as it goes; what core
// refuses is said and the page stays; a release core refuses says the
// workflow is gone but its name isn't free; and anyone who doesn't build
// it is offered nothing.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Lets every reply already on its way arrive. */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await Promise.resolve();
  }
};

/** The section for a reader in `role`, core refusing as `refuses` says. */
const shown = async (
  role: WorkflowRole,
  admin: boolean,
  refuses: { delete?: string; release?: string } = {}
) => {
  const asked: unknown[] = [];
  const workflowResources = {
    delete: async (id: string) => {
      await Promise.resolve();
      asked.push({ delete: id });
      if (refuses.delete !== undefined) {
        throw new Error(refuses.delete);
      }
    },
    releaseName: async (name: string) => {
      await Promise.resolve();
      asked.push({ releaseName: name });
      if (refuses.release !== undefined) {
        throw new Error(refuses.release);
      }
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
      <DeleteWorkflow
        admin={admin}
        resource={{ id: "workflow-1", name: "invoices", role }}
      />
    ),
  });
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows",
    component: () => <p>The workflows</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, list]),
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
  return { asked, at: () => router.state.location.pathname };
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

/** Ticks the release box. */
const tickRelease = async (): Promise<void> => {
  await act(async () => {
    document.querySelector<HTMLElement>('[role="checkbox"]')?.click();
    await settled();
  });
};

describe("deleting a workflow from its page", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("deletes it only once a builder confirms, then goes to the workflows, offering no release to a builder who isn't an admin", async () => {
    const { asked, at } = await shown("builder", false);
    await press("Delete the workflow");
    const beforeConfirming = [...asked];
    const offersRelease = document.body.textContent.includes(
      "Also release its name"
    );
    await press("Delete the workflow");

    expect({ beforeConfirming, offersRelease, asked, at: at() }).toStrictEqual({
      beforeConfirming: [],
      offersRelease: false,
      asked: [{ delete: "workflow-1" }],
      at: "/workflows",
    });
  });

  it("releases its name too, after deleting it, when an admin asks", async () => {
    const { asked, at } = await shown("builder", true);
    await press("Delete the workflow");
    await tickRelease();
    await press("Delete the workflow");

    expect({ asked, at: at() }).toStrictEqual({
      asked: [{ delete: "workflow-1" }, { releaseName: "invoices" }],
      at: "/workflows",
    });
  });

  it("says what core refuses, releasing nothing and staying on the page", async () => {
    const bound =
      "The current version of another workflow calls this one, or a trigger starts it, so it can't be deleted.";
    const { asked, at } = await shown("builder", true, { delete: bound });
    await press("Delete the workflow");
    await tickRelease();
    await press("Delete the workflow");

    expect({
      asked,
      at: at(),
      said: document.body.textContent.includes(bound),
    }).toStrictEqual({
      asked: [{ delete: "workflow-1" }],
      at: "/",
      said: true,
    });
  });

  it("says the workflow is gone but its name isn't free when core refuses the release", async () => {
    const pinned = "Something still names a version of the deleted workflow.";
    const { at } = await shown("builder", true, { release: pinned });
    await press("Delete the workflow");
    await tickRelease();
    await press("Delete the workflow");

    expect({
      at: at(),
      said: document.body.textContent.includes(
        `The workflow is deleted, but its name wasn't released: ${pinned}`
      ),
    }).toStrictEqual({ at: "/", said: true });
  });

  it("offers someone who doesn't build it nothing", async () => {
    await shown("user", true);

    expect(document.body.textContent).not.toContain("Delete");
  });
});

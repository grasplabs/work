// @vitest-environment happy-dom
import type {
  PendingWorkflowBindings,
  WorkflowBindingTarget,
} from "@grasp-os/shared/workflow-resources";
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

import { FilesAndApps } from "./files-and-apps.tsx";

// A workflow's Files and apps tab against core's RPC as the page reaches
// it, faked: core keeps what an admin approves, and lists as waiting only
// the bindings no approval serves, so what the tab shows after an approval
// is what core holds. An admin approves a decision with the people and
// teams they pick, and a connector with the target core offers, each for
// the version listed; anyone else is never shown what waits.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const workflow = "workflow-quotes";

const crmTarget: WorkflowBindingTarget = {
  kind: "connector",
  permissionId: "permission-crm",
  contract: "composio.hubspot@1",
};

/** What version 2 declares that waits, before anything is approved. */
const waiting: PendingWorkflowBindings["bindings"] = [
  {
    alias: "approval",
    kind: "decision",
    contractId: "invoice-approval",
    offered: [],
  },
  {
    alias: "crm",
    kind: "connector",
    contractId: "crm-contacts",
    offered: [{ target: crmTarget, label: "HUBSPOT: composio.hubspot@1" }],
  },
];

/** Core as the tab reaches it, keeping each approval asked of it. */
const fakeCore = () => {
  const approved: { id: string; input: { alias: string } }[] = [];
  const asked: string[] = [];
  const workflowResources = {
    knowledge: async () => await Promise.resolve([]),
    files: async () => await Promise.resolve([]),
    bindings: async () => await Promise.resolve([]),
    pendingBindingsOf: async (
      id: string
    ): Promise<PendingWorkflowBindings[]> => {
      await Promise.resolve();
      asked.push("pendingBindingsOf");
      const done = new Set(approved.map(({ input }) => input.alias));
      const left = waiting.filter(({ alias }) => !done.has(alias));
      return left.length === 0
        ? []
        : [
            {
              workflow: { id, name: "Quotes" },
              version: 2,
              live: true,
              bindings: left,
            },
          ];
    },
    approveBinding: async (id: string, input: { alias: string }) => {
      await Promise.resolve();
      approved.push({ id, input });
      return {};
    },
  };
  const session = {
    workflowResources,
    connections: {
      catalog: async () => await Promise.resolve({ entries: [] }),
      list: async () => await Promise.resolve([]),
    },
    workflows: {
      byConnection: async () => await Promise.resolve([]),
      teams: async () =>
        await Promise.resolve([{ id: "team-finance", name: "Finance" }]),
    },
    members: {
      list: async () =>
        await Promise.resolve([
          { userId: "user-ada", name: "Ada Lovelace", email: "ada@acme.test" },
        ]),
    },
  };
  return { session, approved, asked };
};

/** Lets every pending promise and render settle. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The tab on `session`, for an admin who approves when `approves`. */
const shown = async (
  session: ReturnType<typeof fakeCore>["session"],
  approves: boolean
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (reached: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <FilesAndApps
        approves={approves}
        currentVersion={2}
        versions={{ state: "ready", data: [] }}
        workflow={workflow}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
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
  await settled();
};

const press = async (element: Element | null | undefined) => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === name ||
      each.textContent.trim() === name
  );

/** Opens the list of who answers and picks `name` from it. */
const pick = async (name: string) => {
  await press(button("Add who answers"));
  await press(
    [...document.querySelectorAll('[role="option"]')].find((each) =>
      each.textContent.trim().endsWith(name)
    )
  );
};

describe("a workflow's Files and apps tab", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("lets an admin approve a decision with the people and teams they pick, and a connector with the target offered, until nothing waits", async () => {
    const { session, approved } = fakeCore();
    await shown(session, true);
    const unpicked = button("Approve approval")?.disabled;

    await pick("Ada Lovelace");
    await pick("Finance");
    await press(button("Approve approval"));
    await press(button("Approve crm"));

    expect({
      unpicked,
      approved,
      waits: document.body.textContent.includes("Waiting for your approval"),
    }).toStrictEqual({
      unpicked: true,
      approved: [
        {
          id: workflow,
          input: {
            alias: "approval",
            target: {
              kind: "decision",
              deciders: ["person:user-ada", "team:team-finance"],
            },
            reviewed: { version: 2 },
          },
        },
        {
          id: workflow,
          input: {
            alias: "crm",
            target: crmTarget,
            reviewed: { version: 2 },
          },
        },
      ],
      waits: false,
    });
  });

  it("never asks core what waits for someone who doesn't approve", async () => {
    const { session, asked } = fakeCore();
    await shown(session, false);

    expect({
      asked,
      waits: document.body.textContent.includes("Waiting for your approval"),
    }).toStrictEqual({ asked: [], waits: false });
  });
});

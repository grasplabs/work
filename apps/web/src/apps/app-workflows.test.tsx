// @vitest-environment happy-dom
import type { ViewedApp } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import type {
  AppWorkflowBinding,
  WorkflowResource,
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

import { AppWorkflows } from "./app-workflows.tsx";

// The workflows an App starts, on its Resources tab, against core's
// `workflowResources` and `apps.define` as the page reaches them over RPC
// (the boundary from the web app), faked: it keeps the App's active
// bindings, and answers a change of the draft as core does, refusing one
// whose workflow the draft can't bind.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const appId = appIdSchema.parse("app-1");

const ledger: ViewedApp = {
  id: appId,
  name: "Ledger",
  description: "",
  owner: "user-owner",
  responsible: "user-owner",
  audience: null,
  blueprint: null,
  currentVersion: 1,
  liveLabel: "26.11.1",
  archived: false,
  process: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  role: "builder",
  link: "ledger",
};

const workflow = (
  id: string,
  name: string,
  currentVersion: number | null
): WorkflowResource => ({
  id,
  namespace: "grasp",
  name,
  owner: "user-owner",
  currentVersion,
  role: "builder",
  process: null,
  paused: false,
  createdAt: "2026-10-01T09:00:00.000Z",
});

/** Core's workflows and the App's bindings, and each change asked. */
const fakeWorkflows = () => {
  const asked: unknown[][] = [];
  const bindings: AppWorkflowBinding[] = [
    {
      id: "binding-1",
      app: appId,
      alias: "summary",
      workflowId: "flow-summary",
      boundBy: "user-owner",
      boundAt: "2026-10-20T09:00:00.000Z",
    },
  ];
  const workflowResources = {
    appBindings: async (app: string): Promise<AppWorkflowBinding[]> => {
      await Promise.resolve();
      asked.push(["appBindings", app]);
      return bindings.toSorted((a, b) => a.alias.localeCompare(b.alias));
    },
    list: async (): Promise<WorkflowResource[]> => {
      await Promise.resolve();
      return [
        workflow("flow-summary", "Summarise the week", 2),
        workflow("flow-invoice", "Send an invoice", 3),
        workflow("flow-draft", "Never published", null),
      ];
    },
  };
  const apps = {
    define: async (
      app: string,
      operation: { op: string; alias: string; workflow: string }
    ): Promise<{ ok: false; problem: string } | { ok: true }> => {
      await Promise.resolve();
      asked.push(["define", app, operation]);
      return operation.workflow === "flow-summary"
        ? { ok: false, problem: "The draft binds this workflow already." }
        : { ok: true };
    },
  };
  return { session: { workflowResources, apps }, asked };
};

let root: Root | undefined;

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

const shown = async (
  session: ReturnType<typeof fakeWorkflows>["session"],
  { app = ledger, staff = false } = {}
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    component: () => <AppWorkflows app={app} identity={{ staff }} />,
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

const unmount = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.innerHTML = "";
};

const press = async (element: Element | undefined) => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

const button = (name: string) =>
  [...document.querySelectorAll("button")].findLast(
    (each) => each.textContent?.trim() === name
  );

/** The field labelled `label`: its control. */
const field = (label: string) => {
  const named = [...document.querySelectorAll("label")].find(
    (each) => each.textContent?.trim() === label
  );
  return [...document.querySelectorAll("input, button")].find(
    (each) => each.id !== "" && each.id === named?.htmlFor
  );
};

/** Chooses `option` in the select labelled `label`. */
const choose = async (label: string, option: string): Promise<void> => {
  await press(field(label));
  await press(
    [...document.querySelectorAll('[role="option"]')].find(
      (each) => each.textContent?.trim() === option
    )
  );
};

/** Each binding listed: its alias and workflow. */
const listed = (): string[][] =>
  [...document.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")]
      .slice(0, 2)
      .map((cell) => cell.textContent?.trim() ?? "")
  );

describe("The workflows an App starts, for its builders", () => {
  afterEach(() => {
    unmount();
  });

  it("changes what a name starts in the App's draft, which publishing makes live", async () => {
    const { session, asked } = fakeWorkflows();
    await shown(session);

    await press(button("Change"));
    await choose("Workflow", "Send an invoice");
    await press(button("Change in the draft"));

    expect({
      asked,
      listed: listed(),
      told: document.body.textContent?.includes(
        "Changed in the draft: publish the App"
      ),
    }).toStrictEqual({
      asked: [
        ["appBindings", "app-1"],
        [
          "define",
          "app-1",
          { op: "bindWorkflow", alias: "summary", workflow: "flow-invoice" },
        ],
      ],
      // What runs is what's published: the binding is the live version's.
      listed: [["summary", "Summarise the week"]],
      told: true,
    });
  });

  it("says why the draft took no change", async () => {
    const { session } = fakeWorkflows();
    await shown(session);

    await press(button("Change"));
    await press(button("Change in the draft"));

    expect({
      told: document.body.textContent?.includes(
        "The draft binds this workflow already."
      ),
      drafted: document.body.textContent?.includes("Changed in the draft"),
    }).toStrictEqual({ told: true, drafted: false });
  });

  it("shows an archived App's bindings without changing them, and none to who doesn't build it", async () => {
    const archived = fakeWorkflows();
    await shown(archived.session, { app: { ...ledger, archived: true } });
    const kept = {
      listed: listed(),
      changes: button("Change") !== undefined,
    };
    unmount();
    const user = fakeWorkflows();
    await shown(user.session, { app: { ...ledger, role: "user" } });
    const userAsked = [...user.asked];
    unmount();
    const staff = fakeWorkflows();
    await shown(staff.session, { staff: true });

    expect({ kept, userAsked, staffAsked: staff.asked }).toStrictEqual({
      kept: {
        listed: [["summary", "Summarise the week"]],
        changes: false,
      },
      userAsked: [],
      staffAsked: [],
    });
  });
});

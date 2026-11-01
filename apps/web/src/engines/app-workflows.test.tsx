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

// The workflows a domain's App starts, on its Resources tab, against
// core's `workflowResources` as the page reaches it over RPC (the boundary
// from the web app), faked: it keeps the App's active bindings, replaces
// an alias's binding when it is bound again, and forgets one unbound.

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
  pendingVersion: null,
  status: "published",
  process: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  role: "builder",
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
  createdAt: "2026-10-01T09:00:00.000Z",
});

/** Core's workflows and the App's bindings, and each change asked. */
const fakeWorkflows = () => {
  const asked: unknown[][] = [];
  let bindings: AppWorkflowBinding[] = [
    {
      id: "binding-1",
      app: appId,
      alias: "summary",
      workflowId: "flow-summary",
      version: 1,
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
    versions: async (id: string) => {
      await Promise.resolve();
      const count = id === "flow-invoice" ? 3 : 2;
      return Array.from({ length: count }, (_, index) => ({
        version: index + 1,
      }));
    },
    bindToApp: async (
      id: string,
      input: { app: string; alias: string; version: number }
    ): Promise<AppWorkflowBinding> => {
      await Promise.resolve();
      asked.push(["bindToApp", id, input]);
      const bound = {
        id: `binding-${bindings.length + 2}`,
        app: input.app,
        alias: input.alias,
        workflowId: id,
        version: input.version,
        boundBy: "user-owner",
        boundAt: "2026-10-30T09:00:00.000Z",
      };
      bindings = [
        ...bindings.filter((each) => each.alias !== input.alias),
        bound,
      ];
      return bound;
    },
    unbindFromApp: async (binding: string): Promise<void> => {
      await Promise.resolve();
      asked.push(["unbindFromApp", binding]);
      bindings = bindings.filter((each) => each.id !== binding);
    },
  };
  return { session: { workflowResources }, asked };
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

/** Types `text` into the field labelled `label`. */
const type = async (label: string, text: string): Promise<void> => {
  const box = field(label);
  if (!(box instanceof HTMLInputElement)) {
    throw new TypeError(`No field ${label}`);
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

/** Each binding listed: its alias, workflow and version. */
const listed = (): string[][] =>
  [...document.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")]
      .slice(0, 3)
      .map((cell) => cell.textContent?.trim() ?? "")
  );

describe("The workflows a domain's app starts, for its builders", () => {
  afterEach(() => {
    unmount();
  });

  it("binds a new name to a published workflow's exact version", async () => {
    const { session, asked } = fakeWorkflows();
    await shown(session);
    expect(listed()).toStrictEqual([["summary", "Summarise the week", "1"]]);

    await press(button("Bind a workflow"));
    await type("Name in the app's code", "invoice");
    await choose("Workflow", "Send an invoice");
    await choose("Version", "Version 3");
    await press(button("Bind"));

    expect({ asked, listed: listed() }).toStrictEqual({
      asked: [
        ["appBindings", "app-1"],
        [
          "bindToApp",
          "flow-invoice",
          { app: "app-1", alias: "invoice", version: 3 },
        ],
        ["appBindings", "app-1"],
      ],
      listed: [
        ["invoice", "Send an invoice", "3"],
        ["summary", "Summarise the week", "1"],
      ],
    });
  });

  it("moves a name to another version, and unbinds one only once confirmed", async () => {
    const { session, asked } = fakeWorkflows();
    await shown(session);

    await press(button("Change version"));
    await choose("Version", "Version 2");
    await press(button("Bind"));
    const moved = listed();
    await press(button("Unbind"));
    await press(button("Cancel"));
    const afterCancel = asked.filter(([call]) => call === "unbindFromApp");
    await press(button("Unbind"));
    await press(button("Unbind"));

    expect({ moved, afterCancel, listed: listed() }).toStrictEqual({
      moved: [["summary", "Summarise the week", "2"]],
      afterCancel: [],
      listed: [],
    });
  });

  it("refuses a name the app's code couldn't use", async () => {
    const { session } = fakeWorkflows();
    await shown(session);

    await press(button("Bind a workflow"));
    await type("Name in the app's code", "2nd-flow");
    await choose("Workflow", "Send an invoice");
    await choose("Version", "Version 1");

    expect({
      told: document.body.textContent?.includes("Start with a letter"),
      bindable: button("Bind")?.disabled,
    }).toStrictEqual({ told: true, bindable: true });
  });

  it("shows an archived domain's bindings without changing them, and none to who doesn't build it", async () => {
    const archived = fakeWorkflows();
    await shown(archived.session, { app: { ...ledger, status: "archived" } });
    const kept = {
      listed: listed(),
      changes: button("Bind a workflow") !== undefined,
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
        listed: [["summary", "Summarise the week", "1"]],
        changes: false,
      },
      userAsked: [],
      staffAsked: [],
    });
  });
});

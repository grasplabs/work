// @vitest-environment happy-dom
import type { WorkflowStartForm } from "@grasp-os/shared/workflow-resources";
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
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { StartAppRun, StartIndependentRun } from "./start-run.tsx";

// Starting a workflow by hand from its page, against core's RPC as the
// page reaches it, faked: an independent workflow starts at the version
// core named, with exactly the input its form makes and one key per try;
// a field it can't send stops the start before core is asked; one core
// gives no version for has no Start. An App's workflow starts with the
// JSON typed, or none, and links to its run.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Lets every reply already on its way arrive. */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await Promise.resolve();
  }
};

const form: WorkflowStartForm = {
  version: 3,
  input: {
    type: "object",
    properties: { who: { type: "string" }, times: { type: "integer" } },
    required: ["times", "who"],
    additionalProperties: false,
  },
};

/** `page` shown with core faked: what core was asked to start. */
const shown = async (page: () => ReactNode, given: WorkflowStartForm) => {
  const asked: Record<string, unknown>[] = [];
  const workflowResources = {
    startForm: async () => await Promise.resolve(given),
    start: async (
      workflow: string,
      start: { version: number; input: unknown; key: string }
    ) => {
      await Promise.resolve();
      asked.push({
        workflow,
        version: start.version,
        input: start.input,
        keyed: start.key.length > 0,
      });
      return { runId: "run-1" };
    },
  };
  const workflows = {
    start: async (app: string, workflow: string, input?: unknown) => {
      await Promise.resolve();
      asked.push({ app, workflow, input });
      return { id: "run-9" };
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: {
        workflowResources: typeof workflowResources;
        workflows: typeof workflows;
      }) => Promise<T>
    ): Promise<T> => await action({ workflowResources, workflows }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: page,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
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
  return asked;
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

/** Types `value` into the field labelled `label`. */
const type = async (label: string, value: string): Promise<void> => {
  const labelled = [...document.querySelectorAll("label")].find(
    (each) => each.textContent.trim() === label
  );
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `#${CSS.escape(labelled?.htmlFor ?? "")}`
  );
  await act(async () => {
    if (field !== null) {
      const prototype: unknown = Object.getPrototypeOf(field);
      if (typeof prototype === "object" && prototype !== null) {
        Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
          field,
          value
        );
      }
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await settled();
  });
};

/** What the dialog says now. */
const said = (): string => document.body.textContent;

describe("starting a workflow by hand", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("starts an independent workflow at core's version with exactly the input its form makes, after a field it can't send", async () => {
    const asked = await shown(
      () => <StartIndependentRun workflow="workflow-1" />,
      form
    );
    await press("Start");
    await type("who", "Ada");
    await type("times", "two");
    await press("Start the run");
    const refused = { asked: asked.length, said: said() };
    await type("times", "2");
    await press("Start the run");

    expect({
      refusedAsked: refused.asked,
      refusedSaid: refused.said.includes("Type a number."),
      asked,
      started: said().includes("The run started."),
    }).toStrictEqual({
      refusedAsked: 0,
      refusedSaid: true,
      asked: [
        {
          workflow: "workflow-1",
          version: 3,
          input: { who: "Ada", times: 2 },
          keyed: true,
        },
      ],
      started: true,
    });
  });

  it("offers no Start for a workflow core gives no version to start", async () => {
    await shown(() => <StartIndependentRun workflow="workflow-1" />, {
      version: null,
      input: null,
    });

    expect(button("Start")).toBeUndefined();
  });

  it("starts an App's workflow with no input when none is typed, then with the JSON typed, and links to its run", async () => {
    const asked = await shown(
      () => <StartAppRun app="app-1" workflow="invoices" />,
      form
    );
    await press("Start");
    await press("Start the run");
    const link = document.querySelector("output a")?.getAttribute("href");
    await type("Input, as JSON, if it takes any", '{"invoice": 7}');
    await press("Start the run");

    expect({ asked, link }).toStrictEqual({
      asked: [
        { app: "app-1", workflow: "invoices", input: undefined },
        { app: "app-1", workflow: "invoices", input: { invoice: 7 } },
      ],
      link: "/workflows/app-1/invoices/runs/run-9",
    });
  });
});

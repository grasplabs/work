// @vitest-environment happy-dom
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
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

import { StartIndependentRun } from "./start-run.tsx";

// Starting a workflow by hand from its page, against core's RPC as the
// page reaches it, faked: an independent workflow starts at the version
// core named, with exactly the input its form makes and one key per try;
// a field it can't send stops the start before core is asked; one core
// gives no version for has no Start. An App's workflow starts with the
// JSON typed, or none, and links to its run. A start form core can't give
// says why there is no Start; a start refused for an unapproved binding
// says what to do and leads to where it is approved.

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
  people: null,
};

/**
 * `page` shown with core faked, its start form `given` or refused with it,
 * and each start refused with `refusal` when there is one: what core was
 * asked to start.
 */
const shown = async (
  page: () => ReactNode,
  given: WorkflowStartForm | Error,
  refusal?: Error
) => {
  const asked: Record<string, unknown>[] = [];
  const workflowResources = {
    startForm: async () => {
      await Promise.resolve();
      if (given instanceof Error) {
        throw given;
      }
      return given;
    },
    start: async (
      workflow: string,
      start: { version: number; input: unknown; key: string }
    ) => {
      await Promise.resolve();
      if (refusal !== undefined) {
        throw refusal;
      }
      asked.push({
        workflow,
        version: start.version,
        input: start.input,
        keyed: start.key.length > 0,
      });
      return { runId: "run-1" };
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

/** The buttons whose text is `text`. */
const buttonsNamed = (text: string): HTMLButtonElement[] =>
  [...document.querySelectorAll("button")].filter(
    (each) => each.textContent.trim() === text
  );

/** Clicks `element`, and lets what it does settle. */
const click = async (
  element: HTMLElement | null | undefined
): Promise<void> => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to click");
  }
  await act(async () => {
    element.click();
    await settled();
  });
};

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

/** Picks the option of the open list whose text is `text`. */
const choose = async (text: string): Promise<void> => {
  await act(async () => {
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((each) => each.textContent.trim().endsWith(text))
      ?.click();
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

  it("has a person picked, never typed, for a field that takes one: a person, a team or a role", async () => {
    const asked = await shown(
      () => <StartIndependentRun workflow="workflow-1" />,
      {
        version: 3,
        input: {
          type: "object",
          properties: {
            approver: { type: "string", "x-grasp-value": { kind: "person" } },
            watcher: { type: "string", "x-grasp-value": { kind: "person" } },
          },
          required: ["approver"],
          additionalProperties: false,
        },
        people: {
          people: [{ id: "user-ada", name: "Ada Lovelace" }],
          teams: [{ id: "team-finance", name: "Finance" }],
        },
      }
    );
    await press("Start");
    const typed = document.querySelector("input");
    await press("Start the run");
    const unpicked = {
      asked: asked.length,
      said: said().includes("Fill this in."),
    };
    const [approver, watcher] = buttonsNamed("Choose…");
    await click(approver);
    const offered = [...document.querySelectorAll('[role="option"]')].map(
      (each) => each.textContent.trim()
    );
    await choose("Everyone with the Admin role");
    await press("Admin");
    await choose("Ada Lovelace");
    // An optional one picked by mistake is cleared again.
    await click(watcher);
    await choose("Finance");
    await click(
      document.querySelector<HTMLButtonElement>('[aria-label="Clear watcher"]')
    );
    await press("Start the run");

    expect({ typed, unpicked, offered, asked }).toStrictEqual({
      typed: null,
      unpicked: { asked: 0, said: true },
      offered: [
        "ALAda Lovelace",
        "Finance",
        "Everyone with the Admin role",
        "Everyone with the Builder role",
        "Everyone with the User role",
      ],
      asked: [
        {
          workflow: "workflow-1",
          version: 3,
          input: { approver: "person:user-ada" },
          keyed: true,
        },
      ],
    });
  });

  it("names the person picked apart from someone of the same name", async () => {
    await shown(() => <StartIndependentRun workflow="workflow-1" />, {
      version: 3,
      input: {
        type: "object",
        properties: {
          approver: { type: "string", "x-grasp-value": { kind: "person" } },
        },
        required: ["approver"],
        additionalProperties: false,
      },
      people: {
        people: [
          { id: "user-ada-111111", name: "Ada Lovelace" },
          { id: "user-ada-222222", name: "Ada Lovelace" },
        ],
        teams: [],
      },
    });
    await press("Start");
    await click(button("Choose…"));
    await choose("ID …222222");

    expect(button("Ada Lovelace (ID …222222)")).toBeDefined();
  });

  it("offers no Start for a workflow core gives no version to start", async () => {
    await shown(() => <StartIndependentRun workflow="workflow-1" />, {
      version: null,
      input: null,
      people: null,
    });

    expect(button("Start")).toBeUndefined();
  });

  it("says why it can't offer Start when core can't say how the workflow starts", async () => {
    await shown(
      () => <StartIndependentRun workflow="workflow-1" />,
      workflowResourceErrors.create("workflow.resource_unavailable")
    );

    expect({
      start: button("Start"),
      said: said().includes(
        "Can't offer Start: This workflow doesn't exist or was deleted."
      ),
    }).toStrictEqual({ start: undefined, said: true });
  });

  it("says what to do about a start refused for an unapproved binding, and leads to where it is approved", async () => {
    const shownFiles: string[] = [];
    await shown(
      () => (
        <StartIndependentRun
          onFiles={() => {
            shownFiles.push("files");
          }}
          workflow="workflow-1"
        />
      ),
      form,
      workflowResourceErrors.create("workflow.binding_unapproved")
    );
    await press("Start");
    await type("who", "Ada");
    await type("times", "2");
    await press("Start the run");
    const refused = said().includes(
      "Ask for it to go live, or ask an admin to approve it on the workflow's Files and apps tab."
    );
    await press("Open Files and apps");

    expect({
      refused,
      shownFiles,
      dialog: button("Start the run"),
    }).toStrictEqual({
      refused: true,
      shownFiles: ["files"],
      dialog: undefined,
    });
  });
});

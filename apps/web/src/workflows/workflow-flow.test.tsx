// @vitest-environment happy-dom
import type {
  DiagramTask,
  WorkflowDiagram,
} from "@grasp-os/shared/workflow-diagrams";
import type { WorkflowDraft } from "@grasp-os/shared/workflow-resources";
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
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { WorkflowFlow } from "./workflow-flow.tsx";

// A workflow's Flow, against core's workflowResources as the page reaches
// them over RPC, faked: the draft's checkpoint drawn from where it starts
// to where it ends, a step opened from the canvas and changed as the
// draft's next revision, drawn again from what core answered; and no step
// to change while the latest revision doesn't pass.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Lets every reply already on its way arrive. */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await Promise.resolve();
  }
};

/** A step as core draws it, with nothing in it. */
const task = (id: string, index: number): DiagramTask => ({
  id,
  pointer: `/steps/${index}`,
  kind: "wait",
  label: null,
  detail: null,
  guarded: false,
  next: { kind: "continue" },
  scopes: [],
});

/** A draft at `revision` whose steps wait a minute, drawn as core would. */
const draftOf = (
  revision: number,
  ids: readonly string[],
  passes = true
): WorkflowDraft => {
  const source = JSON.stringify({
    $schema: "https://grasp.work/schemas/grasp-workflow/2.json",
    steps: ids.map((id) => ({ id, type: "wait", for: "1 minute" })),
  });
  const diagram: WorkflowDiagram = { tasks: ids.map(task) };
  return {
    revision,
    source,
    problems: passes
      ? []
      : [
          {
            code: "definition.invalid",
            message: "A step is missing its type.",
            pointer: "/steps/0",
            remedy: "Give the step a type.",
          },
        ],
    diagram: passes ? diagram : null,
  };
};

/** The Flow of `first`, held as the page holds it; where it sends, in `asked`. */
const Page = ({ first, asked }: { first: WorkflowDraft; asked: unknown[] }) => {
  const [draft, setDraft] = useState(first);
  return (
    <WorkflowFlow
      draft={draft}
      onDefinition={() => {
        asked.push("definition");
      }}
      onDraft={setDraft}
      onTriggers={() => {
        asked.push("triggers");
      }}
      workflow="workflow-1"
    />
  );
};

/** The Flow of `first`, as the page holds it; and what core was asked. */
const shown = async (first: WorkflowDraft): Promise<unknown[]> => {
  const asked: unknown[] = [];
  const workflowResources = {
    define: async (id: string, input: unknown) => {
      await Promise.resolve();
      asked.push({ define: id, input });
      return draftOf(first.revision + 1, ["greet", "finished", "added"]);
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
    component: () => <Page asked={asked} first={first} />,
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
    await settled();
  });
  return asked;
};

/** The tasks drawn on the canvas, in order. */
const drawn = (): string[] =>
  [...document.querySelectorAll("[data-ground] li[aria-label]")].map(
    (each) => each.getAttribute("aria-label") ?? ""
  );

/** The button labelled `label`, if there is one. */
const button = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === label ||
      each.textContent.trim() === label
  );

const press = async (label: string): Promise<void> => {
  await act(async () => {
    button(label)?.click();
    await settled();
  });
};

describe("a workflow's Flow", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("draws the draft from where it starts to where it ends, and saves a step changed on it as the next revision", async () => {
    const asked = await shown(draftOf(2, ["greet", "finished"]));
    const before = {
      drawn: drawn(),
      ends: document.querySelector("[data-ground]")?.textContent,
    };
    await press("Change step greet");
    const field = document.querySelector("textarea");
    const opened = field?.value;
    await act(async () => {
      if (field !== null) {
        const prototype = Reflect.getPrototypeOf(field) ?? {};
        Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
          field,
          '{ "type": "wait", "for": "2 minutes" }'
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await settled();
    });
    await press("Check and save");
    await press("See what starts it");
    const read: unknown = JSON.parse(opened ?? "null");

    expect({
      before: {
        drawn: before.drawn,
        starts: before.ends?.startsWith("Starts"),
        ends: before.ends?.endsWith("Done"),
      },
      opened: read,
      asked,
      after: drawn(),
    }).toStrictEqual({
      before: { drawn: ["greet", "finished"], starts: true, ends: true },
      opened: { type: "wait", for: "1 minute" },
      asked: [
        {
          define: "workflow-1",
          input: {
            revision: 2,
            edit: {
              kind: "change",
              pointer: "/steps/0",
              step: { type: "wait", for: "2 minutes" },
            },
          },
        },
        "triggers",
      ],
      after: ["greet", "finished", "added"],
    });
  });

  it("offers no step to change while the draft doesn't pass", async () => {
    await shown(draftOf(2, ["greet"], false));

    expect({
      drawn: drawn(),
      change: button("Change step greet"),
    }).toStrictEqual({ drawn: [], change: undefined });
  });
});

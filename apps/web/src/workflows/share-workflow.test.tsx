// @vitest-environment happy-dom
import type { WorkflowMember } from "@grasp-os/shared/workflow-resources";
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

import { toast, Toaster } from "../grasp/toast/index.ts";
import { ShareWorkflow } from "./share-workflow.tsx";

// The Share dialog of an independent workflow, against core's
// workflowResources as the page reaches them over RPC, faked with the
// members core keeps: a builder shares with exactly whom and in exactly
// the role picked, from the people and teams core offers but its owner
// and whoever has it already; changes a role and unshares; and is told
// what core refuses. Anyone but a builder is offered no Share.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Lets every reply already on its way arrive. */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await Promise.resolve();
  }
};

const candidates = {
  people: [
    { id: "owner", name: "Olive Owner" },
    { id: "ada", name: "Ada" },
    { id: "bo", name: "Bo" },
  ],
  teams: [{ id: "team-1", name: "Finance" }],
  projects: [],
};

/** The dialog for a reader in `role`, core refusing shares with `refuses`: what core was asked. */
const shown = async (
  role: "user" | "builder",
  refuses?: string,
  offering = candidates
): Promise<unknown[]> => {
  const asked: unknown[] = [];
  let members: WorkflowMember[] = [
    {
      type: "person",
      id: "bo",
      role: "user",
      addedBy: "owner",
      addedAt: "2026-10-30T09:00:00.000Z",
    },
  ];
  const workflowResources = {
    shareCandidates: async () => await Promise.resolve(offering),
    members: async () => await Promise.resolve(members),
    share: async (
      workflow: string,
      share: { type: "person" | "team"; id: string; role: "user" | "builder" }
    ) => {
      await Promise.resolve();
      asked.push({ share: workflow, ...share });
      if (refuses !== undefined) {
        throw new Error(refuses);
      }
      members = [
        ...members.filter(
          ({ type, id }) => !(type === share.type && id === share.id)
        ),
        {
          ...share,
          addedBy: "owner",
          addedAt: "2026-10-30T10:00:00.000Z",
        },
      ];
    },
    unshare: async (
      workflow: string,
      member: { type: "person" | "team"; id: string }
    ) => {
      await Promise.resolve();
      asked.push({ unshare: workflow, ...member });
      members = members.filter(
        ({ type, id }) => !(type === member.type && id === member.id)
      );
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
    // With the page's toasts, as the frame has them.
    component: () => (
      <>
        <ShareWorkflow
          resource={{
            id: "workflow-1",
            name: "Invoices",
            owner: "owner",
            role,
          }}
        />
        <Toaster aria-label="Notifications" />
      </>
    ),
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

/** A button's words, as shown: the layer a library Button shows, not the ones it keeps for its width. */
const shownWords = (each: Element): string =>
  (each.querySelector("[data-shown]") ?? each).textContent.trim();

/** The button named `name`, by its label or its text. */
const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === name ||
      (each.getAttribute("aria-label") === null && shownWords(each) === name)
  );

/** Presses the button named `name`, and lets what it does settle. */
const press = async (name: string): Promise<void> => {
  await act(async () => {
    button(name)?.click();
    await settled();
  });
};

/** A label's words, without the mark a required field's label carries. */
const labelWords = (label: HTMLLabelElement): string =>
  [...label.childNodes]
    .filter(
      (node) =>
        !(node instanceof HTMLElement && node.dataset.slot === "required-mark")
    )
    .map((node) => node.textContent)
    .join("")
    .trim();

/** The select named `name`, by its label or its own `aria-label`. */
const select = (name: string): HTMLElement | null => {
  const labelled = [...document.querySelectorAll("label")].find(
    (each) => labelWords(each) === name
  );
  return labelled === undefined
    ? document.querySelector<HTMLElement>(
        `[role="combobox"][aria-label="${CSS.escape(name)}"]`
      )
    : document.querySelector<HTMLElement>(`#${CSS.escape(labelled.htmlFor)}`);
};

/** The options of the open list: each one's value, and its words. */
const openOptions = (): { value: string; text: string }[] =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
    (option) => ({
      value: option.id.split("-option-")[1] ?? "",
      text: option.textContent.trim(),
    })
  );

/** What the select named `name` offers, opened and closed again. */
const options = async (
  name: string
): Promise<{ value: string; text: string }[]> => {
  await act(async () => {
    select(name)?.click();
    await settled();
  });
  const listed = openOptions();
  await act(async () => {
    select(name)?.click();
    await settled();
  });
  return listed;
};

/** Picks `value` in the select named `name`. */
const pick = async (name: string, value: string): Promise<void> => {
  await act(async () => {
    select(name)?.click();
    await settled();
  });
  await act(async () => {
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.id.endsWith(`-option-${value}`))
      ?.click();
    await settled();
  });
};

/** What the select named `name` offers, by value. */
const offered = async (name: string): Promise<string[]> => {
  const listed = await options(name);
  return listed.map(({ value }) => value);
};

describe("sharing an independent workflow from its page", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    // The page's toasts are one queue for the tab: none outlives its test.
    toast.dismiss();
    document.body.replaceChildren();
  });

  it("shares with exactly whom and as what the builder picks, from those it isn't shared with but its owner, then changes a role, unshares and undoes that from the toast", async () => {
    const asked = await shown("builder");
    await press("Share");
    const choices = await offered("Share with");
    await pick("Share with", "person:ada");
    await pick("Role to share with", "builder");
    await act(async () => {
      document
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
      await settled();
    });
    const listed = document.body.textContent.includes("Ada");
    await pick("Role of Bo", "builder");
    await press("Stop sharing with Ada");
    const said = [
      ...document.querySelectorAll('[aria-label="Notifications"] li'),
    ].map((each) => each.textContent.includes("Stopped sharing with Ada"));
    await press("Undo");

    expect({ choices, listed, said, asked }).toStrictEqual({
      // Not its owner, nor Bo, who has it already.
      choices: ["person:ada", "team:team-1"],
      listed: true,
      said: [true],
      asked: [
        { share: "workflow-1", type: "person", id: "ada", role: "builder" },
        { share: "workflow-1", type: "person", id: "bo", role: "builder" },
        { unshare: "workflow-1", type: "person", id: "ada" },
        // Undo shares it again, in the role it had.
        { share: "workflow-1", type: "person", id: "ada", role: "builder" },
      ],
    });
  });

  it("tells apart someone offered from a namesake it is shared with by the end of their ID", async () => {
    await shown("builder", undefined, {
      ...candidates,
      people: [...candidates.people, { id: "user-bo-222333", name: "Bo" }],
    });
    await press("Share");
    const listed = await options("Share with");
    const labels = listed
      .filter(({ value }) => value.startsWith("person:"))
      .map(({ text }) => text);

    // The Bo it is shared with is the only one it lists, so plainly.
    const sharedBo = button("Stop sharing with Bo") !== undefined;
    await pick("Share with", "person:user-bo-222333");
    await act(async () => {
      document
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
      await settled();
    });

    expect({
      labels,
      sharedBo,
      // Shared with both, each is named apart.
      bothBos: [
        button("Stop sharing with Bo (ID …bo)") !== undefined,
        button("Stop sharing with Bo (ID …222333)") !== undefined,
      ],
    }).toStrictEqual({
      labels: ["Ada", "Bo (ID …222333)"],
      sharedBo: true,
      bothBos: [true, true],
    });
  });

  it("says what core refuses", async () => {
    await shown(
      "builder",
      "Only the organization's admins and builders build workflows."
    );
    await press("Share");
    await pick("Role of Bo", "builder");

    expect(document.body.textContent).toContain(
      "Only the organization's admins and builders build workflows."
    );
  });

  it("offers no Share to someone who doesn't build the workflow", async () => {
    await shown("user");

    expect(button("Share")).toBeUndefined();
  });
});

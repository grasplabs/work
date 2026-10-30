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
};

/** The dialog for a reader in `role`, core refusing shares with `refuses`: what core was asked. */
const shown = async (
  role: "user" | "builder",
  refuses?: string
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
    shareCandidates: async () => await Promise.resolve(candidates),
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
    component: () => (
      <ShareWorkflow
        resource={{
          id: "workflow-1",
          name: "Invoices",
          owner: "owner",
          role,
        }}
      />
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

/** The button named `name`, by its label or its text. */
const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === name ||
      (each.getAttribute("aria-label") === null &&
        each.textContent.trim() === name)
  );

/** Presses the button named `name`, and lets what it does settle. */
const press = async (name: string): Promise<void> => {
  await act(async () => {
    button(name)?.click();
    await settled();
  });
};

/** The select named `name`, by its label or its own `aria-label`. */
const select = (name: string): HTMLSelectElement | null => {
  const labelled = [...document.querySelectorAll("label")].find(
    (each) => each.textContent.trim() === name
  );
  return labelled === undefined
    ? document.querySelector<HTMLSelectElement>(
        `select[aria-label="${CSS.escape(name)}"]`
      )
    : document.querySelector<HTMLSelectElement>(
        `#${CSS.escape(labelled.htmlFor)}`
      );
};

/** Picks `value` in the select named `name`. */
const pick = async (name: string, value: string): Promise<void> => {
  await act(async () => {
    const chosen = select(name);
    if (chosen !== null) {
      chosen.value = value;
      chosen.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await settled();
  });
};

/** What the select named `name` offers, by value. */
const offered = (name: string): string[] =>
  [...(select(name)?.options ?? [])]
    .map(({ value }) => value)
    .filter((value) => value !== "");

describe("sharing an independent workflow from its page", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("shares with exactly whom and as what the builder picks, from those it isn't shared with but its owner, then changes a role and unshares", async () => {
    const asked = await shown("builder");
    await press("Share");
    const choices = offered("Share with");
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

    expect({ choices, listed, asked }).toStrictEqual({
      // Not its owner, nor Bo, who has it already.
      choices: ["person:ada", "team:team-1"],
      listed: true,
      asked: [
        { share: "workflow-1", type: "person", id: "ada", role: "builder" },
        { share: "workflow-1", type: "person", id: "bo", role: "builder" },
        { unshare: "workflow-1", type: "person", id: "ada" },
      ],
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

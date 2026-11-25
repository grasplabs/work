// @vitest-environment happy-dom
import type { Member } from "@grasp-os/shared/members";
import type { Role } from "@grasp-os/shared/roles";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import { Route } from "../routes/_shell.settings.members.tsx";

// Settings › Members and roles through its route, against core's members
// faked: a role is changed from the member's row, and making someone an
// admin, who may then change anyone's role and remove anyone, asks first;
// turned down, nothing is sent; confirmed, core is asked once.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const me: Member = {
  userId: "me",
  name: "Sanne",
  email: "sanne@acme.test",
  role: "admin",
  joinedAt: "2026-10-01T09:00:00.000Z",
  suspension: null,
};

const ada: Member = {
  userId: "ada",
  name: "Ada",
  email: "ada@acme.test",
  role: "user",
  joinedAt: "2026-10-02T09:00:00.000Z",
  suspension: null,
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

/** Anything else the page reads: refused, so it shows nothing of it. */
const notHere = async (): Promise<never> => {
  await Promise.resolve();
  throw new Error("Not in this test");
};

/** The page, for an admin, with Ada a user: every role core was asked to set. */
const shown = async (): Promise<[string, Role][]> => {
  const set: [string, Role][] = [];
  let members = [me, ada];
  const known = {
    members: {
      list: async () => await Promise.resolve(members),
      invitations: async () => await Promise.resolve([]),
      guests: async () => await Promise.resolve([]),
      removed: async () => await Promise.resolve({ people: [], more: false }),
      setRole: async (userId: string, role: Role): Promise<void> => {
        await Promise.resolve();
        set.push([userId, role]);
        members = members.map((each) =>
          each.userId === userId ? { ...each, role } : each
        );
      },
    },
  };
  // What the test gives, else refused.
  const session = new Proxy(known, {
    get: (target, name) => {
      const part: unknown = Reflect.get(target, name);
      return new Proxy(typeof part === "object" && part !== null ? part : {}, {
        get: (methods, method) => {
          const given: unknown = Reflect.get(methods, method);
          return given ?? notHere;
        },
      });
    },
  });
  const core = {
    withSession: async <T,>(
      action: (given: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const top = createRootRoute();
  // The shell's part: who is signed in, in the page's context.
  const shell = createRoute({
    getParentRoute: () => top,
    id: "_shell",
    beforeLoad: () => ({ identity: { userId: me.userId } }),
  });
  const pageAt = {
    id: "/settings/members",
    path: "/settings/members",
    getParentRoute: () => shell,
  };
  // SAFETY: a place in the tree, as routeTree.gen.ts gives each route.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const page = Route.update(pageAt as Parameters<typeof Route.update>[0]);
  const router = createRouter({
    routeTree: top.addChildren([shell.addChildren([page])]),
    history: createMemoryHistory({ initialEntries: ["/settings/members"] }),
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
  return set;
};

const press = async (element: Element | null | undefined): Promise<void> => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** Chooses `role` for Ada from the role on her row, as a person does. */
const choose = async (role: string): Promise<void> => {
  const control = document.querySelector<HTMLElement>(
    '[aria-label="Role of Ada (ada@acme.test)"]'
  );
  await press(control);
  const list = document.querySelector(
    `[id="${control?.getAttribute("aria-controls") ?? ""}"]`
  );
  const option = [
    ...(list ?? document).querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((each) => each.textContent.trim().startsWith(role));
  await press(option);
};

/** The question open over the page, if any: its title. */
const asked = (): string | undefined =>
  document.querySelector('[role="alertdialog"] h2')?.textContent?.trim() ??
  undefined;

/** The open question's button that says `text` (its words for a failure wait unseen after them). */
const answer = (text: string): HTMLElement | undefined =>
  [
    ...document.querySelectorAll<HTMLElement>('[role="alertdialog"] button'),
  ].find((each) => each.textContent.trim().startsWith(text));

/** Takes the page away. */
const unmounted = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
};

describe("Settings › Members and roles", () => {
  // The page's own file loads once, before the first test's clock starts.
  beforeAll(async () => {
    await shown();
    unmounted();
  }, 60_000);

  afterEach(unmounted);

  it("changes a role from the member's row at once, but asks before making someone an admin", async () => {
    const set = await shown();
    await choose("Builder");
    const builder = { set: [...set], asked: asked() };

    await choose("Admin");
    const promote = { set: [...set], asked: asked() };
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      await Promise.resolve();
    });
    await settled();
    const turnedDown = { set: [...set], asked: asked() };

    await choose("Admin");
    await press(answer("Make admin"));

    expect({ builder, promote, turnedDown, set, asked: asked() }).toStrictEqual(
      {
        builder: { set: [["ada", "builder"]], asked: undefined },
        promote: { set: [["ada", "builder"]], asked: "Make Ada an admin?" },
        turnedDown: { set: [["ada", "builder"]], asked: undefined },
        set: [
          ["ada", "builder"],
          ["ada", "admin"],
        ],
        asked: undefined,
      }
    );
  });
});

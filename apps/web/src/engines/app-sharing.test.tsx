// @vitest-environment happy-dom
import type {
  AppMember,
  AppMemberRef,
  NewAppMember,
  ShareCandidates,
  ViewedApp,
} from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
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

import { AppMembers } from "./app-sharing.tsx";

// Sharing a domain's App on its Members tab, against core's App members
// API as the page reaches it over RPC (the boundary from the web app),
// faked: it keeps whom the App is shared with and in which role, answers
// the tab's next read with it, and offers the organization's people and
// teams to share with.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const app = (role: ViewedApp["role"], owner = "user-owner"): ViewedApp => ({
  id: appIdSchema.parse("app-1"),
  name: "Desk",
  description: "",
  owner,
  responsible: owner,
  audience: null,
  blueprint: null,
  currentVersion: 1,
  pendingVersion: null,
  status: "published",
  process: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  role,
});

const viewer: Identity = {
  userId: "user-owner",
  email: "olga@acme.test",
  name: "Olga Owner",
  role: "builder",
  teams: [],
  staff: false,
  expiresAt: "2026-11-01T09:00:00.000Z",
};

const candidates: ShareCandidates = {
  people: [
    { id: "user-owner", name: "Olga Owner" },
    { id: "user-ann", name: "Ann" },
    { id: "user-bo", name: "Bo" },
  ],
  teams: [{ id: "team-sales", name: "Sales" }],
};

/** Core's App members, kept as builders change them, and each change asked. */
const fakeMembers = (initial: AppMember[] = []) => {
  const asked: unknown[][] = [];
  let kept = initial;
  const nameOf = ({ type, id }: AppMemberRef): string =>
    (type === "team" ? candidates.teams : candidates.people).find(
      (each) => each.id === id
    )?.name ?? id;
  const members = {
    list: async (): Promise<AppMember[]> => {
      await Promise.resolve();
      return kept;
    },
    candidates: async (): Promise<ShareCandidates> => {
      await Promise.resolve();
      return candidates;
    },
    add: async (_app: string, member: NewAppMember): Promise<AppMember> => {
      await Promise.resolve();
      asked.push(["add", member.type, member.id, member.role]);
      const added: AppMember = {
        type: member.type,
        id: member.id,
        name: nameOf(member),
        role: member.role,
        addedBy: "user-owner",
        addedAt: "2026-10-30T09:00:00.000Z",
      };
      kept = [
        ...kept.filter(
          (each) => !(each.type === member.type && each.id === member.id)
        ),
        added,
      ];
      return added;
    },
    remove: async (_app: string, member: AppMemberRef): Promise<void> => {
      await Promise.resolve();
      asked.push(["remove", member.type, member.id]);
      kept = kept.filter(
        (each) => !(each.type === member.type && each.id === member.id)
      );
    },
  };
  return { session: { apps: { members } }, asked };
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

/** The Members tab on what `session` holds, for `viewed`. */
const shown = async (
  session: ReturnType<typeof fakeMembers>["session"],
  viewed: ViewedApp
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    loader: async () => await session.apps.members.list(),
    component: () => (
      <AppMembers
        app={viewed}
        identity={viewer}
        members={rootRoute.useLoaderData()}
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
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.textContent?.trim() === name ||
      each.getAttribute("aria-label") === name
  );

/** The names offered in the open Share list. */
const offered = (): string[] =>
  [...document.querySelectorAll("[cmdk-item]")].map(
    (each) => each.querySelector("span.truncate")?.textContent ?? ""
  );

/** Who the table lists, as shown. */
const listed = (): string[] =>
  [...document.querySelectorAll("tbody tr td:first-child")].map(
    (cell) => cell.textContent?.trim() ?? ""
  );

describe("Sharing a domain's App", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("lets a builder share it with a person and a team, offering only who it isn't shared with yet", async () => {
    const { session, asked } = fakeMembers();
    await shown(session, app("builder"));
    expect(document.body.textContent).toContain("It isn’t shared with anyone.");

    await press(button("Share"));
    const first = offered();
    await press(
      [...document.querySelectorAll("[cmdk-item]")].find((each) =>
        each.textContent?.includes("Ann")
      )
    );
    await press(button("Share"));
    const second = offered();
    await press(
      [...document.querySelectorAll("[cmdk-item]")].find((each) =>
        each.textContent?.includes("Sales")
      )
    );

    expect({ first, second, asked, listed: listed() }).toStrictEqual({
      // Never the owner, who always opens it.
      first: ["Ann", "Bo", "Sales"],
      second: ["Bo", "Sales"],
      asked: [
        ["add", "person", "user-ann", "user"],
        ["add", "team", "team-sales", "user"],
      ],
      listed: ["Ann", "Sales (team)"],
    });
  });

  it("lets a builder unshare it, only once they confirm", async () => {
    const { session, asked } = fakeMembers([
      {
        type: "person",
        id: "user-ann",
        name: "Ann",
        role: "user",
        addedBy: "user-owner",
        addedAt: "2026-10-30T09:00:00.000Z",
      },
    ]);
    await shown(session, app("builder"));

    await press(button("Stop sharing with Ann"));
    await press(button("Cancel"));
    const afterCancel = [...asked];
    await press(button("Stop sharing with Ann"));
    await press(button("Stop sharing"));

    expect({ afterCancel, asked, listed: listed() }).toStrictEqual({
      afterCancel: [],
      asked: [["remove", "person", "user-ann"]],
      listed: [],
    });
  });

  it("shows someone it is shared with as a user whom it is shared with, and nothing they can change", async () => {
    const { session } = fakeMembers([
      {
        type: "team",
        id: "team-sales",
        name: "Sales",
        role: "builder",
        addedBy: "user-owner",
        addedAt: "2026-10-30T09:00:00.000Z",
      },
    ]);
    await shown(session, app("user", "user-someone-else"));

    expect({
      listed: listed(),
      share: button("Share"),
      unshare: button("Stop sharing with Sales (team)"),
      owner: document.body.textContent?.includes("user-someone-else"),
    }).toStrictEqual({
      listed: ["Sales (team)"],
      share: undefined,
      unshare: undefined,
      // The owner is never shown by a raw ID.
      owner: false,
    });
  });
});

// @vitest-environment happy-dom
import { appErrors } from "@grasp-os/shared/apps";
import type { ViewedApp } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import type {
  NewSubjectMember,
  ShareCandidates,
  SubjectMember,
  SubjectMemberRef,
} from "@grasp-os/shared/subject-members";
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

import { sharesApp } from "../apps/app-role.ts";
import { Sharing } from "./sharing.tsx";

// Sharing, in an App's or a workflow's settings, against core's members
// API as the page reaches it over RPC (the boundary from the web app),
// faked alike for both kinds: it keeps whom it is shared with and in
// which role, answers the next read with it, and offers the
// organization's people and teams to share with.

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
  liveLabel: "26.11.1",
  archived: false,
  process: null,
  link: null,
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
  projects: [],
};

/** Core's App members, kept as builders change them, and each change asked. */
const fakeMembers = (
  initial: SubjectMember[] = [],
  offering: ShareCandidates = candidates
) => {
  const asked: unknown[][] = [];
  let kept = initial;
  const nameOf = ({ type, id }: SubjectMemberRef): string =>
    (type === "team" ? offering.teams : offering.people).find(
      (each) => each.id === id
    )?.name ?? id;
  const members = {
    list: async (): Promise<SubjectMember[]> => {
      await Promise.resolve();
      return kept;
    },
    candidates: async (): Promise<ShareCandidates> => {
      await Promise.resolve();
      return offering;
    },
    add: async (
      _app: string,
      member: NewSubjectMember
    ): Promise<SubjectMember> => {
      await Promise.resolve();
      asked.push(["add", member.type, member.id, member.role]);
      const added: SubjectMember = {
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
    remove: async (_app: string, member: SubjectMemberRef): Promise<void> => {
      await Promise.resolve();
      asked.push(["remove", member.type, member.id]);
      kept = kept.filter(
        (each) => !(each.type === member.type && each.id === member.id)
      );
    },
  };
  return {
    session: { apps: { members }, workflowResources: { members } },
    asked,
  };
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

/** Sharing on what `session` holds, for `viewed`, as an App or a workflow. */
const shown = async (
  session: ReturnType<typeof fakeMembers>["session"],
  viewed: ViewedApp,
  kind: "app" | "workflow" = "app"
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <Sharing
        editable={sharesApp(viewed, viewer)}
        identity={viewer}
        owner={viewed.owner}
        subject={{ kind, id: viewed.id }}
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

/** What a button says, without the words it keeps hidden for working or failed. */
const words = (element: Element): string => {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) {
    return "";
  }
  for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) {
    hidden.remove();
  }
  return copy.textContent?.trim() ?? "";
};

const button = (name: string, within: ParentNode = document) =>
  [...within.querySelectorAll("button")].find(
    (each) => words(each) === name || each.getAttribute("aria-label") === name
  );

/** The picker's field. */
const field = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>(
    "input[aria-label='Add people, teams or projects']"
  );

/** Opens the picker's list, as the person does by typing in its field. */
const openPicker = async (): Promise<void> => {
  const box = field();
  if (box === null) {
    throw new TypeError("No picker");
  }
  await act(async () => {
    box.focus();
    box.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
    );
    await Promise.resolve();
  });
  await settled();
};

/** The options the picker's list shows, each as its lines read. */
const optionLines = (): string[] =>
  [...document.querySelectorAll("[role=option]")].map(words);

/** Picks the option that says `text`. */
const pickOption = async (text: string): Promise<void> => {
  await press(
    [...document.querySelectorAll("[role=option]")].find((each) =>
      each.textContent?.includes(text)
    )
  );
};

/** Who the list shows it is shared with, by name: each row's face, then its words. */
const listed = (): string[] =>
  [
    ...document.querySelectorAll(
      "[data-share-member], [aria-label='Shared with'] [data-slot=item]"
    ),
  ].map((row) => {
    const name = row.children[1]?.firstElementChild;
    return name ? words(name) : "";
  });

describe("Sharing an App or a workflow", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("lets a builder share it with a person and a team at once, never offering its owner, and marks who has it", async () => {
    const { session, asked } = fakeMembers();
    await shown(session, app("builder"));

    await openPicker();
    const first = optionLines();
    await pickOption("Ann");
    await pickOption("Sales");
    await press(button("Add"));
    await openPicker();
    const second = optionLines();

    expect({ first, second, asked, listed: listed() }).toStrictEqual({
      first: ["Ann", "Bo", "Sales (team)"],
      second: ["AnnHas access", "Bo", "Sales (team)Has access"],
      asked: [
        ["add", "person", "user-ann", "user"],
        ["add", "team", "team-sales", "user"],
      ],
      listed: ["Ann", "Sales (team)"],
    });
  });

  it("shares a workflow alike, through its own members", async () => {
    const { session, asked } = fakeMembers();
    await shown(session, app("builder"), "workflow");

    await openPicker();
    await pickOption("Bo");
    await press(button("Add"));

    expect({ asked, listed: listed() }).toStrictEqual({
      asked: [["add", "person", "user-bo", "user"]],
      listed: ["Bo"],
    });
  });

  it("tells apart people of the same name by the end of their ID, in the picker and whom it is shared with", async () => {
    const { session, asked } = fakeMembers([], {
      people: [
        { id: "user-eva-0000aaaaaa", name: "Eva de Vries" },
        { id: "user-eva-1111bbbbbb", name: "eva  de \u200BVries" },
        { id: "user-bo", name: "Bo" },
      ],
      teams: [],
      projects: [],
    });
    await shown(session, app("builder"));

    await openPicker();
    const offered = optionLines();
    await pickOption("bbbbbb");
    await pickOption("aaaaaa");
    await press(button("Add"));

    expect({ offered, asked, listed: listed() }).toStrictEqual({
      // Bo's name is theirs alone, so it says nothing more.
      offered: [
        "Eva de VriesID …aaaaaa",
        "eva  de \u200BVriesID …bbbbbb",
        "Bo",
      ],
      asked: [
        ["add", "person", "user-eva-1111bbbbbb", "user"],
        ["add", "person", "user-eva-0000aaaaaa", "user"],
      ],
      listed: ["eva  de \u200BVries (ID …bbbbbb)", "Eva de Vries (ID …aaaaaa)"],
    });
  });

  it("marks a guest where they are offered and among whom it is shared with, and says plainly why sharing with one is refused", async () => {
    const { session } = fakeMembers(
      [
        {
          type: "person",
          id: "user-gil",
          name: "Gil",
          role: "user",
          addedBy: "user-owner",
          addedAt: "2026-10-30T09:00:00.000Z",
          guest: true,
        },
      ],
      {
        people: [
          { id: "user-gus", name: "Gus", guest: true },
          { id: "user-bo", name: "Bo" },
        ],
        teams: [],
        projects: [],
      }
    );
    // Core refuses a builder an App that holds a source (GRA-2235).
    session.apps.members.add = async (): Promise<SubjectMember> => {
      await Promise.resolve();
      throw appErrors.create("app.guest_sources");
    };
    await shown(session, app("builder"));

    const gil = [
      ...document.querySelectorAll(
        "[data-share-member], [aria-label='Shared with'] [data-slot=item]"
      ),
    ].map((row) => row.textContent);
    await openPicker();
    const options = optionLines();
    await pickOption("Gus");
    await press(button("Add"));

    expect({
      options,
      gil,
      refused: document.body.textContent?.includes(
        appErrors.create("app.guest_sources").message
      ),
    }).toStrictEqual({
      options: ["GusGuest", "Bo"],
      // Their initial, name, mark and role.
      gil: ["GGilGuestUser"],
      refused: true,
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

    const remove = async (): Promise<void> => {
      await press(button("Access for Ann"));
      await press(
        [...document.querySelectorAll("[role=option]")].find(
          (each) => words(each) === "Remove"
        )
      );
    };
    await remove();
    await press(button("Cancel"));
    const afterCancel = [...asked];
    await remove();
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

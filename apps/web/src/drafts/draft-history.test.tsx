// @vitest-environment happy-dom
import type { AppVersion, FileDiff, ViewedApp } from "@grasp-os/shared/apps";
import type { Draft, DraftCheckpoint } from "@grasp-os/shared/drafts";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
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

import { RemoveApp } from "../apps/app-remove.tsx";
import { buildsApp } from "../apps/app-role.ts";
import { DraftHistory } from "./draft-history.tsx";

// An App's History and deleting an archived App, against core's Apps,
// drafts and versions APIs as the page reaches them over RPC (the
// boundary from the web app), faked: they keep which version is live,
// the App's draft and its checkpoints, and whether the App is still
// there, and answer the page's next read with that. A workflow's
// History is the same component, on its own subject.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const appId = appIdSchema.parse("app-1");

const versionOf = (number: number): AppVersion => ({
  app: appId,
  version: number,
  label: `26.10.${number}`,
  parent: number === 1 ? null : number - 1,
  tree: `tree-${number}`,
  files: 3,
  author: "user-owner",
  message: `Change ${number}`,
  createdAt: `2026-10-0${number}T09:00:00.000Z`,
});

/** A checkpoint of the draft over version 2. */
const point = (
  number: number,
  of: Partial<DraftCheckpoint>
): DraftCheckpoint => ({
  number,
  revision: number + 2,
  base: 2,
  contentHash: `hash-${number}`,
  personId: "person-ann",
  chatId: null,
  callId: null,
  restoredFrom: null,
  createdAt: "2026-11-09T10:00:00.000Z",
  touched: [],
  changes: 1,
  ...of,
});

/**
 * The draft's checkpoints, newest first: Grasp's in Ann's chat, Ben's own
 * edit, the one publishing version 2 left (changing nothing), and one of
 * work published before.
 */
const points: DraftCheckpoint[] = [
  point(4, {
    chatId: "chat-ann",
    touched: ["src/routes/index.tsx", "server/notes.ts"],
    changes: 2,
  }),
  point(3, { personId: "person-ben", touched: ["src/routes/index.tsx"] }),
  point(2, { changes: 0 }),
  point(1, { base: 1, touched: ["src/routes/old.tsx"] }),
];

const person = (
  userId: string,
  role: Identity["role"],
  staff = false
): Identity => ({
  userId,
  email: `${userId}@acme.test`,
  name: userId,
  role,
  teams: [],
  staff,
  expiresAt: "2026-11-01T09:00:00.000Z",
});

/**
 * Core's Apps API on one App with three versions, its draft at revision 7
 * (changing `changed`), and each change asked.
 */
const fakeApps = ({
  role,
  archived = false,
  current = 2,
  changed = [],
  refusal,
  versions: listed = [versionOf(3), versionOf(2), versionOf(1)],
  history = points,
}: {
  role: ViewedApp["role"];
  archived?: boolean;
  current?: number;
  changed?: string[];
  /** How core refuses publishing a version, if it does. */
  refusal?: Error;
  /** The App's versions, newest first. */
  versions?: AppVersion[];
  /** The draft's checkpoints, newest first. */
  history?: DraftCheckpoint[];
}) => {
  const asked: unknown[][] = [];
  let app: ViewedApp = {
    id: appId,
    name: "Desk",
    description: "",
    owner: "user-owner",
    responsible: "user-owner",
    audience: null,
    blueprint: null,
    currentVersion: current,
    liveLabel: `26.10.${current}`,
    archived,
    process: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    role,
    link: null,
  };
  let draft: Draft = {
    subject: { kind: "app", id: appId },
    base: current,
    changed,
    deleted: [],
    definitionChanged: false,
    revision: 7,
    updatedAt: "2026-11-09T10:00:00.000Z",
    updatedBy: "person-ann",
  };
  let removed = false;
  const apps = {
    get: async (): Promise<ViewedApp> => {
      await Promise.resolve();
      return app;
    },
    remove: async (id: string): Promise<void> => {
      await Promise.resolve();
      asked.push(["remove", id]);
      removed = true;
    },
    releases: {
      // No version sealed: nothing revoked or held.
      list: async (): Promise<[]> => {
        await Promise.resolve();
        return [];
      },
    },
  };
  const versions = {
    list: async (
      _subject: { kind: string; id: string },
      _before?: number
    ): Promise<AppVersion[]> => {
      await Promise.resolve();
      return listed;
    },
    diff: async (
      { id }: { kind: string; id: string },
      from: number,
      to: number
    ): Promise<FileDiff[]> => {
      await Promise.resolve();
      asked.push(["diff", id, from, to]);
      return [{ path: "src/routes/index.tsx", change: "added", after: "" }];
    },
    rollback: async (
      { id }: { kind: string; id: string },
      to: number,
      revision?: number,
      expected?: number | null
    ) => {
      await Promise.resolve();
      asked.push(["rollback", id, to, revision, expected]);
      if (refusal !== undefined) {
        throw refusal;
      }
      app = { ...app, currentVersion: to, liveLabel: `26.10.${to}` };
      return {
        subject: { kind: "app", id },
        version: to,
        label: `26.10.${to}`,
      };
    },
  };
  const drafts = {
    get: async (): Promise<Draft> => {
      await Promise.resolve();
      return draft;
    },
    // Followed, and never written meanwhile.
    watch: async () =>
      await Promise.resolve({
        release: async () => {
          await Promise.resolve();
        },
        [Symbol.dispose]: () => {},
      }),
    checkpoints: async (): Promise<DraftCheckpoint[]> =>
      await Promise.resolve(history),
    restore: async (
      { id }: { kind: string; id: string },
      number: number,
      revision: number
    ) => {
      await Promise.resolve();
      asked.push(["restore", id, number, revision]);
      draft = { ...draft, revision: revision + 1 };
      return points[0];
    },
    discard: async ({ id }: { kind: string; id: string }, revision: number) => {
      await Promise.resolve();
      asked.push(["discard", id, revision]);
      draft = { ...draft, changed: [], revision: revision + 1 };
    },
  };
  const members = {
    list: async () =>
      await Promise.resolve([
        { userId: "person-ann", name: "Ann" },
        { userId: "person-ben", name: "Ben" },
      ]),
  };
  return {
    session: { apps, versions, drafts, members },
    asked,
    removed: () => removed,
  };
};

let root: Root | undefined;

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 10);
    await promise;
  });
};

/** The App's page, its History and its Delete, for `viewer`. */
const shown = async (
  session: ReturnType<typeof fakeApps>["session"],
  viewer: Identity
) => {
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    loader: async () => await session.apps.get(),
    component: () => {
      const app: ViewedApp = page.useLoaderData();
      return (
        <>
          <RemoveApp app={app} identity={viewer} />
          <DraftHistory
            builds={buildsApp(app, viewer) && !app.archived}
            identity={viewer}
            live={app.currentVersion}
            subject={{ kind: "app", id: app.id }}
          />
        </>
      );
    },
  });
  const apps = createRoute({
    getParentRoute: () => rootRoute,
    path: "/apps",
    component: () => <p>Apps</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, apps]),
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
  return router;
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

const button = (name: string, within: ParentNode = document) =>
  [...within.querySelectorAll("button")].find(
    (each) =>
      each.textContent?.trim() === name ||
      each.getAttribute("aria-label") === name
  );

const menuItem = (name: string) =>
  [...document.querySelectorAll('[role="menuitem"]')].find(
    (each) => each.textContent?.trim() === name
  );

/** The section titled `title`. */
const section = (id: "draft-unpublished" | "draft-published") =>
  document.querySelector(`section[aria-labelledby="${id}"]`);

/** What each line of a section says first: its title. */
const titles = (id: "draft-unpublished" | "draft-published"): string[] =>
  [...(section(id)?.querySelectorAll('[data-slot="item-title"]') ?? [])].map(
    (title) => title.textContent?.trim() ?? ""
  );

/** A published version's label, before what it is marked. */
const labelled = /^26\.10\.(?<number>\d+)/u;

describe("An App's History", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("lists the draft's unpublished changes since the last publish, newest first: who, how and what each touched", async () => {
    const { session } = fakeApps({
      role: "builder",
      changed: ["src/routes/index.tsx"],
    });
    await shown(session, person("user-owner", "builder"));

    expect({
      lines: titles("draft-unpublished"),
      touched: section("draft-unpublished")?.textContent.includes(
        "src/routes/index.tsx and server/notes.ts"
      ),
    }).toStrictEqual({
      lines: ["Grasp, in Ann's chatNow", "Ben edited it"],
      touched: true,
    });
  });

  it("shows no unpublished changes while the draft has none and none were undone", async () => {
    // Its newest point is the one publishing version 2 left.
    const { session } = fakeApps({ role: "builder", history: points.slice(2) });
    await shown(session, person("user-owner", "builder"));

    expect({
      unpublished: section("draft-unpublished"),
      published: titles("draft-published"),
    }).toStrictEqual({
      unpublished: null,
      published: ["26.10.3", "26.10.2Your team has this one", "26.10.1"],
    });
  });

  it("keeps the undo points of changes undone, each to see and restore, as Undo changes promised", async () => {
    // Undone: the draft changes nothing, its points since version 2 stay.
    const { session, asked } = fakeApps({ role: "builder" });
    await shown(session, person("user-owner", "builder"));
    const unpublished = section("draft-unpublished") ?? document;
    const seeIt = [...unpublished.querySelectorAll("a")].filter(
      (link) => link.textContent.trim() === "See it"
    ).length;

    await press(button("Restore", unpublished));
    await press(
      button(
        "Restore",
        document.querySelector('[role="alertdialog"]') ?? document
      )
    );

    expect({
      heading: unpublished.querySelector("h3")?.textContent,
      lines: titles("draft-unpublished"),
      seeIt,
      undo: button("Undo changes", unpublished),
      asked,
    }).toStrictEqual({
      heading: "Undone changes",
      // None is the draft now: each can be brought back.
      lines: ["Grasp, in Ann's chat", "Ben edited it"],
      seeIt: 2,
      undo: undefined,
      asked: [["restore", appId, 4, 7]],
    });
  });

  it("restores an earlier state over the revision seen, and discards the draft, each only once the person confirms", async () => {
    const { session, asked } = fakeApps({
      role: "builder",
      changed: ["src/routes/index.tsx"],
    });
    await shown(session, person("user-owner", "builder"));
    const unpublished = section("draft-unpublished") ?? document;

    await press(button("Restore", unpublished));
    await press(button("Cancel"));
    const afterCancel = [...asked];
    await press(button("Restore", unpublished));
    await press(
      button(
        "Restore",
        document.querySelector('[role="alertdialog"]') ?? document
      )
    );
    await press(button("Undo changes"));
    await press(
      button(
        "Undo changes",
        document.querySelector('[role="alertdialog"]') ?? document
      )
    );

    expect({ afterCancel, asked }).toStrictEqual({
      afterCancel: [],
      asked: [
        ["restore", appId, 3, 7],
        ["discard", appId, 8],
      ],
    });
  });

  it("opens an earlier state, and a published version, in the workspace's preview, read-only", async () => {
    const { session } = fakeApps({
      role: "builder",
      changed: ["src/routes/index.tsx"],
    });
    await shown(session, person("user-owner", "builder"));
    const preview = [
      ...(section("draft-unpublished")?.querySelectorAll("a") ?? []),
    ].find((link) => link.textContent.trim() === "See it");
    await press(button("Actions for 26.10.1"));
    const version = menuItem("See this version");

    expect({
      point: preview?.getAttribute("href"),
      version: version?.getAttribute("href"),
    }).toStrictEqual({
      point: "/apps/app-1?point=3",
      version: "/apps/app-1?version=1",
    });
  });

  it("shows what a version changed against the one it was made from", async () => {
    const { session, asked } = fakeApps({ role: "builder" });
    await shown(session, person("user-owner", "builder"));

    await press(button("Actions for 26.10.3"));
    await press(menuItem("View changes"));

    expect({
      asked,
      shown: document
        .querySelector('[data-slot="sheet-content"]')
        ?.textContent.includes("src/routes/index.tsx"),
    }).toStrictEqual({ asked: [["diff", appId, 2, 3]], shown: true });
  });

  it("lets a builder roll back, over the draft as read, only once they confirm", async () => {
    const { session, asked } = fakeApps({ role: "builder" });
    await shown(session, person("user-owner", "builder"));

    await press(button("Actions for 26.10.1"));
    await press(menuItem("Go back to this version"));
    await press(button("Cancel"));
    const afterCancel = [...asked];
    await press(button("Actions for 26.10.1"));
    await press(menuItem("Go back to this version"));
    const said = document.body.textContent;
    await press(button("Go back"));

    expect({
      afterCancel,
      titled: said.includes("Go back to 26.10.1?"),
      warned: said.includes("wait for an admin to grant them again"),
      asked,
      listed: titles("draft-published"),
    }).toStrictEqual({
      afterCancel: [],
      titled: true,
      warned: true,
      asked: [["rollback", appId, 1, 7, 2]],
      listed: ["26.10.3", "26.10.2", "26.10.1Your team has this one"],
    });
  });

  it("says a version never live was created, not published, and names it without a label", async () => {
    const { session } = fakeApps({
      role: "builder",
      versions: [versionOf(2), { ...versionOf(1), label: null }],
    });
    await shown(session, person("user-owner", "builder"));
    const listed = titles("draft-published");
    const created = document.body.textContent.includes("You created it");

    await press(button("Actions for the version not shared yet"));
    await press(menuItem("Go back to this version"));

    expect({
      listed,
      created,
      titled: document.body.textContent.includes("Go back to this version?"),
    }).toStrictEqual({
      listed: ["26.10.2Your team has this one", "Not shared yet"],
      created: true,
      titled: true,
    });
  });

  it("says a roll back discards the draft's unpublished changes, and goes over that draft", async () => {
    const { session, asked } = fakeApps({
      role: "builder",
      changed: ["server/notes.ts"],
    });
    await shown(session, person("user-owner", "admin"));

    await press(button("Actions for 26.10.1"));
    await press(menuItem("Go back to this version"));
    const said = document.body.textContent.includes(
      "The changes only you see are dropped"
    );
    await press(button("Go back"));

    expect({ said, asked }).toStrictEqual({
      said: true,
      asked: [["rollback", appId, 1, 7, 2]],
    });
  });

  it("says in the page's words why a roll back was refused, naming the versions that still fit, and keeps the live one", async () => {
    const { session } = fakeApps({
      role: "builder",
      refusal: Object.assign(
        new Error("This version's schema no longer fits."),
        {
          code: "migration.rollback_incompatible",
          details: { compatible: [2], labels: ["26.10.2"] },
        }
      ),
    });
    await shown(session, person("user-owner", "builder"));

    await press(button("Actions for 26.10.1"));
    await press(menuItem("Go back to this version"));
    await press(button("Go back"));

    expect({
      said: document.body.textContent.includes(
        "Versions that still fit them: 26.10.2."
      ),
      listed: titles("draft-published"),
    }).toStrictEqual({
      said: true,
      listed: ["26.10.3", "26.10.2Your team has this one", "26.10.1"],
    });
  });

  it("drops an older page still on its way when the versions move, and goes on from the newest", async () => {
    const total = 250;
    const numbered = (number: number): AppVersion => ({
      ...versionOf(1),
      version: number,
      label: `26.10.${number}`,
      parent: number === 1 ? null : number - 1,
      tree: `tree-${number}`,
      message: `Change ${number}`,
      createdAt: new Date(Date.UTC(2026, 9, 1) + number * 60_000).toISOString(),
    });
    const { session } = fakeApps({ role: "builder", current: total });
    // The third page waits until the test lets it answer.
    const third = Promise.withResolvers<boolean>();
    session.versions.list = async (
      _subject: { kind: string; id: string },
      before?: number
    ): Promise<AppVersion[]> => {
      if (before === 51) {
        await third.promise;
      }
      const top = before === undefined ? total : before - 1;
      return Array.from({ length: Math.min(100, top) }, (_, at) =>
        numbered(top - at)
      );
    };
    await shown(session, person("user-owner", "builder"));
    await press(button("Show older versions"));
    await press(button("Show older versions"));

    // The versions move while the third page is read: the newest page is
    // read again, and the third, answering after, continues nothing.
    await press(button("Actions for 26.10.200"));
    await press(menuItem("Go back to this version"));
    await press(button("Go back"));
    await act(async () => {
      third.resolve(true);
      await Promise.resolve();
    });
    await settled();
    const numbers = titles("draft-published").map((title) =>
      Number(labelled.exec(title)?.groups?.number)
    );

    expect({
      count: numbers.length,
      first: numbers[0],
      last: numbers.at(-1),
      older: button("Show older versions") !== undefined,
    }).toStrictEqual({ count: 100, first: 250, last: 151, older: true });
  });
});

describe("A workflow's History", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("is an App's, on its own subject: no preview, its triggers named, rolled back through the same versions", async () => {
    const { session, asked } = fakeApps({ role: "builder" });
    const core = {
      withSession: async <T,>(
        run: (reached: typeof session) => Promise<T>
      ): Promise<T> => await run(session),
    };
    const rootRoute = createRootRoute({
      component: () => (
        <DraftHistory
          builds
          identity={person("user-owner", "builder")}
          live={2}
          subject={{ kind: "workflow", id: "workflow-1" }}
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
    const seeIt = [
      ...(section("draft-unpublished")?.querySelectorAll("a") ?? []),
    ].length;

    await press(button("Actions for 26.10.1"));
    const offered = [...document.querySelectorAll('[role="menuitem"]')].map(
      (each) => each.textContent.trim()
    );
    await press(menuItem("Go back to this version"));
    const said = document.body.textContent;
    await press(button("Go back"));

    expect({
      seeIt,
      offered,
      triggers: said.includes("Its triggers start it from now on"),
      asked,
    }).toStrictEqual({
      seeIt: 0,
      offered: ["Go back to this version"],
      triggers: true,
      asked: [["rollback", "workflow-1", 1, 7, 2]],
    });
  });
});

describe("Deleting an archived App", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("lets its owner delete it once archived, after asking, and leaves for Apps", async () => {
    const { session, asked } = fakeApps({
      role: "builder",
      archived: true,
    });
    const router = await shown(session, person("user-owner", "builder"));

    await press(button("Delete"));
    await press(button("Delete for good"));

    expect({ asked, at: router.state.location.pathname }).toStrictEqual({
      asked: [["remove", appId]],
      at: "/apps",
    });
  });

  it("offers it to nobody else, and not before it is archived", async () => {
    const shownFor = async (
      viewer: Identity,
      archived: boolean
    ): Promise<boolean> => {
      const { session } = fakeApps({ role: "builder", archived });
      await shown(session, viewer);
      const offered = button("Delete") !== undefined;
      act(() => {
        root?.unmount();
      });
      document.body.innerHTML = "";
      return offered;
    };

    expect({
      admin: await shownFor(person("user-admin", "admin"), true),
      otherBuilder: await shownFor(person("user-bo", "builder"), true),
      staff: await shownFor(person("user-owner", "admin", true), true),
      unarchived: await shownFor(person("user-owner", "builder"), false),
    }).toStrictEqual({
      admin: true,
      otherBuilder: false,
      staff: false,
      unarchived: false,
    });
  });
});

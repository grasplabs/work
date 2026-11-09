// @vitest-environment happy-dom
import type { App, AppStatus, VersionReview } from "@grasp-os/shared/apps";
import type { ChatDraft } from "@grasp-os/shared/chat";
import {
  appIdSchema,
  permissionIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
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

import { ChatBuilds, changesApp } from "./builds.tsx";
import type { ChatBuildsRead } from "./builds.tsx";

// Releasing a version beside the chat, against core's `apps` as the page
// reaches it over RPC (the boundary from the web app), faked: a new
// App is a draft, which its users can't open until it is published, so
// its release offers to publish it with the version, and says why; a
// published App's release only makes the version current.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const appId = appIdSchema.parse(crypto.randomUUID());

/** An App with version 2 up for review, at `status`. */
const appAt = (status: AppStatus): App & { pendingVersion: number } => ({
  id: appId,
  name: "Invoices",
  description: "",
  owner: "user-1",
  responsible: "user-1",
  audience: null,
  process: null,
  blueprint: null,
  currentVersion: 1,
  pendingVersion: 2,
  status,
  link: null,
  createdAt: "2026-10-20T08:00:00.000Z",
});

/** What core says version 2 changes: nothing a reviewer must read on. */
const review: VersionReview = {
  version: {
    app: appId,
    version: 2,
    parent: 1,
    tree: "tree",
    files: 1,
    author: "user-1",
    message: "Tidier list",
    createdAt: "2026-10-20T08:00:00.000Z",
    proposedBy: null,
  },
  proposedBy: null,
  current: 1,
  files: [{ path: "src/routes/index.tsx", change: "modified" }],
  server: null,
  serverFiles: [],
  migrations: [],
  schema: null,
  permissions: [],
  grants: [],
  callers: [],
  handsFilesToWorkflows: false,
  readsPeople: false,
  rowRules: [],
};

/** Core's `apps`, recording what the release asked of it. */
const fakeApps = (reviewed: VersionReview = review) => {
  const calls: string[] = [];
  return {
    calls,
    apps: {
      publish: async (app: string) => {
        calls.push(`publish ${app}`);
        await Promise.resolve();
      },
      versions: {
        review: async () => await Promise.resolve(reviewed),
        setCurrent: async (app: string, version: number) => {
          calls.push(`setCurrent ${app} ${version}`);
          await Promise.resolve();
        },
      },
    },
  };
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

let root: Root | undefined;

/** The side panel's builds with `app`'s version 2 up for review. */
const opened = async (
  app: App,
  apps: ReturnType<typeof fakeApps>["apps"]
): Promise<{ made: string[] }> => {
  const made: string[] = [];
  const core = {
    withSession: async <T,>(
      action: (session: { apps: typeof apps }) => Promise<T>
    ): Promise<T> => await action({ apps }),
  };
  const read: ChatBuildsRead = {
    builds: { apps: [app], drafts: [] },
    failure: undefined,
    retrying: false,
    retry: () => {
      // Nothing failed to read.
    },
    madeCurrent: new Set(),
    onMadeCurrent: (key) => {
      made.push(key);
    },
  };
  const rootRoute = createRootRoute({
    component: () => <ChatBuilds read={read} />,
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
  return { made };
};

const buttons = (): string[] =>
  [...document.querySelectorAll("button")].map(
    (each) => each.textContent?.trim() ?? ""
  );

const click = async (name: string): Promise<void> => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );
  if (found === undefined) {
    throw new Error(`No button ${name}`);
  }
  await act(async () => {
    found.click();
    await Promise.resolve();
  });
  await settled();
};

const saysDraft = (): boolean =>
  document.body.textContent?.includes(
    "Invoices is a draft: only its builders open it"
  ) ?? false;

/** A workflow's grant to call one of the App's functions, as a review lists it. */
const caller = (askedAgain: boolean, name?: string) => ({
  askedAgain,
  permission: {
    id: permissionIdSchema.parse(crypto.randomUUID()),
    subject: {
      type: "workflow" as const,
      workflowId: workflowResourceIdSchema.parse(
        "44444444-4444-4444-8444-444444444444"
      ),
    },
    object: {
      type: "app" as const,
      appId: appIdSchema.parse("invoice-desk"),
      function: "fn1",
    },
    actions: ["call"],
    binding: "NOTES",
    status: "active" as const,
    requestedBy: "user-1",
    requestedAt: "2026-11-01T00:00:00.000Z",
    grantedBy: "admin-1",
    grantedAt: "2026-11-01T00:00:00.000Z",
    revokedBy: null,
    revokedAt: null,
    requestedVia: null,
    chat: null,
    workflowNames: {
      "44444444-4444-4444-8444-444444444444": "Weekly notes",
    },
    ...(name === undefined ? {} : { functionName: name }),
  },
});

describe("releasing a version beside the chat", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("offers to publish a draft with its version, and does both", async () => {
    const { calls, apps } = fakeApps();
    const { made } = await opened(appAt("draft"), apps);
    const offered = { buttons: buttons(), saysDraft: saysDraft() };

    await click("Make version 2 current and publish");

    expect({ offered, calls, made }).toStrictEqual({
      offered: {
        buttons: [
          "Make version 2 current",
          "Make version 2 current and publish",
        ],
        saysDraft: true,
      },
      calls: [`setCurrent ${appId} 2`, `publish ${appId}`],
      made: [`${appId}:2`],
    });
  });

  it("makes a draft's version current alone when asked to, leaving it a draft", async () => {
    const { calls, apps } = fakeApps();
    await opened(appAt("draft"), apps);

    await click("Make version 2 current");

    expect(calls).toStrictEqual([`setCurrent ${appId} 2`]);
  });

  it("shows who sees and changes which rows of each table that says so", async () => {
    const { apps } = fakeApps({
      ...review,
      rowRules: [
        {
          table: "requests",
          read: [
            { kind: "owner" },
            { kind: "team", field: "team" },
            { kind: "role", role: "builder" },
          ],
          write: [{ kind: "person", field: "assignee" }],
        },
        // A table nobody writes (its write mode `none`).
        {
          table: "archive",
          read: [{ kind: "team", field: "team" }],
          write: null,
        },
      ],
    });
    await opened(appAt("published"), apps);
    const section = document.querySelector(
      'section[aria-label="Who sees which rows"]'
    );

    expect(
      [...(section?.querySelectorAll("li > span") ?? [])].map(
        (line) => line.textContent
      )
    ).toStrictEqual([
      "Read by whoever added the row, members of the team in team, and the App's builders",
      "Changed by the person in assignee, of the rows they can read",
      "Read by members of the team in team",
      "Changed by nobody",
    ]);
  });

  it("shows the workflows that call the App, and whose grant making it current asks for again", async () => {
    const { apps } = fakeApps({
      ...review,
      callers: [caller(true, "notes.create"), caller(false)],
    });
    await opened(appAt("published"), apps);
    const section = document.querySelector(
      'section[aria-label="Workflows that call it"]'
    );

    expect(
      [...(section?.querySelectorAll("li") ?? [])].map(
        (line) => line.textContent
      )
    ).toStrictEqual([
      "Weekly notes calls notes.create, asked for again of an admin if you make this current",
      "Weekly notes calls fn1",
    ]);
  });

  it("shows what a change of the definition does to the records, renames included", async () => {
    const { apps } = fakeApps({
      ...review,
      files: [],
      server: "modified",
      schema: {
        accepted: true,
        addedTables: [],
        renamedTables: [{ from: "tasks", to: "todos" }],
        renamedFields: [{ table: "notes", from: "title", to: "heading" }],
        addedFields: [],
        widenedFields: [],
        checks: [],
        keptTables: [],
        keptFields: [],
        accessChanges: [],
        sensitiveTables: [],
        refused: [],
      },
    });
    await opened(appAt("published"), apps);
    const section = document.querySelector(
      'section[aria-label="When you publish"]'
    );

    expect(
      [...(section?.querySelectorAll("li") ?? [])].map(
        (line) => line.textContent
      )
    ).toStrictEqual([
      "Renames the table tasks to todos; its records go with it.",
      "The values of title in notes move to heading.",
    ]);
  });

  it("only makes a published App's version current", async () => {
    const { calls, apps } = fakeApps();
    await opened(appAt("published"), apps);
    const offered = { buttons: buttons(), saysDraft: saysDraft() };

    await click("Make version 2 current");

    expect({ offered, calls }).toStrictEqual({
      offered: { buttons: ["Make version 2 current"], saysDraft: false },
      calls: [`setCurrent ${appId} 2`],
    });
  });
});

describe("whether a chat's draft changes its App", () => {
  it("counts a change of the definition alone, its stable IDs say, though no file changed", () => {
    const draft: ChatDraft = {
      app: appId,
      base: 1,
      changed: [],
      deleted: [],
      definitionChanged: false,
      revision: 2,
      updatedAt: "2026-10-20T08:00:00.000Z",
      callId: null,
    };
    expect([
      changesApp(draft),
      changesApp({ ...draft, definitionChanged: true }),
    ]).toStrictEqual([false, true]);
  });
});

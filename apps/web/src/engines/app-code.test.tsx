// @vitest-environment happy-dom
import type { AppFiles, FileDiff, ViewedApp } from "@grasp-os/shared/apps";
import type { ChatDraft } from "@grasp-os/shared/chat";
import { appIdSchema } from "@grasp-os/shared/ids";
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
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AppCode } from "./app-code.tsx";

// An App's Code, in its workspace, against core's Apps API as the page
// reaches it over RPC, faked: version 1 is current and version 2, up for
// review, changes one line of app.ts, adds a screen and deletes old.ts.
// Core's diff is the files as they were and are, as its `diffFiles`
// gives them; the page works out the lines.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const appId = appIdSchema.parse("app-1");

const builtApp = (
  role: ViewedApp["role"],
  currentVersion: number | null
): ViewedApp => ({
  id: appId,
  name: "Invoices",
  description: "",
  owner: "user-1",
  responsible: "user-1",
  audience: null,
  process: null,
  blueprint: null,
  currentVersion,
  pendingVersion: 2,
  status: "published",
  link: null,
  createdAt: "2026-10-20T08:00:00.000Z",
  role,
});

/**
 * app.ts, its limit far enough from both ends that the lines above and
 * below it fold.
 */
const appWith = (limit: number): string =>
  [
    'export const title = "Invoices";',
    ...Array.from({ length: 6 }, (_, note) => `// Note ${note + 1}`),
    `export const limit = ${limit};`,
    ...Array.from({ length: 5 }, (_, end) => `// End ${end + 1}`),
    "",
  ].join("\n");
const appV1 = appWith(10);
const appV2 = appWith(25);
const schemaText = "export const schema = {};\n";
const inboxText = "export default function Inbox() {}\n";
const oldText = "export const legacy = true;\n";

/** Each version's files, by version. */
type Versions = Record<number, AppFiles>;

const smallVersions: Versions = {
  1: { "app.ts": appV1, "old.ts": oldText, "schema.ts": schemaText },
  2: {
    "app.ts": appV2,
    "schema.ts": schemaText,
    "screens/inbox.tsx": inboxText,
  },
};

/** `count` lines, each `name` and its number. */
const manyLines = (name: string, count: number): string =>
  Array.from({ length: count }, (_, line) => `// ${name} ${line + 1}\n`).join(
    ""
  );

/**
 * Versions whose draft rewrites every line of data.ts (2,200 edits, past
 * what is worked out line by line) and adds a 2,100-line report.ts.
 */
const largeVersions: Versions = {
  1: { "data.ts": manyLines("old", 1100) },
  2: {
    "data.ts": manyLines("new", 1100),
    "report.ts": manyLines("report", 2100),
  },
};

/** What core's `diffFiles` gives: every path that differs, sorted. */
const diffOf = (before: AppFiles, after: AppFiles): FileDiff[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .toSorted()
    .flatMap((path): FileDiff[] => {
      const old = before[path];
      const now = after[path];
      if (old === undefined) {
        return now === undefined ? [] : [{ path, change: "added", after: now }];
      }
      if (now === undefined) {
        return [{ path, change: "deleted", before: old }];
      }
      return old === now
        ? []
        : [{ path, change: "modified", before: old, after: now }];
    });

const notesAt = (limit: number): string => `export const limit = ${limit};\n`;

/** The chat's draft at each revision, as its agent wrote it. */
const draftAt: Record<number, AppFiles> = {
  1: { "app.ts": appV1, "server/notes.ts": notesAt(10) },
  2: {
    "app.ts": appV1,
    "server/notes.ts": notesAt(25),
    "screens/inbox.tsx": inboxText,
  },
};

/** The chat's draft of the App, at `revision`. */
const chatDraft = (revision: number): ChatDraft => ({
  app: appId,
  base: null,
  changed: Object.keys(draftAt[revision] ?? {}).toSorted(),
  deleted: [],
  revision,
  updatedAt: "2026-11-05T08:00:00.000Z",
  callId: null,
});

/** Core's Apps API, as far as the Code tab reads it, on `filesOf`. */
const appsOn = (filesOf: Versions) => ({
  versions: {
    diff: async (
      _app: string,
      from: number,
      to: number
    ): Promise<FileDiff[]> => {
      await Promise.resolve();
      return diffOf(filesOf[from] ?? {}, filesOf[to] ?? {});
    },
  },
  files: {
    read: async (_app: string, at?: number): Promise<AppFiles> => {
      await Promise.resolve();
      return filesOf[at ?? 2] ?? {};
    },
  },
});

/**
 * Core's chats API, as far as the Code tab reads it: the draft's files at
 * the revision it is at now (`revisionNow`), as core reads them.
 */
let revisionNow = 1;
const chats = {
  draftFiles: async (chatId: string, app: string): Promise<AppFiles> => {
    await Promise.resolve();
    if (chatId !== "chat-1" || app !== appId) {
      throw new Error("Not this chat's draft");
    }
    return draftAt[revisionNow] ?? {};
  },
};

/** Moves the shown chat's draft on to `revision`, as a write of its agent does. */
let moveDraft: (revision: number) => void = () => {
  throw new Error("No chat's draft is shown");
};

/** The Code view, with the chat's draft at the revision it is at, if `building`. */
const CodeOf = ({ app, building }: { app: ViewedApp; building: boolean }) => {
  const [revision, setRevision] = useState(revisionNow);
  useEffect(() => {
    moveDraft = (next) => {
      revisionNow = next;
      setRevision(next);
    };
  }, []);
  return (
    <AppCode
      app={app}
      building={
        building ? { chatId: "chat-1", draft: chatDraft(revision) } : undefined
      }
    />
  );
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

/**
 * The App's Code in its workspace, for one of `role` in it; version
 * `current` runs. With `building`, beside the chat's draft of it.
 */
const shown = async (
  role: ViewedApp["role"],
  current: number | null = 1,
  versions: Versions = smallVersions,
  building = false
): Promise<void> => {
  const apps = appsOn(versions);
  const core = {
    withSession: async <T,>(
      action: (session: {
        apps: typeof apps;
        chats: typeof chats;
      }) => Promise<T>
    ): Promise<T> => await action({ apps, chats }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/apps/$app/edit",
    component: () => (
      <CodeOf app={builtApp(role, current)} building={building} />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory({
      initialEntries: [`/apps/${appId}/edit?view=code`],
    }),
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
  await settled();
};

const press = async (element: Element | undefined): Promise<void> => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
  await settled();
};

const named = (selector: string, name: string) =>
  [...document.querySelectorAll(selector)].find(
    (each) => each.textContent?.trim() === name
  );

/** The text of the file shown. */
const fileShown = (): string =>
  document.querySelector("figure pre")?.textContent ?? "";

/** The tree's folders and files, top to bottom. */
const treeShown = (): string[] =>
  [...document.querySelectorAll('nav[aria-label="Files"] li > :first-child')]
    .map((entry) => entry.textContent?.trim() ?? "")
    .filter((name) => name !== "");

/** Each changed file shown, and its lines as the view prints them. */
const changesShown = () =>
  [...document.querySelectorAll("section")].map((section) => ({
    file: section.querySelector("h3")?.textContent,
    text: section.textContent,
    lines: [...(section.querySelector("pre")?.children ?? [])].map(
      (line) => line.textContent
    ),
  }));

describe("An App's Code", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("shows the version up for review, as the preview does, read-only", async () => {
    await shown("builder");

    expect({
      file: fileShown(),
      readOnly: document.body.textContent.includes(
        "Read-only. Changes to the code go through the chat."
      ),
    }).toStrictEqual({ file: appV2, readOnly: true });
  });

  it("shows the text of the file picked, the current version's too", async () => {
    await shown("builder");
    await press(named("button", "inbox.tsx"));
    const picked = fileShown();
    await press(named("button", "Current (version 1)"));
    await press(named("button", "old.ts"));

    expect({ picked, current: fileShown() }).toStrictEqual({
      picked: inboxText,
      current: oldText,
    });
  });

  it("shows the chat's draft as its agent writes it, the file picked kept", async () => {
    revisionNow = 1;
    await shown("builder", 1, smallVersions, true);
    await press(named("button", "notes.ts"));
    const first = { file: fileShown(), tree: treeShown() };
    await act(async () => {
      moveDraft(2);
      await Promise.resolve();
    });
    await settled();
    await settled();

    expect({
      first,
      written: { file: fileShown(), tree: treeShown() },
      readOnly: document.body.textContent.includes(
        "Read-only. Changes to the code go through the chat."
      ),
      versionsOffered: named("button", "Current (version 1)") !== undefined,
    }).toStrictEqual({
      first: {
        file: notesAt(10),
        tree: ["server", "notes.ts", "app.ts"],
      },
      written: {
        file: notesAt(25),
        tree: ["screens", "inbox.tsx", "server", "notes.ts", "app.ts"],
      },
      readOnly: true,
      versionsOffered: false,
    });
  });

  it("shows the draft's changed lines against the current version, with a few around them", async () => {
    await shown("builder");
    await press(named("button", "Changes"));

    expect(
      changesShown().map(({ file, lines }) => ({ file, lines }))
    ).toStrictEqual([
      {
        file: "app.ts",
        lines: [
          "⋯ 4 unchanged lines",
          "  // Note 4",
          "  // Note 5",
          "  // Note 6",
          "- export const limit = 10;",
          "+ export const limit = 25;",
          "  // End 1",
          "  // End 2",
          "  // End 3",
          "⋯ 2 unchanged lines",
        ],
      },
      { file: "old.ts", lines: ["- export const legacy = true;"] },
      {
        file: "screens/inbox.tsx",
        lines: ["+ export default function Inbox() {}"],
      },
    ]);
  });

  it("shows every file of a draft as added while no version is current", async () => {
    await shown("builder", null);
    const draftFile = fileShown();
    await press(named("button", "Changes"));

    expect({
      draftFile,
      changes: changesShown().map(({ file, lines }) => ({
        file,
        added: lines.every((line) => line?.startsWith("+ ")),
      })),
    }).toStrictEqual({
      draftFile: appV2,
      changes: [
        { file: "app.ts", added: true },
        { file: "schema.ts", added: true },
        { file: "screens/inbox.tsx", added: true },
      ],
    });
  });

  it("says so when a change only takes away the final newline", async () => {
    await shown("builder", 1, {
      1: { "app.ts": "export const done = true;\n" },
      2: { "app.ts": "export const done = true;" },
    });
    await press(named("button", "Changes"));

    expect(
      changesShown().map(({ file, lines }) => ({ file, lines }))
    ).toStrictEqual([
      {
        file: "app.ts",
        lines: [
          "- export const done = true;",
          "+ export const done = true;",
          "No newline at end of file",
        ],
      },
    ]);
  });

  it("says a file rewritten past what is worked out has too many changes, and shows a large new file whole", async () => {
    await shown("builder", 1, largeVersions);
    await press(named("button", "Changes"));
    const [rewritten, added] = changesShown();

    expect({
      rewritten: {
        file: rewritten?.file,
        tooMany: rewritten?.text.includes(
          "Too many changes to show line by line"
        ),
        lines: rewritten?.lines.length,
      },
      added: {
        file: added?.file,
        lines: added?.lines.length,
        allAdded: added?.lines.every((line) => line?.startsWith("+ // report")),
        last: added?.lines.at(-1),
      },
    }).toStrictEqual({
      rewritten: { file: "data.ts", tooMany: true, lines: 0 },
      added: {
        file: "report.ts",
        lines: 2100,
        allAdded: true,
        last: "+ // report 2100",
      },
    });
  });
});

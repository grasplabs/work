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
// review, changes one line of grasp.config.ts, adds a page and deletes old.ts.
// Core's diff is the files as they were and are, as its `diffFiles`
// gives them; the page diffs them (@pierre/diffs), and what it drew is read
// from the shadow roots it draws in.

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
 * grasp.config.ts, its limit far enough from both ends that the lines above and
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
  1: { "grasp.config.ts": appV1, "old.ts": oldText, "schema.ts": schemaText },
  2: {
    "grasp.config.ts": appV2,
    "schema.ts": schemaText,
    "src/routes/inbox.tsx": inboxText,
  },
};

/** `count` lines, each `name` and its number. */
const manyLines = (name: string, count: number): string =>
  Array.from({ length: count }, (_, line) => `// ${name} ${line + 1}\n`).join(
    ""
  );

/**
 * Versions whose draft rewrites every line of data.ts (4,200 lines old and
 * new, past what is diffed line by line), rewrites all of rows.ts (2,200,
 * within it) and adds a 2,100-line report.ts.
 */
const largeVersions: Versions = {
  1: {
    "data.ts": manyLines("old", 2100),
    "rows.ts": manyLines("old row", 1100),
  },
  2: {
    "data.ts": manyLines("new", 2100),
    "rows.ts": manyLines("new row", 1100),
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
  1: { "grasp.config.ts": appV1, "server/notes.ts": notesAt(10) },
  2: {
    "grasp.config.ts": appV1,
    "server/notes.ts": notesAt(25),
    "src/routes/inbox.tsx": inboxText,
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

/**
 * The text `element` shows, the code @pierre/diffs draws in its shadow
 * roots included: what a person reads there.
 */
const textShown = (node: Node | null | undefined): string => {
  if (node === null || node === undefined) {
    return "";
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  const shadow = node instanceof Element ? node.shadowRoot : null;
  return [...(shadow?.childNodes ?? []), ...node.childNodes]
    .map((child) => textShown(child))
    .join("");
};

/** The text of the open file's code, as the view shows it. */
const codeShown = (): string =>
  textShown(document.querySelector('section[aria-label^="Code of"]'));

/** Where the open file is, as its bar says it. */
const pathShown = (): string[] =>
  [
    ...document.querySelectorAll(
      'nav[aria-label="Open file"] [data-slot="breadcrumb-item"]'
    ),
  ].map((item) => item.textContent.trim());

/** The tree's folders and files as they stand, top to bottom. */
const treeShown = (): string[] =>
  [...document.querySelectorAll('nav[aria-label="Files"] button')].map(
    (entry) => entry.textContent.trim()
  );

/** The file the tree marks as open. */
const openInTree = (): string | undefined =>
  document
    .querySelector('nav[aria-label="Files"] [aria-current="true"]')
    ?.textContent.trim();

/** The changed files the Changes show, each a region named by its path. */
const changedFiles = (): string[] =>
  [...document.querySelectorAll('section[aria-label="Changes"] section')].map(
    (section) => section.getAttribute("aria-label") ?? ""
  );

/** What the Changes show of the file at `path`. */
const changeShown = (path: string): string =>
  textShown(document.querySelector(`section[aria-label="${path}"]`));

/** Whether `text` holds each of `parts`. */
const holdsAll = (text: string, parts: readonly string[]): boolean =>
  parts.every((part) => text.includes(part));

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

    await expect.poll(codeShown).toContain("export const limit = 25;");
    expect({
      current: codeShown().includes("export const limit = 10;"),
      path: pathShown(),
      open: openInTree(),
    }).toStrictEqual({
      current: false,
      path: ["grasp.config.ts"],
      open: "grasp.config.ts",
    });
  });

  it("lays the files out as folders first, each folder opening and folding", async () => {
    await shown("builder", 1, {
      2: {
        "grasp.config.ts": appV2,
        "zeta.ts": schemaText,
        "server/b.ts": schemaText,
        "server/a/deep.ts": schemaText,
        "src/routes/inbox.tsx": inboxText,
      },
    });
    const all = treeShown();
    await press(named('nav[aria-label="Files"] button', "server"));
    const folded = {
      tree: treeShown(),
      expanded: named('nav[aria-label="Files"] button', "server")?.getAttribute(
        "aria-expanded"
      ),
    };
    await press(named('nav[aria-label="Files"] button', "server"));

    expect({ all, folded, again: treeShown() }).toStrictEqual({
      all: [
        "server",
        "a",
        "deep.ts",
        "b.ts",
        "src",
        "routes",
        "inbox.tsx",
        "grasp.config.ts",
        "zeta.ts",
      ],
      folded: {
        tree: [
          "server",
          "src",
          "routes",
          "inbox.tsx",
          "grasp.config.ts",
          "zeta.ts",
        ],
        expanded: "false",
      },
      again: all,
    });
  });

  it("opens the tree's first file when the version has no app.ts", async () => {
    await shown("builder", 1, {
      2: {
        "zeta.ts": schemaText,
        "server/b.ts": "export const b = 1;\n",
        "server/a/deep.ts": "export const deep = 1;\n",
      },
    });

    await expect.poll(codeShown).toContain("export const deep = 1;");
    expect(openInTree()).toBe("deep.ts");
  });

  it("opens the file picked, where it is in the tree, the current version's too", async () => {
    await shown("builder");
    await press(named("button", "inbox.tsx"));
    await expect.poll(codeShown).toContain("function Inbox()");
    const picked = { path: pathShown(), open: openInTree() };
    await press(named("button", "Current (version 1)"));
    await press(named("button", "old.ts"));
    await expect.poll(codeShown).toContain("export const legacy = true;");

    expect({
      picked,
      current: { path: pathShown(), open: openInTree() },
    }).toStrictEqual({
      picked: { path: ["src", "routes", "inbox.tsx"], open: "inbox.tsx" },
      current: { path: ["old.ts"], open: "old.ts" },
    });
  });

  it("shows the chat's draft as its agent writes it, the file open kept", async () => {
    revisionNow = 1;
    await shown("builder", 1, smallVersions, true);
    await press(named("button", "notes.ts"));
    await expect.poll(codeShown).toContain("export const limit = 10;");
    const first = treeShown();
    await act(async () => {
      moveDraft(2);
      await Promise.resolve();
    });
    await settled();
    await settled();
    await expect.poll(codeShown).toContain("export const limit = 25;");

    expect({
      first,
      written: treeShown(),
      open: openInTree(),
      versionsOffered: named("button", "Current (version 1)") !== undefined,
    }).toStrictEqual({
      first: ["server", "notes.ts", "grasp.config.ts"],
      written: [
        "server",
        "notes.ts",
        "src",
        "routes",
        "inbox.tsx",
        "grasp.config.ts",
      ],
      open: "notes.ts",
      versionsOffered: false,
    });
  });

  it("shows the draft's changes against the current version, file by file, with what each adds and removes", async () => {
    await shown("builder");
    await press(named("button", "Changes"));
    await expect
      .poll(() => changeShown("grasp.config.ts"))
      .toContain("export const limit = 25;");

    expect({
      files: changedFiles(),
      modified: holdsAll(changeShown("grasp.config.ts"), [
        "-1",
        "+1",
        "export const limit = 10;",
        "export const limit = 25;",
      ]),
      deleted: holdsAll(changeShown("old.ts"), [
        "-1",
        "export const legacy = true;",
      ]),
      added: holdsAll(changeShown("src/routes/inbox.tsx"), [
        "+1",
        "export default function Inbox() {}",
      ]),
    }).toStrictEqual({
      files: ["grasp.config.ts", "old.ts", "src/routes/inbox.tsx"],
      modified: true,
      deleted: true,
      added: true,
    });
  });

  it("shows the changes side by side once split is chosen", async () => {
    await shown("builder");
    await press(named("button", "Changes"));
    await press(named("button", "Split"));

    await expect
      .poll(() => changeShown("grasp.config.ts"))
      .toContain("export const limit = 25;");
    expect({
      split: named("button", "Split")?.getAttribute("aria-pressed"),
      both: holdsAll(changeShown("grasp.config.ts"), [
        "export const limit = 10;",
        "export const limit = 25;",
      ]),
    }).toStrictEqual({ split: "true", both: true });
  });

  it("shows every file of a draft as added while no version is current", async () => {
    await shown("builder", null);
    await press(named("button", "Changes"));
    await expect.poll(changedFiles).toHaveLength(3);

    expect({
      files: changedFiles(),
      added: changedFiles().every((path) => changeShown(path).includes("+")),
    }).toStrictEqual({
      files: ["grasp.config.ts", "schema.ts", "src/routes/inbox.tsx"],
      added: true,
    });
  });

  it("says so when a change only takes away the final newline", async () => {
    await shown("builder", 1, {
      1: { "grasp.config.ts": "export const done = true;\n" },
      2: { "grasp.config.ts": "export const done = true;" },
    });
    await press(named("button", "Changes"));

    expect(changeShown("grasp.config.ts")).toContain(
      "Only the newline at the end of the file was removed."
    );
  });

  it("counts no line for an empty file added or deleted, and only the new ones for one filled", async () => {
    await shown("builder", 1, {
      1: { "filled.ts": "", "gone.ts": "" },
      2: { "filled.ts": "export const filled = true;\n", "new.ts": "" },
    });
    await press(named("button", "Changes"));
    await expect
      .poll(() => changeShown("filled.ts"))
      .toContain("export const filled = true;");
    /** The lines a file's change shows removed and added, as `-n` and `+n`, but none. */
    const counts = (path: string): string[] =>
      (changeShown(path).match(/[-+]\d+/gu) ?? []).filter(
        (count) => count.slice(1) !== "0"
      );

    expect({
      files: changedFiles(),
      filled: counts("filled.ts"),
      added: counts("new.ts"),
      deleted: counts("gone.ts"),
    }).toStrictEqual({
      files: ["filled.ts", "gone.ts", "new.ts"],
      filled: ["+1"],
      added: [],
      deleted: [],
    });
  });

  it("says a change too large to show line by line is so, and opens its file in Files", async () => {
    await shown("builder", 1, largeVersions);
    await press(named("button", "Changes"));
    await expect.poll(() => changeShown("rows.ts")).toContain("+1100");
    const changes = {
      files: changedFiles(),
      tooLarge: changeShown("data.ts").includes(
        "This change is too large to show line by line."
      ),
      rewritten: holdsAll(changeShown("rows.ts"), ["-1100", "+1100"]),
      added: changeShown("report.ts").includes("+2100"),
    };
    await press(
      document
        .querySelector('section[aria-label="data.ts"]')
        ?.querySelector("button") ?? undefined
    );
    await expect.poll(codeShown).toContain("// new 1");

    expect({ changes, open: openInTree() }).toStrictEqual({
      changes: {
        files: ["data.ts", "report.ts", "rows.ts"],
        tooLarge: true,
        rewritten: true,
        added: true,
      },
      open: "data.ts",
    });
  });
});

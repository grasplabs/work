// @vitest-environment happy-dom
import type { AppFiles, ViewedApp } from "@grasp-os/shared/apps";
import type { Draft } from "@grasp-os/shared/drafts";
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
// reaches it over RPC, faked: version 2 is live, and the App's draft, while
// it changes the App, is read from `drafts`. What the page drew
// (@pierre/diffs) is read from the shadow roots it draws in.

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
  liveLabel: currentVersion === null ? null : `26.11.${currentVersion}`,
  archived: false,
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

/** Each version's files, by version. */
type Versions = Record<number, AppFiles>;

const smallVersions: Versions = {
  1: { "grasp.config.ts": appV1, "schema.ts": schemaText },
  2: {
    "grasp.config.ts": appV2,
    "schema.ts": schemaText,
    "src/routes/inbox.tsx": inboxText,
  },
};

const notesAt = (limit: number): string => `export const limit = ${limit};\n`;

/** The App's draft at each revision, as a chat's agent wrote it. */
const draftAt: Record<number, AppFiles> = {
  1: { "grasp.config.ts": appV1, "server/notes.ts": notesAt(10) },
  2: {
    "grasp.config.ts": appV1,
    "server/notes.ts": notesAt(25),
    "src/routes/inbox.tsx": inboxText,
  },
};

/** The App's draft, at `revision`. */
const appDraft = (revision: number): Draft => ({
  subject: { kind: "app", id: appId },
  base: null,
  changed: Object.keys(draftAt[revision] ?? {}).toSorted(),
  deleted: [],
  definitionChanged: false,
  revision,
  updatedAt: "2026-11-05T08:00:00.000Z",
  updatedBy: "person-1",
});

/**
 * Core's drafts, as far as the Code tab reads them: the App's draft's
 * files at the revision it is at now (`revisionNow`), as core reads them.
 */
let revisionNow = 1;
const drafts = {
  files: async (subject: { kind: string; id: string }): Promise<AppFiles> => {
    await Promise.resolve();
    if (subject.kind !== "app" || subject.id !== appId) {
      throw new Error("Not this App's draft");
    }
    return draftAt[revisionNow] ?? {};
  },
};

/** Core's versions, as far as the Code tab reads them, on `filesOf`. */
const versionsOn = (filesOf: Versions) => ({
  files: async (_subject: { kind: string; id: string }, at: number) => {
    await Promise.resolve();
    const files: AppFiles = filesOf[at] ?? {};
    return files;
  },
});

/** Moves the App's draft on to `revision`, as a write of a chat's agent does. */
let moveDraft: (revision: number) => void = () => {
  throw new Error("No draft is shown");
};

/** The Code view, with the App's draft at the revision it is at, if `building`. */
const CodeOf = ({ app, building }: { app: ViewedApp; building: boolean }) => {
  const [revision, setRevision] = useState(revisionNow);
  useEffect(() => {
    moveDraft = (next) => {
      revisionNow = next;
      setRevision(next);
    };
  }, []);
  return (
    <AppCode app={app} building={building ? appDraft(revision) : undefined} />
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
 * `current` runs. With `building`, beside the App's draft.
 */
const shown = async (
  role: ViewedApp["role"],
  current: number | null = 2,
  versions: Versions = smallVersions,
  building = false
): Promise<void> => {
  const read = versionsOn(versions);
  const core = {
    withSession: async <T,>(
      action: (session: {
        versions: typeof read;
        drafts: typeof drafts;
      }) => Promise<T>
    ): Promise<T> => await action({ versions: read, drafts }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/apps/$app",
    component: () => (
      <CodeOf app={builtApp(role, current)} building={building} />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory({
      initialEntries: [`/apps/${appId}?view=code`],
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

describe("An App's Code", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("shows the live version, read-only", async () => {
    await shown("builder");

    await expect.poll(codeShown).toContain("export const limit = 25;");
    expect({ path: pathShown(), open: openInTree() }).toStrictEqual({
      path: ["grasp.config.ts"],
      open: "grasp.config.ts",
    });
  });

  it("lays the files out as folders first, each folder opening and folding", async () => {
    await shown("builder", 2, {
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
    await shown("builder", 2, {
      2: {
        "zeta.ts": schemaText,
        "server/b.ts": "export const b = 1;\n",
        "server/a/deep.ts": "export const deep = 1;\n",
      },
    });

    await expect.poll(codeShown).toContain("export const deep = 1;");
    expect(openInTree()).toBe("deep.ts");
  });

  it("opens the file picked, where it is in the tree", async () => {
    await shown("builder");
    await press(named("button", "inbox.tsx"));
    await expect.poll(codeShown).toContain("function Inbox()");

    expect({ path: pathShown(), open: openInTree() }).toStrictEqual({
      path: ["src", "routes", "inbox.tsx"],
      open: "inbox.tsx",
    });
  });

  it("shows the App's draft as a chat's agent writes it, the file open kept", async () => {
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
    });
  });
});

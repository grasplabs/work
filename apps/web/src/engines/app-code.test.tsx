// @vitest-environment happy-dom
import type {
  AppFiles,
  AppVersion,
  FileDiff,
  ViewedApp,
} from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
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

import { AppPage } from "./app-page.tsx";

// An App's Code tab on its page, against core's Apps API as the page
// reaches it over RPC, faked: version 1 is current and version 2, up for
// review, changes one line of app.ts and adds a screen. Core's diff is
// the files as they were and are; the page works out the lines.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const appId = appIdSchema.parse("app-1");

const builtApp = (role: ViewedApp["role"]): ViewedApp => ({
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
  status: "published",
  link: null,
  createdAt: "2026-10-20T08:00:00.000Z",
  role,
});

const appV1 = 'export const title = "Invoices";\nexport const limit = 10;\n';
const appV2 = 'export const title = "Invoices";\nexport const limit = 25;\n';
const schemaText = "export const schema = {};\n";
const inboxText = "export default function Inbox() {}\n";

const filesOf: Record<number, AppFiles> = {
  1: { "app.ts": appV1, "schema.ts": schemaText },
  2: {
    "app.ts": appV2,
    "schema.ts": schemaText,
    "screens/inbox.tsx": inboxText,
  },
};

const version = (number: number): AppVersion => ({
  app: appId,
  version: number,
  parent: number === 1 ? null : number - 1,
  tree: `tree-${number}`,
  files: Object.keys(filesOf[number] ?? {}).length,
  author: "user-1",
  message: `Change ${number}`,
  createdAt: `2026-10-0${number}T09:00:00.000Z`,
  proposedBy: null,
});

const apps = {
  versions: {
    list: async (): Promise<AppVersion[]> => {
      await Promise.resolve();
      return [version(2), version(1)];
    },
    diff: async (_app: string, from: number, to: number) => {
      await Promise.resolve();
      const before = filesOf[from] ?? {};
      const after = filesOf[to] ?? {};
      const diffs: FileDiff[] = [];
      for (const [path, text] of Object.entries(after)) {
        const old = before[path];
        if (old === undefined) {
          diffs.push({ path, change: "added", after: text });
        } else if (old !== text) {
          diffs.push({ path, change: "modified", before: old, after: text });
        }
      }
      return diffs;
    },
  },
  files: {
    read: async (_app: string, at?: number): Promise<AppFiles> => {
      await Promise.resolve();
      return filesOf[at ?? 2] ?? {};
    },
  },
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

/** The App's page for one of `role` in it, its Code asked for. */
const shown = async (role: ViewedApp["role"]): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (session: { apps: typeof apps }) => Promise<T>
    ): Promise<T> => await action({ apps }),
  };
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <AppPage
          app={builtApp(role)}
          contents={{ version: 1, screens: ["home"], workflows: [] }}
          identity={{ staff: false }}
          open="home"
          view="code"
        >
          <p>The screen</p>
        </AppPage>
      ),
    }),
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

describe("An App's Code tab", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("is there for its builders, with the current version's code, and not the screen", async () => {
    await shown("builder");

    expect({
      tab: named("a", "Code")?.getAttribute("aria-current"),
      screen: document.body.textContent.includes("The screen"),
      file: fileShown(),
      readOnly: document.body.textContent.includes(
        "Read-only. Changes to the code go through the chat."
      ),
    }).toStrictEqual({
      tab: "page",
      screen: false,
      file: appV1,
      readOnly: true,
    });
  });

  it("is not there for its users, who see the App", async () => {
    await shown("user");

    expect({
      tab: named("a", "Code"),
      screen: document.body.textContent.includes("The screen"),
      code: document.querySelector("figure pre"),
    }).toStrictEqual({ tab: undefined, screen: true, code: null });
  });

  it("shows the text of the file picked, the draft's too", async () => {
    await shown("builder");
    await press(named("button", "schema.ts"));
    const picked = fileShown();
    await press(named("button", "Draft (version 2)"));
    await press(named("button", "inbox.tsx"));

    expect({ picked, draft: fileShown() }).toStrictEqual({
      picked: schemaText,
      draft: inboxText,
    });
  });

  it("shows the draft's changed lines against the current version", async () => {
    await shown("builder");
    await press(named("button", "Changes"));

    expect({
      files: [...document.querySelectorAll("section h3")].map(
        (heading) => heading.textContent
      ),
      removed: [...document.querySelectorAll("del")].map(
        (line) => line.textContent
      ),
      added: [...document.querySelectorAll("ins")].map(
        (line) => line.textContent
      ),
    }).toStrictEqual({
      files: ["app.ts", "screens/inbox.tsx"],
      removed: ["- export const limit = 10;"],
      added: [
        "+ export const limit = 25;",
        "+ export default function Inbox() {}",
      ],
    });
  });
});

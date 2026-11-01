// @vitest-environment happy-dom
import type { App, AppStatus, VersionReview } from "@grasp-os/shared/apps";
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

import { ChatBuilds } from "./builds.tsx";
import type { ChatBuildsRead } from "./builds.tsx";

// Releasing a version beside the chat, against core's `apps` as the page
// reaches it over RPC (the boundary from the web app), faked: a new
// domain is a draft, which its users can't open until it is published, so
// its release offers to publish it with the version, and says why; a
// published domain's release only makes the version current.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const appId = appIdSchema.parse(crypto.randomUUID());

/** A domain with version 2 up for review, at `status`. */
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
  files: [{ path: "screens/list.tsx", change: "modified" }],
  server: null,
  serverFiles: [],
  migrations: [],
  workflows: [],
  exports: [],
  permissions: [],
  grants: [],
  handsFilesToWorkflows: false,
  tests: { status: "none", failures: [] },
};

/** Core's `apps`, recording what the release asked of it. */
const fakeApps = () => {
  const calls: string[] = [];
  return {
    calls,
    apps: {
      publish: async (app: string) => {
        calls.push(`publish ${app}`);
        await Promise.resolve();
      },
      versions: {
        review: async () => await Promise.resolve(review),
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

  it("only makes a published domain's version current", async () => {
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

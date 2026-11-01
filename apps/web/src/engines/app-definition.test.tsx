// @vitest-environment happy-dom
import type { ViewedApp } from "@grasp-os/shared/apps";
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
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { ExportDefinition } from "./app-definition.tsx";

// Exporting a domain's definition from its page, against core's `apps` as
// the page reaches it over RPC (the boundary from the web app), faked: it
// hands over the package as it holds it, or refuses as core does. What the
// person saves is read from the file the page made.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const invoices: ViewedApp = {
  id: appIdSchema.parse("app-1"),
  name: "Invoices & Credit notes",
  description: "",
  owner: "user-1",
  responsible: "user-1",
  audience: null,
  process: null,
  blueprint: null,
  currentVersion: 3,
  pendingVersion: null,
  status: "published",
  createdAt: "2026-10-20T08:00:00.000Z",
  role: "builder",
};

/** What core packages of the App's current release, abridged. */
const definition = {
  formatVersion: 2,
  app: { version: 3, files: { "app.ts": "export default {};" } },
  workflows: [],
};

/** Core's `apps`: the App's definition, and each App it was asked for. */
const fakeApps = (refusal?: string) => {
  const asked: string[] = [];
  const apps = {
    definition: async (app: string) => {
      await Promise.resolve();
      asked.push(app);
      if (refusal !== undefined) {
        throw new Error(refusal);
      }
      return definition;
    },
  };
  return { session: { apps }, asked };
};

let root: Root | undefined;
let downloaded: { name: string; text: string }[] = [];

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

const shown = async (
  session: ReturnType<typeof fakeApps>["session"],
  app: ViewedApp,
  staff = false
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    component: () => <ExportDefinition app={app} identity={{ staff }} />,
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

const unmount = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.innerHTML = "";
};

const offered = (): boolean =>
  [...document.querySelectorAll("button")].some(
    (each) => each.textContent?.trim() === "Export definition"
  );

const press = async (name: string) => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );
  if (button === undefined) {
    throw new TypeError(`No button ${name}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settled();
};

describe("Exporting a domain's definition", () => {
  beforeEach(() => {
    // A download is a link to the file, clicked: what it would save is read
    // from the file the page made, and its name from the link.
    const files = new Map<string, Blob>();
    URL.createObjectURL = (blob: Blob) => {
      const url = `blob:test/${files.size}`;
      files.set(url, blob);
      return url;
    };
    URL.revokeObjectURL = () => {
      // Nothing to let go of: the test's files are only in the map.
    };
    HTMLAnchorElement.prototype.click = function click(
      this: HTMLAnchorElement
    ) {
      const file = files.get(this.href);
      if (file !== undefined) {
        void file.text().then((text) => {
          downloaded.push({ name: this.download, text });
        });
      }
    };
  });

  afterEach(() => {
    unmount();
    downloaded = [];
  });

  it("saves the package core built of its current release, named after the domain and version", async () => {
    const { session, asked } = fakeApps();
    await shown(session, invoices);

    await press("Export definition");

    expect({
      asked,
      saved: downloaded.map(({ name, text }) => {
        const saved: unknown = JSON.parse(text);
        return { name, package: saved };
      }),
    }).toStrictEqual({
      asked: ["app-1"],
      saved: [{ name: "invoices-credit-notes-v3.json", package: definition }],
    });
  });

  it("is offered only to its builders, never Grasp staff, once a version is current", async () => {
    const { session } = fakeApps();
    const seen: Record<string, boolean> = {};
    const cases = {
      builder: { app: invoices, staff: false },
      user: { app: { ...invoices, role: "user" as const }, staff: false },
      staff: { app: invoices, staff: true },
      unreleased: { app: { ...invoices, currentVersion: null }, staff: false },
    };
    for (const [name, { app, staff }] of Object.entries(cases)) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await shown(session, app, staff);
      seen[name] = offered();
      unmount();
    }

    expect(seen).toStrictEqual({
      builder: true,
      user: false,
      staff: false,
      unreleased: false,
    });
  });

  it("says why core refused, and saves nothing", async () => {
    const { session } = fakeApps(
      "The export holds what looks like a secret in app.ts. Remove it, then export again."
    );
    await shown(session, invoices);

    await press("Export definition");

    expect(downloaded).toStrictEqual([]);
    expect(document.body.textContent).toContain(
      "looks like a secret in app.ts"
    );
  });
});

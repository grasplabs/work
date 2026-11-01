// @vitest-environment happy-dom
import type { AppVersion, ViewedApp } from "@grasp-os/shared/apps";
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

import { RemoveApp } from "./app-remove.tsx";
import { AppVersions } from "./app-versions.tsx";

// A domain's versions and deleting an archived domain, against core's Apps
// API as the page reaches it over RPC (the boundary from the web app),
// faked: it keeps which version is current and whether the App is still
// there, and answers the page's next read with that.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const appId = appIdSchema.parse("app-1");

const version = (number: number): AppVersion => ({
  app: appId,
  version: number,
  parent: number === 1 ? null : number - 1,
  tree: `tree-${number}`,
  files: 3,
  author: "user-owner",
  message: `Change ${number}`,
  createdAt: `2026-10-0${number}T09:00:00.000Z`,
  proposedBy: null,
});

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

/** Core's Apps API on one App with three versions, and each change asked. */
const fakeApps = ({
  role,
  status = "published",
  current = 2,
}: {
  role: ViewedApp["role"];
  status?: ViewedApp["status"];
  current?: number;
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
    pendingVersion: 3,
    status,
    process: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    role,
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
    versions: {
      list: async (): Promise<AppVersion[]> => {
        await Promise.resolve();
        return [version(3), version(2), version(1)];
      },
      // No version sealed: nothing revoked or held.
      releases: async (): Promise<[]> => {
        await Promise.resolve();
        return [];
      },
      setCurrent: async (
        id: string,
        to: number,
        expected?: number | null
      ): Promise<ViewedApp> => {
        await Promise.resolve();
        asked.push(["setCurrent", id, to, expected]);
        app = {
          ...app,
          currentVersion: to,
          pendingVersion: app.pendingVersion === to ? null : app.pendingVersion,
        };
        return app;
      },
    },
  };
  return { session: { apps }, asked, removed: () => removed };
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

/** The domain's page, its versions and its Delete, for `viewer`. */
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
      const app = page.useLoaderData();
      return (
        <>
          <RemoveApp app={app} identity={viewer} />
          <AppVersions app={app} identity={viewer} />
        </>
      );
    },
  });
  const domains = createRoute({
    getParentRoute: () => rootRoute,
    path: "/domains",
    component: () => <p>Domains</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, domains]),
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

const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.textContent?.trim() === name ||
      each.getAttribute("aria-label") === name
  );

const menuItem = (name: string) =>
  [...document.querySelectorAll('[role="menuitem"]')].find(
    (each) => each.textContent?.trim() === name
  );

/** Each version listed, and what it is marked. */
const listed = (): string[] =>
  [...document.querySelectorAll("tbody tr td:first-child")].map(
    (cell) => cell.textContent?.trim() ?? ""
  );

describe("A domain's versions", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("lets a builder roll back over the version that runs, only once they confirm", async () => {
    const { session, asked } = fakeApps({ role: "builder" });
    await shown(session, person("user-owner", "builder"));
    expect(listed()).toStrictEqual(["3Up for review", "2Current", "1"]);

    await press(button("Actions for version 1"));
    await press(menuItem("Roll back to this version"));
    await press(button("Cancel"));
    const afterCancel = [...asked];
    await press(button("Actions for version 1"));
    await press(menuItem("Roll back to this version"));
    expect(document.body.textContent).toContain(
      "wait for an admin to grant them again"
    );
    await press(button("Roll back"));

    expect({ afterCancel, asked, listed: listed() }).toStrictEqual({
      afterCancel: [],
      asked: [["setCurrent", appId, 1, 2]],
      listed: ["3Up for review", "2", "1Current"],
    });
  });

  it("lets a builder make the version up for review current", async () => {
    const { session, asked } = fakeApps({ role: "builder" });
    await shown(session, person("user-owner", "admin"));

    await press(button("Actions for version 3"));
    await press(menuItem("Make current"));
    // An admin's own making current asks for nothing again.
    expect(document.body.textContent).not.toContain(
      "wait for an admin to grant them again"
    );
    await press(button("Make current"));

    expect(asked).toStrictEqual([["setCurrent", appId, 3, 2]]);
  });
});

describe("Deleting an archived domain", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("lets its owner delete it once archived, after asking, and leaves for Domains", async () => {
    const { session, asked } = fakeApps({
      role: "builder",
      status: "archived",
    });
    const router = await shown(session, person("user-owner", "builder"));

    await press(button("Delete"));
    await press(button("Delete for good"));

    expect({ asked, at: router.state.location.pathname }).toStrictEqual({
      asked: [["remove", appId]],
      at: "/domains",
    });
  });

  it("offers it to nobody else, and not before it is archived", async () => {
    const shownFor = async (
      viewer: Identity,
      status: ViewedApp["status"]
    ): Promise<boolean> => {
      const { session } = fakeApps({ role: "builder", status });
      await shown(session, viewer);
      const offered = button("Delete") !== undefined;
      act(() => {
        root?.unmount();
      });
      document.body.innerHTML = "";
      return offered;
    };

    expect({
      admin: await shownFor(person("user-admin", "admin"), "archived"),
      otherBuilder: await shownFor(person("user-bo", "builder"), "archived"),
      staff: await shownFor(person("user-owner", "admin", true), "archived"),
      unarchived: await shownFor(person("user-owner", "builder"), "published"),
    }).toStrictEqual({
      admin: true,
      otherBuilder: false,
      staff: false,
      unarchived: false,
    });
  });
});

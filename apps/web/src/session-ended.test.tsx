// @vitest-environment happy-dom
import { authErrors } from "@grasp-os/shared/errors";
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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CoreConnection } from "./core-connection.ts";
import type { SessionEnded } from "./core-connection.ts";
import { tabLink } from "./pages/tab-link.ts";
import { Route as Shell } from "./routes/_shell.tsx";

// A session that ends elsewhere while a page of the frame is open (signed
// out on another device, revoked by an admin, removed): core closes the
// tab's connection, the connection made again finds nobody, every App
// frame on it stops and the page loads again (main.tsx); loaded again, the
// shell (routes/_shell.tsx) sends the person to sign in, with the page to
// come back to. Through the shell's own check, on the tab's real
// connection to a stand-in for core.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const ada: Identity = {
  userId: "ada",
  email: "ada@acme.test",
  name: "Ada",
  role: "user",
  teams: [],
  staff: false,
  expiresAt: "2026-11-26T10:00:00.000Z",
};

/** Lets every pending promise, render and timer at once settle. */
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
 * A tab's connection to a stand-in core: each new connection finds Ada
 * signed in until `revoke`, nobody after; `drop` closes the open one, as
 * core does to a session it ended. `ended` hears the page loading again.
 */
const tab = (signedIn: boolean) => {
  let revoked = !signedIn;
  let drop: (() => void) | undefined;
  const ended: string[] = [];
  const core = new CoreConnection({
    onSessionEnded: () => {
      ended.push("page loads again");
    },
    connect: () => {
      const gone = revoked;
      const session = {
        whoami: async () => await Promise.resolve(ada),
        onboarding: { behind: async () => await Promise.resolve(true) },
      };
      const stub = {
        authenticate: async () => {
          await Promise.resolve();
          if (gone) {
            throw authErrors.create("auth.unauthenticated");
          }
          return session;
        },
        ping: async () => await Promise.resolve("pong"),
        signInOptions: async () => await Promise.resolve([]),
        onRpcBroken: (onBroken: () => void) => {
          drop = onBroken;
        },
        [Symbol.dispose]: () => {
          // Nothing to let go of.
        },
      };
      // SAFETY: a stand-in for the parts of core's API the connection uses.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return stub as never;
    },
    watchPage: () => {
      // The page never comes back to the tab in these tests.
    },
  });
  return {
    core,
    ended,
    revoke: () => {
      revoked = true;
      drop?.();
    },
  };
};

/**
 * The shell, by its own check of who is signed in, around a page of the
 * frame at `address`, and the sign-in page: where the router ends up.
 */
const shown = async (core: CoreConnection, address: string) => {
  const top = createRootRoute({ component: Outlet });
  const check = Shell.options.beforeLoad;
  const shell = createRoute({
    getParentRoute: () => top,
    id: "_shell",
    // The shell's own check of who is signed in, on the way to each page.
    beforeLoad: async ({ context, location }) => {
      // SAFETY: what the shell's check reads of its options: the tab's
      // connection, and where the person is going.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      await check?.({ context, location } as never);
    },
    component: Outlet,
  });
  const page = createRoute({
    getParentRoute: () => shell,
    path: "/apps/$app",
    component: () => <p>The Invoices App</p>,
  });
  const signIn = createRoute({
    getParentRoute: () => top,
    path: "/sign-in",
    component: () => <p>Sign in</p>,
  });
  const router = createRouter({
    routeTree: top.addChildren([shell.addChildren([page]), signIn]),
    history: createMemoryHistory({ initialEntries: [address] }),
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

const unmounted = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
};

describe("a session that ends while a page is open", () => {
  afterEach(() => {
    unmounted();
    vi.restoreAllMocks();
  });

  it("stops the page's App frames and loads it again, and the shell then sends the person to sign in and back to that page", async () => {
    // Each reconnect at once: its pause drawn as nothing.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const address = "/apps/invoices?tab=runs&error=access_denied";
    const open = tab(true);
    await shown(open.core, address);
    const before = document.body.textContent;
    const told: SessionEnded[] = [];
    tabLink(open.core, (why) => {
      told.push(why);
    });

    // Revoked elsewhere: core closes the tab's connection.
    open.revoke();
    await settled();
    await settled();
    const ending = { told, ended: open.ended };

    // The page loads again (main.tsx), on a new connection.
    unmounted();
    const again = tab(false);
    const router = await shown(again.core, address);

    expect({
      before,
      ending,
      at: router.state.location.pathname,
      returnTo: new URLSearchParams(router.state.location.searchStr).get(
        "returnTo"
      ),
      after: document.body.textContent,
    }).toStrictEqual({
      before: "The Invoices App",
      ending: { told: ["signed-out"], ended: ["page loads again"] },
      at: "/sign-in",
      // Its search too, but not a refused sign-in's error.
      returnTo: "/apps/invoices?tab=runs",
      after: "Sign in",
    });
  });
});

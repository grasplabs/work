import { pageFrameMounted } from "@grasp-os/shared/page-limits";
/**
 * What runs an App's pages inside its sandboxed frame, as one single
 * page app: it connects to the page around the frame over the
 * `MessagePort` the page hands it, routes the App's file routes with
 * TanStack Router, keeps the router's location and the page's address in
 * step, follows the page's theme and reports the pages' errors. The
 * frame's own document (served by core) loads this module first; App code
 * never imports it.
 *
 * The frame is a sandbox with an opaque origin and no network, so the port
 * is the pages' only way out: to their App's server, through the page,
 * which binds it to that one App.
 */
import type { PageMounted } from "@grasp-os/shared/pages";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type {
  AnyRoute,
  AnyRouter,
  RouterHistory,
} from "@tanstack/react-router";
import type { RpcStub } from "capnweb";
import { createElement, useEffect } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { clientInternals, GraspClient } from "./client-core.ts";
import { GraspError } from "./client-error.ts";
import { portFileTransport } from "./file-port.ts";
import { portLinkTransport } from "./link-port.ts";
import { bridge, bridgeTransport, connectBridge } from "./page-bridge.ts";
import type { PageBridge } from "./page-bridge.ts";
import {
  describe,
  fallbackOf,
  PageBoundary,
  report,
  reportProblems,
} from "./page-problems.ts";
import { GraspProvider } from "./react/provider.ts";

/**
 * What a preview's runtime (preview-runtime.ts) hooks into: once the
 * pages' modules evaluated, before they first render; each error React
 * met rendering them, caught by a boundary or not; and once they first
 * rendered, into `root`, with the page's bridge and the router, whose
 * routes an update replaces.
 */
export interface PageHooks {
  loaded?: () => void;
  renderFailed?: () => void;
  mounted?: (
    page: RpcStub<PageBridge>,
    root: HTMLElement,
    router: AnyRouter
  ) => void;
}

/** What a route tree's module exports: TanStack's generated `routeTree`. */
const routeTreeOf = (module: unknown): AnyRoute | undefined => {
  const tree: unknown =
    typeof module === "object" && module !== null
      ? Reflect.get(module, "routeTree")
      : undefined;
  if (typeof tree !== "object" || tree === null) {
    return undefined;
  }
  // SAFETY: the generated module's `routeTree`, a root route TanStack's
  // `createRootRoute` made; anything else fails the router as it builds.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return tree as AnyRoute;
};

/**
 * The release's functions a route tree's module hands on beside its
 * routes (the compiler's `withFunctions`), as data the client reads; none
 * for a build without references.
 */
const functionsOf = (module: unknown): unknown =>
  typeof module === "object" && module !== null
    ? Reflect.get(module, "functions")
    : undefined;

/** The client each router's pages read through (`runPage`). */
const clients = new WeakMap<AnyRouter, GraspClient>();

/**
 * Routes `router` by the route tree `module` exports, as TanStack's own
 * hot updates do: its routes are rebuilt, and what is shown is matched
 * again, its client given the functions the module hands on. False for a
 * module with no route tree.
 */
export const routeBy = (router: AnyRouter, module: unknown): boolean => {
  const routeTree = routeTreeOf(module);
  if (routeTree === undefined) {
    return false;
  }
  const client = clients.get(router);
  if (client !== undefined) {
    clientInternals(client).useFunctions(functionsOf(module));
  }
  router.update({ ...router.options, routeTree });
  void router.invalidate();
  return true;
};

/**
 * Which start of the frame this is, as the page handed it over with the
 * pages: the frame's load, the hash of the code and the page's name for
 * this start. The runtime only says them back (`pageFrameMounted`).
 */
export type PageStart = Omit<PageMounted, "type">;

/**
 * Renders nothing; tells the page the page has rendered for the first
 * time. An effect runs once React has put the first render on the page,
 * so a page that fails or never finishes its first render says nothing,
 * and the page gives up on it.
 *
 * This only tells the page a start that worked from one that didn't. The
 * page's own code runs in this same frame and could post the same
 * message; the page gives a mounted page nothing it wouldn't otherwise.
 */
const Mounted = ({
  start,
  onMounted,
}: {
  start: PageStart;
  onMounted?: () => void;
}) => {
  useEffect(() => {
    parent.postMessage({ type: pageFrameMounted, ...start }, "*");
    onMounted?.();
  }, [start, onMounted]);
  return null;
};

/** What the router's history tells its subscribers. */
type SubscriberArgs = Parameters<Parameters<RouterHistory["subscribe"]>[0]>[0];

/**
 * Keeps the router and the page's address in step: each entry the router
 * makes, the page carries in its address (a new entry for a push, the
 * current one otherwise); each change of the page's address it didn't ask
 * for, the router goes to, in place of its current entry. A location it
 * is at already goes nowhere, so neither echoes the other.
 */
const syncLocation = async (
  history: RouterHistory,
  page: RpcStub<PageBridge>
): Promise<void> => {
  history.subscribe(({ location, action }: SubscriberArgs) => {
    void page.navigated(location.href, action.type === "PUSH");
  });
  await page.follow((href) => {
    if (href !== history.location.href) {
      history.replace(href);
    }
  });
};

/**
 * Runs the App's pages from their route tree's module `entry` (a name
 * in the frame's import map), connected to the page through `port`, its
 * files through `filePort` (file-port.ts), its links through `linkPort`
 * (link-port.ts), at the location the page carries, and tells the page
 * once they have rendered for the first time, as the `start` the page
 * named. A preview's runtime hooks into it (`hooks`): it registers the
 * pages' components with Fast Refresh once their modules have
 * evaluated, and takes the draft's updates once they have rendered
 * (preview-runtime.ts).
 */
export const runPage = async (
  port: MessagePort,
  entry: string,
  start: PageStart,
  filePort: MessagePort,
  linkPort: MessagePort,
  hooks: PageHooks = {}
): Promise<void> => {
  const page = connectBridge(port);
  reportProblems(entry);
  const root = document.createElement("div");
  document.body.append(root);
  try {
    await page.theme((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    });
    // Where the page's address says the App is: asked for before the
    // routes load, so the first render is of that route.
    const location = await page.location();
    const module: unknown = await import(entry);
    const routeTree = routeTreeOf(module);
    if (routeTree === undefined) {
      throw new Error(`${entry} has no route tree to route by.`);
    }
    hooks.loaded?.();
    // One client for the App session this frame runs, over the page's
    // bridge: every page in it reads through the same queries and
    // submissions, and none makes its own.
    const client = new GraspClient(
      {
        ...bridgeTransport(bridge),
        files: portFileTransport(filePort),
        links: portLinkTransport(linkPort),
      },
      functionsOf(module)
    );
    const retry = (): void => {
      clientInternals(client).retryFailed();
    };
    // The frame has no address of its own to route by: a sandbox's is
    // core's document, so the router keeps its own in memory, in step
    // with the page's (`syncLocation`).
    const history = createMemoryHistory({ initialEntries: [location] });
    const router = createRouter({
      routeTree,
      history,
      defaultErrorComponent: ({ error, reset }): ReactNode =>
        fallbackOf(error, () => {
          retry();
          reset();
        }),
    });
    clients.set(router, client);
    await syncLocation(history, page);
    await router.load();
    const { mounted } = hooks;
    createRoot(root, {
      onUncaughtError: (error) => {
        hooks.renderFailed?.();
        report({ kind: "error", ...describe(error) });
      },
      // What a boundary caught: of a structured SDK error only its code
      // and request ID, never the domain message it may carry.
      onCaughtError: (error) => {
        hooks.renderFailed?.();
        report({
          kind: "error",
          ...(error instanceof GraspError
            ? {
                message: `${error.code}${error.requestId === null ? "" : ` (request ${error.requestId})`}`,
              }
            : describe(error)),
        });
      },
    }).render(
      createElement(
        GraspProvider,
        { client },
        // Inside the boundary: an App whose first render throws replaces
        // `Mounted` with the fallback too, so the page never hears that a
        // start which didn't work did.
        createElement(
          PageBoundary,
          { retry },
          createElement(RouterProvider, { router }),
          createElement(Mounted, {
            start,
            ...(mounted === undefined
              ? {}
              : {
                  onMounted: () => {
                    mounted(page, root, router);
                  },
                }),
          })
        )
      )
    );
  } catch (error) {
    report({ kind: "error", ...describe(error) });
  }
};

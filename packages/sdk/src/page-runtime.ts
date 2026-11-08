import { pageFrameMounted, pageLimits } from "@grasp-os/shared/page-limits";
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
import { portTransport } from "@grasp-os/shared/page-port";
import type { PageMounted, PageProblem } from "@grasp-os/shared/pages";
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
import { RpcSession } from "capnweb";
import type { RpcStub } from "capnweb";
import { Component, createElement, useEffect } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { clientInternals, GraspClient } from "./client-core.ts";
import type { ClientTransport } from "./client-core.ts";
import { GraspError } from "./client-error.ts";
import { calledByApp } from "./console-origin.ts";
import { portFileTransport } from "./file-port.ts";
import { portLinkTransport } from "./link-port.ts";
import { GraspProvider } from "./react/provider.ts";

export type Theme = "light" | "dark";

/**
 * What the page gives the frame over its port, and nothing else. Answers
 * and failures come back as they are; a page reads them as its own data.
 */
export interface PageBridge {
  /**
   * Calls one of the App's functions (spec 32.6), for the person using the
   * page: `request` is the call as JSON text (its reference, input and
   * idempotency key), passed to core as it is; the answer is core's
   * `{ result, fingerprint, manifestHash }`, the last null for an action
   * answered by its invocation, which keeps no release. The transport the page
   * client builds on, not a call for page code itself.
   */
  callFunction: (request: string) => Promise<unknown>;
  /**
   * Follows one of the App's streaming actions (spec 10.7.6): `what` is
   * `stream` (start it, or join it under the same key) or `attach` (read
   * it again, never starting it), `request` as for `callFunction`.
   * `onFrame` gets each frame core sent, one at a time, the next only once
   * it has answered, then `{ type: "closed" }` once the connection ends
   * without a result. Answers the subscription, to `release()` once the
   * page stops following it. The transport the page client builds on.
   */
  streamFunction: (
    what: string,
    request: string,
    onFrame: (frame: unknown) => Promise<void>
  ) => Promise<{ release: () => void }>;
  /** Cancels the streaming action's invocation `request` names, for everyone. */
  cancelStream: (request: string) => Promise<unknown>;
  /** Adds a problem to the App's error log. */
  report: (problem: PageProblem) => void;
  /** Calls `onTheme` with the page's theme now and whenever it changes. */
  theme: (onTheme: (theme: Theme) => void) => void;
  /** Answers the decision `decision` of one of the runs the App started. */
  decide: (run: string, decision: string, answer: unknown) => Promise<unknown>;
  /**
   * Follows one of the App's queries (spec 11): `request` is the call as
   * `callFunction` sends it; `onSnapshot` gets each result core pushes
   * (`{ revision, result }`), until the subscription it answers is
   * released (`release()`) or core lets go of `onSnapshot`. The transport
   * the page client follows queries over, not a call for page code.
   */
  watchQuery: (
    request: string,
    onSnapshot: (snapshot: unknown) => void
  ) => Promise<{ release: () => Promise<void> }>;
  /**
   * Where in the App the frame opens: the route, search and hash the page
   * carries in its own address (`/tasks/12?tab=notes`), `/` for none.
   */
  location: () => Promise<string>;
  /**
   * Tells the page the router went to `href`, a new entry (`push`) or in
   * place of the current one, for the page to carry in its own address.
   */
  navigated: (href: string, push: boolean) => void;
  /**
   * Calls `onLocation` with where the page's own address says the App is,
   * whenever it changes without the frame asking (back, forward, a link of
   * the host's): the router follows it.
   */
  follow: (onLocation: (href: string) => void) => void;
  /**
   * Whether a form of the page holds unsaved edits or a submission whose
   * outcome isn't known: the page confirms once before leaving the page.
   */
  leaveGuard: (guarded: boolean) => void;
  /**
   * A chat's preview's frame alone (preview-runtime.ts): hands the page
   * the frame's receiver of its draft's updates, which the page calls
   * with each version of the page in turn. Once per frame; a live
   * page's page never calls it.
   */
  refresh: (onLoad: (load: PreviewLoad) => Promise<PreviewApplied>) => void;
}

/**
 * A version of a chat's preview's pages for its frame to import: the
 * address of their route tree's module among the frame's own (core's
 * page-frame.ts), and the CSS of that version.
 */
export interface PreviewLoad {
  /** The address of the route tree's module. */
  entry: string;
  /**
   * Which evaluation of the frame's modules to import it in: from 1 on,
   * every module is evaluated afresh, once, as in no frame before, so
   * code the frame ran before registers anew with Refresh.
   */
  visit: number;
  css: string;
}

/**
 * What the frame says of a version: `applied` (its pages show it),
 * `failed` (it didn't evaluate: the pages show what they showed),
 * `broken` (it evaluated, and failed to render), `reset` (React Fast
 * Refresh can't go on in this frame: it needs a fresh start) or `refused`
 * (not a version as the page sends one).
 */
export type PreviewApplied =
  | "applied"
  | "failed"
  | "broken"
  | "reset"
  | "refused";

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
 * Routes `router` by the route tree `module` exports, as TanStack's own
 * hot updates do: its routes are rebuilt, and what is shown is matched
 * again. False for a module with no route tree.
 */
export const routeBy = (router: AnyRouter, module: unknown): boolean => {
  const routeTree = routeTreeOf(module);
  if (routeTree === undefined) {
    return false;
  }
  router.update({ ...router.options, routeTree });
  void router.invalidate();
  return true;
};

let connected: RpcStub<PageBridge> | undefined;

/** The page's bridge, once the frame has connected. */
export const bridge = (): RpcStub<PageBridge> => {
  if (!connected) {
    throw new Error("The page isn't connected to its page yet.");
  }
  return connected;
};

/** A subscription the page answered: released, and let go of, once. */
type HeldSubscription = Awaited<ReturnType<RpcStub<PageBridge>["watchQuery"]>>;

/**
 * Releases `subscription` and lets go of its stub: Cap'n Web keeps what a
 * session was handed until its stub is disposed of, so a released
 * subscription must be both.
 */
const releaseQuietly = async (
  subscription: HeldSubscription
): Promise<void> => {
  try {
    await subscription.release();
  } catch {
    // Core lets go of it anyway once the page's connection does.
  } finally {
    subscription[Symbol.dispose]();
  }
};

/** Runs `call` on the page, never failing the page if the page can't. */
const quietly = async (call: () => Promise<unknown>): Promise<void> => {
  try {
    await call();
  } catch {
    // The page went away: nothing of the frame's waits on it.
  }
};

/**
 * The session client's transport over the page's bridge `page`: calls as
 * function calls, queries followed with `watchQuery`. Core's letting go
 * of a callback reaches it as the callback's disposal (Cap'n Web
 * disposes a callback once nothing can call it any more), which the
 * client reads as a lost subscription; the subscription's stub is let go
 * of then too.
 */
export const bridgeTransport = (
  page: () => RpcStub<PageBridge>
): ClientTransport => ({
  call: async (request) => await page().callFunction(request),
  watch: async (request, onSnapshot, onLost) => {
    // The subscription's stub, once the page answered, and whether core
    // let go of it first; its stub is let go of once, whichever comes.
    const state: { held?: HeldSubscription; lost: boolean; gone: boolean } = {
      lost: false,
      gone: false,
    };
    const letGo = (): void => {
      if (state.held !== undefined && !state.gone) {
        state.gone = true;
        state.held[Symbol.dispose]();
      }
    };
    const callback = Object.assign(
      (snapshot: unknown): void => {
        onSnapshot(snapshot);
      },
      {
        [Symbol.dispose]: (): void => {
          state.lost = true;
          letGo();
          onLost();
        },
      }
    );
    state.held = await page().watchQuery(request, callback);
    if (state.lost) {
      letGo();
    }
    return {
      release: () => {
        if (state.held !== undefined && !state.gone) {
          state.gone = true;
          void releaseQuietly(state.held);
        }
      },
    };
  },
  stream: async (what, request, onFrame) => {
    const link = await page().streamFunction(what, request, async (frame) => {
      await Promise.resolve();
      onFrame(frame);
    });
    return {
      // Released, then let go of: the page holds the subscription's stub
      // until it is disposed, whatever became of the stream.
      release: async () => {
        try {
          await link.release();
        } finally {
          link[Symbol.dispose]();
        }
      },
    };
  },
  cancelStream: async (request) => await page().cancelStream(request),
  // The page asks the person to confirm in its own dialog, then answers
  // with the confirmation it minted (page-host.ts): the frame never
  // holds one.
  decisions: {
    respond: async (run, decision, answer) =>
      await page().decide(run, decision, answer),
  },
  leaveGuard: (guarded) => {
    void quietly(async () => {
      await page().leaveGuard(guarded);
    });
  },
});

/**
 * Connects the frame to the page's bridge over `port`, each message as
 * text, which the page holds to a size (@grasp-os/shared/page-port).
 */
const connectBridge = (port: MessagePort): RpcStub<PageBridge> => {
  connected = new RpcSession<PageBridge>(portTransport(port)).getRemoteMain();
  return connected;
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

/** An error's message and stack, as far as it has them, never throwing. */
const read = (value: unknown): Pick<PageProblem, "message" | "stack"> => {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }
  try {
    return { message: typeof value === "string" ? value : String(value) };
  } catch {
    return { message: "(an error that can't be shown)" };
  }
};

/**
 * An error's message and stack, cut to what a report keeps. The page
 * takes no message over its port beyond a size and ends the session over
 * one that is; a stack names each module by its whole address, which in
 * this frame is the module's code, so it is far longer than what is kept.
 */
const describe = (value: unknown): Pick<PageProblem, "message" | "stack"> => {
  const { message, stack } = read(value);
  return {
    message: message.slice(0, pageLimits.report.message),
    stack: stack?.slice(0, pageLimits.report.stack),
  };
};

const send = async (problem: PageProblem): Promise<void> => {
  try {
    await bridge().report(problem);
  } catch {
    // Reporting must never fail the page, or report itself.
  }
};

const report = (problem: PageProblem): void => {
  void send(problem);
};

/**
 * Sends `value`, what went wrong, to the page as a problem of `kind`, as
 * the runtime's own reports are: for a preview's runtime, whose updates
 * fail outside what the runtime sees (preview-runtime.ts).
 */
export const reportProblem = (
  kind: "error" | "rejection",
  value: unknown
): void => {
  report({ kind, ...describe(value) });
};

/**
 * Sends the pages' uncaught errors and `console.error` calls to the
 * page: `entry` is the address of the route tree's module, beside which
 * every App module of the frame is (core's page-frame.ts).
 */
const reportProblems = (entry: string): void => {
  addEventListener("error", (event) => {
    report({ kind: "error", ...describe(event.error ?? event.message) });
  });
  addEventListener("unhandledrejection", (event) => {
    report({ kind: "rejection", ...describe(event.reason) });
  });
  const logError = console.error.bind(console);
  const appDirectory = new URL("./", entry).href;
  console.error = (...args: unknown[]) => {
    logError(...args);
    const [first] = args;
    const described = describe(first);
    // The App's own call is a problem; React's development warnings in a
    // preview, or a library's, only a warning (console-origin.ts).
    const fromApp = calledByApp(
      new Error("console.error called").stack ?? "",
      import.meta.url,
      appDirectory
    );
    report({
      kind: fromApp ? "console" : "warning",
      ...described,
      message: args
        .map((arg) => describe(arg).message)
        .join(" ")
        .slice(0, pageLimits.report.message),
    });
  };
};

/**
 * What a page shows in place of what failed to render: the failure's
 * own message when it is a structured SDK error (worded for people, and
 * never with a cause or stack, though App code can make one with any
 * message: this box is the App's, not the platform's), a plain sentence
 * otherwise, and a way to try again.
 */
const fallbackOf = (error: unknown, tryAgain: () => void): ReactNode =>
  createElement(
    "div",
    { role: "alert", className: "flex flex-col items-start gap-3 p-6" },
    createElement(
      "p",
      { className: "text-sm" },
      error instanceof GraspError
        ? error.message
        : "Something went wrong showing this page."
    ),
    // A plain button, not @grasp-os/ui's Button: the UI kit depends on
    // the SDK, so the SDK can't depend on it back. Styled with theme
    // utilities only, nothing arbitrary.
    createElement(
      "button",
      {
        type: "button",
        className:
          "rounded-md border px-3 py-1.5 text-sm outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        onClick: tryAgain,
      },
      "Try again"
    )
  );

interface BoundaryProps {
  /** Reads the queries that failed again, before the page renders again. */
  retry: () => void;
  children?: ReactNode;
}

/** What failed to render, if anything did (whatever was thrown, even `undefined`). */
interface BoundaryState {
  failure: { error: unknown } | null;
}

/**
 * The platform's error boundary around the App (spec 10.1), for what
 * fails outside a route's own (`defaultErrorComponent`): a query that
 * fails throws while rendering, and lands here instead of blanking the
 * frame. React offers no hook for this, so it is the runtime's one class
 * component; the React Compiler leaves classes as they are.
 */
class PageBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failure: null };
  }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { failure: { error } };
  }

  override render(): ReactNode {
    const { failure } = this.state;
    if (failure === null) {
      return this.props.children;
    }
    return fallbackOf(failure.error, () => {
      this.props.retry();
      this.setState({ failure: null });
    });
  }
}

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
    const routeTree = routeTreeOf(await import(entry));
    if (routeTree === undefined) {
      throw new Error(`${entry} has no route tree to route by.`);
    }
    hooks.loaded?.();
    // One client for the App session this frame runs, over the page's
    // bridge: every page in it reads through the same queries and
    // submissions, and none makes its own (spec 10.7.1).
    const client = new GraspClient({
      ...bridgeTransport(bridge),
      files: portFileTransport(filePort),
      links: portLinkTransport(linkPort),
    });
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

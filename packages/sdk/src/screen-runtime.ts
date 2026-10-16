import {
  screenFrameMounted,
  screenLimits,
} from "@grasp-os/shared/screen-limits";
/**
 * What runs an App's screen inside its sandboxed frame: it connects to the
 * page around the frame over the `MessagePort` the page hands it, renders
 * the screen, follows the page's theme and reports the screen's errors.
 * The frame's own document (served by core) loads this module first; App
 * code uses `@grasp-os/sdk/screen`, never this.
 *
 * The frame is a sandbox with an opaque origin and no network, so the port
 * is the screen's only way out: to its App's server, through the page,
 * which binds it to that one App.
 */
import { portTransport } from "@grasp-os/shared/screen-port";
import type { ScreenMounted, ScreenProblem } from "@grasp-os/shared/screens";
import { RpcSession } from "capnweb";
import type { RpcStub } from "capnweb";
import { Component, createElement, useEffect } from "react";
import type { ComponentType, ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { clientInternals, GraspClient } from "./client-core.ts";
import type { ClientTransport } from "./client-core.ts";
import { GraspError } from "./client-error.ts";
import { portFileTransport } from "./file-port.ts";
import type { DraftPersistence } from "./form-drafts.ts";
import { GraspProvider } from "./react.ts";

export type Theme = "light" | "dark";

/**
 * What the page gives the frame over its port, and nothing else. Answers
 * and failures come back as they are; a screen reads them as its own data.
 */
export interface ScreenBridge {
  /**
   * Calls `method` of the App's server with `args`, for the person using
   * the screen. Functions among `args` reach the server as callbacks it
   * can keep and call later.
   */
  call: (method: string, args: unknown[]) => Promise<unknown>;
  /**
   * Calls one of the App's functions (spec 32.6), for the person using the
   * screen: `request` is the call as JSON text (its reference, input and
   * idempotency key), passed to core as it is; the answer is core's
   * `{ result, fingerprint, manifestHash }`, the last null for an action
   * answered by its invocation, which keeps no release. The transport the screen
   * client builds on, not a call for screen code itself.
   */
  callFunction: (request: string) => Promise<unknown>;
  /**
   * Follows one of the App's streaming actions (spec 10.7.6): `what` is
   * `stream` (start it, or join it under the same key) or `attach` (read
   * it again, never starting it), `request` as for `callFunction`.
   * `onFrame` gets each frame core sent, one at a time, the next only once
   * it has answered, then `{ type: "closed" }` once the connection ends
   * without a result. Answers the subscription, to `release()` once the
   * screen stops following it. The transport the screen client builds on.
   */
  streamFunction: (
    what: string,
    request: string,
    onFrame: (frame: unknown) => Promise<void>
  ) => Promise<{ release: () => void }>;
  /** Cancels the streaming action's invocation `request` names, for everyone. */
  cancelStream: (request: string) => Promise<unknown>;
  /** Adds a problem to the App's error log. */
  report: (problem: ScreenProblem) => void;
  /** Calls `onTheme` with the page's theme now and whenever it changes. */
  theme: (onTheme: (theme: Theme) => void) => void;
  /** Starts a run of the App's workflow, for the person. */
  startRun: (workflow: string, input: unknown) => Promise<unknown>;
  /** The App's runs of `workflow`, newest first. */
  runs: (workflow: string) => Promise<unknown>;
  /** One of the App's runs as it is now. */
  run: (run: string) => Promise<unknown>;
  /** Answers the decision `decision` of one of the App's runs. */
  decide: (run: string, decision: string, answer: unknown) => Promise<unknown>;
  /** Pauses, resumes or cancels one of the App's runs (`kind`). */
  control: (run: string, kind: string) => Promise<unknown>;
  /** One of the App's runs, as its summary of one revision. */
  summary: (run: string) => Promise<unknown>;
  /**
   * Calls `onChange` each time one of the App's runs of `workflow`
   * changes, until the subscription it answers is released (`release()`)
   * or core lets go of `onChange`.
   */
  watchRuns: (
    workflow: string,
    onChange: (change: unknown) => void
  ) => Promise<unknown>;
  /**
   * Follows one of the App's queries (spec 11): `request` is the call as
   * `callFunction` sends it; `onSnapshot` gets each result core pushes
   * (`{ revision, result }`), until the subscription it answers is
   * released (`release()`) or core lets go of `onSnapshot`. The transport
   * the screen client follows queries over, not a call for screen code.
   */
  watchQuery: (
    request: string,
    onSnapshot: (snapshot: unknown) => void
  ) => Promise<{ release: () => Promise<void> }>;
  /**
   * The person's unsaved record-form drafts of this App the page kept for
   * the tab, by key, as text (`@grasp-os/sdk`'s form-drafts.ts).
   */
  drafts: () => Promise<Record<string, string>>;
  /** Keeps `text` as the draft `key`, or drops it (`null`). */
  saveDraft: (key: string, text: string | null) => void;
  /** Drops every draft of this person and App: access was lost. */
  clearDrafts: () => void;
}

let connected: RpcStub<ScreenBridge> | undefined;

/** The page's bridge, once the frame has connected. */
export const bridge = (): RpcStub<ScreenBridge> => {
  if (!connected) {
    throw new Error("The screen isn't connected to its page yet.");
  }
  return connected;
};

/** A subscription the page answered: released, and let go of, once. */
type HeldSubscription = Awaited<
  ReturnType<RpcStub<ScreenBridge>["watchQuery"]>
>;

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

/**
 * The session client's transport over the page's bridge `page`: calls as
 * function calls, queries followed with `watchQuery`. Core's letting go
 * of a callback reaches it as the callback's disposal (Cap'n Web
 * disposes a callback once nothing can call it any more), which the
 * client reads as a lost subscription; the subscription's stub is let go
 * of then too.
 */
export const bridgeTransport = (
  page: () => RpcStub<ScreenBridge>
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
});

/** Runs `call` on the page, never failing the screen if the page can't. */
const quietly = async (call: () => Promise<unknown>): Promise<void> => {
  try {
    await call();
  } catch {
    // A draft not kept by the page stays in the frame's memory.
  }
};

/**
 * How long the frame waits for the page to hand over its drafts before
 * the screen first renders: past it (the page's connection to core lost,
 * say), the screen starts without them, rather than the page giving up on
 * the whole screen as one that never started.
 */
export const draftLookupMs = 1500;

/** What `work` answers within `ms`, or undefined after; its later failure unheard. */
const within = async <T>(
  work: Promise<T>,
  ms: number
): Promise<T | undefined> => {
  void quietly(async () => await work);
  const late: unique symbol = Symbol("late");
  const { promise, resolve } = Promise.withResolvers<typeof late>();
  const timer = setTimeout(() => {
    resolve(late);
  }, ms);
  try {
    const answer = await Promise.race([work, promise]);
    return answer === late ? undefined : answer;
  } finally {
    clearTimeout(timer);
  }
};

/** What of the page's bridge keeps a frame's drafts. */
export interface DraftPage {
  readonly drafts: () => Promise<unknown>;
  readonly saveDraft: (key: string, text: string | null) => Promise<unknown>;
  readonly clearDrafts: () => Promise<unknown>;
}

/** Most changes a frame holds while the page hasn't handed its drafts over. */
const draftsWaitingMost = 2 * screenLimits.drafts.perApp;

/** How many times in a row the page is asked again for its drafts. */
const draftAsksMost = 5;

/**
 * Where the session client keeps drafts: the page, which hands over the
 * App's drafts it kept for the person, or none if it can't within
 * `draftLookupMs`. An answer that comes later is never applied, as a
 * draft restored into a form the person has started on could overwrite
 * it; the changes made meanwhile are written once it comes.
 */
export const pageDrafts = async (
  page: DraftPage
): Promise<DraftPersistence> => {
  let initial: Record<string, string> = {};
  // Whether the page said what it keeps. Until it has, this frame's
  // changes wait here, the newest of each draft, so none it couldn't hand
  // over is replaced by an edit made without it before it answered; once
  // it answers, they are written, the person's edits and drops being
  // newer than what it kept.
  let handedOver = false;
  const waiting = new Map<string, string | null>();
  /** The page asked again, after a lookup that failed: how often, and when next. */
  let asks = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const send = (key: string, text: string | null): void => {
    void quietly(async () => {
      await page.saveDraft(key, text);
    });
  };
  // Once the page answers, what waits is written: the person's edits of a
  // record, made in this frame, replace what the page kept of it that the
  // frame never showed (its answer came too late), and their saves and
  // discards drop it. A draft of a record they didn't touch stays, for
  // the next load. Their edits are kept as long as they type, never held
  // back for a draft they can't see.
  const answered = (): void => {
    if (handedOver) {
      return;
    }
    handedOver = true;
    for (const [key, text] of waiting) {
      send(key, text);
    }
    waiting.clear();
  };
  /** Asks the page for its drafts: a provider that throws at once rejects. */
  const ask = async (): Promise<unknown> => await page.drafts();
  /**
   * Asks the page again, a while after, while changes wait for it: a few
   * times at most, each a lookup's time apart, and again at the next
   * change once those are spent.
   */
  const askAgain = (): void => {
    if (handedOver || retry !== undefined || asks >= draftAsksMost) {
      return;
    }
    asks += 1;
    retry = setTimeout(() => {
      // Its answer, whenever it comes, writes what waits; the next ask
      // comes a lookup's time later, answered or not.
      const asked = ask();
      void quietly(async () => {
        await asked;
        answered();
      });
      retry = setTimeout(() => {
        retry = undefined;
        if (!handedOver && waiting.size > 0) {
          askAgain();
        }
      }, draftLookupMs);
    }, draftLookupMs);
  };
  const lookup = ask();
  try {
    const kept: unknown = await within(lookup, draftLookupMs);
    // Late (`within` answers nothing): not handed over yet.
    if (typeof kept === "object" && kept !== null) {
      initial = Object.fromEntries(
        Object.entries(kept).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      );
      handedOver = true;
    } else {
      // Its answer, when it comes, is never applied: only what waits is
      // written then.
      void quietly(async () => {
        await lookup;
        answered();
      });
    }
  } catch {
    // The page can't say now: asked again as drafts change.
  }
  return {
    initial,
    write: (key, text) => {
      if (handedOver) {
        send(key, text);
        return;
      }
      waiting.delete(key);
      waiting.set(key, text);
      // Bounded however long the page can't answer: past twice an App's
      // count of drafts, the oldest change waiting is sent now rather than
      // let go of, so no drop of a draft the page keeps is lost. The page
      // writes it as it would once it answers: the person's change is
      // newer than anything it kept.
      if (waiting.size > draftsWaitingMost) {
        const [oldest] = waiting;
        if (oldest !== undefined) {
          waiting.delete(oldest[0]);
          send(...oldest);
        }
      }
      // A change after the asks were spent asks again.
      if (retry === undefined && asks >= draftAsksMost) {
        asks = 0;
      }
      askAgain();
    },
    clear: () => {
      waiting.clear();
      void quietly(async () => {
        await page.clearDrafts();
      });
    },
  };
};

/**
 * Connects the frame to the page's bridge over `port`, each message as
 * text, which the page holds to a size (@grasp-os/shared/screen-port).
 */
export const connectBridge = (port: MessagePort): RpcStub<ScreenBridge> => {
  connected = new RpcSession<ScreenBridge>(portTransport(port)).getRemoteMain();
  return connected;
};

/**
 * Which start of the frame this is, as the page handed it over with the
 * screen: the frame's load, the hash of the code and the page's name for
 * this start. The runtime only says them back (`screenFrameMounted`).
 */
export type ScreenStart = Omit<ScreenMounted, "type">;

/**
 * Renders nothing; tells the page the screen has rendered for the first
 * time. An effect runs once React has put the first render on the page,
 * so a screen that fails or never finishes its first render says nothing,
 * and the page gives up on it.
 *
 * This only tells the page a start that worked from one that didn't. The
 * screen's own code runs in this same frame and could post the same
 * message; the page gives a mounted screen nothing it wouldn't otherwise.
 */
const Mounted = ({ start }: { start: ScreenStart }) => {
  useEffect(() => {
    parent.postMessage({ type: screenFrameMounted, ...start }, "*");
  }, [start]);
  return null;
};

/** An error's message and stack, as far as it has them, never throwing. */
const read = (value: unknown): Pick<ScreenProblem, "message" | "stack"> => {
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
const describe = (value: unknown): Pick<ScreenProblem, "message" | "stack"> => {
  const { message, stack } = read(value);
  return {
    message: message.slice(0, screenLimits.report.message),
    stack: stack?.slice(0, screenLimits.report.stack),
  };
};

const send = async (problem: ScreenProblem): Promise<void> => {
  try {
    await bridge().report(problem);
  } catch {
    // Reporting must never fail the screen, or report itself.
  }
};

const report = (problem: ScreenProblem): void => {
  void send(problem);
};

/** Sends the screen's uncaught errors and `console.error` calls to the page. */
const reportProblems = (): void => {
  addEventListener("error", (event) => {
    report({ kind: "error", ...describe(event.error ?? event.message) });
  });
  addEventListener("unhandledrejection", (event) => {
    report({ kind: "rejection", ...describe(event.reason) });
  });
  const logError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    logError(...args);
    const [first] = args;
    const described = describe(first);
    report({
      kind: "console",
      ...described,
      message: args
        .map((arg) => describe(arg).message)
        .join(" ")
        .slice(0, screenLimits.report.message),
    });
  };
};

/**
 * What a screen shows in place of what failed to render: the failure's
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
        : "Something went wrong showing this screen."
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
  /** Reads the queries that failed again, before the screen renders again. */
  retry: () => void;
  children?: ReactNode;
}

/** What failed to render, if anything did (whatever was thrown, even `undefined`). */
interface BoundaryState {
  failure: { error: unknown } | null;
}

/**
 * The platform's error boundary around every screen (spec 10.1): a query
 * that fails throws while rendering, and lands here instead of blanking
 * the frame. React offers no hook for this, so it is the runtime's one
 * class component; the React Compiler leaves classes as they are.
 */
class ScreenBoundary extends Component<BoundaryProps, BoundaryState> {
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

const isScreenModule = (value: unknown): value is { default: ComponentType } =>
  typeof value === "object" &&
  value !== null &&
  "default" in value &&
  typeof value.default === "function";

/**
 * Runs the screen whose module is `screen` (a name in the frame's import
 * map), connected to the page through `port`, its files through
 * `filePort` (file-port.ts), and tells the page once it has rendered for
 * the first time, as the `start` the page named.
 */
export const runScreen = async (
  port: MessagePort,
  screen: string,
  start: ScreenStart,
  filePort: MessagePort
): Promise<void> => {
  const page = connectBridge(port);
  reportProblems();
  const root = document.createElement("div");
  document.body.append(root);
  try {
    await page.theme((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    });
    const loaded: unknown = await import(screen);
    if (!isScreenModule(loaded)) {
      throw new Error(`${screen} has no default export to render.`);
    }
    // One client for the App session this frame runs, over the page's
    // bridge: every screen in it reads through the same queries and
    // submissions, and none makes its own (spec 10.7.1).
    const client = new GraspClient({
      ...bridgeTransport(bridge),
      drafts: await pageDrafts(page),
      files: portFileTransport(filePort),
    });
    createRoot(root, {
      onUncaughtError: (error) => {
        report({ kind: "error", ...describe(error) });
      },
      // What the boundary caught: of a structured SDK error only its code
      // and request ID, never the domain message it may carry.
      onCaughtError: (error) => {
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
        // Inside the boundary: a screen whose first render throws replaces
        // `Mounted` with the fallback too, so the page never hears that a
        // start which didn't work did.
        createElement(
          ScreenBoundary,
          {
            retry: () => {
              clientInternals(client).retryFailed();
            },
          },
          createElement(loaded.default),
          createElement(Mounted, { start })
        )
      )
    );
  } catch (error) {
    report({ kind: "error", ...describe(error) });
  }
};

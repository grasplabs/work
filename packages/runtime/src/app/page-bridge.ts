import { portTransport } from "@grasp-os/shared/page-port";
import type { PageProblem } from "@grasp-os/shared/pages";
import { RpcSession } from "capnweb";
import type { RpcStub } from "capnweb";

import type { ClientTransport } from "./client-transport.ts";

// The frame's one way out: the page's bridge over the port the page hands
// the frame (Cap'n Web), and the session client's transport over it.

export type Theme = "light" | "dark";

/**
 * What the page gives the frame over its port, and nothing else. Answers
 * and failures come back as they are; a page reads them as its own data.
 */
export interface PageBridge {
  /**
   * Calls one of the App's functions, for the person using the
   * page: `request` is the call as JSON text (its reference, args and
   * idempotency key), passed to core as it is; the answer is core's
   * `{ result, fingerprint, manifestHash }`, the last null for an action
   * answered by its invocation, which keeps no release. The transport the page
   * client builds on, not a call for page code itself.
   */
  callFunction: (request: string) => Promise<unknown>;
  /**
   * Follows one of the App's streaming actions: `what` is
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
   * Follows one of the App's queries: `request` is the call as
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
export const connectBridge = (port: MessagePort): RpcStub<PageBridge> => {
  connected = new RpcSession<PageBridge>(portTransport(port)).getRemoteMain();
  return connected;
};

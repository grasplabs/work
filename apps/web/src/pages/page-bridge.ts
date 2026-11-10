import type {
  PreviewApplied,
  PreviewLoad,
  PageBridge,
  Theme,
} from "@grasp-os/runtime/page";
import { requestErrors } from "@grasp-os/shared/errors";
import { functionRequestMaxBytes } from "@grasp-os/shared/function-limits";
import { portTransport } from "@grasp-os/shared/page-port";
import {
  rpcArgumentDepth,
  rateLimited,
  pageErrors,
  pageHrefSchema,
  pageLimits,
  pageProblemSchema,
} from "@grasp-os/shared/pages";
import type { PageProblem } from "@grasp-os/shared/pages";
import {
  accountedTransport,
  rpcCopyNodeBounds,
} from "@grasp-os/shared/rpc-accounting";
import { boundedRpcTarget } from "@grasp-os/shared/rpc-target";
import { takeToken } from "@grasp-os/shared/token-bucket";
import type { TokenBucket } from "@grasp-os/shared/token-bucket";
import { RpcSession, RpcStub } from "capnweb";

// What a page's frame reaches through its port, and nothing else: its
// target (its own App's server and workflow runs, and where its problems
// go) and the page's theme. Everything the frame sends is untrusted.
//
// The frame's traffic is bounded before it reaches core: each message in
// size and nodes (`pageLimits.rpc`, by the accountant on the port, which
// ends the session over one that is too much) and in depth (by Cap'n Web),
// what each call of the bridge's gets to the same depth and size however
// many messages built it (a value one message refers to from another's:
// `FrameRpcTarget`), its requests and reports by rate. A value too deep for core's connection would otherwise end the
// person's whole connection to core, not only this page's call. That
// spares the person's connection a page that floods; it is not what
// holds a page to its limits. Core counts the same per person and App
// (core's pages-rpc.ts), also for a browser that skips this page.
//
// Closing the bridge ends the session: the port closes, and everything the
// frame held through it is let go, the subscriptions core gave it too
// (core releases one when its stub is dropped).

/**
 * Where a frame's calls go, checked by the bridge first: a running App's
 * page, or a draft's preview (page-host.ts).
 */
export interface FrameTarget {
  callFunction: (request: string) => Promise<unknown>;
  /** Follows a streaming action's invocation (page-stream.ts). */
  streamFunction: (
    what: "stream" | "attach",
    request: string,
    onFrame: (frame: unknown) => Promise<unknown>,
    /** Called once the stream has ended, however it ended. */
    onEnded: () => void
  ) => Promise<{ release: () => void }>;
  /** Cancels a streaming action's invocation, for everyone following it. */
  cancelStream: (request: string) => Promise<unknown>;
  report: (problem: PageProblem) => Promise<void>;
  decide: (run: string, decision: string, answer: unknown) => Promise<unknown>;
  watchQuery: (
    request: string,
    onSnapshot: unknown
  ) => Promise<{ release: () => Promise<void> }>;
  /** Where in the App the frame opens: the route the page's address carries. */
  location: () => string;
  /**
   * The frame's router went to `href`, a path of the App's own
   * (`pageHrefSchema`): the target carries it in the page's address, as
   * a new entry (`push`) or in place of the current one.
   */
  navigated: (href: string, push: boolean) => void;
  /**
   * Takes what tells the frame's router where the page's address says the
   * App is, which the target calls whenever that changes without the
   * frame asking (back, forward, a link of the page's).
   */
  follow: (toFrame: (href: string) => void) => void;
  /**
   * Whether the page holds unsaved edits or an unknown outcome now: the
   * target confirms once before the page leaves it while it does.
   */
  leaveGuard: (guarded: boolean) => void;
  /**
   * A chat's preview's alone: takes the frame's receiver of its draft's
   * updates (preview-updates.ts), which only the target calls. A live
   * page's target has none, and nothing is ever sent to its frame.
   */
  followUpdates?: (
    toFrame: (load: PreviewLoad) => Promise<PreviewApplied>
  ) => void;
}

/** The page's theme, as the `dark` class on its root says (theme.js). */
const pageTheme = (): Theme =>
  document.documentElement.classList.contains("dark") ? "dark" : "light";

type ThemeCallback = (theme: Theme) => void;

/** What the frame passes for a stream's frames: called with each. */
type FrameCallback = (frame: unknown) => Promise<void>;

/** A stub the frame passed for a stream's frames, as for its theme. */
const isFrameCallback = (value: unknown): value is RpcStub<FrameCallback> =>
  value instanceof RpcStub;

/**
 * A stub the frame passed for its theme callback. The page only calls it;
 * a stub of anything else fails in the frame, not here.
 */
const isThemeCallback = (value: unknown): value is RpcStub<ThemeCallback> =>
  value instanceof RpcStub;

type LocationCallback = (href: string) => void;

/** A stub the frame passed for where the page's address goes, as for its theme. */
const isLocationCallback = (
  value: unknown
): value is RpcStub<LocationCallback> => value instanceof RpcStub;

type LoadReceiver = (load: PreviewLoad) => Promise<unknown>;

/** A stub the frame passed for its receiver of a preview's updates. */
const isLoadReceiver = (value: unknown): value is RpcStub<LoadReceiver> =>
  value instanceof RpcStub;

/** What a frame may answer a version of its page with. */
const previewAnswers: ReadonlySet<unknown> = new Set<PreviewApplied>([
  "broken",
  "applied",
  "failed",
  "reset",
  "refused",
]);

/** Whether `value` is one of `previewAnswers`. */
const isPreviewAnswer = (value: unknown): value is PreviewApplied =>
  previewAnswers.has(value);

/** Sends the page's theme to the frame, until the frame is gone. */
const sendTheme = async (
  toFrame: RpcStub<ThemeCallback>,
  observer: MutationObserver
): Promise<void> => {
  try {
    await toFrame(pageTheme());
  } catch {
    observer.disconnect();
  }
};

/** Waits for `sent`, a call into the frame, never failing on a frame that is gone. */
const quietly = async (sent: Promise<unknown>): Promise<void> => {
  try {
    await sent;
  } catch {
    // The frame is gone, or closed its side: nothing follows it.
  }
};

/** A string the frame passed, or `page.invalid`. */
const text = (value: unknown): string => {
  if (typeof value !== "string") {
    throw pageErrors.create("page.invalid");
  }
  return value;
};

/**
 * What the bridge extends: each call's arguments arrive within what one
 * message of the frame's may hold (`request.too_deep`,
 * `request.too_large`), before any of the bridge's code sees them.
 */
const FrameRpcTarget = boundedRpcTarget({
  depth: rpcArgumentDepth,
  size: pageLimits.rpc.maxMessageSize,
});

/** How long a leave guard held past its budget waits: one token's worth. */
const guardRetryMs = 60_000 / pageLimits.leaveGuards.perMinute;

class Bridge extends FrameRpcTarget implements PageBridge {
  readonly #target: FrameTarget;
  readonly #cleanups: (() => void)[];
  #requests: TokenBucket | undefined;
  #reports: TokenBucket | undefined;
  #leaveGuards: TokenBucket | undefined;
  #navigations: TokenBucket | undefined;
  /** The newest leave guard held back past its budget, and its retry. */
  #heldGuard: { guarded: boolean; stop: () => void } | undefined;
  #themed = false;
  #followed = false;
  #refreshed = false;

  constructor(target: FrameTarget, cleanups: (() => void)[]) {
    super();
    this.#target = target;
    this.#cleanups = cleanups;
  }

  /** Counts one request of the frame's, or refuses it: `page.rate_limited`. */
  #request(): void {
    const { taken, bucket } = takeToken(
      this.#requests,
      pageLimits.requests,
      Date.now()
    );
    this.#requests = bucket;
    if (!taken) {
      throw rateLimited();
    }
  }

  /**
   * Passes a function call's request on as the frame sent it: text, no
   * longer than core reads of one (`functionRequestMaxBytes`, counted here
   * in UTF-16 code units, which core then bounds again in bytes).
   */
  async callFunction(request: unknown): Promise<unknown> {
    this.#request();
    if (
      typeof request !== "string" ||
      request.length > functionRequestMaxBytes
    ) {
      throw pageErrors.create("page.invalid");
    }
    return await this.#target.callFunction(request);
  }

  /**
   * Follows a streaming action for the frame: its request checked as
   * `callFunction` checks one, its frames handed to the frame's callback
   * one at a time (page-stream.ts). Answers the subscription, which the
   * frame releases, and which closing the bridge releases too.
   */
  async streamFunction(
    what: unknown,
    request: unknown,
    onFrame: unknown
  ): Promise<{ release: () => void }> {
    this.#request();
    if (
      (what !== "stream" && what !== "attach") ||
      typeof request !== "string" ||
      request.length > functionRequestMaxBytes ||
      !isFrameCallback(onFrame)
    ) {
      throw pageErrors.create("page.invalid");
    }
    const toFrame = onFrame.dup();
    const deliver = async (frame: unknown): Promise<null> => {
      await toFrame(frame);
      return null;
    };
    // What the bridge keeps of the stream until it ends, or the bridge
    // closes: let go of as soon as either happens, so a frame that starts
    // stream after stream holds no more than those still running.
    const held: { subscription?: { release: () => void } } = {};
    let ended = false;
    const cleanup = (): void => {
      if (ended) {
        return;
      }
      ended = true;
      held.subscription?.release();
      toFrame[Symbol.dispose]();
      const at = this.#cleanups.indexOf(cleanup);
      if (at !== -1) {
        this.#cleanups.splice(at, 1);
      }
    };
    // Kept before it is open: a bridge closed while the request is under
    // way lets go of the stream as soon as it arrives.
    this.#cleanups.push(cleanup);
    let opened: { release: () => void };
    try {
      opened = await this.#target.streamFunction(
        what,
        request,
        deliver,
        cleanup
      );
    } catch (error) {
      cleanup();
      throw error;
    }
    held.subscription = opened;
    if (ended) {
      // It ended, or the bridge closed, before it was handed over.
      opened.release();
    }
    return opened;
  }

  /** Cancels a streaming action's invocation, as `callFunction` checks it. */
  async cancelStream(request: unknown): Promise<unknown> {
    this.#request();
    if (
      typeof request !== "string" ||
      request.length > functionRequestMaxBytes
    ) {
      throw pageErrors.create("page.invalid");
    }
    return await this.#target.cancelStream(request);
  }

  async decide(
    run: unknown,
    decision: unknown,
    answer: unknown
  ): Promise<unknown> {
    this.#request();
    return await this.#target.decide(text(run), text(decision), answer);
  }

  /**
   * Follows a query of the App (spec 11): its request goes on as the
   * frame sent it, bounded as a function call's is, and its callback goes
   * on to core, which may only call it; the subscription core answers goes back to the
   * frame, to release. Following counts as a request; what core pushes
   * doesn't, and core bounds what a connection follows.
   */
  async watchQuery(
    request: unknown,
    onSnapshot: unknown
  ): Promise<{ release: () => Promise<void> }> {
    this.#request();
    if (
      typeof request !== "string" ||
      request.length > functionRequestMaxBytes
    ) {
      throw pageErrors.create("page.invalid");
    }
    return await this.#target.watchQuery(request, onSnapshot);
  }

  /** Where in the App the frame opens, as the page's address carries it. */
  async location(): Promise<string> {
    await Promise.resolve();
    return this.#target.location();
  }

  /**
   * Passes where the frame's router went on, once it is a path of the
   * App's own (`pageHrefSchema`) and within the frame's budget
   * (`pageLimits.navigations`); anything else is dropped, and the page
   * keeps its address. The address is the App's, inside the page's own
   * route for it: no frame names another page, App or origin.
   */
  navigated(href: unknown, push: unknown): void {
    const checked = pageHrefSchema.safeParse(href);
    if (!checked.success || typeof push !== "boolean") {
      return;
    }
    const { taken, bucket } = takeToken(
      this.#navigations,
      pageLimits.navigations,
      Date.now()
    );
    this.#navigations = bucket;
    if (taken) {
      this.#target.navigated(checked.data, push);
    }
  }

  /**
   * Once per frame: what tells its router where the page's address says
   * the App is, whenever that changes without the frame asking.
   */
  follow(onLocation: unknown): void {
    if (this.#followed || !isLocationCallback(onLocation)) {
      return;
    }
    this.#followed = true;
    const toFrame = onLocation.dup();
    this.#cleanups.push(() => {
      toFrame[Symbol.dispose]();
    });
    this.#target.follow((href) => {
      void quietly(toFrame(href));
    });
  }

  /**
   * Whether the page holds unsaved edits now; anything else, ignored.
   * Changes past their budget (`pageLimits.leaveGuards`) are gathered:
   * the newest is passed on once the bucket refills, so the page always
   * ends with what the page said last, however often it said it.
   */
  leaveGuard(guarded: unknown): void {
    if (typeof guarded !== "boolean") {
      return;
    }
    if (this.#heldGuard !== undefined) {
      this.#heldGuard.guarded = guarded;
      return;
    }
    this.#passGuard(guarded);
  }

  /** Passes `guarded` on within budget, or holds it for a retry. */
  #passGuard(guarded: boolean): void {
    const { taken, bucket } = takeToken(
      this.#leaveGuards,
      pageLimits.leaveGuards,
      Date.now()
    );
    this.#leaveGuards = bucket;
    if (taken) {
      this.#target.leaveGuard(guarded);
      return;
    }
    // Stopped with the bridge; let go of once it fired.
    const held = { guarded, stop: (): void => undefined };
    const timer = setTimeout(() => {
      const at = this.#cleanups.indexOf(held.stop);
      if (at !== -1) {
        this.#cleanups.splice(at, 1);
      }
      const newest = this.#heldGuard;
      this.#heldGuard = undefined;
      if (newest !== undefined) {
        this.#passGuard(newest.guarded);
      }
    }, guardRetryMs);
    held.stop = () => {
      clearTimeout(timer);
    };
    this.#heldGuard = held;
    this.#cleanups.push(held.stop);
  }

  /** Past what a page may report, or in no valid shape: dropped here. */
  report(problem: unknown): void {
    const { taken, bucket } = takeToken(
      this.#reports,
      pageLimits.callerReports,
      Date.now()
    );
    this.#reports = bucket;
    const parsed = pageProblemSchema.safeParse(problem);
    if (!taken || !parsed.success) {
      return;
    }
    void this.#report(parsed.data);
  }

  /** Once per frame: each call would keep another observer and stub. */
  theme(onTheme: unknown): void {
    if (this.#themed || !isThemeCallback(onTheme)) {
      return;
    }
    this.#themed = true;
    const toFrame = onTheme.dup();
    const observer = new MutationObserver(() => {
      void sendTheme(toFrame, observer);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    void sendTheme(toFrame, observer);
    this.#cleanups.push(() => {
      observer.disconnect();
      toFrame[Symbol.dispose]();
    });
  }

  /**
   * Once per frame, and only to a target that takes updates (a chat's
   * preview's): the frame's receiver of them. What it answers is the
   * frame's word, read as one of the answers it may give, never more:
   * the page decides what the frame is handed (preview-updates.ts).
   */
  refresh(onLoad: unknown): void {
    const follow = this.#target.followUpdates;
    if (this.#refreshed || follow === undefined || !isLoadReceiver(onLoad)) {
      return;
    }
    this.#refreshed = true;
    const toFrame = onLoad.dup();
    this.#cleanups.push(() => {
      toFrame[Symbol.dispose]();
    });
    follow(async (load) => {
      const answer: unknown = await toFrame(load);
      return isPreviewAnswer(answer) ? answer : "refused";
    });
  }

  async #report(problem: PageProblem): Promise<void> {
    try {
      await this.#target.report(problem);
    } catch {
      // A problem that can't be reported is dropped: there's no one to tell.
    }
  }
}

/**
 * What a frame reaches through its port: the one object `openBridge`
 * serves, a {@link FrameRpcTarget}.
 */
const frameBridge = (
  target: FrameTarget,
  cleanups: (() => void)[]
): PageBridge & InstanceType<typeof FrameRpcTarget> =>
  new Bridge(target, cleanups);

/**
 * Serves the bridge to `target` on `port`, the page's end of the frame's
 * channel. Returns what closes it: the session ends, the port closes, and
 * what the bridge kept for the frame (its theme observer, the stubs the
 * frame held) is let go. Closing it twice does nothing.
 *
 * `onBroken` is called if the session ends any other way: the frame sent
 * a message over the limits, or something that isn't a message, or closed
 * its end. Every call of the page's fails from then on, so the page has
 * to say so; the bridge is closed already.
 */
export const openBridge = (
  port: MessagePort,
  target: FrameTarget,
  onBroken: () => void
): (() => void) => {
  const cleanups: (() => void)[] = [];
  // Cap'n Web copies in full every value one message refers to from an
  // earlier one, and keeps every value pushed until it is released, before
  // any of the bridge's code runs, so a page could crash its tab the way
  // an unbounded connection could crash core. The accountant wraps the
  // port: it refuses a message longer than the port's or of too many nodes
  // before parsing it, parses it once and hands the value to Cap'n Web
  // (which then checks only depth and digits), and ends the session once
  // what the messages copy or hold would outgrow one message's budget or
  // the session's (`pageLimits.rpcHeldBytes`); `onBroken` then tells the
  // page, as for any other way the session ends.
  const session = new RpcSession(
    accountedTransport(
      portTransport(port),
      {
        ...rpcCopyNodeBounds,
        maxMessageBytes: pageLimits.rpc.maxMessageSize,
        maxSessionBytes: pageLimits.rpcHeldBytes,
      },
      () => requestErrors.create("request.too_expensive")
    ),
    frameBridge(target, cleanups),
    {
      limits: {
        maxDepth: pageLimits.rpc.maxDepth,
        maxBigIntDigits: pageLimits.rpc.maxBigIntDigits,
      },
    }
  );
  const frame = session.getRemoteMain();
  let open = true;
  const close = (): void => {
    if (!open) {
      return;
    }
    open = false;
    // A copy: a stream's cleanup takes itself off the list as it runs.
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    frame[Symbol.dispose]();
    port.close();
  };
  frame.onRpcBroken(() => {
    // Not when the page closed it itself.
    if (open) {
      close();
      onBroken();
    }
  });
  return close;
};

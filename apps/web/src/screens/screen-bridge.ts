import type { ScreenBridge, Theme } from "@grasp-os/sdk/screen-runtime";
import { portTransport } from "@grasp-os/shared/screen-port";
import {
  screenErrors,
  screenLimits,
  screenProblemSchema,
} from "@grasp-os/shared/screens";
import type { ScreenProblem } from "@grasp-os/shared/screens";
import { takeToken } from "@grasp-os/shared/token-bucket";
import type { TokenBucket } from "@grasp-os/shared/token-bucket";
import { RpcSession, RpcStub, RpcTarget } from "capnweb";

// What a screen's frame reaches through its port, and nothing else: its
// target (its own App's server and workflow runs, and where its problems
// go) and the page's theme. Everything the frame sends is untrusted.
//
// The frame's traffic is bounded before it reaches core: each message in
// size and depth (`screenLimits.rpc`, by Cap'n Web, which ends the session
// over one that is too much), its requests and reports by rate. That
// spares the person's connection a screen that floods; it is not what
// holds a screen to its limits. Core counts the same per person and App
// (core's screens-rpc.ts), also for a browser that skips this page.
//
// Closing the bridge ends the session: the port closes, and everything the
// frame held through it is let go, the subscriptions core gave it too
// (core releases one when its stub is dropped).

/**
 * Where a frame's calls go, checked by the bridge first: a running App's
 * screen, or a draft's preview (screen-host.ts).
 */
export interface FrameTarget {
  call: (method: string, args: unknown[]) => Promise<unknown>;
  report: (problem: ScreenProblem) => Promise<void>;
  startRun: (workflow: string, input: unknown) => Promise<unknown>;
  runs: (workflow: string) => Promise<unknown>;
  run: (run: string) => Promise<unknown>;
  decide: (run: string, decision: string, answer: unknown) => Promise<unknown>;
  watchRuns: (workflow: string, onChange: unknown) => Promise<unknown>;
}

/** The page's theme, as the `dark` class on its root says (theme.js). */
const pageTheme = (): Theme =>
  document.documentElement.classList.contains("dark") ? "dark" : "light";

type ThemeCallback = (theme: Theme) => void;

/**
 * A stub the frame passed for its theme callback. The page only calls it;
 * a stub of anything else fails in the frame, not here.
 */
const isThemeCallback = (value: unknown): value is RpcStub<ThemeCallback> =>
  value instanceof RpcStub;

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

/** A string the frame passed, or `screen.invalid`. */
const text = (value: unknown): string => {
  if (typeof value !== "string") {
    throw screenErrors.create("screen.invalid");
  }
  return value;
};

class Bridge extends RpcTarget implements ScreenBridge {
  readonly #target: FrameTarget;
  readonly #cleanups: (() => void)[];
  #requests: TokenBucket | undefined;
  #reports: TokenBucket | undefined;
  #themed = false;

  constructor(target: FrameTarget, cleanups: (() => void)[]) {
    super();
    this.#target = target;
    this.#cleanups = cleanups;
  }

  /** Counts one request of the frame's, or refuses it: `screen.rate_limited`. */
  #request(): void {
    const { taken, bucket } = takeToken(
      this.#requests,
      screenLimits.requests,
      Date.now()
    );
    this.#requests = bucket;
    if (!taken) {
      throw screenErrors.create("screen.rate_limited");
    }
  }

  async call(method: unknown, args: unknown): Promise<unknown> {
    this.#request();
    if (typeof method !== "string" || !Array.isArray(args)) {
      throw screenErrors.create("screen.invalid");
    }
    return await this.#target.call(method, args);
  }

  async startRun(workflow: unknown, input: unknown): Promise<unknown> {
    this.#request();
    return await this.#target.startRun(text(workflow), input);
  }

  async runs(workflow: unknown): Promise<unknown> {
    this.#request();
    return await this.#target.runs(text(workflow));
  }

  async run(run: unknown): Promise<unknown> {
    this.#request();
    return await this.#target.run(text(run));
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
   * The frame's callback goes on to core, which may only call it; the
   * subscription core answers goes back to the frame, to release. Core
   * holds a screen to a number of them at once.
   */
  async watchRuns(workflow: unknown, onChange: unknown): Promise<unknown> {
    return await this.#target.watchRuns(text(workflow), onChange);
  }

  /** Past what a screen may report, or in no valid shape: dropped here. */
  report(problem: unknown): void {
    const { taken, bucket } = takeToken(
      this.#reports,
      screenLimits.callerReports,
      Date.now()
    );
    this.#reports = bucket;
    const parsed = screenProblemSchema.safeParse(problem);
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

  async #report(problem: ScreenProblem): Promise<void> {
    try {
      await this.#target.report(problem);
    } catch {
      // A problem that can't be reported is dropped: there's no one to tell.
    }
  }
}

/**
 * Serves the bridge to `target` on `port`, the page's end of the frame's
 * channel. Returns what closes it: the session ends, the port closes, and
 * what the bridge kept for the frame (its theme observer, the stubs the
 * frame held) is let go. Closing it twice does nothing.
 */
export const openBridge = (
  port: MessagePort,
  target: FrameTarget
): (() => void) => {
  const cleanups: (() => void)[] = [];
  const session = new RpcSession(
    portTransport(port),
    new Bridge(target, cleanups),
    { limits: screenLimits.rpc }
  );
  const frame = session.getRemoteMain();
  let open = true;
  return () => {
    if (!open) {
      return;
    }
    open = false;
    for (const cleanup of cleanups) {
      cleanup();
    }
    frame[Symbol.dispose]();
    port.close();
  };
};

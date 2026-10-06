import { appErrors } from "@grasp-os/shared/apps";
import type { PreviewBundle } from "@grasp-os/shared/chat";
import { authErrors } from "@grasp-os/shared/errors";
import { roleErrors } from "@grasp-os/shared/roles";
import {
  screenErrors,
  screenFrameMessage,
  screenFramePath,
  screenLimits,
} from "@grasp-os/shared/screens";
import type { ScreenBundle } from "@grasp-os/shared/screens";

import { CoreLink } from "./core-link.ts";
import {
  inTime,
  isMounted,
  isReady,
  stage,
  StageTimeoutError,
} from "./frame-stages.ts";
import type { ExpectedStart } from "./frame-stages.ts";
import { openBridge } from "./screen-bridge.ts";
import type { FrameTarget } from "./screen-bridge.ts";

// The page's side of an App's screen. The screen runs in a sandboxed frame
// (core's screen-frame.ts) with no network, whose document core serves for
// the one build it handed the page, and which runs that build's modules
// and nothing else; the page hands it a Cap'n Web bridge over a
// `MessagePort`, which reaches only its own App's server, through the
// page's own connection to core. Core checks the
// person's session and role on every call; the page binds the bridge to
// one App, which the frame can't change.
//
// A preview of a chat's draft (`runPreview`) runs the same way, in the same
// frame, with its bridge bound to the draft instead: its server calls go to
// the draft's preview in core, which has no side effects; what its screen
// reports goes to the chat's agent; and its calls on the App's workflow
// runs start nothing and find none.
//
// Nothing the frame sends or its App answers is ever read as the platform
// speaking: answers and failures go back to the frame as they are, and the
// page shows a session as ended only when its own connection says so.
//
// A screen starts in two stages, ten seconds each (frame-stages.ts): the
// frame's document says it listens, then the screen says it has rendered.
// The page shows it as running only after the second, and a frame that
// misses either, or that leaves for another address, is stopped: its
// port, its bridge, its timers and what it follows in core all go, and
// the frame is emptied. Which App, version and screen a frame runs is
// what the page opened, never what the frame says.
//
// Core hands an App's data only to code an admin approved, unless an
// admin classified that data as fine for any code (core's
// screen-trust.ts). So a screen nobody approved isn't started at all
// (`open` refuses it), and one whose approval is taken back is stopped:
// the page gives core's lease on the frame's build back on the frame's
// connection (`present`), core decides every call on that build, and
// when it says the build no longer gets the data (as a refused call, or
// at the page's next check) the frame is emptied, and with it what the
// screen had been handed. That is all the page can take back; what a
// screen sent elsewhere before, it can't.

/** What the page shows about a screen besides the screen itself. */
export type ScreenState =
  | { status: "loading" }
  | { status: "running" }
  | { status: "updated" }
  | { status: "signed-out" }
  | { status: "failed"; reason: FailureReason };

export type FailureReason =
  | "forbidden"
  | "not-found"
  | "not-running"
  | "broken"
  /** The frame wasn't ready, or its screen hadn't rendered, in time. */
  | "timed-out"
  /** The frame went to another address, and was stopped. */
  | "left"
  /** The frame's channel to the page ended: over a limit, or closed. */
  | "disconnected"
  /** Nobody approved the screen's code for the App's data. */
  | "unreviewed"
  /** The approval of the screen's code was taken back. */
  | "revoked"
  | "unknown";

/**
 * How often the page asks whether the App has a new current version, and
 * whether the screen's build still gets the App's data.
 */
const versionCheckMs = 30_000;

const failures: Readonly<Record<string, FailureReason>> = {
  "role.forbidden": "forbidden",
  "app.unreadable": "forbidden",
  "app.not_found": "not-found",
  "app.no_draft": "not-found",
  "screen.not_found": "not-found",
  "screen.invalid": "not-found",
  "app.not_running": "not-running",
  "screen.build_failed": "broken",
  "screen.build_slow": "timed-out",
  "screen.unreviewed": "unreviewed",
  "screen.revoked": "revoked",
};

/** Why opening a screen failed, as the page says it. */
const failureOf = (error: unknown): FailureReason => {
  const code =
    roleErrors.codeOf(error) ??
    appErrors.codeOf(error) ??
    screenErrors.codeOf(error);
  return (code === undefined ? undefined : failures[code]) ?? "unknown";
};

/**
 * `value` as what core's call takes: the frame's input, passed on as it is
 * for core to check, as `call` passes its arguments.
 */
const forCore = (value: unknown): never =>
  // SAFETY: core checks every value a screen sends (screens-rpc.ts); the
  // page only binds the call to the screen's own App.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

/** A signed-in session's API, as the page's link to core gives it. */
type Session = Awaited<ReturnType<CoreLink["session"]>>;

/** Runs `run` on the link's signed-in session. */
const on = async <T>(
  link: CoreLink,
  run: (session: Session) => Promise<T>
): Promise<T> => {
  const session = await link.session();
  return await run(session);
};

/** Why core no longer hands a frame's build its App's data. */
type Refused = Extract<FailureReason, "unreviewed" | "revoked">;

/**
 * Asks core whether the frame's build still gets its App's data, and
 * calls `refused` when it doesn't. Core's own answer on the page's own
 * connection: never an error a call came back with, which an App's server
 * can word as it likes.
 */
const checkDelivery = async (
  link: CoreLink,
  { app, lease }: Pick<ScreenBundle, "app" | "lease">,
  refused: (reason: Refused) => void
): Promise<void> => {
  const session = await link.session();
  const delivery = await session.screens.present(app, lease);
  if (delivery !== "open") {
    refused(delivery);
  }
};

/** `checkDelivery`, for a call that doesn't wait for it. */
const checkDeliveryNow = async (
  link: CoreLink,
  bundle: Pick<ScreenBundle, "app" | "lease">,
  refused: (reason: Refused) => void
): Promise<void> => {
  try {
    await checkDelivery(link, bundle, refused);
  } catch {
    // Asked again at the page's next check.
  }
};

/** Whether core refused a call for the build the frame runs. */
const refusedForBuild = (error: unknown): boolean => {
  const code = screenErrors.codeOf(error);
  return code === "screen.unreviewed" || code === "screen.revoked";
};

/**
 * A running App's screen: its own App's server, runs and error log. Each
 * connection is told which build the frame runs before its first call,
 * with core's lease on it, so one made again after a break is too.
 */
const appTarget = (
  link: CoreLink,
  bundle: ScreenBundle,
  refused: (reason: Refused) => void
): FrameTarget => {
  const { app, version, screen, lease } = bundle;
  let presentedOn: Session | undefined;
  const framed = async <T>(
    run: (screens: Session["screens"]) => Promise<T>
  ): Promise<T> => {
    const session = await link.session();
    if (presentedOn !== session) {
      await session.screens.present(app, lease);
      presentedOn = session;
    }
    try {
      return await run(session.screens);
    } catch (error) {
      if (refusedForBuild(error)) {
        // The frame gets the refusal as it is; whether to stop it is
        // core's answer to the page.
        void checkDeliveryNow(link, bundle, refused);
      }
      throw error;
    }
  };
  return {
    call: async (method, args) =>
      await framed(async (screens) => await screens.call(app, method, args)),
    report: async (problem) => {
      await on(link, async ({ screens }) => {
        await screens.report(app, { version, screen }, problem);
      });
    },
    startRun: async (workflow, input) =>
      await framed(
        async (screens) => await screens.startRun(app, workflow, input)
      ),
    runs: async (workflow) =>
      await framed(async (screens) => await screens.runs(app, workflow)),
    run: async (run) =>
      await framed(async (screens) => await screens.run(app, run)),
    decide: async (run, decision, answer) =>
      await framed(
        async (screens) =>
          await screens.decide(app, run, decision, forCore(answer))
      ),
    watchRuns: async (workflow, onChange) =>
      await framed(
        async (screens) =>
          await screens.watchRuns(app, workflow, forCore(onChange))
      ),
  };
};

/**
 * What a preview refuses: starting, reading or answering a workflow run.
 * The same refusal as core's for a call a preview stub refused
 * (`app.preview_side_effect`), and handled alike: the refusal itself
 * fails no check, and what the screen reports of it is the draft's, as
 * of any failed call (core's preview-reports.ts).
 */
const refusedInPreview = async (): Promise<never> => {
  await Promise.resolve();
  throw appErrors.create("app.preview_side_effect");
};

/**
 * A preview of the chat's draft: its server calls go to the draft's
 * preview, what its screen reports to the chat's agent; it starts no
 * workflow run, finds none, and follows none.
 */
const previewTarget = (
  link: CoreLink,
  chatId: string,
  bundle: PreviewBundle
): FrameTarget => {
  const { app, revision, screen } = bundle;
  return {
    call: async (method, args) =>
      await on(
        link,
        async ({ chats }) =>
          await chats.previewCall(chatId, app, revision, method, args)
      ),
    report: async (problem) => {
      await on(link, async ({ chats }) => {
        await chats.previewReport(chatId, app, revision, screen, problem);
      });
    },
    startRun: refusedInPreview,
    runs: async () => await Promise.resolve([]),
    run: refusedInPreview,
    decide: refusedInPreview,
    watchRuns: async () =>
      await Promise.resolve({
        release: async () => {
          await Promise.resolve();
        },
      }),
  };
};

/** Which build a frame runs, and the App's name to show around it. */
type FrameCode = Pick<ScreenBundle, "name" | "artifact" | "frameToken">;

/** What a frame runs, and what its bridge reaches. */
interface FrameSource<Bundle extends FrameCode> {
  open: (session: Session) => Promise<Bundle>;
  /** `refused` stops the frame: core no longer hands its build the data. */
  target: (
    link: CoreLink,
    bundle: Bundle,
    refused: (reason: Refused) => void
  ) => FrameTarget;
  /**
   * Called once the screen runs, if given: `cleanups` stop what it
   * starts, `onState` says what the page shows, and `refused` stops the
   * frame.
   */
  running?: (
    link: CoreLink,
    bundle: Bundle,
    cleanups: (() => void)[],
    onState: (state: ScreenState) => void,
    refused: (reason: Refused) => void
  ) => void;
}

/**
 * Runs what `source` opens in `frame`: loads the frame's document for the
 * build core opened, and hands the frame its bridge. Tells the page what to show with `onState`, and the
 * App's name with `onOpened`. Returns a function that stops it all.
 */
const runFrame = <Bundle extends FrameCode>(
  frame: HTMLIFrameElement,
  source: FrameSource<Bundle>,
  onState: (state: ScreenState) => void,
  onOpened: (appName: string) => void
): (() => void) => {
  const stopped = new AbortController();
  const cleanups: (() => void)[] = [];
  const link = new CoreLink(() => {
    onState({ status: "signed-out" });
  });
  const frameWindow = (): unknown => frame.contentWindow;

  /**
   * Stops it all, once: what waits for the frame stops waiting, the
   * bridge and its port close, timers end, and the page's connection for
   * this frame closes, and with it what the frame followed in core.
   */
  const stop = (): void => {
    if (stopped.signal.aborted) {
      return;
    }
    stopped.abort();
    for (const cleanup of cleanups) {
      cleanup();
    }
    link.close();
  };

  /**
   * Stops a start that went wrong, and says so. The frame is emptied, so
   * no code of the screen runs on behind the message; trying again is a
   * new frame (screen-frame.tsx).
   */
  const fail = (state: ScreenState): void => {
    if (stopped.signal.aborted) {
      return;
    }
    stop();
    frame.removeAttribute("src");
    onState(state);
  };

  // The frame loads one document: its own, which `ready` answers for. A
  // load after that is the screen sending its frame to another address,
  // which the sandbox allows (the page's policy keeps it to this origin,
  // core's security-headers.ts); what loaded there is not ours, whatever
  // it says. A browser doesn't say where a frame went, and may say
  // nothing when that address fails to load: the screen is gone all the
  // same then, and only this message is missing.
  let loads = 0;
  frame.addEventListener(
    "load",
    () => {
      loads += 1;
      if (loads > 1) {
        fail({ status: "failed", reason: "left" });
      }
    },
    { signal: stopped.signal }
  );

  const start = async (): Promise<void> => {
    // Made up here for this start, and read back from the frame only to
    // compare: which load of the frame, and which start of it.
    const load = crypto.randomUUID();
    const generation = crypto.randomUUID();
    // The frame's document holds the build core opened, so it loads once
    // core said which.
    const bundle = await inTime(
      "opened",
      link.retrying(source.open),
      screenLimits.openMs
    );
    // Stopped meanwhile: nothing more is started, as nothing would stop it.
    if (stopped.signal.aborted) {
      return;
    }
    const ready = stage(
      "ready",
      (message) => isReady(message, frameWindow, load),
      window,
      stopped.signal
    );
    // Only now: the page listens before the frame can say it's ready.
    frame.src = `${screenFramePath}?${new URLSearchParams({
      load,
      artifact: bundle.artifact,
      token: bundle.frameToken,
    })}`;
    await ready;
    if (stopped.signal.aborted) {
      return;
    }
    const expected: ExpectedStart = {
      load,
      artifact: bundle.artifact,
      generation,
    };
    const refused = (reason: Refused): void => {
      fail({ status: "failed", reason });
    };
    const { port1, port2 } = new MessageChannel();
    cleanups.push(
      openBridge(port1, source.target(link, bundle, refused), () => {
        fail({ status: "failed", reason: "disconnected" });
      })
    );
    const mounted = stage(
      "mounted",
      (message) => isMounted(message, frameWindow, expected),
      window,
      stopped.signal
    );
    frame.contentWindow?.postMessage(
      { type: screenFrameMessage, ...expected },
      "*",
      [port2]
    );
    onOpened(bundle.name);
    // Running only once the screen has rendered, never because its frame
    // was started.
    await mounted;
    if (stopped.signal.aborted) {
      return;
    }
    onState({ status: "running" });
    source.running?.(link, bundle, cleanups, onState, refused);
  };

  const run = async (): Promise<void> => {
    try {
      await start();
    } catch (error) {
      if (error instanceof StageTimeoutError) {
        fail({ status: "failed", reason: "timed-out" });
        return;
      }
      fail(
        authErrors.codeOf(error) === "auth.unauthenticated"
          ? { status: "signed-out" }
          : { status: "failed", reason: failureOf(error) }
      );
    }
  };
  void run();

  return stop;
};

/**
 * Runs `screen` of `app` in `frame`, and watches for a new current
 * version, and for its build no longer getting the App's data
 * (`runFrame`).
 */
export const runScreen = (
  frame: HTMLIFrameElement,
  app: string,
  screen: string,
  onState: (state: ScreenState) => void,
  onOpened: (appName: string) => void
): (() => void) =>
  runFrame(
    frame,
    {
      open: async (session) => await session.screens.open(app, screen),
      target: appTarget,
      running: (link, bundle, cleanups, setState, refused) => {
        const { version } = bundle;
        const check = async (): Promise<void> => {
          try {
            // A screen that asks for nothing more still holds what it was
            // handed: this is when the page hears its approval is gone.
            await checkDelivery(link, bundle, refused);
            const session = await link.session();
            if ((await session.screens.version(app)) !== version) {
              setState({ status: "updated" });
            }
          } catch {
            // Asked again at the next check.
          }
        };
        const timer = setInterval(() => {
          void check();
        }, versionCheckMs);
        cleanups.push(() => {
          clearInterval(timer);
        });
      },
    },
    onState,
    onOpened
  );

/**
 * Runs `screen` (the draft's first when none is named) of the chat's
 * draft of `app` in `frame`, as a preview (`runFrame`).
 */
export const runPreview = (
  frame: HTMLIFrameElement,
  { chatId, app, screen }: { chatId: string; app: string; screen?: string },
  onState: (state: ScreenState) => void,
  onOpened: (appName: string) => void
): (() => void) =>
  runFrame(
    frame,
    {
      open: async (session) => await session.chats.preview(chatId, app, screen),
      // A preview reads no real data, so no approval decides it.
      target: (link, bundle) => previewTarget(link, chatId, bundle),
    },
    onState,
    onOpened
  );

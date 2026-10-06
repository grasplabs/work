import { appErrors } from "@grasp-os/shared/apps";
import type { PreviewBundle } from "@grasp-os/shared/chat";
import { authErrors } from "@grasp-os/shared/errors";
import { roleErrors } from "@grasp-os/shared/roles";
import {
  screenErrors,
  screenFrameMessage,
  screenFramePath,
} from "@grasp-os/shared/screens";
import type { ScreenBundle } from "@grasp-os/shared/screens";

import { CoreLink } from "./core-link.ts";
import {
  isMounted,
  isReady,
  stage,
  StageTimeoutError,
} from "./frame-stages.ts";
import type { ExpectedStart } from "./frame-stages.ts";
import { openBridge } from "./screen-bridge.ts";
import type { FrameTarget } from "./screen-bridge.ts";

// The page's side of an App's screen. The screen runs in a sandboxed frame
// (core's screen-frame.ts) with no network; the page hands it its code and
// a Cap'n Web bridge over a `MessagePort`, which reaches only its own App's
// server, through the page's own connection to core. Core checks the
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
  | "unknown";

/** How often the page asks whether the App has a new current version. */
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

/** A running App's screen: its own App's server, runs and error log. */
const appTarget = (link: CoreLink, bundle: ScreenBundle): FrameTarget => {
  const { app, version, screen } = bundle;
  return {
    call: async (method, args) =>
      await on(
        link,
        async ({ screens }) => await screens.call(app, method, args)
      ),
    report: async (problem) => {
      await on(link, async ({ screens }) => {
        await screens.report(app, { version, screen }, problem);
      });
    },
    startRun: async (workflow, input) =>
      await on(
        link,
        async ({ screens }) => await screens.startRun(app, workflow, input)
      ),
    runs: async (workflow) =>
      await on(link, async ({ screens }) => await screens.runs(app, workflow)),
    run: async (run) =>
      await on(link, async ({ screens }) => await screens.run(app, run)),
    decide: async (run, decision, answer) =>
      await on(
        link,
        async ({ screens }) =>
          await screens.decide(app, run, decision, forCore(answer))
      ),
    watchRuns: async (workflow, onChange) =>
      await on(
        link,
        async ({ screens }) =>
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

/** A module as a URL the frame's import map can name. */
const dataUrl = (code: string): string =>
  `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;

/** What a frame runs of a screen, and the App's name to show around it. */
type FrameCode = Pick<
  ScreenBundle,
  "name" | "entry" | "runtime" | "modules" | "kit" | "css" | "artifact"
>;

/** The frame's import map: the kit's modules it needs and the App's own. */
const importsOf = (bundle: FrameCode): Record<string, string> =>
  Object.fromEntries(
    [...Object.entries(bundle.kit), ...Object.entries(bundle.modules)].map(
      ([name, code]) => [name, dataUrl(code)]
    )
  );

/** What a frame runs, and what its bridge reaches. */
interface FrameSource<Bundle extends FrameCode> {
  open: (session: Session) => Promise<Bundle>;
  target: (link: CoreLink, bundle: Bundle) => FrameTarget;
  /**
   * Called once the screen runs, if given: `cleanups` stop what it
   * starts, and `onState` says what the page shows.
   */
  running?: (
    link: CoreLink,
    bundle: Bundle,
    cleanups: (() => void)[],
    onState: (state: ScreenState) => void
  ) => void;
}

/**
 * Runs what `source` opens in `frame`: loads it, and hands the frame its
 * code and bridge. Tells the page what to show with `onState`, and the
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
    const ready = stage(
      "ready",
      (message) => isReady(message, frameWindow, load),
      window,
      stopped.signal
    );
    // Only now: the page listens before the frame can say it's ready.
    frame.src = `${screenFramePath}?${new URLSearchParams({ load })}`;
    // Whichever fails first fails the start: a frame that isn't ready in
    // time doesn't wait for a build that takes longer.
    const [bundle] = await Promise.all([link.retrying(source.open), ready]);
    // Stopped just as both came: nothing more is started, as nothing
    // would stop it.
    if (stopped.signal.aborted) {
      return;
    }
    const expected: ExpectedStart = {
      load,
      artifact: bundle.artifact,
      generation,
    };
    const { port1, port2 } = new MessageChannel();
    cleanups.push(
      openBridge(port1, source.target(link, bundle), () => {
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
      {
        type: screenFrameMessage,
        ...expected,
        imports: importsOf(bundle),
        css: bundle.css,
        runtime: bundle.runtime,
        entry: bundle.entry,
      },
      "*",
      [port2]
    );
    onOpened(bundle.name);
    // Running only once the screen has rendered, never because its code
    // was handed over.
    await mounted;
    if (stopped.signal.aborted) {
      return;
    }
    onState({ status: "running" });
    source.running?.(link, bundle, cleanups, onState);
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
 * version (`runFrame`).
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
      running: (link, { version }, cleanups, setState) => {
        const checkVersion = async (): Promise<void> => {
          try {
            const session = await link.session();
            if ((await session.screens.version(app)) !== version) {
              setState({ status: "updated" });
            }
          } catch {
            // Asked again at the next check.
          }
        };
        const timer = setInterval(() => {
          void checkVersion();
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
      target: (link, bundle) => previewTarget(link, chatId, bundle),
    },
    onState,
    onOpened
  );

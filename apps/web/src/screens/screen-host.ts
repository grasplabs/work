import { appErrors } from "@grasp-os/shared/apps";
import type { PreviewBundle } from "@grasp-os/shared/chat";
import { decisionErrors } from "@grasp-os/shared/decisions";
import { authErrors, errorPayloadSchema } from "@grasp-os/shared/errors";
import { roleErrors } from "@grasp-os/shared/roles";
import {
  appFunctionPath,
  screenErrors,
  screenFrameMessage,
  screenFramePath,
  screenLeaseHeader,
  screenLimits,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import type { ScreenBundle } from "@grasp-os/shared/screens";

import type { PendingConfirmation } from "../decision-confirmation.tsx";
import type { CoreLink, LinkEnded } from "./core-link.ts";
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
import { cancelStream, followStream } from "./screen-stream.ts";
import { frameLinks, ownLink } from "./tab-link.ts";
import type { Joined } from "./tab-link.ts";

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
//
// A frame is for the person its page's connection was first made for
// (core-link.ts). When the browser's session turns out to be someone
// else's (a connection made again, or a function call core refused with
// `auth.principal_changed`), or ends, the frame is stopped and emptied,
// so nothing the screen held for the first person, such as their data or
// a save it would send again, is left on the page or sent as the next.
//
// A tab's frames share that connection (tab-link.ts, spec 11.2), and each
// reaches its App on it through a way of its own (core's `screens.frame`):
// bound to its App, its build and its person, decided on its own build
// alone, and closed when the frame stops, which lets go in core of
// everything the frame followed. The frames never see the connection or
// each other. What ends the connection for its person (signed out, or
// someone else's session) ends it for every frame on it, and the next
// frame opens a new one; what stops one frame (its build's approval
// taken back, a broken channel, a timeout, the page leaving) stops that
// frame alone.

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
  /** Someone else signed in on the browser since the frame was opened. */
  | "principal-changed"
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
  "auth.principal_changed": "principal-changed",
};

/** Why opening a screen failed, as the page says it. */
const failureOf = (error: unknown): FailureReason => {
  const code =
    roleErrors.codeOf(error) ??
    appErrors.codeOf(error) ??
    screenErrors.codeOf(error) ??
    authErrors.codeOf(error);
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

/**
 * Why core's answer stops a frame: its build no longer gets the App's
 * data, or the browser's session is someone else's now.
 */
type Refused = Extract<
  FailureReason,
  "unreviewed" | "revoked" | "principal-changed"
>;

/** A frame's own way to its App, as core's `screens.frame` answers it. */
type FrameApi = Awaited<ReturnType<Session["screens"]["frame"]>>;

/**
 * The frame's own way to its App on the tab's link (core's
 * `screens.frame`), for the build core leased it: asked for on each
 * connection the link makes, as one made again knows nothing of the last.
 * `close` lets go of it, and core of everything the frame followed
 * through it; nothing is asked for once it is closed.
 */
interface FrameHold {
  use: <T>(run: (frame: FrameApi) => Promise<T>) => Promise<T>;
  /**
   * Sends one of the frame's plain requests as the link's person: `send`
   * is called right after the last check that the frame still runs, in
   * the same turn, so a frame stopped meanwhile (also while the link
   * connected again) sends nothing.
   */
  asPerson: <T>(send: (person: string) => Promise<T>) => Promise<T>;
  /** The link's session, refused as `person` is. */
  session: () => Promise<Session>;
  close: () => void;
}

const frameClosedError = (): Error => new Error("The frame was stopped.");

/** Closes `frame` in core and lets go of it, gone already or not. */
const letGo = async (frame: Promise<FrameApi>): Promise<void> => {
  try {
    const held = await frame;
    try {
      await held.close();
    } finally {
      held[Symbol.dispose]();
    }
  } catch {
    // Gone with its connection, which let go of it in core too.
  }
};

const holdFrame = (
  link: CoreLink,
  { app, lease }: Pick<ScreenBundle, "app" | "lease">
): FrameHold => {
  let held: { session: Session; frame: Promise<FrameApi> } | undefined;
  let closed = false;
  const ask = async (session: Session): Promise<FrameApi> => {
    try {
      return await session.screens.frame(app, lease);
    } catch (error) {
      // Asked again by the next call, not refused for good.
      if (held?.session === session) {
        held = undefined;
      }
      throw error;
    }
  };
  /** `wait`'s answer, unless the frame is stopped before or meanwhile. */
  const whileOpen = async <T>(wait: () => Promise<T>): Promise<T> => {
    if (closed) {
      throw frameClosedError();
    }
    const answer = await wait();
    if (closed) {
      throw frameClosedError();
    }
    return answer;
  };
  const current = async (): Promise<FrameApi> => {
    // Stopped while the link connected: nothing is asked for that would
    // never be closed.
    const session = await whileOpen(async () => await link.session());
    // Checked again in the turn it is asked for: a frame stopped since
    // would hold a capability nobody closes.
    if (closed) {
      throw frameClosedError();
    }
    if (held?.session !== session) {
      // The last connection's broke with it, and core let go of it then.
      held = { session, frame: ask(session) };
    }
    // Stopped while core made it: nothing is sent on it.
    const { frame } = held;
    return await whileOpen(async () => await frame);
  };
  return {
    use: async (run) => {
      const frame = await current();
      if (closed) {
        throw frameClosedError();
      }
      // In this same turn, as `asPerson`: nothing stops the frame between.
      return await run(frame);
    },
    asPerson: async (send) => {
      if (closed) {
        throw frameClosedError();
      }
      const person = await link.person();
      if (closed) {
        throw frameClosedError();
      }
      // In this same turn: nothing can stop the frame in between.
      return await send(person);
    },
    session: async () => await whileOpen(async () => await link.session()),
    close: () => {
      closed = true;
      const last = held;
      held = undefined;
      if (last !== undefined) {
        void letGo(last.frame);
      }
    },
  };
};

/**
 * Asks core whether the frame's build still gets its App's data, and
 * calls `refused` when it doesn't. Core's own answer on the page's own
 * connection: never an error a call came back with, which an App's server
 * can word as it likes.
 */
const checkDelivery = async (
  hold: FrameHold,
  refused: (reason: Refused) => void
): Promise<void> => {
  const delivery = await hold.use(async (frame) => await frame.delivery());
  if (delivery !== "open") {
    refused(delivery);
  }
};

/** `checkDelivery`, for a call that doesn't wait for it. */
const checkDeliveryNow = async (
  hold: FrameHold,
  refused: (reason: Refused) => void
): Promise<void> => {
  try {
    await checkDelivery(hold, refused);
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
 * A failure that isn't core's refusal (offline, a cut connection, a
 * proxy's page), as the frame gets it: a coded error, never what was
 * thrown or what the response held.
 */
const callFailed = (): Error =>
  Object.assign(new Error("The call failed."), {
    code: "internal.unexpected",
  });

/**
 * Calls one of `app`'s functions with `request`, as the frame sent it,
 * for the build `lease` names and the person the frame was opened for
 * (core's app-function-route.ts): a plain request, so core bounds its
 * bytes as it reads them. Core's answer, or its refusal as an error with
 * its code: `auth.principal_changed` when the browser's session is no
 * longer `person`'s.
 */
export const callFunction = async (
  app: string,
  { lease, person }: { lease: string; person: string },
  request: string
): Promise<unknown> => {
  let response: Response;
  let answer: unknown;
  try {
    response = await fetch(`${appFunctionPath}/${encodeURIComponent(app)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        [screenLeaseHeader]: lease,
        [screenPersonHeader]: person,
      },
      body: request,
    });
    answer = await response.json();
  } catch {
    throw callFailed();
  }
  if (response.ok) {
    return answer;
  }
  const payload = errorPayloadSchema.safeParse(answer);
  if (!payload.success) {
    throw callFailed();
  }
  // Of the details, only how long to wait before asking again: what the
  // screen's client needs to wait for its budget.
  const retryAfterMs = payload.data.details?.retryAfterMs;
  throw Object.assign(new Error(payload.data.message), {
    code: payload.data.code,
    ...(typeof retryAfterMs === "number" ? { details: { retryAfterMs } } : {}),
  });
};

/**
 * Asks the person, in Grasp's own dialog outside the frame, to confirm an
 * answer a screen asked to give (decision-confirmation.tsx): whether they
 * did.
 */
export type ConfirmDecision = (
  pending: PendingConfirmation
) => Promise<boolean>;

/**
 * A running App's screen: its own App's server, runs and error log. Its
 * calls go through the frame's own way to its App (`hold`), so each is
 * decided on the build this frame runs, whatever other frames of the App
 * on the tab's connection run.
 *
 * A screen's answer to a decision is the person's only once they
 * confirmed it in the page's own dialog (`confirm`): the page shows them
 * what core says is asked and what would be recorded, mints the one-use
 * confirmation on their click, and answers with it. The frame gets the
 * answered decision, never the confirmation; nothing the frame sends can
 * stand in for one. Cancelled, nothing is recorded, and the frame gets
 * `decision.cancelled`.
 */
const appTarget = (
  bundle: ScreenBundle,
  refused: (reason: Refused) => void,
  hold: FrameHold,
  confirm: ConfirmDecision
): FrameTarget => {
  const { app, version, screen, lease } = bundle;
  const framed = async <T>(
    run: (frame: FrameApi) => Promise<T>
  ): Promise<T> => {
    try {
      return await hold.use(run);
    } catch (error) {
      if (refusedForBuild(error)) {
        // The frame gets the refusal as it is; whether to stop it is
        // core's answer to the page.
        void checkDeliveryNow(hold, refused);
      }
      throw error;
    }
  };
  /**
   * One of the frame's plain requests, as the link's person: it waits for
   * a connection being made again, which fails when it is someone else's,
   * and is never sent once the frame stopped. Core refusing it for the
   * build, or as someone else's, is handled as for a call.
   */
  const plain = async <T>(send: (person: string) => Promise<T>): Promise<T> => {
    try {
      return await hold.asPerson(send);
    } catch (error) {
      if (refusedForBuild(error)) {
        void checkDeliveryNow(hold, refused);
      }
      if (authErrors.codeOf(error) === "auth.principal_changed") {
        refused("principal-changed");
      }
      throw error;
    }
  };
  return {
    call: async (method, args) =>
      await framed(async (frame) => await frame.call(method, args)),
    callFunction: async (request) =>
      await plain(
        async (person) => await callFunction(app, { lease, person }, request)
      ),
    streamFunction: async (what, request, onFrame, onEnded) =>
      await plain(
        async (person) =>
          await followStream(
            app,
            { lease, person },
            what,
            request,
            onFrame,
            onEnded
          )
      ),
    cancelStream: async (request) =>
      await plain(
        async (person) => await cancelStream(app, { lease, person }, request)
      ),
    report: async (problem) => {
      const { screens } = await hold.session();
      await screens.report(app, { version, screen }, problem);
    },
    startRun: async (workflow, input) =>
      await framed(async (frame) => await frame.startRun(workflow, input)),
    runs: async (workflow) =>
      await framed(async (frame) => await frame.runs(workflow)),
    run: async (run) => await framed(async (frame) => await frame.run(run)),
    decide: async (run, decision, answer) => {
      const review = await framed(
        async (frame) =>
          await frame.reviewDecision(run, decision, forCore(answer))
      );
      if (review.state === "recorded") {
        return review.decision;
      }
      if (!(await confirm(review))) {
        throw decisionErrors.create("decision.cancelled");
      }
      const { confirmation } = await framed(
        async (frame) =>
          await frame.confirmDecision(
            run,
            decision,
            review.decision.revision,
            review.response
          )
      );
      return await framed(
        async (frame) =>
          await frame.decide(run, decision, review.response, confirmation)
      );
    },
    summary: async (run) =>
      await framed(async (frame) => await frame.summary(run)),
    control: async (run, kind) =>
      await framed(async (frame) => {
        if (kind !== "pause" && kind !== "resume" && kind !== "cancel") {
          throw screenErrors.create("screen.invalid");
        }
        return await frame.control(run, kind);
      }),
    watchRuns: async (workflow, onChange) =>
      await framed(
        async (frame) => await frame.watchRuns(workflow, forCore(onChange))
      ),
    watchQuery: async (request, onSnapshot) =>
      await framed(
        async (frame) => await frame.watchQuery(request, forCore(onSnapshot))
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
    // A draft's functions aren't sealed, so its preview has none to call.
    callFunction: refusedInPreview,
    streamFunction: refusedInPreview,
    cancelStream: refusedInPreview,
    report: async (problem) => {
      await on(link, async ({ chats }) => {
        await chats.previewReport(chatId, app, revision, screen, problem);
      });
    },
    startRun: refusedInPreview,
    runs: async () => await Promise.resolve([]),
    run: refusedInPreview,
    decide: refusedInPreview,
    control: refusedInPreview,
    summary: refusedInPreview,
    watchRuns: async () =>
      await Promise.resolve({
        release: async () => {
          await Promise.resolve();
        },
      }),
    // As `callFunction`: a draft's functions aren't sealed.
    watchQuery: refusedInPreview,
  };
};

/** Which build a frame runs, and the App's name to show around it. */
type FrameCode = Pick<ScreenBundle, "name" | "artifact" | "frameToken">;

/** What a frame's bridge reaches, and what runs once its screen does. */
interface Connected {
  target: FrameTarget;
  /** Called once the screen runs, if given: `onState` says what the page shows. */
  running?: (onState: (state: ScreenState) => void) => void;
}

/** What a frame runs, and what its bridge reaches. */
interface FrameSource<Bundle extends FrameCode> {
  open: (session: Session) => Promise<Bundle>;
  /**
   * The link the frame goes over: the tab's (`frameLinks`) unless given,
   * or one of its own, closed with the frame.
   */
  join?: (onEnded: (why: LinkEnded) => void) => Joined<CoreLink>;
  /**
   * What the frame's bridge reaches on the tab's `link`: `refused` stops
   * the frame (core no longer hands its build the data, or the browser's
   * session is someone else's), and `cleanups` stop what it starts.
   */
  connect: (
    link: CoreLink,
    bundle: Bundle,
    refused: (reason: Refused) => void,
    cleanups: (() => void)[]
  ) => Connected;
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
  const frameWindow = (): unknown => frame.contentWindow;

  /**
   * Stops it all, once: what waits for the frame stops waiting, the
   * frame leaves the tab's link (the first cleanup), its own way to its
   * App closes, and with it what the frame followed in core, and the
   * bridge and its port close and timers end. The link stays, for the
   * tab's other frames.
   */
  const stop = (): void => {
    if (stopped.signal.aborted) {
      return;
    }
    stopped.abort();
    for (const cleanup of cleanups) {
      cleanup();
    }
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

  // The link ending stops the frame, signed out or not, as it stops every
  // frame of the tab: nothing of the person's stays on the page, in a
  // frame or its bridge, for whoever uses the browser next.
  const join =
    source.join ??
    ((onEnded: (why: LinkEnded) => void) => frameLinks.join(onEnded));
  const joined = join((why) => {
    fail(
      why === "signed-out"
        ? { status: "signed-out" }
        : { status: "failed", reason: "principal-changed" }
    );
  });
  const { link } = joined;
  cleanups.push(() => {
    joined.leave();
  });

  /**
   * Stops the frame for `reason`. Core saying the browser's session is
   * someone else's ends the tab's link, which stops every frame on it,
   * this one too, and the next frame connects anew; anything else stops
   * this frame alone.
   */
  const refused = (reason: Refused): void => {
    if (reason === "principal-changed") {
      joined.end("principal-changed");
      return;
    }
    fail({ status: "failed", reason });
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
    const { target, running } = source.connect(link, bundle, refused, cleanups);
    const { port1, port2 } = new MessageChannel();
    cleanups.push(
      openBridge(port1, target, () => {
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
    running?.(onState);
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
  onOpened: (appName: string) => void,
  confirm: ConfirmDecision
): (() => void) =>
  runFrame(
    frame,
    {
      open: async (session) => await session.screens.open(app, screen),
      connect: (link, bundle, refused, cleanups) => {
        const hold = holdFrame(link, bundle);
        cleanups.push(() => {
          hold.close();
        });
        return {
          target: appTarget(bundle, refused, hold, confirm),
          running: (setState) => {
            const { version } = bundle;
            const check = async (): Promise<void> => {
              try {
                // A screen that asks for nothing more still holds what it
                // was handed: this is when the page hears its approval is
                // gone.
                await checkDelivery(hold, refused);
                const session = await hold.session();
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
        };
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
      // A connection of its own: core keeps a preview's callbacks (its
      // server calls') per connection, with no way of the frame's own to
      // let go of them, so only closing the connection when the preview
      // stops releases them (GRA-623).
      join: ownLink,
      // A preview reads no real data, so no approval decides it.
      connect: (link, bundle) => ({
        target: previewTarget(link, chatId, bundle),
      }),
    },
    onState,
    onOpened
  );

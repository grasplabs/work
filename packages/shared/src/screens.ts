import { z } from "zod";

import type {
  DecisionAnswerInput,
  DecisionConfirmation,
  DecisionReview,
  DecisionView,
} from "./decisions.ts";
import { defineErrorFamily } from "./errors.ts";
import type { AppId } from "./ids.ts";
import {
  screenFrameMounted,
  screenFrameReady,
  screenLimits,
} from "./screen-limits.ts";
import type { ScreenDelivery } from "./screen-trust.ts";
import type { RunControl, RunSummary, WorkflowRun } from "./workflows.ts";

// An App's screens run in a sandboxed frame in the frontend (apps/web): a
// document core serves for one build (core's screen-frame.ts), which runs
// that build's modules and nothing else, connected to its App's server
// through the page and core. Core checks the person's session and role on
// every call; the frame only ever talks to the page.

export {
  appFunctionPath,
  jsonBytes,
  rpcArgumentDepth,
  screenFrameMessage,
  screenFrameMounted,
  screenFramePath,
  screenFrameReady,
  screenLeaseHeader,
  screenLimits,
  screenModulePath,
  screenPersonHeader,
  streamCallActions,
} from "./screen-limits.ts";
export type { StreamCallAction } from "./screen-limits.ts";

/** A value the page or core made up: never longer than a hash in hex. */
const stageValue = z.string().min(1).max(128);

/** The frame's `ready`, as the page reads it. */
export const screenReadySchema = z.strictObject({
  type: z.literal(screenFrameReady),
  load: stageValue,
});

/** The runtime's `mounted`, as the page reads it. */
export const screenMountedSchema = z.strictObject({
  type: z.literal(screenFrameMounted),
  load: stageValue,
  artifact: stageValue,
  generation: stageValue,
});
export type ScreenMounted = z.output<typeof screenMountedSchema>;

/** A screen's name: `desk` for `screens/desk.tsx`. */
export const screenNameSchema = z
  .string()
  .regex(/^[\w-]{1,64}$/u, "a screen's file name, without .tsx");

/** A screen's file, `screens/<name>.tsx`: its name is the `name` group. */
export const screenPath = /^screens\/(?<name>[\w-]{1,64})\.tsx$/u;

/**
 * One of an App's screens at its current version, ready for a frame: the
 * frame loads its code from core by `artifact` (`screenFramePath`).
 */
export interface ScreenBundle {
  app: AppId;
  /** The App's name, which the page shows around the frame. */
  name: string;
  /** The App's current version, which the screen was built from. */
  version: number;
  screen: string;
  /**
   * The SHA-256, in hex, of the code a frame runs (the screen's modules,
   * the kit's modules they load and their CSS), as core built it: what an
   * admin approves, and what the frame's document runs and nothing else.
   * The frame says it back once the screen has mounted
   * (`screenFrameMounted`).
   */
  artifact: string;
  /**
   * What lets the frame load that build's document from core, for a few
   * minutes (`?token=`): a sandboxed frame sends no session.
   */
  frameToken: string;
  /**
   * Core's word that it handed this person this build of this App, for
   * the page to give back on the frame's own connection (`present`):
   * opaque to the page, and worth nothing to anyone else.
   */
  lease: string;
}

const reportLimits = screenLimits.report;

/**
 * A problem in a screen, as the frame reports it: an uncaught error, an
 * unhandled rejection or a `console.error` call. Written by App code, so
 * it is held to size and never counts as more than text.
 */
export const screenProblemSchema = z.strictObject({
  kind: z.enum(["error", "rejection", "console"]),
  message: z.string().transform((text) => text.slice(0, reportLimits.message)),
  stack: z
    .string()
    .transform((text) => text.slice(0, reportLimits.stack))
    .optional(),
});
export type ScreenProblem = z.output<typeof screenProblemSchema>;

/** What an App's server code wrote with `console`, one line of one call. */
export interface ServerLog {
  /** When, ISO 8601. */
  at: string;
  level: "debug" | "info" | "log" | "warn" | "error";
  /** Its arguments as text, held to size. */
  message: string;
  /** The server method whose call wrote it, when the runtime says. */
  method: string | null;
}

/**
 * What reaches an App's error log: a problem one of its screens reported,
 * or a line its server code wrote with `console` (core's server-logs.ts).
 */
export type ReportedEntry =
  | (ScreenProblem & {
      /** When it was reported, ISO 8601. */
      at: string;
      source: "screen";
      version: number;
      screen: string;
    })
  | (ServerLog & { source: "server"; version: number });

/**
 * One entry of an App's error log, and how often it was reported. The
 * same problem in the same screen and version is one entry, and so is the
 * same line from the same method and version; `at` is the last time.
 */
export type AppErrorEntry = ReportedEntry & {
  /** How many times it was reported. */
  count: number;
};

/** An App's error log, as its builders read it. */
export interface AppErrorLog {
  /** The newest different entries, newest first. */
  entries: AppErrorEntry[];
  /**
   * At least how many reports were dropped unread because the App's
   * screens and server reported more than they may: counted, never kept one by one.
   * The last minute's count is held in memory before it is written, so a
   * flood right before the App's host restarts is counted short.
   */
  suppressed: number;
}

/** A decision a run waits for, as its App's screens see it. */
export interface WaitingDecision {
  /** Its name in the workflow (`step.decision(name, …)`), with its key. */
  name: string;
  /**
   * What it asks, as the workflow describes it: only for whoever sees the
   * run's details (its starter, admins) or may answer the decision. It is
   * written by workflow code, and can hold what the run read.
   */
  description?: string;
  /** Its deadline, ISO 8601: no answer counts after it. */
  expiresAt: string;
}

/**
 * A run as its App's screens see it: `waiting` exactly while a decision of
 * it is open, with the decisions it waits for; `running` while it waits
 * on anything else; none once it has ended. While decisions are switched
 * off, it waits for none, as nobody can answer one.
 */
export interface ScreenRun extends WorkflowRun {
  waitingFor: WaitingDecision[];
}

/**
 * What core tells a screen following its App's runs (`watchRuns`): which
 * run changed. The screen reads it again (`run`, `runs`), as its person.
 */
export interface RunChange {
  run: string;
}

/**
 * The bounds of live queries (spec 11.3, 11.4): what core holds one
 * page's connection (one browser tab) and one person to, and how it
 * delivers.
 */
export const querySubscriptionLimits = {
  /** Live queries one connection follows at once. */
  perConnection: 100,
  /** Live queries one person follows of one App at once, across tabs. */
  perPerson: 500,
  /** How long core gathers a query's changes before it reads it again. */
  coalesceMs: 50,
  /**
   * The longest it gathers them: the window stretches with how many of
   * the connection's queries wait to be read, so a write that wakes a
   * page's every query is read in fewer, later rounds, not a flood.
   */
  maxCoalesceMs: 2000,
  /** Reads of live queries one connection runs at once; the rest wait. */
  concurrentReads: 4,
  /**
   * Reads core makes of one person's live queries of one App because a
   * write changed what they read (the reads a page asks for are counted
   * as its requests instead), held by the App's host across every tab.
   * Past it a read waits, gathering every change meanwhile, and is tried
   * again later: never dropped, only slower. The burst covers one write
   * waking two full tabs (2 x `perConnection`); the rate, 10 a second,
   * is five times what a person may ask directly
   * (`screenLimits.requests`), so a write rate the person's own requests
   * allow keeps a few screens current, while one person's commits can
   * cost core at most this many sandboxed reads of their queries, however
   * many they follow. Each other person pays for their own.
   */
  liveReads: { burst: 200, perMinute: 600 },
  /** How long core waits before reading again past `liveReads`, at most. */
  liveReadWaitMs: 10_000,
  /**
   * How often core checks that the store still holds a query's watch,
   * when nothing else made it look: a watch the store lost without core
   * hearing of it is then made again, and the query read afresh.
   */
  livenessMs: 60_000,
  /**
   * Snapshot bytes core holds for one connection that the page hasn't
   * taken yet: past it, the snapshots in between are dropped, and each
   * query sends its latest once the page catches up.
   */
  unsentBytes: 512 * 1024,
} as const;

/**
 * What core pushes to a screen following a query (`watchQuery`): the
 * query's result (spec 32.6's `OperationResult`, as a function call
 * answers it), numbered. Each push of one subscription has a greater
 * `revision` than the one before; a screen drops any that doesn't.
 */
export interface QuerySnapshotPush {
  revision: number;
  result: unknown;
}

/**
 * A screen's hold on its App's runs of one workflow (`watchRuns`), until
 * it releases it: then core calls its callback no more, and the slot it
 * took of the 20 a screen may hold is free again.
 */
export interface RunSubscriptionApi {
  release: () => Promise<void>;
}

/**
 * One frame's way to its App, on the connection all of a tab's frames
 * share (`ScreensApi.frame`): bound to the App, the build core leased the
 * frame and the person it was opened for. Each call is decided on that
 * build alone, never on what another frame of the App on the connection
 * runs, and is refused as `ScreensApi`'s same call would be otherwise.
 * `close` (or letting go of the stub) releases everything the frame
 * follows through it, its live queries, its runs' updates and the
 * callbacks its server calls passed, at once; a closed frame is refused
 * every call (`screen.invalid`).
 */
export interface ScreenFrameApi {
  /** Whether the frame's build gets the App's data now. */
  delivery: () => Promise<ScreenDelivery>;
  call: (method: string, args: unknown[]) => Promise<unknown>;
  startRun: (workflow: string, input?: unknown) => Promise<WorkflowRun>;
  runs: (workflow: string) => Promise<ScreenRun[]>;
  run: (run: string) => Promise<ScreenRun>;
  summary: (run: string) => Promise<RunSummary>;
  /** `ScreensApi.reviewDecision`, for this frame's App. */
  reviewDecision: (
    run: string,
    decision: string,
    answer: DecisionAnswerInput
  ) => Promise<DecisionReview>;
  /**
   * `ScreensApi.confirmDecision`, for this frame's App: the page's alone,
   * once the person confirmed the answer in its own dialog, never reached
   * from the frame.
   */
  confirmDecision: (
    run: string,
    decision: string,
    revision: string,
    answer: DecisionAnswerInput
  ) => Promise<DecisionConfirmation>;
  /** `ScreensApi.decide`, for this frame's App, with the confirmation. */
  decide: (
    run: string,
    decision: string,
    answer: DecisionAnswerInput,
    confirmation?: string
  ) => Promise<DecisionView>;
  control: (run: string, kind: RunControl["kind"]) => Promise<RunControl>;
  watchRuns: (
    workflow: string,
    onChange: (change: RunChange) => void
  ) => Promise<RunSubscriptionApi>;
  watchQuery: (
    request: string,
    onSnapshot: (snapshot: QuerySnapshotPush) => void
  ) => Promise<RunSubscriptionApi>;
  close: () => Promise<void>;
}

/**
 * A signed-in person's way to an App's screens: for anyone with a role in
 * the App (`AppsApi`); its error log for its builders only.
 */
export interface ScreensApi {
  /**
   * A screen of the App, built from its current version: refused with
   * `screen.unreviewed` or `screen.revoked` while the App's data is
   * sensitive and nobody approved exactly this build
   * (@grasp-os/shared/screen-trust), or with `screen.revoked` once its
   * approval was taken back, however the data is classified. Refusals are
   * audited, the same one once in a while. Counted against what one
   * person's screens of the App may ask (`screen.rate_limited`).
   */
  open: (app: string, screen: string) => Promise<ScreenBundle>;
  /**
   * Says which build this connection's frame runs for the App, with the
   * lease `open` gave: what every call below is then decided on. Answers
   * whether that build gets the App's data now. A connection that
   * presented nothing runs a build nobody approved, as far as core knows.
   */
  present: (app: string, lease: string) => Promise<ScreenDelivery>;
  /**
   * One frame's own way to the App (`ScreenFrameApi`), for the build the
   * lease `open` gave it: how frames that share a connection each get
   * their App's data on their own build, and let go of all they follow
   * when they close. A lease core didn't sign for this person and App
   * runs a build nobody approved, as with `present`.
   */
  frame: (app: string, lease: string) => Promise<ScreenFrameApi>;
  /**
   * Calls `method` of the App's server with `args`, as the person. Plain
   * data, and functions (callbacks the server may keep and call later
   * with plain data). The answer is plain data, whatever it holds. Like
   * every call below that reaches the App's data or runs, it is refused
   * with `screen.unreviewed` or `screen.revoked` unless the build the
   * connection presented gets that data now: read before the call, before
   * its answer and before each push.
   */
  call: (app: string, method: string, args: unknown[]) => Promise<unknown>;
  /** The App's current version; null while it has none. */
  version: (app: string) => Promise<number | null>;
  /**
   * Adds a problem in a screen at `version` to the App's error log:
   * `screen.rate_limited` past what one person's screens, or all of the
   * App's, may report a minute, whatever the report holds.
   */
  report: (
    app: string,
    at: { version: number; screen: string },
    problem: ScreenProblem
  ) => Promise<void>;
  /** The App's error log. */
  errors: (app: string) => Promise<AppErrorLog>;
  /**
   * Starts a run of the App's workflow, for the person: anyone with a role
   * in the App. Audited as started on a screen (`via: "screen"`). Behind
   * `screen_workflows`, as are the calls below.
   */
  startRun: (
    app: string,
    workflow: string,
    input?: unknown
  ) => Promise<WorkflowRun>;
  /** The App's latest 100 runs of `workflow`, newest first. */
  runs: (app: string, workflow: string) => Promise<ScreenRun[]>;
  /** One of the App's runs as it is now; another App's is not found. */
  run: (app: string, run: string) => Promise<ScreenRun>;
  /**
   * The summary of one of the App's runs, all of one revision: status,
   * identity, times, the decisions it waits for, a compensation, and what
   * the person may do with it now (`control`). Another App's run is not
   * found.
   */
  summary: (app: string, run: string) => Promise<RunSummary>;
  /**
   * What the trusted host decision UI shows the person before they
   * confirm the screen's answer to the decision `decision` (its name in
   * the workflow) of one of the App's runs (`DecisionsApi.review`).
   */
  reviewDecision: (
    app: string,
    run: string,
    decision: string,
    answer: DecisionAnswerInput
  ) => Promise<DecisionReview>;
  /**
   * Mints the person's one-use confirmation of the screen's answer, as
   * reviewed at `revision` (`DecisionsApi.confirm`), once they confirmed it
   * in the page's own dialog: the page's alone, never the screen's.
   * Audited as confirmed for a screen.
   */
  confirmDecision: (
    app: string,
    run: string,
    decision: string,
    revision: string,
    answer: DecisionAnswerInput
  ) => Promise<DecisionConfirmation>;
  /**
   * Answers the decision `decision` (its name in the workflow) of one of
   * the App's runs, as the person, by the decision's own rules: only
   * someone it is from, and never the run's starter unless it names
   * exactly them, with the one-use confirmation the page minted once the
   * person confirmed exactly this answer (`DecisionsApi.confirm`); the
   * screen never has it. Audited as answered on a screen (`via: "screen"`).
   */
  decide: (
    app: string,
    run: string,
    decision: string,
    answer: DecisionAnswerInput,
    confirmation?: string
  ) => Promise<DecisionView>;
  /**
   * Pauses, resumes or cancels one of the App's runs, for a builder of the
   * App, and answers the host's receipt once it admitted the request: not
   * that the run has got there yet, which its status says. The same
   * request again, while its receipt is unresolved, answers that receipt.
   * Refused with `workflow.control_conflict` while a cancel, or the other
   * of pause and resume, is unresolved, and `workflow.control_refused`
   * once the run has ended. Audited as asked on a screen.
   */
  control: (
    app: string,
    run: string,
    kind: RunControl["kind"]
  ) => Promise<RunControl>;
  /**
   * Calls `onChange` each time one of the App's runs of `workflow` starts,
   * waits for a decision, has it answered or closed, or ends, for as long
   * as the person may use the App and until the screen releases the
   * subscription it answers. Core lets go of `onChange` when it stops
   * calling it, which tells the screen to follow again. One tab's
   * connection holds at most 20 subscriptions at once.
   */
  watchRuns: (
    app: string,
    workflow: string,
    onChange: (change: RunChange) => void
  ) => Promise<RunSubscriptionApi>;
  /**
   * Follows one of the App's public queries (spec 11): `request` is the
   * call as a function call sends it (its reference and input, as JSON
   * text), for the build `lease` (the following frame's own, from
   * `open`) names. Core reads it as the
   * person, pushes its result to `onSnapshot` (`QuerySnapshotPush`), and
   * pushes it again, read afresh, after every commit that changed what
   * it read, for as long as the person may use the App and the build
   * gets its data, until the screen releases the subscription. A refusal
   * that ends the subscription (the person or the build lost access, the
   * App moved to another version) is pushed as the last result; core
   * then lets go of `onSnapshot`, as it does when it can no longer keep
   * the query fresh, which tells the screen to follow again. One
   * connection follows at most 100 queries at once, and a person 500 of
   * one App (`screen.too_many_queries`).
   */
  watchQuery: (
    app: string,
    lease: string,
    request: string,
    onSnapshot: (snapshot: QuerySnapshotPush) => void
  ) => Promise<RunSubscriptionApi>;
}

/** Why a call to an App's screens was refused. */
export const screenErrors = defineErrorFamily({
  "screen.not_found": "The App has no such screen.",
  "screen.build_failed": "The App's screens don't build.",
  "screen.build_slow":
    "The app's screens are still building. Try again in a moment.",
  "screen.invalid": "That isn't a valid request for a screen.",
  "screen.too_many_subscriptions":
    "This page follows at most 20 workflows' runs at once. Close a screen, then try again.",
  "screen.too_many_queries":
    "This page follows too many live queries at once. Close a screen, then try again.",
  "screen.rate_limited":
    "This screen asks for too much at once. Try again in a moment.",
  "screen.input_too_large":
    "That is more data than a screen may send in one call.",
  "screen.answer_too_large":
    "The App answered with more data than a screen takes in one call.",
  "screen.unreviewed":
    "Nobody has approved this app's code for the engine's data yet.",
  "screen.revoked": "The approval of this app's code was taken back.",
  "screen.review_outdated":
    "The app or its approvals changed since they were reviewed. Review them again.",
  "screen.not_approved": "That build of the app isn't approved.",
  "screen.reload_required": "This page is out of date. Reload it to go on.",
});

/**
 * How long a screen refused as `screen.rate_limited` should wait before it
 * asks again: the time its request budget takes to give back one request.
 */
export const rateLimitedRetryMs = Math.ceil(
  60_000 / screenLimits.requests.perMinute
);

/**
 * `screen.rate_limited`, with how long to wait before asking again
 * (`retryAfterMs`), so a client waits for the budget rather than spending
 * its retries while it is empty.
 */
export const rateLimited = () =>
  screenErrors.create("screen.rate_limited", {
    retryAfterMs: rateLimitedRetryMs,
  });

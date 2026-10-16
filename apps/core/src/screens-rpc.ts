// oxlint-disable max-classes-per-file -- a connection's screens, and each frame's own way to its App on that connection, which shares its checks
import { appErrors, appVersionSchema } from "@grasp-os/shared/apps";
import type { App } from "@grasp-os/shared/apps";
import type {
  DecisionConfirmation,
  DecisionReview,
  DecisionView,
} from "@grasp-os/shared/decisions";
import { authErrors, isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ScreenDelivery } from "@grasp-os/shared/screen-trust";
import {
  jsonBytes,
  rateLimited,
  screenErrors,
  screenLimits,
  screenNameSchema,
  screenProblemSchema,
} from "@grasp-os/shared/screens";
import type {
  AppErrorLog,
  QuerySnapshotPush,
  RunChange,
  ScreenBundle,
  ScreenRun,
  ScreenFrameApi,
  ScreensApi,
} from "@grasp-os/shared/screens";
import { valueDepth } from "@grasp-os/shared/value-depth";
import type {
  RunControl,
  RunSummary,
  WorkflowRun,
} from "@grasp-os/shared/workflows";
import { z } from "zod";

import { callApp, isPlainData, plainDataBounds } from "./app.ts";
import type { AppAnswer } from "./app.ts";
import { appFor, findVersion, getApp, versionFiles } from "./apps.ts";
import { appHost } from "./durable-objects.ts";
import { callbackFor, isStub } from "./page-callbacks.ts";
import type { StillOpen } from "./page-callbacks.ts";
import { QuerySubscriptions, screenReads } from "./query-subscriptions.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { RunSubscription } from "./run-subscription.ts";
import { recordBuilds } from "./screen-builds.ts";
import { frameAccess, stageFrame } from "./screen-frame.ts";
import { withScreenReferences } from "./screen-references.ts";
import {
  deliveryOf,
  deliveryOpen,
  delivering,
  leasedArtifact,
  leaseFor,
  requireDelivery,
  standingOf,
} from "./screen-trust.ts";
import { screenCode } from "./screens.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { controlScreenRun } from "./workflows/controls.ts";
import {
  confirmScreenDecision,
  decideScreenRun,
  reviewScreenDecision,
  screenRun,
  screenRuns,
  screenWorkflow,
  startScreenRun,
} from "./workflows/screen-runs.ts";
import { runSummary } from "./workflows/summary.ts";

// What the frontend's screen host reaches for the frames it runs (see
// @grasp-os/sdk/screen-runtime): an App's screen to load, its server to
// call and its current version. Next to them, never on the frame bridge
// and for the App's builders only, its error log (`errors`): its screens'
// problems and what its server code wrote with `console`
// (server-logs.ts). Screens run code nobody
// reviewed line by line, which the page passes on as it is, so everything
// here takes the frame's input as untrusted and checks the person's
// session and role on every call.
//
// What a screen may ask is bounded here and in the App's host, never only
// on the page, which a person can change: each person's requests of an
// App and its screens' reports by rate (`admitted`, `reportProblem`), a
// call's arguments and answer by their size in bytes (`argumentsFor`,
// `withinAnswer`). Who is asking is always the session core checked; a
// screen names only its App, and has a role in it or is refused.
//
// Anyone with a role in the App (app-access.ts) uses its screens: opens
// them, calls its server, reports problems, and starts, follows and
// answers its workflow runs (workflows/screen-runs.ts). Only its builders
// read its error log.
//
// Having a role is not enough to get the App's data into a screen: the
// code the screen runs must be approved, or the App's data classified as
// fine for code nobody approved (screen-trust.ts, which says why). Every
// call here that reaches the App's data or its runs passes that gate, and
// so does every push; only a screen's own reports of its problems, the
// App's version number and its error log, which only its builders read
// and no frame reaches, don't. Which build a connection's frame runs
// is the one core leased it (`present`), never what the frame says.
//
// A callback the App keeps (a screen's subscription), or its host keeps
// for the App's run changes (`watchRuns`), outlives the call that passed
// it, so each push through it checks again that the person
// still has a role in the App (`stillHasRole`), once per reading of the
// connection's session (at most every `sessionRecheckMs`) per App and
// connection. Once they don't (signed out, unshared, a team left, a role
// changed, a source they can't read), the callback is released and
// forwards nothing more: losing access stops a screen within a few
// seconds, whatever the App does.

/**
 * Most run subscriptions (`watchRuns`) one connection keeps at once. A
 * connection is one browser tab, shared by every App frame it runs
 * (`ScreensApi.frame`), so this bounds the whole tab, as spec 11.4 sets
 * its limits per tab: each screen follows a workflow or two, and this
 * only bounds what screens that subscribe over and over keep in their
 * Apps' hosts.
 */
const maxRunSubscriptions = 20;

/**
 * The App `app` names, for the person, once the App's host has counted
 * this request of theirs: `screen.rate_limited` past what one person's
 * screens of an App may ask (`screenLimits.requests`).
 */
const admittedApp = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<App> => {
  const found = await getApp(env, by, app);
  if (!(await appHost(env, found.id).admitRequest(by.userId))) {
    throw rateLimited();
  }
  return found;
};

/** `admittedApp`, for its ID. */
export const admitted = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<AppId> => {
  const { id } = await admittedApp(env, by, app);
  return id;
};

/**
 * Counts a call of a draft's preview as a request of the person's
 * (`admitted`), for an App whose role core has checked already.
 */
export const admitPreviewCall = async (
  env: Env,
  by: Identity,
  app: AppId
): Promise<void> => {
  if (!(await appHost(env, app).admitRequest(by.userId))) {
    throw rateLimited();
  }
};

/** `answer`, if it is no more than a screen takes in one call. */
export const withinAnswer = <Answer>(answer: Answer): Answer => {
  if (jsonBytes(answer, screenLimits.answerBytes) > screenLimits.answerBytes) {
    throw screenErrors.create("screen.answer_too_large");
  }
  return answer;
};

/**
 * A running App's screen, built from its current version, with core's
 * lease on that build for the person: only a build that gets the App's
 * data now, once this request of theirs is counted (`admitted`). One that
 * doesn't is refused before its code is where a frame can load it; one
 * that does is put there (`stageFrame`).
 */
const openScreen = async (
  env: Env,
  by: Identity,
  app: unknown,
  screen: unknown
): Promise<ScreenBundle> => {
  const {
    id,
    name: appName,
    currentVersion: version,
  } = await admittedApp(env, by, app);
  // A name that can't be a screen's is refused before `app.not_running`.
  screenErrors.parse("screen.invalid", screenNameSchema, screen);
  if (version === null) {
    throw appErrors.create("app.not_running");
  }
  const files = await withScreenReferences(
    env,
    id,
    version,
    await versionFiles(env, id, version)
  );
  const built = await screenCode(env, files, screen, version);
  const { artifact } = built;
  // What it builds to now, refused or not: a fact about the version, for
  // what waits on an admin (screen-builds.ts).
  await recordBuilds(env, id, version, [built]);
  await requireDelivery(env, by, id, artifact, {
    operation: "open",
    stage: "admission",
  });
  await stageFrame(env, artifact, built.code);
  return {
    app: id,
    name: appName,
    version,
    screen: built.screen,
    artifact,
    frameToken: await frameAccess(env, artifact),
    lease: await leaseFor(env, by.userId, id, artifact),
  };
};

/** What a connection's calls on an App are decided on. */
interface Frame {
  /** The build the connection presented for the App, if it did. */
  artifactOf: (app: AppId) => string | undefined;
  /**
   * Whether the person may still get a callback's pushes from the App:
   * they still have a role in it, and `artifact` still gets its data.
   */
  stillOpen: (
    by: Identity,
    app: AppId,
    artifact: string | undefined,
    operation: string
  ) => StillOpen;
  /**
   * What one frame keeps through its calls (`ScreenFrameRpc`), let go of
   * when it closes; none for the connection's own calls.
   */
  held?: Holder;
  /**
   * Called right before the App runs anything for a call: refuses once
   * the frame closed (`ScreenFrameRpc`); none for the connection's own.
   */
  dispatching?: () => void;
}

/**
 * What a frame keeps until it closes: `keep` lets go at once of what
 * arrives once the frame has closed, `forget` drops what was let go of.
 */
interface Holder {
  keep: (held: Disposable) => void;
  forget: (held: Disposable) => void;
}

/** A function the App gets for a callback the screen passed. */
type Callback = (value: AppAnswer) => Promise<void>;

/**
 * How the App's pushes through a screen's callback are refused. A push is
 * held to the size of an answer: what `live` sends a screen is the same
 * data a call would answer.
 */
const refusals = {
  invalid: () => appErrors.create("app.answer_invalid"),
  closed: () => appErrors.create("app.not_found"),
  tooLarge: {
    maxBytes: screenLimits.answerBytes,
    refuse: () => screenErrors.create("screen.answer_too_large"),
  },
};

/**
 * The arguments for the App: plain data, and callbacks of the screen's
 * (how `live` in @grasp-os/sdk/screen subscribes), each as a function the
 * App can only call.
 */
export const argumentsFor = (
  args: unknown[],
  stillOpen: StillOpen,
  held?: Holder
): { passed: unknown[]; callbacks: Disposable[] } => {
  if (
    !args.every(
      (arg) =>
        isStub(arg) ||
        // Held to its bytes below, which says so.
        isPlainData(arg, { ...plainDataBounds, depth: valueDepth })
    )
  ) {
    throw screenErrors.create("screen.invalid");
  }
  // Measured without the callbacks, which carry nothing yet.
  const data = args.filter((arg) => !isStub(arg));
  if (jsonBytes(data, screenLimits.inputBytes) > screenLimits.inputBytes) {
    throw screenErrors.create("screen.input_too_large");
  }
  const callbacks: Disposable[] = [];
  const passed = args.map((arg) => {
    if (!isStub(arg)) {
      return arg;
    }
    // Kept by the frame that passed it, if any, until it is let go of:
    // closing the frame lets go of it too, and a frame that closed while
    // this call was admitted keeps none.
    const callback = callbackFor(arg, stillOpen, refusals, () => {
      held?.forget(callback);
    });
    callbacks.push(callback);
    held?.keep(callback);
    return callback;
  });
  return { passed, callbacks };
};

/**
 * How long a screen waits for an App's answer, its turn in the App
 * included: the App's code gets as long from its turn, then is stopped,
 * so a call nobody waits for any more frees the App sooner than the App's
 * own time for a call (`App.call`).
 */
const screenCallMs = 30_000;

/**
 * Calls a method of the App's server for the person: plain data and a
 * screen's callbacks go in, plain data comes out, whatever it holds. The
 * name must be a string before it goes anywhere near the App, so an object
 * can't turn into a different one between the check and the call.
 */
const callServer = async (
  env: Env,
  by: Identity,
  { app, method, args }: { app: unknown; method: unknown; args: unknown },
  frame: Frame
): Promise<AppAnswer> => {
  const id = await admitted(env, by, app);
  if (typeof method !== "string" || !Array.isArray(args)) {
    throw screenErrors.create("screen.invalid");
  }
  const artifact = frame.artifactOf(id);
  const { passed, callbacks } = argumentsFor(
    args,
    frame.stillOpen(by, id, artifact, "call"),
    frame.held
  );
  try {
    return await delivering(env, by, id, artifact, "call", async () => {
      // A frame closed while the call was admitted runs nothing.
      frame.dispatching?.();
      return withinAnswer(
        await callApp(
          env,
          id,
          {
            userId: by.userId,
            mode: "interactive",
            // In on the person's role in the App: each stub call of the
            // App's code checks it again (app-bindings.ts).
            admission: {
              type: "role",
              person: { userId: by.userId, role: by.role, teams: by.teams },
            },
          },
          method,
          passed,
          Date.now() + screenCallMs
        )
      );
    });
  } catch (error) {
    // A failed call keeps no callback.
    for (const callback of callbacks) {
      callback[Symbol.dispose]();
    }
    throw error;
  }
};

/**
 * Follows the App's runs of `workflow` for the person (app.ts,
 * `watchRuns`): the screen's callback goes to the App's host as a
 * function it can only call, checked before each push as any callback of
 * a screen is. `subscriptions` holds this connection's, which drop out
 * once released: at most {@link maxRunSubscriptions} at once.
 */
const watchRuns = async (
  env: Env,
  by: Identity,
  {
    app,
    workflow,
    onChange,
  }: { app: unknown; workflow: unknown; onChange: unknown },
  frame: Frame,
  subscriptions: Set<Disposable>,
  /** Told once the callback is let go of, however that happens. */
  ended?: () => void
): Promise<RunSubscription> => {
  // Following is a request like any other: a screen that follows and
  // lets go over and over is held to what a person may ask. What core
  // then pushes is not counted, and how many it follows at once has its
  // own bound below.
  const id = await admitted(env, by, app);
  const name = screenWorkflow(workflow);
  if (!isStub(onChange)) {
    throw screenErrors.create("screen.invalid");
  }
  const artifact = frame.artifactOf(id);
  await requireDelivery(env, by, id, artifact, {
    operation: "watchRuns",
    stage: "admission",
  });
  if (subscriptions.size >= maxRunSubscriptions) {
    throw screenErrors.create("screen.too_many_subscriptions");
  }
  const callback: Callback & Disposable = callbackFor(
    onChange,
    frame.stillOpen(by, id, artifact, "watchRuns"),
    refusals,
    () => {
      subscriptions.delete(callback);
      frame.held?.forget(callback);
      ended?.();
    }
  );
  subscriptions.add(callback);
  // The frame's from now on: one closed while its host answers lets go
  // of it, and its slot, at once.
  frame.held?.keep(callback);
  let watch: string;
  try {
    watch = await appHost(env, id).watchRuns(name, callback);
  } catch (error) {
    callback[Symbol.dispose]();
    throw error;
  }
  return new RunSubscription(async () => {
    // The slot is free at once, and the callback forwards nothing more;
    // the host drops it now, or at its next push if it can't be reached.
    callback[Symbol.dispose]();
    try {
      await appHost(env, id).unwatchRuns(name, watch);
    } catch (error) {
      log.warn("screen.unwatch_failed", { appId: id, ...errorFields(error) });
    }
  });
};

/**
 * Whether `by` has a role in `app` now, for a live query's gate before
 * each push (query-subscriptions.ts): false when refused, while a failure
 * nobody expected (the database away for a moment) is thrown, so the gate
 * refuses as one to try again, never as a lost role, which would sign
 * the page out of the App. `by` is the gate's own reading of the
 * session, and the gate keeps the answer for a second.
 */
const hasRoleNow = async (
  env: Env,
  by: Identity,
  app: AppId
): Promise<boolean> => {
  try {
    await appFor(env, by, app, "user");
    return true;
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
};

/**
 * Whether the person behind the connection still has `role` in `app`
 * (any role: `user`), before each push: the connection's own session check
 * (`check`), the reading of their session, role and teams that every call
 * shares, Grasp staff's window included, then the App's rules (`appFor`),
 * read again with each new reading of the session and kept until the next.
 * So a push never rests on an older reading than a call would, and a
 * stream of pushes costs one look at the App's rules every few seconds.
 * Anything that goes wrong on the way is a no: a callback must not
 * outlive access because a check failed. A session that ended also closes
 * the connection, as on any call. For the callbacks of an App's screens,
 * and of a draft's preview (chats-rpc.ts).
 */
export const stillHasRole = (
  env: Env,
  check: SessionCheck,
  app: AppId,
  role: "user" | "builder" = "user"
): StillOpen => {
  const refused = (error: unknown): false => {
    if (!isExpectedError(error)) {
      log.error("screen.access_check_failed", {
        appId: app,
        ...errorFields(error),
      });
    }
    return false;
  };
  const hasRole = async (person: Identity): Promise<boolean> => {
    try {
      await appFor(env, person, app, role);
      return true;
    } catch (error) {
      return refused(error);
    }
  };
  let latest: { person: Identity; open: Promise<boolean> } | undefined;
  return async () => {
    let person: Identity;
    try {
      person = await check();
    } catch (error) {
      return refused(error);
    }
    if (latest?.person !== person) {
      latest = { person, open: hasRole(person) };
    }
    return await latest.open;
  };
};

/** Where in a screen a problem happened, as the page reports it. */
const reportedAtSchema = z.strictObject({
  version: appVersionSchema,
  screen: screenNameSchema,
});

const reportProblem = async (
  env: Env,
  by: Identity,
  app: unknown,
  at: unknown,
  problem: unknown
): Promise<void> => {
  const { id } = await getApp(env, by, app);
  // Counted before it is read: a report that says nothing valid, or more
  // than is kept, costs the App's log one number at most.
  if (!(await appHost(env, id).admitReport(by.userId))) {
    throw rateLimited();
  }
  const where = screenErrors.parse("screen.invalid", reportedAtSchema, at);
  const reported = screenErrors.parse(
    "screen.invalid",
    screenProblemSchema,
    problem
  );
  // One of the App's versions, or `app.version_not_found`.
  await findVersion(env, id, where.version);
  await appHost(env, id).logError({
    at: new Date().toISOString(),
    source: "screen",
    ...where,
    ...reported,
  });
};

const errorLog = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<AppErrorLog> => {
  const { id } = await appFor(env, by, app, "builder");
  return await appHost(env, id).errors();
};

/** What a frame's capability shares with its connection (`ScreensRpc`). */
interface FrameConnection {
  readonly env: Env;
  readonly check: SessionCheck;
  /** Who the frame was opened for. */
  readonly userId: string;
  readonly app: AppId;
  /** The build core leased the frame, if the lease was core's for them. */
  readonly artifact: string | undefined;
  /** The connection's check that the person may still use an App. */
  readonly stillOpen: (app: AppId) => StillOpen;
  /** The connection's live queries, bounded for the whole tab. */
  readonly queries: QuerySubscriptions;
  /** The connection's run subscriptions, bounded for the whole tab. */
  readonly runSubscriptions: Set<Disposable>;
}

/**
 * One frame's way to its App on the connection a tab's frames share
 * (`ScreensApi.frame`). Threat model, and how each is closed:
 *
 * - Frame A decided on frame B's build: every call is decided on the
 *   build this frame's own lease named, never on what the connection
 *   presented (`present`) or another frame of the App runs, so a frame
 *   whose build was revoked is refused while another frame's goes on.
 * - A closed frame following on: what it follows through here (its live
 *   queries, its runs' updates, the callbacks its server calls passed)
 *   is kept in `#held`, and `close`, or the page letting go of the stub,
 *   lets go of all of it at once; a closed frame is refused every call,
 *   and its callbacks push nothing more.
 * - Another person: a call checks the connection's session as every call
 *   does, and is refused unless it is still the person the frame was
 *   opened for (`auth.principal_changed`).
 *
 * The tab's bounds (how many queries and run subscriptions, what waits
 * to be pushed) stay the connection's, as spec 11.4 sets them per tab.
 */
export class ScreenFrameRpc extends CoreRpcTarget implements ScreenFrameApi {
  readonly #connection: FrameConnection;
  /** What the frame follows, let go of when it closes. */
  readonly #held = new Set<Disposable>();
  #closed = false;
  /** What the frame's calls are decided on: its own build, always. */
  readonly #frame: Frame;

  constructor(connection: FrameConnection) {
    super();
    this.#connection = connection;
    const { env, app, artifact } = connection;
    this.#frame = {
      artifactOf: (id) => (id === app ? artifact : undefined),
      stillOpen: (by, id, build, operation) => {
        const hasRole = connection.stillOpen(id);
        return async () =>
          !this.#closed &&
          (await hasRole()) &&
          (await deliveryOpen(env, by, id, build, {
            operation,
            stage: "push",
          }));
      },
      held: {
        keep: (held) => {
          this.#keep(held);
        },
        forget: (held) => {
          this.#held.delete(held);
        },
      },
      dispatching: () => {
        this.#open();
      },
    };
  }

  /**
   * Keeps `held` until the frame closes; a frame that closed while it was
   * being made (its call admitted, its subscription opened) lets go of it
   * at once.
   */
  #keep(held: Disposable): void {
    this.#held.add(held);
    if (this.#closed) {
      held[Symbol.dispose]();
    }
  }

  /** The person behind the connection, still the frame's, if it is open. */
  /** Refuses once the frame closed (`screen.invalid`). */
  #open(): void {
    if (this.#closed) {
      throw screenErrors.create("screen.invalid");
    }
  }

  async #person(): Promise<Identity> {
    this.#open();
    const by = await this.#connection.check();
    // Closed while the session was checked: nothing goes on.
    this.#open();
    if (by.userId !== this.#connection.userId) {
      throw authErrors.create("auth.principal_changed");
    }
    return by;
  }

  /**
   * `run`, once this request of the person's is counted (`admitted`), if
   * the frame's build gets the App's data now (`delivering`).
   */
  async #delivered<Answer>(
    operation: string,
    run: (by: Identity) => Promise<Answer>
  ): Promise<Answer> {
    const by = await this.#person();
    const { env, app, artifact } = this.#connection;
    const id = await admitted(env, by, app);
    return await delivering(env, by, id, artifact, operation, async () => {
      // Closed while it was admitted: nothing runs.
      this.#open();
      return await run(by);
    });
  }

  /**
   * `subscription`, kept until it is released or the frame closes: the
   * page gets a hold that releases both.
   */
  async #hold(
    open: (ended: () => void) => RunSubscription | Promise<RunSubscription>
  ): Promise<RunSubscription> {
    // Told when the subscription ends on its own (a refusal, a store
    // that can't be watched, a callback the page no longer takes): the
    // frame forgets it then, so ended ones don't pile up while it's open.
    const state: { hold?: RunSubscription; ended: boolean } = {
      ended: false,
    };
    // Ended, it is still released: what holds it besides its callback (a
    // run watch in the App's host) goes now, not at the next push.
    const subscription = await open(() => {
      state.ended = true;
      void state.hold?.release();
    });
    const hold = new RunSubscription(async () => {
      this.#held.delete(hold);
      await subscription.release();
    });
    state.hold = hold;
    if (state.ended) {
      await hold.release();
    } else {
      this.#keep(hold);
    }
    return hold;
  }

  async delivery(): Promise<ScreenDelivery> {
    const by = await this.#person();
    const { env, app, artifact } = this.#connection;
    // The person's role in the App first, as every call's: someone who
    // lost it hears that, never how the App's build stands.
    const { id } = await getApp(env, by, app);
    return deliveryOf(await standingOf(env, id, artifact));
  }

  async call(method: string, args: unknown[]): Promise<unknown> {
    const by = await this.#person();
    const { env, app } = this.#connection;
    return await callServer(env, by, { app, method, args }, this.#frame);
  }

  async startRun(workflow: string, input?: unknown): Promise<WorkflowRun> {
    const { env, app } = this.#connection;
    return await this.#delivered(
      "startRun",
      async (by) => await startScreenRun(env, by, app, workflow, input)
    );
  }

  async runs(workflow: string): Promise<ScreenRun[]> {
    const { env, app } = this.#connection;
    return await this.#delivered(
      "runs",
      async (by) => await screenRuns(env, by, app, workflow)
    );
  }

  async run(run: string): Promise<ScreenRun> {
    const { env, app } = this.#connection;
    return await this.#delivered(
      "run",
      async (by) => await screenRun(env, by, app, run)
    );
  }

  async summary(run: string): Promise<RunSummary> {
    const { env, app } = this.#connection;
    return await this.#delivered(
      "summary",
      async (by) => await runSummary(env, by, app, run)
    );
  }

  async reviewDecision(
    run: string,
    decision: string,
    answer: unknown
  ): Promise<DecisionReview> {
    const { env, app } = this.#connection;
    return await this.#delivered(
      "reviewDecision",
      async (by) =>
        await reviewScreenDecision(env, by, app, run, decision, answer)
    );
  }

  async confirmDecision(
    run: string,
    decision: string,
    revision: string,
    answer: unknown
  ): Promise<DecisionConfirmation> {
    const { env, app } = this.#connection;
    return await this.#delivered(
      "confirmDecision",
      async (by) =>
        await confirmScreenDecision(
          env,
          by,
          app,
          run,
          decision,
          revision,
          answer
        )
    );
  }

  async decide(
    run: string,
    decision: string,
    answer: unknown,
    confirmation?: string
  ): Promise<DecisionView> {
    const { env, app } = this.#connection;
    return await this.#delivered(
      "decide",
      async (by) =>
        await decideScreenRun(env, by, app, run, decision, answer, confirmation)
    );
  }

  async control(run: string, kind: RunControl["kind"]): Promise<RunControl> {
    const { env, app } = this.#connection;
    return await this.#delivered(
      "control",
      async (by) => await controlScreenRun(env, by, app, run, kind)
    );
  }

  async watchRuns(
    workflow: string,
    onChange: (change: RunChange) => void
  ): Promise<RunSubscription> {
    const by = await this.#person();
    const { env, app, runSubscriptions } = this.#connection;
    return await this.#hold(
      async (ended) =>
        await watchRuns(
          env,
          by,
          { app, workflow, onChange },
          this.#frame,
          runSubscriptions,
          ended
        )
    );
  }

  async watchQuery(
    request: string,
    onSnapshot: (snapshot: QuerySnapshotPush) => void
  ): Promise<RunSubscription> {
    const by = await this.#person();
    const { env, app, artifact, queries } = this.#connection;
    // Following is a request like any other; what core then pushes is
    // not counted (query-subscriptions.ts bounds it).
    const id = await admitted(env, by, app);
    if (
      typeof request !== "string" ||
      request.length > functionRequestMaxBytes ||
      !isStub(onSnapshot)
    ) {
      throw screenErrors.create("screen.invalid");
    }
    await requireDelivery(env, by, id, artifact, {
      operation: "watchQuery",
      stage: "admission",
    });
    return await this.#hold((ended) =>
      queries.subscribe(by, id, artifact, request, onSnapshot, ended)
    );
  }

  /** Lets go of everything the frame follows; refuses its calls from now on. */
  async close(): Promise<void> {
    this.#closed = true;
    // Each takes itself off the set as it goes, which a set allows.
    for (const held of this.#held) {
      held[Symbol.dispose]();
    }
    this.#held.clear();
    await Promise.resolve();
  }

  [Symbol.dispose](): void {
    void this.close();
  }
}

/**
 * A signed-in person's `screens`. Like the other APIs of a session, every
 * call checks the session first and hands the identity that check returned
 * on; each function checks the person's role.
 */
export class ScreensRpc extends CoreRpcTarget implements ScreensApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  /** This connection's run subscriptions that haven't been released. */
  readonly #runSubscriptions = new Set<Disposable>();

  /** Whether the person may still use each App, shared by its callbacks. */
  readonly #access = new Map<AppId, StillOpen>();

  /**
   * Which build this connection's frame runs for each App: the one a
   * lease of core's own named (`present`), so nothing the page or the
   * frame makes up gets in here.
   */
  readonly #presented = new Map<AppId, string>();

  /** What this connection's calls on an App are decided on. */
  readonly #frame: Frame = {
    artifactOf: (app) => this.#presented.get(app),
    stillOpen: (by, app, artifact, operation) => {
      const hasRole = this.#stillOpen(app);
      // Trust is read at every push, never kept: an approval taken back
      // stops the very next one.
      return async () =>
        (await hasRole()) &&
        (await deliveryOpen(this.#env, by, app, artifact, {
          operation,
          stage: "push",
        }));
    },
  };

  /** This connection's live queries (query-subscriptions.ts). */
  readonly #queries: QuerySubscriptions;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
    this.#queries = new QuerySubscriptions(
      env,
      screenReads(env, check, async (by, app, artifact) => {
        if (!(await hasRoleNow(env, by, app))) {
          return "role";
        }
        const open = await deliveryOpen(env, by, app, artifact, {
          operation: "watchQuery",
          stage: "push",
        });
        return open ? "open" : "build";
      })
    );
  }

  /**
   * Whether the person may still use `app`, for this connection's callbacks:
   * one answer per reading of the session, shared by every push meanwhile.
   */
  #stillOpen(app: AppId): StillOpen {
    let open = this.#access.get(app);
    if (open === undefined) {
      open = stillHasRole(this.#env, this.#check, app);
      this.#access.set(app, open);
    }
    return open;
  }

  async open(app: string, screen: string): Promise<ScreenBundle> {
    return await withPerson(
      this.#check,
      async (by) => await openScreen(this.#env, by, app, screen)
    );
  }

  async present(app: string, lease: string): Promise<ScreenDelivery> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await getApp(this.#env, by, app);
      const artifact = await leasedArtifact(this.#env, by.userId, id, lease);
      // A lease core didn't sign for them and this App presents nothing:
      // what the connection held before is gone too, so it can't keep an
      // approved build while its frame runs another.
      if (artifact === undefined) {
        this.#presented.delete(id);
      } else {
        this.#presented.set(id, artifact);
      }
      return deliveryOf(await standingOf(this.#env, id, artifact));
    });
  }

  async frame(app: string, lease: string): Promise<ScreenFrameRpc> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await getApp(this.#env, by, app);
      // Core's own lease names the build, never the page or the frame; a
      // lease core didn't sign for them and this App names none, and is
      // decided as a build nobody approved.
      const artifact = await leasedArtifact(this.#env, by.userId, id, lease);
      return new ScreenFrameRpc({
        env: this.#env,
        check: this.#check,
        userId: by.userId,
        app: id,
        artifact,
        stillOpen: (frameApp) => this.#stillOpen(frameApp),
        queries: this.#queries,
        runSubscriptions: this.#runSubscriptions,
      });
    });
  }

  /**
   * `run` for the App `app` names, once this request of the person's is
   * counted (`admitted`), if the build this connection presented gets the
   * App's data now (`delivering`).
   */
  async #delivered<Answer>(
    by: Identity,
    app: string,
    operation: string,
    run: (id: AppId) => Promise<Answer>
  ): Promise<Answer> {
    const id = await admitted(this.#env, by, app);
    return await delivering(
      this.#env,
      by,
      id,
      this.#presented.get(id),
      operation,
      async () => await run(id)
    );
  }

  async call(app: string, method: string, args: unknown[]): Promise<unknown> {
    return await withPerson(
      this.#check,
      async (by) =>
        await callServer(this.#env, by, { app, method, args }, this.#frame)
    );
  }

  async version(app: string): Promise<number | null> {
    return await withPerson(this.#check, async (by) => {
      const { currentVersion } = await getApp(this.#env, by, app);
      return currentVersion;
    });
  }

  async report(
    app: string,
    at: { version: number; screen: string },
    problem: unknown
  ): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await reportProblem(this.#env, by, app, at, problem);
    });
  }

  async errors(app: string): Promise<AppErrorLog> {
    return await withPerson(
      this.#check,
      async (by) => await errorLog(this.#env, by, app)
    );
  }

  async startRun(
    app: string,
    workflow: string,
    input?: unknown
  ): Promise<WorkflowRun> {
    return await withPerson(
      this.#check,
      async (by) =>
        await this.#delivered(
          by,
          app,
          "startRun",
          async (id) => await startScreenRun(this.#env, by, id, workflow, input)
        )
    );
  }

  async runs(app: string, workflow: string): Promise<ScreenRun[]> {
    return await withPerson(
      this.#check,
      async (by) =>
        await this.#delivered(
          by,
          app,
          "runs",
          async (id) => await screenRuns(this.#env, by, id, workflow)
        )
    );
  }

  async run(app: string, run: string): Promise<ScreenRun> {
    return await withPerson(
      this.#check,
      async (by) =>
        await this.#delivered(
          by,
          app,
          "run",
          async (id) => await screenRun(this.#env, by, id, run)
        )
    );
  }

  async summary(app: string, run: string): Promise<RunSummary> {
    return await withPerson(
      this.#check,
      async (by) =>
        await this.#delivered(
          by,
          app,
          "summary",
          async (id) => await runSummary(this.#env, by, id, run)
        )
    );
  }

  async reviewDecision(
    app: string,
    run: string,
    decision: string,
    answer: unknown
  ): Promise<DecisionReview> {
    return await withPerson(
      this.#check,
      async (by) =>
        await this.#delivered(
          by,
          app,
          "reviewDecision",
          async (id) =>
            await reviewScreenDecision(this.#env, by, id, run, decision, answer)
        )
    );
  }

  async confirmDecision(
    app: string,
    run: string,
    decision: string,
    revision: string,
    answer: unknown
  ): Promise<DecisionConfirmation> {
    return await withPerson(
      this.#check,
      async (by) =>
        await this.#delivered(
          by,
          app,
          "confirmDecision",
          async (id) =>
            await confirmScreenDecision(
              this.#env,
              by,
              id,
              run,
              decision,
              revision,
              answer
            )
        )
    );
  }

  async decide(
    app: string,
    run: string,
    decision: string,
    answer: unknown,
    confirmation?: string
  ): Promise<DecisionView> {
    return await withPerson(
      this.#check,
      async (by) =>
        await this.#delivered(
          by,
          app,
          "decide",
          async (id) =>
            await decideScreenRun(
              this.#env,
              by,
              id,
              run,
              decision,
              answer,
              confirmation
            )
        )
    );
  }

  async control(
    app: string,
    run: string,
    kind: RunControl["kind"]
  ): Promise<RunControl> {
    return await withPerson(
      this.#check,
      async (by) =>
        await this.#delivered(
          by,
          app,
          "control",
          async (id) => await controlScreenRun(this.#env, by, id, run, kind)
        )
    );
  }

  async watchRuns(
    app: string,
    workflow: string,
    onChange: (change: RunChange) => void
  ): Promise<RunSubscription> {
    return await withPerson(
      this.#check,
      async (by) =>
        await watchRuns(
          this.#env,
          by,
          { app, workflow, onChange },
          this.#frame,
          this.#runSubscriptions
        )
    );
  }

  async watchQuery(
    app: string,
    lease: string,
    request: string,
    onSnapshot: (snapshot: QuerySnapshotPush) => void
  ): Promise<RunSubscription> {
    return await withPerson(this.#check, async (by) => {
      // Following is a request like any other; what core then pushes is
      // not counted (query-subscriptions.ts bounds it).
      const id = await admitted(this.#env, by, app);
      if (
        typeof request !== "string" ||
        request.length > functionRequestMaxBytes ||
        !isStub(onSnapshot)
      ) {
        throw screenErrors.create("screen.invalid");
      }
      // The build of the frame that follows, by its own lease: never what
      // another frame of the App on this connection presented last.
      const artifact = await leasedArtifact(this.#env, by.userId, id, lease);
      await requireDelivery(this.#env, by, id, artifact, {
        operation: "watchQuery",
        stage: "admission",
      });
      return this.#queries.subscribe(by, id, artifact, request, onSnapshot);
    });
  }
}

import { appErrors, appVersionSchema } from "@grasp-os/shared/apps";
import type { App } from "@grasp-os/shared/apps";
import type { DecisionView } from "@grasp-os/shared/decisions";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ScreenDelivery } from "@grasp-os/shared/screen-trust";
import {
  jsonBytes,
  screenErrors,
  screenLimits,
  screenNameSchema,
  screenProblemSchema,
} from "@grasp-os/shared/screens";
import type {
  AppErrorLog,
  RunChange,
  ScreenBundle,
  ScreenRun,
  ScreensApi,
} from "@grasp-os/shared/screens";
import type { WorkflowRun } from "@grasp-os/shared/workflows";
import { RpcTarget } from "capnweb";
import { z } from "zod";

import { callApp, isPlainData } from "./app.ts";
import type { AppAnswer } from "./app.ts";
import { appFor, findVersion, getApp, versionFiles } from "./apps.ts";
import { appHost } from "./durable-objects.ts";
import { callbackFor, isStub } from "./page-callbacks.ts";
import type { StillOpen } from "./page-callbacks.ts";
import { RunSubscription } from "./run-subscription.ts";
import { recordBuilds } from "./screen-builds.ts";
import { frameAccess, stageFrame } from "./screen-frame.ts";
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
import {
  decideScreenRun,
  screenRun,
  screenRuns,
  screenWorkflow,
  startScreenRun,
} from "./workflows/screen-runs.ts";

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
 * connection is one open screen, which follows a workflow or two: this
 * only bounds what a screen that subscribes over and over keeps in its
 * App's host.
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
    throw screenErrors.create("screen.rate_limited");
  }
  return found;
};

/** `admittedApp`, for its ID. */
const admitted = async (
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
    throw screenErrors.create("screen.rate_limited");
  }
};

/** `answer`, if it is no more than a screen takes in one call. */
export const withinAnswer = <Answer>(answer: Answer): Answer => {
  if (jsonBytes(answer) > screenLimits.answerBytes) {
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
  const files = await versionFiles(env, id, version);
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
  stillOpen: StillOpen
): { passed: unknown[]; callbacks: Disposable[] } => {
  if (!args.every((arg) => isStub(arg) || isPlainData(arg))) {
    throw screenErrors.create("screen.invalid");
  }
  // Measured without the callbacks, which carry nothing yet.
  const data = args.filter((arg) => !isStub(arg));
  if (jsonBytes(data) > screenLimits.inputBytes) {
    throw screenErrors.create("screen.input_too_large");
  }
  const callbacks: Disposable[] = [];
  const passed = args.map((arg) => {
    if (!isStub(arg)) {
      return arg;
    }
    const callback = callbackFor(arg, stillOpen, refusals);
    callbacks.push(callback);
    return callback;
  });
  return { passed, callbacks };
};

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
    frame.stillOpen(by, id, artifact, "call")
  );
  try {
    return await delivering(env, by, id, artifact, "call", async () =>
      withinAnswer(
        await callApp(
          env,
          id,
          { userId: by.userId, mode: "interactive" },
          method,
          passed
        )
      )
    );
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
  subscriptions: Set<Disposable>
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
    }
  );
  subscriptions.add(callback);
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
    throw screenErrors.create("screen.rate_limited");
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

/**
 * A signed-in person's `screens`. Like the other APIs of a session, every
 * call checks the session first and hands the identity that check returned
 * on; each function checks the person's role.
 */
export class ScreensRpc extends RpcTarget implements ScreensApi {
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

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
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

  async decide(
    app: string,
    run: string,
    decision: string,
    answer: unknown
  ): Promise<DecisionView> {
    return await withPerson(
      this.#check,
      async (by) =>
        await this.#delivered(
          by,
          app,
          "decide",
          async (id) =>
            await decideScreenRun(this.#env, by, id, run, decision, answer)
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
}

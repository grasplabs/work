import { appErrors } from "@grasp-os/shared/apps";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { OperationResult } from "@grasp-os/shared/operations";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  jsonBytes,
  querySubscriptionLimits,
  screenErrors,
  screenLimits,
} from "@grasp-os/shared/screens";
import type { QuerySnapshotPush } from "@grasp-os/shared/screens";

import { operationRoles } from "./app-access.ts";
import { evaluateAppQuery, refusalOf } from "./app-functions.ts";
import type { EvaluatedQuery } from "./app-functions.ts";
import { appHost, inJurisdiction } from "./durable-objects.ts";
import { RunSubscription } from "./run-subscription.ts";
import { delivering } from "./screen-trust.ts";
import type { SessionCheck } from "./session-check.ts";

// Live queries (spec 11): what one page's connection to core (one browser
// tab) follows of its Apps' public queries, kept fresh by core. A screen
// asks to follow a query (`watchQuery`); core reads it as the person and
// pushes the result; the App's store tells core of every write that
// changed a table the query read (store-watches.ts), and core reads it
// again and pushes the new result. The screen never asks again, and no
// App code subscribes or broadcasts.
//
// Who a connection reads for, and how, is its `LiveReads`: a page's are
// the person behind its session, the App's current release and its
// business store (`screenReads`); an App test principal's are the
// fixture's, on the test's own store (app-tests.ts). Everything else
// here (ordering, gathering, watching, the gate before each push, the
// bounds and releasing) is the same for both: a test follows a query
// through exactly what a screen follows it through.
//
// Delivery (spec 11.3): a query is read, then watched with the generation
// of each table it read, compared on the spot with the store's own, so a
// write between the read and the watch is never missed; changes are
// gathered for a while and the query read once for all of them; each
// subscription's pushes are numbered, the screen dropping any older than
// what it shows. Threat model, and how each is closed:
//
// - A snapshot reaches someone who lost access: every read runs as the
//   person behind the connection's session now (`check`), through the
//   App's role check and the release's own authorization, inside the
//   build's trust check (`delivering`), and every push of data is made
//   only after the connection's access check (the person's role and the
//   build's trust, read again). A refusal of either is pushed as the
//   subscription's last result, which carries no data and makes the
//   screen drop what it holds, and the subscription ends: its readers are
//   let go of before anything is awaited, so nothing that waited to be
//   pushed goes out after the refusal.
// - A subscription outlives its session or the App's version: a session
//   that ended refuses the read (`check`) and ends it; a reference to a
//   version that is no longer current is refused (`version.*`) and ends
//   it, never read against another contract.
// - Results cross people or builds: a connection is one session's, and
//   one read is shared only by subscriptions of the same App, build,
//   person and canonical request on it; the build is the one the
//   subscribing frame's own lease names, never another frame's.
// - A snapshot can't be kept fresh: when the store can't be watched (its
//   object unreachable, restarted, or at its bound) nothing more is
//   pushed, and core lets go of the screen's callbacks, which tells the
//   screen to follow again, from a fresh read, later. A watch the store
//   lost without core hearing of it is found by a `rewatch` every
//   `livenessMs`.
// - Ordering and staleness after a reconnect: a new subscription starts
//   from a fresh read; the screen orders pushes by subscription and
//   revision, so an older connection's late push is dropped.
// - Fan-out cost: a connection follows at most `perConnection` queries
//   (`screen.too_many_queries`), a person `perPerson` of one App's store,
//   held by the store. Reads a write causes are charged to the person's
//   `liveReads` budget of the App, held by the App's host across tabs;
//   past it a read waits and gathers every change meanwhile. A connection
//   runs `concurrentReads` reads at once, the rest queued, and gathers a
//   query's changes for longer the more of its queries wait (up to
//   `maxCoalesceMs`). A query is never read twice at once.
// - Memory: what waits to be pushed is at most one replacement per
//   subscription and `unsentBytes` for the whole connection; past that,
//   results in between are dropped, and the subscription gets the latest
//   once the page takes what it has. A result is kept only until every
//   subscription has it: a later subscriber gets a fresh read.

/** How long a read of a live query may take. */
const evaluationMs = 30_000;

/**
 * How long one look at the person's role and the build's trust clears
 * pushes of an App's data on a connection (`#gate`).
 */
const accessCacheMs = 1000;

/**
 * How long core waits for a page to take a subscription's last result (a
 * refusal) before it lets go of the page's callback anyway.
 */
const finalPushMs = 10_000;

/**
 * Refusals that end a subscription: the person, the session or the build
 * lost access, or the reference no longer names the App's current
 * version. Pushed as the last result; reading again would only repeat
 * them.
 */
const endsSubscription = (code: string): boolean =>
  code.startsWith("auth.") ||
  code.startsWith("version.") ||
  code === "role.forbidden" ||
  code === "app.not_found" ||
  code === "app.unreadable" ||
  code === "app.not_running" ||
  code === "screen.unreviewed" ||
  code === "screen.revoked";

/** A result as a push carries it: `{ ok, value }` or `{ ok, error }`. */
type Result = OperationResult;

/** A push made, and its size. */
interface Snapshot {
  readonly push: QuerySnapshotPush;
  readonly bytes: number;
  /** The roles it was read under (`rolesOf`): it goes out under those only. */
  readonly roles: string;
}

/**
 * The roles `by` reads App `app`'s tables with (`operationRoles`), as a
 * key: what decides which records a read sees, so a result read under
 * one is never pushed under another.
 */
const rolesOf = async (
  env: Env,
  by: Identity,
  app: AppId
): Promise<string | undefined> => {
  try {
    const { appMember, appBuilder } = await operationRoles(env, by, app);
    return canonicalJson({ appMember, appBuilder });
  } catch {
    // No role in the App any more, or no answer: no roles to push under.
    return undefined;
  }
};

/**
 * Where a subscription's pushes go: a page's callback, or an App test's
 * (app-tests.ts). Each `dup` is a hold of its own; disposing the last
 * tells the subscriber core let go of it, so it follows again.
 */
export interface SnapshotCallback {
  (push: QuerySnapshotPush): unknown;
  dup: () => SnapshotCallback;
  [Symbol.dispose]: () => void;
}

/** One screen's subscription to a query. */
interface Listener {
  readonly toPage: SnapshotCallback;
  /** The latest revision sent to it. */
  sent: number;
  inFlight: boolean;
  /** The one result waiting while one is in flight. */
  pending: Snapshot | undefined;
  /** Dropped results past the connection's bound: owed the latest. */
  behind: boolean;
  /**
   * The size of the result dropped for it past the bound: it is read
   * again only once that much fits.
   */
  behindBytes: number;
  released: boolean;
}

/** One query read for the subscriptions that share it. */
interface Evaluation {
  readonly key: string;
  readonly app: AppId;
  readonly artifact: string | undefined;
  readonly request: string;
  readonly listeners: Set<Listener>;
  revision: number;
  /** The latest result, while a subscription still needs it. */
  latest: Snapshot | undefined;
  /** Its watch in the store, and what that watch read, once made. */
  watch:
    | {
        readonly storeId: StoreId;
        readonly id: string;
        readSet: Record<string, number>;
      }
    | undefined;
  /** Its gathering window, its wait for budget, or its liveness check. */
  timer: ReturnType<typeof setTimeout> | undefined;
  liveness: ReturnType<typeof setTimeout> | undefined;
  /** Waiting in the connection's queue, or being read. */
  queued: boolean;
  running: boolean;
  /** Changed again while it was queued or read. */
  dirty: boolean;
  /** Its next read is one a write caused, charged to the person's budget. */
  charged: boolean;
  /** How long it waited for budget last, to wait longer next time. */
  budgetWaitMs: number;
  closed: boolean;
}

/** What the connection's access check says, before each push of data. */
export type AccessCheck<By = Identity> = (
  by: By,
  app: AppId,
  artifact: string | undefined
) => Promise<"open" | "role" | "build">;

/** Whoever a connection's live queries are read for, by `userId`. */
export interface Reader {
  readonly userId: string;
}

/** What one read of a live query answered, and the store state it read. */
export interface LiveRead {
  readonly result: Result;
  readonly reads: EvaluatedQuery["reads"];
}

/**
 * Who one connection's live queries are read for, and how they are read
 * (see the header).
 */
export interface LiveReads<By extends Reader> {
  /**
   * Who reads, now: throws once nobody may (the session ended). The same
   * object for as long as one reading holds, which the gate's cache is
   * keyed by.
   */
  check: () => Promise<By>;
  /** The access check before each push of data. */
  access: AccessCheck<By>;
  /**
   * The roles `by` reads App `app`'s tables with, as a key: a result read
   * under one is never pushed under another. None once they have none.
   */
  roles: (by: By, app: AppId) => Promise<string | undefined>;
  /** Whether a read a write caused may run now, within `by`'s budget. */
  admit: (by: By, app: AppId) => Promise<boolean>;
  /**
   * Reads the query `request` names as `by`, as build `artifact`, by
   * `deadline`; a throw is a refusal that ends the subscription.
   */
  evaluate: (
    by: By,
    app: AppId,
    artifact: string | undefined,
    request: string,
    deadline: number
  ) => Promise<LiveRead>;
}

/**
 * A page's live reads: as the person behind the connection's session
 * (`check`), checked with `access` before each push, read from the App's
 * current release inside the build's trust check, and charged to the
 * person's live reads of the App.
 */
export const screenReads = (
  env: Env,
  check: SessionCheck,
  access: AccessCheck
): LiveReads<Identity> => ({
  check,
  access,
  roles: async (by, app) => await rolesOf(env, by, app),
  admit: async (by, app) => await appHost(env, app).admitLiveRead(by.userId),
  evaluate: async (by, app, artifact, request, deadline) => {
    const { answer, reads } = await delivering(
      env,
      by,
      app,
      artifact,
      "watchQuery",
      async () => await evaluateAppQuery(env, by, app, request, deadline)
    );
    return { result: answer.result, reads };
  },
});

/** A store's object, for its watches. */
const storeOf = (env: Env, storeId: StoreId) =>
  inJurisdiction(env, env.DATA_STORES).getByName(storeId);

/**
 * The key two subscriptions share a read by: the App, the build, the
 * person and the canonical call. A request that isn't JSON is keyed by
 * its text; its read refuses it.
 */
const keyOf = (
  app: AppId,
  artifact: string | undefined,
  userId: string,
  request: string
): string => {
  let call = request;
  try {
    // SAFETY: what `JSON.parse` answers is JSON.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    call = canonicalJson(JSON.parse(request) as Json);
  } catch {
    // Keyed by its text.
  }
  return canonicalJson([app, artifact ?? null, userId, call]);
};

/** A refusal as a push carries it. */
const refusalResult = (error: unknown): Result => ({
  ok: false,
  error: refusalOf(error, crypto.randomUUID()),
});

/** Whether every subscription of `evaluation` has its latest result. */
const allHaveLatest = (evaluation: Evaluation): boolean =>
  [...evaluation.listeners].every(
    (listener) =>
      // One behind the connection's bound reads afresh once the page has
      // room (`#catchUp`), so nothing is kept for it meanwhile.
      listener.behind ||
      (listener.pending === undefined &&
        listener.sent >= (evaluation.latest?.push.revision ?? 0))
  );

/** One connection's live queries. */
export class QuerySubscriptions<By extends Reader = Identity> {
  readonly #env: Env;
  readonly #reads: LiveReads<By>;
  readonly #evaluations = new Map<string, Evaluation>();
  /** Reads waiting their turn, oldest first. */
  readonly #queue: Evaluation[] = [];
  /** Reads under way. */
  #running = 0;
  /** Subscriptions not released. */
  #count = 0;
  /** Bytes of snapshots handed to the page and not yet taken. */
  #unsent = 0;
  /** The latest look at access, per App and build (`#gate`). */
  readonly #cleared = new Map<
    string,
    {
      readonly by: By;
      readonly until: number;
      readonly access: ReturnType<AccessCheck<By>>;
      readonly roles: Promise<string | undefined>;
    }
  >();

  constructor(env: Env, reads: LiveReads<By>) {
    this.#env = env;
    this.#reads = reads;
  }

  /**
   * Follows the query `request` names of `app` for `by`, its results
   * pushed to `onSnapshot`, as the build `artifact` the subscribing
   * frame's lease names (see the header). The caller admitted the
   * request and checked the build's trust.
   */
  subscribe(
    by: By,
    app: AppId,
    artifact: string | undefined,
    request: string,
    onSnapshot: SnapshotCallback
  ): RunSubscription {
    if (this.#count >= querySubscriptionLimits.perConnection) {
      throw screenErrors.create("screen.too_many_queries");
    }
    const key = keyOf(app, artifact, by.userId, request);
    const evaluation =
      this.#evaluations.get(key) ?? this.#start(key, app, artifact, request);
    const listener: Listener = {
      toPage: onSnapshot.dup(),
      sent: 0,
      inFlight: false,
      pending: undefined,
      behind: false,
      behindBytes: 0,
      released: false,
    };
    evaluation.listeners.add(listener);
    this.#count += 1;
    // A result kept for another subscription that hasn't taken it yet
    // goes to this one too; otherwise a read on its way answers it, or a
    // fresh one, admitted as the person's request, so not charged.
    if (evaluation.latest !== undefined) {
      this.#offer(evaluation, listener, evaluation.latest);
    } else if (
      !(evaluation.running || evaluation.queued) &&
      evaluation.timer === undefined
    ) {
      this.#enqueue(evaluation, false);
    }
    return new RunSubscription(async () => {
      this.#release(evaluation, listener);
      await Promise.resolve();
    });
  }

  #start(
    key: string,
    app: AppId,
    artifact: string | undefined,
    request: string
  ): Evaluation {
    const evaluation: Evaluation = {
      key,
      app,
      artifact,
      request,
      listeners: new Set(),
      revision: 0,
      latest: undefined,
      watch: undefined,
      timer: undefined,
      liveness: undefined,
      queued: false,
      running: false,
      dirty: false,
      charged: false,
      budgetWaitMs: 0,
      closed: false,
    };
    this.#evaluations.set(key, evaluation);
    return evaluation;
  }

  /**
   * Something it read changed: read it again, gathered over a window
   * that stretches with how many of the connection's reads wait.
   */
  #changed(evaluation: Evaluation): void {
    if (evaluation.closed) {
      return;
    }
    if (evaluation.running || evaluation.queued) {
      evaluation.dirty = true;
      return;
    }
    if (evaluation.timer !== undefined) {
      return;
    }
    const waiting = this.#queue.length + this.#running;
    const windowMs = Math.min(
      querySubscriptionLimits.maxCoalesceMs,
      querySubscriptionLimits.coalesceMs *
        (1 + Math.floor(waiting / querySubscriptionLimits.concurrentReads))
    );
    evaluation.timer = setTimeout(() => {
      evaluation.timer = undefined;
      this.#enqueue(evaluation, true);
    }, windowMs);
  }

  /** Queues a read of `evaluation`, charged when a write caused it. */
  #enqueue(evaluation: Evaluation, charged: boolean): void {
    if (evaluation.closed || evaluation.queued || evaluation.running) {
      return;
    }
    evaluation.queued = true;
    evaluation.charged = charged;
    this.#queue.push(evaluation);
    this.#pump();
  }

  /** Starts queued reads while fewer than `concurrentReads` run. */
  #pump(): void {
    while (
      this.#running < querySubscriptionLimits.concurrentReads &&
      this.#queue.length > 0
    ) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        next.queued = false;
        if (!next.closed) {
          void this.#evaluate(next);
        }
      }
    }
  }

  /** Reads `evaluation`'s query, keeps it watched and pushes the result. */
  async #evaluate(evaluation: Evaluation): Promise<void> {
    evaluation.running = true;
    evaluation.dirty = false;
    this.#running += 1;
    try {
      await this.#readAndPush(evaluation);
    } catch (error) {
      log.error("query.evaluation_failed", errorFields(error));
      await this.#lose(evaluation);
    } finally {
      evaluation.running = false;
      this.#running -= 1;
      if (evaluation.dirty && !evaluation.closed) {
        this.#changed(evaluation);
      }
      this.#pump();
    }
  }

  async #readAndPush(evaluation: Evaluation): Promise<void> {
    const { app, artifact, request } = evaluation;
    let by: By;
    try {
      by = await this.#reads.check();
    } catch (error) {
      await this.#end(evaluation, refusalResult(error));
      return;
    }
    if (evaluation.charged && !(await this.#reads.admit(by, app))) {
      // Past the person's budget: read later, gathering every change
      // meanwhile, waiting longer each time it is still spent.
      evaluation.budgetWaitMs = Math.min(
        querySubscriptionLimits.liveReadWaitMs,
        Math.max(500, evaluation.budgetWaitMs * 2)
      );
      evaluation.timer = setTimeout(() => {
        evaluation.timer = undefined;
        this.#enqueue(evaluation, true);
      }, evaluation.budgetWaitMs);
      return;
    }
    evaluation.budgetWaitMs = 0;
    // The roles it is read under, looked at first: the read sees records
    // by roles at least as new, and a result whose roles changed since is
    // read again rather than pushed (`#send`).
    const before = await this.#gate(evaluation);
    if ("refusal" in before) {
      await this.#end(evaluation, before.refusal);
      return;
    }
    let evaluated: LiveRead;
    try {
      evaluated = await this.#reads.evaluate(
        by,
        app,
        artifact,
        request,
        Date.now() + evaluationMs
      );
    } catch (error) {
      await this.#end(evaluation, refusalResult(error));
      return;
    }
    if (evaluation.closed) {
      return;
    }
    const { result } = evaluated;
    if (!result.ok && endsSubscription(result.error.code)) {
      await this.#end(evaluation, result);
      return;
    }
    // A failure the host would answer differently later (the sandbox
    // busy or away, a concurrent change) is not pushed as though it were
    // final, nor watched: what it read, if anything, isn't what an answer
    // would read. The screen keeps what it shows and follows again.
    if (!result.ok && result.error.retryable) {
      await this.#lose(evaluation);
      return;
    }
    const { reads } = evaluated;
    if (reads === undefined) {
      // Nothing read that could be watched.
      await this.#unwatch(evaluation);
    } else if (!(await this.#keepWatched(evaluation, by, reads))) {
      await this.#lose(evaluation);
      return;
    }
    // The person and the build, checked again before any data goes out
    // (and again before each push of it, `#send`).
    const after = await this.#gate(evaluation);
    if ("refusal" in after) {
      await this.#end(evaluation, after.refusal);
      return;
    }
    if (after.roles !== before.roles) {
      evaluation.dirty = true;
      return;
    }
    this.#publish(evaluation, result, before.roles);
  }

  /**
   * The gate every push of data passes, just before it goes out: the
   * connection's session read now (`check`), then the person's role in
   * the App and the build's trust, as a refusal to end with; while all
   * three hold, the roles the person reads the App's tables with now
   * (member, builder), which a result read under other roles must not go
   * out with (`#send`). Kept for `accessCacheMs` per App and build, and
   * only for the same reading of the session (a new reading, after the
   * session's recheck interval, asks again), so a burst of pushes costs
   * one look, and a change is seen within that second at most.
   */
  async #gate(
    evaluation: Evaluation
  ): Promise<{ refusal: Result } | { roles: string }> {
    const { app, artifact } = evaluation;
    let by: By;
    try {
      by = await this.#reads.check();
    } catch (error) {
      return { refusal: refusalResult(error) };
    }
    const key = canonicalJson([app, artifact ?? null]);
    const now = Date.now();
    let cached = this.#cleared.get(key);
    if (cached === undefined || cached.by !== by || cached.until <= now) {
      cached = {
        by,
        until: now + accessCacheMs,
        access: this.#reads.access(by, app, artifact),
        roles: this.#reads.roles(by, app),
      };
      this.#cleared.set(key, cached);
    }
    let access: Awaited<ReturnType<AccessCheck<By>>>;
    let roles: string | undefined;
    try {
      access = await cached.access;
      roles = access === "open" ? await cached.roles : undefined;
    } catch {
      access = "role";
    }
    if (access === "open" && roles !== undefined) {
      return { roles };
    }
    this.#cleared.delete(key);
    // Someone without a role is refused as a read refuses them: nothing
    // of the App disclosed.
    return {
      refusal: refusalResult(
        access === "build"
          ? screenErrors.create("screen.revoked")
          : appErrors.create("app.not_found")
      ),
    };
  }

  /**
   * A fresh watcher for one watch of `evaluation`: told by the store of a
   * change, or let go of by it (its object restarted). Only the watch it
   * was made for counts, so a late word about an older one reads nothing.
   */
  #watcherFor(
    evaluation: Evaluation,
    made: { id: string | undefined; early: boolean }
  ): ((tables: string[]) => void) & Disposable {
    const current = (): boolean =>
      !evaluation.closed &&
      made.id !== undefined &&
      evaluation.watch?.id === made.id;
    return Object.assign(
      (tables: string[]): void => {
        // Once its query closed or moved to another watch, it says it is
        // gone, so the store drops the watch even if core's own word that
        // it let go of it never arrived (`#unwatch`).
        if (made.id !== undefined && !current()) {
          throw new Error("This watch is no longer followed.");
        }
        // Called with none to see whether it is still here.
        if (tables.length === 0) {
          return;
        }
        if (made.id === undefined) {
          // Told before `watch` answered (a write landed after the read):
          // kept until the watch is installed (`#keepWatched`).
          made.early = true;
        } else {
          this.#changed(evaluation);
        }
      },
      {
        [Symbol.dispose]: (): void => {
          if (made.id === undefined) {
            made.early = true;
          } else if (current()) {
            evaluation.watch = undefined;
            this.#changed(evaluation);
          }
        },
      }
    );
  }

  /**
   * Watches what `evaluation` read in its store, moving its watch on or
   * making it anew: false when the store can't be reached, or holds no
   * more watches now (core tries again later).
   */
  async #keepWatched(
    evaluation: Evaluation,
    by: By,
    reads: {
      readonly storeId: StoreId;
      readonly readSet: Record<string, number>;
    }
  ): Promise<boolean> {
    const { storeId, readSet } = reads;
    try {
      const { watch } = evaluation;
      if (watch !== undefined && watch.storeId === storeId) {
        if (
          await storeOf(this.#env, storeId).rewatch(storeId, watch.id, readSet)
        ) {
          watch.readSet = readSet;
          this.#checkLater(evaluation);
          return true;
        }
      } else if (watch !== undefined) {
        await this.#unwatch(evaluation);
      }
      const made: { id: string | undefined; early: boolean } = {
        id: undefined,
        early: false,
      };
      const { id, moved } = await storeOf(this.#env, storeId).watch(
        storeId,
        by.userId,
        readSet,
        this.#watcherFor(evaluation, made)
      );
      made.id = id;
      if (evaluation.closed) {
        await storeOf(this.#env, storeId).unwatch(id);
        return true;
      }
      evaluation.watch = { storeId, id, readSet };
      this.#checkLater(evaluation);
      if (moved || made.early) {
        // A write moved past what this read saw, as the store answered,
        // or told before the watch was installed: read again once this
        // read is pushed.
        evaluation.dirty = true;
      }
      return true;
    } catch (error) {
      log.warn("query.watch_failed", errorFields(error));
      evaluation.watch = undefined;
      return false;
    }
  }

  /**
   * Checks, `livenessMs` from now, that the store still holds the watch:
   * one it lost without a word (`rewatch` answers false), or one a write
   * moved past without telling, has the query read again.
   */
  #checkLater(evaluation: Evaluation): void {
    clearTimeout(evaluation.liveness);
    evaluation.liveness = setTimeout(() => {
      evaluation.liveness = undefined;
      void this.#checkWatch(evaluation);
    }, querySubscriptionLimits.livenessMs);
  }

  async #checkWatch(evaluation: Evaluation): Promise<void> {
    const { watch } = evaluation;
    if (evaluation.closed || watch === undefined) {
      return;
    }
    let held = false;
    try {
      held = await storeOf(this.#env, watch.storeId).rewatch(
        watch.storeId,
        watch.id,
        watch.readSet
      );
    } catch (error) {
      log.warn("query.liveness_failed", errorFields(error));
    }
    if (evaluation.watch !== watch) {
      return;
    }
    if (held) {
      this.#checkLater(evaluation);
      return;
    }
    evaluation.watch = undefined;
    this.#changed(evaluation);
  }

  async #unwatch(evaluation: Evaluation): Promise<void> {
    const { watch } = evaluation;
    evaluation.watch = undefined;
    clearTimeout(evaluation.liveness);
    evaluation.liveness = undefined;
    if (watch === undefined) {
      return;
    }
    try {
      await storeOf(this.#env, watch.storeId).unwatch(watch.id);
    } catch (error) {
      // The store drops it at its next telling, or sweep.
      log.warn("query.unwatch_failed", errorFields(error));
    }
  }

  /** Numbers `result` and offers it to every subscription of `evaluation`. */
  #publish(evaluation: Evaluation, result: Result, roles: string): void {
    if (evaluation.closed) {
      return;
    }
    evaluation.revision += 1;
    let push: QuerySnapshotPush = { revision: evaluation.revision, result };
    let bytes = jsonBytes(push, screenLimits.answerBytes + 1);
    if (bytes > screenLimits.answerBytes) {
      push = {
        revision: evaluation.revision,
        result: refusalResult(screenErrors.create("screen.answer_too_large")),
      };
      bytes = jsonBytes(push, screenLimits.answerBytes);
    }
    const snapshot: Snapshot = { push, bytes, roles };
    evaluation.latest = snapshot;
    for (const listener of evaluation.listeners) {
      this.#offer(evaluation, listener, snapshot);
    }
    QuerySubscriptions.#forgetDelivered(evaluation);
  }

  /** Drops `evaluation`'s latest result once every subscription has it. */
  static #forgetDelivered(evaluation: Evaluation): void {
    if (evaluation.latest !== undefined && allHaveLatest(evaluation)) {
      evaluation.latest = undefined;
    }
  }

  /**
   * Hands `snapshot` to `listener`: now, or as its one replacement while
   * one is in flight, or not at all past the connection's bound, which
   * leaves it owed the latest.
   */
  #offer(evaluation: Evaluation, listener: Listener, snapshot: Snapshot): void {
    if (listener.released || snapshot.push.revision <= listener.sent) {
      return;
    }
    if (listener.pending !== undefined) {
      this.#unsent -= listener.pending.bytes;
      listener.pending = undefined;
    }
    // One result alone always goes, however large: the bound is on what
    // piles up behind it.
    const nothingWaits = this.#unsent === 0;
    if (
      !nothingWaits &&
      this.#unsent + snapshot.bytes > querySubscriptionLimits.unsentBytes
    ) {
      listener.behind = true;
      listener.behindBytes = snapshot.bytes;
      QuerySubscriptions.#forgetDelivered(evaluation);
      return;
    }
    listener.behind = false;
    listener.behindBytes = 0;
    if (listener.inFlight) {
      listener.pending = snapshot;
      this.#unsent += snapshot.bytes;
      return;
    }
    void this.#send(evaluation, listener, snapshot);
  }

  async #send(
    evaluation: Evaluation,
    listener: Listener,
    snapshot: Snapshot
  ): Promise<void> {
    listener.inFlight = true;
    listener.sent = snapshot.push.revision;
    this.#unsent += snapshot.bytes;
    try {
      // Every push of data passes the gate first, however long it waited.
      const gate = await this.#gate(evaluation);
      if ("refusal" in gate) {
        void this.#end(evaluation, gate.refusal);
      } else if (gate.roles !== snapshot.roles) {
        // Read under roles the person no longer has: dropped, and read
        // again as they are now.
        if (evaluation.latest === snapshot) {
          evaluation.latest = undefined;
        }
        listener.behind = true;
        listener.behindBytes = 0;
      } else if (!listener.released) {
        await listener.toPage(snapshot.push);
      }
    } catch {
      // The page is gone, or stopped following.
      this.#release(evaluation, listener);
    } finally {
      this.#unsent -= snapshot.bytes;
      listener.inFlight = false;
    }
    // Released meanwhile (a refusal ended it): nothing more goes out to
    // it, but the room it took is free for the others.
    if (listener.released) {
      this.#catchUp();
      return;
    }
    const next = listener.pending;
    if (next !== undefined) {
      listener.pending = undefined;
      this.#unsent -= next.bytes;
      this.#offer(evaluation, listener, next);
    }
    this.#catchUp();
    QuerySubscriptions.#forgetDelivered(evaluation);
  }

  /**
   * Gives every subscription behind the connection's bound its latest
   * result, now the page took something: the one kept, if another
   * subscription still waits for it, or a fresh read, once a result as
   * large as the one dropped would fit: a read whose answer would only be
   * dropped again isn't worth the person's live reads.
   */
  #catchUp(): void {
    for (const evaluation of this.#evaluations.values()) {
      for (const listener of evaluation.listeners) {
        if (!listener.behind || listener.inFlight) {
          continue;
        }
        if (evaluation.latest === undefined) {
          const fits =
            this.#unsent === 0 ||
            this.#unsent + listener.behindBytes <=
              querySubscriptionLimits.unsentBytes;
          if (fits) {
            this.#enqueue(evaluation, true);
          }
        } else {
          this.#offer(evaluation, listener, evaluation.latest);
        }
      }
    }
  }

  /**
   * Closes `evaluation` and lets go of its subscriptions at once, before
   * anything is awaited: nothing queued for them goes out after this.
   * Answers the subscriptions' callbacks, still to be disposed of.
   */
  #close(evaluation: Evaluation): SnapshotCallback[] {
    evaluation.closed = true;
    evaluation.latest = undefined;
    if (this.#evaluations.get(evaluation.key) === evaluation) {
      this.#evaluations.delete(evaluation.key);
    }
    clearTimeout(evaluation.timer);
    clearTimeout(evaluation.liveness);
    const callbacks: SnapshotCallback[] = [];
    for (const listener of evaluation.listeners) {
      callbacks.push(this.#detach(listener));
    }
    evaluation.listeners.clear();
    return callbacks;
  }

  /** Marks `listener` released, dropping what waited for it. */
  #detach(listener: Listener): SnapshotCallback {
    listener.released = true;
    listener.behind = false;
    if (listener.pending !== undefined) {
      this.#unsent -= listener.pending.bytes;
      listener.pending = undefined;
    }
    this.#count -= 1;
    return listener.toPage;
  }

  /**
   * Ends `evaluation` with `result`, a refusal: pushed to every
   * subscription as its last, then each let go of.
   */
  async #end(evaluation: Evaluation, result: Result): Promise<void> {
    if (evaluation.closed) {
      return;
    }
    const callbacks = this.#close(evaluation);
    evaluation.revision += 1;
    const push: QuerySnapshotPush = { revision: evaluation.revision, result };
    // Not awaited: a page that never takes it holds no read's turn, and
    // its callback is let go of after `finalPushMs` anyway.
    for (const toPage of callbacks) {
      void QuerySubscriptions.#pushLast(toPage, push);
    }
    await this.#unwatch(evaluation);
  }

  /** Pushes `push` to `toPage`, then lets go of it, waiting `finalPushMs` at most. */
  static async #pushLast(
    toPage: SnapshotCallback,
    push: QuerySnapshotPush
  ): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<null>();
    const timer = setTimeout(() => {
      resolve(null);
    }, finalPushMs);
    const pushing = async (): Promise<void> => {
      try {
        await toPage(push);
      } catch {
        // Gone already.
      }
      resolve(null);
    };
    void pushing();
    try {
      await promise;
    } finally {
      clearTimeout(timer);
      toPage[Symbol.dispose]();
    }
  }

  /**
   * Stops `evaluation` without a word: it can't be kept fresh now. Its
   * subscriptions are let go of, which tells each screen to follow again.
   */
  async #lose(evaluation: Evaluation): Promise<void> {
    if (evaluation.closed) {
      return;
    }
    for (const toPage of this.#close(evaluation)) {
      toPage[Symbol.dispose]();
    }
    await this.#unwatch(evaluation);
  }

  /** Releases `listener`; the read goes once nobody follows it. */
  #release(evaluation: Evaluation, listener: Listener): void {
    if (listener.released) {
      return;
    }
    evaluation.listeners.delete(listener);
    this.#detach(listener)[Symbol.dispose]();
    if (evaluation.listeners.size === 0 && !evaluation.closed) {
      this.#close(evaluation);
      void this.#unwatch(evaluation);
    } else {
      QuerySubscriptions.#forgetDelivered(evaluation);
    }
    // What waited for it is dropped: room for those behind.
    this.#catchUp();
  }
}

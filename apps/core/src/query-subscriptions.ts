import type { AppId, StoreId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { OperationResult } from "@grasp-os/shared/operations";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  jsonBytes,
  querySubscriptionLimits,
  screenErrors,
  screenLimits,
} from "@grasp-os/shared/screens";
import type { QuerySnapshotPush } from "@grasp-os/shared/screens";

import { evaluateAppQuery, refusalOf } from "./app-functions.ts";
import { inJurisdiction } from "./durable-objects.ts";
import type { PageCallback } from "./page-callbacks.ts";
import { RunSubscription } from "./run-subscription.ts";
import { delivering } from "./screen-trust.ts";
import type { SessionCheck } from "./session-check.ts";

// Live queries (spec 11): what one page's connection to core (one browser
// tab) follows of its Apps' public queries, kept fresh by core. A screen
// asks to follow a query (`watchQuery`); core reads it as the person and
// pushes the result; the App's store tells core of every commit that
// changed a table the query read (store-watches.ts, from the store's
// outbox), and core reads it again and pushes the new result. The screen
// never asks again, and no App code subscribes or broadcasts.
//
// Delivery (spec 11.3): a query is read, then watched with the generation
// of each table it read, compared on the spot with the store's own, so a
// commit between the read and the watch is never missed; changes are
// gathered for `coalesceMs` and the query read once for all of them;
// each subscription's pushes are numbered, the screen dropping any older
// than what it shows. Threat model, and how each is closed:
//
// - A snapshot reaches someone who lost access: every read runs as the
//   person behind the connection's session now (`check`), through the
//   App's role check and the release's own authorization, inside the
//   build's trust check (`delivering`), and every push of data is made
//   only after the connection's access check (`stillOpen`: the person's
//   role and the build's trust, read again). A refusal of either is
//   pushed as the subscription's last result, which carries no data and
//   makes the screen drop what it holds, and the subscription ends.
// - A subscription outlives its session or the App's version: a session
//   that ended refuses the read (`check`) and ends it; a reference to a
//   version that is no longer current is refused (`version.*`) and ends
//   it, never read against another contract.
// - Results cross people: a connection is one session's, and one read is
//   shared only by subscriptions of the same App, build, person and
//   canonical request on it; nothing is shared across connections.
// - A snapshot can't be kept fresh: when the store can't be watched (its
//   object unreachable, or restarted since and the watch not made again)
//   nothing more is pushed, and core lets go of the screen's callbacks,
//   which tells the screen to follow again, from a fresh read; a lookup of
//   generations that fails blocks the push it was for.
// - Ordering and staleness after a reconnect: a new subscription starts
//   from a fresh read; the screen orders pushes by subscription and
//   revision, so an older connection's late push is dropped.
// - Fan-out cost: a connection follows at most `perConnection` queries
//   (`screen.too_many_queries`), a person `perPerson` of one App's store,
//   held by the store. A query is read at most once per `coalesceMs`
//   while changes come, never twice at once. What waits to be pushed is
//   at most one replacement per subscription and `unsentBytes` for the
//   whole connection: past that, results in between are dropped, and the
//   subscription gets the latest once the page takes what it has.
//   Following counts as a request of the person's (`admitted`, by the
//   caller); what core then pushes doesn't.

/** How long a read of a live query may take. */
const evaluationMs = 30_000;

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
}

/** One screen's subscription to a query. */
interface Listener {
  readonly toPage: PageCallback;
  /** The latest revision sent to it. */
  sent: number;
  inFlight: boolean;
  /** The one result waiting while one is in flight. */
  pending: Snapshot | undefined;
  /** Dropped results past the connection's bound: owed the latest. */
  behind: boolean;
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
  latest: Snapshot | undefined;
  /** Its watch in the store, once made. */
  watch: { readonly storeId: StoreId; readonly id: string } | undefined;
  /** What the store calls when what it read changed. */
  readonly watcher: ((tables: string[]) => void) & Disposable;
  timer: ReturnType<typeof setTimeout> | undefined;
  running: boolean;
  /** Changed again while it was read. */
  dirty: boolean;
  closed: boolean;
}

/** What the connection's access check says, before each push of data. */
export type AccessCheck = (
  by: Identity,
  app: AppId,
  artifact: string | undefined
) => Promise<"open" | "role" | "build">;

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

/** One connection's live queries. */
export class QuerySubscriptions {
  readonly #env: Env;
  readonly #check: SessionCheck;
  readonly #access: AccessCheck;
  readonly #evaluations = new Map<string, Evaluation>();
  /** Subscriptions not released. */
  #count = 0;
  /** Bytes of snapshots handed to the page and not yet taken. */
  #unsent = 0;

  constructor(env: Env, check: SessionCheck, access: AccessCheck) {
    this.#env = env;
    this.#check = check;
    this.#access = access;
  }

  /**
   * Follows the query `request` names of `app` for `by`, its results
   * pushed to `onSnapshot`, as the build `artifact` the connection
   * presented (see the header). The caller admitted the request and
   * checked the build's trust.
   */
  subscribe(
    by: Identity,
    app: AppId,
    artifact: string | undefined,
    request: string,
    onSnapshot: PageCallback
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
      released: false,
    };
    evaluation.listeners.add(listener);
    this.#count += 1;
    if (evaluation.latest !== undefined) {
      this.#offer(evaluation, listener, evaluation.latest);
    } else if (!evaluation.running && evaluation.timer === undefined) {
      void this.#evaluate(evaluation);
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
      watcher: Object.assign(
        (tables: string[]): void => {
          // Called with none to see whether it is still here.
          if (tables.length > 0) {
            this.#changed(evaluation);
          }
        },
        {
          [Symbol.dispose]: (): void => {
            // The store let go of it (its object restarted): what it read
            // is no longer watched, so read and watch it afresh.
            if (!evaluation.closed && evaluation.watch !== undefined) {
              evaluation.watch = undefined;
              this.#changed(evaluation);
            }
          },
        }
      ),
      timer: undefined,
      running: false,
      dirty: false,
      closed: false,
    };
    this.#evaluations.set(key, evaluation);
    return evaluation;
  }

  /** Something it read changed: read it again, gathered over `coalesceMs`. */
  #changed(evaluation: Evaluation): void {
    if (evaluation.closed) {
      return;
    }
    if (evaluation.running) {
      evaluation.dirty = true;
      return;
    }
    if (evaluation.timer !== undefined) {
      return;
    }
    evaluation.timer = setTimeout(() => {
      evaluation.timer = undefined;
      void this.#evaluate(evaluation);
    }, querySubscriptionLimits.coalesceMs);
  }

  /** Reads `evaluation`'s query, keeps it watched and pushes the result. */
  async #evaluate(evaluation: Evaluation): Promise<void> {
    if (evaluation.closed || evaluation.running) {
      return;
    }
    evaluation.running = true;
    evaluation.dirty = false;
    try {
      await this.#readAndPush(evaluation);
    } catch (error) {
      log.error("query.evaluation_failed", errorFields(error));
      await this.#lose(evaluation);
    } finally {
      evaluation.running = false;
      if (evaluation.dirty && !evaluation.closed) {
        this.#changed(evaluation);
      }
    }
  }

  async #readAndPush(evaluation: Evaluation): Promise<void> {
    const { app, artifact, request } = evaluation;
    let by: Identity;
    try {
      by = await this.#check();
    } catch (error) {
      await this.#end(evaluation, refusalResult(error));
      return;
    }
    let evaluated: Awaited<ReturnType<typeof evaluateAppQuery>>;
    try {
      evaluated = await delivering(
        this.#env,
        by,
        app,
        artifact,
        "watchQuery",
        async () =>
          await evaluateAppQuery(
            this.#env,
            by,
            app,
            request,
            Date.now() + evaluationMs
          )
      );
    } catch (error) {
      await this.#end(evaluation, refusalResult(error));
      return;
    }
    if (evaluation.closed) {
      return;
    }
    const { result } = evaluated.answer;
    if (!result.ok && endsSubscription(result.error.code)) {
      await this.#end(evaluation, result);
      return;
    }
    const { reads } = evaluated;
    if (reads === undefined) {
      // Nothing read that could be watched. A failure the host would
      // answer differently later is not pushed as though it were final:
      // the screen keeps what it shows and follows again.
      if (!result.ok && result.error.retryable) {
        await this.#lose(evaluation);
        return;
      }
      await this.#unwatch(evaluation);
    } else if (!(await this.#keepWatched(evaluation, by, reads))) {
      await this.#lose(evaluation);
      return;
    }
    // The person and the build, checked again before any data goes out.
    const access = await this.#access(by, app, artifact);
    if (access !== "open") {
      await this.#end(
        evaluation,
        refusalResult(
          access === "role"
            ? roleErrors.create("role.forbidden")
            : screenErrors.create("screen.revoked")
        )
      );
      return;
    }
    this.#publish(evaluation, result);
  }

  /**
   * Watches what `evaluation` read in its store, moving its watch on or
   * making it anew: false when the store can't be reached.
   */
  async #keepWatched(
    evaluation: Evaluation,
    by: Identity,
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
          return true;
        }
      } else if (watch !== undefined) {
        await this.#unwatch(evaluation);
      }
      const id = await storeOf(this.#env, storeId).watch(
        storeId,
        by.userId,
        readSet,
        evaluation.watcher
      );
      if (evaluation.closed) {
        await storeOf(this.#env, storeId).unwatch(id);
        return true;
      }
      evaluation.watch = { storeId, id };
      return true;
    } catch (error) {
      if (screenErrors.codeOf(error) === "screen.too_many_queries") {
        await this.#end(evaluation, refusalResult(error));
        return true;
      }
      log.warn("query.watch_failed", errorFields(error));
      evaluation.watch = undefined;
      return false;
    }
  }

  async #unwatch(evaluation: Evaluation): Promise<void> {
    const { watch } = evaluation;
    evaluation.watch = undefined;
    if (watch === undefined) {
      return;
    }
    try {
      await storeOf(this.#env, watch.storeId).unwatch(watch.id);
    } catch (error) {
      // The store drops it at its next telling, which fails.
      log.warn("query.unwatch_failed", errorFields(error));
    }
  }

  /** Numbers `result` and offers it to every subscription of `evaluation`. */
  #publish(evaluation: Evaluation, result: Result): void {
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
    const snapshot: Snapshot = { push, bytes };
    evaluation.latest = snapshot;
    for (const listener of evaluation.listeners) {
      this.#offer(evaluation, listener, snapshot);
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
      return;
    }
    listener.behind = false;
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
      await listener.toPage(snapshot.push);
    } catch {
      // The page is gone, or stopped following.
      this.#release(evaluation, listener);
    } finally {
      this.#unsent -= snapshot.bytes;
      listener.inFlight = false;
    }
    const next = listener.pending;
    if (next !== undefined) {
      listener.pending = undefined;
      this.#unsent -= next.bytes;
      this.#offer(evaluation, listener, next);
    }
    this.#catchUp();
  }

  /** Offers the latest result to every subscription owed it. */
  #catchUp(): void {
    for (const evaluation of this.#evaluations.values()) {
      for (const listener of evaluation.listeners) {
        if (
          listener.behind &&
          !listener.inFlight &&
          evaluation.latest !== undefined
        ) {
          this.#offer(evaluation, listener, evaluation.latest);
        }
      }
    }
  }

  /**
   * Ends `evaluation` with `result`, a refusal: pushed to every
   * subscription as its last, then each let go of.
   */
  async #end(evaluation: Evaluation, result: Result): Promise<void> {
    if (evaluation.closed) {
      return;
    }
    evaluation.closed = true;
    this.#evaluations.delete(evaluation.key);
    clearTimeout(evaluation.timer);
    await this.#unwatch(evaluation);
    evaluation.revision += 1;
    const push: QuerySnapshotPush = { revision: evaluation.revision, result };
    await Promise.all(
      [...evaluation.listeners].map(async (listener) => {
        try {
          await listener.toPage(push);
        } catch {
          // Gone already.
        }
        this.#release(evaluation, listener);
      })
    );
  }

  /**
   * Stops `evaluation` without a word: it can't be kept fresh. Its
   * subscriptions are let go of, which tells each screen to follow again.
   */
  async #lose(evaluation: Evaluation): Promise<void> {
    if (evaluation.closed) {
      return;
    }
    evaluation.closed = true;
    this.#evaluations.delete(evaluation.key);
    clearTimeout(evaluation.timer);
    await this.#unwatch(evaluation);
    for (const listener of evaluation.listeners) {
      this.#release(evaluation, listener);
    }
  }

  /** Releases `listener`; the read goes once nobody follows it. */
  #release(evaluation: Evaluation, listener: Listener): void {
    if (listener.released) {
      return;
    }
    listener.released = true;
    if (listener.pending !== undefined) {
      this.#unsent -= listener.pending.bytes;
      listener.pending = undefined;
    }
    evaluation.listeners.delete(listener);
    this.#count -= 1;
    listener.toPage[Symbol.dispose]();
    if (evaluation.listeners.size === 0 && !evaluation.closed) {
      evaluation.closed = true;
      this.#evaluations.delete(evaluation.key);
      clearTimeout(evaluation.timer);
      void this.#unwatch(evaluation);
    }
  }
}

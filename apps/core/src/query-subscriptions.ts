import { appErrors } from "@grasp-os/shared/apps";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import { canonicalJson, canonicalText, isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { OperationResult } from "@grasp-os/shared/operations";
import {
  jsonBytes,
  querySubscriptionLimits,
  pageErrors,
  pageLimits,
} from "@grasp-os/shared/pages";
import type { QuerySnapshotPush } from "@grasp-os/shared/pages";
import type { Identity } from "@grasp-os/shared/rpc";

import { operationRoles } from "./app-access.ts";
import {
  callsDecisionQuery,
  callsWorkflowQuery,
  evaluateAppQuery,
  refusalOf,
} from "./app-functions.ts";
import type { EvaluatedQuery } from "./app-functions.ts";
import { callDraftOn } from "./draft-runs.ts";
import { appHost, inJurisdiction } from "./durable-objects.ts";
import { delivering, leaseKey } from "./page-delivery.ts";
import type { PageLease } from "./page-delivery.ts";
import type { SessionCheck } from "./session-check.ts";
import { Subscription } from "./subscription.ts";

// Live queries (spec 11): what one page's connection to core (one browser
// tab) follows of its Apps' public queries, kept fresh by core. A page
// asks to follow a query (`watchQuery`); core reads it as the person and
// pushes the result; the App's store tells core of every write that
// changed a table the query read (store-watches.ts), and core reads it
// again and pushes the new result. The page never asks again, and no
// App code subscribes or broadcasts.
// A paginated list (`usePaginatedQuery`) follows each of its pages the
// same way, as a query of its own: a page's request carries its cursor
// and, once a page follows it, the cursor it ends at, so it keeps its
// bounds as records move in and out (store-queries.ts, `readPage`), and
// a write re-reads and pushes only the pages whose answer changed.
//
// Who a connection reads for, and how, is its `LiveReads`: a page's are
// the person behind its session, the App's current release and its
// business store (`pageReads`); an App test principal's are the
// fixture's, on the test's own store (app-tests.ts). Everything else
// here (ordering, gathering, watching, the gate before each push, the
// bounds and releasing) is the same for both: a test follows a query
// through exactly what a page follows it through.
//
// Delivery (spec 11.3): a query is read, then watched with the generation
// of each table it read, compared on the spot with the store's own, so a
// write between the read and the watch is never missed; changes are
// gathered for a while and the query read once for all of them; each
// subscription's pushes are numbered, the page dropping any older than
// what it shows. Threat model, and how each is closed:
//
// - A snapshot reaches someone who lost access: every read runs as the
//   person behind the connection's session now (`check`), through the
//   App's role check and the release's own authorization, inside the
//   build's trust check (`delivering`), and every push of data is made
//   only after the connection's access check (the person's role and the
//   build's trust, read again). A refusal of either is pushed as the
//   subscription's last result, which carries no data and makes the
//   page drop what it holds, and the subscription ends: its readers are
//   let go of before anything is awaited, so nothing that waited to be
//   pushed goes out after the refusal.
// - A snapshot stays on screen after access is lost, because nothing
//   commits to what it read (spec 11.4): every write that can take a role
//   in an App away, or its data from code (its data sensitive again, its
//   release revoked), tells the App's host once
//   it committed (access-revocations.ts), and the host tells every
//   connection of those people that follows the App (`#follow`), on every
//   tab and isolate.
//   The connection reads the session again now (`forget`), then passes
//   each of the App's queries through the gate: a refusal ends it as
//   above, clearing the page; roles that changed read it again. No
//   periodic recheck. How each way this can fail is closed:
//   - An event that names someone else, arrives twice or late, or that
//     anyone forged closes nothing: it only makes the connection look,
//     and its own session and the database decide. Only core reaches an
//     App's host, and the person a connection follows for is its
//     session's, never the page's word.
//   - An event missed while the host restarted: the host lets go of every
//     callback with it, and a connection let go of looks at once and
//     follows again, then looks once more, so an event sent in between
//     is found by that look. A connection that can't follow at all stops
//     its queries of the App, as when its store can't be watched.
//   - A query followed just before the event lands, or right after it on
//     a session read before it: nothing of the App is read on a
//     connection until it follows the App's revocations, and then the
//     session is read again, so a read either sees the change or is
//     followed when the event arrives.
// - A snapshot stays on screen after the store's rules narrow (a release
//   that tightens a table's access mode or row rules is made current,
//   for a workflow store too, which other people may read): no record is
//   written, but applying the change moves the generation of every table
//   whose rules changed (store-host.ts, `#applyIn`), so every query that
//   read one is read again, under the new rules, and drops the rows it no
//   longer may see.
// - A subscription outlives its session or the App's version: a session
//   that ended refuses the read (`check`) and ends it; every read is of
//   the App's current release, by the function's name (app-functions.ts,
//   `publicOperationOf`), so a page open across a publish reads the new
//   code, and one whose function is gone is refused, which ends it.
// - Results cross people or builds: a connection is one session's, and
//   one read is shared only by subscriptions of the same App, build,
//   person and canonical request on it; the build is the one the
//   subscribing frame's own lease names, never another frame's.
// - A push tells of a write the person can't see (a row their rules
//   hide): a read again whose result is the one shown, by the digest of
//   its canonical JSON, under the same roles, pushes nothing (`#publish`).
// - A snapshot can't be kept fresh: when the store can't be watched (its
//   object unreachable, restarted, or at its bound) nothing more is
//   pushed, and core lets go of the page's callbacks, which tells the
//   page to follow again, from a fresh read, later. A watch the store
//   lost without core hearing of it is found by a `rewatch` every
//   `livenessMs`.
// - Ordering and staleness after a reconnect: a new subscription starts
//   from a fresh read; the page orders pushes by subscription and
//   revision, so an older connection's late push is dropped.
// - Fan-out cost: a connection follows at most `perConnection` queries
//   (`page.too_many_queries`), the pages of one paginated list counting
//   as one, and at most `perPerson` subscriptions in all, every page
//   counted; a person follows `perPerson` of one App's store, held by
//   the store. So one list holds up to about `perPerson` pages, each kept
//   near its size by splitting (store-queries.ts, `readPage`). Reads a write causes are charged to the person's
//   `liveReads` budget of the App, held by the App's host across tabs;
//   past it a read waits and gathers every change meanwhile; each page a
//   paginated list follows is one live query, charged as one. A connection
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
 * How many reads of a live query in a row may find their reads torn by
 * writes landing while they read (`query.concurrent_change`) before core
 * lets go of it. Each is read again after a gathering window that doubles
 * with every torn read, so a writer making one write after another, each
 * landing while the last read was under way, is waited out rather than
 * dropped; only writes that keep landing past that let go of the query,
 * which the page then follows again.
 */
export const maxTornReads = 5;

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
  code === "page.unreviewed" ||
  code === "page.revoked";

/** A result as a push carries it: `{ ok, value }` or `{ ok, error }`. */
type Result = OperationResult;

/** A push made, and its size. */
interface Snapshot {
  readonly push: QuerySnapshotPush;
  readonly bytes: number;
  /** The roles it was read under (`rolesOf`): it goes out under those only. */
  readonly roles: string;
  /**
   * Where it stands among its evaluation's pushes (`Evaluation.revision`):
   * what each subscription is sent by, whatever revision the push names.
   */
  readonly seq: number;
}

/**
 * What a push showed, without the result itself, which a connection
 * needn't hold once every subscription has it: what a read again is
 * compared with, and numbered as when it found the same.
 */
interface Shown {
  readonly roles: string;
  readonly seq: number;
  /** The revision the push named. */
  readonly revision: number;
  /** The SHA-256 of the result read's canonical JSON (`digestOf`). */
  readonly digest: string;
  /** Whether it pushed the value read, not a refusal in its place. */
  readonly value: boolean;
}

/**
 * The roles `by` reads App `app`'s tables with (`operationRoles`), and
 * the teams a table's row rules read, as a key: what decides which
 * records a read sees, so a result read under one is never pushed under
 * another.
 */
const rolesOf = async (
  env: Env,
  by: Identity,
  app: AppId
): Promise<string | undefined> => {
  try {
    const { appMember, appBuilder, teams } = await operationRoles(env, by, app);
    return canonicalJson({ appMember, appBuilder, teams: teams.toSorted() });
  } catch (error) {
    // No answer (the database away for a moment): thrown, so the gate
    // refuses as one to try again, never as though the role were gone.
    if (!isExpectedError(error)) {
      throw error;
    }
    // No role in the App any more: no roles to push under.
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

/** One page's subscription to a query. */
interface Listener {
  readonly toPage: SnapshotCallback;
  /** The list it counts toward (`listKeyOf`). */
  readonly list: string;
  /** The latest of its evaluation's pushes sent to it (`Snapshot.seq`). */
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
  /** Told once it is let go of, however that happens. */
  readonly ended: (() => void) | undefined;
}

/** One query read for the subscriptions that share it. */
interface Evaluation {
  readonly key: string;
  readonly app: AppId;
  readonly build: PageLease | undefined;
  readonly request: string;
  readonly listeners: Set<Listener>;
  /** How many pushes it made: each push's `Snapshot.seq`. */
  revision: number;
  /**
   * The latest revision a value it read carried (`LiveRead.revision`), 0
   * before any: what a push of its names, refusals included, and what a
   * value read later is compared with. Kept apart from the count of its
   * pushes, so no refusal ever moves it.
   */
  carried: number;
  /**
   * What its latest push showed: a read again that finds the same result
   * under the same roles (or, for a value carrying its own revision, that
   * revision) only offers it again, to subscriptions that haven't had it
   * yet, never pushing it twice.
   */
  shown: Shown | undefined;
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
  /**
   * Whether it is a workflow reference's query, read again when the
   * person's runs of the App change (`#runsChanged`): it reads no store.
   */
  readonly followsRuns: boolean;
  /**
   * Whether it is a workflow reference's decision query, read again when
   * a decision of the App's runs changes (`#decisionsChanged`).
   */
  readonly followsDecisions: boolean;
  /** How long it waited for budget last, to wait longer next time. */
  budgetWaitMs: number;
  /** Reads in a row that writes tore (`maxTornReads`). */
  torn: number;
  closed: boolean;
  /** The roles its latest result was read under (`rolesOf`). */
  roles?: string;
}

/**
 * This connection's place among those an App's host tells of revocations
 * (`followAccess`): its ID there once the host answered, and the wait for
 * that answer, which every read of the App waits for first.
 */
interface Following {
  id: string | undefined;
  ready: Promise<void>;
  /** Let go of by the host before its answer was taken. */
  early: boolean;
}

/**
 * What the connection's access check says, before each push of data: open,
 * no role in the App (for a draft's, none that builds it), or the build
 * refused (`revoked`, `unreviewed`).
 */
export type AccessCheck<By = Identity> = (
  by: By,
  app: AppId,
  build: PageLease | undefined
) => Promise<"open" | "role" | "revoked" | "unreviewed">;

/** Whoever a connection's live queries are read for, by `userId`. */
export interface Reader {
  readonly userId: string;
}

/** What one read of a live query answered, and the store state it read. */
export interface LiveRead {
  readonly result: Result;
  readonly reads: EvaluatedQuery["reads"];
  /**
   * The revision its value carries, when it carries its own (a workflow
   * run's snapshot, page-workflows.ts): pushed under that revision, so a
   * control's receipt names the snapshot that settles it. Otherwise each
   * push is numbered after the last.
   */
  readonly revision?: number;
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
  /**
   * Whether a read a write caused may run now, within `by`'s budget of
   * live reads.
   */
  admit: (by: By, app: AppId) => Promise<boolean>;
  /**
   * Whether the connection follows each App's revocations (`#follow`):
   * a page's do, for the person behind its session; a test's fixtures
   * hold no role a write could take away.
   */
  readonly revocable: boolean;
  /** Drops the latest reading of who reads, so `check` reads now. */
  forget: () => void;
  /**
   * Reads the query `request` names as `by`, as `build`, by
   * `deadline`; a throw is a refusal that ends the subscription.
   */
  evaluate: (
    by: By,
    app: AppId,
    build: PageLease | undefined,
    request: string,
    deadline: number
  ) => Promise<LiveRead>;
}

/**
 * What a page's live query reads, as its lease names it (page-delivery.ts):
 * a builder's draft on its throwaway store (draft-runs.ts), or the App's
 * current release inside the build's trust check.
 */
const evaluatePage = async (
  env: Env,
  by: Identity,
  app: AppId,
  lease: PageLease | undefined,
  request: string,
  deadline: number
): Promise<EvaluatedQuery> => {
  if (lease?.kind === "draft") {
    let reads: EvaluatedQuery["reads"];
    const answer = await callDraftOn(
      env,
      by,
      { app, chatId: lease.chatId },
      request,
      {
        deadline,
        kind: "query",
        observeReads: (storeId, readSet) => {
          reads = { storeId: storeIdSchema.parse(storeId), readSet };
        },
      }
    );
    return { answer, reads };
  }
  return await delivering(
    env,
    by,
    app,
    lease?.build,
    "watchQuery",
    async () => await evaluateAppQuery(env, by, app, request, deadline)
  );
};

/**
 * A page's live reads: as the person behind the connection's session
 * (`check`), checked with `access` before each push, read from what the
 * frame's lease runs on (`evaluatePage`), and charged to the person's
 * live reads of the App.
 */
export const pageReads = (
  env: Env,
  check: SessionCheck,
  access: AccessCheck
): LiveReads<Identity> => ({
  check,
  access,
  roles: async (by, app) => await rolesOf(env, by, app),
  admit: async (by, app) => await appHost(env, app).admitLiveRead(by.userId),
  revocable: true,
  forget: () => {
    check.forget?.();
  },
  evaluate: async (by, app, build, request, deadline) => {
    const { answer, reads, revision } = await evaluatePage(
      env,
      by,
      app,
      build,
      request,
      deadline
    );
    return {
      result: answer.result,
      reads,
      ...(revision === undefined ? {} : { revision }),
    };
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
  build: PageLease | undefined,
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
  return canonicalJson([app, leaseKey(build), userId, call]);
};

/**
 * What a subscription counts toward the queries a connection follows:
 * its key (`keyOf`) without its arguments' `pagination`, so the pages of
 * one paginated list are one query.
 */
const listKeyOf = (
  app: AppId,
  build: PageLease | undefined,
  userId: string,
  request: string
): string => {
  let call: unknown = request;
  try {
    const parsed: unknown = JSON.parse(request);
    if (isRecord(parsed) && isRecord(parsed.input)) {
      const { pagination: _pagination, ...input } = parsed.input;
      call = { ...parsed, input };
    }
  } catch {
    // Keyed by its text, as `keyOf` keys it.
  }
  return keyOf(app, build, userId, JSON.stringify(call));
};

/** A refusal as a push carries it. */
const refusalResult = (error: unknown): Result => ({
  ok: false,
  error: refusalOf(error, crypto.randomUUID()),
});

/**
 * The push of `result` named `revision`, and its size: a refusal in its
 * place past the answer bound.
 */
const pushOf = (
  result: Result,
  revision: number
): { readonly push: QuerySnapshotPush; readonly bytes: number } => {
  const push: QuerySnapshotPush = { revision, result };
  const bytes = jsonBytes(push, pageLimits.answerBytes + 1);
  if (bytes <= pageLimits.answerBytes) {
    return { push, bytes };
  }
  const refusal: QuerySnapshotPush = {
    revision,
    result: refusalResult(pageErrors.create("page.answer_too_large")),
  };
  return { push: refusal, bytes: jsonBytes(refusal, pageLimits.answerBytes) };
};

/**
 * What a result is compared by with the one pushed last: equal results
 * have equal canonical JSON, so equal digests.
 */
const digestOf = async (result: Result): Promise<string> =>
  await sha256Hex(canonicalText(result));

/** Whether every subscription of `evaluation` has its latest result. */
const allHaveLatest = (evaluation: Evaluation): boolean =>
  [...evaluation.listeners].every(
    (listener) =>
      // One behind the connection's bound reads afresh once the page has
      // room (`#catchUp`), so nothing is kept for it meanwhile.
      listener.behind ||
      (listener.pending === undefined &&
        listener.sent >= (evaluation.latest?.seq ?? 0))
  );

/** One connection's live queries. */
/**
 * A callback of an App's that isn't a live query, as the connection looks
 * at it again (`QuerySubscriptions.follow`): `look` checks its access now,
 * `lose` lets go of it, when the App's revocations can't be followed;
 * `versioned`, if given, is told another version of the App was made
 * current.
 */
interface Look {
  readonly look: () => Promise<void>;
  readonly lose: () => void;
  readonly versioned?: () => Promise<void>;
}

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
  /** How many subscriptions each list it follows holds (`listKeyOf`). */
  readonly #lists = new Map<string, number>();
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

  /**
   * The roles the gate last saw the person read each followed App's
   * tables with (`#recheck`).
   */
  readonly #rolesSeen = new Map<AppId, string>();

  /** The Apps whose revocations this connection follows (`#follow`). */
  readonly #following = new Map<AppId, Following>();

  /**
   * The looks of the connection's other callbacks of each App (a server
   * call's, a run subscription's: `follow`), called whenever the person's
   * access to it may have dropped.
   */
  readonly #looks = new Map<AppId, Set<Look>>();

  /**
   * How many times the person's access to each App may have dropped
   * (`#revoked`): a read or push of the App that one landed during is
   * read again rather than pushed. Per App, so events for one App never
   * hold back another's.
   */
  readonly #revocations = new Map<AppId, number>();

  constructor(env: Env, reads: LiveReads<By>) {
    this.#env = env;
    this.#reads = reads;
  }

  /**
   * Follows the query `request` names of `app` for `by`, its results
   * pushed to `onSnapshot`, as the build `build` the subscribing
   * frame's lease names (see the header). The caller admitted the
   * request and checked the build's trust.
   */
  subscribe(
    by: By,
    app: AppId,
    build: PageLease | undefined,
    request: string,
    onSnapshot: SnapshotCallback,
    /**
     * Told once the subscription ends, released or ended by core (a
     * refusal, a store that can't be watched): what holds it for a frame
     * forgets it then (pages-rpc.ts).
     */
    ended?: () => void
  ): Subscription {
    // A paginated list's pages count as one query (`listKeyOf`), so a
    // long list isn't cut off by the queries a connection follows; every
    // page still counts toward the connection's subscriptions, as each
    // holds a watch of the person's in the store (`perPerson`).
    const list = listKeyOf(app, build, by.userId, request);
    if (
      this.#count >= querySubscriptionLimits.perPerson ||
      (!this.#lists.has(list) &&
        this.#lists.size >= querySubscriptionLimits.perConnection)
    ) {
      throw pageErrors.create("page.too_many_queries");
    }
    this.#lists.set(list, (this.#lists.get(list) ?? 0) + 1);
    const key = keyOf(app, build, by.userId, request);
    const evaluation =
      this.#evaluations.get(key) ?? this.#start(key, app, build, request);
    const listener: Listener = {
      toPage: onSnapshot.dup(),
      list,
      sent: 0,
      inFlight: false,
      pending: undefined,
      behind: false,
      behindBytes: 0,
      released: false,
      ended,
    };
    evaluation.listeners.add(listener);
    this.#count += 1;
    if (this.#reads.revocable && !this.#following.has(app)) {
      this.#follow(by.userId, app);
    }
    // Only a result read for another subscription that hasn't taken it
    // yet: never the carried value a watch last showed, which may have
    // aged since (a run's output past its retention, say), so a
    // subscription that has had nothing is answered by a read of its own.
    const kept = evaluation.latest;
    if (kept !== undefined) {
      // A result kept for another subscription that hasn't taken it yet
      // goes to this one too; otherwise a read on its way answers it, or a
      // fresh one, admitted as the person's request, so not charged.
      this.#offer(evaluation, listener, kept);
    } else if (
      !(evaluation.running || evaluation.queued) &&
      evaluation.timer === undefined
    ) {
      this.#enqueue(evaluation, false);
    }
    return new Subscription(async () => {
      this.#release(evaluation, listener);
      await Promise.resolve();
    });
  }

  #start(
    key: string,
    app: AppId,
    build: PageLease | undefined,
    request: string
  ): Evaluation {
    const evaluation: Evaluation = {
      key,
      app,
      build,
      request,
      listeners: new Set(),
      revision: 0,
      carried: 0,
      shown: undefined,
      latest: undefined,
      watch: undefined,
      timer: undefined,
      liveness: undefined,
      queued: false,
      running: false,
      dirty: false,
      charged: false,
      followsRuns: callsWorkflowQuery(request),
      followsDecisions: callsDecisionQuery(request),
      budgetWaitMs: 0,
      torn: 0,
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
    // Longer after each read writes tore, so writes still landing one
    // after another are over by the time it reads again.
    const windowMs = Math.min(
      querySubscriptionLimits.maxCoalesceMs,
      querySubscriptionLimits.coalesceMs *
        (1 + Math.floor(waiting / querySubscriptionLimits.concurrentReads)) *
        2 ** evaluation.torn
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
    const { app, build, request } = evaluation;
    // Nothing of the App is read before the connection follows its
    // revocations (see the header).
    await this.#followed(app);
    if (evaluation.closed) {
      return;
    }
    let by: By;
    try {
      by = await this.#reads.check();
    } catch (error) {
      await this.#end(evaluation, refusalResult(error));
      return;
    }
    if (evaluation.charged && !(await this.#reads.admit(by, app))) {
      this.#waitForBudget(evaluation);
      return;
    }
    // The roles it is read under, looked at first: the read sees records
    // by roles at least as new, and a result whose roles changed since is
    // read again rather than pushed (`#send`).
    const revocations = this.#revocations.get(app);
    const before = await this.#gate(evaluation);
    if ("refusal" in before) {
      await this.#end(evaluation, before.refusal);
      return;
    }
    let evaluated: LiveRead;
    try {
      // As the very reading the gate looked at, so the roles a result goes
      // out under are those of the person it was read for: a newer reading
      // (after a revocation, `#revoked`) is never paired with an older read.
      evaluated = await this.#reads.evaluate(
        before.by,
        app,
        build,
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
    if (QuerySubscriptions.#tornAgain(evaluation, result)) {
      return;
    }
    // A failure the host would answer differently later (the sandbox
    // busy or away, writes that kept tearing it) is not pushed as though
    // it were final, nor watched: what it read, if anything, isn't what an
    // answer would read. The page keeps what it shows and follows again.
    if (!result.ok && result.error.retryable) {
      await this.#lose(evaluation);
      return;
    }
    const { reads } = evaluated;
    if (reads === undefined) {
      // Nothing read that could be watched.
      await this.#unwatch(evaluation);
    } else if (!(await this.#keepWatched(evaluation, before.by, reads))) {
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
    if (
      after.roles !== before.roles ||
      this.#revocations.get(app) !== revocations
    ) {
      evaluation.dirty = true;
      return;
    }
    // Waited for the budget no more once a read went through.
    evaluation.budgetWaitMs = 0;
    this.#publish(
      evaluation,
      result,
      await digestOf(result),
      before.roles,
      evaluated.revision
    );
  }

  /**
   * Whether `evaluation` is read again for a read writes tore. Writes
   * landed while it read, each run of it (store-reader.ts): one writer's
   * writes one after another do that as surely as concurrent ones. Its
   * watch, if any, and what it pushed stay; it is read again once a
   * longer window has passed (`#changed`), and let go of only once
   * `maxTornReads` reads in a row were torn. A read writes didn't tear
   * (or tore once too often, and is let go of) makes the next torn read
   * the first in a row again.
   */
  static #tornAgain(evaluation: Evaluation, result: Result): boolean {
    if (
      !result.ok &&
      result.error.code === "query.concurrent_change" &&
      evaluation.torn + 1 < maxTornReads
    ) {
      evaluation.torn += 1;
      evaluation.dirty = true;
      return true;
    }
    evaluation.torn = 0;
    return false;
  }

  /**
   * Past the person's live-read budget: `evaluation` is read later,
   * gathering every change meanwhile, waiting longer each time it is
   * still spent. Its watch and what it pushed stay.
   */
  #waitForBudget(evaluation: Evaluation): void {
    evaluation.budgetWaitMs = Math.min(
      querySubscriptionLimits.liveReadWaitMs,
      Math.max(500, evaluation.budgetWaitMs * 2)
    );
    evaluation.timer = setTimeout(() => {
      evaluation.timer = undefined;
      this.#enqueue(evaluation, true);
    }, evaluation.budgetWaitMs);
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
  ): Promise<{ refusal: Result } | { roles: string; by: By }> {
    const { app, build } = evaluation;
    let by: By;
    try {
      by = await this.#reads.check();
    } catch (error) {
      return { refusal: refusalResult(error) };
    }
    const key = canonicalJson([app, leaseKey(build)]);
    const now = Date.now();
    let cached = this.#cleared.get(key);
    if (cached === undefined || cached.by !== by || cached.until <= now) {
      cached = {
        by,
        until: now + accessCacheMs,
        access: this.#reads.access(by, app, build),
        roles: this.#reads.roles(by, app),
      };
      this.#cleared.set(key, cached);
    }
    const [accessed, read] = await Promise.allSettled([
      cached.access,
      cached.roles,
    ]);
    // No answer of the roles or the access check (the database away for a
    // moment): refused as a failure to try again, which clears what the
    // page shows and has it follow again, never as a lost role, which
    // would sign the page out of the App for someone who still has it.
    const unanswered = [read, accessed].find(
      (settled): settled is PromiseRejectedResult =>
        settled.status === "rejected" && !isExpectedError(settled.reason)
    );
    if (unanswered !== undefined) {
      this.#cleared.delete(key);
      return { refusal: refusalResult(unanswered.reason) };
    }
    if (read.status === "rejected") {
      this.#cleared.delete(key);
      return {
        refusal: refusalResult(appErrors.create("app.not_found")),
      };
    }
    const access = accessed.status === "fulfilled" ? accessed.value : "role";
    const roles = access === "open" ? read.value : undefined;
    if (access === "open" && roles !== undefined) {
      this.#rolesSeen.set(app, roles);
      return { roles, by };
    }
    this.#cleared.delete(key);
    // A build refused is refused as such; anyone else (no role, or none
    // read by the time the access was) as a read refuses them: nothing of
    // the App disclosed.
    if (
      read.value !== undefined &&
      (access === "revoked" || access === "unreviewed")
    ) {
      return {
        refusal: refusalResult(pageErrors.create(`page.${access}`)),
      };
    }
    return {
      refusal: refusalResult(appErrors.create("app.not_found")),
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

  /**
   * Numbers `result` and offers it to every subscription of `evaluation`,
   * unless it shows that already.
   */
  #publish(
    evaluation: Evaluation,
    result: Result,
    /** `result`'s digest (`digestOf`). */
    digest: string,
    roles: string,
    /** The revision the value carries, if its own (`LiveRead.revision`). */
    carried?: number
  ): void {
    if (evaluation.closed) {
      return;
    }
    const { shown } = evaluation;
    // Only one read under the same roles: one read under others is never
    // pushed under these (`#send`). A value carrying its own revision is
    // the same by that revision, which a control's receipt names; any
    // other by its content, so a write that changed nothing the person
    // reads (a row their rules hide, say) pushes nothing, and so never
    // tells them the table was written.
    const same =
      shown !== undefined &&
      shown.roles === roles &&
      (carried !== undefined && result.ok
        ? carried === evaluation.carried && shown.value
        : shown.digest === digest);
    if (same) {
      // Nothing new, but whoever hasn't had it yet gets it: as the push
      // still held for one, or else as this read, numbered as shown.
      const held = evaluation.latest;
      const again: Snapshot =
        held?.seq === shown.seq
          ? held
          : {
              ...pushOf(result, shown.revision),
              roles,
              seq: shown.seq,
            };
      evaluation.latest = again;
      for (const listener of evaluation.listeners) {
        this.#offer(evaluation, listener, again);
      }
      QuerySubscriptions.#forgetDelivered(evaluation);
      return;
    }
    let named: number;
    if (carried !== undefined && result.ok) {
      if (carried < evaluation.carried) {
        // Older than one pushed already: a read overtaken by a newer one.
        return;
      }
      evaluation.carried = carried;
      named = carried;
    } else {
      // A refusal of one that carries revisions names the revision it
      // last showed (a refusal is heard whatever revision it names), so
      // the value read once it clears is shown again: never one past it.
      named =
        evaluation.carried > 0 ? evaluation.carried : evaluation.revision + 1;
    }
    evaluation.revision += 1;
    const { push, bytes } = pushOf(result, named);
    const snapshot: Snapshot = {
      push,
      bytes,
      roles,
      seq: evaluation.revision,
    };
    evaluation.latest = snapshot;
    evaluation.shown = {
      roles,
      seq: snapshot.seq,
      revision: named,
      digest,
      value: result.ok && push.result === result,
    };
    evaluation.roles = roles;
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
    if (listener.released || snapshot.seq <= listener.sent) {
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
    const sentBefore = listener.sent;
    listener.sent = snapshot.seq;
    this.#unsent += snapshot.bytes;
    try {
      // Every push of data passes the gate first, however long it waited.
      const revocations = this.#revocations.get(evaluation.app);
      const gate = await this.#gate(evaluation);
      if ("refusal" in gate) {
        void this.#end(evaluation, gate.refusal);
      } else if (
        gate.roles !== snapshot.roles ||
        this.#revocations.get(evaluation.app) !== revocations
      ) {
        // Read under roles the person no longer has, or passed by a gate
        // that looked before a revocation landed (`#revoked`): dropped,
        // and read again as they are now.
        if (evaluation.latest === snapshot) {
          evaluation.latest = undefined;
        }
        if (evaluation.shown?.seq === snapshot.seq) {
          evaluation.shown = undefined;
        }
        // Not sent: the read again may carry the same revision, and still
        // goes to it.
        listener.sent = sentBefore;
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
    if (!this.#follows(evaluation.app)) {
      this.#unfollow(evaluation.app);
    }
    return callbacks;
  }

  /**
   * Once the connection follows `app`'s revocations, or can't: waits for
   * whichever following is current when the last one answered, so a
   * following its host let go of early and replaced is waited out too.
   */
  async #followed(app: AppId): Promise<void> {
    for (;;) {
      const following = this.#following.get(app);
      if (following === undefined) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- until the current one answered
      await following.ready;
      if (this.#following.get(app) === following) {
        return;
      }
    }
  }

  /**
   * Whether the connection still follows a query of `app`, or holds
   * another callback of it (`follow`).
   */
  #follows(app: AppId): boolean {
    return (
      (this.#looks.get(app)?.size ?? 0) > 0 ||
      [...this.#evaluations.values()].some(
        (evaluation) => evaluation.app === app
      )
    );
  }

  /**
   * Has `look` called whenever `by`'s access to `app` may have dropped (a
   * role taken away, a build's trust taken back: access-revocations.ts),
   * as the connection's live queries of it are looked at again, until the
   * returned handle is let go of: for a callback of the App's that isn't a
   * live query (a server call's, a run subscription's), which checks its
   * own access in `look` and lets itself go when refused, so what it last
   * pushed doesn't stay on screen until its next push. When the App's
   * revocations can't be followed, `lose` lets go of it, as the App's
   * queries are then (`#lose`); its own check before each push stays.
   * `versioned`, if given, is called each time the App's host says another
   * of its versions was made current (`versionChanged`): a page following
   * the App's version (pages-rpc.ts, `watchVersion`). An event missed
   * while the host restarted is made up for by the look that follows.
   */
  follow(
    by: By,
    app: AppId,
    look: () => Promise<void>,
    lose: () => void,
    versioned?: () => Promise<void>
  ): Disposable {
    let looks = this.#looks.get(app);
    if (looks === undefined) {
      looks = new Set();
      this.#looks.set(app, looks);
    }
    const entry: Look = {
      look,
      lose,
      ...(versioned === undefined ? {} : { versioned }),
    };
    looks.add(entry);
    if (this.#reads.revocable && !this.#following.has(app)) {
      this.#follow(by.userId, app);
    }
    let held = true;
    return {
      [Symbol.dispose]: (): void => {
        if (!held) {
          return;
        }
        held = false;
        const current = this.#looks.get(app);
        current?.delete(entry);
        if (current?.size === 0) {
          this.#looks.delete(app);
        }
        if (!this.#follows(app)) {
          this.#unfollow(app);
        }
      },
    };
  }

  /**
   * Has `app`'s host tell this connection when `userId`'s role in it may
   * have dropped (`followAccess`), until the connection follows no query
   * of it (`#unfollow`). Once the host answered, looks once (`#revoked`):
   * whatever changed before it followed is seen by that look. Let go of
   * by the host (restarted), it looks at once and follows again; when it
   * can't follow, the App's queries stop, as when a store can't be
   * watched, and the pages follow again later.
   */
  #follow(
    userId: string,
    app: AppId,
    /**
     * Whether it follows again, after the host let go of it: a run change
     * the host had no connection to tell of meanwhile is made up for once
     * it follows (`#runsChanged`), as a revocation is by its look.
     */
    again = false
  ): void {
    const following: Following = {
      id: undefined,
      ready: Promise.resolve(),
      early: false,
    };
    this.#following.set(app, following);
    const current = (): boolean => this.#following.get(app) === following;
    // Let go of by the host: an event may have been missed, so look now,
    // and follow again while a query of the App is still followed here.
    const letGo = (): void => {
      this.#following.delete(app);
      this.#revoked(app);
      if (this.#follows(app)) {
        this.#follow(userId, app, true);
      }
    };
    const watcher = Object.assign(
      (
        revoked: boolean,
        runsChanged = false,
        versionChanged = false,
        decisionsChanged = false
      ): void => {
        // Once it no longer follows, it says it is gone, so the host drops
        // it even if core's word that it let go never arrived.
        if (!current()) {
          throw new Error("This App's revocations are no longer followed.");
        }
        if (revoked) {
          this.#revoked(app);
        }
        if (runsChanged) {
          this.#runsChanged(app);
        }
        if (versionChanged) {
          this.#versionChanged(app);
        }
        if (decisionsChanged) {
          this.#decisionsChanged(app);
        }
      },
      {
        [Symbol.dispose]: (): void => {
          if (!current()) {
            return;
          }
          if (following.id === undefined) {
            // Before the host's answer was taken: once it is (`answered`).
            following.early = true;
            return;
          }
          letGo();
        },
      }
    );
    const answered = async (): Promise<void> => {
      try {
        following.id = await appHost(this.#env, app).followAccess(
          userId,
          watcher
        );
      } catch (error) {
        log.warn("query.follow_access_failed", errorFields(error));
        if (current()) {
          this.#following.delete(app);
          // Its other callbacks too: let go of, so their pages follow
          // again later, and nothing stays on screen unwatched.
          // A Set iterates safely as each lets go of its own entry.
          for (const { lose } of this.#looks.get(app) ?? []) {
            lose();
          }
          await Promise.all(
            [...this.#evaluations.values()]
              .filter((evaluation) => evaluation.app === app)
              .map(async (evaluation) => {
                await this.#lose(evaluation);
              })
          );
        }
        return;
      }
      if (current() && following.early) {
        letGo();
      } else if (current()) {
        this.#revoked(app);
        if (again) {
          this.#runsChanged(app);
        }
      } else {
        await this.#leave(app, following.id);
      }
    };
    following.ready = answered();
  }

  /** Stops following `app`'s revocations: no query of it is followed. */
  #unfollow(app: AppId): void {
    const following = this.#following.get(app);
    this.#following.delete(app);
    // No read or push of the App is left to compare against it: a later
    // follow starts afresh, so a connection keeps nothing per App it left.
    this.#revocations.delete(app);
    this.#rolesSeen.delete(app);
    // Not answered yet: `#follow` leaves once it is.
    if (following?.id !== undefined) {
      void this.#leave(app, following.id);
    }
  }

  async #leave(app: AppId, id: string): Promise<void> {
    try {
      await appHost(this.#env, app).unfollowAccess(id);
    } catch (error) {
      // The host drops it at its next telling.
      log.warn("query.unfollow_access_failed", errorFields(error));
    }
  }

  /**
   * The person's role in `app` may have dropped: reads the session again
   * now, and passes each of the App's queries through the gate, ending
   * those it refuses (which clears their pages) and reading again those
   * whose roles changed. Changes nothing for someone whose access holds.
   */
  #revoked(app: AppId): void {
    this.#revocations.set(app, (this.#revocations.get(app) ?? 0) + 1);
    // Before any look below moves it on.
    const seen = this.#rolesSeen.get(app);
    this.#reads.forget();
    this.#cleared.clear();
    for (const evaluation of this.#evaluations.values()) {
      if (evaluation.app === app) {
        void this.#recheck(evaluation, seen);
      }
    }
    for (const { look } of this.#looks.get(app) ?? []) {
      void QuerySubscriptions.#lookAgain(look);
    }
  }

  /**
   * Another version of `app` was made current: each callback of it that
   * follows its version is told. Its live queries are left as they are:
   * each reads under its own reference, which decides (app-functions.ts).
   */
  #versionChanged(app: AppId): void {
    for (const { versioned } of this.#looks.get(app) ?? []) {
      if (versioned !== undefined) {
        void QuerySubscriptions.#lookAgain(versioned);
      }
    }
  }

  /** Calls `look`: a failure of it changes nothing for the others. */
  static async #lookAgain(look: () => Promise<void>): Promise<void> {
    try {
      await look();
    } catch (error) {
      log.warn("query.callback_look_failed", errorFields(error));
    }
  }

  /**
   * The person's independent runs `app` started changed (run-changes.ts):
   * each of the App's workflow queries followed here is read again, as a
   * write to a table it read would read it, gathered and charged alike.
   */
  #runsChanged(app: AppId): void {
    for (const evaluation of this.#evaluations.values()) {
      if (evaluation.app === app && evaluation.followsRuns) {
        this.#changed(evaluation);
      }
    }
  }

  /**
   * A decision of a run `app` started changed (run-changes.ts): each of
   * the App's decision queries followed here is read again, gathered and
   * charged as `#runsChanged`'s are.
   */
  #decisionsChanged(app: AppId): void {
    for (const evaluation of this.#evaluations.values()) {
      if (evaluation.app === app && evaluation.followsDecisions) {
        this.#changed(evaluation);
      }
    }
  }

  async #recheck(
    evaluation: Evaluation,
    seen: string | undefined
  ): Promise<void> {
    // The roles what it shows was read under, or for one that showed
    // nothing yet, those the connection last saw: the client may keep
    // results of the App read under them, which this tells it to drop.
    const before = evaluation.roles ?? seen;
    const gate = await this.#gate(evaluation);
    if ("refusal" in gate) {
      await this.#end(evaluation, gate.refusal);
    } else if (before !== undefined && gate.roles !== before) {
      // What its pages show was read under roles the person no longer
      // has: ended with a result that carries nothing, pushed as the last
      // however much waited (`#end`), so it clears the page whatever a
      // later read answers. It is no refusal of the person: the page
      // keeps following and follows again, from a read under their roles.
      await this.#end(
        evaluation,
        refusalResult(pageErrors.create("page.access_changed"))
      );
    } else if (evaluation.followsDecisions) {
      // Who answers a decision is also by team, which an access notice
      // may be about with the App role unchanged (leaving a decision's
      // team, say): its decision queries are read again, so a decision
      // the person may no longer answer goes from their inbox at once.
      this.#changed(evaluation);
    }
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
    const pages = (this.#lists.get(listener.list) ?? 1) - 1;
    if (pages > 0) {
      this.#lists.set(listener.list, pages);
    } else {
      this.#lists.delete(listener.list);
    }
    listener.ended?.();
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
   * subscriptions are let go of, which tells each page to follow again.
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

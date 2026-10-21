import { fileLimits } from "@grasp-os/shared/app-file-limits";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  actionMaxRunning,
  streamMaxRunning,
} from "@grasp-os/shared/operation-limits";
import {
  querySubscriptionLimits,
  screenErrors,
  screenLimits,
} from "@grasp-os/shared/screens";
import type {
  AppErrorLog,
  RunChange,
  ServerLog,
} from "@grasp-os/shared/screens";
import {
  statisticErrors,
  statisticLimitsOf,
} from "@grasp-os/shared/statistics";
import type { StatisticUse } from "@grasp-os/shared/statistics";
import { TokenBuckets } from "@grasp-os/shared/token-bucket";
import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";

import { ErrorLog } from "./app-error-log.ts";
import type { ReportedProblem } from "./app-error-log.ts";
import { auditedBatch, outboxed } from "./audit-outbox.ts";

// An App's host object: one per App, which every connection of every
// person to the App ends at, so what it counts can't be skipped by opening
// another. It keeps the App's restricted mode (restricted.ts), its error
// log and its rate buckets, follows its runs and revocations for open
// screens, and holds the places of its running invocations. No App code
// runs here: an App's functions run in isolates of their own, from its
// sealed release (app-functions.ts).

/**
 * The facet an App's v1 server code ran in, with a database of its own.
 * Nothing runs there since GRA-789: deleted once, on the object's first
 * start after (`#dropV1Server`).
 */
const v1ServerFacet = "server";

/** Where the object notes that `v1ServerFacet` is gone. */
const v1ServerDroppedKey = "v1-server-dropped";

/** How often, at most, the count of dropped reports is written to the log. */
const suppressedWriteMs = 60_000;
/** How often, at most, refused requests of an App's screens are logged. */
const refusalLogMs = 60_000;
/**
 * How often, at most, the same refusal of the App's data to a screen (who,
 * which build, why, what and where) is audited (`auditOnce`).
 */
const refusalAuditMs = 10 * 60_000;
/** How many refusals `auditOnce` remembers at most. */
const refusalsKept = 1000;
/** The one bucket all of an App's reports share, and its server lines. */
const appBucket = "app";
/**
 * The lines kept a minute of what an App's server code writes with
 * `console`, as many as of its screens' reports (`screenLimits.appReports`)
 * but counted apart from them (`logServer`).
 */
const serverLinesLimit = { burst: 200, perMinute: 200 } as const;
/** Where the App keeps its restricted mode (see restricted.ts). */
const restrictedKey = "restricted";
/**
 * A screen's callback for its App's run changes, as the host keeps it:
 * screens-rpc.ts wraps it, checking before each push that the person may
 * still use the App.
 */
export type RunWatcher = Rpc.Stub<(change: RunChange) => Promise<void>>;

/**
 * A connection's callback for the App's revocations (`followAccess`):
 * called with `true` when its person's role in the App may have dropped,
 * so it checks their access again now (query-subscriptions.ts), and with
 * `false` only to see that it is still there. Called with `false, true`
 * when the person's independent runs the App started changed
 * (`workflowRunsChanged`), so its workflow queries read again. It throws
 * once the connection no longer follows the App.
 */
export type AccessWatcher = Rpc.Stub<
  (revoked: boolean, runsChanged?: boolean) => void
>;

/**
 * Most connections of one person that follow the App's revocations at
 * once: one per open tab of the App's screens, so this only bounds what a
 * page that follows over and over keeps here.
 */
const accessFollowersPerPerson = 64;
/** Where the App's object keeps `userId`'s held places of one kind. */
const invocationHoldsKey = (userId: string, streaming: boolean): string =>
  `${streaming ? "stream" : "action"}-holds:${userId}`;

/**
 * One App's host object (see above): core reaches it through `appHost`;
 * no App code does.
 */
export class App extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#dropV1Server();
  }

  /**
   * Deletes the database of the facet the App's v1 server code ran in,
   * once: a hard cut, nothing of it released (GRA-789), so nothing reads
   * it. The note is written after, so a start that dies between deletes
   * again, which changes nothing. A cleanup never stops the App's host
   * object from starting: one that fails is logged, its note left unset,
   * and the next start tries again.
   */
  #dropV1Server(): void {
    const { kv } = this.ctx.storage;
    try {
      if (kv.get(v1ServerDroppedKey) === true) {
        return;
      }
      this.ctx.facets.delete(v1ServerFacet);
      kv.put(v1ServerDroppedKey, true);
    } catch (error) {
      log.error("app.v1_server_drop_failed", {
        objectId: this.ctx.id.toString(),
        ...errorFields(error),
      });
    }
  }

  /** Screens following the App's runs, by workflow and ID (`watchRuns`). */
  readonly #runWatchers = new Map<string, Map<string, RunWatcher>>();

  /** Connections following the App's revocations, by ID (`followAccess`). */
  readonly #accessFollowers = new Map<
    string,
    { readonly userId: string; readonly onRevoked: AccessWatcher }
  >();

  /** Statistics points the App recorded, and reads, in the current minute. */
  #statisticsMinute = { minute: 0, point: 0, read: 0 };

  /** The minute a read refused past its bounds was last audited. */
  #limitedAuditMinute = -1;

  // What the App's screens may ask and report, counted here because every
  // connection of every person to this App ends at this one object: a
  // count the page or one connection kept is skipped by opening another.
  // Kept in memory: a restart of this object starts the buckets full,
  // which an idle App's are anyway.

  /** Each person's requests of the App's screens. */
  readonly #requests = new TokenBuckets(screenLimits.requests);

  /**
   * Each person's reads of their live queries that writes caused
   * (`querySubscriptionLimits.liveReads`, query-subscriptions.ts).
   */
  readonly #liveReads = new TokenBuckets(querySubscriptionLimits.liveReads);

  /**
   * Each person's chunk requests of the App's files: a budget of their
   * own (an upload is many chunks), charged before a chunk costs anything.
   */
  readonly #chunks = new TokenBuckets(fileLimits.chunkRequests);

  /** Chunks refused since the last line logged of them, and when that was. */
  #refusedChunks = { chunks: 0, loggedAt: 0 };

  /** The reports kept of each person's screens, and of all of them. */
  readonly #callerReports = new TokenBuckets(screenLimits.callerReports);
  readonly #appReports = new TokenBuckets(screenLimits.appReports);

  /**
   * The lines kept of what the App's server code writes with `console`:
   * a budget apart from its screens' reports, so server code that logs
   * a lot never crowds out a problem a screen reports.
   */
  readonly #serverLines = new TokenBuckets(serverLinesLimit);

  /** The App's error log, in this object's own storage. */
  readonly #errorLog = new ErrorLog(this.ctx.storage);

  /** Reports dropped unread and not yet in the log's count, and when it was last written. */
  readonly #suppressed = { writtenAt: 0, writing: false };

  /** Requests refused since the last line logged of them, and when that was. */
  #refused = { requests: 0, loggedAt: 0 };

  /** When each refusal of a screen was last audited, oldest first (`auditOnce`). */
  readonly #refusalsAudited = new Map<string, number>();

  /** The refusals whose rows are being written now (`auditOnce`). */
  readonly #refusalsWriting = new Map<string, Promise<void>>();

  get #app(): AppId {
    return appIdSchema.parse(this.ctx.id.name);
  }

  /** Whether the App has read restricted data. */
  async isRestricted(): Promise<boolean> {
    return (await this.ctx.storage.get(restrictedKey)) === true;
  }

  /** Puts the App in restricted mode, for good. */
  async restrict(): Promise<void> {
    await this.ctx.storage.put(restrictedKey, true);
  }

  /**
   * Audits what `refusal` names, with `entry`: a screen's refusal of the
   * App's data (who, which build, why, what and where), or a person's use
   * of the App from a portable host (app-function-route.ts); unless it was
   * audited within `refusalAuditMs`, so a screen opened over and over, or
   * a page retrying, adds a row a window, not one a try. The check and the
   * write are one operation per refusal here: the same refusal arriving
   * while its row is being written waits for that write instead of
   * writing its own. It counts as audited only once the row is written;
   * a write that fails fails each that waited on it, and the next refusal
   * writes again. Kept in memory, so a restart of this object audits each
   * once more; past `refusalsKept`, the oldest are forgotten first, which
   * only audits them again.
   */
  async auditOnce(refusal: string, entry: AuditEntry): Promise<void> {
    const audited = this.#refusalsAudited.get(refusal);
    if (audited !== undefined && Date.now() - audited < refusalAuditMs) {
      return;
    }
    const writing = this.#refusalsWriting.get(refusal);
    if (writing !== undefined) {
      await writing;
      return;
    }
    const write = this.#writeRefusal(refusal, entry);
    this.#refusalsWriting.set(refusal, write);
    try {
      await write;
    } finally {
      this.#refusalsWriting.delete(refusal);
    }
  }

  /** Writes `refusal`'s row, then notes it audited. */
  async #writeRefusal(refusal: string, entry: AuditEntry): Promise<void> {
    const db = drizzle(this.env.DB);
    await auditedBatch(this.env, db, [outboxed(db, entry)]);
    this.#refusalsAudited.delete(refusal);
    this.#refusalsAudited.set(refusal, Date.now());
    for (const [oldest] of this.#refusalsAudited) {
      if (this.#refusalsAudited.size <= refusalsKept) {
        break;
      }
      this.#refusalsAudited.delete(oldest);
    }
  }

  /**
   * Whether core may read one more of `userId`'s live queries of the App
   * now because a write changed what it read
   * (`querySubscriptionLimits.liveReads`), at `cost` reads: a paginated
   * list's window costs one per page it reads (query-windows.ts), never
   * more than the burst. One that may not waits.
   */
  admitLiveRead(userId: string, cost = 1): boolean {
    return this.#liveReads.take(userId, Date.now(), cost);
  }

  /**
   * Whether `userId` may start the action invocation `name` now, which
   * runs until `until` at most: holds a place for it if so. A person runs
   * at most `streamMaxRunning` streaming actions and `actionMaxRunning`
   * plain ones at once in the App, each kind counted apart. A hold past
   * its time no longer counts, so a run whose end was never told frees its
   * place by its deadline. Stored, not only in memory: a restart of this
   * object while invocations run (each in an object of its own) must not
   * give their places back.
   */
  holdInvocation(
    userId: string,
    name: string,
    until: number,
    streaming: boolean
  ): boolean {
    const now = Date.now();
    const key = invocationHoldsKey(userId, streaming);
    const held = Object.entries(this.#invocationHolds(key)).filter(
      ([, end]) => end > now
    );
    const most = streaming ? streamMaxRunning : actionMaxRunning;
    if (!held.some(([running]) => running === name) && held.length >= most) {
      return false;
    }
    this.ctx.storage.kv.put(key, {
      ...Object.fromEntries(held),
      [name]: until,
    });
    return true;
  }

  /** Frees `userId`'s place for the invocation `name`, which has ended. */
  releaseInvocation(userId: string, name: string, streaming: boolean): void {
    const now = Date.now();
    const key = invocationHoldsKey(userId, streaming);
    const held = Object.entries(this.#invocationHolds(key)).filter(
      ([running, end]) => running !== name && end > now
    );
    if (held.length === 0) {
      this.ctx.storage.kv.delete(key);
      return;
    }
    this.ctx.storage.kv.put(key, Object.fromEntries(held));
  }

  /** The places held under `key`, by invocation name, each until when. */
  #invocationHolds(key: string): Readonly<Record<string, number>> {
    return this.ctx.storage.kv.get<Record<string, number>>(key) ?? {};
  }

  /**
   * Whether `userId`'s screen may ask the App one more thing now
   * (`screenLimits.requests`), at `count` requests: a paginated list's
   * window counts one per page it reads (query-windows.ts), never more
   * than the burst. Asked before the request is read, so one that is
   * refused or malformed counts too.
   */
  admitRequest(userId: string, count = 1): boolean {
    const now = Date.now();
    const admitted = this.#requests.take(userId, now, count);
    if (!admitted) {
      this.#refused.requests += 1;
      // One line a minute for whoever audits it, not one a request.
      if (now - this.#refused.loggedAt >= refusalLogMs) {
        log.warn("screen.requests_limited", {
          appId: this.#app,
          refused: this.#refused.requests,
        });
        this.#refused = { requests: 0, loggedAt: now };
      }
    }
    return admitted;
  }

  /**
   * Whether `userId`'s screen may send one more chunk of a file now
   * (`fileLimits.chunkRequests`): asked before the chunk is read or
   * anything is looked up, so a refused, duplicate or malformed chunk
   * counts too. Refusals reach the log at most once a minute.
   */
  admitChunk(userId: string): boolean {
    const now = Date.now();
    const admitted = this.#chunks.take(userId, now);
    if (!admitted) {
      this.#refusedChunks.chunks += 1;
      if (now - this.#refusedChunks.loggedAt >= refusalLogMs) {
        log.warn("app_file.chunks_limited", {
          appId: this.#app,
          refused: this.#refusedChunks.chunks,
        });
        this.#refusedChunks = { chunks: 0, loggedAt: now };
      }
    }
    return admitted;
  }

  /**
   * Whether one more report of `userId`'s screen is kept now: within what
   * one person's screens may report, and all of the App's together. One
   * that isn't is only counted. The count reaches the log at once the
   * first time and at most once a minute after, so a flood of reports
   * writes one number, not a record each.
   */
  async admitReport(userId: string): Promise<boolean> {
    const now = Date.now();
    // Asked of the App's bucket first, taken from it last: a report the
    // App has no room for must not use up the person's own.
    const admitted =
      this.#appReports.has(appBucket, now) &&
      this.#callerReports.take(userId, now) &&
      this.#appReports.take(appBucket, now);
    if (!admitted) {
      await this.#dropReport(now);
    }
    return admitted;
  }

  /**
   * Counts one report as dropped unread: written to the log at once the
   * first time, and at most once a minute after.
   */
  async #dropReport(now: number): Promise<void> {
    this.#errorLog.suppress();
    if (
      !this.#suppressed.writing &&
      now - this.#suppressed.writtenAt >= suppressedWriteMs
    ) {
      await this.#writeSuppressed(now);
    }
  }

  /**
   * Writes the count of dropped reports to the log. The time of the write
   * moves on only once the log has it: after one that fails, the next
   * dropped report tries again.
   */
  async #writeSuppressed(now: number): Promise<void> {
    this.#suppressed.writing = true;
    try {
      const reports = await this.#errorLog.writeSuppressed();
      this.#suppressed.writtenAt = now;
      // One line for the operator too, as often as the number is written.
      if (reports > 0) {
        log.warn("screen.reports_suppressed", { appId: this.#app, reports });
      }
    } finally {
      this.#suppressed.writing = false;
    }
  }

  /** Adds an admitted report to the App's error log (app-error-log.ts). */
  async logError(reported: ReportedProblem): Promise<void> {
    await this.#errorLog.add(reported);
  }

  /**
   * Adds what the App's server code at `version` wrote with `console` to
   * its error log, for its tail alone (server-logs.ts): each line within
   * what the App's server lines may use together (`serverLinesLimit`),
   * apart from its screens' reports, and only counted past it, so code
   * that logs in a loop writes no more, and suppresses no screen's report.
   */
  async logServer(version: number, logs: ServerLog[]): Promise<void> {
    for (const line of logs) {
      const now = Date.now();
      // oxlint-disable-next-line no-await-in-loop -- in order, each counted against the App's server lines
      await (this.#serverLines.take(appBucket, now)
        ? this.#errorLog.add({ ...line, source: "server", version })
        : this.#dropReport(now));
    }
  }

  /**
   * The App's error log, with every report dropped so far counted.
   * Reading it writes nothing: the count is written only as reports are
   * dropped, at most once a minute (`admitReport`).
   */
  async errors(): Promise<AppErrorLog> {
    return await this.#errorLog.read();
  }

  /**
   * Keeps `onChange`, a screen's callback, and calls it each time a run of
   * the App's workflow `workflow` changes (`runChanged`), until calling it
   * fails: the screen is gone, or the person may no longer use the App.
   * Kept here in memory, outside the App's code, so a restart of that code
   * keeps them; a restart of this object drops them, which tells each
   * screen to follow again. Returns the ID `unwatchRuns` drops it by.
   */
  watchRuns(workflow: string, onChange: RunWatcher): string {
    const id = crypto.randomUUID();
    const watchers =
      this.#runWatchers.get(workflow) ?? new Map<string, RunWatcher>();
    watchers.set(id, onChange.dup());
    this.#runWatchers.set(workflow, watchers);
    return id;
  }

  /** Drops the screen's callback `watchRuns` kept as `id`, if it still does. */
  unwatchRuns(workflow: string, id: string): void {
    this.#drop(workflow, id);
  }

  /**
   * Tells the screens following `workflow` that its run `run` changed, so
   * they read it again (workflows/run-changes.ts). Returns at once: each
   * push goes on by itself, and one that fails drops only its screen.
   */
  runChanged(workflow: string, run: string): void {
    for (const [id, watcher] of this.#runWatchers.get(workflow) ?? []) {
      void this.#tell(workflow, id, watcher, { run });
    }
  }

  async #tell(
    workflow: string,
    id: string,
    watcher: RunWatcher,
    change: RunChange
  ): Promise<void> {
    try {
      await watcher(change);
    } catch {
      this.#drop(workflow, id);
    }
  }

  #drop(workflow: string, id: string): void {
    const watchers = this.#runWatchers.get(workflow);
    const watcher = watchers?.get(id);
    watchers?.delete(id);
    if (watchers?.size === 0) {
      this.#runWatchers.delete(workflow);
    }
    watcher?.[Symbol.dispose]();
  }

  /**
   * Keeps `onRevoked`, the callback of a connection of `userId`'s that
   * follows the App's live queries, and calls it each time their role in
   * the App may have dropped (`accessRevoked`), until calling it fails.
   * Kept in memory, as `watchRuns` keeps its callbacks: a restart of this
   * object drops them, which tells each connection to check its access
   * and follow again, so an event sent meanwhile is never missed. Past
   * `accessFollowersPerPerson`, the person's connections that are gone
   * are let go of first; refused if that frees no place. Returns the ID
   * `unfollowAccess` drops it by.
   */
  async followAccess(
    userId: string,
    onRevoked: AccessWatcher
  ): Promise<string> {
    const held = onRevoked.dup();
    const theirs = (): [string, AccessWatcher][] =>
      [...this.#accessFollowers]
        .filter(([, follower]) => follower.userId === userId)
        .map(([id, follower]) => [id, follower.onRevoked]);
    if (theirs().length >= accessFollowersPerPerson) {
      await Promise.all(
        theirs().map(async ([id, watcher]) => {
          try {
            await watcher(false);
          } catch {
            this.#dropFollower(id);
          }
        })
      );
    }
    if (theirs().length >= accessFollowersPerPerson) {
      held[Symbol.dispose]();
      throw screenErrors.create("screen.too_many_queries");
    }
    const id = crypto.randomUUID();
    this.#accessFollowers.set(id, { userId, onRevoked: held });
    return id;
  }

  /** Drops the callback `followAccess` kept as `id`, if it still does. */
  unfollowAccess(id: string): void {
    this.#dropFollower(id);
  }

  /**
   * Tells the connections of `userIds` (of everyone, when `null`) that
   * follow the App's live queries that their role in it may have dropped
   * (access-revocations.ts): each checks again now, and clears what its
   * screens show if it has. Returns at once, with how many connections it
   * told; a connection that is gone is dropped.
   */
  accessRevoked(userIds: readonly string[] | null): number {
    let told = 0;
    for (const [id, { userId, onRevoked }] of this.#accessFollowers) {
      if (userIds === null || userIds.includes(userId)) {
        told += 1;
        void this.#tellRevoked(id, onRevoked);
      }
    }
    return told;
  }

  async #tellRevoked(id: string, onRevoked: AccessWatcher): Promise<void> {
    try {
      await onRevoked(true);
    } catch {
      this.#dropFollower(id);
    }
  }

  /**
   * Tells the connections of `userId` that follow the App's live queries
   * that their independent runs the App started changed (run-changes.ts,
   * `tellQueryFollowers`): each reads its workflow queries of the App
   * again, as its person. Returns at once, with how many connections it
   * told; a connection that is gone is dropped.
   */
  workflowRunsChanged(userId: string): number {
    let told = 0;
    for (const [id, follower] of this.#accessFollowers) {
      if (follower.userId === userId) {
        told += 1;
        void this.#tellRunsChanged(id, follower.onRevoked);
      }
    }
    return told;
  }

  /**
   * Tells every connection that follows the App's live queries that what
   * the App may start may have changed (a permission of the App granted or
   * revoked, permissions.ts): each reads its workflow queries and watches
   * of the App again, as its person, so a screen's `canRun` and
   * `canCancel` follow the grant (screen-workflows.ts). Returns at once,
   * with how many connections it told.
   */
  workflowPolicyChanged(): number {
    for (const [id, follower] of this.#accessFollowers) {
      void this.#tellRunsChanged(id, follower.onRevoked);
    }
    return this.#accessFollowers.size;
  }

  async #tellRunsChanged(id: string, onRevoked: AccessWatcher): Promise<void> {
    try {
      await onRevoked(false, true);
    } catch {
      this.#dropFollower(id);
    }
  }

  #dropFollower(id: string): void {
    const follower = this.#accessFollowers.get(id);
    this.#accessFollowers.delete(id);
    follower?.onRevoked[Symbol.dispose]();
  }

  /**
   * Counts one statistics `use` of a sealed function's statistics resource
   * (resource-statistics.ts) against the App's minute, all the App's
   * calls together. `statistics.rate_limited` past
   * it. Each call's own bound is core's (the invocation's counts).
   */
  claimStatisticMinute(use: StatisticUse): void {
    const minute = Math.floor(Date.now() / 60_000);
    if (this.#statisticsMinute.minute !== minute) {
      this.#statisticsMinute = { minute, point: 0, read: 0 };
    }
    const { perCall, perMinute } = statisticLimitsOf(
      use,
      use === "point"
        ? this.env.STATISTICS_POINT_LIMITS
        : this.env.STATISTICS_READ_LIMITS
    );
    if (this.#statisticsMinute[use] >= perMinute) {
      throw statisticErrors.create("statistics.rate_limited", {
        use,
        perCall,
        perMinute,
      });
    }
    this.#statisticsMinute[use] += 1;
  }

  /**
   * Whether a sealed function's platform read refused past its bounds is
   * the App's first in this minute, the one audited, so a loop can't
   * flood the audit log.
   */
  limitedReadAuditDue(): boolean {
    const minute = Math.floor(Date.now() / 60_000);
    if (this.#limitedAuditMinute === minute) {
      return false;
    }
    this.#limitedAuditMinute = minute;
    return true;
  }
}

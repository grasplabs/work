import { actorOf } from "@grasp-os/shared/audit";
import { connectionErrors } from "@grasp-os/shared/connect";
import { isExpectedError } from "@grasp-os/shared/errors";
import {
  isHighPrivilegeScope,
  landscapeErrors,
  landscapeLimits,
  landscapeNewAppDays,
  landscapeRetentionDays,
} from "@grasp-os/shared/landscape";
import type {
  LandscapeApi,
  LandscapeAppSummary,
  LandscapeConnection,
  LandscapeGrant,
  LandscapePerson,
  LandscapeRead,
  LandscapeSignal,
  LandscapeSyncStatus,
} from "@grasp-os/shared/landscape";
import { errorFields, log } from "@grasp-os/shared/log";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import {
  and,
  eq,
  getTableColumns,
  inArray,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import {
  appendAuditEvent,
  outboxed,
  outboxedIfChanged,
} from "./audit-outbox.ts";
import { signInConfig } from "./auth/config.ts";
import { onOrigin, personOf, tenantOf } from "./connections.ts";
import {
  accounts,
  landscapeAppPeople,
  landscapeApps,
  landscapeSyncs,
} from "./db/core/schema.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// The application landscape (GRA-539): the apps the organization's people
// granted access, read from its identity provider by connect
// (connect's src/landscape.ts) through a read-only admin connection, kept
// here, and served to the Landscape. Threat model, written first on
// GRA-539, and how each is closed here:
//
// - Another company's data: a read is kept only if its tenant is this
//   deployment's own, from its sign-in config; any other is refused and
//   the sync fails, and everything kept of that connection is deleted.
// - Planted names: an app's name and publisher are only data, shown as
//   text; an app is known by its client ID, and nothing here puts a name
//   in a prompt. A vendor is only a publisher the provider verified; an
//   unverified one's own word is kept apart (`unverified_publisher`).
// - Personal data: who granted an app is shown to admins only (members see
//   a count), never to Grasp staff, and every admin read of it is audited
//   first. A person's grant goes once it wasn't seen for
//   `landscapeRetentionDays`, and everything of a connection within 15
//   minutes of its disconnect (the next cron run).
// - Not read in phase 1: application permissions admins granted apps
//   (app role assignments), the most dangerous consents (GRA-900).
// - A flood: a sync makes at most `readsPerSync` reads, each bounded by
//   connect, `readsPerRun` per cron run, going on over later runs; one
//   that reaches its bound stops as partial, never loops, and what counts
//   as current stays the last whole sync's.
// - A sync stuck under way: one whose connection needs reconnecting, or
//   whose day passed while it was throttled or failing, ends as failed.
// - Replays and crashes: each page is written in one batch with the
//   cursor after it, and every row as seen at the sync's start, so a page
//   written again writes the same, and a sync that stopped goes on from
//   its last page. A batch guarded by the cursor it read can't be written
//   twice by two cron runs at once. A late write of an older sync changes
//   nothing: each upsert only moves a row forward.

const dayMs = 24 * 60 * 60_000;
/** Most IDs one query binds: D1 takes 100 bound parameters. */
const oidsPerQuery = 90;
/** How long a throttled sync waits when the provider doesn't say. */
const defaultRetryMs = 15 * 60_000;

type SyncRow = typeof landscapeSyncs.$inferSelect;
type Db = DrizzleD1Database & { $client: D1Database };

const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/** Each grant of a page, merged per app: its admin consent and its people. */
interface PageApp {
  app: LandscapeGrant["app"];
  adminScopes: string[] | null;
  people: Map<string, { name: string | null; scopes: string[] }>;
}

const appsOf = (grants: readonly LandscapeGrant[]): Map<string, PageApp> => {
  const apps = new Map<string, PageApp>();
  for (const { app, consent, person, scopes } of grants) {
    const entry: PageApp = apps.get(app.id) ?? {
      app,
      adminScopes: null,
      people: new Map<string, { name: string | null; scopes: string[] }>(),
    };
    apps.set(app.id, entry);
    if (consent === "admin" || person === null) {
      entry.adminScopes = [
        ...new Set([...(entry.adminScopes ?? []), ...scopes]),
      ];
    } else {
      const earlier = entry.people.get(person.id);
      entry.people.set(person.id, {
        name: person.name,
        scopes: [...new Set([...(earlier?.scopes ?? []), ...scopes])],
      });
    }
  }
  return apps;
};

/**
 * Scopes as an upsert keeps them: within one sync (`sameSync`), what
 * earlier pages saw and this one, so a later page's grant never drops an
 * earlier one's scopes, and a page written twice writes the same; in a new
 * sync, only what it sees, so a revoked scope goes. Bounded as one grant's.
 */
const sameSyncUnion = (sameSync: SQL, kept: SQL, seen: SQL): SQL =>
  sql`CASE WHEN ${sameSync} THEN (
    SELECT json_group_array(value) FROM (
      SELECT value FROM json_each(${kept})
      UNION SELECT value FROM json_each(${seen})
      LIMIT ${landscapeLimits.scopesPerGrant}
    )
  ) ELSE ${seen} END`;

/**
 * The statements that write one page of `sync`, as seen at its start:
 * each app and person upserted, never moved back in time.
 */
const pageWrites = (
  db: Db,
  sync: SyncRow,
  grants: readonly LandscapeGrant[]
): BatchItem<"sqlite">[] => {
  const seen = sync.startedAt;
  const writes: BatchItem<"sqlite">[] = [];
  for (const { app, adminScopes, people } of appsOf(grants).values()) {
    writes.push(
      db
        .insert(landscapeApps)
        .values({
          connectionId: sync.connectionId,
          appId: app.id,
          name: app.name,
          publisher: app.publisher,
          unverifiedPublisher: app.unverifiedPublisher,
          verified: app.verified,
          adminScopes,
          adminSeenAt: adminScopes === null ? null : seen,
          firstSeen: seen,
          lastSeen: seen,
        })
        .onConflictDoUpdate({
          target: [landscapeApps.connectionId, landscapeApps.appId],
          set: {
            name: app.name,
            publisher: app.publisher,
            unverifiedPublisher: app.unverifiedPublisher,
            verified: app.verified,
            lastSeen: sql`excluded.last_seen`,
            ...(adminScopes === null
              ? {}
              : {
                  adminScopes: sameSyncUnion(
                    sql`${landscapeApps.adminSeenAt} = excluded.admin_seen_at`,
                    sql`${landscapeApps.adminScopes}`,
                    sql`excluded.admin_scopes`
                  ),
                  adminSeenAt: sql`excluded.admin_seen_at`,
                }),
          },
          // A late write of an older sync changes nothing.
          setWhere: sql`excluded.last_seen >= ${landscapeApps.lastSeen}`,
        })
    );
    for (const [personId, { name, scopes }] of people) {
      writes.push(
        db
          .insert(landscapeAppPeople)
          .values({
            connectionId: sync.connectionId,
            appId: app.id,
            personId,
            name,
            scopes,
            firstSeen: seen,
            lastSeen: seen,
          })
          .onConflictDoUpdate({
            target: [
              landscapeAppPeople.connectionId,
              landscapeAppPeople.appId,
              landscapeAppPeople.personId,
            ],
            set: {
              name,
              scopes: sameSyncUnion(
                sql`${landscapeAppPeople.lastSeen} = excluded.last_seen`,
                sql`${landscapeAppPeople.scopes}`,
                sql`excluded.scopes`
              ),
              lastSeen: sql`excluded.last_seen`,
            },
            setWhere: sql`excluded.last_seen >= ${landscapeAppPeople.lastSeen}`,
          })
      );
    }
  }
  return writes;
};

/** The sync of `connection` to go on with now, started anew once a day. */
const syncToRun = async (
  db: Db,
  connection: LandscapeConnection,
  now: Date
): Promise<SyncRow | undefined> => {
  const current = await db
    .select()
    .from(landscapeSyncs)
    .where(eq(landscapeSyncs.connectionId, connection.id))
    .get();
  if (current?.state === "running") {
    return current.retryAt !== null && current.retryAt > now
      ? undefined
      : current;
  }
  const restart = {
    day: dayOf(now),
    startedAt: now,
    cursor: null,
    reads: 0,
    state: "running" as const,
    reason: null,
    retryAt: null,
    finishedAt: null,
  };
  const started: SyncRow = {
    ...restart,
    connectionId: connection.id,
    currentSince: current?.currentSince ?? null,
  };
  // Only one cron run starts it: the other finds it running. What counts
  // as current stays the last whole sync's until this one ends.
  const inserted = await db
    .insert(landscapeSyncs)
    .values(started)
    .onConflictDoUpdate({
      target: landscapeSyncs.connectionId,
      set: restart,
      setWhere: sql`${landscapeSyncs.state} <> 'running' AND ${landscapeSyncs.day} <> ${restart.day}`,
    })
    .run();
  return inserted.meta.changes > 0 ? started : undefined;
};

/** Ends `sync` as `state`, unless another run moved it on. */
const ended = (
  db: Db,
  sync: SyncRow,
  state: "failed",
  reason: string,
  now: Date
) =>
  db
    .update(landscapeSyncs)
    .set({ state, reason, finishedAt: now })
    .where(
      and(
        eq(landscapeSyncs.connectionId, sync.connectionId),
        eq(landscapeSyncs.startedAt, sync.startedAt),
        eq(landscapeSyncs.reads, sync.reads)
      )
    );

/** What one sync's audit event says: counts and its outcome, never a name. */
const syncedEntry = (sync: SyncRow, state: string, grants: number) => ({
  actor: { type: "system" as const },
  action: "landscape.synced",
  target: { type: "connection", id: sync.connectionId },
  detail: { state, reads: sync.reads + 1, grants },
});

/**
 * What a read that failed leaves of `sync`: a throttled one waits as the
 * provider says; one that can't go on fails; anything else is tried again
 * later the same day, and failed once its day is over, so a sync never
 * stays under way for good.
 */
const readFailed = async (
  db: Db,
  sync: SyncRow,
  error: unknown,
  now: Date
): Promise<void> => {
  const code = landscapeErrors.codeOf(error);
  if (code === "landscape.throttled") {
    const details = isExpectedError(error) ? error.details : undefined;
    const wait = z.number().safeParse(details?.retryAfterMs).data;
    const retryAt = new Date(now.getTime() + (wait ?? defaultRetryMs));
    // Waited for only within its day: past it, the sync ends, so the next
    // day's starts.
    if (dayOf(retryAt) === sync.day) {
      await db
        .update(landscapeSyncs)
        .set({ retryAt })
        .where(eq(landscapeSyncs.connectionId, sync.connectionId));
      return;
    }
    await ended(db, sync, "failed", code, now);
    return;
  }
  if (
    code === "landscape.not_found" ||
    code === "landscape.inactive" ||
    code === "landscape.cursor_invalid"
  ) {
    await ended(db, sync, "failed", code, now);
    return;
  }
  // Anything else may pass: tried again later the same day, and failed
  // once its day is over, so a sync never stays under way for good.
  log.warn("landscape.read_failed", {
    connectionId: sync.connectionId,
    ...errorFields(error),
  });
  if (sync.day !== dayOf(now)) {
    await ended(db, sync, "failed", code ?? "landscape.provider_failed", now);
    return;
  }
  await db
    .update(landscapeSyncs)
    .set({ retryAt: new Date(now.getTime() + defaultRetryMs) })
    .where(eq(landscapeSyncs.connectionId, sync.connectionId));
};

/**
 * Reads and writes one page of `sync`: false once it ended, or must wait.
 * The page and the cursor after it are written together, only if the
 * sync is still where it was read from.
 */
const readPage = async (
  env: Env,
  db: Db,
  sync: SyncRow,
  tenant: string | undefined,
  now: Date
): Promise<SyncRow | undefined> => {
  let read: LandscapeRead;
  try {
    read = await env.CONNECT.readLandscape({
      connectionId: sync.connectionId,
      cursor: sync.cursor,
    });
  } catch (error) {
    await readFailed(db, sync, error, now);
    return undefined;
  }
  // Another tenant's grants are never kept: the sync fails on them.
  // With no tenant configured, nothing can be checked: the sync fails and
  // keeps what it had, until the deployment says whose it is.
  if (tenant === undefined) {
    await db.batch([
      ended(db, sync, "failed", "landscape.tenant_unknown", now),
      outboxed(db, {
        ...syncedEntry(sync, "failed", 0),
        detail: { state: "failed", reason: "landscape.tenant_unknown" },
      }),
    ]);
    return undefined;
  }
  if (read.tenant.toLowerCase() !== tenant) {
    // Nothing of this connection is kept, from this sync or an earlier one.
    await db.batch([
      ended(db, sync, "failed", "landscape.tenant_mismatch", now),
      db
        .delete(landscapeAppPeople)
        .where(eq(landscapeAppPeople.connectionId, sync.connectionId)),
      db
        .delete(landscapeApps)
        .where(eq(landscapeApps.connectionId, sync.connectionId)),
      outboxed(db, {
        ...syncedEntry(sync, "failed", 0),
        detail: { state: "failed", reason: "landscape.tenant_mismatch" },
      }),
    ]);
    return undefined;
  }
  const reads = sync.reads + 1;
  const finished = read.next === null;
  const partial = !finished && reads >= landscapeLimits.readsPerSync;
  let state: "done" | "partial" | "running" = "running";
  if (finished) {
    state = "done";
  } else if (partial) {
    state = "partial";
  }
  const next: SyncRow = {
    ...sync,
    cursor: finished || partial ? null : read.next,
    reads,
    state,
    retryAt: null,
    finishedAt: state === "running" ? null : now,
    // Read whole: its rows are what is current from now on. One stopped
    // at its bound didn't read everything: the last whole one stays.
    currentSince: state === "done" ? sync.startedAt : sync.currentSince,
  };
  const moved = db
    .update(landscapeSyncs)
    .set({
      cursor: next.cursor,
      reads,
      state,
      retryAt: null,
      finishedAt: next.finishedAt,
      currentSince: next.currentSince,
    })
    .where(
      and(
        eq(landscapeSyncs.connectionId, sync.connectionId),
        eq(landscapeSyncs.startedAt, sync.startedAt),
        eq(landscapeSyncs.reads, sync.reads),
        eq(landscapeSyncs.state, "running")
      )
    );
  // The page's rows go with it. Written again by another cron run that
  // read the same page, even after a later page, they change nothing: each
  // row is as seen at the sync's start, and its scopes add to the sync's
  // (`sameSyncUnion`). The cursor moves on only once, and the sync's end
  // is recorded only by the run whose claim moved it, right after it.
  const done: BatchItem<"sqlite">[] =
    state === "running"
      ? []
      : [outboxedIfChanged(db, syncedEntry(sync, state, read.grants.length))];
  await db.batch([moved, ...done, ...pageWrites(db, sync, read.grants)]);
  return state === "running" ? next : undefined;
};

/** Goes on with `connection`'s sync for at most `readsPerRun` reads. */
const syncOne = async (
  env: Env,
  connection: LandscapeConnection,
  tenant: string | undefined,
  now: Date
): Promise<void> => {
  const db = drizzle(env.DB);
  if (connection.status !== "active") {
    // A sync under way ends: it can't go on until an admin reconnects.
    await db
      .update(landscapeSyncs)
      .set({ state: "failed", reason: "landscape.inactive", finishedAt: now })
      .where(
        and(
          eq(landscapeSyncs.connectionId, connection.id),
          eq(landscapeSyncs.state, "running")
        )
      );
    return;
  }
  let sync = await syncToRun(db, connection, now);
  for (let read = 0; read < landscapeLimits.readsPerRun; read += 1) {
    if (sync === undefined) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- each page goes on from the last
    sync = await readPage(env, db, sync, tenant, now);
  }
};

/**
 * Forgets what retention no longer keeps: every row of a connection no
 * longer connected, and grants and apps not seen for
 * `landscapeRetentionDays`.
 */
const forget = async (
  env: Env,
  connected: readonly string[],
  now: Date
): Promise<void> => {
  const db = drizzle(env.DB);
  const before = new Date(now.getTime() - landscapeRetentionDays * dayMs);
  const kept = [...connected];
  await db.batch([
    db
      .delete(landscapeAppPeople)
      .where(notInArray(landscapeAppPeople.connectionId, kept)),
    db
      .delete(landscapeApps)
      .where(notInArray(landscapeApps.connectionId, kept)),
    db
      .delete(landscapeSyncs)
      .where(notInArray(landscapeSyncs.connectionId, kept)),
    db
      .delete(landscapeAppPeople)
      .where(lt(landscapeAppPeople.lastSeen, before)),
    db.delete(landscapeApps).where(lt(landscapeApps.lastSeen, before)),
  ]);
};

/**
 * The landscape's sync, on the quarter-hour cron: each connection's grants
 * read once a day, a bounded number of pages a run, and what retention no
 * longer keeps forgotten.
 */
export const syncLandscapes = async (env: Env, now: Date): Promise<void> => {
  const listed = await env.CONNECT.landscapeConnections();
  await forget(
    env,
    listed.map(({ id }) => id),
    now
  );
  const config = signInConfig(env);
  const tenant =
    config === undefined
      ? undefined
      : tenantOf(config, "microsoft")?.toLowerCase();
  for (const connection of listed) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one connection after another, within the run's bound
      await syncOne(env, connection, tenant, now);
    } catch (error) {
      log.error("landscape.sync_failed", {
        connectionId: connection.id,
        ...errorFields(error),
      });
    }
  }
};

/**
 * When each connection's grants were last read whole: what counts as
 * current. A sync under way or failed leaves the last whole one's; before
 * any, everything read so far counts.
 */
const currentSince = async (db: Db): Promise<Map<string, Date>> => {
  const syncs = await db
    .select({
      connectionId: landscapeSyncs.connectionId,
      currentSince: landscapeSyncs.currentSince,
    })
    .from(landscapeSyncs);
  return new Map(
    syncs.map(({ connectionId, currentSince: since }) => [
      connectionId,
      since ?? new Date(0),
    ])
  );
};

/** What may need a look at an app, each a reason. */
const signalsOf = (
  app: typeof landscapeApps.$inferSelect,
  people: readonly (typeof landscapeAppPeople.$inferSelect)[],
  since: Date,
  now: Date
): LandscapeSignal[] => {
  const signals: LandscapeSignal[] = [];
  if (!app.verified) {
    signals.push("unverified_publisher");
  }
  if (people.some(({ scopes }) => scopes.some(isHighPrivilegeScope))) {
    signals.push("person_high_privilege");
  }
  if (app.firstSeen.getTime() > now.getTime() - landscapeNewAppDays * dayMs) {
    signals.push("new_app");
  }
  const adminConsented = app.adminSeenAt !== null && app.adminSeenAt >= since;
  if (people.length > 0 && !adminConsented) {
    signals.push("no_admin_consent");
  }
  return signals;
};

/** Every app of the landscape, with counts and signals. */
export const landscapeAppsOf = async (
  env: Env,
  now: Date
): Promise<LandscapeAppSummary[]> => {
  const db = drizzle(env.DB);
  const [apps, people, since] = await Promise.all([
    db.select().from(landscapeApps),
    // Only the grants current for their connection, chosen in SQL: the
    // ones retention keeps after they went aren't read at all.
    db
      .select(getTableColumns(landscapeAppPeople))
      .from(landscapeAppPeople)
      .leftJoin(
        landscapeSyncs,
        eq(landscapeSyncs.connectionId, landscapeAppPeople.connectionId)
      )
      .where(
        sql`${landscapeAppPeople.lastSeen} >= coalesce(${landscapeSyncs.currentSince}, 0)`
      ),
    currentSince(db),
  ]);
  // Each app's people, grouped once: every app reads only its own.
  const peopleOf = Map.groupBy(
    people,
    ({ connectionId, appId }) => `${connectionId} ${appId}`
  );
  return apps
    .map((app) => {
      const current = since.get(app.connectionId) ?? new Date(0);
      const grants = peopleOf.get(`${app.connectionId} ${app.appId}`) ?? [];
      const adminConsented =
        app.adminSeenAt !== null && app.adminSeenAt >= current;
      return {
        connectionId: app.connectionId,
        appId: app.appId,
        name: app.name,
        publisher: app.publisher,
        unverifiedPublisher: app.unverifiedPublisher,
        verified: app.verified,
        firstSeen: app.firstSeen.toISOString(),
        lastSeen: app.lastSeen.toISOString(),
        people: grants.length,
        adminConsented,
        scopes: [
          ...new Set([
            ...(adminConsented ? (app.adminScopes ?? []) : []),
            ...grants.flatMap(({ scopes }) => scopes),
          ]),
        ].slice(0, landscapeLimits.scopesPerGrant),
        signals: signalsOf(app, grants, current, now),
      };
    })
    .toSorted((one, other) => one.name.localeCompare(other.name));
};

const peopleRequestSchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
  appId: z.string().min(1).max(256),
});

const connectRequestSchema = z.strictObject({
  returnTo: z.string().default("/landscape"),
});

/** The application landscape over `/rpc`. */
export class LandscapeRpc extends CoreRpcTarget implements LandscapeApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async apps(): Promise<LandscapeAppSummary[]> {
    return await withPerson(
      this.#check,
      async () => await landscapeAppsOf(this.#env, new Date())
    );
  }

  async people(
    connectionId: string,
    appId: string
  ): Promise<LandscapePerson[]> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      // A client's people are the client's: not Grasp staff's to see.
      if (person.staff) {
        throw roleErrors.create("role.forbidden");
      }
      const request = landscapeErrors.parse(
        "landscape.invalid",
        peopleRequestSchema,
        {
          connectionId,
          appId,
        }
      );
      // Recorded before anything is read back.
      await appendAuditEvent(this.#env, {
        actor: actorOf(person),
        action: "landscape.people_viewed",
        target: { type: "connection", id: request.connectionId },
        detail: { app: request.appId },
      });
      const db = drizzle(this.#env.DB);
      const syncs = await currentSince(db);
      const since = syncs.get(request.connectionId) ?? new Date(0);
      const rows = await db
        .select()
        .from(landscapeAppPeople)
        .where(
          and(
            eq(landscapeAppPeople.connectionId, request.connectionId),
            eq(landscapeAppPeople.appId, request.appId)
          )
        );
      const current = rows.filter(({ lastSeen }) => lastSeen >= since);
      // A page of people at a time, within D1's bound parameters.
      const signIns: { userId: string; oid: string | null }[] = [];
      for (let start = 0; start < current.length; start += oidsPerQuery) {
        const page = current
          .slice(start, start + oidsPerQuery)
          .map(({ personId }) => personId);
        // oxlint-disable-next-line no-await-in-loop -- one bounded page after another
        const found = await db
          .select({ userId: accounts.userId, oid: accounts.oid })
          .from(accounts)
          .where(inArray(accounts.oid, page));
        signIns.push(...found);
      }
      const users = new Map(signIns.map(({ oid, userId }) => [oid, userId]));
      return current
        .map((row) => ({
          personId: row.personId,
          name: row.name,
          userId: users.get(row.personId) ?? null,
          scopes: row.scopes,
          firstSeen: row.firstSeen.toISOString(),
          lastSeen: row.lastSeen.toISOString(),
        }))
        .toSorted((one, other) =>
          (one.name ?? one.personId).localeCompare(other.name ?? other.personId)
        );
    });
  }

  async incomplete(): Promise<string[]> {
    return await withPerson(this.#check, async () => {
      const stopped = await drizzle(this.#env.DB)
        .select({ connectionId: landscapeSyncs.connectionId })
        .from(landscapeSyncs)
        .where(inArray(landscapeSyncs.state, ["partial", "failed"]));
      return stopped.map(({ connectionId }) => connectionId);
    });
  }

  async status(): Promise<LandscapeSyncStatus[]> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      const [listed, syncs] = await Promise.all([
        this.#env.CONNECT.landscapeConnections(),
        drizzle(this.#env.DB).select().from(landscapeSyncs),
      ]);
      return listed.map(({ id }) => {
        const sync = syncs.find(({ connectionId }) => connectionId === id);
        return {
          connectionId: id,
          state: sync?.state ?? null,
          reason: sync?.reason ?? null,
          startedAt: sync?.startedAt.toISOString() ?? null,
          finishedAt: sync?.finishedAt?.toISOString() ?? null,
          wholeAt: sync?.currentSince?.toISOString() ?? null,
        };
      });
    });
  }

  async connect(request: { returnTo?: string }): Promise<{ url: string }> {
    return await withPerson(this.#check, async (identity) => {
      requireAdmin(identity);
      const parsed = connectRequestSchema.safeParse(request);
      const config = signInConfig(this.#env);
      const tenant =
        config === undefined ? undefined : tenantOf(config, "microsoft");
      if (config === undefined || tenant === undefined) {
        throw connectionErrors.create("connection.provider_unavailable");
      }
      const back = parsed.success
        ? onOrigin(config.origin, parsed.data.returnTo)
        : undefined;
      if (back === undefined) {
        throw connectionErrors.create("connection.invalid");
      }
      return await this.#env.CONNECT.startConnection({
        person: await personOf(this.#env, identity),
        provider: "microsoft-landscape",
        scope: "shared",
        origin: config.origin,
        tenant,
        returnTo: `${back.pathname}${back.search}`,
      });
    });
  }
}

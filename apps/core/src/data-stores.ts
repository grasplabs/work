import type { RecordChangePage } from "@grasp-os/shared/app-data";
import type { App } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema, storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { ReadRequest } from "@grasp-os/shared/store-reads";
import { committedSchema, dataErrors } from "@grasp-os/shared/stores";
import type {
  ClaimInput,
  Claimed,
  Commit,
  Committed,
  StagedWrites,
  StoredRecord,
} from "@grasp-os/shared/stores";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { requireAppRole, requireNotArchived } from "./app-access.ts";
import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { appDefaultStores, apps, businessStores } from "./db/core/schema.ts";
import { inJurisdiction } from "./durable-objects.ts";
import type { FileReader } from "./file-host.ts";
import { requireNotStaff } from "./sharing.ts";
import { recordStoreDeleted, storeClosingMs } from "./store-deletion.ts";
import type { StoreDeletionMark } from "./store-deletion.ts";
import type {
  AppliedSchema,
  ImportApply,
  ImportBatch,
  MigrationBatch,
  MigrationRow,
  MigrationStart,
  ReadResult,
  SchemaApply,
  StoreReset,
  TableFacts,
} from "./store-host.ts";

// Each App's one store, as core finds it: `app_default_stores` keys it by
// the App, the inventory in core D1 (`business_stores`) says it exists,
// and its records live in its own Durable Object (data-store.ts), named by
// the store's ID. Core D1 never holds a store's records. A store's ID is
// minted here, at random, only as its App's store is created: it isn't an
// App's, a workflow's or a run's, and no request ever names one, so
// nothing reaches a store by guessing or passing an ID.
//
// What could widen access to an App's data by mistake, and how each is
// closed:
//
// - A store serving a second App, which would read what the first left
//   behind: a store ID enters `app_default_stores` only in the batch that
//   mints it (`appStoreFor`), and nothing else writes the column, so no
//   store ever belongs to two Apps. A seal binds only its own App's store,
//   read from that table (app-releases.ts); no request, manifest or
//   permission names a store, and the binding statement requires the
//   table to agree.
// - Another App or a workflow reaching the store: there is no grant, call
//   path or binding kind that names a store. Its records are reached only
//   through its own App's release, as its App's roles decide on each call.
// - Someone managing a store who doesn't build its App: its App's builders
//   manage it, as App roles decide it on each call (`requireAppRole`), the
//   organization's admins among them, never its creator as such. A store
//   is never shared on its own: whom it serves follows the App's
//   membership. Anyone else gets `data.store_unavailable`, as for a store
//   that doesn't exist. Grasp staff never delete a store: whether a
//   client's data is destroyed is the client's decision.
// - A removed App's store stuck: a removed App has no builders, so the
//   organization's own admins (never Grasp staff) read, change and delete
//   it (`managedBy`), so its records are never
//   stuck (erasure, GRA-335).
// - A store is deleted while something still relies on it: the store's
//   own object refuses (`data.store_in_use`) while any receipt not yet
//   expired refers to it, which an attempt in flight, a retry to come, a
//   live workflow run or an outbox entry still owed keeps. The check and
//   the deletion mark are one transaction in the object, so no claim lands
//   in between, and every call after the mark is refused there, whatever
//   core's inventory says.
// - A store is deleted under a sealed release that may still run on it (a
//   current or pending version, a rollback target, a pinned run, an open
//   page's lease): refused (`data.store_bound`) while any release its App
//   keeps is bound to it (`sdk_resource_bindings`, whose rows retention
//   deletes with their release), read in the statement that marks the
//   store closing, before its object is touched; a seal's binding in turn
//   requires the store live and not closing (app-releases.ts), so of the
//   two, one wins. Deleting an App never deletes its store; a deleted
//   store is replaced by a new one for the versions sealed after it.
// - A deletion stops half-way, or its records go unaudited: the object is
//   marked first, with who deleted it and when; then the inventory row and
//   the `store.deleted` event in one batch, which core runs at once and
//   the object's alarm runs again before it purges anything, until it
//   succeeds (store-deletion.ts). The event's ID and content come from
//   the mark alone, and only the batch that marks the row stores it, so it
//   is stored once whichever runs first; a store marked in its object is
//   refused even while its inventory row lags.
// - A deleted store comes back: its ID is never minted again (random), its
//   object keeps its deletion mark after purging its records, and its
//   inventory row keeps `deleted_at`.
// - A store of another deployment is reached: each deployment's core has
//   its own namespace of store objects, and IDs resolve only through the
//   inventory of the core that holds them.

/** A store, as core uses it: its ID bound to every call. */
export interface OpenStore {
  id: StoreId;
  /** Applies a version's schema to the store (`StoreHost.applySchema`). */
  applySchema: (change: SchemaApply) => Promise<AppliedSchema>;
  /** Starts staging a migration's output (`StoreHost.beginMigration`). */
  beginMigration: () => Promise<MigrationStart>;
  /** A page of a table's records, by its ID, for its migration (`StoreHost.migrationRows`). */
  migrationRows: (
    table: string,
    after: string | null
  ) => Promise<MigrationRow[]>;
  /** Stages a batch of a migration's output (`StoreHost.stageMigration`). */
  stageMigration: (batch: MigrationBatch) => Promise<void>;
  get: (table: string, id: string) => Promise<StoredRecord | null>;
  claim: (claim: Omit<ClaimInput, "storeId">) => Promise<Claimed>;
  commit: (commit: Omit<Commit, "storeId">) => Promise<Committed>;
  /**
   * One read for `scope`, which the caller resolved for the invocation
   * (`StoreHost.read`): never a scope App code supplied. With `staged`,
   * a mutation's writes not yet committed, the read sees them as their
   * commit would.
   */
  read: (
    scope: ReadScope,
    request: ReadRequest,
    staged?: StagedWrites
  ) => Promise<ReadResult>;
  /** The current generation of each of `tables` (`StoreHost.generations`). */
  generations: (tables: string[]) => Promise<Record<string, number>>;
  /** A page of a record's change history (`StoreHost.history`). */
  history: (
    scope: ReadScope,
    table: string,
    id: string,
    before: number | null
  ) => Promise<RecordChangePage>;
  /** One batch of an import's rows (`StoreHost.stageImport`). */
  stageImport: (batch: ImportBatch) => Promise<void>;
  /** Whether each table is sensitive, and its records (`StoreHost.tableFacts`). */
  tableFacts: () => Promise<Record<string, TableFacts>>;
  /** Lands an import's staged rows (`StoreHost.applyImport`). */
  applyImport: (landing: ImportApply) => Promise<{ inserted: number }>;
  /**
   * Checks `reader` may use each of `fileIds`, files of the store
   * (`FileHost.usable`).
   */
  filesUsable: (
    reader: FileReader,
    fileIds: string[],
    resources: string[]
  ) => Promise<void>;
}

/**
 * A read's result as the store's object answered it, as JSON text over
 * RPC (data-store.ts): its value as the store shaped it, and the
 * generations and the records it answered of each sensitive table, which
 * must be counts.
 */
const readResultSchema = z.strictObject({
  value: z.unknown(),
  generations: z.record(z.string(), z.number().int().min(0)),
  sensitive: z.record(z.string(), z.number().int().min(0)),
});

/** A claim's answer, as JSON text over RPC (data-store.ts). */
const claimedSchema = z.union([
  z.strictObject({
    held: z.strictObject({ receiptId: z.string(), fence: z.number().int() }),
    startedAt: z.number().int(),
    seed: z.string(),
  }),
  z.strictObject({ outcome: committedSchema, startedAt: z.number().int() }),
]);

const claimedOf = (answered: string): Claimed =>
  claimedSchema.parse(JSON.parse(answered));

/** A page of a record's history, as JSON text over RPC (data-store.ts). */
const historyOf = (answered: string): RecordChangePage => {
  const page: unknown = JSON.parse(answered);
  // SAFETY: the store's host shaped the page (`StoreHost.history`, read
  // with its own schemas, store-changes.ts), which JSON carries unchanged.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return page as RecordChangePage;
};

/** A page of a migration's rows, as JSON text over RPC (data-store.ts). */
const migrationRowsOf = (answered: string): MigrationRow[] => {
  const rows: unknown = JSON.parse(answered);
  // SAFETY: the store's host read them (`StoreHost.migrationRows`), each
  // record's fields with its own schema, which JSON carries unchanged.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return rows as MigrationRow[];
};

const readResultOf = (answered: string): ReadResult => {
  const { value, generations, sensitive } = readResultSchema.parse(
    JSON.parse(answered)
  );
  // SAFETY: the store's host shaped the value (`StoreHost.read`), a
  // `QueryAnswer` of JSON documents, which JSON carries unchanged.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return { value: value as ReadResult["value"], generations, sensitive };
};

/** The audit entry of a change to `store` by `by`: identifiers only. */
const storeEntry = (
  by: Acting,
  action: "store.created" | "store.delete_refused",
  store: StoreId,
  detail: AuditEntry["detail"] = {}
): AuditEntry => ({
  actor: by.actor ?? actorOf(by),
  action,
  target: { type: "store", id: store },
  detail,
});

/** App `app`'s store, as `app_default_stores` records it, and whether it lives. */
const recordedStoreOf = async (
  env: Env,
  app: AppId
): Promise<{ store: StoreId; live: boolean } | undefined> => {
  const row = await drizzle(env.DB)
    .select({
      store: appDefaultStores.storeId,
      listed: businessStores.id,
      deletedAt: businessStores.deletedAt,
    })
    .from(appDefaultStores)
    .leftJoin(businessStores, eq(businessStores.id, appDefaultStores.storeId))
    .where(eq(appDefaultStores.appId, app))
    .get();
  return row === undefined
    ? undefined
    : {
        store: storeIdSchema.parse(row.store),
        live: row.listed !== null && row.deletedAt === null,
      };
};

/** App `app`'s store, if it has one that lives; null otherwise. */
export const liveStoreOf = async (
  env: Env,
  app: AppId
): Promise<StoreId | null> => {
  const recorded = await recordedStoreOf(env, app);
  return recorded?.live === true ? recorded.store : null;
};

/**
 * App `app`'s store, created for `by` if it has none that lives: minted
 * here, keyed by the App and listed in the inventory in one batch, with
 * its audit event. A deleted store is replaced by a new one, in one
 * conditional statement, so of two creations at once one record wins and
 * both answer its store; the other's store is never listed, nor audited.
 * The versions sealed on a deleted store stay bound to it and are refused
 * as they are made current (`makeCurrent`): their data is gone, and a
 * fresh store isn't it. Its caller decides who may: only the App's
 * builders seal its versions (app-releases.ts).
 */
export const appStoreFor = async (
  env: Env,
  by: Acting,
  app: AppId
): Promise<StoreId> => {
  const existing = await recordedStoreOf(env, app);
  if (existing?.live === true) {
    return existing.store;
  }
  const id = storeIdSchema.parse(crypto.randomUUID());
  const now = new Date();
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    existing === undefined
      ? db
          .insert(appDefaultStores)
          .values({ appId: app, storeId: id, createdAt: now })
          .onConflictDoNothing({ target: appDefaultStores.appId })
      : db
          .update(appDefaultStores)
          .set({ storeId: id, createdAt: now })
          .where(
            and(
              eq(appDefaultStores.appId, app),
              eq(appDefaultStores.storeId, existing.store)
            )
          ),
    // Listed only while the App's record names it, so a store that lost
    // the race above is never listed: every store in the inventory is
    // exactly one App's.
    db.insert(businessStores).select(
      sql`SELECT ${id}, ${by.userId}, NULL, NULL, NULL, 1, 'data_store', ${now.getTime()}, NULL, NULL, NULL
        WHERE EXISTS (SELECT 1 FROM app_default_stores
          WHERE app_id = ${app} AND store_id = ${id})`
    ),
    outboxedIfChanged(db, storeEntry(by, "store.created", id, { app })),
  ]);
  const recorded = await recordedStoreOf(env, app);
  if (recorded?.live !== true) {
    throw new Error("The App's store wasn't recorded");
  }
  return recorded.store;
};

/**
 * Resets the data of App `app`'s store for `by` (`StoreHost.resetData`,
 * audited in the store's own transaction), applying `apply` to the empty
 * store in the same one: its store, if it has one that lives, or null.
 * Its caller decides who may.
 */
export const resetAppStore = async (
  env: Env,
  by: Acting,
  app: AppId,
  reset: Pick<StoreReset, "apply">
): Promise<StoreId | null> => {
  const store = await liveStoreOf(env, app);
  if (store === null) {
    return null;
  }
  await inJurisdiction(env, env.DATA_STORES)
    .getByName(store)
    .resetData(store, {
      ...reset,
      actor: by.actor ?? actorOf(by),
      app,
    });
  return store;
};

/** The App a store serves: whose roles decide who manages it. */
type StoreApp = Pick<App, "id" | "owner" | "status"> & {
  /** Whether the App was removed (app-removal.ts): its admins' alone then. */
  removed: boolean;
};

/**
 * The App whose store `id` is (`app_default_stores`), if it is one. A
 * store whose App row is gone is refused (`data.store_unavailable`).
 */
const storeApp = async (
  env: Env,
  id: StoreId
): Promise<StoreApp | undefined> => {
  const row = await drizzle(env.DB)
    .select({
      id: apps.id,
      owner: apps.ownerId,
      status: apps.status,
      removedAt: apps.removedAt,
    })
    .from(appDefaultStores)
    .leftJoin(apps, eq(apps.id, appDefaultStores.appId))
    .where(eq(appDefaultStores.storeId, id))
    .get();
  if (row === undefined) {
    return undefined;
  }
  if (row.id === null || row.owner === null || row.status === null) {
    throw dataErrors.create("data.store_unavailable");
  }
  return {
    id: appIdSchema.parse(row.id),
    owner: row.owner,
    status: row.status,
    removed: row.removedAt !== null,
  };
};

/**
 * The live store `id` if `by` manages it; otherwise `data.store_unavailable`,
 * as for a store that doesn't exist. A store is managed by whoever builds
 * its App, as its App roles decide it on this call (`requireAppRole`): the
 * organization's admins and the App's builders, never its creator as such;
 * an archived App's store is read-only. A removed App's store by the
 * organization's own admins alone. `by`'s role and teams are taken as
 * given: an identity read for this call, as for App roles.
 */
const managedBy = async (
  env: Env,
  by: Acting,
  id: string
): Promise<StoreId> => {
  const parsed = storeIdSchema.safeParse(id);
  if (!parsed.success) {
    throw dataErrors.create("data.store_unavailable");
  }
  const app = await storeApp(env, parsed.data);
  if (app === undefined) {
    throw dataErrors.create("data.store_unavailable");
  }
  if (app.removed) {
    if (!isMemberAdmin(by)) {
      throw dataErrors.create("data.store_unavailable");
    }
  } else {
    try {
      await requireAppRole(env, by, app, "builder");
    } catch (error) {
      if (isExpectedError(error)) {
        throw dataErrors.create("data.store_unavailable");
      }
      throw error;
    }
    requireNotArchived(app);
  }
  const row = await drizzle(env.DB)
    .select({ id: businessStores.id })
    .from(businessStores)
    .where(
      and(eq(businessStores.id, parsed.data), isNull(businessStores.deletedAt))
    )
    .get();
  if (row === undefined) {
    throw dataErrors.create("data.store_unavailable");
  }
  return parsed.data;
};

/**
 * That some sealed release is bound to store `id` (`sdk_resource_bindings`):
 * a retained version of its App, which may still run (as current or
 * pending, a rollback target, a pinned run or an open page's lease).
 * Retention deletes a release's bindings with it (release-retention.ts),
 * so a binding is there exactly while its release is kept.
 */
const boundSql = (id: StoreId): SQL =>
  sql`EXISTS (SELECT 1 FROM sdk_resource_bindings AS bound
    WHERE bound.kind = 'store' AND bound.target_id = ${id})`;

/**
 * Marks store `id` closing at `now` for the deletion `owner`, in one
 * statement that requires it live, bound to no sealed release, and not
 * closing for another deletion (unless that mark lapsed,
 * `storeClosingMs`): the mark a seal's binding (app-releases.ts) and
 * `makeCurrent` honour, so of this deletion and a seal that binds
 * the store, exactly one wins. True when this call holds the mark: only
 * then may it close the store.
 */
const markClosing = async (
  env: Env,
  id: StoreId,
  owner: string,
  now: Date
): Promise<boolean> => {
  const marked = await drizzle(env.DB)
    .update(businessStores)
    .set({ closingAt: now, closingOwner: owner })
    .where(
      and(
        eq(businessStores.id, id),
        isNull(businessStores.deletedAt),
        or(
          isNull(businessStores.closingAt),
          lte(
            businessStores.closingAt,
            new Date(now.getTime() - storeClosingMs)
          )
        ),
        sql`NOT ${boundSql(id)}`
      )
    )
    .returning({ owner: businessStores.closingOwner });
  return marked[0]?.owner === owner;
};

/** Whether some sealed release is bound to store `id`. */
const boundToRelease = async (env: Env, id: StoreId): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ one: sql`1` })
    .from(businessStores)
    .where(and(eq(businessStores.id, id), boundSql(id)))
    .get();
  return row !== undefined;
};

/**
 * Deletes store `id` for `by`, who must manage it and isn't Grasp staff:
 * marked closing first, by this deletion alone (`markClosing`), and
 * refused, and audited, while another deletion holds the mark
 * (`data.store_closing`), while any sealed release its App keeps is bound
 * to it (`data.store_bound`: its calls would fail with
 * `data.store_unavailable`), or while a receipt not yet expired refers to
 * it (`data.store_in_use`: the store's object decides, store-host.ts).
 * The object is marked deleted first, with `by` and the time; then the
 * inventory row and its event, which the object's alarm also ensures
 * before it purges anything, so they happen even if this call stops here.
 */
export const deleteStore = async (
  env: Env,
  by: Acting,
  id: string
): Promise<void> => {
  requireNotStaff(by);
  const store = await managedBy(env, by, id);
  const actor = by.actor ?? actorOf(by);
  // Marked closing first, by this deletion alone, before its object is
  // touched: refused while any sealed release binds it, or while
  // another deletion holds the mark (it alone closes the store, or clears
  // the mark if its close is refused).
  const owner = crypto.randomUUID();
  if (!(await markClosing(env, store, owner, new Date()))) {
    const reason = (await boundToRelease(env, store))
      ? "data.store_bound"
      : "data.store_closing";
    const db = drizzle(env.DB);
    await auditedBatch(env, db, [
      outboxed(db, storeEntry(by, "store.delete_refused", store, { reason })),
    ]);
    throw dataErrors.create(reason);
  }
  let mark: StoreDeletionMark;
  try {
    // Still this deletion's mark, not one taken over after it lapsed: the
    // window left is only a close already on its way.
    const held = await drizzle(env.DB)
      .select({ owner: businessStores.closingOwner })
      .from(businessStores)
      .where(eq(businessStores.id, store))
      .get();
    if (held?.owner !== owner) {
      throw dataErrors.create("data.store_closing");
    }
    mark = await inJurisdiction(env, env.DATA_STORES)
      .getByName(store)
      .close(store, actor);
  } catch (error) {
    // Not deleted after all: its versions may be made current again. Only
    // this deletion's own mark, never one another took over since.
    await drizzle(env.DB)
      .update(businessStores)
      .set({ closingAt: null, closingOwner: null })
      .where(
        and(
          eq(businessStores.id, store),
          eq(businessStores.closingOwner, owner)
        )
      );
    if (dataErrors.codeOf(error) === "data.store_in_use") {
      const db = drizzle(env.DB);
      await auditedBatch(env, db, [
        outboxed(
          db,
          storeEntry(by, "store.delete_refused", store, {
            reason: "data.store_in_use",
          })
        ),
      ]);
    }
    throw error;
  }
  // The mark's actor, not `by`: when deletions race, the one that marked
  // the store is who deleted it.
  await recordStoreDeleted(env, store, mark);
};

/** Store `storeId`'s object, as core calls it, its ID bound to every call. */
const storeClient = (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  storeId: StoreId
): OpenStore => {
  const stub = inJurisdiction(env, env.DATA_STORES).getByName(storeId);
  return {
    id: storeId,
    applySchema: async (change) => await stub.applySchema(storeId, change),
    beginMigration: async () => await stub.beginMigration(storeId),
    migrationRows: async (table, after) =>
      migrationRowsOf(await stub.migrationRows(storeId, table, after)),
    stageMigration: async (batch) => {
      await stub.stageMigration(storeId, JSON.stringify(batch));
    },
    get: async (table, recordId) => await stub.get(storeId, table, recordId),
    claim: async (claim) => claimedOf(await stub.claim({ ...claim, storeId })),
    commit: async (commit) =>
      committedSchema.parse(
        JSON.parse(await stub.commit({ ...commit, storeId }))
      ),
    read: async (scope, request, staged) =>
      readResultOf(await stub.read(storeId, scope, request, staged)),
    generations: async (names) => await stub.generations(storeId, names),
    history: async (scope, table, recordId, before) =>
      historyOf(await stub.history(storeId, scope, table, recordId, before)),
    stageImport: async (batch) => {
      await stub.stageImport(storeId, batch);
    },
    applyImport: async (landing) => await stub.applyImport(storeId, landing),
    tableFacts: async () => await stub.tableFacts(storeId),
    filesUsable: async (reader, fileIds, resources) => {
      await stub.filesUsable(storeId, reader, fileIds, resources);
    },
  };
};

/**
 * The store `id`, if the inventory lists it and it isn't deleted;
 * otherwise `data.store_unavailable`, the same for a store that never
 * existed as for a deleted one.
 */
export const openStore = async (
  env: Pick<Env, "DB" | "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  id: string
): Promise<OpenStore> => {
  const parsed = storeIdSchema.safeParse(id);
  const row = parsed.success
    ? await drizzle(env.DB)
        .select({ id: businessStores.id })
        .from(businessStores)
        .where(
          and(
            eq(businessStores.id, parsed.data),
            isNull(businessStores.deletedAt)
          )
        )
        .get()
    : undefined;
  if (!parsed.success || row === undefined) {
    throw dataErrors.create("data.store_unavailable");
  }
  return storeClient(env, parsed.data);
};

/**
 * The files of store `id`, which an App's release names, as core's file
 * channel reaches them (app-file-route.ts): the store's object, which
 * holds every call to that store. Opened only for a store the inventory
 * lists and hasn't deleted (`openStore`).
 */
export const storeFiles = async (
  env: Pick<Env, "DB" | "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  id: string
) => {
  const { id: storeId } = await openStore(env, id);
  return {
    storeId,
    stub: inJurisdiction(env, env.DATA_STORES).getByName(storeId),
  };
};

/**
 * A fixture store an App's tests run on (app-tests.ts): an object of the
 * stores' namespace that core's inventory never lists, so it is opened
 * only here, never by `openStore`, and no release binds it. Core mints
 * its ID and records it (`app_test_fixtures`) before it is first opened.
 */
export const openFixtureStore = (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  id: StoreId
): OpenStore => storeClient(env, id);

/**
 * A throwaway store (draft-runs.ts): an object of the stores' namespace
 * that core's inventory never lists, so `openStore` never opens it and no
 * release binds it. Held with `holdThrowawayStore`, or it empties itself.
 */
export const throwawayStore = (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  id: StoreId
): OpenStore => storeClient(env, id);

/**
 * Holds throwaway store `id` until `until`, when it empties itself unless
 * held again (`DataStore.holdThrowaway`, which refuses a listed store, and
 * one emptied for good).
 */
export const holdThrowawayStore = async (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  id: StoreId,
  until: number
): Promise<void> => {
  await inJurisdiction(env, env.DATA_STORES)
    .getByName(id)
    .holdThrowaway(id, until);
};

/**
 * Empties throwaway store `id` for good, at once: it refuses every call
 * after, one under way included, and is never held again
 * (`DataStore.emptyThrowaway`).
 */
export const emptyThrowawayStore = async (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  id: StoreId
): Promise<void> => {
  await inJurisdiction(env, env.DATA_STORES).getByName(id).emptyThrowaway(id);
};

/**
 * Discards fixture store `id`: its object refuses for any store the
 * inventory lists (`DataStore.discardFixture`).
 */
export const discardFixtureStore = async (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  id: StoreId
): Promise<void> => {
  await inJurisdiction(env, env.DATA_STORES).getByName(id).discardFixture(id);
};

import type { SchemaAnswer, SchemaIds } from "@grasp-os/sdk/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  compatibleVersionsMax,
  migrationErrors,
} from "@grasp-os/shared/stores";
import type {
  DefinedTables,
  SchemaConsumer,
  StoreMigration,
} from "@grasp-os/shared/stores";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { OpenStore } from "./data-stores.ts";
import {
  apps,
  sdkReleaseManifests,
  sdkResourceBindings,
  workflowResources,
} from "./db/core/schema.ts";
import { owedResourceKinds } from "./db/data-store/schema.ts";
import { inJurisdiction } from "./durable-objects.ts";
import type {
  BackfillRestart,
  BackfillStatus,
  SchemaStatus,
} from "./store-host.ts";
import { runEngine } from "./workflows/engine.ts";

// A store's schema change and the release that brought it (spec 17.2,
// 17.4 steps 5 and 6): a store takes a schema whose defaulted fields its
// records lack as a pending target, and its contract moves to it only
// once its backfill has filled them all in (store-host.ts,
// `fillMissing`), or, for a release with explicit migrations, once their
// transforms rewrote every record of the tables they migrate
// (store-migrations.ts). The backfill runs as a platform workflow of
// core's own (backfill-run.ts), on the engine Apps' workflows run on, one
// bounded batch per step, so it survives restarts and runs apart from
// whoever asked for it.
//
// A release sealed on that schema runs on the store only once the
// store's contract holds its schema: core asks the store, the authority
// on its own contract, before it makes such a release current
// (`requireStoreSchemaActive`). A change that checks the store's records
// (a narrowing, a field required, a rename, a changed access mode or row rule;
// store-schema-changes.ts) is applied by the store as its release is
// made current (`activateReady`), all or nothing; the schemas it no
// longer covers are left behind there, so a release another one's
// activation left behind meanwhile writes nothing on the store
// (`migration.incompatible_write`) rather than records that don't fit.
// Access modes and row rules are the exception: a change of them checks
// no record and can't be refused, so a store applies them only once
// core's database made the version current or published it
// (`applyCurrentRules`), never before, and no version reads under rules
// that database never made current.
//
// Threat model, and how each is closed:
//
// - The backfill stops for good (its run ran out of retries, its start
//   was lost, the engine's retention removed it) and every schema change
//   of the store waits behind it, whichever App's: the backfill is kept
//   going (`keepBackfillGoing`) by the seal that made it pending, by
//   every seal it refuses, by every attempt to make its release current,
//   and by the store's own alarm once a run's lease ran out
//   (store-host.ts, `runAlarm`), so nothing depends on one App acting.
//   A run that ended without finishing, or that the engine no longer
//   knows after it took batches, is handed over to a new run, which
//   takes over only once the old one's lease ran out; the store answers
//   only its newest run (its fence), so two runs never fill at once.
// - A step is retried after its answer was lost, or the run replays:
//   the engine replays a finished step from its journal, and a step
//   retried sends the same batch again, which the store answers from its
//   receipt without filling anything twice.
// - A run's journal grows without bound on a large store: a run takes at
//   most `batchesPerRun` batches, then hands over to a fresh run itself.
// - The backfill finds a value it can't keep: it fails, naming the
//   record, and its releases are refused (`migration.backfill_failed`),
//   at the seal and as they are made current, rather than run over
//   records that don't fit. Once that record changed (the current
//   version shrank it, say), keeping it going retries from there; a
//   failure nothing changed for stays failed, so nothing loops. One no
//   App can mend (a value under a key no schema declares) an admin
//   abandons (store-abandon.ts): its releases are then refused for good
//   (`migration.abandoned`).
// - A rollback to a version whose schema an explicit migration left
//   behind would run it over records it no longer fits: refused for good
//   (`migration.rollback_incompatible`), naming the App's retained
//   versions on the store that still fit (spec 17.4). The names come from
//   the store's contract and core's own retained releases, for the App's
//   builder making it current, who sees every version of it already.
// - Rules applied for a version core's database doesn't make current
//   after all (a lost compare-and-set, an archived App, a failed batch):
//   none is applied before the commit; after it, the store takes the
//   rules of whichever version that database has current then, read again
//   after applying until it holds still, so a make-current racing another
//   is never undone by a slower one. What checks records goes first and
//   fails closed: a version it leaves behind is refused its writes
//   (`migration.incompatible_write`), never let read more.
// - Core stops between its commit and the rules (a crash, a lost isolate,
//   its database failing): the store owes them from before the commit
//   (`StoreHost.activateReady` with `owed`), and its alarm applies them
//   once core is past due.

/** The store `storeId`'s object, for core's own questions of it. */
const storeObject = (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  storeId: StoreId
) => inJurisdiction(env, env.DATA_STORES).getByName(storeId);

/**
 * Whether the store holds `schemaHash` in force for `consumer`
 * (`StoreHost.schemaStatus`).
 */
export const schemaStatus = async (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  storeId: StoreId,
  schemaHash: string,
  consumer: SchemaConsumer
): Promise<SchemaStatus> =>
  await storeObject(env, storeId).schemaStatus(storeId, schemaHash, consumer);

/**
 * The versions of `app` other than `version` that could be made current
 * on store `storeId` in its place: of its newest retained releases bound
 * to the store (sealed, not revoked: release-retention.ts deletes the
 * rest), those whose schema the store's contract holds in force
 * (`StoreHost.compatibleVersions`). Newest first. What a refused rollback
 * names (spec 17.4); read for the App's builder making it current, who
 * may see every version of it already.
 */
const compatibleVersions = async (
  env: Env,
  app: AppId,
  version: number,
  storeId: StoreId
): Promise<number[]> => {
  const retained = await drizzle(env.DB)
    .select({
      resourceVersion: sdkResourceBindings.resourceVersion,
      schemaHash: sdkResourceBindings.schemaHash,
    })
    .from(sdkResourceBindings)
    .innerJoin(
      sdkReleaseManifests,
      and(
        eq(sdkReleaseManifests.appId, sdkResourceBindings.resourceId),
        eq(sdkReleaseManifests.version, sdkResourceBindings.resourceVersion)
      )
    )
    .where(
      and(
        eq(sdkResourceBindings.resourceId, app),
        eq(sdkResourceBindings.kind, "store"),
        eq(sdkResourceBindings.targetId, storeId),
        ne(sdkResourceBindings.resourceVersion, version),
        isNull(sdkReleaseManifests.revokedAt)
      )
    )
    .orderBy(desc(sdkResourceBindings.resourceVersion))
    .limit(compatibleVersionsMax)
    .all();
  if (retained.length === 0) {
    return [];
  }
  return await storeObject(env, storeId).compatibleVersions(
    storeId,
    app,
    retained
  );
};

/**
 * Refuses making `version` of `app` current on a store a migration moved
 * past its schema (`migration.rollback_incompatible`), naming the
 * versions that would fit instead (`details.compatible`).
 */
const rollbackIncompatible = async (
  env: Env,
  app: AppId,
  version: number,
  storeId: StoreId
): Promise<Error> =>
  migrationErrors.create("migration.rollback_incompatible", {
    compatible: await compatibleVersions(env, app, version, storeId),
  });

/**
 * What keeping a backfill going asks of its store: core reaches it over
 * RPC, its own alarm calls its host directly.
 */
export interface BackfillStore {
  readonly id: StoreId;
  status: () => Promise<BackfillStatus | null>;
  retry: (target: string) => Promise<BackfillStatus | null>;
  restart: (restart: BackfillRestart) => Promise<number>;
}

/** The store `storeId`, as core keeps its backfill going. */
const remoteStore = (env: Env, storeId: StoreId): BackfillStore => {
  const stub = storeObject(env, storeId);
  return {
    id: storeId,
    status: async () => await stub.backfillStatus(storeId),
    retry: async (target) => await stub.retryBackfill(storeId, target),
    restart: async (restart) => await stub.restartBackfill(storeId, restart),
  };
};

/** Most batches one run takes before it hands over to a fresh one. */
export const batchesPerRun = 500;

/**
 * The ID of run `attempt` of the backfill of `target` in `storeId`: one
 * of its own per run, within the engine's hundred characters.
 */
export const backfillRunId = async (
  storeId: StoreId,
  target: string,
  attempt: number
): Promise<string> => {
  const hash = await sha256Hex(`${storeId}:${target}`);
  return `backfill-${hash.slice(0, 40)}-${attempt}`;
};

/** Engine statuses of a run that has ended. */
const endedStatuses: ReadonlySet<string> = new Set([
  "complete",
  "errored",
  "terminated",
]);

/**
 * Hands run `attempt` over to the next; undefined while its lease holds,
 * or when the store didn't move on (the backfill stopped running).
 */
const handedOver = async (
  store: BackfillStore,
  target: string,
  attempt: number
): Promise<number | undefined> => {
  try {
    const next = await store.restart({ target, attempt });
    // Not moved on: the backfill is no longer running (it stalled, say).
    return next === attempt ? undefined : next;
  } catch (error) {
    if (isExpectedError(error) && error.code === "migration.busy") {
      return undefined;
    }
    throw error;
  }
};

/**
 * Makes sure a run of the running backfill `status` describes is going:
 * started when it never was; handed over to a new run when its run ended
 * without finishing it, or the engine no longer knows a run that took
 * batches (its retention removed it). A lease that still holds leaves it
 * as it is, for a later look.
 */
const ensureRun = async (
  env: Env,
  store: BackfillStore,
  status: BackfillStatus
): Promise<void> => {
  const engine = runEngine(env);
  const { target } = status;
  const runOf = async (attempt: number) =>
    await backfillRunId(store.id, target, attempt);
  const run = await engine.status(await runOf(status.attempt));
  if (run !== undefined && !endedStatuses.has(run.status)) {
    return;
  }
  let attempt: number | undefined = status.attempt;
  if (run !== undefined || status.lastBatch > 0) {
    attempt = await handedOver(store, target, status.attempt);
    if (attempt === undefined) {
      return;
    }
  }
  const start = async (at: number) => {
    await engine.createInternal({
      id: await runOf(at),
      workflow: "backfill",
      input: { storeId: store.id, target, attempt: at },
    });
  };
  await start(attempt);
  // A run the engine removed before it took a batch is found removed,
  // not created again: hand over past it too.
  if ((await engine.status(await runOf(attempt))) === undefined) {
    const next = await handedOver(store, target, attempt);
    if (next !== undefined) {
      await start(next);
    }
  }
};

/**
 * Keeps the store's pending backfill going, if it has one (see the
 * header): a failed one retried once its record changed, a running one
 * made sure of a run. Answers the backfill as it is then.
 */
export const keepStoreBackfillGoing = async (
  env: Env,
  store: BackfillStore
): Promise<BackfillStatus | null> => {
  let status = await store.status();
  if (status?.state === "failed") {
    status = await store.retry(status.target);
  }
  // A ready migration has no run: it waits for its release.
  if (status?.state === "running" && !status.ready) {
    await ensureRun(env, store, status);
  }
  return status;
};

/** `keepStoreBackfillGoing`, for the store `storeId`, over RPC. */
export const keepBackfillGoing = async (
  env: Env,
  storeId: StoreId
): Promise<BackfillStatus | null> =>
  await keepStoreBackfillGoing(env, remoteStore(env, storeId));

/**
 * Keeps the backfill going for a seal or an activation, which never fail
 * for it: what it says of the backfill is read from the store, not from
 * this (the engine may be unavailable, the store's alarm keeps it going).
 */
const keepGoingQuietly = async (env: Env, storeId: StoreId): Promise<void> => {
  try {
    await keepBackfillGoing(env, storeId);
  } catch (error) {
    log.warn("store.backfill_start_failed", errorFields(error));
  }
};

/**
 * Hands `store` a release's schema (`defineTables`), for a seal: when the
 * store takes it as its pending target, or refuses it because another
 * target is pending or failed, keeps that backfill going before
 * answering, so a backfill nobody else drives isn't left to stall every
 * schema change of the store.
 */
export const defineSchemaOnStore = async (
  env: Env,
  store: OpenStore,
  manifest: string,
  consumer: SchemaConsumer,
  migrations: StoreMigration[] = [],
  answers: SchemaAnswer[] = [],
  ids: SchemaIds = {}
): Promise<DefinedTables> => {
  let defined: DefinedTables;
  try {
    defined = await store.defineTables(
      manifest,
      consumer,
      migrations,
      answers,
      ids
    );
  } catch (error) {
    if (
      isExpectedError(error) &&
      (error.code === "migration.pending" ||
        error.code === "migration.backfill_failed")
    ) {
      await keepGoingQuietly(env, store.id);
    }
    throw error;
  }
  if (defined.contract.pending) {
    await keepGoingQuietly(env, store.id);
  }
  return defined;
};

/**
 * Why a release can't run on a store that answered `status` for its
 * schema: `migration.pending` (retryable, with the backfill's progress)
 * while a target is pending or its change waits, `migration.backfill_failed`
 * (naming the record) while the backfill stays failed,
 * `migration.abandoned` once an admin abandoned it,
 * `migration.rollback_incompatible` for a schema a migration left
 * behind; a schema the store never took is its records and core's
 * disagreeing, which no retry mends.
 */
export const schemaRefusal = (
  status: Exclude<SchemaStatus, { state: "active" }>
): Error => {
  if (status.state === "abandoned") {
    return migrationErrors.create("migration.abandoned");
  }
  if (status.state === "incompatible") {
    return migrationErrors.create("migration.rollback_incompatible", {
      compatible: [],
    });
  }
  if (status.state === "unknown") {
    return new Error(
      "The store doesn't hold the schema its release was sealed on"
    );
  }
  if (status.state === "failed") {
    return migrationErrors.create("migration.backfill_failed", {
      target: status.target,
      attempt: status.attempt,
      failure: status.failure === null ? null : { ...status.failure },
    });
  }
  return migrationErrors.create("migration.pending", {
    retryable: true,
    scanned: status.scanned,
    filled: status.filled,
  });
};

/**
 * Applies the change schema `schemaHash` makes on `store` for `consumer`,
 * a version that runs once it is written (a workflow's, as it is
 * published), its rules owed under `owed` until it is
 * (`applyRulesAfterCommit`), and refuses it (`schemaRefusal`) unless the
 * store then holds it in force, keeping a pending backfill going.
 */
export const activateOnStore = async (
  env: Env,
  store: OpenStore,
  schemaHash: string,
  consumer: SchemaConsumer,
  owed: OwedRules
): Promise<void> => {
  const status = await store.activate(schemaHash, consumer, owed);
  if (status.state === "active") {
    return;
  }
  if (status.state === "pending" || status.state === "failed") {
    await keepGoingQuietly(env, store.id);
  }
  throw schemaRefusal(status);
};

/**
 * The stores version `version` of resource `resourceId` (an App or a
 * workflow) binds, each with the schema it was sealed or published on.
 */
export const storeBindings = async (
  env: Env,
  resourceId: string,
  version: number
): Promise<{ storeId: StoreId; schemaHash: string }[]> => {
  const bound = await drizzle(env.DB)
    .select({
      store: sdkResourceBindings.targetId,
      schemaHash: sdkResourceBindings.schemaHash,
    })
    .from(sdkResourceBindings)
    .where(
      and(
        eq(sdkResourceBindings.resourceId, resourceId),
        eq(sdkResourceBindings.resourceVersion, version),
        eq(sdkResourceBindings.kind, "store")
      )
    );
  return bound.map(({ store, schemaHash }) => ({
    storeId: storeIdSchema.parse(store),
    schemaHash,
  }));
};

/**
 * The plan of the schema `manifest` (its stable IDs and answers) on the
 * store version `version` of App `app` binds, as that store answers it
 * from what it holds (`StoreHost.planTables`), as JSON text. Undefined
 * when the version binds no store (or no version is current), or when
 * the store can't answer (it waits on a repair, say): the caller plans
 * without it.
 */
export const planOnBoundStore = async (
  env: Env,
  app: AppId,
  version: number | null,
  {
    manifest,
    ids,
    answers,
  }: { manifest: string; ids: SchemaIds; answers: SchemaAnswer[] }
): Promise<string | undefined> => {
  if (version === null) {
    return undefined;
  }
  const [bound] = await storeBindings(env, app, version);
  if (bound === undefined) {
    return undefined;
  }
  try {
    return await storeObject(env, bound.storeId).planTables(
      bound.storeId,
      manifest,
      ids,
      answers
    );
  } catch (error) {
    if (!isExpectedError(error)) {
      throw error;
    }
    log.warn("store.plan_unavailable", errorFields(error));
    return undefined;
  }
};

/**
 * Refuses release `version` of `app` while the store it binds doesn't
 * hold its schema in force, keeping its backfill going. A ready explicit
 * migration passes; with `activate` (the last step before the version is
 * made current, apps.ts) it takes over first (`StoreHost.activateReady`),
 * with the change its schema checks records for, its rules owed under
 * `activate` until the version is current (`applyRulesAfterCommit`),
 * refused as pending if work came back (`schemaRefusal`), or naming the
 * versions that still fit for a rollback past a migration. A release
 * without a store passes.
 */
export const requireStoreSchemaActive = async (
  env: Env,
  app: AppId,
  version: number,
  { activate }: { activate?: OwedRules } = {}
): Promise<void> => {
  const [bound] = await storeBindings(env, app, version);
  if (bound === undefined) {
    return;
  }
  const { storeId, schemaHash } = bound;
  const consumer = { resourceId: app, resourceVersion: version };
  let status = await schemaStatus(env, storeId, schemaHash, consumer);
  if (status.state === "ready" && activate === undefined) {
    // Its explicit migration is done: it may be made current, and takes
    // over only as it is (`activate`), once every other gate passed.
    return;
  }
  if (
    activate !== undefined &&
    (status.state === "ready" || status.state === "active")
  ) {
    // It takes over now, unless a write queued work meanwhile; in force
    // already, it may still owe its rules.
    status = await storeObject(env, storeId).activateReady(
      storeId,
      schemaHash,
      consumer,
      activate
    );
  }
  if (status.state === "active") {
    return;
  }
  if (status.state === "incompatible") {
    // A rollback past an explicit migration: its records moved on, and
    // no backfill brings them back (destructive contraction is a release
    // of its own, never a rollback).
    throw await rollbackIncompatible(env, app, version, storeId);
  }
  if (status.state === "abandoned" || status.state === "unknown") {
    throw schemaRefusal(status);
  }
  await keepGoingQuietly(env, storeId);
  // Asked again: the store's pending target may have moved on meanwhile
  // (this schema's finished and a newer one began), and only this
  // schema's own state refuses its release.
  const after = await schemaStatus(env, storeId, schemaHash, consumer);
  if (after.state === "active") {
    return;
  }
  if (after.state === "incompatible") {
    throw await rollbackIncompatible(env, app, version, storeId);
  }
  throw schemaRefusal(after);
};

/** Rules a store owes a version until core's database committed it. */
export const owedRulesSchema = z
  .object({
    /** The make-current's or publication's own. */
    id: z.uuid(),
    kind: z.enum(owedResourceKinds),
  })
  .strict();

export type OwedRules = z.output<typeof owedRulesSchema>;

/** What owes rules: an App or a workflow, by ID. */
export interface OwedResource {
  kind: OwedRules["kind"];
  id: string;
}

/**
 * What applying rules asks of a store: core reaches it over RPC, its own
 * alarm calls its host directly.
 */
export interface RulesStore {
  readonly id: StoreId;
  applyRules: (schemaHash: string) => Promise<boolean>;
}

/** The version of `resource` core's database has current, if any. */
export const currentVersionOf = async (
  env: Env,
  resource: OwedResource
): Promise<number | null> => {
  const db = drizzle(env.DB);
  const row =
    resource.kind === "app"
      ? await db
          .select({ version: apps.currentVersion })
          .from(apps)
          .where(eq(apps.id, resource.id))
          .get()
      : await db
          .select({ version: workflowResources.currentVersion })
          .from(workflowResources)
          .where(eq(workflowResources.id, resource.id))
          .get();
  return row?.version ?? null;
};

/** How often applying rules reads the current version before it gives up. */
const rulesReads = 3;

/**
 * Applies to `store` the access modes and row rules of the version of
 * `resource` that core's database has current (`StoreHost.applyRules`),
 * then reads it again: a version made current meanwhile is applied in
 * turn, so a slower call never leaves the rules of the one before it.
 * True once the rules are those of a version still current after (or
 * none is current, or it binds no such store); false while the store
 * waits on a pending target, or the version kept moving, for the store's
 * alarm to try again.
 */
export const applyCurrentRules = async (
  env: Env,
  store: RulesStore,
  resource: OwedResource
): Promise<boolean> => {
  for (let read = 0; read < rulesReads; read += 1) {
    // oxlint-disable-next-line no-await-in-loop -- read, apply, read again
    const current = await currentVersionOf(env, resource);
    if (current === null) {
      return true;
    }
    // oxlint-disable-next-line no-await-in-loop -- read, apply, read again
    const bound = await storeBindings(env, resource.id, current);
    const binding = bound.find(({ storeId }) => storeId === store.id);
    if (binding === undefined) {
      return true;
    }
    // oxlint-disable-next-line no-await-in-loop -- read, apply, read again
    if (!(await store.applyRules(binding.schemaHash))) {
      return false;
    }
    // oxlint-disable-next-line no-await-in-loop -- read, apply, read again
    if ((await currentVersionOf(env, resource)) === current) {
      return true;
    }
  }
  return false;
};

/**
 * After core's database made a version of `resourceId` current or
 * published it, or failed to: applies on `stores` the rules of whichever
 * version it has current (`applyCurrentRules`), and settles what each
 * owed under `owed` (`StoreHost.activateReady`). A store that recorded
 * nothing under `owed` (its activation refused as busy, or never asked)
 * applies nothing (`StoreHost.applyRules`). Never throws, as the commit
 * stands either way: a store it can't reach, or that waits on a pending
 * target, keeps owing them, and its alarm applies them.
 */
export const applyRulesAfterCommit = async (
  env: Env,
  owed: OwedRules,
  resourceId: string,
  stores: readonly StoreId[]
): Promise<void> => {
  const resource = { kind: owed.kind, id: resourceId };
  for (const storeId of stores) {
    const stub = storeObject(env, storeId);
    try {
      // oxlint-disable-next-line no-await-in-loop -- one store at a time
      const applied = await applyCurrentRules(
        env,
        {
          id: storeId,
          applyRules: async (schemaHash) =>
            await stub.applyRules(storeId, schemaHash, owed.id),
        },
        resource
      );
      if (applied) {
        // oxlint-disable-next-line no-await-in-loop -- one store at a time
        await stub.settleRules(storeId, [owed.id]);
      }
    } catch (error) {
      log.error("store.rules_apply_failed", {
        storeId,
        resourceId,
        ...errorFields(error),
      });
    }
  }
};

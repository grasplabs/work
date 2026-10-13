import { actorOf, auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { appIdSchema, storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import { requireAdmin } from "@grasp-os/shared/roles";
import { abandonBackfillSchema, dataErrors } from "@grasp-os/shared/stores";
import type {
  AbandonedBackfill,
  AppStoreBackfill,
  StoreBackfill,
} from "@grasp-os/shared/stores";
import { and, eq, inArray, isNull, not } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  auditedBatch,
  outboxedEventWhere,
  storedEvent,
  uuidFromHash,
} from "./audit-outbox.ts";
import type { Member } from "./auth/identity.ts";
import {
  appDefaultStores,
  businessStores,
  sdkResourceBindings,
} from "./db/core/schema.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { requireNotStaff } from "./sharing.ts";
import type { BackfillAbandonment } from "./store-host.ts";

// Abandoning a store's failed backfill (spec 17.2, 17.3): the explicit
// migration that gets a store out of a defaulted field it can't fill in.
// A backfill fails on a record that already holds a value the field
// doesn't accept, or on one the default would make too large, or stalls;
// until then, every schema change of the store is refused
// (`migration.backfill_failed`), whichever App's, and on a shared store
// that blocks every App bound to it. An admin abandons the failed target:
// the store keeps its contract as it was and takes schema changes again
// (store-host.ts, `abandonBackfill`). What can go wrong, and how each is
// closed:
//
// - Someone abandons who shouldn't: only the organization's admins, never
//   Grasp staff (`role.forbidden`), checked here, server-side, from the
//   identity read for the call. Not a store's managers, nor an App's
//   builders: on a shared store, one App's target holds other Apps'
//   releases too, so abandoning it decides for all of them, which is the
//   organization's call. No App or workflow reaches it (it isn't in the
//   SDK, and core's agents don't get it). Reading a store's failed change,
//   or which stores an App uses and theirs, is theirs alone too.
// - A backfill still running is abandoned under its run: refused
//   (`migration.not_failed`); it either finishes or fails first.
// - An abandonment races a retry: the admin names the run they saw fail
//   (`attempt`), and the store abandons only that run's failure, in the
//   transaction that checks it. A retry that took the target on first
//   (a new run) makes the abandonment `migration.superseded`, so nobody
//   abandons a backfill that may be about to finish; one that comes after
//   finds the target gone, and does nothing.
// - The values the failed backfill filled in are later read under another
//   meaning: the target's fields stay reserved with their descriptors, so
//   a later schema adds them again only as they were
//   (`reserved_field_changed` otherwise), and the values fit. Reads
//   project to the reader's schema, so a value nothing declares stays
//   unseen; records keep it, harmlessly.
// - A release sealed on the abandoned schema becomes current after all:
//   its receipt in the store is marked abandoned, which `schemaStatus`
//   answers for it from then on, whatever the store later holds; sealing
//   it again for that release is refused (`migration.abandoned`). A later
//   release adding the same fields as they were makes a new target, whose
//   backfill runs from the run after the abandoned one's.
// - An abandonment goes unaudited: the store records it (who, when, what
//   it took out of force) in the transaction that abandons, and its event
//   is made from that record alone, with an ID derived from it; core
//   stores it at once, and the store's alarm stores it again until core
//   is known to hold it, so it lands once whichever runs first, even if
//   this call stopped after the store abandoned.

/** The store `storeId`'s object. */
const storeObject = (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  storeId: StoreId
) => inJurisdiction(env, env.DATA_STORES).getByName(storeId);

/** Most releases, and reserved fields, an abandonment's event names. */
const releasesNamed = 12;
const reservedNamed = 8;

/** The `store.backfill_abandoned` event of `abandonment`, the same wherever made. */
export const backfillAbandonedEvent = async (
  store: StoreId,
  abandonment: BackfillAbandonment
): Promise<AuditEvent> => {
  const { target, attempt, failure, abandonedAt } = abandonment;
  const record =
    failure.reason === "stalled"
      ? {}
      : { table: failure.table, field: failure.field, record: failure.id };
  return auditEventSchema.parse({
    actor: abandonment.abandonedBy,
    action: "store.backfill_abandoned",
    target: { type: "store", id: store },
    detail: {
      target,
      attempt,
      reason: failure.reason,
      ...record,
      scanned: abandonment.scanned,
      filled: abandonment.filled,
      schemas: abandonment.schemas.length,
      releases: abandonment.consumers.length,
      ...Object.fromEntries(
        abandonment.consumers
          .slice(0, releasesNamed)
          .map(({ resourceId, resourceVersion }, index) => [
            `release.${index}`,
            `${resourceId}@${resourceVersion}`,
          ])
      ),
      reserved: abandonment.reserved.length,
      ...Object.fromEntries(
        abandonment.reserved
          .slice(0, reservedNamed)
          .map(({ table, field }, index) => [
            `reserved.${index}`,
            `${table}.${field}`,
          ])
      ),
    },
    id: uuidFromHash(
      await sha256Hex(
        `store.backfill_abandoned:${store}:${target}:${abandonedAt}`
      )
    ),
    at: new Date(abandonedAt).toISOString(),
    source: "core",
  });
};

/**
 * Stores `abandonment`'s event in core's audit outbox, unless it holds it
 * already: repeating it changes nothing, and the log takes an event once.
 */
export const recordBackfillAbandoned = async (
  env: Env,
  store: StoreId,
  abandonment: BackfillAbandonment
): Promise<void> => {
  const db = drizzle(env.DB);
  const event = await backfillAbandonedEvent(store, abandonment);
  await auditedBatch(env, db, [
    outboxedEventWhere(db, event, not(storedEvent(event.id))),
  ]);
};

/** The store `id`, live in core's inventory; `data.store_unavailable` otherwise. */
const liveStore = async (env: Env, id: StoreId): Promise<StoreId> => {
  const row = await drizzle(env.DB)
    .select({ id: businessStores.id })
    .from(businessStores)
    .where(and(eq(businessStores.id, id), isNull(businessStores.deletedAt)))
    .get();
  if (row === undefined) {
    throw dataErrors.create("data.store_unavailable");
  }
  return id;
};

/** The store `store`'s pending schema change, for an admin (`StoresApi.backfill`). */
export const storeBackfill = async (
  env: Env,
  by: Member,
  store: string
): Promise<StoreBackfill | null> => {
  requireAdmin(by);
  requireNotStaff(by);
  const { store: id } = dataErrors.parse(
    "data.invalid",
    abandonBackfillSchema.pick({ store: true }),
    { store }
  );
  await liveStore(env, id);
  const status = await storeObject(env, id).backfillStatus(id);
  if (status === null) {
    return null;
  }
  const { target, state, attempt, scanned, filled, failure } = status;
  return { target, state, attempt, scanned, filled, failure };
};

/**
 * The most stores `appStoreBackfills` asks: an App's releases bind one
 * store each, so more than a handful only comes of rebinding it often.
 */
const appStoresAsked = 32;

/**
 * The pending schema changes of the stores the App `app` uses, for an
 * admin (`StoresApi.appBackfills`): its default store and every live
 * store a release of it is bound to. On a shared store the change may be
 * another App's, which blocks this App's releases all the same. A store
 * with none isn't listed; neither is an App nobody knows.
 */
export const appStoreBackfills = async (
  env: Env,
  by: Member,
  app: string
): Promise<AppStoreBackfill[]> => {
  requireAdmin(by);
  requireNotStaff(by);
  const { app: id } = dataErrors.parse(
    "data.invalid",
    z.strictObject({ app: appIdSchema }),
    { app }
  );
  const db = drizzle(env.DB);
  const [bound, defaults] = await Promise.all([
    db
      .selectDistinct({ store: sdkResourceBindings.targetId })
      .from(sdkResourceBindings)
      .where(
        and(
          eq(sdkResourceBindings.resourceId, id),
          eq(sdkResourceBindings.kind, "store")
        )
      )
      .limit(appStoresAsked),
    db
      .select({ store: appDefaultStores.storeId })
      .from(appDefaultStores)
      .where(eq(appDefaultStores.appId, id)),
  ]);
  const named = [
    ...new Set([...defaults, ...bound].map(({ store }) => store)),
  ].slice(0, appStoresAsked);
  if (named.length === 0) {
    return [];
  }
  const live = await db
    .select({ id: businessStores.id })
    .from(businessStores)
    .where(
      and(inArray(businessStores.id, named), isNull(businessStores.deletedAt))
    )
    .orderBy(businessStores.id);
  const found = await Promise.all(
    live.map(async (row) => {
      const store = storeIdSchema.parse(row.id);
      const status = await storeObject(env, store).backfillStatus(store);
      if (status === null) {
        return [];
      }
      const { target, state, attempt, scanned, filled, failure } = status;
      return [
        {
          store,
          backfill: { target, state, attempt, scanned, filled, failure },
        },
      ];
    })
  );
  return found.flat();
};

/**
 * Abandons the failed backfill `input` names, for `by`, an admin who
 * isn't Grasp staff (see the header): the store abandons it, then its
 * event is stored, then the store notes that core holds it.
 */
export const abandonStoreBackfill = async (
  env: Env,
  by: Member,
  input: unknown
): Promise<AbandonedBackfill> => {
  requireAdmin(by);
  requireNotStaff(by);
  const { store, target, attempt } = dataErrors.parse(
    "data.invalid",
    abandonBackfillSchema,
    input
  );
  await liveStore(env, store);
  const object = storeObject(env, store);
  const abandonment = await object.abandonBackfill(
    store,
    { target, attempt },
    actorOf(by)
  );
  await recordBackfillAbandoned(env, store, abandonment);
  await object.markAbandonmentAudited(store, target, abandonment.attempt);
  return {
    store,
    target,
    attempt: abandonment.attempt,
    scanned: abandonment.scanned,
    filled: abandonment.filled,
    failure: abandonment.failure,
    releases: abandonment.consumers.map(({ resourceId, resourceVersion }) => ({
      app: resourceId,
      version: resourceVersion,
    })),
    reserved: abandonment.reserved,
    abandonedAt: new Date(abandonment.abandonedAt).toISOString(),
  };
};

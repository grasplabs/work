import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import {
  canBuild,
  isAdmin,
  requireBuilder,
  roleErrors,
} from "@grasp-os/shared/roles";
import { dataErrors, storeMemberSchema } from "@grasp-os/shared/stores";
import type {
  ClaimInput,
  Claimed,
  Commit,
  Committed,
  StoredRecord,
} from "@grasp-os/shared/stores";
import { and, eq, exists, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed, outboxedEventWhere } from "./audit-outbox.ts";
import { organizationId } from "./auth/auth.ts";
import { memberRole } from "./auth/identity.ts";
import type { Acting } from "./auth/identity.ts";
import {
  businessStoreMembers,
  businessStores,
  teams,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { inJurisdiction } from "./durable-objects.ts";

// The deployment's business stores, as core finds them: its inventory in
// core D1 (`business_stores`) says which stores exist, and each store's
// records live in its own Durable Object (data-store.ts), named by the
// store's ID. Core D1 never holds a store's records. A store's ID is
// minted here, at random: it isn't an App's, a workflow's or a run's, and
// no name anyone gives a store becomes it, so a store outlives whatever
// first used it, and nothing reaches it by guessing a name.
//
// A store's lifecycle: the organization's builders create stores; its
// admins, its creator and the people and teams it is shared with in role
// `manage` manage it (share it, delete it), as long as their own role in
// the organization builds. Threat model, and how each is closed:
//
// - Someone creates stores who shouldn't: only admins and builders can
//   (`role.forbidden` otherwise), and the creation is audited in the same
//   batch as its inventory row.
// - Someone deletes or shares a store they don't manage: manage authority
//   is read from the database at each call (role, ownership, membership
//   by person or team, capped by the organization role). Anyone without
//   it gets `data.store_unavailable`, as for a store that doesn't exist,
//   so they learn nothing of it. Grasp staff manage as admins but never
//   share a store: whom a client's data reaches is the client's decision.
// - A store is deleted while something still relies on it: the store's
//   own object refuses (`data.store_in_use`) while any receipt not yet
//   expired refers to it, which an attempt in flight, a retry to come, a
//   live workflow run or an outbox entry still owed keeps. The check and
//   the deletion mark are one transaction in the object, so no claim lands
//   in between, and every call after the mark is refused there, whatever
//   core's inventory says.
// - A deletion stops half-way: the object is marked first, then the
//   inventory row and its audit event in one batch. Deleting again
//   repeats only what is missing (marking is idempotent, and the event is
//   stored only by the batch that marks the row), and a store marked in
//   its object is refused even while its inventory row lags.
// - A deleted store comes back: its ID is never minted again (random), its
//   object keeps its deletion mark after purging its records, and its
//   inventory row keeps `deleted_at`.
// - A store of another deployment is reached: each deployment's core has
//   its own namespace of store objects, and IDs resolve only through the
//   inventory of the core that holds them.

/** A store, as core uses it: its ID bound to every call. */
export interface OpenStore {
  id: StoreId;
  defineTables: (names: readonly string[]) => Promise<Record<string, string>>;
  get: (table: string, id: string) => Promise<StoredRecord | null>;
  claim: (claim: Omit<ClaimInput, "storeId">) => Promise<Claimed>;
  commit: (commit: Omit<Commit, "storeId">) => Promise<Committed>;
}

/** The audit entry of a change to `store` by `by`: identifiers only. */
const storeEntry = (
  by: Acting,
  action:
    | "store.created"
    | "store.deleted"
    | "store.member.added"
    | "store.member.removed",
  store: StoreId,
  detail: AuditEntry["detail"] = {}
): AuditEntry => ({
  actor: by.actor ?? actorOf(by),
  action,
  target: { type: "store", id: store },
  detail,
});

/**
 * Creates a store owned by `by`, who must build, audited with its
 * inventory row, and answers its ID. Its object starts empty on first use.
 */
export const createStore = async (env: Env, by: Acting): Promise<StoreId> => {
  requireBuilder(by);
  const id = storeIdSchema.parse(crypto.randomUUID());
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db.insert(businessStores).values({
      id,
      ownerId: by.userId,
      physicalNamespaceRole: "data_store",
      createdAt: new Date(),
    }),
    outboxed(db, storeEntry(by, "store.created", id)),
  ]);
  return id;
};

/**
 * The live store `id` if `by` manages it: an admin, its creator, or a
 * person or team it is shared with in role `manage`, and only while their
 * role in the organization builds. Otherwise `data.store_unavailable`, as
 * for a store that doesn't exist.
 */
const managedBy = async (
  env: Env,
  by: Acting,
  id: string
): Promise<StoreId> => {
  const parsed = storeIdSchema.safeParse(id);
  if (!parsed.success || !canBuild(by.role)) {
    throw dataErrors.create("data.store_unavailable");
  }
  const db = drizzle(env.DB);
  const teamIds = by.teams.map((team) => team.id);
  const shared = db
    .select({ one: sql`1` })
    .from(businessStoreMembers)
    .where(
      and(
        eq(businessStoreMembers.storeId, businessStores.id),
        eq(businessStoreMembers.role, "manage"),
        or(
          and(
            eq(businessStoreMembers.memberType, "person"),
            eq(businessStoreMembers.memberId, by.userId)
          ),
          teamIds.length === 0
            ? undefined
            : and(
                eq(businessStoreMembers.memberType, "team"),
                inList(businessStoreMembers.memberId, teamIds)
              )
        )
      )
    );
  const row = await db
    .select({ id: businessStores.id })
    .from(businessStores)
    .where(
      and(
        eq(businessStores.id, parsed.data),
        isNull(businessStores.deletedAt),
        isAdmin(by.role)
          ? undefined
          : or(eq(businessStores.ownerId, by.userId), exists(shared))
      )
    )
    .get();
  if (row === undefined) {
    throw dataErrors.create("data.store_unavailable");
  }
  return parsed.data;
};

/**
 * Deletes store `id` for `by`, who must manage it: refused with
 * `data.store_in_use` while a receipt not yet expired refers to it (the
 * store's object decides, data-store.ts). The object is marked deleted
 * first, then the inventory row, audited in the same batch; repeating a
 * deletion that stopped half-way finishes it, auditing it once.
 */
export const deleteStore = async (
  env: Env,
  by: Acting,
  id: string
): Promise<void> => {
  const storeId = await managedBy(env, by, id);
  await inJurisdiction(env, env.DATA_STORES).getByName(storeId).close(storeId);
  const db = drizzle(env.DB);
  const event = createAuditEvent(
    storeEntry(by, "store.deleted", storeId),
    "core"
  );
  await auditedBatch(env, db, [
    db
      .update(businessStores)
      .set({ deletedAt: new Date() })
      .where(
        and(eq(businessStores.id, storeId), isNull(businessStores.deletedAt))
      ),
    outboxedEventWhere(db, event, sql`changes() > 0`),
  ]);
};

/**
 * Shares store `id` with a person or team in role `manage`, for `by`, who
 * must manage it and isn't Grasp staff. A person must be in the
 * organization in a role that builds; a team must exist. Sharing again
 * changes nothing.
 */
export const shareStore = async (
  env: Env,
  by: Acting,
  id: string,
  input: unknown
): Promise<void> => {
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const storeId = await managedBy(env, by, id);
  const member = dataErrors.parse("data.invalid", storeMemberSchema, input);
  const db = drizzle(env.DB);
  if (member.type === "team") {
    const team = await db
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(eq(teams.id, member.id), eq(teams.organizationId, organizationId))
      )
      .get();
    if (team === undefined) {
      throw dataErrors.create("data.invalid", { issues: ["No such team"] });
    }
  } else {
    const role = await memberRole(env.DB, member.id);
    if (role === undefined || !canBuild(role)) {
      throw dataErrors.create("data.invalid", {
        issues: ["Only the organization's admins and builders manage stores"],
      });
    }
  }
  const event = createAuditEvent(
    storeEntry(by, "store.member.added", storeId, {
      memberType: member.type,
      member: member.id,
      role: "manage",
    }),
    "core"
  );
  await auditedBatch(env, db, [
    db
      .insert(businessStoreMembers)
      .values({
        storeId,
        memberType: member.type,
        memberId: member.id,
        role: "manage",
        addedBy: by.userId,
        addedAt: new Date(),
      })
      .onConflictDoNothing(),
    outboxedEventWhere(db, event, sql`changes() > 0`),
  ]);
};

/**
 * Stops sharing store `id` with a person or team, for `by`, who must
 * manage it and isn't Grasp staff. Unsharing someone it isn't shared with
 * changes nothing.
 */
export const unshareStore = async (
  env: Env,
  by: Acting,
  id: string,
  input: unknown
): Promise<void> => {
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const storeId = await managedBy(env, by, id);
  const member = dataErrors.parse("data.invalid", storeMemberSchema, input);
  const db = drizzle(env.DB);
  const event = createAuditEvent(
    storeEntry(by, "store.member.removed", storeId, {
      memberType: member.type,
      member: member.id,
    }),
    "core"
  );
  await auditedBatch(env, db, [
    db
      .delete(businessStoreMembers)
      .where(
        and(
          eq(businessStoreMembers.storeId, storeId),
          eq(businessStoreMembers.memberType, member.type),
          eq(businessStoreMembers.memberId, member.id)
        )
      ),
    outboxedEventWhere(db, event, sql`changes() > 0`),
  ]);
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
  const storeId = parsed.data;
  const stub = inJurisdiction(env, env.DATA_STORES).getByName(storeId);
  return {
    id: storeId,
    defineTables: async (names) => await stub.defineTables(storeId, names),
    get: async (table, recordId) => await stub.get(storeId, table, recordId),
    claim: async (claim) => await stub.claim({ ...claim, storeId }),
    commit: async (commit) => await stub.commit({ ...commit, storeId }),
  };
};

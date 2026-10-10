import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import { canBuild, isAdmin, requireBuilder } from "@grasp-os/shared/roles";
import { dataErrors, storeMemberSchema } from "@grasp-os/shared/stores";
import type {
  ClaimInput,
  Claimed,
  Commit,
  Committed,
  StoredRecord,
} from "@grasp-os/shared/stores";
import { and, asc, eq, exists, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { businessStoreMembers, businessStores } from "./db/core/schema.ts";
import { inJurisdiction } from "./durable-objects.ts";
import {
  memberEntry,
  requireNotStaff,
  requireSharable,
  rowsOf,
  stillMembers,
} from "./sharing.ts";
import type { MemberRef } from "./sharing.ts";
import { recordStoreDeleted } from "./store-deletion.ts";
import type { StoreDeletionMark } from "./store-deletion.ts";

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
//   so they learn nothing of it. Grasp staff never share, unshare or
//   delete a store: whom a client's data reaches, and whether it is
//   destroyed, is the client's decision. A refused deletion is audited.
// - A store is deleted while something still relies on it: the store's
//   own object refuses (`data.store_in_use`) while any receipt not yet
//   expired refers to it, which an attempt in flight, a retry to come, a
//   live workflow run or an outbox entry still owed keeps. The check and
//   the deletion mark are one transaction in the object, so no claim lands
//   in between, and every call after the mark is refused there, whatever
//   core's inventory says.
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
  defineTables: (names: readonly string[]) => Promise<Record<string, string>>;
  get: (table: string, id: string) => Promise<StoredRecord | null>;
  claim: (claim: Omit<ClaimInput, "storeId">) => Promise<Claimed>;
  commit: (commit: Omit<Commit, "storeId">) => Promise<Committed>;
}

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

/** Whom a store is shared with to manage it, as its managers see it. */
export interface StoreManager {
  type: "person" | "team";
  id: string;
  role: "manage";
  addedBy: string;
  addedAt: string;
}

/**
 * Creates a store owned by `by`, who must build, as for creating an App,
 * audited with its inventory row, and answers its ID. Its object starts
 * empty on first use.
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
 * person or team still in the organization it is shared with in role
 * `manage`, and only while their role in the organization builds.
 * Otherwise `data.store_unavailable`, as for a store that doesn't exist.
 */
const managedBy = async (
  env: Env,
  by: Acting,
  id: string
): Promise<{ id: StoreId; owner: string }> => {
  const parsed = storeIdSchema.safeParse(id);
  if (!parsed.success || !canBuild(by.role)) {
    throw dataErrors.create("data.store_unavailable");
  }
  const db = drizzle(env.DB);
  const shared = db
    .select({ one: sql`1` })
    .from(businessStoreMembers)
    .where(
      and(
        eq(businessStoreMembers.storeId, businessStores.id),
        eq(businessStoreMembers.role, "manage"),
        rowsOf(businessStoreMembers, by),
        stillMembers(businessStoreMembers)
      )
    );
  const row = await db
    .select({ id: businessStores.id, owner: businessStores.ownerId })
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
  return { id: parsed.data, owner: row.owner };
};

/**
 * Deletes store `id` for `by`, who must manage it and isn't Grasp staff:
 * refused with `data.store_in_use`, and audited, while a receipt not yet
 * expired refers to it (the store's object decides, store-host.ts). The
 * object is marked deleted first, with `by` and the time; then the
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
  let mark: StoreDeletionMark;
  try {
    mark = await inJurisdiction(env, env.DATA_STORES)
      .getByName(store.id)
      .close(store.id, actor);
  } catch (error) {
    if (dataErrors.codeOf(error) === "data.store_in_use") {
      const db = drizzle(env.DB);
      await auditedBatch(env, db, [
        outboxed(db, storeEntry(by, "store.delete_refused", store.id)),
      ]);
    }
    throw error;
  }
  // The mark's actor, not `by`: when deletions race, the one that marked
  // the store is who deleted it.
  await recordStoreDeleted(env, store.id, mark);
};

/** The rules for sharing a store (sharing.ts). */
const sharingRules = (owner: string) => ({
  owner,
  builds: true,
  invalid: (issue: string) =>
    dataErrors.create("data.invalid", { issues: [issue] }),
  ownerIssue: "id: They created the store, and always manage it.",
  buildsIssue:
    "role: Only the organization's admins and builders manage stores.",
});

/**
 * Shares store `id` with a person or team in role `manage`, for `by`, who
 * must manage it and isn't Grasp staff, as for Apps: a person in the
 * organization in a role that builds, never its creator; or a team that
 * exists. Sharing again changes and records nothing.
 */
export const shareStore = async (
  env: Env,
  by: Acting,
  id: string,
  input: unknown
): Promise<void> => {
  requireNotStaff(by);
  const store = await managedBy(env, by, id);
  const member: MemberRef = dataErrors.parse(
    "data.invalid",
    storeMemberSchema,
    input
  );
  await requireSharable(env, member, sharingRules(store.owner));
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .insert(businessStoreMembers)
      .values({
        storeId: store.id,
        memberType: member.type,
        memberId: member.id,
        role: "manage",
        addedBy: by.userId,
        addedAt: new Date(),
      })
      .onConflictDoNothing(),
    outboxedIfChanged(
      db,
      memberEntry(
        by,
        "store.member.added",
        { type: "store", id: store.id },
        {
          ...member,
          role: "manage",
        }
      )
    ),
  ]);
};

/**
 * Stops sharing store `id` with a person or team, for `by`, who must
 * manage it and isn't Grasp staff. Unsharing someone it isn't shared with
 * changes and records nothing.
 */
export const unshareStore = async (
  env: Env,
  by: Acting,
  id: string,
  input: unknown
): Promise<void> => {
  requireNotStaff(by);
  const store = await managedBy(env, by, id);
  const member: MemberRef = dataErrors.parse(
    "data.invalid",
    storeMemberSchema,
    input
  );
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .delete(businessStoreMembers)
      .where(
        and(
          eq(businessStoreMembers.storeId, store.id),
          eq(businessStoreMembers.memberType, member.type),
          eq(businessStoreMembers.memberId, member.id)
        )
      ),
    outboxedIfChanged(
      db,
      memberEntry(
        by,
        "store.member.removed",
        { type: "store", id: store.id },
        {
          ...member,
          role: "manage",
        }
      )
    ),
  ]);
};

/**
 * Whom store `id` is shared with to manage it, for `by`, who must manage
 * it: the people still in the organization and the teams that still
 * exist, in the order they were shared.
 */
export const storeManagers = async (
  env: Env,
  by: Acting,
  id: string
): Promise<StoreManager[]> => {
  const store = await managedBy(env, by, id);
  const rows = await drizzle(env.DB)
    .select()
    .from(businessStoreMembers)
    .where(
      and(
        eq(businessStoreMembers.storeId, store.id),
        stillMembers(businessStoreMembers)
      )
    )
    .orderBy(
      asc(businessStoreMembers.addedAt),
      asc(businessStoreMembers.memberType),
      asc(businessStoreMembers.memberId)
    );
  return rows.map((row) => ({
    type: row.memberType,
    id: row.memberId,
    role: row.role,
    addedBy: row.addedBy,
    addedAt: row.addedAt.toISOString(),
  }));
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

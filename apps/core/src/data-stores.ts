import type { App } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema, storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import { canBuild, isAdmin, requireBuilder } from "@grasp-os/shared/roles";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { ReadRequest } from "@grasp-os/shared/store-reads";
import {
  committedSchema,
  dataErrors,
  storeMemberSchema,
} from "@grasp-os/shared/stores";
import type {
  ClaimInput,
  Claimed,
  Commit,
  Committed,
  DefinedTables,
  SchemaConsumer,
  StagedWrites,
  StoredRecord,
  StoreMigration,
} from "@grasp-os/shared/stores";
import { and, asc, eq, exists, isNull, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { requireAppRole } from "./app-access.ts";
import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember } from "./auth/auth.ts";
import type { Acting } from "./auth/identity.ts";
import {
  appDefaultStores,
  appMembers,
  apps,
  businessStoreMembers,
  businessStores,
} from "./db/core/schema.ts";
import { inJurisdiction } from "./durable-objects.ts";
import {
  memberEntry,
  requireNotStaff,
  requireSharable,
  rowsOf,
  stillMembers,
} from "./sharing.ts";
import type { MemberRef } from "./sharing.ts";
import { recordStoreDeleted, storeClosingMs } from "./store-deletion.ts";
import type { StoreDeletionMark } from "./store-deletion.ts";
import type { ReadResult } from "./store-host.ts";

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
// the organization builds. An App's default store (app-activation.ts) is
// managed instead by whoever builds the App, the organization's admins
// included. Threat model, and how each is closed:
//
// - Someone creates stores who shouldn't: only admins and builders can
//   (`role.forbidden` otherwise), and the creation is audited in the same
//   batch as its inventory row.
// - Someone deletes or shares a store they don't manage: manage authority
//   is decided at each call, as an App's roles are (app-access.ts): the
//   store's ownership and member rows are read from the database then,
//   so unsharing applies to the next call; the caller's role and teams
//   are their identity as read for the call (a session's latest reading,
//   at most a few seconds old, auth/identity.ts and rpc.ts), so a
//   demotion or a team change applies within those seconds. Whoever
//   calls these must pass an identity read that way, never one kept
//   across calls. Membership is capped by the organization role. Anyone without
//   it gets `data.store_unavailable`, as for a store that doesn't exist,
//   so they learn nothing of it. Grasp staff never share, unshare or
//   delete a store: whom a client's data reaches, and whether it is
//   destroyed, is the client's decision. A refused deletion is audited.
// - Someone keeps power over an App's data after leaving the App, or hands
//   it to an outsider: an App's default store is managed by the App's
//   builders as its App roles decide them on each call (requireAppRole),
//   never by its creator as such, and it can't be shared or unshared as a
//   store (`data.store_managed_by_app`): whom it serves follows the App's
//   own membership.
// - A store is deleted while something still relies on it: the store's
//   own object refuses (`data.store_in_use`) while any receipt not yet
//   expired refers to it, which an attempt in flight, a retry to come, a
//   live workflow run or an outbox entry still owed keeps. The check and
//   the deletion mark are one transaction in the object, so no claim lands
//   in between, and every call after the mark is refused there, whatever
//   core's inventory says.
// - A store is deleted under a sealed release that may still run on it (a
//   current or pending version, a rollback target, a pinned run, an open
//   screen's lease): refused (`data.store_bound`) while any release an App
//   keeps is bound to it (`sdk_resource_bindings`, whose rows retention
//   deletes with their release), read in the statement that marks the
//   store closing, before its object is touched; a seal's binding in turn
//   requires the store live and not closing (app-releases.ts), so of the
//   two, one wins. Deleting an App never deletes its stores.
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
  /**
   * A schema applied to the store, from its manifest's text, for its
   * consumer when named (`StoreHost.defineTables`).
   */
  defineTables: (
    manifest: string,
    consumer?: SchemaConsumer,
    migrations?: StoreMigration[]
  ) => Promise<DefinedTables>;
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
}

/**
 * A read's result as the store's object answered it, as JSON text over
 * RPC (data-store.ts): its value as the store shaped it, and the
 * generations, which must be counts.
 */
const readResultSchema = z.strictObject({
  value: z.unknown(),
  generations: z.record(z.string(), z.number().int().min(0)),
});

/** A claim's answer, as JSON text over RPC (data-store.ts). */
const claimedSchema = z.union([
  z.strictObject({
    held: z.strictObject({ receiptId: z.string(), fence: z.number().int() }),
  }),
  z.strictObject({ outcome: committedSchema }),
]);

const claimedOf = (answered: string): Claimed =>
  claimedSchema.parse(JSON.parse(answered));

const readResultOf = (answered: string): ReadResult => {
  const { value, generations } = readResultSchema.parse(JSON.parse(answered));
  // SAFETY: the store's host shaped the value (`StoreHost.read`), a
  // `QueryAnswer` of JSON documents, which JSON carries unchanged.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return { value: value as ReadResult["value"], generations };
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

/** The App a default store serves: whose roles decide who manages it. */
type DefaultStoreApp = Pick<App, "id" | "owner"> & { createdAt: Date };

/**
 * The App whose default store `id` is (`app_default_stores`,
 * app-activation.ts), if it is one. Whether it is one is that table's
 * alone: a default store whose App row is gone is refused
 * (`data.store_unavailable`), never managed as a plain store by whoever
 * created it.
 */
const defaultStoreApp = async (
  env: Env,
  id: StoreId
): Promise<DefaultStoreApp | undefined> => {
  const row = await drizzle(env.DB)
    .select({
      id: apps.id,
      owner: apps.ownerId,
      createdAt: apps.createdAt,
    })
    .from(appDefaultStores)
    .leftJoin(apps, eq(apps.id, appDefaultStores.appId))
    .where(eq(appDefaultStores.storeId, id))
    .get();
  if (row === undefined) {
    return undefined;
  }
  if (row.id === null || row.owner === null || row.createdAt === null) {
    throw dataErrors.create("data.store_unavailable");
  }
  return {
    id: appIdSchema.parse(row.id),
    owner: row.owner,
    createdAt: row.createdAt,
  };
};

/**
 * The live store `id` if `by` manages it; otherwise `data.store_unavailable`,
 * as for a store that doesn't exist. An App's default store is managed by
 * whoever builds the App, as its App roles decide it on this call
 * (`requireAppRole`): the organization's admins and the App's builders,
 * never its creator as such, nor anyone it is shared with as a store
 * (`defaultOf` names the App). Any other store is managed by an admin, its
 * creator, or a person or team still in the organization it is shared with
 * in role `manage`, and only while their role in the organization builds.
 * `by`'s role and teams are taken as given: an identity read for this
 * call, as for App roles (see the threat model above).
 */
const managedBy = async (
  env: Env,
  by: Acting,
  id: string
): Promise<{ id: StoreId; owner: string; defaultOf?: DefaultStoreApp }> => {
  const parsed = storeIdSchema.safeParse(id);
  if (!parsed.success || !canBuild(by.role)) {
    throw dataErrors.create("data.store_unavailable");
  }
  const db = drizzle(env.DB);
  const app = await defaultStoreApp(env, parsed.data);
  if (app !== undefined) {
    try {
      await requireAppRole(env, by, app, "builder");
    } catch (error) {
      if (isExpectedError(error)) {
        throw dataErrors.create("data.store_unavailable");
      }
      throw error;
    }
  }
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
        app !== undefined || isAdmin(by.role)
          ? undefined
          : or(eq(businessStores.ownerId, by.userId), exists(shared))
      )
    )
    .get();
  if (row === undefined) {
    throw dataErrors.create("data.store_unavailable");
  }
  return {
    id: parsed.data,
    owner: row.owner,
    ...(app === undefined ? {} : { defaultOf: app }),
  };
};

/**
 * Refuses (`data.store_managed_by_app`) to share or unshare an App's
 * default store as a store: whom it serves follows the App's membership.
 */
const requireSharableStore = (store: { defaultOf?: DefaultStoreApp }): void => {
  if (store.defaultOf !== undefined) {
    throw dataErrors.create("data.store_managed_by_app");
  }
};

/**
 * Requires that `by` may bind store `id` to an App's release: they manage
 * it and aren't Grasp staff, as for sharing it, since a binding hands the
 * App's callers its records as sharing hands its managers them. Otherwise
 * `data.store_unavailable`, as for a store that doesn't exist, or
 * `role.forbidden` for staff.
 */
export const requireStoreManager = async (
  env: Env,
  by: Acting,
  id: string
): Promise<StoreId> => {
  requireNotStaff(by);
  const store = await managedBy(env, by, id);
  return store.id;
};

/**
 * That some sealed release is bound to store `id` (`sdk_resource_bindings`):
 * a retained consumer, which may still run (as current or pending, a
 * rollback target, a pinned run or an open screen's lease). Retention
 * deletes a release's bindings with it (release-retention.ts), so a
 * binding is there exactly while its release is kept.
 */
const boundSql = (id: StoreId): SQL =>
  sql`EXISTS (SELECT 1 FROM sdk_resource_bindings AS bound
    WHERE bound.kind = 'store' AND bound.target_id = ${id})`;

/**
 * Marks store `id` closing at `now` for the deletion `owner`, in one
 * statement that requires it live, bound to no sealed release, and not
 * closing for another deletion (unless that mark lapsed,
 * `storeClosingMs`): the mark a seal's binding (app-releases.ts) and
 * `setCurrentVersion` honour, so of this deletion and a seal that binds
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

/** The organization roles that build, and so may manage a store. */
const buildingRoles = ["admin", "builder"] as const;

/**
 * Who manages an App's default store besides the organization's admins,
 * in the shape of a store's managers: the App's owner, then whom the App
 * is shared with as builders, as App roles decide it (app-access.ts). A
 * person is listed only while still in the organization in a role that
 * builds, which caps their role in the App; a team while it exists, its
 * people each capped by their own role.
 */
const appBuilders = async (
  env: Env,
  app: DefaultStoreApp
): Promise<StoreManager[]> => {
  const db = drizzle(env.DB);
  const ownerBuilds = await db
    .select({ one: sql`1` })
    .from(apps)
    .where(and(eq(apps.id, app.id), activeMember(apps.ownerId, buildingRoles)))
    .get();
  const owner: StoreManager[] =
    ownerBuilds === undefined
      ? []
      : [
          {
            type: "person",
            id: app.owner,
            role: "manage",
            addedBy: app.owner,
            addedAt: app.createdAt.toISOString(),
          },
        ];
  const rows = await db
    .select()
    .from(appMembers)
    .where(
      and(
        eq(appMembers.appId, app.id),
        eq(appMembers.role, "builder"),
        or(
          and(
            eq(appMembers.memberType, "person"),
            activeMember(appMembers.memberId, buildingRoles)
          ),
          and(eq(appMembers.memberType, "team"), stillMembers(appMembers))
        )
      )
    )
    .orderBy(
      asc(appMembers.addedAt),
      asc(appMembers.memberType),
      asc(appMembers.memberId)
    );
  return [
    ...owner,
    ...rows.map((row): StoreManager => ({
      type: row.memberType,
      id: row.memberId,
      role: "manage",
      addedBy: row.addedBy,
      addedAt: row.addedAt.toISOString(),
    })),
  ];
};

/**
 * Deletes store `id` for `by`, who must manage it and isn't Grasp staff:
 * marked closing first, by this deletion alone (`markClosing`), and
 * refused, and audited, while another deletion holds the mark
 * (`data.store_closing`), while any sealed release an App keeps is bound
 * to it (`data.store_bound`: its calls would fail with
 * `data.store_unavailable`), or while a receipt not yet expired
 * refers to it (`data.store_in_use`: the store's object decides,
 * store-host.ts). The
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
  // Marked closing first, by this deletion alone, before its object is
  // touched: refused while any sealed release binds it, or while
  // another deletion holds the mark (it alone closes the store, or clears
  // the mark if its close is refused).
  const owner = crypto.randomUUID();
  if (!(await markClosing(env, store.id, owner, new Date()))) {
    const reason = (await boundToRelease(env, store.id))
      ? "data.store_bound"
      : "data.store_closing";
    const db = drizzle(env.DB);
    await auditedBatch(env, db, [
      outboxed(
        db,
        storeEntry(by, "store.delete_refused", store.id, { reason })
      ),
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
      .where(eq(businessStores.id, store.id))
      .get();
    if (held?.owner !== owner) {
      throw dataErrors.create("data.store_closing");
    }
    mark = await inJurisdiction(env, env.DATA_STORES)
      .getByName(store.id)
      .close(store.id, actor);
  } catch (error) {
    // Not deleted after all: its versions may be made current again. Only
    // this deletion's own mark, never one another took over since.
    await drizzle(env.DB)
      .update(businessStores)
      .set({ closingAt: null, closingOwner: null })
      .where(
        and(
          eq(businessStores.id, store.id),
          eq(businessStores.closingOwner, owner)
        )
      );
    if (dataErrors.codeOf(error) === "data.store_in_use") {
      const db = drizzle(env.DB);
      await auditedBatch(env, db, [
        outboxed(
          db,
          storeEntry(by, "store.delete_refused", store.id, {
            reason: "data.store_in_use",
          })
        ),
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
  requireSharableStore(store);
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
  requireSharableStore(store);
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
  if (store.defaultOf !== undefined) {
    return await appBuilders(env, store.defaultOf);
  }
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

/** Store `storeId`'s object, as core calls it, its ID bound to every call. */
const storeClient = (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  storeId: StoreId
): OpenStore => {
  const stub = inJurisdiction(env, env.DATA_STORES).getByName(storeId);
  return {
    id: storeId,
    defineTables: async (manifest, consumer, migrations) =>
      await stub.defineTables(storeId, manifest, consumer, migrations),
    get: async (table, recordId) => await stub.get(storeId, table, recordId),
    claim: async (claim) => claimedOf(await stub.claim({ ...claim, storeId })),
    commit: async (commit) =>
      committedSchema.parse(
        JSON.parse(await stub.commit({ ...commit, storeId }))
      ),
    read: async (scope, request, staged) =>
      readResultOf(await stub.read(storeId, scope, request, staged)),
    generations: async (names) => await stub.generations(storeId, names),
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
 * Discards fixture store `id`: its object refuses for any store the
 * inventory lists (`DataStore.discardFixture`).
 */
export const discardFixtureStore = async (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  id: StoreId
): Promise<void> => {
  await inJurisdiction(env, env.DATA_STORES).getByName(id).discardFixture(id);
};

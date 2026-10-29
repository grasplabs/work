import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { identifierSchema, storeIdSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { memberErrors } from "@grasp-os/shared/members";
import type { Erasure, ErasurePreview } from "@grasp-os/shared/members";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember, isRemoved, notRemoved } from "./auth/auth.ts";
import { directoryProviderId } from "./auth/config.ts";
import { personalWorkspaceId } from "./chats-rpc.ts";
import {
  accounts,
  erasedSubjects,
  channelAccounts,
  channelConversations,
  channelLinks,
  chatWorkflowOffers,
  invitations,
  notifications,
  chatAudiences,
  businessStores,
  knowledgeSignals,
  screenSubmissions,
  personErasureAreas,
  personErasures,
  sessions,
  teamMembers,
  users,
} from "./db/core/schema.ts";
import { workspace, inJurisdiction } from "./durable-objects.ts";
import {
  emailHashOf,
  emailKeyVersion,
  erasedAddress,
  subjectHashOf,
  subjectKeyVersion,
  subjectsOf,
} from "./erased-people.ts";

// Erasing a person (GRA-903), from its threat model (person-erasure.test.ts):
//
// - Only one of the client's own admins erases, never Grasp staff, the
//   person or anyone else (Nick's D4), and never themselves. Only someone
//   they removed already (members.ts): removing ends every session, keeps
//   them out of every sign-in, revokes what acts for them and disconnects
//   their personal connections, so erasing is a second, deliberate step on
//   someone already out.
// - Never the wrong person: the admin sees who it is first (`erasurePreview`)
//   and confirms with their name exactly as it stands now, so a stale ID or
//   a mix-up of two people is refused before anything changes.
// - Their name and ID stay, everything else of theirs goes (Nick's D1:
//   "user can be deleted but it should still show the name of the person,
//   so its still traceable"): `users` keeps both and nothing else, so every
//   company record that names them still does; the name the admin
//   confirmed is frozen in `person_erasures`.
// - They don't come back: their email goes, but a keyed hash of it stays
//   (`emailHashOf`, erased-people.ts), which sign-in (auth.ts) and
//   invitations (members.ts) check, as a removal keeps them out by their
//   ID. So does a keyed hash of every subject their sign-in accounts
//   named (`subjectsOf`): their Entra object id above all, which Teams
//   names them by and the directory would make them a member again by
//   (directory-members.ts), and their first sign-in checks too. The email
//   keeps out the address, not the person: an admin releases one the
//   company gives to someone else (`releaseAddress`), audited. Rotating the
//   deployment's auth secret changes the hash's key, and re-admits everyone
//   erased before it until that is handled (erased-people.ts).
// - Never half done for good: each area of the erasure is a step of its own,
//   all of it in one batch or none, marked complete in that batch. One that
//   fails stays pending and the clock tries it again (`retryErasures`), so
//   an erasure that stopped, however, is finished.
// - Recorded once, by IDs only: asking again while it runs, or after,
//   answers where it stands and records nothing more.

/** An area of a person's erasure: what it erases, in one batch, once. */
interface ErasureStep {
  readonly area: string;
  /**
   * Erases everything of `userId`'s in the area, and marks the area
   * complete in the same batch (`completed`), or nothing of it.
   */
  readonly erase: (env: Env, userId: string) => Promise<void>;
}

/**
 * Marks area `area` of `userId`'s erasure complete, if `done` holds as the
 * batch reaches it.
 */
const completed = (
  db: ReturnType<typeof drizzle>,
  userId: string,
  area: string,
  done: SQL = sql`1`
) =>
  db
    .update(personErasureAreas)
    .set({ state: "complete", updatedAt: new Date() })
    .where(
      and(
        eq(personErasureAreas.userId, userId),
        eq(personErasureAreas.area, area),
        done
      )
    );

/** Where an erased person's email was: an address nothing can deliver to. */
const erasedEmail = (userId: string): string =>
  `erased-${userId}@erased.invalid`;

/**
 * Their identity: their email (the address `users` keeps becomes one that
 * reaches nobody, and names nobody), whether it was verified, their
 * picture, every sign-in account and every session. Their name and ID stay.
 * What each account named them by stays as a keyed hash, written in the
 * batch that deletes the accounts, so there is never a moment when neither
 * keeps them out. Only the accounts whose subjects were hashed go: one
 * linked between the read and the batch stays, and so does the area,
 * pending, until the clock's next try hashes and deletes it too.
 */
const identity: ErasureStep = {
  area: "identity",
  erase: async (env, userId) => {
    const db = drizzle(env.DB);
    const held = await db
      .select({
        id: accounts.id,
        providerId: accounts.providerId,
        accountId: accounts.accountId,
        oid: accounts.oid,
      })
      .from(accounts)
      .where(eq(accounts.userId, userId));
    const subjects = new Set(
      held.flatMap((account) => subjectsOf(account, directoryProviderId))
    );
    const hashes = await Promise.all(
      [...subjects].map(async (subject) => await subjectHashOf(env, subject))
    );
    await db.batch([
      db
        .update(users)
        .set({
          email: erasedEmail(userId),
          emailVerified: false,
          image: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId)),
      ...hashes.map((subjectHash) =>
        db
          .insert(erasedSubjects)
          .values({ subjectHash, keyVersion: subjectKeyVersion, userId })
          .onConflictDoNothing()
      ),
      db.delete(accounts).where(
        and(
          eq(accounts.userId, userId),
          inArray(
            accounts.id,
            held.map(({ id }) => id)
          )
        )
      ),
      db.delete(sessions).where(eq(sessions.userId, userId)),
      completed(
        db,
        userId,
        "identity",
        sql`NOT EXISTS (
          SELECT 1 FROM ${accounts} WHERE ${accounts.userId} = ${userId}
        )`
      ),
    ]);
  },
};

/**
 * How they were reached, and what reached them (GRA-1182): their chat
 * accounts on every platform, the sign-in links they used to link one
 * (which carry their name there), their conversations with the agent,
 * the workflow offers it made them, the invitations made to the address
 * that was theirs, found by its keyed hash (`person_erasures`), so
 * whichever area runs first, their notifications, and their teams.
 * Removing them took out their chat accounts, notifications and teams
 * already; this takes them out again, in case any came back since.
 * Guest chats they opened for an App are the company's, naming them.
 */
const channels: ErasureStep = {
  area: "channels",
  erase: async (env, userId) => {
    const db = drizzle(env.DB);
    const [erasure] = await db
      .select({
        emailHash: personErasures.emailHash,
        keyVersion: personErasures.emailKeyVersion,
      })
      .from(personErasures)
      .where(eq(personErasures.userId, userId));
    if (erasure === undefined) {
      return;
    }
    // Under the key their hash was made with only: one made with an older
    // key matches no address hashed now (erased-people.ts), so their
    // invitations aren't found, and stay, until a rotation re-keys it.
    // Their address is the one whose hash is theirs: each address hashed
    // once, as invitations store it in any case.
    let address: string | undefined;
    if (erasure.keyVersion === emailKeyVersion) {
      const invited = await db
        .selectDistinct({ email: sql<string>`lower(${invitations.email})` })
        .from(invitations);
      for (const { email } of invited) {
        // oxlint-disable-next-line no-await-in-loop -- one address at a time
        if ((await emailHashOf(env, email)) === erasure.emailHash) {
          address = email;
          break;
        }
      }
    }
    // By the address itself, in one statement, however many invitations
    // went to it. Only those made before the erasure was asked for: none
    // could be made to it after (members.ts refuses an erased address)
    // until an admin released it and someone else was invited under it,
    // whose invitation stays.
    const theirInvitations =
      address === undefined
        ? []
        : [
            db.delete(invitations).where(
              and(
                sql`lower(${invitations.email}) = ${address}`,
                sql`${invitations.createdAt} <= (
                  SELECT ${personErasures.requestedAt} FROM ${personErasures}
                  WHERE ${personErasures.userId} = ${userId}
                )`
              )
            ),
          ];
    await db.batch([
      db.delete(channelAccounts).where(eq(channelAccounts.userId, userId)),
      db.delete(channelLinks).where(eq(channelLinks.usedBy, userId)),
      db
        .delete(channelConversations)
        .where(eq(channelConversations.userId, userId)),
      db
        .delete(chatWorkflowOffers)
        .where(eq(chatWorkflowOffers.userId, userId)),
      ...theirInvitations,
      db.delete(notifications).where(eq(notifications.personId, userId)),
      db.delete(teamMembers).where(eq(teamMembers.userId, userId)),
      completed(db, userId, "channels"),
    ]);
  },
};

/**
 * Their personal connections, in connect, the only place tokens live
 * (GRA-1183): disconnected again, each grant revoked at its provider, then
 * emptied of who their accounts were and of what calls through them
 * returned (connect's person-erasure.ts). Connect erases once, however
 * often it is asked; the area is complete once it answered.
 */
const connect: ErasureStep = {
  area: "connect",
  erase: async (env, userId) => {
    await env.CONNECT.erasePersonal({ ownerUserId: userId });
    await completed(drizzle(env.DB), userId, "connect");
  },
};

/**
 * Their workspace (GRA-1181): the object that holds their chats, their
 * messages, drafts and attachments, their projects, dashboard and email
 * settings, with what the Brain captured of their chats, any connection
 * granted in them, and the stores their drafts' previews wrote to. It is
 * theirs alone (`personalWorkspaceId`), and empties itself
 * (`Workspace.erasePerson`); the area is complete once it did, and its
 * chats' audiences are gone.
 */
const workspaceArea: ErasureStep = {
  area: "workspace",
  erase: async (env, userId) => {
    await workspace(env, personalWorkspaceId(userId)).erasePerson(userId);
    const db = drizzle(env.DB);
    // Who was in their chats, kept for each chat's agent (knowledge/
    // access.ts), goes with the chats. Shared chats elsewhere keep them in
    // their audience: those are the company's.
    await db.batch([
      db
        .delete(chatAudiences)
        .where(eq(chatAudiences.workspaceId, personalWorkspaceId(userId))),
      completed(db, userId, "workspace"),
    ]);
  },
};

/**
 * What they left in the company's Apps that is theirs alone (GRA-1184):
 * their preferences in every App's store (`sdk_preferences`, a host-owned
 * table no App code reaches), what their screens kept to recover their
 * submissions, and the usage signals computed for them as the owner of
 * Knowledge collections (what others asked there, counted, and what they
 * haven't read or reviewed), which the daily computation no longer makes
 * for anyone erased (knowledge/signals.ts). The Apps' records they own are
 * the company's (`_ownerId` names them), and stay. Every store is asked,
 * whether or not they were a member of its App now: a store's row is never
 * deleted (a deleted store keeps it, `deleted_at` set), so every store
 * there ever was is listed; one never set up holds nothing. Draft
 * previews' stores are their workspace's (GRA-1181).
 */
const apps: ErasureStep = {
  area: "apps",
  erase: async (env, userId) => {
    const db = drizzle(env.DB);
    const stores = await db
      .select({ id: businessStores.id })
      .from(businessStores);
    for (const { id } of stores) {
      const storeId = storeIdSchema.parse(id);
      // oxlint-disable-next-line no-await-in-loop -- one store at a time
      await inJurisdiction(env, env.DATA_STORES)
        .getByName(storeId)
        .forgetPreferences(storeId, userId);
    }
    await db.batch([
      db
        .delete(screenSubmissions)
        .where(eq(screenSubmissions.personId, userId)),
      db.delete(knowledgeSignals).where(eq(knowledgeSignals.owner, userId)),
      completed(db, userId, "apps"),
    ]);
  },
};

/**
 * The erasure's areas, in the order they run. Each area's own leaf of
 * GRA-903 adds its step here.
 */
const steps: readonly ErasureStep[] = [
  identity,
  channels,
  connect,
  workspaceArea,
  apps,
];

/** Refuses anyone but one of the client's admins, as members.ts does. */
const requireMemberAdmin = (by: Identity): void => {
  if (by.staff || !isAdmin(by.role)) {
    log.warn("member.refused", { actor: by.userId, reason: "role.forbidden" });
    throw roleErrors.create("role.forbidden");
  }
};

/** The person an admin names: an ID, never the admin themselves. */
const targetOf = (by: Identity, userId: unknown): string => {
  const parsed = identifierSchema.safeParse(userId);
  if (!parsed.success) {
    throw memberErrors.create("member.not_found");
  }
  if (parsed.data === by.userId) {
    throw memberErrors.create("member.self");
  }
  return parsed.data;
};

/** Where `userId`'s erasure stands, or null if none was asked for. */
const erasureOf = async (env: Env, userId: string): Promise<Erasure | null> => {
  const db = drizzle(env.DB);
  const [erasure] = await db
    .select({
      requestedAt: personErasures.requestedAt,
      completedAt: personErasures.completedAt,
    })
    .from(personErasures)
    .where(eq(personErasures.userId, userId));
  if (erasure === undefined) {
    return null;
  }
  const areas = await db
    .select({ area: personErasureAreas.area, state: personErasureAreas.state })
    .from(personErasureAreas)
    .where(eq(personErasureAreas.userId, userId));
  const order = new Map(steps.map(({ area }, index) => [area, index]));
  return {
    requestedAt: erasure.requestedAt.toISOString(),
    completedAt: erasure.completedAt?.toISOString() ?? null,
    areas: areas.toSorted(
      (one, other) =>
        (order.get(one.area) ?? steps.length) -
        (order.get(other.area) ?? steps.length)
    ),
  };
};

/**
 * Runs every area of `userId`'s erasure still pending, each on its own: one
 * that fails stays pending, for the clock to try again. Once every area is
 * complete the erasure is, recorded once as of who asked for it.
 */
const runErasure = async (env: Env, userId: string): Promise<void> => {
  const db = drizzle(env.DB);
  const pending = await db
    .select({ area: personErasureAreas.area })
    .from(personErasureAreas)
    .where(
      and(
        eq(personErasureAreas.userId, userId),
        eq(personErasureAreas.state, "pending")
      )
    );
  for (const { area } of pending) {
    const step = steps.find((each) => each.area === area);
    if (step === undefined) {
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one area at a time
      await step.erase(env, userId);
    } catch (error) {
      log.error("member.erasure_failed", { area, ...errorFields(error) });
      // oxlint-disable-next-line no-await-in-loop -- one area at a time
      await db
        .update(personErasureAreas)
        .set({
          attempts: sql`${personErasureAreas.attempts} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(personErasureAreas.userId, userId),
            eq(personErasureAreas.area, area)
          )
        );
    }
  }
  const [erasure] = await db
    .select({ requestedBy: personErasures.requestedBy })
    .from(personErasures)
    .where(eq(personErasures.userId, userId));
  if (erasure === undefined) {
    return;
  }
  const done: AuditEntry = {
    actor: { type: "person", userId: erasure.requestedBy },
    action: "member.erased",
    target: { type: "member", id: userId },
    detail: { userId },
  };
  await auditedBatch(env, db, [
    db
      .update(personErasures)
      .set({ completedAt: new Date() })
      .where(
        and(
          eq(personErasures.userId, userId),
          isNull(personErasures.completedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM ${personErasureAreas}
            WHERE ${personErasureAreas.userId} = ${userId}
              AND ${personErasureAreas.state} = 'pending'
          )`
        )
      ),
    outboxedIfChanged(db, done),
  ]);
};

/** The person `userId` as `users` has them now. */
const personOf = async (env: Env, userId: string) => {
  const [person] = await drizzle(env.DB)
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  return person;
};

/** Whether `userId`'s old address is kept out, not released. */
const addressKeptOut = async (env: Env, userId: string): Promise<boolean> => {
  const [row] = await drizzle(env.DB)
    .select({ hash: personErasures.emailHash })
    .from(personErasures)
    .where(eq(personErasures.userId, userId));
  return row?.hash !== undefined && row.hash !== null;
};

/**
 * What erasing `userId` would do, or where their erasure stands, for one of
 * the client's admins.
 */
export const erasurePreview = async (
  env: Env,
  by: Identity,
  userId: unknown
): Promise<ErasurePreview> => {
  requireMemberAdmin(by);
  const target = targetOf(by, userId);
  const person = await personOf(env, target);
  if (person === undefined) {
    throw memberErrors.create("member.not_found");
  }
  const erasure = await erasureOf(env, target);
  return {
    userId: target,
    name: person.name,
    email: erasure === null ? person.email : null,
    removed: await isRemoved(env, target),
    erasure,
    addressKeptOut: await addressKeptOut(env, target),
  };
};

/**
 * Erases the removed person `userId`, as one of the client's admins asked,
 * confirming them by `name` exactly as it stands now: records the erasure
 * and each of its areas pending, once, while the admin still is one and the
 * person is still removed, then runs it (`runErasure`). Asking again only
 * runs what is still pending, and answers where it stands.
 */
export const erasePerson = async (
  env: Env,
  by: Identity,
  userId: unknown,
  name: unknown
): Promise<Erasure> => {
  requireMemberAdmin(by);
  const target = targetOf(by, userId);
  const person = await personOf(env, target);
  if (person === undefined) {
    throw memberErrors.create("member.not_found");
  }
  if (!(await isRemoved(env, target))) {
    throw memberErrors.create("member.erase_not_removed");
  }
  if (typeof name !== "string" || name !== person.name) {
    throw memberErrors.create("member.erase_name_mismatch");
  }
  const db = drizzle(env.DB);
  const now = new Date();
  const emailHash = await emailHashOf(env, person.email);
  const asked = sql`${activeMember(by.userId, ["admin"])}
    AND NOT ${notRemoved(target)}
    AND NOT EXISTS (
      SELECT 1 FROM ${personErasures} WHERE ${personErasures.userId} = ${target}
    )`;
  const requested: AuditEntry = {
    actor: actorOf(by),
    action: "member.erasure.requested",
    target: { type: "member", id: target },
    detail: { userId: target },
  };
  await auditedBatch(env, db, [
    db
      .insert(personErasures)
      .select(
        sql`SELECT ${target}, ${person.name}, ${emailHash}, ${emailKeyVersion}, ${by.userId}, ${now.getTime()}, NULL
          WHERE ${asked}`
      )
      .onConflictDoNothing(),
    outboxedIfChanged(db, requested),
    ...steps.map(({ area }) =>
      db
        .insert(personErasureAreas)
        .select(
          sql`SELECT ${target}, ${area}, 'pending', 0, ${now.getTime()}
            WHERE EXISTS (
              SELECT 1 FROM ${personErasures}
              WHERE ${personErasures.userId} = ${target}
                AND ${personErasures.requestedAt} = ${now.getTime()}
            )`
        )
        .onConflictDoNothing()
    ),
  ]);
  const erasure = await erasureOf(env, target);
  if (erasure === null) {
    // Nothing went in: the admin stopped being one since their session
    // was checked.
    throw roleErrors.create("role.forbidden");
  }
  await runErasure(env, target);
  return (await erasureOf(env, target)) ?? erasure;
};

/**
 * Lets the address `email` in again, as one of the client's admins asked:
 * the company gave the address that was an erased person's to someone
 * else. Only the hash goes, while the admin still is one, recorded with
 * the erased person's ID only, never the address. Answers whether an
 * erased person's address it was.
 */
export const releaseAddress = async (
  env: Env,
  by: Identity,
  email: unknown
): Promise<{ released: boolean }> => {
  requireMemberAdmin(by);
  if (typeof email !== "string" || email.trim() === "") {
    throw memberErrors.create("member.invite_email");
  }
  const db = drizzle(env.DB);
  const hash = await emailHashOf(env, email);
  const [erased] = await db
    .select({ userId: personErasures.userId })
    .from(personErasures)
    .where(erasedAddress(hash));
  if (erased === undefined) {
    return { released: false };
  }
  const [released] = await auditedBatch(env, db, [
    db
      .update(personErasures)
      .set({ emailHash: null })
      .where(
        and(
          eq(personErasures.userId, erased.userId),
          erasedAddress(hash),
          activeMember(by.userId, ["admin"])
        )
      )
      .returning({ userId: personErasures.userId }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "member.address.released",
      target: { type: "member", id: erased.userId },
      detail: { userId: erased.userId },
    }),
  ]);
  if (released.length === 0) {
    throw roleErrors.create("role.forbidden");
  }
  return { released: true };
};

/**
 * Runs every erasure not yet complete again, oldest first: what failed
 * last time is tried once more, each person on their own.
 */
export const retryErasures = async (env: Env): Promise<void> => {
  const pending = await drizzle(env.DB)
    .select({ userId: personErasures.userId })
    .from(personErasures)
    .where(isNull(personErasures.completedAt))
    .orderBy(asc(personErasures.requestedAt));
  for (const { userId } of pending) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      await runErasure(env, userId);
    } catch (error) {
      log.error("member.erasure_failed", errorFields(error));
    }
  }
};

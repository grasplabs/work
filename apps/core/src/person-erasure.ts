import { preparePurge, purge } from "@grasp-os/brain/purge";
import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { identifierSchema, storeIdSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { memberErrors } from "@grasp-os/shared/members";
import type {
  Erasure,
  ErasureArea,
  ErasurePreview,
  ErasureRecordsPage,
  RemovedPeoplePage,
} from "@grasp-os/shared/members";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import {
  appendAuditEvent,
  auditedBatch,
  outboxedIfChanged,
} from "./audit-outbox.ts";
import {
  activeMember,
  isRemoved,
  notRemoved,
  organizationId,
} from "./auth/auth.ts";
import { directoryProviderId } from "./auth/config.ts";
import { personalWorkspaceId } from "./chats-rpc.ts";
import {
  accounts,
  businessStores,
  channelAccounts,
  channelConversations,
  channelLinks,
  chatAudiences,
  chatWorkflowOffers,
  erasedSubjects,
  invitations,
  knowledgeSignals,
  memberRemovals,
  notifications,
  personErasureAreas,
  personErasures,
  screenSubmissions,
  sessions,
  teamMembers,
  users,
  workflowDecisionConfirmations,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { workspace, inJurisdiction } from "./durable-objects.ts";
import {
  emailHashOf,
  emailKeyVersion,
  erasedAddress,
  subjectHashOf,
  subjectKeyVersion,
  subjectsOf,
} from "./erased-people.ts";
import { brainOf } from "./knowledge/ports.ts";
import { coreErasure } from "./knowledge/rpc.ts";
import { modelLedger } from "./model-ledger.ts";
import { onboardingStore } from "./onboarding/store.ts";
import { cancelRunsStartedBy } from "./workflows/controls.ts";
import { stopRunsFor } from "./workflows/resource-runs.ts";

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
 * Marks area `area` of `userId`'s erasure `state`, done one way or
 * another, if `done` holds as the batch reaches it.
 */
const marked = (
  db: ReturnType<typeof drizzle>,
  userId: string,
  area: string,
  state: "complete" | "skipped",
  done: SQL = sql`1`
) =>
  db
    .update(personErasureAreas)
    .set({ state, updatedAt: new Date() })
    .where(
      and(
        eq(personErasureAreas.userId, userId),
        eq(personErasureAreas.area, area),
        done
      )
    );

/**
 * Marks area `area` of `userId`'s erasure complete, if `done` holds as the
 * batch reaches it.
 */
const completed = (
  db: ReturnType<typeof drizzle>,
  userId: string,
  area: string,
  done: SQL = sql`1`
) => marked(db, userId, area, "complete", done);

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
 * What the Brain and Knowledge hold of them (GRA-1185), through the
 * Brain's own personal purge, the one way it erases a person (purge.ts),
 * as an admin's purge on the Knowledge page runs it, for the admin who
 * asked: their memories, their outcomes with the Brain's tombstone that
 * keeps them from coming back, their Personal collection with every
 * version, section, transcript and payload, core's copies of what they
 * gave (`coreErasure`), and the search index. It is one batch, safe to run
 * again, so a failure leaves the area pending and the clock runs it again.
 * Derived projections are GRA-309's, which the purge reaches as it grows.
 */
const brain: ErasureStep = {
  area: "brain",
  erase: async (env, userId) => {
    const db = drizzle(env.DB);
    const [erasure] = await db
      .select({ requestedBy: personErasures.requestedBy })
      .from(personErasures)
      .where(eq(personErasures.userId, userId));
    if (erasure === undefined) {
      return;
    }
    const by = {
      actor: { type: "person" as const, userId: erasure.requestedBy },
      userId: erasure.requestedBy,
    };
    const input = {
      type: "personal" as const,
      userId,
      reason: "erasure_request" as const,
    };
    const onErase = coreErasure(env);
    const plan = await preparePurge(brainOf(env), by, input, onErase);
    await purge(brainOf(env), by, input, plan.token, onErase);
    await completed(db, userId, "brain");
  },
};

/**
 * What still acts for them, and what of their decisions and limits is
 * theirs alone (GRA-1186). The runs they started are the company's
 * records (Nick's D3): kept, naming them by their ID and name, their
 * details removed only as run retention removes any run's. But nothing
 * goes on running for someone erased: every unfinished run of theirs, of
 * an App's workflow or an independent one, is cancelled or stopped as a
 * builder's is, audited, for the admin who asked. The area is complete
 * once each was asked to end; the engine ends it. A run that starts for
 * them after (a trigger of an App they own, a schedule of theirs) does
 * nothing: every step of every run checks first that the person it acts
 * for is still a member (`requireActivePerson`, the hosts'
 * `#requirePerson`), so it fails at its first step. Moving ownership of
 * what they owned is an admin's. Then the one-use
 * confirmations they were given to answer decisions, and the model limit
 * set for them alone, go. The decisions they answered keep who did, as
 * company history.
 */
const runs: ErasureStep = {
  area: "runs",
  erase: async (env, userId) => {
    const db = drizzle(env.DB);
    const [erasure] = await db
      .select({ requestedBy: personErasures.requestedBy })
      .from(personErasures)
      .where(eq(personErasures.userId, userId));
    if (erasure === undefined) {
      return;
    }
    const by = { userId: erasure.requestedBy, staff: false };
    const cancelled = await cancelRunsStartedBy(env, by, userId);
    const stopped = await stopRunsFor(env, actorOf(by), userId);
    if (cancelled.unasked > 0 || stopped.unasked > 0) {
      throw new Error("Runs of theirs are still to be asked to end");
    }
    await modelLedger(env).removePersonLimit(
      { type: "person", userId },
      actorOf(by)
    );
    await db.batch([
      db
        .delete(workflowDecisionConfirmations)
        .where(eq(workflowDecisionConfirmations.userId, userId)),
      completed(db, userId, "runs"),
    ]);
  },
};

/**
 * Their interview (GRA-1187), deleted as the onboarding deletes one on
 * its person's own request (`deleteOnRequest`): what they said and agreed
 * to, every drawing it was in, the Brain's records resting on it, and
 * Stephen's lines kept from it. Found on the list by the address that was
 * theirs, through its keyed hash, so whichever area ran first; once an
 * admin released the address, or under an older key, it is found no more.
 * Their entry on the list is the company's (Nick's D5): it stays, removed
 * only by an admin.
 */
const interview: ErasureStep = {
  area: "interview",
  erase: async (env, userId) => {
    const db = drizzle(env.DB);
    const [erasure] = await db
      .select({
        emailHash: personErasures.emailHash,
        keyVersion: personErasures.emailKeyVersion,
        requestedAt: personErasures.requestedAt,
      })
      .from(personErasures)
      .where(eq(personErasures.userId, userId));
    if (erasure === undefined) {
      return;
    }
    // Their address released, or hashed under an older key: they can't be
    // found on the list by it, and whatever interview they have is left.
    // Recorded as skipped, never as done.
    if (erasure.emailHash === null || erasure.keyVersion !== emailKeyVersion) {
      await marked(db, userId, "interview", "skipped");
      return;
    }
    const store = onboardingStore(env);
    let found = 0;
    for (const { id, email } of await store.rosterEmails()) {
      // oxlint-disable-next-line no-await-in-loop -- one entry at a time
      if ((await emailHashOf(env, email)) === erasure.emailHash) {
        // Only an interview from a link sent before the erasure was asked
        // for: the address may have been released, and a link sent to
        // the entry since, as this ran (`eraseInterviewOf`).
        // oxlint-disable-next-line no-await-in-loop -- one entry at a time
        await store.eraseInterviewOf(id, erasure.requestedAt.toISOString());
        found += 1;
      }
    }
    if (found === 0) {
      // Not on the list by the address they signed in with: an interview
      // under another address is left. IDs only.
      log.warn("member.erasure_interview_unmatched", { userId });
    }
    await completed(db, userId, "interview");
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
  interview,
  runs,
  brain,
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

/** `areas` in the order the erasure runs them; any it doesn't know last. */
const inStepOrder = (areas: readonly ErasureArea[]): ErasureArea[] => {
  const order = new Map(steps.map(({ area }, index) => [area, index]));
  return areas.toSorted(
    (one, other) =>
      (order.get(one.area) ?? steps.length) -
      (order.get(other.area) ?? steps.length)
  );
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
  return {
    requestedAt: erasure.requestedAt.toISOString(),
    completedAt: erasure.completedAt?.toISOString() ?? null,
    areas: inStepOrder(areas),
  };
};

/** The areas of the erasures of `userIds`, by the person erased. */
const areasByPerson = async (
  env: Env,
  userIds: readonly string[]
): Promise<Map<string, ErasureArea[]>> => {
  if (userIds.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({
      userId: personErasureAreas.userId,
      area: personErasureAreas.area,
      state: personErasureAreas.state,
    })
    .from(personErasureAreas)
    // One bound value however many: D1 binds at most 100.
    .where(inList(personErasureAreas.userId, userIds));
  const byPerson = new Map<string, ErasureArea[]>();
  for (const { userId, area, state } of rows) {
    byPerson.set(userId, [...(byPerson.get(userId) ?? []), { area, state }]);
  }
  return byPerson;
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
    areas: steps.map(({ area }) => area),
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

/** The most people a page of `removedPeople` or `erasureRecords` holds. */
export const erasurePageSize = 100;

const cursorSchema = z
  .object({ at: z.iso.datetime(), userId: identifierSchema })
  .optional();

/**
 * The page before `before` (by `at`, then the person's ID, both newest
 * first), as SQL on `at` and `userId`: none for the latest page. A cursor
 * that isn't one is `member.invalid`.
 */
const pageBefore = (
  before: unknown,
  at: SQLiteColumn,
  userId: SQLiteColumn
): SQL | undefined => {
  const cursor = cursorSchema.safeParse(before);
  if (!cursor.success) {
    throw memberErrors.create("member.invalid");
  }
  return cursor.data === undefined
    ? undefined
    : sql`(${at}, ${userId}) < (${new Date(cursor.data.at).getTime()}, ${cursor.data.userId})`;
};

/**
 * The people admins removed, most recently first, with where each one's
 * erasure stands, for one of the client's admins: whom they may erase. The
 * latest page, or the page before `before`.
 */
export const removedPeople = async (
  env: Env,
  by: Identity,
  before?: unknown
): Promise<RemovedPeoplePage> => {
  requireMemberAdmin(by);
  const after = pageBefore(
    before,
    memberRemovals.removedAt,
    memberRemovals.userId
  );
  const rows = await drizzle(env.DB)
    .select({
      userId: memberRemovals.userId,
      name: users.name,
      email: users.email,
      removedAt: memberRemovals.removedAt,
      requestedAt: personErasures.requestedAt,
      completedAt: personErasures.completedAt,
      emailHash: personErasures.emailHash,
    })
    .from(memberRemovals)
    .innerJoin(users, eq(users.id, memberRemovals.userId))
    .leftJoin(personErasures, eq(personErasures.userId, memberRemovals.userId))
    .where(and(eq(memberRemovals.organizationId, organizationId), after))
    .orderBy(desc(memberRemovals.removedAt), desc(memberRemovals.userId))
    // One past the page: whether more follow.
    .limit(erasurePageSize + 1);
  const page = rows.slice(0, erasurePageSize);
  const areas = await areasByPerson(
    env,
    page.flatMap((row) => (row.requestedAt === null ? [] : [row.userId]))
  );
  return {
    people: page.map((row) => ({
      userId: row.userId,
      name: row.name,
      email: row.requestedAt === null ? row.email : null,
      removedAt: row.removedAt.toISOString(),
      erasure:
        row.requestedAt === null
          ? null
          : {
              requestedAt: row.requestedAt.toISOString(),
              completedAt: row.completedAt?.toISOString() ?? null,
              areas: inStepOrder(areas.get(row.userId) ?? []),
            },
      addressKeptOut: row.emailHash !== null,
    })),
    more: rows.length > erasurePageSize,
  };
};

const requesters = alias(users, "requesters");

/**
 * Every erasure, newest first, for Grasp's staff alone: who was erased, by
 * ID and the name the admin confirmed, who asked and where it stands. The
 * latest page, or the page before `before`. Recorded as the staff
 * member's before it is read: a log that can't take it refuses the read.
 */
export const erasureRecords = async (
  env: Env,
  by: Identity,
  before?: unknown
): Promise<ErasureRecordsPage> => {
  // Staff let in for the onboarding alone see only it.
  if (!by.staff || by.onboardingOnly === true) {
    log.warn("member.refused", { actor: by.userId, reason: "role.forbidden" });
    throw roleErrors.create("role.forbidden");
  }
  const after = pageBefore(
    before,
    personErasures.requestedAt,
    personErasures.userId
  );
  await appendAuditEvent(env, {
    actor: actorOf(by),
    action: "member.erasures.viewed",
    target: { type: "organization", id: organizationId },
    detail: {},
  });
  const rows = await drizzle(env.DB)
    .select({
      userId: personErasures.userId,
      name: personErasures.name,
      requestedAt: personErasures.requestedAt,
      completedAt: personErasures.completedAt,
      requestedBy: personErasures.requestedBy,
      requesterName: requesters.name,
    })
    .from(personErasures)
    .leftJoin(requesters, eq(requesters.id, personErasures.requestedBy))
    .where(after)
    .orderBy(desc(personErasures.requestedAt), desc(personErasures.userId))
    // One past the page: whether more follow.
    .limit(erasurePageSize + 1);
  const page = rows.slice(0, erasurePageSize);
  const areas = await areasByPerson(
    env,
    page.map(({ userId }) => userId)
  );
  return {
    records: page.map((row) => ({
      userId: row.userId,
      name: row.name,
      requestedAt: row.requestedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      requestedBy: { userId: row.requestedBy, name: row.requesterName ?? "" },
      areas: inStepOrder(areas.get(row.userId) ?? []),
    })),
    more: rows.length > erasurePageSize,
  };
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

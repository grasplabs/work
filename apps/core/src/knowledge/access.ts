import type { ReadRecord } from "@grasp-os/brain/authorize";
import { collections } from "@grasp-os/brain/schema";
import {
  actorOf,
  auditProvenanceMaxItems,
  delegateActorOf,
} from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import type { PermissionId } from "@grasp-os/shared/ids";
import type { Provenance } from "@grasp-os/shared/knowledge";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { keepAuditEvent } from "../audit-outbox.ts";
import { memberRole, teamsOf } from "../auth/identity.ts";
import {
  chatAudiences,
  collectionTeams,
  teamMembers,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { grantedPermissions } from "../permissions.ts";
import { restrict } from "../restricted.ts";
import type { WorkContext } from "../restricted.ts";

// The one place core decides what Knowledge may be read by whom: the
// host side of Knowledge's `authorize` port (app-entries.ts `authorize`
// adds the Apps collection's entries; authorize.ts puts the answer inside
// every read's SQL). Core's own reads of Knowledge (uploads, signals,
// memory, history) use these conditions directly.
//
// A person reads a collection for everyone, one of their teams', or one
// they own. An App or agent reads the collections it has a permission to
// read, never a personal one, and of those only the ones the person it
// acts for may read too
// (R5): a grant never reaches past that person. The one exception is an
// agent's memory (`readableForPerson`), which reads what the person may
// read, without a grant, and only their memory files. What anyone reads is
// marked with where it came from and recorded in the audit log, and
// restricted data puts the chat or App an App or agent works in in
// restricted mode (`noteProvenance`).
//
// In a chat others share (a group chat or channel on a chat platform), an
// agent reads only what every member of the chat may read
// (`audienceCondition`), whoever asked: never a personal collection, nor
// one for admins, nor one shared with teams that leave any member out, nor
// anything at all while someone Grasp can't name as an active member is
// in it (a guest, another company's people).

/**
 * Who reads Knowledge: a signed-in person, or an App or agent acting for
 * one in a chat or App. `permissionId` limits an App or agent to that one
 * permission: its stub's.
 *
 * A person's reads never put anything in restricted mode: a person has no
 * context to restrict. So an App or agent reads only as a delegate, through
 * its stubs (knowledge/binding.ts), never through a person's reader, or
 * restricted data would reach it without restricting it.
 */
export type Reader =
  | { type: "person"; person: Identity }
  | {
      type: "delegate";
      authority: Authority;
      context: WorkContext;
      permissionId?: PermissionId;
    };

/** A person, as far as reading Knowledge goes. */
export interface PersonAccess {
  userId: string;
  teamIds: string[];
  /** An admin (Grasp staff included): reads the collections for admins. */
  admin: boolean;
}

/**
 * The collections shared with any of `teamIds`, read now from core's
 * `collection_teams`.
 */
const sharedWith = async (
  env: Env,
  teamIds: readonly string[]
): Promise<string[]> => {
  if (teamIds.length === 0) {
    return [];
  }
  const rows = await drizzle(env.DB)
    .selectDistinct({ id: collectionTeams.collectionId })
    .from(collectionTeams)
    .where(inList(collectionTeams.teamId, teamIds));
  return rows.map(({ id }) => id);
};

/**
 * Collections a person may read, as a condition on `collections`, with
 * the collections shared with their teams (`sharedWith`).
 */
const readableBy = async (
  env: Env,
  { userId, teamIds, admin }: PersonAccess
): Promise<SQL> => {
  const shared = await sharedWith(env, teamIds);
  return (
    or(
      eq(collections.access, "everyone"),
      admin ? eq(collections.access, "admins") : undefined,
      // Its owner always, also of a team collection for teams they aren't
      // in; but one for admins only while they are one: owning it gives
      // nothing.
      and(eq(collections.owner, userId), ne(collections.access, "admins")),
      shared.length === 0
        ? undefined
        : and(eq(collections.access, "teams"), inList(collections.id, shared))
    ) ?? sql`0`
  );
};

/** Who is in a chat others share, as `chat_audiences` keeps them. */
export interface Audience {
  members: readonly string[];
  /** Someone Grasp can't name as one of the organization's members. */
  outsiders: boolean;
}

/**
 * The most members an audience is read for: past it, the chat reads
 * nothing, as if someone in it couldn't be named. A Teams channel's whole
 * team can be thousands; deciding for each is no answer's work.
 */
export const audienceMaxMembers = 1000;

/** The audience of the chat `context` is, if others share it. */
export const audienceOf = async (
  env: Env,
  context: WorkContext
): Promise<Audience | undefined> => {
  if (context.type !== "chat") {
    return undefined;
  }
  const [row] = await drizzle(env.DB)
    .select({
      workspaceId: chatAudiences.workspaceId,
      members: chatAudiences.members,
      outsiders: chatAudiences.outsiders,
    })
    .from(chatAudiences)
    .where(eq(chatAudiences.chatId, context.chatId))
    .limit(1);
  if (row === undefined) {
    return undefined;
  }
  // Kept by another Workspace object's chat of that id: read as nothing.
  if (row.workspaceId !== context.workspaceId) {
    return { members: [], outsiders: true };
  }
  return { members: row.members, outsiders: row.outsiders };
};

/**
 * Keeps who is in the chat `chatId`, held by the Workspace object
 * `workspaceId`, for its agent's reads from now on: the person who asked
 * always among them.
 */
export const keepAudience = async (
  env: Env,
  { workspaceId, chatId }: { workspaceId: string; chatId: string },
  asker: string,
  { members, outsiders }: Audience
): Promise<void> => {
  const kept = {
    members: [...new Set([asker, ...members])],
    outsiders,
    updatedAt: new Date(),
  };
  await drizzle(env.DB)
    .insert(chatAudiences)
    .values({ chatId, workspaceId, ...kept })
    .onConflictDoUpdate({ target: chatAudiences.chatId, set: kept });
};

/**
 * The chats others share that count `reader` in their audience now, by
 * chat ID, as `chat_audiences` keeps them before each turn: none once
 * they are no longer one of the organization's members. The audiences
 * whose shared events reach them (the Brain's `audiences` port). Only a
 * person: an App or agent reaches no shared session's events.
 */
export const audiencesOf = async (
  env: Env,
  reader: Reader
): Promise<string[]> => {
  if (reader.type !== "person") {
    return [];
  }
  const { userId } = reader.person;
  if ((await memberRole(env.DB, userId)) === undefined) {
    return [];
  }
  const rows = await drizzle(env.DB)
    .select({ chatId: chatAudiences.chatId })
    .from(chatAudiences)
    .where(
      sql`EXISTS (SELECT 1 FROM json_each(${chatAudiences.members}) WHERE json_each.value = ${userId})`
    );
  return rows.map(({ chatId }) => chatId);
};

/**
 * Collections every member of `audience` may read, as a condition on
 * `collections`: those for everyone, and those for teams that hold each
 * member through one team or another, as `readableBy` reads them for each.
 * Never a personal collection or one for admins, and no owner's exception:
 * a collection its owner alone reads is read by no audience. Nothing while
 * the audience has anyone Grasp can't name, or is too large to decide.
 */
const readableByAll = async (env: Env, audience: Audience): Promise<SQL> => {
  const { members, outsiders } = audience;
  if (
    outsiders ||
    members.length === 0 ||
    members.length > audienceMaxMembers
  ) {
    return sql`0`;
  }
  const db = drizzle(env.DB);
  const memberships = await db
    .select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(inList(teamMembers.userId, members));
  const teamsByMember = new Map<string, Set<string>>();
  for (const { userId, teamId } of memberships) {
    const each = teamsByMember.get(userId) ?? new Set<string>();
    each.add(teamId);
    teamsByMember.set(userId, each);
  }
  const allTeams = [...new Set(memberships.map(({ teamId }) => teamId))];
  const shares =
    allTeams.length === 0
      ? []
      : await db
          .select({
            collectionId: collectionTeams.collectionId,
            teamId: collectionTeams.teamId,
          })
          .from(collectionTeams)
          .where(inList(collectionTeams.teamId, allTeams));
  const teamsByCollection = new Map<string, Set<string>>();
  for (const { collectionId, teamId } of shares) {
    const each = teamsByCollection.get(collectionId) ?? new Set<string>();
    each.add(teamId);
    teamsByCollection.set(collectionId, each);
  }
  const forEveryMember = [...teamsByCollection].flatMap(([id, shared]) =>
    members.every((member) =>
      [...(teamsByMember.get(member) ?? [])].some((team) => shared.has(team))
    )
      ? [id]
      : []
  );
  return (
    or(
      eq(collections.access, "everyone"),
      forEveryMember.length === 0
        ? undefined
        : and(
            eq(collections.access, "teams"),
            inList(collections.id, forEveryMember)
          )
    ) ?? sql`0`
  );
};

/**
 * What an agent working in `context` may read for the chat's audience, as
 * a condition on `collections`: undefined for a context nobody else shares.
 */
export const audienceCondition = async (
  env: Env,
  context: WorkContext
): Promise<SQL | undefined> => {
  const audience = await audienceOf(env, context);
  return audience === undefined
    ? undefined
    : await readableByAll(env, audience);
};

/** A collection as `mayRead` needs it: its access, owner and teams. */
export interface CollectionAccess {
  access: (typeof collections.$inferSelect)["access"];
  owner: string;
  teamIds: readonly string[];
}

/**
 * Whether `person` may read `collection`: `readableBy`'s rule, decided in
 * memory, for checking many people against collections read once (sharing
 * an App, app-provenance.ts). The two must always agree: a new kind of
 * access doesn't compile here until it is decided.
 */
export const mayRead = (
  { userId, teamIds, admin }: PersonAccess,
  { access, owner, teamIds: shared }: CollectionAccess
): boolean => {
  // One for admins only while they are one, whoever owns it.
  if (access === "admins") {
    return admin;
  }
  // Its owner always, also of a team collection for teams they aren't in.
  if (owner === userId) {
    return true;
  }
  switch (access) {
    case "everyone": {
      return true;
    }
    case "teams": {
      return shared.some((team) => teamIds.includes(team));
    }
    case "me": {
      return false;
    }
    default: {
      return access satisfies never;
    }
  }
};

/**
 * The collections the App or agent may read under its permissions (only
 * `permissionId`, when given), read now. Throws `permission.person_inactive`
 * when the person it acts for has left, and `permission.denied` when
 * `permissionId` doesn't allow reading any more.
 */
const grantedToRead = async (
  env: Env,
  authority: Authority,
  permissionId: PermissionId | undefined
): Promise<string[]> => {
  const granted = await grantedPermissions(env, authority);
  const ids = granted.flatMap(({ id, object, actions }) =>
    object.type === "collection" &&
    actions.includes("read") &&
    (permissionId === undefined || id === permissionId)
      ? [object.collectionId]
      : []
  );
  if (permissionId !== undefined && ids.length === 0) {
    throw permissionErrors.create("permission.denied", { action: "read" });
  }
  return ids;
};

/** The collections a reader may read, and for a delegate, those granted. */
export interface CollectionsAllowed {
  /** A condition on `collections`. */
  condition: SQL;
  /**
   * The collections an App or agent is granted to read, read now (every
   * collection's own rule applies on top); undefined for a person.
   */
  granted: readonly string[] | undefined;
  /**
   * Whether the reader works in a chat others share: what it reads is
   * read for all of them (`audienceCondition`).
   */
  shared: boolean;
}

/**
 * The collections `reader` may read (`condition`), and those an App or
 * agent is granted.
 */
export const collectionsAllowed = async (
  env: Env,
  db: DrizzleD1Database,
  reader: Reader
): Promise<CollectionsAllowed> => {
  if (reader.type === "person") {
    const { userId, teams, role } = reader.person;
    return {
      condition: await readableBy(env, {
        userId,
        teamIds: teams.map(({ id }) => id),
        admin: isAdmin(role),
      }),
      granted: undefined,
      shared: false,
    };
  }
  const { authority, permissionId, context } = reader;
  const [granted, audience] = await Promise.all([
    grantedToRead(env, authority, permissionId),
    audienceCondition(env, context),
  ]);
  const shared = audience !== undefined;
  if (granted.length === 0) {
    return { condition: sql`0`, granted, shared };
  }
  const teams = await teamsOf(env.DB, authority.onBehalfOf);
  return {
    condition:
      and(
        inList(collections.id, granted),
        // A personal collection is never read under a grant: an App is
        // shared, and a grant isn't the person's own. What an agent reads
        // of its person's own collection (their USER.md) it reads as
        // memory, through `readableForPerson`.
        ne(collections.access, "me"),
        // Nor one for admins: what the onboarding holds stays with people.
        ne(collections.access, "admins"),
        await readableBy(env, {
          userId: authority.onBehalfOf,
          teamIds: teams.map(({ id }) => id),
          admin: false,
        }),
        audience
      ) ?? sql`0`,
    granted,
    shared,
  };
};

/** The collections `reader` may read, as a condition on `collections`. */
export const allowedCollections = async (
  env: Env,
  db: DrizzleD1Database,
  reader: Reader
): Promise<SQL> => {
  const { condition } = await collectionsAllowed(env, db, reader);
  return condition;
};

/**
 * The collections the person `userId` may read themselves, their teams
 * read now, as a condition on `collections`. Only for memory (memory.ts):
 * an agent's memory is the person's own files and the company's, which it
 * gets without a permission, in the contexts that are that person's own.
 * Every other read by an App or agent goes through `allowedCollections`.
 */
export const readableForPerson = async (
  env: Env,
  db: DrizzleD1Database,
  userId: string
): Promise<SQL> => {
  const teams = await teamsOf(env.DB, userId);
  // Memory is the person's own files and the company's: never admins'.
  return await readableBy(env, {
    userId,
    teamIds: teams.map(({ id }) => id),
    admin: false,
  });
};

/** Who read, as the audit log names them. */
export const readerActor = (reader: Reader): AuditActor =>
  reader.type === "person"
    ? actorOf(reader.person)
    : delegateActorOf(reader.authority);

/**
 * Where a delegate read, for its read's audit event: every chat's agent
 * and every App is the organization's, so which chat or run read
 * (GRA-1067: a run's reads, a recall among them, are recorded with it).
 */
const readIn = (
  reader: Reader
): { chat: string } | { run: string } | Record<string, never> => {
  if (reader.type !== "delegate") {
    return {};
  }
  const { context } = reader;
  if (context.type === "chat") {
    return { chat: context.chatId };
  }
  return context.type === "run" || context.type === "workflowRun"
    ? { run: context.runId }
    : {};
};

/**
 * Knowledge's `onRead` port (ports.ts): notes where what `reader` read came from, `sources` (a collection, or
 * those a search found something in; none when it found nothing), and
 * returns the read's provenance. Call it after the read and before handing
 * over what it returned: an App or agent that read restricted data puts
 * its chat or App in restricted mode first, so the data never reaches
 * anything that can still call out. If that fails, the read fails, and
 * isn't recorded as one (entering restricted mode is, in restricted.ts).
 *
 * Then the read is recorded (R16), whoever read, staff included: `record`,
 * with the collections it read from and the documents it names as the
 * event's provenance, and whether any was sensitive. Through the Knowledge
 * outbox, which never fails the read (`keepAuditEvent`): what was read is
 * read, and a read that can't be recorded there goes straight to the log,
 * or to the logs.
 */
export const noteProvenance = async (
  env: Env,
  reader: Reader,
  record: ReadRecord,
  ...sources: { id: string; sensitive: boolean }[]
): Promise<Provenance> => {
  const sensitive = sources.some((source) => source.sensitive);
  const provenance: Provenance = {
    collectionIds: [...new Set(sources.map(({ id }) => id))].map((id) =>
      collectionIdSchema.parse(id)
    ),
    sensitive,
    // A sensitive collection holds restricted data (threat model Q12).
    restricted: sensitive,
  };
  if (provenance.restricted && reader.type === "delegate") {
    await restrict(
      env,
      reader.authority,
      reader.context,
      provenance.collectionIds
    );
  }
  const { action, target, documentIds = [], detail } = record;
  await keepAuditEvent(env, drizzle(env.KNOWLEDGE), {
    actor: readerActor(reader),
    action,
    target,
    // At most one collection per document a search returns, and a search
    // returns at most `searchMaxLimit` (50): both fit.
    provenance: [
      ...new Set([...provenance.collectionIds, ...documentIds]),
    ].slice(0, auditProvenanceMaxItems),
    detail: { ...detail, sensitive, ...readIn(reader) },
  });
  return provenance;
};

/**
 * Whether `person` may change a collection they can read: its owner and
 * admins always; anyone who can read a team or personal collection. A
 * collection for everyone is read by everyone but changed only by its
 * owner and admins.
 */
export const canWrite = (
  person: Pick<Identity, "userId" | "role">,
  collection: { owner: string; access: string }
): boolean =>
  collection.access !== "everyone" ||
  collection.owner === person.userId ||
  person.role === "admin";

/** Whether `person` may create a collection with `access`. */
export const canCreate = (person: Identity, access: string): boolean =>
  access === "me" || person.role === "admin";

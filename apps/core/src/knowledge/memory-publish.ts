import { brainErrors, brainSourceRefSchema } from "@grasp-os/brain/contract";
import type { BrainSourceRef } from "@grasp-os/brain/contract";
import { brainMemories, collections } from "@grasp-os/brain/schema";
import { isAdmin, isMemberAdmin } from "@grasp-os/shared/roles";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { organizationId } from "../auth/auth.ts";
import {
  chatAudiences,
  collectionTeams,
  members,
  teamMembers,
  teams,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { mayRead } from "./access.ts";
import type { PersonAccess, Reader } from "./access.ts";

// Who may publish a Brain memory record into a shared scope, and on what
// (GRA-298; the threat model is on the issue): the Brain's `mayPublish`
// port. The Brain asks, core decides, as for every other read and write.
//
// - Only a signed-in person publishes: an agent, an App or a run never.
// - The company's scope: one of the organization's own admins, never
//   Grasp staff. A team's: a current member of one of the organization's.
//   A chat's session: a member of its audience, which must be known and
//   all the company's.
// - What a record rests on, its whole audience may read: every document
//   it cites is in a collection every current member of the team or chat
//   may read, or, for the company, one everyone reads that isn't
//   sensitive. Rewording private material doesn't make it shared.
//   Anything else is refused as one that isn't there (`brain.not_found`).

const refsSchema = z.array(brainSourceRefSchema);

/** The refusal of a scope that isn't the publisher's. */
const denied = () => brainErrors.create("brain.denied");

/** Who a scope's records reach: its members, or everyone in the company. */
type ScopeAudience = { company: true } | { people: PersonAccess[] };

/** `userIds` as reading Knowledge takes them: active members only. */
const accessOf = async (
  env: Env,
  userIds: readonly string[]
): Promise<PersonAccess[]> => {
  const db = drizzle(env.DB);
  const [active, memberships] = await Promise.all([
    db
      .select({ userId: members.userId, role: members.role })
      .from(members)
      .where(
        and(
          eq(members.organizationId, organizationId),
          inList(members.userId, userIds)
        )
      ),
    db
      .select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(inList(teamMembers.userId, userIds)),
  ]);
  return active.map(({ userId, role }) => ({
    userId,
    admin: isAdmin(role),
    teamIds: memberships
      .filter((membership) => membership.userId === userId)
      .map(({ teamId }) => teamId),
  }));
};

/**
 * The audience of `target` that `userId` may publish to, or a refusal
 * (`brain.denied`) where the scope isn't theirs.
 */
const audienceOf = async (
  env: Env,
  person: { userId: string; role: string; staff: boolean },
  target: { scope: "team" | "company" | "session"; scopeId: string | null }
): Promise<ScopeAudience> => {
  if (target.scope === "company") {
    if (!isMemberAdmin(person)) {
      throw denied();
    }
    return { company: true };
  }
  if (target.scopeId === null) {
    throw denied();
  }
  const db = drizzle(env.DB);
  let userIds: string[];
  if (target.scope === "team") {
    const rows = await db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(
        and(
          eq(teamMembers.teamId, target.scopeId),
          eq(teams.organizationId, organizationId)
        )
      );
    userIds = rows.map(({ userId }) => userId);
  } else {
    const [row] = await db
      .select({
        members: chatAudiences.members,
        outsiders: chatAudiences.outsiders,
      })
      .from(chatAudiences)
      .where(eq(chatAudiences.chatId, target.scopeId))
      .limit(1);
    if (row === undefined || row.outsiders) {
      throw denied();
    }
    userIds = row.members;
  }
  if (!userIds.includes(person.userId)) {
    throw denied();
  }
  return { people: await accessOf(env, userIds) };
};

/** `ids`' collections with what reading one takes, and their teams. */
const collectionsOf = async (env: Env, ids: readonly string[]) => {
  const [rows, shares] = await Promise.all([
    drizzle(env.KNOWLEDGE)
      .select({
        id: collections.id,
        access: collections.access,
        owner: collections.owner,
        sensitive: collections.sensitive,
      })
      .from(collections)
      .where(inList(collections.id, ids)),
    drizzle(env.DB)
      .select({
        collectionId: collectionTeams.collectionId,
        teamId: collectionTeams.teamId,
      })
      .from(collectionTeams)
      .where(inList(collectionTeams.collectionId, ids)),
  ]);
  return rows.map((row) => ({
    ...row,
    teamIds: shares
      .filter(({ collectionId }) => collectionId === row.id)
      .map(({ teamId }) => teamId),
  }));
};

/** Those of `ids` everyone in the company reads, none of them sensitive. */
const readableByEveryone = async (
  env: Env,
  ids: readonly string[]
): Promise<Set<string>> => {
  const found = await collectionsOf(env, ids);
  return new Set(
    found
      .filter(({ access, sensitive }) => access === "everyone" && !sensitive)
      .map(({ id }) => id)
  );
};

/** Those of `ids` every one of `people` may read (`mayRead`). */
const readableByPeople = async (
  env: Env,
  people: readonly PersonAccess[],
  ids: readonly string[]
): Promise<Set<string>> => {
  const found = await collectionsOf(env, ids);
  return new Set(
    found
      .filter((collection) =>
        people.every((person) => mayRead(person, collection))
      )
      .map(({ id }) => id)
  );
};

/**
 * Those of the collections `ids` every one of `userIds` may read now, as
 * active members of the company: none for an empty audience, or one
 * whose people have all left.
 */
export const readableByAll = async (
  env: Env,
  userIds: readonly string[],
  ids: readonly string[]
): Promise<Set<string>> => {
  const people = await accessOf(env, userIds);
  return people.length === 0 || people.length < userIds.length
    ? new Set()
    : await readableByPeople(env, people, ids);
};

/**
 * Core's `mayPublish` port: refuses, as `brain.denied`, a publication by
 * anyone but a person whose scope `target` is, and, as `brain.not_found`,
 * one citing a document that scope's whole audience may not read.
 */
export const mayPublish = async (
  env: Env,
  reader: Reader,
  target: { scope: "team" | "company" | "session"; scopeId: string | null },
  refs: readonly BrainSourceRef[]
): Promise<void> => {
  if (reader.type !== "person") {
    throw brainErrors.create("brain.denied");
  }
  const audience = await audienceOf(env, reader.person, target);
  // A memory it cites is read through: the documents that one rests on
  // must be the scope's whole audience's too.
  const memoryIds = refs.flatMap((ref) =>
    ref.kind === "memory" ? [ref.memoryId] : []
  );
  const cited =
    memoryIds.length === 0
      ? []
      : await drizzle(env.KNOWLEDGE)
          .select({ sourceRefs: brainMemories.sourceRefs })
          .from(brainMemories)
          .where(inList(brainMemories.id, memoryIds));
  const throughMemories = cited.flatMap(({ sourceRefs }) =>
    refsSchema.parse(JSON.parse(sourceRefs))
  );
  const ids = [
    ...new Set(
      [...refs, ...throughMemories].flatMap((ref) =>
        ref.kind === "document" ? [ref.collectionId] : []
      )
    ),
  ];
  if (ids.length === 0) {
    return;
  }
  const readable =
    "company" in audience
      ? await readableByEveryone(env, ids)
      : await readableByPeople(env, audience.people, ids);
  if (!ids.every((id) => readable.has(id))) {
    throw brainErrors.create("brain.not_found");
  }
};

/**
 * Core's `mayRetire` port: a shared record is retired by whoever published
 * it, or by one of the organization's own admins; anyone else is refused
 * as one that isn't there.
 */
export const mayRetire = async (
  reader: Reader,
  record: { ownerId: string }
): Promise<void> => {
  const allowed =
    reader.type === "person" &&
    (record.ownerId === reader.person.userId || isMemberAdmin(reader.person));
  if (!allowed) {
    throw brainErrors.create("brain.not_found");
  }
  await Promise.resolve();
};

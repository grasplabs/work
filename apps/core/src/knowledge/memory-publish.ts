import { brainErrors } from "@grasp-os/brain/contract";
import type { BrainSourceRef } from "@grasp-os/brain/contract";
import { collections } from "@grasp-os/brain/schema";
import { isAdmin } from "@grasp-os/shared/roles";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  chatAudiences,
  collectionTeams,
  members,
  teamMembers,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { mayRead } from "./access.ts";
import type { PersonAccess, Reader } from "./access.ts";

// Who may publish a Brain memory record into a shared scope, and on what
// (GRA-298; the threat model is on the issue): the Brain's `mayPublish`
// port. The Brain asks, core decides, as for every other read and write.
//
// - Only a signed-in person publishes: an agent, an App or a run never.
// - The company's scope: an admin only. A team's: a current member of it.
//   A chat's session: a member of its audience, which must be known and
//   all the company's.
// - What a record rests on, its whole audience may read: every document
//   it cites is in a collection every current member of the team or chat
//   may read, or, for the company, one everyone reads that isn't
//   sensitive. Rewording private material doesn't make it shared.
//   Anything else is refused as one that isn't there (`brain.not_found`).

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
      .where(inList(members.userId, userIds)),
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
  person: { userId: string; role: string },
  target: { scope: "team" | "company" | "session"; scopeId: string | null }
): Promise<ScopeAudience> => {
  if (target.scope === "company") {
    if (!isAdmin(person.role)) {
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
      .where(eq(teamMembers.teamId, target.scopeId));
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
  const ids = [
    ...new Set(
      refs.flatMap((ref) => (ref.kind === "document" ? [ref.collectionId] : []))
    ),
  ];
  if (ids.length === 0) {
    return;
  }
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
  const readable = ids.every((id) => {
    const row = rows.find((collection) => collection.id === id);
    if (row === undefined) {
      return false;
    }
    if ("company" in audience) {
      return row.access === "everyone" && !row.sensitive;
    }
    const teamIds = shares
      .filter(({ collectionId }) => collectionId === id)
      .map(({ teamId }) => teamId);
    return audience.people.every((person) =>
      mayRead(person, { access: row.access, owner: row.owner, teamIds })
    );
  });
  if (!readable) {
    throw brainErrors.create("brain.not_found");
  }
};

import type { MemoryRecord } from "@grasp-os/brain/contract";
import type { MemoryAudience } from "@grasp-os/brain/memories";
import { collections } from "@grasp-os/brain/schema";
import type { Authority } from "@grasp-os/shared/permissions";
import { drizzle } from "drizzle-orm/d1";

import { teamsOf } from "../auth/identity.ts";
import { users } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import type { WorkContext } from "../restricted.ts";
import { audienceMaxMembers, audienceOf } from "./access.ts";
import type { Reader } from "./access.ts";
import { citedCollectionIds, readableByAll } from "./memory-publish.ts";

// Whom memory records serve (GRA-298; the threat models are on the issue):
// a turn's memory (memory.ts) and a recall (the Brain's `memories` port,
// ports.ts) compile the same audience and keep the same records.

/** An audience that reads no memory record. */
export const noAudience: MemoryAudience = {
  owners: [],
  teams: [],
  company: false,
  sessions: [],
};

/**
 * Who the memory records of `context` serve (GRA-298; the threat model is
 * on the issue): requester ∩ the chat's audience ∩ output audience, read
 * now. A person's own records only where the chat's audience is them
 * alone; a team's only where every member of it is in the team; the
 * company's unless people from outside it are in the chat; the chat's own
 * session records. A workflow step gets none.
 */
export const memoryAudienceOf = async (
  env: Env,
  authority: Authority,
  work: WorkContext,
  /**
   * Whether others may read the answer (a channel); undefined: whether the
   * chat keeps an audience, which only a shared chat does (workspace.ts).
   */
  shared?: boolean
): Promise<{ audience: MemoryAudience; people: string[] }> => {
  const none = { audience: noAudience, people: [] };
  const person = authority.onBehalfOf;
  const sessions = work.type === "chat" ? [work.chatId] : [];
  const audience = await audienceOf(env, work);
  const others: boolean = shared ?? audience !== undefined;
  const alone =
    !others &&
    (audience === undefined ||
      (!audience.outsiders &&
        audience.members.every((member) => member === person)));
  if (alone) {
    const teams = await teamsOf(env.DB, person);
    return {
      audience: {
        owners: [person],
        teams: teams.map(({ id }) => id),
        company: true,
        sessions,
      },
      people: [person],
    };
  }
  // A chat others share whose members aren't known gets nothing; nor one
  // kept by another Workspace object's chat of that ID (no members); nor
  // one with people from outside the company, whose records were cleared
  // for the company's people only.
  if (
    audience === undefined ||
    audience.members.length === 0 ||
    audience.outsiders ||
    audience.members.length > audienceMaxMembers
  ) {
    return none;
  }
  const memberships = await Promise.all(
    audience.members.map(async (member) => {
      const teams = await teamsOf(env.DB, member);
      return new Set(teams.map(({ id }) => id));
    })
  );
  const [first, ...rest] = memberships;
  const sharedTeams = [...(first ?? [])].filter((team) =>
    rest.every((teams) => teams.has(team))
  );
  return {
    audience: { owners: [], teams: sharedTeams, company: true, sessions },
    people: [...audience.members],
  };
};

/**
 * `records` whose cited documents every one of `people` may read now: a
 * record was cleared for its scope's audience when it was published, and
 * an audience changes (a guest joins, a collection stops being shared).
 */
export const stillReadable = async <Record extends MemoryRecord>(
  env: Env,
  people: readonly string[],
  records: readonly Record[]
): Promise<Record[]> => {
  // Each record's whole lineage: a correction rests on what it corrected.
  const each = await Promise.all(
    records.map(
      async ({ sourceRefs }) => await citedCollectionIds(env, sourceRefs)
    )
  );
  const ids = [...new Set(each.flatMap((cited) => [...cited]))];
  if (ids.length === 0) {
    return [...records];
  }
  const readable = await readableByAll(env, people, ids);
  return records.filter((_record, index) =>
    [...(each[index] ?? [])].every((id) => readable.has(id))
  );
};

/**
 * The collections every one of `people` may read now: the Brain's
 * `memories.readableBy` port (GRA-1085), which holds a shared read of
 * memory records to those resting on nothing else, in its queries. As
 * `stillReadable` decides, over every collection of the deployment.
 */
export const readableByEveryoneOf = async (
  env: Env,
  people: readonly string[]
): Promise<string[]> => {
  if (people.length === 0) {
    return [];
  }
  const all = await drizzle(env.KNOWLEDGE)
    .select({ id: collections.id })
    .from(collections);
  return [
    ...(await readableByAll(
      env,
      people,
      all.map(({ id }) => id)
    )),
  ];
};

/** The names of the people `userIds`, by ID, as the model may see them. */
export const namesOf = async (
  env: Env,
  userIds: readonly string[]
): Promise<Map<string, string>> => {
  if (userIds.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inList(users.id, userIds));
  return new Map(rows.map(({ id, name }) => [id, name]));
};

/**
 * The collections the documents `records` cite are in, with whether each
 * is sensitive: what a read of the records rests on.
 */
export const citedCollections = async (
  env: Env,
  records: readonly MemoryRecord[]
): Promise<{ id: string; sensitive: boolean }[]> => {
  const each = await Promise.all(
    records.map(
      async ({ sourceRefs }) => await citedCollectionIds(env, sourceRefs)
    )
  );
  const ids = [...new Set(each.flatMap((cited) => [...cited]))];
  return ids.length === 0
    ? []
    : await drizzle(env.KNOWLEDGE)
        .select({ id: collections.id, sensitive: collections.sensitive })
        .from(collections)
        .where(inList(collections.id, ids));
};

/**
 * Whom a recall by `reader` serves of memory (GRA-298), as a chat's
 * memory is served: a person recalling for themselves reads their own
 * records, their teams' and the company's (Grasp staff, who aren't the
 * company's, their own only); a chat's agent what its chat's memory
 * reads; an App, a run, an agent outside a chat and a reader under a
 * permission none.
 */
export const recallMemoryAudience = async (
  env: Env,
  reader: Reader
): Promise<{ audience: MemoryAudience; people: string[] }> => {
  if (reader.type === "person") {
    const { userId, staff } = reader.person;
    const teams = staff ? [] : await teamsOf(env.DB, userId);
    return {
      audience: {
        owners: [userId],
        teams: teams.map(({ id }) => id),
        company: !staff,
        sessions: [],
      },
      people: [userId],
    };
  }
  const { authority, context, permissionId } = reader;
  if (
    authority.subject.type !== "agent" ||
    context.type !== "chat" ||
    permissionId !== undefined
  ) {
    return { audience: noAudience, people: [] };
  }
  return await memoryAudienceOf(env, authority, context);
};

/**
 * Of `records`, found for `people`, those a recall by `reader` hands over
 * now (GRA-298), as a turn's memory keeps them: each whose cited documents
 * every one of `people` may read, with who published it when that isn't
 * the person reading, and the collections it rests on.
 */
export const keepRecalledMemories = async (
  env: Env,
  reader: Reader,
  people: readonly string[],
  records: readonly (MemoryRecord & { ownerId: string })[]
): Promise<
  (MemoryRecord & {
    by: string | null;
    cites: { id: string; sensitive: boolean }[];
  })[]
> => {
  const permitted = await stillReadable(env, people, records);
  const self =
    reader.type === "person"
      ? reader.person.userId
      : reader.authority.onBehalfOf;
  const names = await namesOf(env, [
    ...new Set(
      permitted.flatMap(({ ownerId }) => (ownerId === self ? [] : [ownerId]))
    ),
  ]);
  return await Promise.all(
    permitted.map(async ({ ownerId, ...record }) => ({
      ...record,
      by:
        ownerId === self
          ? null
          : (names.get(ownerId) ?? "someone who has left"),
      cites: await citedCollections(env, [record]),
    }))
  );
};

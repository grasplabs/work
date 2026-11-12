import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";

import { organizationId } from "../src/auth/auth.ts";
import type { SourceReaders } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";

/** Each person's team of their own, by their id. */
const soleTeams = new Map<string, Promise<string>>();

/** A team of the organization with `personId` alone in it. */
const soleTeamOf = async (personId: string): Promise<string> => {
  const id = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db
    .insert(teams)
    .values({ id, name: `Team ${id}`, organizationId, createdAt: new Date() });
  await db.insert(teamMembers).values({
    id: crypto.randomUUID(),
    teamId: id,
    userId: personId,
    createdAt: new Date(),
  });
  return id;
};

/**
 * Readers of the member `personId` alone, kept in the shared store: a team
 * of them alone, the same team each time. Core keeps what an `owner` may
 * read in that person's own store (brain-next-personal.test.ts); tests of
 * the shared store's own workings use this instead.
 */
export const soleReadersOf = async (
  personId: string
): Promise<SourceReaders> => {
  const teamId = soleTeams.get(personId) ?? soleTeamOf(personId);
  soleTeams.set(personId, teamId);
  return { kind: "team", teamId: await teamId };
};

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";

import { organizationId } from "../src/auth/auth.ts";
import { addSource } from "../src/brain-next.ts";
import type { SourceReaders } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import {
  brainEvalPeople,
  brainEvalTeamNames,
  brainEvalTeams,
} from "./fixtures/brain-eval/company.ts";
import type {
  BrainEvalPerson,
  BrainEvalReaders,
  BrainEvalSource,
  BrainEvalTeam,
} from "./fixtures/brain-eval/company.ts";
import type { Idp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";

// The Brain evaluation's company (fixtures/brain-eval/) put into a fresh
// core, for the evaluation (brain-eval.test.ts) and its run against a
// model (brain-eval-model.test.ts): its people as members, its teams with
// their members, and each source through core's own `addSource` with who
// may read it.

/** `key`'s ID in core, as the run set it up. */
export const idIn = <Key extends string>(
  ids: ReadonlyMap<Key, string>,
  key: Key
): string => {
  const id = ids.get(key);
  if (id === undefined) {
    throw new Error(`${key} is not set up`);
  }
  return id;
};

/** The company's people as members of core's organization: each one's user ID. */
const signUpPeople = async (idp: Idp): Promise<Map<BrainEvalPerson, string>> =>
  new Map(
    await Promise.all(
      brainEvalPeople.map(async (person) => {
        const { userId } = await signedInWithRole(idp, "user");
        return [person, userId] as const;
      })
    )
  );

/** The company's teams in core, with their members: each team's ID. */
const setUpTeams = async (
  people: ReadonlyMap<BrainEvalPerson, string>
): Promise<Map<BrainEvalTeam, string>> => {
  const db = drizzle(env.DB);
  return new Map(
    await Promise.all(
      brainEvalTeamNames.map(async (team) => {
        const id = crypto.randomUUID();
        await db
          .insert(teams)
          .values({ id, name: team, organizationId, createdAt: new Date() });
        await db.insert(teamMembers).values(
          brainEvalTeams[team].map((person) => ({
            id: crypto.randomUUID(),
            teamId: id,
            userId: idIn(people, person),
            createdAt: new Date(),
          }))
        );
        return [team, id] as const;
      })
    )
  );
};

const readersIn = (
  readers: BrainEvalReaders,
  people: ReadonlyMap<BrainEvalPerson, string>,
  teamIds: ReadonlyMap<BrainEvalTeam, string>
): SourceReaders => {
  if (readers === "nobody") {
    return { kind: "none" };
  }
  return "owner" in readers
    ? { kind: "owner", personId: idIn(people, readers.owner) }
    : { kind: "team", teamId: idIn(teamIds, readers.team) };
};

/**
 * The company in core, `sources` added one at a time in the set's order
 * (so "newer first" would break ties as the baseline does), each as an
 * upload named by its key in the set, so what recall returns names it:
 * each person's user ID.
 */
export const setUpEvalCompany = async (
  idp: Idp,
  sources: readonly BrainEvalSource[]
): Promise<Map<BrainEvalPerson, string>> => {
  const people = await signUpPeople(idp);
  const teamIds = await setUpTeams(people);
  for (const source of sources) {
    // oxlint-disable-next-line no-await-in-loop -- in order, see above
    await addSource(env, {
      source: { producer: "upload", id: source.key },
      change: source.key,
      text: source.text,
      readers: readersIn(source.readers, people, teamIds),
    });
  }
  return people;
};

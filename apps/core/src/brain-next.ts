import { brainOf } from "@grasp-os/brain-next/contract";
import type {
  Access,
  Brain,
  Reader,
  Recalled,
  SourceId,
} from "@grasp-os/brain-next/contract";
import { permissionErrors } from "@grasp-os/shared/permissions";

import { memberOf } from "./auth/identity.ts";
import { inJurisdiction } from "./durable-objects.ts";

// The Brain, as core reaches it (@grasp-os/brain-next). The Brain knows no
// people or teams: core names them as principals, a person by their user
// ID and a team as a group (`teamGroup`). Core's other code adds and
// recalls through the two functions here, naming people and teams; the
// Brain's reader is made only here, from core's own records read at each
// recall, never from what a caller claims or hands in ready-made.

/** Who may read a source, as core names them. */
export type SourceReaders =
  | { kind: "owner"; personId: string }
  | { kind: "team"; teamId: string }
  | { kind: "none" };

type BrainEnv = Pick<Env, "BRAIN_STORE" | "DURABLE_OBJECT_JURISDICTION">;

/** The Brain, in its store in core's jurisdiction. */
const brain = (env: BrainEnv): Brain =>
  brainOf(inJurisdiction(env, env.BRAIN_STORE));

/**
 * A team, as the Brain's group: named by kind, so no other kind of group
 * core names later can take its name.
 */
const teamGroup = (teamId: string): string => `team:${teamId}`;

const accessOf = (readers: SourceReaders): Access => {
  switch (readers.kind) {
    case "owner": {
      return { kind: "owner", person: readers.personId };
    }
    case "team": {
      return { kind: "audience", group: teamGroup(readers.teamId) };
    }
    case "none": {
      return { kind: "none" };
    }
    default: {
      throw new Error("Unknown readers");
    }
  }
};

/**
 * `personId` as the Brain's reader: the person, and the teams core counts
 * them in now. Refused once they have no current membership.
 */
const readerOf = async (
  env: Pick<Env, "DB">,
  personId: string
): Promise<Reader> => {
  const member = await memberOf(env.DB, personId);
  if (member === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
  return {
    person: member.userId,
    groups: member.teams.map(({ id }) => teamGroup(id)),
  };
};

/** Adds `text` to the Brain as a source `readers` may read. */
export const addSource = async (
  env: BrainEnv,
  { text, readers }: { text: string; readers: SourceReaders }
): Promise<{ id: SourceId }> =>
  await brain(env).addSource({ text, access: accessOf(readers) });

/**
 * What the member `personId` may read of the sources holding `question`'s
 * words, best first, as core counts them now. Refused once they are no
 * longer a member.
 */
export const recallAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  question: string
): Promise<Recalled> =>
  await brain(env).recall({ question, reader: await readerOf(env, personId) });

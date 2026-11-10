import { brainOf } from "@grasp-os/brain-next/contract";
import type { Brain, Reader } from "@grasp-os/brain-next/contract";
import { permissionErrors } from "@grasp-os/shared/permissions";

import { memberOf } from "./auth/identity.ts";
import { inJurisdiction } from "./durable-objects.ts";

// The Brain, as core reaches it (@grasp-os/brain-next): its contract, and
// who reads, as core knows them. The Brain knows no people or teams: core
// names them as principals, a person by their user ID and a team as a
// group (`teamGroup`), and resolves a reader's groups from its own
// records at each recall. A reader is never taken from what a caller
// claims.

/** The Brain, in its store in core's jurisdiction. */
export const brain = (
  env: Pick<Env, "BRAIN_STORE" | "DURABLE_OBJECT_JURISDICTION">
): Brain => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/**
 * A team, as the Brain's group: named by kind, so no other kind of group
 * core names later can take its name.
 */
export const teamGroup = (teamId: string): string => `team:${teamId}`;

/**
 * `personId` as the Brain's reader: the person, and the teams core counts
 * them in now. Refused once they have no current membership.
 */
export const brainReader = async (
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

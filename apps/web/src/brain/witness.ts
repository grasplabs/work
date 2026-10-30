import type { Source, Workspace } from "@grasp-os/shared/brain";
import { minTeamShown } from "@grasp-os/shared/onboarding";

import { latest } from "./history.ts";

/**
 * Who said something, as the company may read it (the prototype's
 * `lib/witness.ts`): their role in their team where five or more in the
 * team have that role, else the team alone, so a label never points at one
 * person. None for what nobody in a team said, such as a document.
 */
export const labelOf = (ws: Workspace, source: Source): string | undefined => {
  const team = ws.teams.find((each) => each.id === source.teamIds?.[0]);
  if (!team) {
    return undefined;
  }
  const holders =
    latest(team.counts)?.roles?.find((role) => role.name === source.who)
      ?.people ?? 0;
  return source.who !== undefined && holders >= minTeamShown
    ? `${source.who}, ${team.name}`
    : team.name;
};

import type { UnknownOutcomeListing } from "@grasp-os/shared/connect";

import type { CoreConnection } from "../core-connection.ts";
import { readPeople } from "../directory.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { loadEveryPage } from "./outcome-pages.ts";

// Every person's open calls of unknown outcome, for the organization's own
// admins, as a part of their inbox, as the reference lists them: changes
// Grasp sent for someone whose answer was lost, so an admin can follow up
// with each person. Read only: only the person a call acted for says what
// became of it, and only they see what was sent (core's
// unknown-outcomes.ts lists these without it). Each has its receipt, the
// effect key's hash the audit log's events of the call and of its
// resolution carry, so the trail of each is found in an export. Core
// checks the role on every read.

export interface Outcomes {
  listed: UnknownOutcomeListing[];
  /** Each person's name by their id, for whom a call acted. */
  people: ReadonlyMap<string, string>;
}

/** Every open call of unknown outcome but `own`'s, each page within its own few seconds. */
export const readOutcomes = async (
  core: Pick<CoreConnection, "withSession">,
  own: string
): Promise<Loaded<Outcomes>> => {
  const [listed, people] = await Promise.all([
    loadEveryPage(
      core,
      async (session, before) => await session.unknownOutcomes.listAll(before)
    ),
    loadFromCore(core, readPeople),
  ]);
  if (listed.state !== "ready") {
    return listed;
  }
  if (people.state !== "ready") {
    return people;
  }
  return {
    state: "ready",
    data: {
      listed: listed.data.filter(({ onBehalfOf }) => onBehalfOf !== own),
      people: people.data,
    },
  };
};

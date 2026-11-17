import type { UnknownOutcomeListing } from "@grasp-os/shared/connect";

import type { CoreConnection } from "../core-connection.ts";
import { loadEveryPage } from "../dashboard/outcome-pages.ts";
import { readPeople } from "../directory.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// Every person's open calls of unknown outcome, for the organization's own
// admins (once Settings › Unknown outcomes, now a group of the inbox):
// changes Grasp sent for someone whose answer was lost, so an admin can
// follow up with each person. Read only: only the person a call acted for
// says what became of it, and only they see what was sent (core's
// unknown-outcomes.ts lists these without it). Each has its receipt, the
// effect key's hash the audit log's events of the call and of its
// resolution carry, so the trail of each is found in an export. Core
// checks the role on every read.

export interface Outcomes {
  listed: UnknownOutcomeListing[];
  people: ReadonlyMap<string, string>;
}

/** Every open call of unknown outcome, each page within its own few seconds, none after `left`. */
export const readOutcomes = async (
  core: Pick<CoreConnection, "withSession">,
  left?: AbortSignal
): Promise<Loaded<Outcomes>> => {
  const [listed, people] = await Promise.all([
    loadEveryPage(
      core,
      async (session, before) => await session.unknownOutcomes.listAll(before),
      left
    ),
    loadFromCore(core, readPeople, left),
  ]);
  if (listed.state !== "ready") {
    return listed;
  }
  if (people.state !== "ready") {
    return people;
  }
  return { state: "ready", data: { listed: listed.data, people: people.data } };
};

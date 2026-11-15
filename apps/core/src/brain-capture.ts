import { eraseOutcomes } from "@grasp-os/brain/outcomes";

import { brainOf } from "./knowledge/ports.ts";

// What today's Brain captured of chat turns before core stopped capturing
// them: erased with the chats it rests on (workspace.ts), until the
// cutover removes today's Brain.

/**
 * Erases today's Brain's events resting on the records `evidenceIds`
 * (chats), their records going: run before the records go, so an erasure
 * cut short is made again.
 */
export const eraseCaptured = async (
  env: Env,
  evidenceIds: readonly string[]
): Promise<void> => {
  await eraseOutcomes(brainOf(env), evidenceIds);
};

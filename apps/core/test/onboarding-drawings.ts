import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { onboardingStore } from "../src/onboarding/store.ts";

/**
 * Holds `drawing` (a brain record of type `workflowVersion`) as the
 * standing drawing of the piece of work `workflow` of `team`, as the
 * onboarding's intake notes one (`brain_drawings`, GRA-1748): its earlier
 * drawing no longer stands. For a test that needs a drawing on the Brain
 * page without drawing one; nothing is handed to the new Brain.
 */
export const drawingHeld = async ({
  workflow,
  team,
  name,
  drawing,
}: {
  workflow: string;
  team: string;
  name: string;
  drawing: { id: string } & Record<string, unknown>;
}): Promise<void> => {
  await runInDurableObject(onboardingStore(env), (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE brain_drawings SET erase = 1 WHERE workflow = ? AND erase = 0",
      workflow
    );
    state.storage.sql.exec(
      "INSERT INTO brain_drawings (source, record, workflow, team, name, local, drawing, at, erase) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 0)",
      crypto.randomUUID(),
      drawing.id,
      workflow,
      team,
      name,
      JSON.stringify(drawing),
      new Date().toISOString()
    );
  });
};

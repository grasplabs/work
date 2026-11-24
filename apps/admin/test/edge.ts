import { compareReleaseIds } from "@grasp-os/shared/release-id";

import { adminDatabase } from "../src/db/act.ts";
import { toEdge } from "../src/rollout/channels.ts";

/**
 * Takes Edge to the newest of `imported`, releases the admin has, as the
 * import does in the batch that saves each (`toEdge`): for a release a
 * test put in the database itself.
 */
export const releaseToEdge = async (
  env: Env,
  imported: readonly string[]
): Promise<void> => {
  const [newest] = imported.toSorted((a, b) => compareReleaseIds(b, a));
  if (newest === undefined) {
    return;
  }
  const db = adminDatabase(env.DB);
  await db.batch(toEdge(db, newest));
};

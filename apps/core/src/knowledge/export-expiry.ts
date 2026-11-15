import { expireExports } from "@grasp-os/brain/exports";
import { brainExports } from "@grasp-os/brain/schema";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { brainOf } from "./ports.ts";

// What is left of today's Brain's exports: their files under `exports/<id>/`
// in the Brain's bucket, written before nothing could export any more. Each
// holds every version of the company's documents, so they are deleted as
// they always were (`expireExports`, packages/brain's exports.ts): a
// complete one once its download window is over, and one a purge ran
// after it began, as it may hold what that purge erased, at the clock's
// next minute after that purge: the purge, a person's erasure's included,
// doesn't wait for it. Nothing writes an export any more, so one left
// running is stopped here, and its files deleted with the rest. A delete
// R2 refuses throws: the clock records the failure and tries again every
// minute until it is done. The cutover removes this with the bucket's
// `exports/` prefix.

/** Why an export left running when exports stopped was failed. */
const stopped = "knowledge.export_stopped";

/**
 * Stops every export still running, then deletes the files of every one
 * that is due, as of `at`.
 */
export const expireBrainExports = async (env: Env, at: Date): Promise<void> => {
  await drizzle(env.KNOWLEDGE)
    .update(brainExports)
    .set({
      state: "failed",
      reason: stopped,
      claim: null,
      claimedAt: null,
      updatedAt: at,
      endedAt: sql`coalesce(${brainExports.endedAt}, ${at.getTime()})`,
    })
    .where(eq(brainExports.state, "running"));
  await expireExports(brainOf(env), at);
};

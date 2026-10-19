import { v } from "@grasp-os/sdk";

import { action, internalQuery } from "#grasp/server";

// Whether the person using the page may take a snapshot and write its
// narrative: the screen shows those controls only then. The store refuses anyone but the App's
// builders a read of `builders`, which holds nothing, so reading it is
// the check. The store still checks every write, whatever this answers.

/** Reads `builders`, which only the App's builders may. */
export const builder = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.db.query("builders").take(1);
    return null;
  },
});

/** Whether the caller may take snapshots and write their narratives. */
export const writable = action({
  args: {},
  returns: v.boolean(),
  uses: [builder],
  handler: async (ctx) => {
    try {
      await ctx.runQuery(builder, {});
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "data.access_denied"
      ) {
        return false;
      }
      throw error;
    }
  },
});

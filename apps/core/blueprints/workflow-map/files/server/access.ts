import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

// Whether the person using the page may change the map: the App's
// builders (an admin is one on every App), as `ctx.auth.getUser()` tells.
// The page shows its controls only then; the store still checks every
// write, whatever this answers.

/** Whether the caller may change the map. */
export const writable = action({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const user = await ctx.auth.getUser();
    return user.roles.includes("builder");
  },
});

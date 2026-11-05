import { AppError, v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import type { CallerCtx } from "@server/_generated/server";

// Whether the person using the page may take a snapshot and write its
// narrative: the App's builders (an admin is one on every App), as
// `ctx.auth.getUser()` tells. The screen shows those controls only then;
// the store still checks every write, whatever this answers.

/** Whether the caller is one of the App's builders. */
export const isBuilder = async (ctx: CallerCtx): Promise<boolean> => {
  const user = await ctx.auth.getUser();
  return user.roles.includes("builder");
};

/** Refuses anyone but the App's builders, before anything is read. */
export const requireBuilder = async (ctx: CallerCtx): Promise<void> => {
  if (!(await isBuilder(ctx))) {
    throw new AppError(
      "board.builders_only",
      "Only the App's builders take snapshots and write them."
    );
  }
};

/** Whether the caller may take snapshots and write their narratives. */
export const writable = action({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => await isBuilder(ctx),
});

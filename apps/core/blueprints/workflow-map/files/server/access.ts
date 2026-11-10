import { AppError, v } from "@grasp-os/runtime";
import { action } from "@server/_generated/server";
import type { CallerCtx } from "@server/_generated/server";

// Whether the person using a page may change the map, take a snapshot of
// it and write the snapshot's narrative: the App's builders (an admin is
// one on every App), as `ctx.auth.getUser()` tells. The pages show their
// controls only then; the store still checks every write, whatever this
// answers.

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

/** Whether the caller may change the map, and take and write snapshots. */
export const writable = action({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => await isBuilder(ctx),
});

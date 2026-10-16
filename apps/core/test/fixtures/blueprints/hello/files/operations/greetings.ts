import { v } from "@grasp-os/sdk";

import { mutation } from "#grasp/server";

/** Most greetings it counts, as many as one read returns. */
const countedMax = 100;

/** Greets `name`, and says how many greetings this App has given. */
export const hello = mutation({
  args: { name: v.string().min(1).max(200) },
  returns: v.string(),
  handler: async (ctx, args) => {
    await ctx.db.insert("greetings", { name: args.name });
    const given = await ctx.db.query("greetings").take(countedMax);
    return `Hello, ${args.name}: greeting ${given.length}`;
  },
});

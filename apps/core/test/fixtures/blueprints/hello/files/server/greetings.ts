import { v } from "@grasp-os/runtime";
import { mutation } from "@server/_generated/server";

/** Greets `name`, and says how many greetings this App has given. */
export const hello = mutation({
  args: { name: v.string().min(1).max(200) },
  returns: v.string(),
  handler: async (ctx, args) => {
    await ctx.db.insert("greetings", { name: args.name });
    const given = await ctx.db.query("greetings").count();
    return `Hello, ${args.name}: greeting ${given}`;
  },
});

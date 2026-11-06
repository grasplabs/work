import { v } from "@grasp-os/sdk";
import { doc, query } from "@server/_generated/server";

export const lastYear = query({
  args: {},
  returns: v.array(doc("months")).max(12),
  handler: async (ctx) => {
    const months = await ctx.db
      .query("months")
      .withIndex("by_month")
      .order("desc")
      .take(12);
    return months.toReversed();
  },
});

import {
  paginationOptionsValidator,
  paginationResultValidator,
} from "@grasp-os/sdk";
import { doc, query } from "@server/_generated/server";

/** The greetings given, newest first, a page at a time. */
export const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("greetings")),
  handler: async (ctx, args) =>
    await ctx.db.query("greetings").order("desc").paginate(args.pagination),
});

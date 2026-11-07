import {
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";
import { doc, mutation, query } from "@server/_generated/server";

export const list = query({
  args: {
    search: v.string().trim().max(200),
    pagination: paginationOptionsValidator,
  },
  returns: paginationResultValidator(doc("contacts")),
  handler: async (ctx, args) =>
    args.search === ""
      ? await ctx.db
          .query("contacts")
          .withIndex("by_name")
          .paginate(args.pagination)
      : await ctx.db.search("contacts", args.search).paginate(args.pagination),
});

export const get = query({
  args: { id: v.id("contacts") },
  returns: doc("contacts").nullable(),
  handler: async (ctx, args) => await ctx.db.get("contacts", args.id),
});

export const add = mutation({
  args: {
    name: v.string().trim().min(1).max(200),
    company: v.string().trim().max(200),
    email: v.string().trim().email().max(320).optional(),
  },
  returns: v.id("contacts"),
  handler: async (ctx, args) =>
    await ctx.db.insert("contacts", { ...args, email: args.email ?? null }),
});

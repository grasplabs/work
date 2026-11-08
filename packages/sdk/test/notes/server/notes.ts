import {
  AppError,
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";

import { internal } from "./_generated/internal.ts";
import {
  doc,
  internalQuery,
  mutation,
  query,
  action,
} from "./_generated/server.ts";
import { noteFields } from "./schema.ts";

export const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("notes")),
  handler: async (ctx, args) =>
    await ctx.db
      .query("notes")
      .withIndex("by_updated")
      .order("desc")
      .paginate(args.pagination),
});

export const get = query({
  args: { id: v.id("notes") },
  returns: doc("notes").nullable(),
  handler: async (ctx, args) => await ctx.db.get("notes", args.id),
});

export const create = mutation({
  args: { title: noteFields.title, body: noteFields.body },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

/** Saves what someone changed of a note, and only that. */
export const update = mutation({
  args: {
    id: v.id("notes"),
    title: noteFields.title.optional(),
    body: v.string().max(100_000).optional(),
  },
  returns: doc("notes"),
  handler: async (ctx, { id, ...changed }) => {
    await ctx.db.patch("notes", id, changed);
    const updated = await ctx.db.get("notes", id);
    if (!updated) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    return updated;
  },
});

export const remove = mutation({
  args: { id: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete("notes", args.id);
    return null;
  },
});

/** How many notes the caller can read: the App's own code only. */
export const count = internalQuery({
  args: {},
  returns: v.number().integer().min(0),
  handler: async (ctx) => {
    const notes = await ctx.db.query("notes").take(100);
    return notes.length;
  },
});

export const setSummary = mutation({
  args: {
    id: v.id("notes"),
    summary: v.string().max(10_000),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("notes", args.id, { summary: args.summary });
    return null;
  },
});

/** Counts the caller's notes through the internal reference. */
export const tally = action({
  args: {},
  returns: v.number().integer().min(0),
  handler: async (ctx) => await ctx.runQuery(internal.notes.count, {}),
});

/** Exports notes, reporting how far it got: a streaming action. */
export const exportAll = action({
  args: { format: v.enum(["csv", "json"]) },
  returns: v.string(),
  stream: v.object({ done: v.number().integer().min(0) }),
  handler: (_ctx, args) => args.format,
});

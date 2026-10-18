import { v } from "@grasp-os/sdk";

import { doc, mutation, query } from "#grasp/server";

import { shortTextMax } from "../schema.ts";

// The teams the map groups workflows by.

/** Most teams the map lists. */
const teamsMax = 100;

/** The teams, by title. */
export const list = query({
  args: {},
  returns: v.array(doc("teams")).max(teamsMax),
  handler: async (ctx) =>
    await ctx.db.query("teams").withIndex("by_title").take(teamsMax),
});

/** Adds a team to group workflows by. */
export const add = mutation({
  args: { title: v.string().trim().min(1).max(shortTextMax) },
  returns: v.id("teams"),
  handler: async (ctx, args) =>
    await ctx.db.insert("teams", { title: args.title }),
});

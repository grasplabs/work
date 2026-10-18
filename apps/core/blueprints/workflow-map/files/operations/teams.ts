import { AppError, v } from "@grasp-os/sdk";

import { doc, mutation, query } from "#grasp/server";

import { shortTextMax } from "../schema.ts";
import { requireText } from "./text.ts";

// The teams the map groups workflows by.

/** Most teams the map lists. */
export const teamsMax = 100;

/** The teams, by title. */
export const list = query({
  args: {},
  returns: v.array(doc("teams")).max(teamsMax),
  handler: async (ctx) =>
    await ctx.db.query("teams").withIndex("by_title").take(teamsMax),
});

/**
 * Adds a team to group workflows by: refused once the map has as many as
 * it lists (`map.too_many_teams`), so every team stays listed.
 */
export const add = mutation({
  args: { title: v.string().trim().min(1).max(shortTextMax) },
  returns: v.id("teams"),
  handler: async (ctx, args) => {
    requireText("team's name", args.title);
    const teams = await ctx.db.query("teams").take(teamsMax);
    if (teams.length >= teamsMax) {
      throw new AppError(
        "map.too_many_teams",
        `The map holds at most ${teamsMax} teams.`
      );
    }
    return await ctx.db.insert("teams", { title: args.title });
  },
});

import {
  AppError,
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";
import { doc, mutation, query } from "@server/_generated/server";

const stage = v.enum(["lead", "qualified", "proposal", "won", "lost"]);

const currency = "EUR";

export const forContact = query({
  args: { contact: v.id("contacts"), pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("deals")),
  handler: async (ctx, args) =>
    await ctx.db
      .query("deals")
      .withIndex("by_contact", (range) => range.eq("contact", args.contact))
      .order("desc")
      .paginate(args.pagination),
});

export const pipeline = query({
  args: {},
  returns: v
    .array(v.object({ stage, deals: v.number().integer().min(0) }))
    .max(5),
  handler: async (ctx) => {
    const groups = await ctx.db
      .query("deals")
      .withIndex("by_stage")
      .group({ by: ["stage"] });
    return groups.map(({ key, count }) => ({ stage: key.stage, deals: count }));
  },
});

export const add = mutation({
  args: {
    contact: v.id("contacts"),
    title: v.string().trim().min(1).max(200),
    amount: v.number().min(0).max(1_000_000_000),
  },
  returns: v.id("deals"),
  handler: async (ctx, args) => {
    if ((await ctx.db.get("contacts", args.contact)) === null) {
      throw new AppError("deals.no_contact", "This contact is gone.");
    }
    return await ctx.db.insert("deals", {
      contact: args.contact,
      title: args.title,
      value: { currency, minorUnits: Math.round(args.amount * 100) },
      stage: "lead",
    });
  },
});

export const setStage = mutation({
  args: {
    id: v.id("deals"),
    stage,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("deals", args.id, { stage: args.stage });
    return null;
  },
});

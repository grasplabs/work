import { AppError, v } from "@grasp-os/sdk";
import { doc, mutation, query } from "@server/_generated/server";
import type { Doc, MutationCtx } from "@server/_generated/server";

const column = v.enum(["todo", "doing", "done"]);

const cardsPerColumn = 100;

/** The rank that puts a card at the bottom of `to`, once there is room. */
const bottomOf = async (
  ctx: MutationCtx,
  to: Doc<"cards">["column"]
): Promise<number> => {
  const cards = ctx.db
    .query("cards")
    .withIndex("by_column", (range) => range.eq("column", to));
  if ((await cards.count()) >= cardsPerColumn) {
    throw new AppError(
      "cards.column_full",
      `A column holds at most ${cardsPerColumn} cards.`
    );
  }
  const last = await cards.order("desc").first();
  return (last?.rank ?? 0) + 1;
};

export const list = query({
  args: { column },
  returns: v.array(doc("cards")).max(cardsPerColumn),
  handler: async (ctx, args) =>
    await ctx.db
      .query("cards")
      .withIndex("by_column", (range) => range.eq("column", args.column))
      .take(cardsPerColumn),
});

export const add = mutation({
  args: { title: v.string().trim().min(1).max(200) },
  returns: v.id("cards"),
  handler: async (ctx, args) =>
    await ctx.db.insert("cards", {
      title: args.title,
      column: "todo",
      rank: await bottomOf(ctx, "todo"),
    }),
});

export const move = mutation({
  args: {
    id: v.id("cards"),
    column,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("cards", args.id, {
      column: args.column,
      rank: await bottomOf(ctx, args.column),
    });
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id("cards") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete("cards", args.id);
    return null;
  },
});

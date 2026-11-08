import {
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";
import { doc, mutation, query } from "@server/_generated/server";
import type { Doc, MutationCtx } from "@server/_generated/server";

// Each sale is counted into its month (`months`) in the same mutation that
// records or removes it, so the dashboard reads twelve records, never
// every sale.

const currency = "EUR";

/** `2026-11`: the month, in UTC, of a moment. */
const monthOf = (at: number): string => new Date(at).toISOString().slice(0, 7);

const tally = async (
  ctx: MutationCtx,
  sale: Pick<Doc<"sales">, "amount" | "closedAt">,
  direction: 1 | -1
): Promise<void> => {
  const month = monthOf(sale.closedAt);
  const totals = await ctx.db
    .query("months")
    .withIndex("by_month", (range) => range.eq("month", month))
    .unique();
  const minorUnits = direction * sale.amount.minorUnits;
  if (totals === null) {
    await ctx.db.insert("months", {
      month,
      sales: direction,
      revenue: { currency, minorUnits },
    });
    return;
  }
  await ctx.db.patch("months", totals._id, {
    sales: totals.sales + direction,
    revenue: {
      currency,
      minorUnits: totals.revenue.minorUnits + minorUnits,
    },
  });
};

export const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("sales")),
  handler: async (ctx, args) =>
    await ctx.db
      .query("sales")
      .withIndex("by_closed")
      .order("desc")
      .paginate(args.pagination),
});

export const record = mutation({
  args: {
    customer: v.string().trim().min(1).max(200),
    amount: v.number().min(0).max(1_000_000_000),
    closedAt: v.timestamp(),
  },
  returns: v.id("sales"),
  handler: async (ctx, args) => {
    const sale = {
      customer: args.customer,
      amount: { currency, minorUnits: Math.round(args.amount * 100) },
      closedAt: args.closedAt,
    };
    const id = await ctx.db.insert("sales", sale);
    await tally(ctx, sale, 1);
    return id;
  },
});

export const remove = mutation({
  args: { id: v.id("sales") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const sale = await ctx.db.get("sales", args.id);
    if (sale === null) {
      return null;
    }
    await ctx.db.delete("sales", sale._id);
    await tally(ctx, sale, -1);
    return null;
  },
});

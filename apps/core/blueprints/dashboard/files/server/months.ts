import { AppError, v } from "@grasp-os/runtime";
import { doc, query } from "@server/_generated/server";

const monthPattern = /^(?<year>\d{4})-(?<month>0[1-9]|1[0-2])$/u;

/** The month `count` months before `month`, both as `2026-11`. */
const monthsBefore = (month: string, count: number): string => {
  const parts = monthPattern.exec(month)?.groups;
  if (parts?.year === undefined || parts.month === undefined) {
    throw new AppError("months.invalid", "A month is written as 2026-11.");
  }
  const first = Date.UTC(Number(parts.year), Number(parts.month) - 1 - count);
  return new Date(first).toISOString().slice(0, 7);
};

/** The twelve calendar months up to `through` (this month, as the page sees it) that have sales. */
export const lastYear = query({
  args: { through: v.string().min(7).max(7) },
  returns: v.array(doc("months")).max(12),
  handler: async (ctx, args) =>
    await ctx.db
      .query("months")
      .withIndex("by_month", (range) =>
        range
          .gte("month", monthsBefore(args.through, 11))
          .lte("month", monthsBefore(args.through, 0))
      )
      .take(12),
});

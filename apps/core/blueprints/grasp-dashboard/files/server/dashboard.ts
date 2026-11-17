import { v } from "@grasp-os/sdk";
import { api } from "@server/_generated/api";
import { action, mutation, query } from "@server/_generated/server";

// The dashboard's figures, from what an App reads of the platform today
// (`ctx.grasp.statistics.read`, which an admin grants): the runs of the
// workflows of the Apps it counts, and their improvement signals, over
// the last 30 days. An App can't list the company's Apps, so its builders
// name the ones it counts (`apps`); the platform counts only those the
// person looking may see, and says which it left out.

/** Days the figures are over: the signals' window. */
const days = 30;

/** Most Apps the dashboard counts: the platform's bound for one read. */
const appsMax = 100;

const group = v.object({ name: v.string(), count: v.number() });

/** The Apps it counts, by their names. */
export const counted = query({
  args: {},
  returns: v.array(
    v.object({ id: v.id("apps"), appId: v.string(), title: v.string() })
  ),
  handler: async (ctx) => {
    const apps = await ctx.db.query("apps").withIndex("by_title").take(appsMax);
    return apps.map(({ _id, appId, title }) => ({ id: _id, appId, title }));
  },
});

/** Counts one more App. Only builders write the table. */
export const count = mutation({
  args: {
    appId: v.string().trim().min(1).max(256),
    title: v.string().trim().min(1).max(200),
  },
  returns: v.id("apps"),
  handler: async (ctx, args) => await ctx.db.insert("apps", args),
});

/** Stops counting an App. */
export const forget = mutation({
  args: { id: v.id("apps") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete("apps", args.id);
    return null;
  },
});

/** The last 30 days: runs by App, signals by kind, and the Apps left out. */
export const figures = action({
  args: {},
  returns: v.object({
    runs: v.array(group),
    signals: v.array(group),
    leftOut: v.array(v.string()),
  }),
  handler: async (ctx) => {
    const apps = await ctx.runQuery(api.dashboard.counted, {});
    if (apps.length === 0) {
      return { runs: [], signals: [], leftOut: [] };
    }
    const ids = apps.map(({ appId }) => appId);
    const titleOf = new Map(apps.map(({ appId, title }) => [appId, title]));
    const [runs, signals] = await Promise.all([
      ctx.grasp.statistics.read({
        measure: "platform.workflow_runs",
        days,
        apps: ids,
        groupBy: ["app"],
      }),
      ctx.grasp.statistics.read({
        measure: "platform.improvement_signals",
        days,
        apps: ids,
        groupBy: ["kind"],
      }),
    ]);
    return {
      runs: runs.groups.map(({ dimensions, count: runsCounted }) => ({
        name: titleOf.get(dimensions.app ?? "") ?? dimensions.app ?? "",
        count: runsCounted,
      })),
      signals: signals.groups.map(({ dimensions, count: signalsCounted }) => ({
        name: dimensions.kind ?? "",
        count: signalsCounted,
      })),
      leftOut: (runs.unavailable ?? []).map((id) => titleOf.get(id) ?? id),
    };
  },
});

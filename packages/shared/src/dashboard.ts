import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// Each person's own dashboard: which of the widget board's widgets are on
// it, and in what order. Core keeps it in the person's Workspace object
// (core's dashboard-rpc.ts); only they read or change it. A person who
// never changed theirs has none saved, and sees the board as it begins.

/** Why a call on the dashboard was refused. */
export const dashboardErrors = defineErrorFamily({
  "dashboard.invalid_layout":
    "That isn't a dashboard layout: each of the dashboard's widgets at most once, and no others.",
});

/**
 * The widgets Grasp has for the board, in the order the board begins
 * with: where the workflows stand, each engine's workflows, the runs this
 * week, and what could be better.
 */
export const standardWidgetIds = [
  "workflows",
  "engines",
  "runs",
  "signals",
] as const;

/** One of Grasp's own widgets. */
export const standardWidgetIdSchema = z.enum(standardWidgetIds);
export type StandardWidgetId = z.infer<typeof standardWidgetIdSchema>;

/**
 * The widgets on a person's board, in order: each at most once, so no
 * more than there are. None at all is a board they took everything off.
 */
export const dashboardLayoutSchema = z.strictObject({
  widgets: z
    .array(standardWidgetIdSchema)
    .max(standardWidgetIds.length)
    .refine((widgets) => new Set(widgets).size === widgets.length, {
      message: "Each widget may be on the board once.",
    }),
});
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

/** The signed-in person's own dashboard. */
export interface DashboardApi {
  /** Their board as they last saved it; `null` when they never did. */
  layout: () => Promise<DashboardLayout | null>;
  /** Saves their whole board, in place of what they saved before. */
  saveLayout: (layout: DashboardLayout) => Promise<void>;
}

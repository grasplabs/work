import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import type { KnowledgeSignalKind } from "./knowledge-signals.ts";
import type { OnboardingProgress, Programme } from "./onboarding.ts";
import type { SignalKind } from "./signals.ts";
import { customWidgetIdSchema, customWidgetsMax } from "./widgets.ts";
import type { CustomWidget, WidgetMade } from "./widgets.ts";
import type { RunActivity } from "./workflows.ts";

// Each person's own dashboard: which of the widget board's widgets are on
// it, and in what order, Grasp's own and those Grasp made from what they
// asked (widgets.ts). Core keeps it in the person's Workspace object
// (core's dashboard-rpc.ts); only they read or change it. A person who
// never changed theirs has none saved, and sees the board as it begins.

/** Why a call on the dashboard was refused. */
export const dashboardErrors = defineErrorFamily({
  "dashboard.invalid_layout":
    "That isn't a dashboard layout: each of the dashboard's widgets at most once, and no others.",
  "dashboard.invalid_request":
    "Say in a few words what the widget should show: at most 500 characters.",
  "dashboard.widget_not_found":
    "That widget is not on your dashboard any more.",
  "dashboard.too_many_widgets":
    "Your dashboard holds at most 12 widgets Grasp made. Take one off first.",
  "dashboard.widget_busy":
    "Grasp is still changing this widget. Try again in a moment.",
  "dashboard.widget_unreadable":
    "Grasp could not make that into a widget. Try asking another way.",
  "dashboard.widget_unchanged":
    "That is how the widget is already. Say what should be different.",
  "dashboard.no_model": "No model may make widgets here.",
});

/**
 * The widgets Grasp has for the board, in the order the board begins
 * with: the prototype's four (what the work returns a month, the board's
 * goals, how far each team is with AI, where the workflows stand), then
 * each engine's workflows, the runs this week, what could be better, and,
 * for admins, what the models cost this month. A board saved before a
 * widget was added keeps what it had.
 */
export const standardWidgetIds = [
  "return",
  "goals",
  "teams",
  "workflows",
  "engines",
  "runs",
  "signals",
  "spend",
] as const;

/** One of Grasp's own widgets. */
export const standardWidgetIdSchema = z.enum(standardWidgetIds);
export type StandardWidgetId = z.infer<typeof standardWidgetIdSchema>;

/** The widgets only admins are offered: what the models cost, which core reads only to them. */
const adminWidgets: ReadonlySet<StandardWidgetId> = new Set(["spend"]);

/**
 * The widgets Grasp offers a person, in the order the board begins with:
 * every one to admins. It is their board as it begins, and as it is if
 * they never changed it.
 */
export const offeredWidgets = (admin: boolean): readonly StandardWidgetId[] =>
  admin
    ? standardWidgetIds
    : standardWidgetIds.filter((widget) => !adminWidgets.has(widget));

/** A widget on a person's board: one of Grasp's own, or one Grasp made for them. */
export const dashboardWidgetIdSchema = z.union([
  standardWidgetIdSchema,
  customWidgetIdSchema,
]);
export type DashboardWidgetId = z.infer<typeof dashboardWidgetIdSchema>;

/**
 * The widgets on a person's board, in order: each at most once, so no
 * more than there are. None at all is a board they took everything off.
 * A widget Grasp made is on it only while they have it (core checks).
 */
export const dashboardLayoutSchema = z.strictObject({
  widgets: z
    .array(dashboardWidgetIdSchema)
    .max(standardWidgetIds.length + customWidgetsMax)
    .refine((widgets) => new Set(widgets).size === widgets.length, {
      message: "Each widget may be on the board once.",
    }),
});
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

/** The signed-in person's own dashboard. */
/**
 * One part of the board report, as core read it for the person: what it
 * says, or why it couldn't be read. A part that fails leaves the rest.
 */
export type BoardReportPart<T> =
  | { state: "read"; data: T }
  | { state: "unread"; code: string };

/** How many signals of one kind there are, improvement and Knowledge alike. */
export interface SignalCount {
  kind: SignalKind | KnowledgeSignalKind;
  count: number;
}

/**
 * The weekly report on the board, read in one call: everything core
 * knows of what it says, each part as the person may read it. What ran
 * and the decisions runs asked for are of the next report's window
 * (`Programme.reportWindow`; today alone without a programme); the rest
 * stands as it is now.
 */
export interface BoardReport {
  /** The programme and where today falls in it; null without a plan. */
  programme: BoardReportPart<Programme | null>;
  /** The runs started in the report's window, of the Apps the person can open. */
  runs: BoardReportPart<RunActivity>;
  /** How many of the person's workflows didn't run in the window. */
  idleWorkflows: BoardReportPart<number>;
  /**
   * How many signals of each kind there are: every one for admins, an
   * engine's for its builders, their own collections' for owners. Null for
   * someone who reads none, so the report leaves the section out.
   */
  better: BoardReportPart<SignalCount[] | null>;
  /**
   * How many the interviews heard; null before anyone was asked. Only
   * for admins, Grasp staff included: absent for everyone else.
   */
  people?: BoardReportPart<OnboardingProgress | null>;
}

export interface DashboardApi {
  /** Their board as they last saved it; `null` when they never did. */
  layout: () => Promise<DashboardLayout | null>;
  /** Saves their whole board, in place of what they saved before. */
  saveLayout: (layout: DashboardLayout) => Promise<void>;
  /**
   * The widgets Grasp made for them, each as it looks now, its numbers
   * worked out from what they may see today.
   */
  widgets: () => Promise<CustomWidget[]>;
  /**
   * Has Grasp make a widget from what they ask (`request`), through the
   * model gateway, on their own model budget, and puts it last on their
   * board. Refused as `dashboard.widget_unreadable` when no answer would
   * read as one after being sent back to be put right twice.
   */
  makeWidget: (request: string) => Promise<WidgetMade>;
  /** Has Grasp change widget `id` as they ask; it keeps its place. */
  changeWidget: (id: string, request: string) => Promise<WidgetMade>;
  /** Takes widget `id` off their board, for good. */
  removeWidget: (id: string) => Promise<void>;
  /**
   * The weekly report as it stands now, each part as the person may read
   * it. Reading it changes nothing and isn't audited.
   */
  report: () => Promise<BoardReport>;
}

import { defineTool } from "@grasp-os/connector-kit/connector";
import { jsonBody, segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import {
  atPage,
  graphHost,
  graphJson,
  graphUrl,
  idSchema,
  nextPageOf,
  pageOf,
  pageSchema,
  v1,
} from "./graph.ts";

// Planner, one plan per call, as `/planner/plans/{plan}`, so a call's
// capability binds its reads to the plan. A plan belongs to a Microsoft 365
// group, a team's, so these reach `company`; Graph answers with the
// person's own rights (a delegated `Tasks.Read` or `Tasks.ReadWrite`
// token), and refuses a plan of a group they aren't in.
//
// A task is made unassigned. Assigning one tells the person it is
// assigned to, which would reach others: that is left out, so making a
// task stays Change company.

const plans = `${v1}/planner/plans/{plan}`;

const graphPlan = z.object({ id: z.string(), title: z.string().nullish() });

const graphTask = z.object({
  id: z.string(),
  planId: z.string().nullish(),
  bucketId: z.string().nullish(),
  title: z.string().nullish(),
  percentComplete: z.number().nullish(),
  priority: z.number().nullish(),
  dueDateTime: z.string().nullish(),
  createdDateTime: z.string().nullish(),
  completedDateTime: z.string().nullish(),
  assignments: z.record(z.string(), z.unknown()).nullish(),
});
type GraphTask = z.infer<typeof graphTask>;

const taskSchema = z.strictObject({
  id: z.string(),
  title: z.string().nullable(),
  bucketId: z.string().nullable(),
  percentComplete: z.number().nullable(),
  priority: z.number().nullable(),
  due: z.string().nullable(),
  createdAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** The user IDs of those it is assigned to. */
  assignedTo: z.array(z.string()),
});

const taskOf = (task: GraphTask): z.infer<typeof taskSchema> => ({
  id: task.id,
  title: task.title ?? null,
  bucketId: task.bucketId ?? null,
  percentComplete: task.percentComplete ?? null,
  priority: task.priority ?? null,
  due: task.dueDateTime ?? null,
  createdAt: task.createdDateTime ?? null,
  completedAt: task.completedDateTime ?? null,
  assignedTo: Object.keys(task.assignments ?? {}),
});

/** Planner's done: a task at 100 percent. */
const isDone = (task: GraphTask): boolean => (task.percentComplete ?? 0) >= 100;

/** The plan, as Graph lets the person open it; a ToolError otherwise. */
const planOf = async (plan: string) =>
  await graphJson(graphUrl(`/planner/plans/${segment(plan)}`), graphPlan);

const listTasks = defineTool({
  name: "planner.tasks",
  description:
    "Lists the tasks of a Planner plan, a page at a time: each task's title, bucket, progress, due time and the user IDs it is assigned to. Optionally only those not done yet.",
  input: z.strictObject({
    plan: idSchema,
    openOnly: z.boolean().optional(),
    page: pageSchema,
  }),
  output: z.strictObject({
    plan: z.string(),
    tasks: z.array(taskSchema),
    nextPage: z.string().nullable(),
  }),
  readOnly: true,
  reach: "company",
  resource: "plan",
  routes: [{ method: "GET", host: graphHost, path: `${plans}/tasks` }],
  run: async ({ plan, openOnly, page }) => {
    // Planner takes neither `$filter` nor `$top` on a plan's tasks: it
    // pages as it likes, and open tasks are kept here.
    const { value, "@odata.nextLink": nextLink } = await graphJson(
      atPage(graphUrl(`/planner/plans/${segment(plan)}/tasks`), page),
      pageOf(graphTask)
    );
    const tasks = value.filter((task) => openOnly !== true || !isDone(task));
    return {
      output: {
        plan,
        tasks: tasks.map(taskOf),
        nextPage: nextPageOf(nextLink),
      },
      provenance: tasks.map(({ id }) => id),
    };
  },
});

/** A day's form, `2026-10-30`. */
const dayPattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;

/** A day of the calendar; that it exists (no 30 February) is checked too. */
const daySchema = z
  .string()
  .regex(dayPattern)
  .refine(
    (day) => new Date(`${day}T00:00:00Z`).toISOString().startsWith(day),
    "No such day"
  );

const createTask = defineTool({
  name: "planner.create",
  description:
    "Adds an unassigned task to a Planner plan, with a due day if given.",
  input: z.strictObject({
    plan: idSchema,
    title: z.string().min(1).max(255),
    due: daySchema.optional(),
  }),
  output: z.strictObject({ plan: z.string(), task: taskSchema }),
  readOnly: false,
  reach: "company",
  destructive: false,
  resource: "plan",
  // Recovery `none`: a Planner task carries no property of ours to find it
  // by, and the same task may rightly be added twice, so one of unknown
  // outcome stays unknown, for its person to say what became of it.
  routes: [
    { method: "GET", host: graphHost, path: plans },
    // Planner names a new task's plan in its body, not its path: `run`
    // puts the call's own plan there, the one its capability bound when
    // it read the plan just before.
    { method: "POST", host: graphHost, path: `${v1}/planner/tasks` },
  ],
  describe: {
    title: "Add a task to Planner",
    fields: [
      { label: "Plan", input: "plan" },
      { label: "Title", input: "title" },
      { label: "Due", input: "due" },
    ],
  },
  run: async ({ plan, title, due }) => {
    // Graph refuses a plan the person can't open before anything is made.
    await planOf(plan);
    const task = await graphJson(
      graphUrl("/planner/tasks"),
      graphTask,
      jsonBody({
        planId: plan,
        title,
        // Planner keeps a due day as a time: noon UTC falls on that day in
        // every time zone from UTC-12 to UTC+11.
        ...(due === undefined ? {} : { dueDateTime: `${due}T12:00:00Z` }),
      })
    );
    const after = taskOf(task);
    return {
      output: { plan, task: after },
      change: { before: null, after },
    };
  },
});

export const plannerTools = [listTasks, createTask];

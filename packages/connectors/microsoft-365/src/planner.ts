import { page, tool, ToolError, v } from "@grasp-os/sdk/connector";

import {
  checkIds,
  graphId,
  graphPage,
  next,
  nextOf,
  positionOf,
} from "./graph-sdk.ts";

// Planner, one plan per call, as `/planner/plans/{plan}`, so a call's
// capability binds its reads to the plan. A plan belongs to a Microsoft 365
// group, a team's, so these reach `company`; Graph answers with the
// person's own rights (a delegated `Tasks.Read` or `Tasks.ReadWrite`
// token), and refuses a plan of a group they aren't in.
//
// A task is made unassigned. Assigning one tells the person it is
// assigned to, which would reach others: that is left out, so making a
// task stays Change company.

const planRoute = "/planner/plans/{plan}";
const planTasksRoute = "/planner/plans/{plan}/tasks";
const tasksRoute = "/planner/tasks";

const taskFields = {
  id: v.string(),
  planId: v.string().nullable().optional(),
  bucketId: v.string().nullable().optional(),
  title: v.string().nullable().optional(),
  percentComplete: v.number().nullable().optional(),
  priority: v.number().nullable().optional(),
  dueDateTime: v.string().nullable().optional(),
  createdDateTime: v.string().nullable().optional(),
  completedDateTime: v.string().nullable().optional(),
  // Each assignee's user ID, with how they were assigned.
  assignments: v.record(v.json()).nullable().optional(),
};

/** A Planner task (Graph's plannerTask), narrowed to these fields. */
const Task = v.object(taskFields);

/** A due time as Planner keeps a day: noon UTC on it. */
const duePattern =
  /^(?<day>\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))T12:00:00Z$/u;

/**
 * Refuses, before anything is sent, a due time that isn't noon UTC on a
 * day of the calendar (no 30 February).
 */
const checkDue = (due: string | undefined): void => {
  if (due === undefined) {
    return;
  }
  const day = duePattern.exec(due)?.groups?.day;
  if (
    day === undefined ||
    !new Date(`${day}T00:00:00Z`).toISOString().startsWith(day)
  ) {
    throw new ToolError(
      "Invalid input: dueDateTime isn't noon UTC on a day, such as 2026-10-30T12:00:00Z",
      { code: "invalid" }
    );
  }
};

/**
 * Planner tools, by name: each named from its route
 * (`POST /planner/tasks` is `planner.tasks.create`).
 */
export const plannerTools = {
  "planner.plans.tasks.list": tool({
    description:
      "Lists the tasks of a Planner plan, a page at a time: each task's title, bucket, progress, priority, due time and assignments. With completedDateTime null, only the tasks not completed yet.",
    readOnly: true,
    reach: "company",
    scopes: ["Tasks.Read"],
    resource: "plan",
    routes: [`GET ${planTasksRoute}`],
    args: { plan: graphId, completedDateTime: v.null().optional(), next },
    returns: page(Task),
    handler: async ({ plan, completedDateTime, ...args }, api) => {
      checkIds({ plan });
      // Planner takes neither `$filter` nor `$top` on a plan's tasks: it
      // pages as it likes, and open tasks are kept here.
      const answer = await api.get(planTasksRoute, {
        path: { plan },
        query: positionOf(args.next),
        returns: graphPage(Task),
      });
      return {
        items: answer.value.filter(
          (task) =>
            completedDateTime === undefined ||
            (task.completedDateTime ?? null) === null
        ),
        next: nextOf(answer["@odata.nextLink"]),
      };
    },
  }),
  "planner.tasks.create": tool({
    description:
      "Adds an unassigned task to a Planner plan, with a due time if given: Planner keeps a due day, so it is noon UTC on that day (2026-10-30T12:00:00Z), which falls on it in every time zone from UTC-12 to UTC+11.",
    readOnly: false,
    reach: "company",
    scopes: ["Tasks.ReadWrite"],
    resource: "plan",
    // No recovery: a Planner task carries no property of ours to find it
    // by, and the same task may rightly be added twice, so one of unknown
    // outcome stays unknown, for its person to say what became of it.
    //
    // Planner names a new task's plan in its body, not its path: the
    // handler puts the call's own plan there, the one its capability bound
    // when it read the plan just before.
    routes: [`POST ${tasksRoute}`, `GET ${planRoute}`],
    args: {
      plan: graphId,
      title: v.string().min(1).max(255),
      dueDateTime: v.string().min(1).max(32).optional(),
    },
    returns: Task,
    describe: {
      title: "Add a task to Planner",
      fields: [
        { label: "Plan", arg: "plan" },
        { label: "Title", arg: "title" },
        { label: "Due", arg: "dueDateTime" },
      ],
    },
    handler: async ({ plan, title, dueDateTime }, api, call) => {
      checkIds({ plan });
      checkDue(dueDateTime);
      // Graph refuses a plan the person can't open before anything is made.
      await api.get(planRoute, {
        path: { plan },
        returns: v.object({ id: v.string() }),
      });
      const task = await api.post(tasksRoute, {
        body: {
          planId: plan,
          title,
          ...(dueDateTime === undefined ? {} : { dueDateTime }),
        },
        returns: Task,
      });
      call.changed({ before: null, after: task });
      return task;
    },
  }),
};

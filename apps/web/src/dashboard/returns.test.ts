import type { Goal } from "@grasp-os/shared/brain";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type {
  AppWorkflowSummary as WorkflowSummary,
  RunActivity,
  RunActivityWorkflow,
} from "@grasp-os/shared/workflows";
import { describe, expect, it } from "vite-plus/test";

import { goalProgressOf, teamProgressOf } from "./returns.ts";

// The board's goals as the goals widget draws them (returns.ts): each by
// its newest wording, with the workflows linked to it and how far each is.

/** A workflow of the invoices App that handled `handled` items this week. */
const workflow = (name: string, handled: number): WorkflowSummary => ({
  type: "app",
  app: appIdSchema.parse("invoices"),
  appName: "Invoices",
  workflow: workflowIdSchema.parse(name),
  version: 1,
  owner: { userId: "owner", name: null },
  changesOwner: false,
  team: null,
  lastRun: {
    id: runIdSchema.parse(`run-${name}`),
    status: "completed",
    createdAt: "2026-10-27T09:00:00.000Z",
  },
  waiting: 0,
  failed: 0,
  handled,
  scheduleStopped: false,
});

const goal: Goal = {
  id: "goal-close",
  versions: [
    {
      title: "Close the books in three days",
      howWeNotice: "",
      sourceId: "src-board",
      date: "2026-10-01",
    },
    {
      title: "Close the books in two days",
      howWeNotice: "",
      sourceId: "src-board",
      date: "2026-10-15",
    },
  ],
  workflows: [
    { app: "invoices", workflow: "chase" },
    { app: "invoices", workflow: "remind" },
    // Linked, but not among the workflows the person reads: left out.
    { app: "invoices", workflow: "archive" },
  ],
};

describe("the board's goals", () => {
  it("are each their newest wording, with the workflows linked to them: live once they handle items, else in their test", () => {
    const [progress] = goalProgressOf(
      [goal],
      [workflow("chase", 12), workflow("remind", 0), workflow("other", 3)]
    );
    expect({
      title: progress?.title,
      rows: progress?.rows.map(({ workflow: { name, goalId }, stage }) => [
        name,
        goalId,
        stage,
      ]),
      live: progress?.live,
      // No hours are kept: no return.
      back: progress?.back,
      coming: progress?.coming,
      basis: progress?.rows.map(({ basis }) => basis),
    }).toStrictEqual({
      title: "Close the books in two days",
      rows: [
        ["chase", "goal-close", "live"],
        ["remind", "goal-close", "testing"],
      ],
      live: 1,
      back: 0,
      coming: 0,
      basis: ["unknown", "unknown"],
    });
  });
});

/** What `name` of the invoices App did over the week: completed runs, and how many asked no one. */
const ran = (
  name: string,
  completed: number,
  completedAlone: number
): RunActivityWorkflow => ({
  type: "app",
  app: appIdSchema.parse("invoices"),
  appName: "Invoices",
  workflow: workflowIdSchema.parse(name),
  current: true,
  started: completed,
  completed,
  failed: 0,
  completedAlone,
});

/** A week's activity of `workflows`. */
const week = (...workflows: RunActivityWorkflow[]): RunActivity => ({
  from: "2026-10-21",
  to: "2026-10-27",
  days: [],
  runs: { total: 0, withPerson: 0, withoutPerson: 0 },
  decisions: { approved: 0, rejected: 0, timedOut: 0, open: 0 },
  workflows,
});

const finance = { id: "team-finance", name: "Finance" };
const sales = { id: "team-sales", name: "Sales" };

describe("the teams with AI", () => {
  it("are the teams that own workflows, the furthest first, with what their workflows handled and how much of it without a person", () => {
    const read = teamProgressOf(
      [
        { ...workflow("chase", 12), team: finance },
        { ...workflow("remind", 0), team: finance },
        { ...workflow("quote", 0), team: sales },
        // No team owns it: no team counts it.
        workflow("archive", 3),
      ],
      week(ran("chase", 12, 9), ran("quote", 0, 0), ran("archive", 3, 3))
    );
    expect({
      teams: read.teams.map(
        ({ name, level, workflows, live, testing, handled, alone }) => ({
          name,
          level,
          workflows,
          live,
          testing,
          handled,
          alone,
        })
      ),
      rows: read.rows.map(({ workflow: { name, teamId }, stage }) => [
        name,
        teamId,
        stage,
      ]),
      // No hours are kept: nothing to say of cost, share or help.
      unknowns: read.teams.map(({ share, cost, needsHelp }) => [
        share,
        cost,
        needsHelp,
      ]),
    }).toStrictEqual({
      teams: [
        {
          name: "Finance",
          level: "live",
          workflows: 2,
          live: 1,
          testing: 1,
          handled: 12,
          alone: 9,
        },
        {
          name: "Sales",
          level: "testing",
          workflows: 1,
          live: 0,
          testing: 1,
          handled: 0,
          alone: 0,
        },
      ],
      rows: [
        ["chase", "team-finance", "live"],
        ["remind", "team-finance", "testing"],
        ["quote", "team-sales", "testing"],
      ],
      unknowns: [
        [null, 0, false],
        [null, 0, false],
      ],
    });
  });
});

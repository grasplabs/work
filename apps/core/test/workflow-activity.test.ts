import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { seedResourceRun } from "./runs.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// The dashboard's runs over time: the runs of the independent workflows a
// person has a role in, by the UTC day they started and how they stand
// now, and the decisions they asked people for. What could go wrong: a run
// of a workflow the person has no role in counted, another person's run
// counted for one of its users, a run counted on the wrong day or as the wrong outcome, a day
// without runs missing, a decision that ended with its run counted as
// open, a window longer than core reads, and a read that walks every run
// there is.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

const day = 24 * 60 * 60 * 1000;

/** The start of the UTC day `ago` days before today. */
const dayStart = (ago: number): number =>
  (Math.floor(Date.now() / day) - ago) * day;

/** `YYYY-MM-DD` of the UTC day `ago` days before today. */
const dateOf = (ago: number): string =>
  new Date(dayStart(ago)).toISOString().slice(0, 10);

interface SeededRun {
  status: "running" | "completed" | "failed" | "cancelled";
  /** How many UTC days before today it started. */
  ago: number;
  decision?: "open" | "approved" | "rejected" | "timed_out";
}

/**
 * A run of workflow `workflow` for `principal`, as core keeps it, started
 * halfway through its day (or through today so far), and its decision.
 */
const seedRun = async (
  workflow: string,
  principal: string,
  run: SeededRun
): Promise<void> => {
  const start = dayStart(run.ago);
  const createdAt =
    start + Math.floor((Math.min(Date.now(), start + day - 1) - start) / 2);
  const id = await seedResourceRun({
    workflow,
    principal,
    status: run.status,
    createdAt,
  });
  if (run.decision !== undefined) {
    const answered = run.decision === "approved" || run.decision === "rejected";
    await env.DB.prepare(
      "INSERT INTO workflow_decisions (id, resource_run_id, step, deciders, description, status, opened_at, expires_at, decided_at) VALUES (?, ?, 'review', 'role:admin', 'Approve it', ?, ?, ?, ?)"
    )
      .bind(
        `decision-${unique()}`,
        id,
        run.decision,
        createdAt,
        Date.now() + 7 * day,
        answered ? createdAt : null
      )
      .run();
  }
};

/** A day of the window with no runs. */
const none = (ago: number) => ({
  day: dateOf(ago),
  completed: 0,
  failed: 0,
  waiting: 0,
  other: 0,
  withPerson: 0,
});

describe("runs over time", () => {
  it("counts an independent workflow's runs as its page lists them: every run for its builders, their own for its users", async () => {
    const [owner, user, stranger] = await Promise.all([
      personApi("builder"),
      personApi("user"),
      personApi("builder"),
    ]);
    const workflow = await owner.api.workflowResources.create(
      `intake-${unique()}`
    );
    await owner.api.workflowResources.members.add(workflow.id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await Promise.all([
      seedResourceRun({
        workflow: workflow.id,
        principal: owner.userId,
        status: "completed",
        createdAt: dayStart(0),
      }),
      seedResourceRun({
        workflow: workflow.id,
        principal: user.userId,
        status: "failed",
        createdAt: dayStart(1),
      }),
      seedResourceRun({
        workflow: workflow.id,
        principal: user.userId,
        status: "running",
        createdAt: dayStart(1),
      }),
      // Before the week.
      seedResourceRun({
        workflow: workflow.id,
        principal: owner.userId,
        status: "completed",
        createdAt: dayStart(9),
      }),
    ]);
    const entry = (started: number, completed: number, failed: number) => ({
      workflowId: workflow.id,
      name: workflow.name,
      started,
      completed,
      failed,
      // None of these runs asked a person: each completed one was alone.
      completedAlone: completed,
    });
    const [asOwner, asUser, asStranger] = await Promise.all([
      owner.api.workflows.activity(),
      user.api.workflows.activity(),
      stranger.api.workflows.activity(),
    ]);
    expect({
      owner: [asOwner.days.slice(-2), asOwner.runs, asOwner.workflows],
      user: [asUser.days.slice(-2), asUser.runs, asUser.workflows],
      stranger: [asStranger.runs.total, asStranger.workflows],
    }).toStrictEqual({
      owner: [
        [
          { ...none(1), failed: 1, other: 1 },
          { ...none(0), completed: 1 },
        ],
        { total: 3, withPerson: 0, withoutPerson: 3 },
        [entry(3, 1, 1)],
      ],
      user: [
        [{ ...none(1), failed: 1, other: 1 }, none(0)],
        { total: 2, withPerson: 0, withoutPerson: 2 },
        [entry(2, 0, 1)],
      ],
      stranger: [0, []],
    });
  });

  it("returns every day of the window, with nothing counted, before anything ran", async () => {
    const person = await personApi("builder");
    const activity = await person.api.workflows.activity({ days: 1 });
    // Others' tests' Apps are not theirs to open: nothing of them counts.
    expect(activity).toStrictEqual({
      from: dateOf(0),
      to: dateOf(0),
      days: [none(0)],
      runs: { total: 0, withPerson: 0, withoutPerson: 0 },
      decisions: { approved: 0, rejected: 0, timedOut: 0, open: 0 },
      workflows: [],
    });
  });

  it("reads a window that ended before today as it was: its own days, and none after it", async () => {
    const owner = await personApi("builder");
    const { id: workflow } = await owner.api.workflowResources.create(
      `approve-${unique()}`
    );
    const seeded = async (run: SeededRun) => {
      await seedRun(workflow, owner.userId, run);
    };
    await Promise.all([
      seeded({ status: "completed", ago: 9 }),
      seeded({ status: "completed", ago: 7 }),
      seeded({ status: "failed", ago: 3 }),
      seeded({ status: "completed", ago: 2 }),
      seeded({ status: "completed", ago: 0 }),
    ]);
    // Five days, from 7 days ago to 3 days ago.
    const activity = await owner.api.workflows.activity({
      days: 5,
      to: dateOf(3),
    });
    expect({
      from: activity.from,
      to: activity.to,
      days: activity.days,
      runs: activity.runs,
      workflows: activity.workflows.map(({ started, completed, failed }) => ({
        started,
        completed,
        failed,
      })),
    }).toStrictEqual({
      from: dateOf(7),
      to: dateOf(3),
      days: Array.from({ length: 5 }, (_, index) => {
        const ago = 7 - index;
        return {
          ...none(ago),
          ...(ago === 7 ? { completed: 1 } : {}),
          ...(ago === 3 ? { failed: 1 } : {}),
        };
      }),
      runs: { total: 2, withPerson: 0, withoutPerson: 2 },
      workflows: [{ started: 2, completed: 1, failed: 1 }],
    });
  });

  it("refuses a window of other than 1 to 90 whole days, or one that ends after today", async () => {
    const { api } = await personApi("builder");
    const read = async (query?: unknown) =>
      await outcome(
        api.workflows.activity(
          // SAFETY: invalid on purpose: anything a client can send, as Cap'n
          // Web checks no types, so core must.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          query as never
        )
      );
    expect({
      none: await read(),
      one: await read({ days: 1 }),
      ninety: await read({ days: 90 }),
      zero: await read({ days: 0 }),
      longer: await read({ days: 91 }),
      part: await read({ days: 1.5 }),
      text: await read({ days: "7" }),
      more: await read({ days: 7, app: "other" }),
      past: await read({ days: 7, to: dateOf(10) }),
      today: await read({ days: 7, to: dateOf(0) }),
      future: await read({ days: 7, to: dateOf(-1) }),
      notADate: await read({ days: 7, to: "last week" }),
    }).toStrictEqual({
      none: "ok",
      one: "ok",
      ninety: "ok",
      zero: "workflow.invalid",
      longer: "workflow.invalid",
      part: "workflow.invalid",
      text: "workflow.invalid",
      more: "workflow.invalid",
      past: "ok",
      today: "ok",
      future: "workflow.invalid",
      notADate: "workflow.invalid",
    });
  });

  it("reads the window's runs of the person's workflows by index, with no statistics to go by", async () => {
    const owner = await personApi("admin");
    const workflow = await owner.api.workflowResources.create(
      `intake-${unique()}`
    );
    await Promise.all([
      seedRun(workflow.id, owner.userId, {
        status: "running",
        ago: 0,
        decision: "open",
      }),
      seedRun(workflow.id, owner.userId, { status: "completed", ago: 0 }),
    ]);
    const queries = await recordedQueries(
      async () => await owner.api.workflows.activity({ days: 90 })
    );
    const plans = await Promise.all(
      queries
        .filter(({ query }) => query.includes('"workflow_resource_runs"'))
        .map(async (recorded) => ({
          query: recorded.query,
          plan: await planOf(recorded),
        }))
    );
    // Each reads the runs by the start of their workflow's runs.
    expect({
      read: plans.length,
      fullScans: plans.filter(({ plan }) =>
        plan.some((step) => fullScan.test(step))
      ),
      byStart: plans.every(({ plan }) =>
        plan.some((step) => step.includes("workflow_resource_runs_newest_idx"))
      ),
    }).toStrictEqual({ read: 3, fullScans: [], byStart: true });
  });
});

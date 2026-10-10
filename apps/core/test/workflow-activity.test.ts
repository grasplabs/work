import { workflowIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import type { RunActivity } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// The dashboard's runs over time: the runs of the Apps a person can open,
// by the UTC day they started and how they stand now, and the decisions
// they asked people for. What could go wrong: a run of an App the person
// can't open counted, a run counted on the wrong day or as the wrong
// outcome, a day without runs missing, a decision that ended with its run
// counted as open, a window longer than core reads, and a read that walks
// every run there is.

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
  workflow: string;
  status: "running" | "completed" | "failed" | "cancelled";
  /** How many UTC days before today it started. */
  ago: number;
  decision?: "open" | "approved" | "rejected" | "timed_out";
}

/**
 * A run of `app`'s as core keeps it, started halfway through its day (or
 * through today so far), and its decision.
 */
const seedRun = async (app: string, run: SeededRun): Promise<void> => {
  const id = `run-${unique()}`;
  const start = dayStart(run.ago);
  const createdAt =
    start + Math.floor((Math.min(Date.now(), start + day - 1) - start) / 2);
  const ended = run.status !== "running";
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) VALUES (?, ?, ?, 1, NULL, ?, ?, ?)"
  )
    .bind(
      id,
      app,
      run.workflow,
      run.status,
      createdAt,
      ended ? createdAt : null
    )
    .run();
  if (run.decision !== undefined) {
    const answered = run.decision === "approved" || run.decision === "rejected";
    await env.DB.prepare(
      "INSERT INTO workflow_decisions (id, run_id, step, deciders, description, status, opened_at, expires_at, decided_at) VALUES (?, ?, 'review', 'role:admin', 'Approve it', ?, ?, ?, ?)"
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

/** The days of a window of `days`, oldest first, none of them with runs but as `ran` says. */
const daysOf = (
  days: number,
  ran: Record<number, Partial<RunActivity["days"][number]>>
) =>
  Array.from({ length: days }, (_, index) => {
    const ago = days - 1 - index;
    return { ...none(ago), ...ran[ago] };
  });

describe("runs over time", () => {
  it("counts the runs of the Apps the person can open by day and outcome, and the people they needed", async () => {
    const [owner, other, user] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("user"),
    ]);
    const appName = `Invoices ${unique()}`;
    const { id: app } = await owner.api.apps.create({ name: appName });
    const { id: hidden } = await other.api.apps.create({
      name: `Payroll ${unique()}`,
    });
    // Its current version has `approve`: `remind` ran, but a later
    // version removed it, so it has no page to open.
    const { version } = await owner.api.apps.files.commit(
      app,
      { "workflows/approve.ts": "export default {};\n" },
      "Workflows"
    );
    await env.DB.prepare("UPDATE apps SET current_version = ? WHERE id = ?")
      .bind(version, app)
      .run();
    await owner.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await Promise.all([
      // Today: two completed, one asking a person; one waiting; one failed.
      seedRun(app, { workflow: "approve", status: "completed", ago: 0 }),
      seedRun(app, {
        workflow: "approve",
        status: "completed",
        ago: 0,
        decision: "approved",
      }),
      seedRun(app, {
        workflow: "approve",
        status: "running",
        ago: 0,
        decision: "open",
      }),
      seedRun(app, { workflow: "remind", status: "failed", ago: 0 }),
      // Two days ago: one rejected and failed; one cancelled while its
      // decision was open, which nobody answers any more.
      seedRun(app, {
        workflow: "approve",
        status: "failed",
        ago: 2,
        decision: "rejected",
      }),
      seedRun(app, {
        workflow: "remind",
        status: "cancelled",
        ago: 2,
        decision: "open",
      }),
      // Three days ago: still running once its decision timed out.
      seedRun(app, {
        workflow: "approve",
        status: "running",
        ago: 3,
        decision: "timed_out",
      }),
      // Before the week: only a longer window counts it.
      seedRun(app, { workflow: "remind", status: "completed", ago: 8 }),
      // An App the owner can't open.
      seedRun(hidden, { workflow: "pay", status: "completed", ago: 0 }),
    ]);

    const week: RunActivity = {
      from: dateOf(6),
      to: dateOf(0),
      days: daysOf(7, {
        0: { completed: 2, failed: 1, waiting: 1, withPerson: 2 },
        2: { failed: 1, other: 1, withPerson: 2 },
        3: { other: 1, withPerson: 1 },
      }),
      runs: { total: 7, withPerson: 5, withoutPerson: 2 },
      decisions: { approved: 1, rejected: 1, timedOut: 1, open: 1 },
      workflows: [
        {
          app,
          appName,
          workflow: workflowIdSchema.parse("approve"),
          current: true,
          started: 5,
          completed: 2,
          failed: 1,
        },
        {
          app,
          appName,
          workflow: workflowIdSchema.parse("remind"),
          current: false,
          started: 2,
          completed: 0,
          failed: 1,
        },
      ],
    };
    const [asOwner, asUser, asOther, month] = await Promise.all([
      owner.api.workflows.activity(),
      user.api.workflows.activity({ days: 7 }),
      other.api.workflows.activity(),
      owner.api.workflows.activity({ days: 30 }),
    ]);
    expect(asOwner).toStrictEqual(week);
    expect(asUser).toStrictEqual(week);
    expect({
      runs: asOther.runs,
      workflows: asOther.workflows.map(({ app: id }) => id),
    }).toStrictEqual({
      runs: { total: 1, withPerson: 0, withoutPerson: 1 },
      workflows: [hidden],
    });
    expect({
      from: month.from,
      days: month.days.length,
      eightDaysAgo: month.days.at(-9),
      runs: month.runs.total,
      remind: month.workflows.find(({ workflow }) => workflow === "remind"),
    }).toStrictEqual({
      from: dateOf(29),
      days: 30,
      eightDaysAgo: { ...none(8), completed: 1 },
      runs: 8,
      remind: {
        app,
        appName,
        workflow: "remind",
        current: false,
        started: 3,
        completed: 1,
        failed: 1,
      },
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

  it("refuses a window of other than 1 to 90 whole days", async () => {
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
    }).toStrictEqual({
      none: "ok",
      one: "ok",
      ninety: "ok",
      zero: "workflow.invalid",
      longer: "workflow.invalid",
      part: "workflow.invalid",
      text: "workflow.invalid",
      more: "workflow.invalid",
    });
  });

  it("reads the window's runs of the person's Apps by index, with no statistics to go by", async () => {
    const owner = await personApi("admin");
    const { id: app } = await owner.api.apps.create({
      name: `Invoices ${unique()}`,
    });
    await seedRun(app, {
      workflow: "approve",
      status: "running",
      ago: 0,
      decision: "open",
    });
    const queries = await recordedQueries(
      async () => await owner.api.workflows.activity({ days: 90 })
    );
    const plans = await Promise.all(
      queries
        .filter(({ query }) => query.includes('"workflow_runs"'))
        .map(async (recorded) => ({
          query: recorded.query,
          plan: await planOf(recorded),
        }))
    );
    expect({
      read: plans.length,
      fullScans: plans.filter(({ plan }) =>
        plan.some((step) => fullScan.test(step))
      ),
      byStart: plans.every(({ plan }) =>
        plan.some((step) => step.includes("workflow_runs_app_idx"))
      ),
    }).toStrictEqual({ read: 3, fullScans: [], byStart: true });
  });
});

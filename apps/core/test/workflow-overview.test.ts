import type { Role } from "@grasp-os/shared/roles";
import { failedRunDays } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { revokeWorkflowBinding } from "../src/workflow-bindings.ts";
import {
  connectHubspot,
  connectingAdmin,
  crmWorkflow,
} from "./hubspot-workflow.ts";
import { mockIdp } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { seedResourceRun } from "./runs.ts";
import { signedInApi, unique } from "./sign-in.ts";

// The Workflows page: every independent workflow a person has a role in,
// the runs across them, and the workflows that use a connection. What
// could go wrong: a workflow or run someone has no role in showing up,
// counts that count the wrong runs, or a workflow listed to someone it
// isn't shared with, or still listed once its approval goes. A workflow's
// use of a connection runs as a JSON workflow.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/** The IDs of the workflows `person` is told use `connection`. */
const workflowsUsing = async (
  person: {
    api: { workflows: Pick<Person["api"]["workflows"], "byConnection"> };
  },
  connection: string
): Promise<string[]> => {
  const uses = await person.api.workflows.byConnection();
  const using = uses.find(({ connectionId }) => connectionId === connection);
  return (using?.workflows ?? []).map(({ id }) => id);
};

/**
 * A decision of the run `run` at its step `step`, opened at `openedAt`
 * (now, unless given): open until `expiresAt`.
 */
const seedDecision = async (
  run: string,
  step: string,
  expiresAt: number,
  openedAt = Date.now()
): Promise<void> => {
  await env.DB.prepare(
    "INSERT INTO workflow_decisions (id, resource_run_id, step, deciders, description, status, opened_at, expires_at) VALUES (?, ?, ?, 'role:admin', 'Approve it', 'open', ?, ?)"
  )
    .bind(`decision-${unique()}`, run, step, openedAt, expiresAt)
    .run();
};

/**
 * A cancel of the run `run` by `principal`, through an App's page, in
 * `state`: admitted until the engine stops the run, or superseded when the
 * run went on to end otherwise first.
 */
const seedCancel = async (
  run: string,
  principal: string,
  state: "admitted" | "superseded"
): Promise<void> => {
  const app = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Desk', '', ?, ?)"
    ).bind(app, principal, now),
    env.DB.prepare(
      "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, created_at, next_at, generation) VALUES (?, ?, ?, ?, ?, 'cancel', ?, ?, ?, 1)"
    ).bind(
      crypto.randomUUID(),
      run,
      app,
      principal,
      "0".repeat(32),
      state,
      now,
      now
    ),
  ]);
};

/**
 * The independent workflows `person` sees summed up, each with its owner's
 * ID for its owner.
 */
const independent = async (person: Person) => {
  const all = await person.api.workflows.overview();
  return all.map((row) => ({ ...row, owner: row.owner.userId }));
};

/** A statement that groups what it reads: a count. */
const grouped = /group by/iu;

const minute = 60_000;
const day = 24 * 60 * minute;

// Signing people in and connecting accounts takes longer than the
// default five seconds on a loaded runner. Sixty is room for a slow
// runner, not for a hang.
const buildTime = { timeout: 60_000 };

describe("the Workflows page", buildTime, () => {
  it("lists the independent workflows a person has a role in, each summed up from the runs its page lists them", async () => {
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
    const now = Date.now();
    const runs = await Promise.all([
      seedResourceRun({
        workflow: workflow.id,
        principal: owner.userId,
        status: "completed",
        createdAt: now - day,
      }),
      // Failed, but before the failures counted.
      seedResourceRun({
        workflow: workflow.id,
        principal: owner.userId,
        status: "failed",
        createdAt: now - (failedRunDays + 1) * day,
      }),
      seedResourceRun({
        workflow: workflow.id,
        principal: user.userId,
        status: "failed",
        createdAt: now - minute * 2,
      }),
      seedResourceRun({
        workflow: workflow.id,
        principal: owner.userId,
        status: "running",
        createdAt: now - minute,
      }),
    ]);
    const [usersLatest, ownersLatest] = runs.slice(2);
    const summary = (change: object) => ({
      workflowId: workflow.id,
      name: workflow.name,
      version: null,
      owner: owner.userId,
      waiting: 0,
      ...change,
    });
    expect({
      owner: await independent(owner),
      user: await independent(user),
      stranger: await independent(stranger),
    }).toStrictEqual({
      // Its builder sees every run.
      owner: [
        summary({
          lastRun: {
            id: ownersLatest,
            status: "running",
            createdAt: new Date(now - minute).toISOString(),
          },
          failed: 1,
          handled: 1,
        }),
      ],
      // Its user, their own alone.
      user: [
        summary({
          lastRun: {
            id: usersLatest,
            status: "failed",
            createdAt: new Date(now - minute * 2).toISOString(),
          },
          failed: 1,
          handled: 0,
        }),
      ],
      stranger: [],
    });
  });

  it("counts and lists a run waiting for a decision once, however many it waits for, and none that ended, whose decision is past its deadline, or whose cancel was admitted", async () => {
    const owner = await personApi("builder");
    const workflow = await owner.api.workflowResources.create(
      `intake-${unique()}`
    );
    const now = Date.now();
    const seeded = async (status: "running" | "completed", createdAt: number) =>
      await seedResourceRun({
        workflow: workflow.id,
        principal: owner.userId,
        status,
        createdAt,
      });
    const [waiting, ended, lapsed, cancelling, uncancelled] = await Promise.all(
      [
        seeded("running", now - minute),
        seeded("completed", now - minute),
        seeded("running", now - minute),
        // The latest run: cancelled, the engine yet to stop it.
        seeded("running", now),
        // A cancel superseded: the run went on, and still waits.
        seeded("running", now - 2 * minute),
      ]
    );
    // The waiting list comes latest to wait first: `waiting` asked last.
    await Promise.all([
      seedDecision(waiting, "review", now + day, now - minute),
      seedDecision(waiting, "sign", now + day, now),
      seedDecision(ended, "review", now + day),
      seedDecision(lapsed, "review", now - minute),
      seedDecision(cancelling, "review", now + day),
      seedDecision(uncancelled, "review", now + day, now - 2 * minute),
    ]);
    await Promise.all([
      seedCancel(cancelling, owner.userId, "admitted"),
      seedCancel(uncancelled, owner.userId, "superseded"),
    ]);
    const [[summary], listed, all] = await Promise.all([
      independent(owner),
      owner.api.workflows.runs({ status: "waiting" }),
      owner.api.workflows.runs(),
    ]);
    // A cancelled run shows as running until the engine stops it, as
    // answering its decision is refused (decisions.ts).
    expect({
      waiting: summary?.waiting,
      latest: summary?.lastRun?.status,
      listed: listed.runs.map(({ id, status }) => ({ id, status })),
      cancelling: all.runs.find(({ id }) => id === cancelling)?.status,
    }).toStrictEqual({
      waiting: 2,
      latest: "running",
      listed: [
        { id: waiting, status: "waiting" },
        { id: uncancelled, status: "waiting" },
      ],
      cancelling: "running",
    });
  });

  it("reads runs by an index, never every run, with no statistics to go by", async () => {
    const owner = await personApi("admin");
    const workflow = await owner.api.workflowResources.create(
      `intake-${unique()}`
    );
    const now = Date.now();
    const runs = await Promise.all(
      (["running", "failed", "completed"] as const).map(
        async (status) =>
          await seedResourceRun({
            workflow: workflow.id,
            principal: owner.userId,
            status,
            createdAt: now,
          })
      )
    );
    await seedDecision(runs[0] ?? "", "review", now + day);
    // A fresh D1 has no statistics: SQLite goes by the queries alone.
    const stats = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%'"
    ).all();
    const { api } = owner;
    // The Workflows page and the dashboard read the overview; the Runs tab
    // lists every run, or the waiting ones.
    const calls = {
      overview: async () => await api.workflows.overview(),
      all: async () => await api.workflows.runs(),
      waiting: async () => await api.workflows.runs({ status: "waiting" }),
    };
    const plans = [];
    for (const [call, run] of Object.entries(calls)) {
      // oxlint-disable-next-line no-await-in-loop -- one call's statements at a time
      const queries = await recordedQueries(run);
      // oxlint-disable-next-line no-await-in-loop -- as above
      const planned = await Promise.all(
        queries
          .filter(({ query }) => query.includes('"workflow_resource_runs"'))
          .map(async (recorded) => ({
            call,
            query: recorded.query,
            plan: await planOf(recorded),
          }))
      );
      plans.push(...planned);
    }
    // Finished runs pile up. No read of the overview or the runs reads the
    // table whole, and a count looks its runs up, never walks every run
    // (by any index) to find the few that wait or ended lately: a list
    // may walk an index in its own order, as it stops at a page.
    expect({
      stats: stats.results,
      calls: [...new Set(plans.map(({ call }) => call))],
      fullScans: plans.filter(({ plan }) =>
        plan.some((step) => fullScan.test(step))
      ),
      countWalks: plans.filter(
        ({ query, plan }) =>
          grouped.test(query) &&
          plan.some((step) => step.startsWith("SCAN workflow_resource_runs"))
      ),
    }).toStrictEqual({
      stats: [],
      calls: Object.keys(calls),
      fullScans: [],
      countWalks: [],
    });
  });

  it("lists an independent workflow that uses a connection through its approved binding, for those who can open it, until the approval goes", async () => {
    const by = await connectingAdmin(idp);
    const [hubspot, builder] = await Promise.all([
      connectHubspot(by),
      personApi("builder"),
    ]);
    const workflow = await crmWorkflow(by, hubspot);
    const asAdmin = { api: { workflows: by.workflows } };

    await expect(
      Promise.all([
        workflowsUsing(asAdmin, hubspot),
        // Not shared with them, so not theirs to see.
        workflowsUsing(builder, hubspot),
      ])
    ).resolves.toStrictEqual([[workflow.id], []]);

    await revokeWorkflowBinding(
      env,
      by.identity,
      workflow.id,
      workflow.approval
    );
    await expect(workflowsUsing(asAdmin, hubspot)).resolves.toStrictEqual([]);
  });
});

import type { WorkflowsToday } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { published, verifiedCandidate } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Runs › Today: the runs of the company's day across the workflows the
// person may see (workflows/today.ts). What could go wrong: a run of a
// workflow the person can't open named, or its workflow; whom someone
// else's run waits on, or since when, told; a run that waits on the
// reader not saying so; yesterday's runs on today's lanes; and a run
// pointing at one the reader may not see.

const idp = mockIdp();

const hour = 60 * 60 * 1000;

/** Today's midnight, UTC, in milliseconds: the organization's day here. */
const startOfToday = (): number =>
  Math.floor(Date.now() / (24 * hour)) * 24 * hour;

interface SeededRun {
  workflow: string;
  status: "running" | "completed" | "failed";
  /** When it started, in milliseconds. */
  at: number;
  /** Its decision: whom it asks, and whether it is still open. */
  asks?: { deciders: string; open: boolean };
  root?: string;
}

/** A run of `app`'s as core keeps it, and its decision: its ID and the decision's. */
const seedRun = async (
  app: string,
  run: SeededRun
): Promise<{ id: string; decision: string }> => {
  const id = `run-${unique()}`;
  const decision = `decision-${unique()}`;
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at, root_run_id) VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?)"
  )
    .bind(
      id,
      app,
      run.workflow,
      run.status,
      run.at,
      run.status === "running" ? null : run.at + 1000,
      run.root ?? null
    )
    .run();
  if (run.asks !== undefined) {
    await env.DB.prepare(
      "INSERT INTO workflow_decisions (id, run_id, step, deciders, description, status, opened_at, expires_at, decided_at) VALUES (?, ?, 'review', ?, 'Approve the invoice?', ?, ?, ?, ?)"
    )
      .bind(
        decision,
        id,
        run.asks.deciders,
        run.asks.open ? "open" : "approved",
        run.at + 500,
        Date.now() + 24 * hour,
        run.asks.open ? null : run.at + 900
      )
      .run();
  }
  return { id, decision };
};

/** An App of `owner`'s with workflow `approve` in its current version. */
const appOf = async (owner: Awaited<ReturnType<typeof signedInApi>>) => {
  const appName = `Invoices ${unique()}`;
  const { id } = await owner.api.apps.create({ name: appName });
  await published(id);
  const { version } = await owner.api.apps.files.commit(
    id,
    { "workflows/approve.ts": "export default {};\n" },
    "Workflows"
  );
  await verifiedCandidate(id, version);
  await env.DB.prepare("UPDATE apps SET current_version = ? WHERE id = ?")
    .bind(version, id)
    .run();
  return { id, appName };
};

/** Each lane's runs, by what the lane is, as the reader reads them. */
const lanesOf = (today: WorkflowsToday) =>
  today.lanes.map((lane) => ({
    lane: lane.kind === "app" ? lane.app : lane.id,
    runs: lane.runs.map(({ id, went, waits, waitsOnOthers, from }) => ({
      id,
      went,
      waits,
      waitsOnOthers,
      from,
    })),
  }));

describe("today's runs", () => {
  it("lays the day's runs of the workflows the person sees on lanes, says what waits on them, and only counts the rest", async () => {
    const [owner, other] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    // The organization's day, in UTC here: from its midnight.
    await env.DB.prepare(
      "UPDATE organizations SET time_zone = 'UTC' WHERE id = 'organization'"
    ).run();
    // Each run at its own moment of today, counted from its midnight, so
    // the day holds them in this order whatever time it is: never pressed
    // together at midnight, nor on yesterday. Today's read takes the runs
    // started since its midnight, whether or not that moment has come.
    const midnight = startOfToday();
    const minutesIn = (minutes: number) => midnight + minutes * 60_000;
    const app = await appOf(owner);
    const hidden = await appOf(other);

    const alone = await seedRun(app.id, {
      workflow: "approve",
      status: "completed",
      at: minutesIn(10),
    });
    const askedOwner = await seedRun(app.id, {
      workflow: "approve",
      status: "running",
      at: minutesIn(20),
      asks: { deciders: `person:${owner.userId}`, open: true },
      root: alone.id,
    });
    const askedAdmins = await seedRun(app.id, {
      workflow: "approve",
      status: "running",
      at: minutesIn(30),
      asks: { deciders: "role:admin", open: true },
    });
    const answered = await seedRun(app.id, {
      workflow: "approve",
      status: "completed",
      at: minutesIn(40),
      asks: { deciders: "role:admin", open: false },
      // From a run the owner may not see.
      root: `run-${unique()}`,
    });
    // Yesterday's run is no run of today.
    await seedRun(app.id, {
      workflow: "approve",
      status: "completed",
      at: midnight - hour,
    });
    // A run of an App the owner can't open.
    await seedRun(hidden.id, {
      workflow: "approve",
      status: "completed",
      at: minutesIn(50),
    });

    const today = await owner.api.workflows.today();
    expect({
      from: today.from,
      timeZone: today.timeZone,
      cutOff: today.cutOff,
      lanes: lanesOf(today),
    }).toStrictEqual({
      from: new Date(midnight).toISOString(),
      timeZone: "UTC",
      cutOff: 0,
      lanes: [
        {
          lane: app.id,
          runs: [
            {
              id: alone.id,
              went: "alone",
              waits: null,
              waitsOnOthers: false,
              from: null,
            },
            {
              id: askedOwner.id,
              went: "people",
              waits: {
                decision: askedOwner.decision,
                on: { kind: "you" },
                since: new Date(minutesIn(20) + 500).toISOString(),
                asks: "Approve the invoice?",
              },
              waitsOnOthers: false,
              from: alone.id,
            },
            {
              id: askedAdmins.id,
              went: "people",
              // Whom it waits on, and since when, isn't the owner's to read.
              waits: null,
              waitsOnOthers: true,
              from: null,
            },
            {
              id: answered.id,
              went: "people",
              waits: null,
              waitsOnOthers: false,
              from: null,
            },
          ],
        },
      ],
    });
    // The other App's run is counted, never named; the other builder
    // sees only their own App's lane, and counts the owner's runs.
    const theirs = await other.api.workflows.today();
    expect({
      ownerCounts: today.unseen >= 1,
      theirLanes: lanesOf(theirs).map(({ lane }) => lane),
      theyCount: theirs.unseen >= 4,
      theyReadTheDecision: JSON.stringify(theirs).includes(askedOwner.decision),
    }).toStrictEqual({
      ownerCounts: true,
      theirLanes: [hidden.id],
      theyCount: true,
      theyReadTheDecision: false,
    });

    // An admin is asked by the role: the run waits on them, by it.
    const admin = await signedInApi(idp, "admin");
    const asAdmin = await admin.api.workflows.today();
    const lane = asAdmin.lanes.find(
      (each) => each.kind === "app" && each.app === app.id
    );
    expect(
      lane?.runs.find(({ id }) => id === askedAdmins.id)?.waits
    ).toStrictEqual({
      decision: askedAdmins.decision,
      on: { kind: "role", role: "admin" },
      since: new Date(minutesIn(30) + 500).toISOString(),
      asks: "Approve the invoice?",
    });
  });

  it("keeps the newest runs of a busy day, and every run waiting on the reader however early, and counts the rest apart", async () => {
    const owner = await signedInApi(idp, "builder");
    await env.DB.prepare(
      "UPDATE organizations SET time_zone = 'UTC' WHERE id = 'organization'"
    ).run();
    const app = await appOf(owner);
    // A millisecond apart from a minute past today's midnight, never two
    // at once, whatever time it is: a run asking the owner first, then
    // more runs than one read takes, then another asking the owner.
    const first = startOfToday() + 60_000;
    const asksFirst = await seedRun(app.id, {
      workflow: "approve",
      status: "running",
      at: first,
      asks: { deciders: `person:${owner.userId}`, open: true },
    });
    const earlier = 1001;
    const runs = Array.from({ length: earlier }, (_, index) =>
      env.DB.prepare(
        "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at, root_run_id) VALUES (?, ?, 'approve', 1, NULL, 'completed', ?, ?, NULL)"
      ).bind(`run-${unique()}`, app.id, first + 1 + index, first + 2 + index)
    );
    await env.DB.batch(runs);
    const asksLast = await seedRun(app.id, {
      workflow: "approve",
      status: "running",
      at: first + 1 + earlier,
      asks: { deciders: `person:${owner.userId}`, open: true },
    });

    const today = await owner.api.workflows.today();
    const shown = today.lanes.flatMap(({ runs: laneRuns }) => laneRuns);
    const waitsOf = (id: string) =>
      shown.find((run) => run.id === id)?.waits?.on;
    expect({
      shown: shown.length,
      cutOff: today.cutOff,
      oldest: shown.at(0)?.id,
      newest: shown.at(-1)?.id,
      waitsFirst: waitsOf(asksFirst.id),
      waitsLast: waitsOf(asksLast.id),
    }).toStrictEqual({
      // The newest 1,000, and the early wait beside them.
      shown: 1001,
      // The two earliest of the others, which the owner may see: not
      // counted as unseen.
      cutOff: 2,
      oldest: asksFirst.id,
      newest: asksLast.id,
      waitsFirst: { kind: "you" },
      waitsLast: { kind: "you" },
    });
  });
});

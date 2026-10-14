import { stepIdempotencyKey } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { projectStatus } from "../src/workflows/runs.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { racingDb } from "./racing-db.ts";
import { signedInApi } from "./sign-in.ts";

// The one writer of a run's status: the engine's notifications, as the
// run's row takes them (runs.ts, `projectStatus`). Delivery is at least
// once and may be late, so what could go wrong is a notification taken
// twice, an older one taking over a newer, an ended run brought back, an
// end audited twice, and a cancelled run recorded as failed. Each is
// handed to the projection as the run object hands it on.

const idp = mockIdp();

/** A run's row, as a start leaves it, of a new App. */
const runRow = async (cancelled = false): Promise<string> => {
  const builder = await signedInApi(idp, "builder");
  const { id: app } = await builder.api.apps.create({ name: "Invoices" });
  const run = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, cancel_requested_at) VALUES (?, ?, 'tidy', 1, ?, 'starting', ?, ?)"
  )
    .bind(run, app, builder.userId, Date.now(), cancelled ? Date.now() : null)
    .run();
  return run;
};

/** The run's row: its status, sequence, end and failure report. */
const rowOf = async (run: string) =>
  await env.DB.prepare(
    "SELECT status, engine_sequence AS sequence, ended_at IS NOT NULL AS ended, failure FROM workflow_runs WHERE id = ?"
  )
    .bind(run)
    .first<{
      status: string;
      sequence: number;
      ended: number;
      failure: string | null;
    }>();

/** What a failure report says of its error. */
const failureSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/** The run's audit events, by action. */
const auditedOf = async (run: string): Promise<string[]> => {
  const events = await allEvents();
  return events
    .filter(({ target }) => target?.id === run)
    .map(({ action }) => action)
    .toSorted();
};

describe("a run's status, as the engine's notifications set it", () => {
  it("takes only a notification newer than the last, never one twice, and never leaves an end", async () => {
    const run = await runRow();
    const at = Date.now();

    await projectStatus(env, run, { status: "running", at, sequence: 3 });
    const running = await rowOf(run);
    // Late: an older one, delivered after.
    await projectStatus(env, run, { status: "paused", at, sequence: 2 });
    const afterLate = await rowOf(run);
    await projectStatus(env, run, { status: "complete", at, sequence: 5 });
    // The same one again, then a newer one after the end.
    await projectStatus(env, run, { status: "complete", at, sequence: 5 });
    await projectStatus(env, run, { status: "running", at, sequence: 7 });

    expect({
      running: running?.status,
      afterLate: afterLate?.status,
      ended: await rowOf(run),
      audited: await auditedOf(run),
    }).toStrictEqual({
      running: "running",
      afterLate: "running",
      ended: { status: "completed", sequence: 5, ended: 1, failure: null },
      audited: ["workflow.run.completed"],
    });
  });

  it("records a cancelled run the engine ended as errored as cancelled, not failed", async () => {
    const run = await runRow(true);

    await projectStatus(env, run, {
      status: "errored",
      at: Date.now(),
      sequence: 4,
    });

    expect({
      row: await rowOf(run),
      audited: await auditedOf(run),
    }).toStrictEqual({
      row: { status: "cancelled", sequence: 4, ended: 1, failure: null },
      // Its cancel was audited when it was asked for.
      audited: [],
    });
  });

  it("gives a run the engine ended as errored without a report of its own one saying it stopped, audited and notified once", async () => {
    const run = await runRow();
    const at = Date.now();

    await projectStatus(env, run, { status: "errored", at, sequence: 2 });
    await projectStatus(env, run, { status: "errored", at, sequence: 3 });
    const row = await rowOf(run);
    const report = failureSchema.parse(JSON.parse(row?.failure ?? "null"));

    expect({
      status: row?.status,
      error: report.error,
      audited: await auditedOf(run),
    }).toStrictEqual({
      status: "failed",
      error: {
        code: "workflow.run_failed",
        message: "The workflow run stopped.",
      },
      audited: ["workflow.run.failed", "workflow.run.notified"],
    });
  });

  it("audits a run cancelled while the engine's end is projected once, by its cancel", async () => {
    const run = await runRow();
    // The cancel lands after the projection read the row, before it writes.
    const racing = racingDb(async (db) => {
      await db
        .prepare(
          "UPDATE workflow_runs SET cancel_requested_at = ? WHERE id = ? AND cancel_requested_at IS NULL"
        )
        .bind(Date.now(), run)
        .run();
    });

    await projectStatus({ ...env, DB: racing }, run, {
      status: "terminated",
      at: Date.now(),
      sequence: 2,
    });

    expect({
      row: await rowOf(run),
      // The cancel audits it when it is asked for; the system never does.
      audited: await auditedOf(run),
    }).toStrictEqual({
      row: { status: "cancelled", sequence: 2, ended: 1, failure: null },
      audited: [],
    });
  });

  it("records a run cancelled while the engine's error is projected as cancelled, with no failure report or notice", async () => {
    const run = await runRow();
    // The cancel lands after the projection read the row, before it writes.
    const racing = racingDb(async (db) => {
      await db
        .prepare(
          "UPDATE workflow_runs SET cancel_requested_at = ? WHERE id = ? AND cancel_requested_at IS NULL"
        )
        .bind(Date.now(), run)
        .run();
    });

    await projectStatus({ ...env, DB: racing }, run, {
      status: "errored",
      at: Date.now(),
      sequence: 2,
    });

    expect({
      row: await rowOf(run),
      audited: await auditedOf(run),
    }).toStrictEqual({
      row: { status: "cancelled", sequence: 2, ended: 1, failure: null },
      audited: [],
    });
  });

  it("forgets the statistics points of an ended run's steps with its end, even when the first write of it fails", async () => {
    const run = await runRow();
    await env.DB.prepare(
      "INSERT INTO app_statistic_steps (step_key, attempt, app_id, measure, day, dimensions, count, sum, min, max, committed) VALUES (?, 'attempt', 'app', 'mails', '2026-10-12', '{}', 1, 1, 1, 1, 0)"
    )
      .bind(stepIdempotencyKey(run, "send"))
      .run();
    const kept = async () =>
      await env.DB.prepare(
        "SELECT count(*) AS kept FROM app_statistic_steps WHERE step_key = ?"
      )
        .bind(stepIdempotencyKey(run, "send"))
        .first<number>("kept");
    // D1 fails the cleanup once, as it can (overloaded, timed out).
    let failing = true;
    const marked = new WeakSet<object>();
    const refuse = () => {
      if (failing) {
        failing = false;
        throw new Error("D1_ERROR: broken for the test");
      }
    };
    const flaky = new Proxy(env.DB, {
      get: (target, key) => {
        if (key === "prepare") {
          return (query: string) => {
            const statement = target.prepare(query);
            if (!/delete from "?app_statistic_steps"?/iu.test(query)) {
              return statement;
            }
            const proxied = new Proxy(statement, {
              get: (inner, name) => {
                const value: unknown = Reflect.get(inner, name);
                if (name === "run" && typeof value === "function") {
                  return async (...args: unknown[]) => {
                    refuse();
                    const result: unknown = await Reflect.apply(
                      value,
                      inner,
                      args
                    );
                    return result;
                  };
                }
                if (name === "bind" && typeof value === "function") {
                  return (...args: unknown[]) => {
                    const bound: unknown = Reflect.apply(value, inner, args);
                    if (typeof bound === "object" && bound !== null) {
                      marked.add(bound);
                    }
                    return bound;
                  };
                }
                if (typeof value !== "function") {
                  return value;
                }
                const own: unknown = value.bind(inner);
                return own;
              },
            });
            marked.add(proxied);
            return proxied;
          };
        }
        if (key === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (statements.some((statement) => marked.has(statement))) {
              refuse();
            }
            return await target.batch(statements);
          };
        }
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    const ending = { status: "complete", at: Date.now(), sequence: 4 } as const;

    const first = await projectStatus({ ...env, DB: flaky }, run, ending).then(
      () => "ok",
      () => "failed"
    );
    // The notification is delivered again.
    await projectStatus(env, run, ending);

    expect({ first, row: await rowOf(run), kept: await kept() }).toStrictEqual({
      first: "failed",
      row: { status: "completed", sequence: 4, ended: 1, failure: null },
      kept: 0,
    });
  });
});

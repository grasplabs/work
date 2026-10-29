import type { WorkflowDefinition } from "@grasp-os/workerflow/contracts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { adminDatabase } from "../src/db/act.ts";
import { stepBudget } from "../src/rollout/workflow.ts";
import { adminWorkflow, adminWorkflows } from "../src/workflow-runs.ts";
import { quickStep } from "../src/workflow-steps.ts";
import { ended, journalOf, runObject } from "./runs.ts";

// How long a run as long as a rollout may get takes on the admin's own
// Workerflow host (src/run-object.ts): rollouts moved there from
// Cloudflare Workflows (src/rollout/workflow.ts), and a rollout of the
// fleet may take up to `stepBudget` steps. A synthetic run of 1,000 steps,
// each a D1 read as a rollout's quick steps make, suspending now and then
// as a rollout does between rings, through the host's real object.

/** Steps in the synthetic run: more than a rollout may take. */
const steps = 1000;

/** Every this many steps, the run suspends for a moment, as between rings. */
const suspendEvery = 200;

/** The longest the whole run may take: far inside what staff wait for a rollout. */
const withinMs = 5 * 60_000;

/** A run of `steps` steps, each reading the admin's database once. */
const synthetic = (database: D1Database): WorkflowDefinition => ({
  run: async (_event, step): Promise<number> => {
    const db = adminDatabase(database);
    let read = 0;
    // oxlint-disable no-await-in-loop -- a run's steps, in turn
    for (let index = 0; index < steps; index += 1) {
      if (index > 0 && index % suspendEvery === 0) {
        await step.sleep(`pause ${index}`, "1 second");
      }
      read += await step.do(`step ${index}`, quickStep, async () => {
        const [row] = await db.all<{ one: number }>(sql`SELECT 1 AS one`);
        return row?.one ?? 0;
      });
    }
    // oxlint-enable no-await-in-loop
    return read;
  },
});

describe("a run as long as a rollout may get, on the admin's Workerflow host", () => {
  it(
    `runs ${steps} steps, more than a rollout's budget, in minutes at most`,
    async () => {
      const id = `budget-${crypto.randomUUID().slice(0, 8)}`;
      // The host's own object, running the synthetic definition under a
      // rollout's name: its journal, alarms and activations as a rollout's.
      await runInDurableObject(
        runObject(adminWorkflows.rollout, id),
        (object) => {
          Reflect.set(object, "definition", () => synthetic(env.DB));
        }
      );
      const started = Date.now();

      await adminWorkflow(env, adminWorkflows.rollout).create({
        id,
        params: {},
      });
      const status = await ended(adminWorkflows.rollout, id, 6 * 60_000);
      const tookMs = Date.now() - started;
      const journal = await journalOf(adminWorkflows.rollout, id);

      expect({
        status: status.status,
        output: status.status === "complete" ? status.output : undefined,
        stepsJournaled: journal.steps.filter(({ type }) => type === "do")
          .length,
        overBudget: steps > stepBudget,
        inTime: tookMs < withinMs,
      }).toStrictEqual({
        status: "complete",
        output: steps,
        stepsJournaled: steps,
        overBudget: true,
        inTime: true,
      });
    },
    7 * 60_000
  );
});

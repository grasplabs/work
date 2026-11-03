import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { startRun } from "../src/workflows/runs.ts";
import { mockIdp } from "./idp.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { aroundEngine, endLiveRuns, runObjectId } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// A run's row keeps the start it is to send the engine until the engine
// confirms it. A start that stopped in between (core stopped) leaves a
// row starting with that start pending; one core still can't send a
// quarter of an hour on is marked failed. Kept as an App run until a JSON
// run shows the same: a triggered run's key given up once its start is
// marked failed, so its trigger delivered again starts a new run. The
// rest of the start repair is covered on JSON runs
// (workflow-resource-runs.test.ts).

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

const minute = 60_000;

/**
 * A workflow that does one step, then sleeps a day:
 * a live run.
 */
const waiting = workflowFiles(
  "waits",
  `  await step.do("work", { description: "Work" }, async () => null);
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return null;`,
  { work: null }
);

/** A run's row as a triggered start leaves it that stopped `age` ago. */
const orphanOf = async (
  app: string,
  age: number,
  triggerKey: string
): Promise<string> => {
  const run = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, trigger_key, pending_start) VALUES (?, ?, 'waits', 1, NULL, 'starting', ?, ?, '{}')"
  )
    .bind(run, app, Date.now() - age, triggerKey)
    .run();
  return run;
};

/** A run's status as its row has it. */
const rowStatus = async (run: string): Promise<string | undefined> => {
  const row = await env.DB.prepare(
    "SELECT status FROM workflow_runs WHERE id = ?"
  )
    .bind(run)
    .first<{ status: string }>();
  return row?.status;
};

/** Once the run's row says `status`. */
const rowSays = async (run: string, status: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      await expect(rowStatus(run)).resolves.toBe(status);
    },
    { timeout: 10_000, interval: 100 }
  );
};

/**
 * Runs `run` while the engine won't take the starts of the runs `runs`
 * (its storage is down for them, say), and answers where they are: that
 * it has no record of them.
 */
const whileRefusingStarts = async <T>(
  runs: readonly string[],
  run: () => Promise<T>
): Promise<T> => {
  const objects = runs.map((id) => runObjectId(id));
  return await aroundEngine(async (method, call, object) => {
    if (method === "start" && objects.some((id) => id.equals(object))) {
      throw new Error("The engine is unavailable");
    }
    return await call();
  }, run);
};

/**
 * Ends what a test left: its live runs, then the rows whose start it left
 * pending, which a later repair would send.
 */
const endTest = async (): Promise<void> => {
  await endLiveRuns();
  await env.DB.prepare(
    "DELETE FROM workflow_runs WHERE pending_start IS NOT NULL"
  ).run();
};

describe("starts core stopped in the middle of", () => {
  afterEach(endTest);

  it("give up a triggered run's key once marked failed, so its trigger delivered again starts a new run", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    // A delivery whose start stopped, with nothing delivering it again
    // since (triggers were off), and the engine unreachable for it.
    const key = `event:${crypto.randomUUID()}`;
    const orphan = await orphanOf(app, 20 * minute, key);

    await whileRefusingStarts([orphan], async () => {
      await runMinuteTasks();
    });
    const again = await startRun(env, {
      app: appIdSchema.parse(app),
      workflow: workflowIdSchema.parse("waits"),
      input: undefined,
      startedBy: null,
      actor: { type: "system" },
      trigger: { type: "schedule", key, version: 1 },
    });
    await rowSays(again.id, "running");

    expect({
      orphan: await rowStatus(orphan),
      newRun: again.id !== orphan,
    }).toStrictEqual({ orphan: "failed", newRun: true });
  });
});

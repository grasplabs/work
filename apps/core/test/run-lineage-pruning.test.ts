import { runActorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import type { ModelsEnv } from "../src/models.ts";
import { runActor, startRun } from "../src/workflows/runs.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import { finished, sleeping } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// The model ledger prunes what it keeps of a run lineage (its spend and
// its alerts) once every run of it ended a retention ago, as core's own
// records of the runs say, and no open request reserves against it.
// AI Gateway is the outside system: a fake behind the AI binding. The
// runs, the engine, D1 and the ledger are real; where a test needs runs
// that ended long ago, it moves their end back in core's records, as time
// passing would.

const idp = mockIdp();

const workersAi = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Costs 519 micros from Llama 3.3: past a $0.01 lineage budget's 1% alert. */
const pricedAnswer = { text: "Hi.", inputTokens: 1000, outputTokens: 100 };

/** Longer ago than the ledger's 90-day retention. */
const longAgo = () => Date.now() - 91 * 24 * 60 * 60 * 1000;

/** An App of an idle workflow and one that waits a day, for `builder`. */
const lineageApp = async (builder: Awaited<ReturnType<typeof signedInApi>>) =>
  await appWith(builder, {
    ...workflowFiles("idle", "  return null;"),
    ...workflowFiles(
      "later",
      `  await step.sleep("pause", { description: "Wait", duration: "1 day" });
  return null;`
    ),
  });

/** Starts a run of `workflow` under `parent`, with `input`, as core starts a child. */
const startChild = async (
  app: string,
  workflow: string,
  parent: string,
  startedBy: string,
  input: Json = null
): Promise<string> => {
  const parentRun = runIdSchema.parse(parent);
  const run = await startRun(env, {
    app: appIdSchema.parse(app),
    workflow: workflowIdSchema.parse(workflow),
    input,
    startedBy,
    actor: runActor({ id: parentRun, appId: app, workflowId: workflow }),
    parent: parentRun,
  });
  return run.id;
};

/** One model call for each of `triggers`, counted against a $0.01 run budget. */
const spendFor = async (
  app: string,
  person: string,
  triggers: readonly AuditActor[]
): Promise<string[]> => {
  const fake = fakeGateway(...triggers.map(() => pricedAnswer));
  const coreEnv: ModelsEnv = {
    ...env,
    AI: fake.binding,
    MODEL_GATEWAY: {
      gateway: "grasp-os-test",
      models: [workersAi],
      budgets: { run: { limit: 0.01, alertAt: 1 } },
    },
  };
  const appId = appIdSchema.parse(app);
  const outcomes: string[] = [];
  for (const trigger of triggers) {
    outcomes.push(
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await outcome(
        models(coreEnv).call({
          model: workersAi,
          maxTokens: 100,
          input: "Hello.",
          purpose: "workflow.step",
          trigger,
          work: {
            authority: {
              subject: { type: "app", appId },
              onBehalfOf: person,
              mode: "interactive",
              appVersion: 1,
            },
            context: { type: "app", appId },
          },
        })
      )
    );
  }
  return outcomes;
};

/** Moves the end of `runs` back to `at` in core's records. */
const endedAt = async (at: number, ...runs: string[]): Promise<void> => {
  for (const run of runs) {
    // oxlint-disable-next-line no-await-in-loop -- one after another
    await env.DB.prepare("UPDATE workflow_runs SET ended_at = ? WHERE id = ?")
      .bind(at, run)
      .run();
  }
};

/** What the ledger keeps of lineage `root`: its spend rows and alert rows. */
const keptOf = async (root: string) =>
  await runInDurableObject(modelLedger(env), (_instance, state) => ({
    spend: state.storage.sql
      .exec(
        "SELECT 1 FROM spend WHERE scope = 'run' AND key = ? AND period = 'lineage'",
        root
      )
      .toArray().length,
    alerts: state.storage.sql
      .exec(
        "SELECT 1 FROM alerts WHERE scope = 'run' AND key = ? AND period = 'lineage'",
        root
      )
      .toArray().length,
  }));

/** The ledger's alarm, with its sweep, now. */
const swept = async (): Promise<void> => {
  // The sweep runs on the alarm; set it for now, then run it.
  await runInDurableObject(modelLedger(env), async (_instance, state) => {
    await state.storage.setAlarm(Date.now());
  });
  await runDurableObjectAlarm(modelLedger(env));
};

describe("run lineage pruning", { timeout: 90_000 }, () => {
  it("prune a lineage once every run of it ended a retention ago, and keep one that ended since, or one core has no run of", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await lineageApp(builder);
    const [old, recent] = await Promise.all([
      builder.api.workflows.start(app, "idle"),
      builder.api.workflows.start(app, "idle"),
    ]);
    await Promise.all([finished(old.id), finished(recent.id)]);
    const child = await startChild(app, "idle", old.id, builder.userId);
    await finished(child);
    const ghost = `run-${crypto.randomUUID()}`;
    const spent = await spendFor(app, builder.userId, [
      runActorOf({ runId: old.id, app, workflow: "idle" }),
      runActorOf({ runId: child, app, workflow: "idle", rootRunId: old.id }),
      runActorOf({ runId: recent.id, app, workflow: "idle" }),
      // A lineage no run core keeps names: nothing says it ended.
      runActorOf({ runId: ghost, app, workflow: "idle" }),
    ]);
    const before = await keptOf(old.id);
    await endedAt(longAgo(), old.id, child);

    await swept();

    expect({
      spent,
      before,
      old: await keptOf(old.id),
      recent: await keptOf(recent.id),
      ghost: await keptOf(ghost),
    }).toStrictEqual({
      spent: ["ok", "ok", "ok", "ok"],
      before: { spend: 1, alerts: 1 },
      old: { spend: 0, alerts: 0 },
      recent: { spend: 1, alerts: 1 },
      ghost: { spend: 1, alerts: 1 },
    });
  });

  it("sweep an idle ledger holding an ended lineage once it wakes, with no admission to set its alarm", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await lineageApp(builder);
    const root = await builder.api.workflows.start(app, "idle");
    await finished(root.id);
    await endedAt(longAgo(), root.id);
    // A ledger of its own that holds only the ended lineage's rows, with
    // no alarm set: its last alarm ended, and nothing was admitted since.
    const ledger = env.MODEL_LEDGER.getByName(crypto.randomUUID());
    await runInDurableObject(ledger, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO spend (scope, key, period, spent_micros, requests) VALUES ('run', ?, 'lineage', 519, 1)",
        root.id
      );
      state.storage.sql.exec(
        "INSERT INTO alerts (scope, key, period, kind, threshold_micros) VALUES ('run', ?, 'lineage', 'alert', 100)",
        root.id
      );
      await state.storage.deleteAlarm();
    });
    const armedBefore = await runInDurableObject(
      ledger,
      async (_instance, state) => await state.storage.getAlarm()
    );
    // Evicted, as an idle object is: the next request wakes it anew.
    await evictDurableObject(ledger);

    const alarmed = await runDurableObjectAlarm(ledger);
    const kept = await runInDurableObject(ledger, (_instance, state) => [
      state.storage.sql.exec("SELECT 1 FROM spend").toArray().length,
      state.storage.sql.exec("SELECT 1 FROM alerts").toArray().length,
    ]);

    expect({ armedBefore, alarmed, kept }).toStrictEqual({
      armedBefore: null,
      alarmed: true,
      kept: [0, 0],
    });
  });

  it("keep a lineage while any run of it is live, whatever its runs' input claims, its root long ended", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await lineageApp(builder);
    const root = await builder.api.workflows.start(app, "idle");
    await finished(root.id);
    // A child still waiting, its input claiming the lineage is over.
    const child = await startChild(app, "later", root.id, builder.userId, {
      ended: true,
      endedAt: longAgo(),
      status: "completed",
      rootRunId: root.id,
    });
    await sleeping(child, "pause");
    await spendFor(app, builder.userId, [
      runActorOf({ runId: child, app, workflow: "later", rootRunId: root.id }),
    ]);
    await endedAt(longAgo(), root.id);

    await swept();

    await expect(keptOf(root.id)).resolves.toStrictEqual({
      spend: 1,
      alerts: 1,
    });
    await builder.api.workflows.cancel(child);
  });

  it("keep a lineage a request held for a person still reserves against, however long ago its runs ended", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await lineageApp(builder);
    const root = await builder.api.workflows.start(app, "idle");
    await finished(root.id);
    await spendFor(app, builder.userId, [
      runActorOf({ runId: root.id, app, workflow: "idle" }),
    ]);
    // A request of it held for a person, its reservation released by
    // hand so only the hold says the lineage still owes something.
    const held = crypto.randomUUID();
    await runInDurableObject(modelLedger(env), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO requests (id, fingerprint, period, scopes, model, price_version, prices, reserved_micros, state, actor, dispatched_at, deadline, reconcile_at)
         VALUES (?, 'held', '2400-01', '[]', 'workers-ai/test', 'test', '{}', 0, 'quarantined', '{"type":"system"}', 0, 1, 1)`,
        held
      );
      state.storage.sql.exec(
        "INSERT INTO request_scopes (request_id, scope, key, period) VALUES (?, 'run', ?, 'lineage')",
        held,
        root.id
      );
    });
    await endedAt(longAgo(), root.id);

    await swept();
    const whileHeld = await keptOf(root.id);
    await runInDurableObject(modelLedger(env), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE requests SET state = 'settled', charged_micros = 0, settled_by = 'released', settled_at = ? WHERE id = ?",
        Date.now(),
        held
      );
    });
    await swept();

    expect({ whileHeld, once: await keptOf(root.id) }).toStrictEqual({
      whileHeld: { spend: 1, alerts: 1 },
      once: { spend: 0, alerts: 0 },
    });
  });
});

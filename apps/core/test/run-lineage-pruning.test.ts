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
import { runActor, startRun } from "../src/workflows/runs.ts";
import { mockIdp } from "./idp.ts";
import { fakeProviderFor } from "./model-provider.ts";
import { finished, sleeping } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// The model ledger prunes what it keeps of a run lineage (its spend) once
// every run of it ended a retention ago, as core's own records of the
// runs say.
// The model provider behind connect is the outside system
// (test/model-provider.ts). The runs, the engine, D1 and the ledger are
// real; where a test needs runs
// that ended long ago, it moves their end back in core's records, as time
// passing would.

const idp = mockIdp();

const mistral = "mistral/mistral-large-latest";

/** Costs 650 micros from Mistral Large. */
const pricedAnswer = { text: "Hi.", inputTokens: 1000, outputTokens: 100 };

const dayMs = 24 * 60 * 60 * 1000;

/** Longer ago than the ledger's 90-day retention. */
const longAgo = () => Date.now() - 91 * dayMs;

/** Longer ago than the oldest a lineage may grow (the platform's year). */
const pastAge = () => Date.now() - 366 * dayMs;

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

/** One model call for each of `triggers`, counted in its run lineage. */
const spendFor = async (
  app: string,
  person: string,
  triggers: readonly AuditActor[]
): Promise<string[]> => {
  await fakeProviderFor([mistral], ...triggers.map(() => pricedAnswer));
  const appId = appIdSchema.parse(app);
  const outcomes: string[] = [];
  for (const trigger of triggers) {
    outcomes.push(
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await outcome(
        models(env).call({
          model: mistral,
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

/** Moves the start of `runs` back to `at` in core's records. */
const startedAt = async (at: number, ...runs: string[]): Promise<void> => {
  for (const run of runs) {
    // oxlint-disable-next-line no-await-in-loop -- one after another
    await env.DB.prepare("UPDATE workflow_runs SET created_at = ? WHERE id = ?")
      .bind(at, run)
      .run();
  }
};

/** What the ledger keeps of lineage `root`: its spend rows. */
const keptOf = async (root: string) =>
  await runInDurableObject(
    modelLedger(env),
    (_instance, state) =>
      state.storage.sql
        .exec(
          "SELECT 1 FROM spend WHERE scope = 'run' AND key = ? AND period = 'lineage'",
          root
        )
        .toArray().length
  );

/** The ledger's alarm, with its sweep, now. */
const swept = async (): Promise<void> => {
  // The sweep runs on the alarm; set it, then run it. Set an hour ahead,
  // never for now: workerd would run one due now on its own, and this one
  // would then find none to run and return while that one still sweeps.
  await runInDurableObject(modelLedger(env), async (_instance, state) => {
    await state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
  });
  await expect(runDurableObjectAlarm(modelLedger(env))).resolves.toBeTruthy();
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
    await startedAt(pastAge(), old.id, child);

    await swept();

    expect({
      spent,
      before,
      old: await keptOf(old.id),
      recent: await keptOf(recent.id),
      ghost: await keptOf(ghost),
    }).toStrictEqual({
      spent: ["ok", "ok", "ok", "ok"],
      before: 1,
      old: 0,
      recent: 1,
      ghost: 1,
    });
  });

  it("sweep an idle ledger holding an ended lineage once it wakes, with no admission to set its alarm", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await lineageApp(builder);
    const root = await builder.api.workflows.start(app, "idle");
    await finished(root.id);
    await endedAt(longAgo(), root.id);
    await startedAt(pastAge(), root.id);
    // A ledger of its own that holds only the ended lineage's rows, with
    // no alarm set: its last alarm ended, and nothing was admitted since.
    const ledger = env.MODEL_LEDGER.getByName(crypto.randomUUID());
    await runInDurableObject(ledger, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO spend (scope, key, period, spent_micros, requests) VALUES ('run', ?, 'lineage', 650, 1)",
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
    const kept = await runInDurableObject(
      ledger,
      (_instance, state) =>
        state.storage.sql.exec("SELECT 1 FROM spend").toArray().length
    );

    expect({ armedBefore, alarmed, kept }).toStrictEqual({
      armedBefore: null,
      alarmed: true,
      kept: 0,
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

    await expect(keptOf(root.id)).resolves.toBe(1);
    await builder.api.workflows.cancel(child);
  });

  it("prune an App's account in a lineage it joined once every run of the lineage ended, and keep it while any is live", async () => {
    const builder = await signedInApi(idp, "builder");
    const appX = await lineageApp(builder);
    const appY = await lineageApp(builder);
    const root = await builder.api.workflows.start(appX, "idle");
    await finished(root.id);
    // App Y's run in App X's lineage, charged to its own account: itself.
    const joined = await startChild(appY, "idle", root.id, builder.userId);
    await finished(joined);
    const waiting = await startChild(appX, "later", root.id, builder.userId);
    await sleeping(waiting, "pause");
    await spendFor(appY, builder.userId, [
      runActorOf({
        runId: joined,
        app: appY,
        workflow: "idle",
        rootRunId: root.id,
        accountRunId: joined,
      }),
    ]);
    await endedAt(longAgo(), root.id, joined);
    await startedAt(pastAge(), root.id, joined, waiting);

    await swept();
    const whileLive = await keptOf(joined);
    await builder.api.workflows.cancel(waiting);
    await finished(waiting);
    await endedAt(longAgo(), waiting);
    await swept();

    expect({ whileLive, ended: await keptOf(joined) }).toStrictEqual({
      whileLive: 1,
      ended: 0,
    });
  });

  it("keep an ended lineage's spend until it is past the oldest a lineage may grow, so a run started in it late doesn't count from nothing", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await lineageApp(builder);
    const root = await builder.api.workflows.start(app, "idle");
    await finished(root.id);
    await spendFor(app, builder.userId, [
      runActorOf({ runId: root.id, app, workflow: "idle" }),
    ]);
    // Ended a retention ago, but started within the year a lineage may
    // live: a late delivery of its mail could still start a run in it.
    await endedAt(longAgo(), root.id);
    await startedAt(Date.now() - 200 * dayMs, root.id);

    await swept();
    const young = await keptOf(root.id);
    await startedAt(pastAge(), root.id);
    await swept();

    expect({ young, old: await keptOf(root.id) }).toStrictEqual({
      young: 1,
      old: 0,
    });
  });
});

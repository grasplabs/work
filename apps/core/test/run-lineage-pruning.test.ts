import { runIdSchema, workflowResourceIdSchema } from "@grasp-os/shared/ids";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import { mockIdp } from "./idp.ts";
import {
  endedRun,
  greetingTasks,
  jsonWorkflowAppsOf,
  liveLineage,
  publishedWorkflow,
  startedBy,
} from "./json-workflow-apps.ts";
import type { Person } from "./json-workflow-apps.ts";
import { fakeProviderFor } from "./model-provider.ts";
import { outcome } from "./sign-in.ts";

// The model ledger prunes what it keeps of a run lineage (its spend) once
// every run of it ended a retention ago and it is past the oldest a
// lineage may grow, as core's own records of the runs say: here, the runs
// of independent JSON workflows (`workflow_resource_runs`). The model
// provider behind connect is the outside system (test/model-provider.ts).
// The runs, the engine, D1 and the ledger are real; a run's row never
// changes once it ended, so where a test needs runs that ended long ago,
// the ledger sweeps with the clock moved on, as time passing would.
//
// That a lineage's children are pruned with it is workflow-children's
// "have the model ledger forget a lineage's requests once every run of it
// ended long ago…". An App's account in a lineage another App's mail
// started a run in went with App workflows: an independent workflow's
// lineage holds only its own runs (run-children.ts).

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

const mistral = "mistral/mistral-large-latest";

/** Costs 650 micros from Mistral Large. */
const pricedAnswer = { text: "Hi.", inputTokens: 1000, outputTokens: 100 };

const dayMs = 24 * 60 * 60 * 1000;

/** A run of `by`'s that has ended: the root of a lineage of its own. */
const endedRoot = async (by: Person) => {
  const { id } = await publishedWorkflow(by, greetingTasks());
  const run = await startedBy(by, id);
  await endedRun(by, id, run);
  return { run, workflow: id };
};

/**
 * One model call counted in the lineage of `root`, as a run of `workflow`
 * makes one (resource-calls.ts), working in run `run` (`root` unless said).
 */
const spentIn = async (
  by: Person,
  {
    root,
    workflow,
    run = root,
  }: { root: string; workflow: string; run?: string }
): Promise<string> => {
  await fakeProviderFor([mistral], pricedAnswer);
  const workflowId = workflowResourceIdSchema.parse(workflow);
  return await outcome(
    models(env).call({
      model: mistral,
      maxTokens: 100,
      input: "Hello.",
      purpose: "workflow.step",
      trigger: { type: "system" },
      lineage: { rootRunId: root, workflowId: workflow },
      work: {
        authority: {
          subject: { type: "workflow", workflowId },
          onBehalfOf: by.userId,
          mode: "workflow",
        },
        context: {
          type: "workflowRun",
          workflowId,
          runId: runIdSchema.parse(run),
        },
      },
    })
  );
};

/** What `ledger` keeps of lineage `root`: its spend rows. */
const keptOf = async (root: string, ledger = modelLedger(env)) =>
  await runInDurableObject(
    ledger,
    (_instance, state) =>
      state.storage.sql
        .exec(
          "SELECT 1 FROM spend WHERE scope = 'run' AND key = ? AND period = 'lineage'",
          root
        )
        .toArray().length
  );

/** `run`, with the clock `days` on, as time passing would have it. */
const daysOn = async <Result>(
  days: number,
  run: () => Promise<Result>
): Promise<Result> => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + days * dayMs);
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
};

/** The ledger's alarm, with its sweep, now, `days` on. */
const sweptDaysOn = async (days: number): Promise<void> => {
  // The sweep runs on the alarm; set it, then run it. Set an hour ahead,
  // never for now: workerd would run one due now on its own, and this one
  // would then find none to run and return while that one still sweeps.
  await runInDurableObject(modelLedger(env), async (_instance, state) => {
    await state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
  });
  await daysOn(days, async () => {
    await expect(runDurableObjectAlarm(modelLedger(env))).resolves.toBeTruthy();
  });
};

describe("run lineage pruning", { timeout: 90_000 }, () => {
  it("prune a lineage once every run of it ended a retention ago and it is past the oldest a lineage may grow, and keep one core has no run of", async () => {
    const builder = await signedIn("builder");
    const old = await endedRoot(builder);
    // A lineage no run core keeps names: nothing says it ended.
    const ghost = crypto.randomUUID();
    const spent = [
      await spentIn(builder, { root: old.run, workflow: old.workflow }),
      await spentIn(builder, {
        root: ghost,
        workflow: old.workflow,
        run: old.run,
      }),
    ];
    // Ended just now: kept, in case a late delivery starts a run in it.
    await sweptDaysOn(0);
    const justEnded = await keptOf(old.run);
    // Past the ledger's 90-day retention of an ended lineage, and the
    // year a lineage may live.
    await sweptDaysOn(400);

    expect({
      spent,
      justEnded,
      old: await keptOf(old.run),
      ghost: await keptOf(ghost),
    }).toStrictEqual({
      spent: ["ok", "ok"],
      justEnded: 1,
      old: 0,
      ghost: 1,
    });
  });

  it("keep an ended lineage's spend until it is past the oldest a lineage may grow, so a run started in it late doesn't count from nothing", async () => {
    const builder = await signedIn("builder");
    const root = await endedRoot(builder);
    await spentIn(builder, { root: root.run, workflow: root.workflow });

    // Ended a retention ago, but started within the year a lineage may
    // live: a late delivery of its mail could still start a run in it.
    await sweptDaysOn(200);
    const young = await keptOf(root.run);
    await sweptDaysOn(400);

    expect({ young, old: await keptOf(root.run) }).toStrictEqual({
      young: 1,
      old: 0,
    });
  });

  it("keep a lineage while any run of it is live, however long ago it started", async () => {
    const builder = await signedIn("builder");
    const { run, workflow, end } = await liveLineage(builder);
    await spentIn(builder, { root: run, workflow });

    await sweptDaysOn(400);
    const kept = await keptOf(run);
    await end();

    expect(kept).toBe(1);
  });

  it("sweep an idle ledger holding an ended lineage once it wakes, with no admission to set its alarm", async () => {
    const builder = await signedIn("builder");
    const { run } = await endedRoot(builder);
    // A ledger of its own that holds only the ended lineage's rows, with
    // no alarm set: its last alarm ended, and nothing was admitted since.
    const ledger = env.MODEL_LEDGER.getByName(crypto.randomUUID());
    await runInDurableObject(ledger, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO spend (scope, key, period, spent_micros, requests) VALUES ('run', ?, 'lineage', 650, 1)",
        run
      );
      await state.storage.deleteAlarm();
    });
    const armedBefore = await runInDurableObject(
      ledger,
      async (_instance, state) => await state.storage.getAlarm()
    );
    // Evicted, as an idle object is: the next request wakes it anew.
    await evictDurableObject(ledger);

    const alarmed = await daysOn(
      400,
      async () => await runDurableObjectAlarm(ledger)
    );

    expect({
      armedBefore,
      alarmed,
      kept: await keptOf(run, ledger),
    }).toStrictEqual({
      armedBefore: null,
      alarmed: true,
      kept: 0,
    });
  });
});

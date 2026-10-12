import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { runActorOf } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEvent } from "@grasp-os/shared/audit";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import type { ModelCall } from "../src/models.ts";
import { runActor, startRun } from "../src/workflows/runs.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { finished, woken } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// A run lineage's model calls: a run and every run started under it count
// their model spend and provider requests together, against the lineage's
// root, for the lineage's whole life. AI Gateway is the outside system: a
// fake behind the AI binding. The runs, the engine, the dispatcher, the
// model ledger and the audit log are real. Child runs are started the way
// core starts a run under another (`startRun`'s `parent`): no App or run
// can name a parent or a root.

const idp = mockIdp();

const gateway = "grasp-os-test";
const workersAi = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** An answer that costs next to nothing. */
const cheapAnswer = { text: "Hi.", inputTokens: 10, outputTokens: 5 };

/**
 * An answer to the steps' schema that costs $0.293226 from Llama 3.3 (a
 * million tokens in at $0.293, 100 out at $2.253 a million): far more
 * than a step's request reserves, about $0.014 for Llama's default
 * 6,000-token answer, so what decides is what was spent.
 */
const dearTotal = {
  text: '{ "total": 1234 }',
  inputTokens: 1_000_000,
  outputTokens: 100,
};

/** A run's AI step, with `more` options. */
const llmStep = (more = "") => `  return await step.llm("extract", {
    description: "Read the total",
    model: "${workersAi}",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
    ${more}
  });`;

let monthsUsed = 0;

/** A month no other file counts budgets in. */
const newMonth = (): string => {
  monthsUsed += 1;
  return `${2500 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/**
 * What `run` returns, with `budgets` in the deployment's gateway config
 * and the fake gateway answering with `replies`: for the runs the
 * dispatcher runs and the calls the test makes alike.
 */
const withGateway = async <Result>(
  budgets: Record<string, unknown> | undefined,
  replies: GatewayReply[],
  run: (fake: ReturnType<typeof fakeGateway>) => Promise<Result>
): Promise<Result> => {
  const { MODEL_GATEWAY: before, MODEL_BUDGET_MONTH: month } = env;
  const fake = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  const sending = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  try {
    env.MODEL_GATEWAY = {
      gateway,
      models: [workersAi],
      ...(budgets === undefined ? {} : { budgets }),
    };
    env.MODEL_BUDGET_MONTH = newMonth();
    return await run(fake);
  } finally {
    env.MODEL_GATEWAY = before;
    env.MODEL_BUDGET_MONTH = month;
    sending.mockRestore();
  }
};

/** `count` of `item`. */
const times = <Item>(count: number, item: Item): Item[] =>
  Array.from({ length: count }, () => item);

/** Someone signed in, with their API. */
type Builder = Awaited<ReturnType<typeof signedInApi>>;

/** Where `run` stands, as `builder` sees it. */
const statusOf = async (builder: Builder, run: string): Promise<string> => {
  const seen = await builder.api.workflows.status(run);
  return seen.status;
};

/** The audit events, the model ledger's delivered too. */
const eventsNow = async (): Promise<AuditEvent[]> => {
  await runDurableObjectAlarm(modelLedger(env));
  return await allEvents();
};

/** How `run` failed, as its `workflow.run.failed` event names it; none yet. */
const failedWith = async (run: string): Promise<unknown> => {
  const events = await allEvents();
  return events.find(
    ({ action, target }) =>
      action === "workflow.run.failed" && target?.id === run
  )?.detail.error;
};

/** The model gateway's refusals of `run`'s calls, as their reasons. */
const refusalsOf = async (run: string): Promise<unknown[]> => {
  const events = await eventsNow();
  return events
    .filter(
      ({ action, actor }) =>
        action === "model.refused" &&
        actor.type === "workflow" &&
        actor.runId === run
    )
    .map(({ detail }) => [detail.reason, detail.because]);
};

/** Starts a run of `workflow` under `parent`, as core starts a child run. */
const startChild = async (
  app: string,
  workflow: string,
  parent: string,
  startedBy: string
): Promise<string> => {
  const parentRun = runIdSchema.parse(parent);
  const run = await startRun(env, {
    app: appIdSchema.parse(app),
    workflow: workflowIdSchema.parse(workflow),
    input: null,
    startedBy,
    actor: runActor({ id: parentRun, appId: app, workflowId: workflow }),
    parent: parentRun,
  });
  return run.id;
};

/**
 * A call to Llama for the workflow run `trigger`, in the context of `app`
 * for `person`: capped at 100 tokens unless `capped` is false, when it
 * reserves as much as a step's (Llama's whole 24,000-token answer).
 */
const stepCall = (
  { app, person }: { app: string; person: string },
  trigger: AuditActor,
  capped = true
): ModelCall<undefined> => {
  const appId = appIdSchema.parse(app);
  return {
    model: workersAi,
    ...(capped ? { maxTokens: 100 } : {}),
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
  };
};

/** Where the calls a test makes itself work: an App, for its builder. */
interface Work {
  app: string;
  person: string;
}

/** The outcome of one call for `trigger`, counted in `month` if given. */
const callFor = async (
  work: Work,
  trigger: AuditActor,
  month?: string
): Promise<string> => {
  const before = env.MODEL_BUDGET_MONTH;
  env.MODEL_BUDGET_MONTH = month ?? before;
  try {
    return await outcome(models(env).call(stepCall(work, trigger)));
  } finally {
    env.MODEL_BUDGET_MONTH = before;
  }
};

/** The outcomes of calls for each of `triggers`, made all at once. */
const allAtOnce = async (
  triggers: readonly AuditActor[],
  work: Work
): Promise<string[]> =>
  await Promise.all(
    triggers.map(async (trigger) => await callFor(work, trigger))
  );

/** How many of `outcomes` are `outcome`. */
const countOf = (outcomes: readonly string[], one: string): number =>
  outcomes.filter((each) => each === one).length;

describe("run lineages", { timeout: 90_000 }, () => {
  it("stop a run nested two deep once its lineage's spend reaches the run budget, after a restart too", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("reader", llmStep(), { extract: { total: 1234 } }),
      // Waits a day first, so the test can restart it mid-wait.
      ...workflowFiles(
        "later",
        `  await step.sleep("pause", { description: "Wait", duration: "1 day" });
${llmStep()}`,
        { extract: { total: 1234 } }
      ),
    });

    // $0.50 a lineage: the root's and its child's answers spend $0.586.
    const result = await withGateway(
      { run: { limit: 0.5 } },
      times(3, dearTotal),
      async (fake) => {
        const root = await builder.api.workflows.start(app, "reader");
        await finished(root.id);
        const child = await startChild(app, "reader", root.id, builder.userId);
        await finished(child);
        const grandchild = await startChild(
          app,
          "later",
          child,
          builder.userId
        );
        // Stopped as it waits, and resumed: loaded anew, from its record.
        await woken(grandchild, "pause");
        await finished(grandchild);
        const events = await eventsNow();
        return {
          sent: fake.requests.length,
          root: await statusOf(builder, root.id),
          child: await statusOf(builder, child),
          grandchild: await failedWith(grandchild),
          refused: await refusalsOf(grandchild),
          // Its model events name the lineage's root, from its record.
          roots: events
            .filter(
              ({ action, actor }) =>
                action.startsWith("model.") &&
                actor.type === "workflow" &&
                actor.runId === grandchild
            )
            .map(({ actor }) =>
              actor.type === "workflow" && actor.rootRunId === root.id
                ? "root"
                : "other"
            ),
        };
      }
    );

    expect(result).toMatchObject({
      sent: 2,
      root: "completed",
      child: "completed",
      grandchild: "model.run_limit",
      refused: [["model.run_limit", "spend"]],
      roots: ["root"],
    });
  });

  it("hold back a lineage's run beside the others while their calls under way hold its run budget", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("idle", "  return null;"),
      ...workflowFiles("reader", llmStep("retries: { limit: 0 },"), {
        extract: { total: 1234 },
      }),
    });
    const work = { app, person: builder.userId };
    const root = await builder.api.workflows.start(app, "idle");
    await finished(root.id);
    // Calls under way of the root and of a run beside the next, until
    // released: each reserves some $0.014 (Llama's default 6,000-token
    // answer), as a step does.
    const release = Promise.withResolvers<boolean>();
    const held = { ...cheapAnswer, pause: { at: 1, until: release.promise } };
    const branches = [
      runActorOf({ runId: root.id, app, workflow: "idle" }),
      runActorOf({
        runId: `run-${crypto.randomUUID()}`,
        app,
        workflow: "reader",
        rootRunId: root.id,
      }),
    ];

    // $0.035 a lineage fits two such calls at once, not three.
    const result = await withGateway(
      { run: { limit: 0.035 } },
      [...times(2, held), dearTotal],
      async (fake) => {
        const holding = Promise.all(
          branches.map(
            async (trigger) =>
              await outcome(models(env).call(stepCall(work, trigger, false)))
          )
        );
        await vi.waitFor(() => {
          expect(fake.requests).toHaveLength(2);
        });
        const child = await startChild(app, "reader", root.id, builder.userId);
        await finished(child);
        release.resolve(true);
        return {
          held: await holding,
          sent: fake.requests.length,
          child: await failedWith(child),
          refused: await refusalsOf(child),
        };
      }
    );

    expect(result).toStrictEqual({
      held: ["ok", "ok"],
      sent: 2,
      child: "model.budget_busy",
      refused: [["model.budget_busy", "run"]],
    });
  });

  it("count a retried step's requests on top of its lineage's, so its retry can't start the count afresh", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("idle", "  return null;"),
      ...workflowFiles("reader", llmStep("retries: { limit: 2, delay: 1 },"), {
        extract: { total: 1234 },
      }),
    });
    const work = { app, person: builder.userId };
    const root = await builder.api.workflows.start(app, "idle");
    await finished(root.id);
    const rootActor = runActorOf({ runId: root.id, app, workflow: "idle" });

    const result = await withGateway(
      undefined,
      [
        ...times(97, cheapAnswer),
        // Each of the step's attempts sends one request and two retries:
        // its first fails on server errors, and is tried again.
        ...times(3, { status: 500 }),
        ...times(6, dearTotal),
      ],
      async (fake) => {
        // The root used 97 of its lineage's 100 requests.
        const before = await allAtOnce(times(97, rootActor), work);
        const child = await startChild(app, "reader", root.id, builder.userId);
        await finished(child);
        return {
          before: countOf(before, "ok"),
          sentByChild: fake.requests.length - 97,
          child: await failedWith(child),
          refused: await refusalsOf(child),
        };
      }
    );

    expect(result).toStrictEqual({
      before: 97,
      sentByChild: 3,
      child: "model.run_limit",
      refused: [["model.run_limit", "requests"]],
    });
  });

  it("admit 100 provider requests a lineage, its root's and its children's together, however many ask at once, and no more", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Lineages" });
    const work = { app, person: builder.userId };
    const root = `run-${crypto.randomUUID()}`;
    const rootActor = runActorOf({ runId: root, app, workflow: "reader" });
    const childActor = runActorOf({
      runId: `run-${crypto.randomUUID()}`,
      app,
      workflow: "reader",
      rootRunId: root,
    });
    const otherLineage = runActorOf({
      runId: `run-${crypto.randomUUID()}`,
      app,
      workflow: "reader",
    });

    const result = await withGateway(
      undefined,
      times(110, cheapAnswer),
      async (fake) => {
        const lineage = await allAtOnce(
          Array.from({ length: 101 }, (_, index) =>
            index % 2 === 0 ? rootActor : childActor
          ),
          work
        );
        return {
          ok: countOf(lineage, "ok"),
          refused: countOf(lineage, "model.run_limit"),
          // In the next month too: a lineage is counted for its whole life.
          again: await callFor(work, childActor, newMonth()),
          other: await callFor(work, otherLineage),
          sent: fake.requests.length,
        };
      }
    );

    expect(result).toStrictEqual({
      ok: 100,
      refused: 1,
      again: "model.run_limit",
      other: "ok",
      sent: 101,
    });
  });

  it("count a run's calls against its own lineage, whatever lineage or root its input names", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles("reader", llmStep(), { extract: { total: 1234 } })
    );
    const work = { app, person: builder.userId };
    const victim = runIdSchema.parse(`run-${crypto.randomUUID()}`);
    const victimActor = runActorOf({ runId: victim, app, workflow: "reader" });

    const result = await withGateway(
      undefined,
      [...times(100, cheapAnswer), dearTotal],
      async () => {
        // The victim's lineage used all of its requests.
        const used = await allAtOnce(times(100, victimActor), work);
        const forged = await builder.api.workflows.start(app, "reader", {
          rootRunId: victim,
          root: victim,
          parent: victim,
          lineage: victim,
          parentRunId: victim,
        });
        await finished(forged.id);
        const events = await eventsNow();
        return {
          used: countOf(used, "ok"),
          forged: await statusOf(builder, forged.id),
          // Its own root: no `rootRunId` at all.
          ownActor: runActorOf({ runId: forged.id, app, workflow: "reader" }),
          actor: events.find(
            ({ action, actor }) =>
              action === "model.call" &&
              actor.type === "workflow" &&
              actor.runId === forged.id
          )?.actor,
          victimAgain: await callFor(work, victimActor),
        };
      }
    );

    expect(result).toMatchObject({
      used: 100,
      forged: "completed",
      victimAgain: "model.run_limit",
    });
    expect(result.actor).toStrictEqual(result.ownActor);
  });
});

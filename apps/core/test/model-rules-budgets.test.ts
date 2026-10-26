import { runActorOf } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import { mockIdp } from "./idp.ts";
import {
  appWith,
  llm,
  workersAi,
  anthropic,
  gateway,
  cheapAnswer,
  withDeploymentRules,
  modelActions,
  eventsOf,
  callsInAnApp,
} from "./model-rules.ts";
import { finished } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { bindModel, workflowFiles } from "./workflow-apps.ts";

// The model budgets a workflow's AI steps meet, and how a step the budget
// turned away waits on the model ledger. AI Gateway is the outside
// system: a fake behind the AI binding. Everything else is real, down to
// the audit log and the run. The other rules' tests are in
// model-rules.test.ts.

const idp = mockIdp();

// The tests that run a workflow release an App of their own, which runs
// its workflow tests to activate it, have permissions granted where they
// need them, and wait for up to two runs to end, one after another
// (`finished` gives each up to 20 seconds). On a loaded CI runner that
// takes longer than Vitest's default five seconds: the sensitive-collection
// test, with two workflows to activate and two runs, timed out there.
// Sixty seconds fits two runs' waits with room for the setup, as
// app-roles.test.ts and knowledge-access.test.ts give theirs.
describe("model rules", { timeout: 60_000 }, () => {
  const hello = callsInAnApp(idp);

  it("retry a workflow's AI step the budget turned away while other calls hold it, no sooner than 15 seconds on, however tight its retries", async () => {
    const builder = await signedInApi(idp, "builder");
    // One retry, a millisecond on: the step's own delay.
    const app = await appWith(
      builder,
      workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    binding: "reader",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
    retries: { limit: 1, delay: 1 },
  });`,
        { extract: { total: 1234 } }
      )
    );
    const release = Promise.withResolvers<boolean>();
    const actor = (runId: string) =>
      runActorOf({ runId, app, workflow: "reader" });

    // Sonnet 4.5 reserves some $0.56: another of the workflow's runs holds
    // its $1 budget while it answers, until released.
    const { result } = await withDeploymentRules(
      {
        gateway,
        models: [workersAi, anthropic],
        budgets: { workflow: { limit: 1 } },
      },
      [
        { ...cheapAnswer, pause: { at: 1, until: release.promise } },
        { text: '{ "total": 1234 }', inputTokens: 10, outputTokens: 5 },
      ],
      async () => {
        await bindModel(app, "reader", anthropic);
        const holding = outcome(
          models(env).call(
            hello(anthropic, {
              purpose: "workflow.step",
              trigger: actor(`run-${crypto.randomUUID()}`),
            })
          )
        );
        await vi.waitFor(async () => {
          const read = await modelLedger(env).spendOf(
            env.MODEL_BUDGET_MONTH ?? "",
            ["workflow"],
            10
          );
          expect(read.workflow?.[0]?.reservedMicros).toBeGreaterThan(0);
        });
        const run = await builder.api.workflows.start(app, "reader");
        await vi.waitFor(
          async () => {
            const events = await eventsOf(actor(run.id));
            expect(events.map(({ action }) => action)).toContain(
              "model.refused"
            );
          },
          { timeout: 10_000, interval: 200 }
        );
        // Still held a while after the refusal: a retry a millisecond on
        // would be turned away again, and spend the step's last.
        await scheduler.wait(3000);
        release.resolve(true);
        await finished(run.id);
        return {
          held: await holding,
          run: await builder.api.workflows.status(run.id),
          events: await eventsOf(actor(run.id)),
        };
      }
    );

    const timeOf = (action: string) =>
      Date.parse(
        result.events.find((event) => event.action === action)?.at ?? ""
      );
    expect({
      held: result.held,
      run: result.run,
      refused: result.events
        .filter(({ action }) => action === "model.refused")
        .map(({ detail }) => detail),
      waited: timeOf("model.call") - timeOf("model.refused") >= 15_000,
    }).toMatchObject({
      held: "ok",
      run: { status: "completed", output: { total: 1234 } },
      // A shared budget: a fixed wait, nothing of the other run's timing.
      refused: [
        {
          reason: "model.budget_busy",
          because: "workflow",
          retryAfterSeconds: 60,
        },
      ],
      waited: true,
    });
  });

  it("ask the ledger for a busy step at most every 15 seconds, however short its attempts' timeout, and fail a step with no retry left at once", async () => {
    const builder = await signedInApi(idp, "builder");
    // Attempts that time out after four seconds, retried a millisecond on:
    // the five a step may have span past the 15 seconds; and a step with
    // no retry at all.
    const app = await appWith(builder, {
      ...workflowFiles(
        "reader",
        llm("timeout: 4000, retries: { limit: 4, delay: 1 },"),
        {
          extract: { total: 1234 },
        }
      ),
      ...workflowFiles("once", llm("retries: { limit: 0 },"), {
        extract: { total: 1234 },
      }),
    });
    const release = Promise.withResolvers<boolean>();
    const actor = (runId: string, workflow = "reader") =>
      runActorOf({ runId, app, workflow });

    // Another run of each workflow holds its $1 budget while it answers,
    // until released.
    const { result } = await withDeploymentRules(
      {
        gateway,
        models: [workersAi, anthropic],
        budgets: { workflow: { limit: 1 } },
      },
      [
        { ...cheapAnswer, pause: { at: 1, until: release.promise } },
        { ...cheapAnswer, pause: { at: 1, until: release.promise } },
        { text: '{ "total": 1234 }', inputTokens: 10, outputTokens: 5 },
      ],
      async () => {
        await bindModel(app, "reader", anthropic);
        const holding = Promise.all(
          ["reader", "once"].map(
            async (workflow) =>
              await outcome(
                models(env).call(
                  hello(anthropic, {
                    purpose: "workflow.step",
                    trigger: actor(`run-${crypto.randomUUID()}`, workflow),
                  })
                )
              )
          )
        );
        await vi.waitFor(async () => {
          const read = await modelLedger(env).spendOf(
            env.MODEL_BUDGET_MONTH ?? "",
            ["workflow"],
            10
          );
          expect(
            read.workflow?.filter(({ reservedMicros }) => reservedMicros > 0)
          ).toHaveLength(2);
        });
        const once = await builder.api.workflows.start(app, "once");
        const startedOnce = Date.now();
        await finished(once.id);
        const onceTook = Date.now() - startedOnce;
        const run = await builder.api.workflows.start(app, "reader");
        // Eight seconds of attempts four seconds apart, all while held.
        await scheduler.wait(8000);
        const whileHeld = await eventsOf(actor(run.id));
        release.resolve(true);
        await finished(run.id);
        return {
          held: await holding,
          onceTook,
          once: await builder.api.workflows.status(once.id),
          whileHeld,
          run: await builder.api.workflows.status(run.id),
          events: await eventsOf(actor(run.id)),
        };
      }
    );

    expect({
      held: result.held,
      once: result.once,
      onceQuick: result.onceTook < 10_000,
      whileHeld: modelActions(result.whileHeld),
      run: result.run,
      after: modelActions(result.events),
    }).toMatchObject({
      held: ["ok", "ok"],
      // No retry left: it fails at once, with the reason.
      once: {
        status: "failed",
        error: {
          message:
            "Model calls still under way hold what's left of this workflow's model budget for the month. Try again once they finish.",
        },
      },
      onceQuick: true,
      // Asked once in eight seconds of attempts; the next answered by the
      // host from that refusal.
      whileHeld: ["model.refused"],
      run: { status: "completed", output: { total: 1234 } },
      after: ["model.refused", "model.call"],
    });
  });

  it("give an AI step's next attempt the answer its timed-out attempt was still waiting for, asking and paying once", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    binding: "reader",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
    timeout: 1000,
    retries: { limit: 3, delay: 1 },
  });`,
        { extract: { total: 1234 } }
      )
    );
    const release = Promise.withResolvers<boolean>();

    // The gateway answers the first attempt only after its second.
    const { result } = await withDeploymentRules(
      { gateway, models: [workersAi, anthropic] },
      [
        {
          text: '{ "total": 1234 }',
          inputTokens: 10,
          outputTokens: 5,
          pause: { at: 1, until: release.promise },
        },
        { text: '{ "total": 9999 }', inputTokens: 10, outputTokens: 5 },
      ],
      async () => {
        await bindModel(app, "reader", anthropic);
        const run = await builder.api.workflows.start(app, "reader");
        await scheduler.wait(2500);
        release.resolve(true);
        await finished(run.id);
        return {
          run: await builder.api.workflows.status(run.id),
          events: await eventsOf(
            runActorOf({ runId: run.id, app, workflow: "reader" })
          ),
        };
      }
    );

    expect({
      run: result.run,
      models: modelActions(result.events),
    }).toMatchObject({
      run: { status: "completed", output: { total: 1234 } },
      models: ["model.call"],
    });
  });

  it("ask the ledger again once 15 seconds passed since a busy step's refusal, on its last attempt too, when the budget freed meanwhile", async () => {
    const builder = await signedInApi(idp, "builder");
    // Attempts at about 0, 6 and 12 seconds: the third, the last, runs
    // past the 15 seconds since the first was turned away.
    const app = await appWith(
      builder,
      workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    binding: "reader",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
    timeout: 6000,
    retries: { limit: 2, delay: 1 },
  });`,
        { extract: { total: 1234 } }
      )
    );
    const release = Promise.withResolvers<boolean>();
    const actor = (runId: string) =>
      runActorOf({ runId, app, workflow: "reader" });

    const { result } = await withDeploymentRules(
      {
        gateway,
        models: [workersAi, anthropic],
        budgets: { workflow: { limit: 1 } },
      },
      [
        { ...cheapAnswer, pause: { at: 1, until: release.promise } },
        { text: '{ "total": 1234 }', inputTokens: 10, outputTokens: 5 },
      ],
      async () => {
        await bindModel(app, "reader", anthropic);
        const holding = outcome(
          models(env).call(
            hello(anthropic, {
              purpose: "workflow.step",
              trigger: actor(`run-${crypto.randomUUID()}`),
            })
          )
        );
        await vi.waitFor(async () => {
          const read = await modelLedger(env).spendOf(
            env.MODEL_BUDGET_MONTH ?? "",
            ["workflow"],
            10
          );
          expect(read.workflow?.[0]?.reservedMicros).toBeGreaterThan(0);
        });
        const run = await builder.api.workflows.start(app, "reader");
        await vi.waitFor(
          async () => {
            const events = await eventsOf(actor(run.id));
            expect(modelActions(events)).toContain("model.refused");
          },
          { timeout: 10_000, interval: 100 }
        );
        // Free half a second after the refusal, well within the 15 seconds.
        await scheduler.wait(500);
        release.resolve(true);
        await finished(run.id);
        return {
          held: await holding,
          run: await builder.api.workflows.status(run.id),
          events: await eventsOf(actor(run.id)),
        };
      }
    );

    expect({
      held: result.held,
      run: result.run,
      actions: modelActions(result.events),
    }).toMatchObject({
      held: "ok",
      run: { status: "completed", output: { total: 1234 } },
      actions: ["model.refused", "model.call"],
    });
  });

  it("stop a workflow's AI steps with a readable error once its budget is used up, and alert admins", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    binding: "reader",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
  });`,
        { extract: { total: 1234 } }
      )
    );

    // One answer of a million tokens in costs $3: well past the budget.
    const { result: runs } = await withDeploymentRules(
      {
        gateway,
        models: [workersAi, anthropic],
        budgets: { workflow: { limit: 1 } },
      },
      [{ text: '{ "total": 1234 }', inputTokens: 1_000_000, outputTokens: 10 }],
      async () => {
        await bindModel(app, "reader", anthropic);
        const paid = await builder.api.workflows.start(app, "reader");
        await finished(paid.id);
        const stopped = await builder.api.workflows.start(app, "reader");
        await finished(stopped.id);
        return { paid: paid.id, stopped: stopped.id };
      }
    );

    await expect(
      Promise.all([
        builder.api.workflows.status(runs.paid),
        builder.api.workflows.status(runs.stopped),
      ])
    ).resolves.toMatchObject([
      { status: "completed", output: { total: 1234 } },
      {
        status: "failed",
        error: {
          message:
            "This workflow's model budget for the month is used up, so it can make no more model calls until the budget resets at the start of next month (UTC). Ask your admin to have Grasp raise the budget.",
        },
      },
    ]);
    const alerts = await eventsOf(
      runActorOf({ runId: runs.paid, app, workflow: "reader" })
    );
    expect(
      alerts.filter(({ action }) => action.startsWith("model.budget."))
    ).toMatchObject([
      {
        action: "model.budget.alert",
        detail: { scope: "workflow", app, workflow: "reader", limit: 1 },
      },
      {
        action: "model.budget.exhausted",
        detail: { scope: "workflow", app, workflow: "reader", limit: 1 },
      },
    ]);
  });
});

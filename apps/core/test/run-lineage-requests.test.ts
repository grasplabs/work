import { runIdSchema, workflowResourceIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { models } from "../src/models.ts";
import type { ModelCall } from "../src/models.ts";
import { mockIdp } from "./idp.ts";
import { jsonWorkflowAppsOf, liveLineage } from "./json-workflow-apps.ts";
import { fakeProviderFor } from "./model-provider.ts";
import { outcome } from "./sign-in.ts";

// A run lineage's provider requests: 100 a lineage, all its runs'
// together, however many ask at once, for the lineage's whole life. The
// calls are made as an independent JSON workflow's run makes them
// (resource-calls.ts): its lineage, from its run's row, by its root. The
// model provider behind connect is the outside system
// (test/model-provider.ts); the gateway and the model ledger are real.
//
// Covered elsewhere for JSON runs, and so not tried here:
// - A run's lineage taken from core's own row, never from its input: a
//   JSON start's input is held to its workflow's schema, and
//   workflow-resource-runs' "admits each attempt against the run's own
//   lineage…" shows the root a run's attempts count on.
// A step retried after the provider refused it went with App workflows:
// a JSON workflow's model task is tried once (resource-calls.ts,
// `askAgain`).

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

/** The model the calls go through: Mistral Large, which doesn't think. */
const lineageModel = "mistral/mistral-large-latest";

/** An answer that costs next to nothing. */
const cheapAnswer = { text: "Hi.", inputTokens: 10, outputTokens: 5 };

let monthsUsed = 0;

/** A month no other file counts spend in. */
const newMonth = (): string => {
  monthsUsed += 1;
  return `${2600 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/** A run, the root of its lineage, of workflow `workflow`, for `person`. */
interface Lineage {
  root: string;
  workflow: string;
  person: string;
}

/** A call of a run of `lineage`, capped at 100 tokens, as its host makes it. */
const callOf = ({ root, workflow, person }: Lineage): ModelCall<undefined> => {
  const workflowId = workflowResourceIdSchema.parse(workflow);
  return {
    model: lineageModel,
    maxTokens: 100,
    input: "Hello.",
    purpose: "workflow.step",
    trigger: { type: "system" },
    lineage: { rootRunId: root, workflowId: workflow },
    work: {
      authority: {
        subject: { type: "workflow", workflowId },
        onBehalfOf: person,
        mode: "workflow",
      },
      context: {
        type: "workflowRun",
        workflowId,
        runId: runIdSchema.parse(root),
      },
    },
  };
};

/** The outcome of one call of `lineage`, counted in `month` if given. */
const callFor = async (lineage: Lineage, month?: string): Promise<string> => {
  const before = env.MODEL_BUDGET_MONTH;
  env.MODEL_BUDGET_MONTH = month ?? before;
  try {
    return await outcome(models(env).call(callOf(lineage)));
  } finally {
    env.MODEL_BUDGET_MONTH = before;
  }
};

/**
 * The outcome of a call of `lineage`, asked again each time it is told it
 * is queued for a share of the model requests in flight, as its host
 * would: more at once than the shares and the queue's places hold are
 * told so at once (model-admission.ts), and nothing else of them counts.
 */
const callUntilServed = async (lineage: Lineage): Promise<string> => {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- asked again once told it is queued
    const told = await callFor(lineage);
    if (told !== "model.queued") {
      return told;
    }
    // oxlint-disable-next-line no-await-in-loop -- a moment before asking again
    await scheduler.wait(50);
  }
};

/** How many of `outcomes` are `one`. */
const countOf = (outcomes: readonly string[], one: string): number =>
  outcomes.filter((each) => each === one).length;

describe("run lineages", () => {
  // A person's share admits four requests in flight a round, each round
  // five seconds on, and the provider behind connect answers in its own
  // time: 101 at once take about a minute, so this test has three.
  it(
    "admit 100 provider requests a lineage, however many of its runs ask at once, and no more, in any month",
    { timeout: 180_000 },
    async () => {
      const builder = await signedIn("builder");
      const runs = [await liveLineage(builder), await liveLineage(builder)];
      const [lineage, otherLineage] = runs.map(({ run, workflow }) => ({
        root: run,
        workflow,
        person: builder.userId,
      }));
      if (lineage === undefined || otherLineage === undefined) {
        throw new Error("No runs");
      }
      const fake = await fakeProviderFor(
        [lineageModel],
        ...Array.from({ length: 110 }, () => cheapAnswer)
      );
      const { MODEL_BUDGET_MONTH: month } = env;
      env.MODEL_BUDGET_MONTH = newMonth();
      try {
        const asked = await Promise.all(
          Array.from(
            { length: 101 },
            async () => await callUntilServed(lineage)
          )
        );

        expect({
          ok: countOf(asked, "ok"),
          refused: countOf(asked, "model.run_limit"),
          // In the next month too: a lineage is counted for its whole life.
          again: await callFor(lineage, newMonth()),
          other: await callFor(otherLineage),
          sent: fake.requests.length,
        }).toStrictEqual({
          ok: 100,
          refused: 1,
          again: "model.run_limit",
          other: "ok",
          sent: 101,
        });
      } finally {
        env.MODEL_BUDGET_MONTH = month;
        await Promise.all(
          runs.map(async ({ end }) => {
            await end();
          })
        );
      }
    }
  );
});

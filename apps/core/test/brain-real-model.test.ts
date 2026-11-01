import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { parseModelRef } from "../src/model-catalog.ts";
import { contextWindowOf } from "../src/models.ts";
import {
  brainArms,
  charged,
  runBrainBaseline,
  setUpBrainCompany,
  tasksOf,
} from "./brain-harness.ts";
import type {
  BrainModelSetup,
  BrainProvider,
  BrainReport,
} from "./brain-harness.ts";
import { realProvider, realProviderTakes } from "./brain-real-provider.ts";
import type { ModelExchange } from "./brain-real-provider.ts";
import { summarizeArm } from "./brain-scoring.ts";
import { stubReader } from "./brain-stub-model.ts";
import { brainFamilies, brainTasks } from "./fixtures/brain-tasks.ts";
import { mockIdp } from "./idp.ts";
import { testBinding } from "./test-env.ts";

// The Brain baseline against a real model (GRA-676), on request only:
// vite.brain-model.config.ts says how to run it. The harness runs as in CI;
// only the provider differs (brain-real-provider.ts): the provider's own
// API, with the real key the run was given (`BRAIN_MODEL_KEY`), the model
// the run names (`BRAIN_MODEL`) the one the organization chose, and the
// run's budget as the ledger's deployment limit.
// The estimate first runs the dev split against the stub, priced as that
// model, to project what a run costs. Each reports on the run's output as
// JSON lines.

const settings = z
  .object({
    mode: z.enum(["estimate", "run"]),
    model: z.string().min(1),
    split: z.enum(["dev", "validation", "sealed"]),
    repeats: z.int().min(1),
    budgetUsd: z.number().positive().optional(),
    outputAllowance: z.int().min(0),
    build: z.object({
      sha: z.string().regex(/^[0-9a-f]{40}$/u),
      dirty: z.boolean(),
      profile: z.string(),
    }),
  })
  .parse(testBinding("BRAIN_MODEL"));

/** The provider's real key, for a run only: never committed. */
const realKey = z
  .string()
  .min(1)
  .optional()
  .parse(testBinding("BRAIN_MODEL_KEY"));

/**
 * The model under test, the one the organization chooses, so its chats
 * ask it. One the gateway doesn't offer (not in its catalog, so without a
 * price) is refused before anything is sent.
 */
if (parseModelRef(settings.model) === undefined) {
  throw new Error(
    `The gateway doesn't offer ${settings.model}: name one of its catalog as <provider>/<model>`
  );
}
const testedModel = settings.model;

/** Micros in a US dollar. */
const micros = 1_000_000;

/** Headroom on the estimate: a real agent may take more steps than the stub. */
const estimateMargin = 1.5;

const idp = mockIdp();

/** The run's quality, latency and cost by arm and task family. */
const byFamily = (report: BrainReport) => {
  const familyOf = new Map(brainTasks.map(({ id, family }) => [id, family]));
  return report.arms.map(({ arm }) => ({
    arm,
    families: brainFamilies.flatMap((family) => {
      const scores = report.scores.filter(
        (score) => score.arm === arm && familyOf.get(score.taskId) === family
      );
      return scores.length === 0
        ? []
        : [summarizeArm(arm, scores)].map((summary) => ({
            family,
            ...summary,
          }));
    }),
  }));
};

describe("the Brain baseline against a real model", () => {
  it.runIf(settings.mode === "estimate")(
    "estimates a run's cost from the dev split, spending nothing",
    async () => {
      const setup: BrainModelSetup = { model: testedModel, rules: {} };
      const requests: { arm: string; inputTokens: number }[] = [];
      // The stub, each answer counted as long as a real one may be.
      const respond: BrainProvider = (turn) => {
        const answer = stubReader(turn);
        return (sent) => {
          const reply = answer(sent);
          if (!("text" in reply)) {
            return reply;
          }
          const current = turn();
          requests.push({
            arm: current.phase === "question" ? (current.arm ?? "") : "prior",
            inputTokens: reply.inputTokens,
          });
          return {
            ...reply,
            outputTokens: Math.max(
              reply.outputTokens,
              settings.outputAllowance
            ),
          };
        };
      };
      const report = await runBrainBaseline(await setUpBrainCompany(idp), {
        split: "dev",
        repeats: 1,
        respond,
        providerName: "brain-stub-reader, priced as the model under test",
        modelSetup: setup,
        build: settings.build,
      });
      const spent = await charged();
      const trials = report.scores.length;
      const perTrial = spent / trials;
      // Trials as a run of each split would take them, at the repeats a run
      // with these settings (`BRAIN_MODEL_REPEATS`) is given.
      const planned = {
        validation:
          tasksOf("validation").length * brainArms.length * settings.repeats,
        sealed:
          tasksOf("sealed", { openSealed: true }).length *
          brainArms.length *
          settings.repeats,
      };
      const projectedUsd = (count: number) =>
        (count * perTrial * estimateMargin) / micros;
      const window = contextWindowOf(
        testedModel.slice(testedModel.indexOf("/") + 1)
      );
      const estimate = {
        identity: report.identity,
        model: testedModel,
        outputAllowance: settings.outputAllowance,
        margin: estimateMargin,
        dev: {
          trials,
          spentUsd: spent / micros,
          perTrialUsd: perTrial / micros,
          byArm: report.arms.map(({ arm, trials: count, cost }) => ({
            arm,
            perTrialUsd: cost.totalMicros / count / micros,
          })),
        },
        contextWindow: window,
        largestRequest: Object.fromEntries(
          [...new Set(requests.map(({ arm }) => arm))].map((arm) => [
            arm,
            Math.max(
              ...requests
                .filter((request) => request.arm === arm)
                .map(({ inputTokens }) => inputTokens)
            ),
          ])
        ),
        planned,
        projectedUsd: {
          validation: projectedUsd(planned.validation),
          sealed: projectedUsd(planned.sealed),
          both: projectedUsd(planned.validation + planned.sealed),
        },
      };
      console.info(`BRAIN_MODEL_ESTIMATE ${JSON.stringify(estimate)}`);
      expect(report.identity.model.id).toBe(testedModel);
    }
  );

  it.runIf(settings.mode === "run")(
    `runs the ${settings.split} split against ${testedModel}, within its budget`,
    async () => {
      const { budgetUsd } = settings;
      if (budgetUsd === undefined) {
        throw new Error("A real-model run needs a budget");
      }
      // The identity pins a commit: changes on top of it aren't in it.
      if (settings.build.dirty) {
        throw new Error(
          "Commit your changes first: a run pins the commit it ran"
        );
      }
      if (realKey === undefined) {
        throw new Error(
          `A real-model run needs BRAIN_MODEL_KEY, the key of ${testedModel}'s provider`
        );
      }
      if (!realProviderTakes(testedModel)) {
        throw new Error(
          `A real run reaches Anthropic, Mistral and OpenRouter models, not ${testedModel}`
        );
      }
      const exchanges: ModelExchange[] = [];
      const setup: BrainModelSetup = {
        model: testedModel,
        // The run's budget, as the ledger enforces it on every request.
        rules: { budgets: { deployment: { limit: budgetUsd, alertAt: 99 } } },
      };
      const report = await runBrainBaseline(await setUpBrainCompany(idp), {
        split: settings.split,
        openSealed: settings.split === "sealed",
        repeats: settings.repeats,
        respond: realProvider(realKey, (exchange) => {
          exchanges.push(exchange);
        }),
        providerName: testedModel.slice(0, testedModel.indexOf("/")),
        modelSetup: setup,
        build: settings.build,
      });
      const spent = await charged();
      console.info(
        `BRAIN_MODEL_REPORT ${JSON.stringify({
          ...report,
          budgetUsd,
          spentUsd: spent / micros,
          families: byFamily(report),
        })}`
      );
      console.info(`BRAIN_MODEL_EXCHANGES ${JSON.stringify(exchanges)}`);
      expect({
        model: report.identity.model.id,
        sha: report.identity.build?.sha,
        withinBudget: spent <= budgetUsd * micros,
      }).toStrictEqual({
        model: testedModel,
        sha: settings.build.sha,
        withinBudget: true,
      });
    }
  );
});

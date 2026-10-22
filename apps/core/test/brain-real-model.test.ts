import { jsonVar } from "@grasp-os/shared/config";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { contextWindowOf, gatewaySettings } from "../src/models.ts";
import { gatewayProvider } from "./brain-gateway-provider.ts";
import type { AiFetch, ModelExchange } from "./brain-gateway-provider.ts";
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
import { summarizeArm } from "./brain-scoring.ts";
import { stubReader } from "./brain-stub-model.ts";
import { brainFamilies, brainTasks } from "./fixtures/brain-tasks.ts";
import { mockIdp } from "./idp.ts";
import { testBinding } from "./test-env.ts";

// The Brain baseline against a real model (GRA-676), on request only:
// vite.brain-model.config.ts says how to run it. The harness runs as in CI;
// only the provider differs (brain-gateway-provider.ts), with the model a
// deployment's gateway asks by default for chat, and the run's budget as
// the ledger's deployment limit. The estimate first runs the dev split
// against the stub, priced as that model, to project what a run costs.
// Each reports on the run's output as JSON lines.

const settings = z
  .object({
    mode: z.enum(["estimate", "run"]),
    split: z.enum(["validation", "sealed"]),
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

// Taken before the harness points any object at its stand-in gateway:
// objects share the env, so `env.AI` is the stand-in from then on.
const realAi: unknown = Reflect.get(env, "AI");

const isAiFetch = (value: unknown): value is AiFetch =>
  typeof value === "object" &&
  value !== null &&
  "fetch" in value &&
  typeof value.fetch === "function";

/** The deployment's gateway config, as core reads it. */
const deploymentGateway = z
  .object({ gateway: z.string(), models: z.array(z.string()).min(1) })
  .loose()
  .parse(jsonVar(Reflect.get(env, "MODEL_GATEWAY")));

/** The model a deployment's chats ask by default: the first allowed. */
const [defaultModel = ""] = gatewaySettings(env).models;

/** Micros in a US dollar. */
const micros = 1_000_000;

/** Headroom on the estimate: a real agent may take more steps than the stub. */
const estimateMargin = 1.5;

/** The repeats of a sealed run, as GRA-676 asks. */
const sealedRepeats = 3;

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
      const setup: BrainModelSetup = {
        model: defaultModel,
        config: deploymentGateway,
      };
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
        providerName: "brain-stub-reader, priced as the default model",
        modelSetup: setup,
        build: settings.build,
      });
      const spent = await charged();
      const trials = report.scores.length;
      const perTrial = spent / trials;
      const planned = {
        validation:
          tasksOf("validation").length * brainArms.length * settings.repeats,
        sealed:
          tasksOf("sealed", { openSealed: true }).length *
          brainArms.length *
          sealedRepeats,
      };
      const projectedUsd = (count: number) =>
        (count * perTrial * estimateMargin) / micros;
      const window = contextWindowOf(
        defaultModel.slice(defaultModel.indexOf("/") + 1)
      );
      const estimate = {
        identity: report.identity,
        model: defaultModel,
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
      expect(report.identity.model.id).toBe(defaultModel);
    }
  );

  it.runIf(settings.mode === "run")(
    `runs the ${settings.split} split against the default model, within its budget`,
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
      if (!isAiFetch(realAi)) {
        throw new TypeError(
          "The AI binding isn't remote: run with BRAIN_MODEL_MODE=run"
        );
      }
      const exchanges: ModelExchange[] = [];
      const setup: BrainModelSetup = {
        model: defaultModel,
        config: {
          ...deploymentGateway,
          // The run's budget, as the ledger enforces it on every request.
          budgets: { deployment: { limit: budgetUsd, alertAt: 99 } },
        },
      };
      const report = await runBrainBaseline(await setUpBrainCompany(idp), {
        split: settings.split,
        openSealed: settings.split === "sealed",
        repeats: settings.repeats,
        respond: gatewayProvider(realAi, (exchange) => {
          exchanges.push(exchange);
        }),
        providerName: `ai-gateway/${deploymentGateway.gateway}`,
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
        model: defaultModel,
        sha: settings.build.sha,
        withinBudget: true,
      });
    }
  );
});

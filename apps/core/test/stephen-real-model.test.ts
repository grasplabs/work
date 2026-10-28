import { jsonVar } from "@grasp-os/shared/config";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { gatewaySettings } from "../src/models.ts";
import { gatewayProvider } from "./brain-gateway-provider.ts";
import type { AiFetch, ModelExchange } from "./brain-gateway-provider.ts";
import { charged } from "./brain-harness.ts";
import { stephenCases } from "./fixtures/stephen-cases.ts";
import { mockIdp } from "./idp.ts";
import { runStephenEval, setUpStephenCompany } from "./stephen-harness.ts";
import type { StephenProvider } from "./stephen-stub.ts";
import { testBinding } from "./test-env.ts";

// Stephen's eval against a real model (GRA-720), on request only:
// vite.stephen-model.config.ts says how to run it. The harness runs as in
// CI; only the provider differs, the Brain baseline's real one
// (brain-gateway-provider.ts), with the model the run names listed first
// in its gateway, and the run's budget as the ledger's deployment limit.
// It reports on the run's output as JSON lines, then fails if a hard rule
// broke (GRA-739): run by hand (stephen-eval.yml) or weekly.

const settings = z
  .object({
    model: z.string().min(1),
    budgetUsd: z.number().positive(),
    cases: z.array(z.string()),
    build: z.object({
      sha: z.string().regex(/^[0-9a-f]{40}$/u),
      dirty: z.boolean(),
      profile: z.string(),
    }),
  })
  .parse(testBinding("STEPHEN_MODEL"));

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

/** Micros in a US dollar. */
const micros = 1_000_000;

/** What the model said to each request, by the case or judge it was for. */
type Exchange = ModelExchange & { caseId?: string; judging?: boolean };

/** The real model behind the gateway, each exchange logged by its case. */
const realModel =
  (ai: AiFetch, log: (exchange: Exchange) => void): StephenProvider =>
  (turn) =>
    gatewayProvider(ai, (exchange) => {
      const current = turn();
      log({
        ...exchange,
        ...(current.phase === "idle" ? {} : { caseId: current.item.id }),
        ...(current.phase === "judge" ? { judging: true } : {}),
      });
    })(() => ({ phase: "prior" }));

const idp = mockIdp();

describe("Stephen's eval against a real model", () => {
  it(`runs the cases against ${settings.model}, within its budget`, async () => {
    const [firstAllowed] = gatewaySettings(env).models;
    if (firstAllowed !== settings.model) {
      throw new Error(
        `The gateway doesn't offer ${settings.model}: name one of its catalog as <provider>/<model>`
      );
    }
    // The identity pins a commit: changes on top of it aren't in it.
    if (settings.build.dirty) {
      throw new Error(
        "Commit your changes first: a run pins the commit it ran"
      );
    }
    if (!isAiFetch(realAi)) {
      throw new TypeError("The AI binding isn't remote");
    }
    const unknown = settings.cases.filter(
      (id) => !stephenCases.some((item) => item.id === id)
    );
    if (unknown.length > 0) {
      throw new Error(`No such case: ${unknown.join(", ")}`);
    }
    const exchanges: Exchange[] = [];
    const report = await runStephenEval(await setUpStephenCompany(idp), {
      cases:
        settings.cases.length === 0
          ? stephenCases
          : stephenCases.filter(({ id }) => settings.cases.includes(id)),
      respond: realModel(realAi, (exchange) => {
        exchanges.push(exchange);
      }),
      providerName: `ai-gateway/${deploymentGateway.gateway}`,
      modelSetup: {
        model: settings.model,
        config: {
          ...deploymentGateway,
          // The run's budget, as the ledger enforces it on every request.
          budgets: { deployment: { limit: settings.budgetUsd, alertAt: 99 } },
        },
      },
      build: settings.build,
    });
    const spent = await charged();
    console.info(
      `STEPHEN_MODEL_REPORT ${JSON.stringify({
        ...report,
        budgetUsd: settings.budgetUsd,
        spentUsd: spent / micros,
      })}`
    );
    console.info(`STEPHEN_MODEL_EXCHANGES ${JSON.stringify(exchanges)}`);
    expect({
      model: report.identity.model,
      sha: report.identity.build?.sha,
      withinBudget: spent <= settings.budgetUsd * micros,
      broken: report.hardRules.filter(({ broken }) => broken.length > 0),
    }).toStrictEqual({
      model: settings.model,
      sha: settings.build.sha,
      withinBudget: true,
      broken: [],
    });
  });
});

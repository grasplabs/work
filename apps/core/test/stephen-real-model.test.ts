import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { parseModelRef } from "../src/model-catalog.ts";
import { charged } from "./brain-harness.ts";
import { realProvider, realProviderTakes } from "./brain-real-provider.ts";
import type { ModelExchange } from "./brain-real-provider.ts";
import { stephenCases } from "./fixtures/stephen-cases.ts";
import { mockIdp } from "./idp.ts";
import { runStephenEval, setUpStephenCompany } from "./stephen-harness.ts";
import type { StephenProvider } from "./stephen-stub.ts";
import { testBinding } from "./test-env.ts";

// Stephen's eval against a real model (GRA-720), on request only:
// vite.stephen-model.config.ts says how to run it. The harness runs as in
// CI; only the provider differs, the Brain baseline's real one
// (brain-real-provider.ts): the provider's own API, with the real key the
// run was given (`STEPHEN_MODEL_KEY`), the model the run names the one the
// organization chose, and the run's budget as the ledger's deployment
// limit, the only cap on what it spends.
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

/** The provider's real key: never committed. */
const realKey = z
  .string()
  .min(1)
  .optional()
  .parse(testBinding("STEPHEN_MODEL_KEY"));

/** Micros in a US dollar. */
const micros = 1_000_000;

/** What the model said to each request, by the case or judge it was for. */
type Exchange = ModelExchange & { caseId?: string; judging?: boolean };

/** The real model behind connect, each exchange logged by its case. */
const realModel =
  (key: string, log: (exchange: Exchange) => void): StephenProvider =>
  (turn) =>
    realProvider(key, (exchange) => {
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
    if (parseModelRef(settings.model) === undefined) {
      throw new Error(
        `The gateway doesn't offer ${settings.model}: name one of its catalog as <provider>/<model>`
      );
    }
    if (!realProviderTakes(settings.model)) {
      throw new Error(
        `A real run reaches Anthropic, Mistral and OpenRouter models, not ${settings.model}`
      );
    }
    // The identity pins a commit: changes on top of it aren't in it.
    if (settings.build.dirty) {
      throw new Error(
        "Commit your changes first: a run pins the commit it ran"
      );
    }
    if (realKey === undefined) {
      throw new Error(
        `A real-model run needs STEPHEN_MODEL_KEY, the key of ${settings.model}'s provider`
      );
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
      respond: realModel(realKey, (exchange) => {
        exchanges.push(exchange);
      }),
      providerName: settings.model.slice(0, settings.model.indexOf("/")),
      modelSetup: {
        model: settings.model,
        // The run's budget, as the ledger enforces it on every request.
        rules: {
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

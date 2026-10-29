import { jsonVar } from "@grasp-os/shared/config";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { gatewaySettings, modelForRole } from "../src/models.ts";
import { charged, setUpBrainCompany } from "./brain-harness.ts";
import { runBrainRecallComparison } from "./brain-recall-harness.ts";
import { mockIdp } from "./idp.ts";
import { testBinding } from "./test-env.ts";

// Experiment E02 (GRA-304) against a real reranking model, on request
// only: vite.brain-recall-model.config.ts says how to run it. The harness
// runs as in CI (brain-recall-e02.test.ts); only the model behind the
// gateway differs, the model the run names playing the quick role a rerank
// asks, and the run's budget is the ledger's deployment limit. It reports
// on the run's output as one JSON line: the numbers a decision to make
// reranking a default rests on.

const settings = z
  .object({
    model: z.string().min(1),
    repeats: z.int().min(1),
    budgetUsd: z.number().positive(),
    build: z.object({
      sha: z.string().regex(/^[0-9a-f]{40}$/u),
      dirty: z.boolean(),
      profile: z.string(),
    }),
  })
  .parse(testBinding("BRAIN_RECALL_MODEL"));

/** Micros in a US dollar. */
const micros = 1_000_000;

const idp = mockIdp();

describe("experiment E02 against a real reranking model", () => {
  it(`compares hybrid recall, reranked by ${settings.model}, with full-text search, within its budget`, async () => {
    // The identity pins a commit: changes on top of it aren't in it.
    if (settings.build.dirty) {
      throw new Error(
        "Commit your changes first: a run pins the commit it ran"
      );
    }
    const reranker = modelForRole(gatewaySettings(env), "quick", {
      sensitive: true,
    });
    if (reranker !== settings.model) {
      throw new Error(
        `The gateway reranks with ${String(reranker)}, not ${settings.model}: name one of its catalog as <provider>/<model>`
      );
    }
    const before = Reflect.get(env, "MODEL_GATEWAY");
    // The run's budget, as the ledger enforces it on every request.
    Reflect.set(env, "MODEL_GATEWAY", {
      ...z.record(z.string(), z.unknown()).parse(jsonVar(before)),
      budgets: { deployment: { limit: settings.budgetUsd, alertAt: 99 } },
    });
    try {
      const report = await runBrainRecallComparison(
        await setUpBrainCompany(idp),
        {
          repeats: settings.repeats,
          measured: true,
          identity: {
            model: settings.model,
            profile: settings.build.profile,
            build: settings.build,
          },
        }
      );
      const spent = await charged();
      console.info(
        `BRAIN_RECALL_REPORT ${JSON.stringify({
          ...report,
          budgetUsd: settings.budgetUsd,
          spentUsd: spent / micros,
        })}`
      );
      expect({
        model: report.identity.model,
        withinBudget: spent <= settings.budgetUsd * micros,
      }).toStrictEqual({ model: settings.model, withinBudget: true });
    } finally {
      Reflect.set(env, "MODEL_GATEWAY", before);
    }
  });
});

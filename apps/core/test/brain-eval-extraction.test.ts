import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

// oxlint-disable-next-line no-restricted-imports -- extraction's own prompts, as above
import {
  checkInstructions,
  proposeInstructions,
} from "../../../packages/brain-next/src/extraction.ts";
// oxlint-disable-next-line no-restricted-imports -- the version of extraction's own prompts, as its memories record them
import { promptVersionOf } from "../../../packages/brain-next/src/extractors.ts";
import { usageRecorded } from "../src/model-usage.ts";
import { runExtractionEval } from "./brain-extraction-eval.ts";
import { realProvider } from "./brain-real-provider.ts";
import { extractionMarkers } from "./fixtures/brain-extraction-eval/scoring.ts";
import {
  extractionEvalSet,
  setProblems,
} from "./fixtures/brain-extraction-eval/set.ts";
import { spentMicros } from "./model-usage.ts";
import { realProviderTakes, unreachableModel } from "./real-providers.ts";
import { testBinding } from "./test-env.ts";

// The evaluation of extraction against a real model (GRA-1992), on
// request only: scripts/brain-eval-extraction.ts says how to run it and
// scores what it prints (vite.brain-eval-extraction.config.ts). It runs
// the set through core's real extraction (brain-extraction-eval.ts): the
// read and the check, with their real prompts, through core's model
// gateway and connect to the provider's own API with the real key
// (brain-real-provider.ts), the model under test as the organization's.
// It prints one JSON line per unit.
//
// The budget: no unit starts once what core recorded as spent reaches
// it; a unit is two calls over one short document. The provider key's own
// spend limit is the hard cap.

const settings = z
  .object({ model: z.string().min(1), budgetUsd: z.number().positive() })
  .parse(testBinding("BRAIN_EVAL_EXTRACTION_RUN"));

/** The provider's real key: never committed. */
const realKey = z.string().min(1).parse(testBinding("BRAIN_MODEL_KEY"));

/** Micros in a US dollar. */
const micros = 1_000_000;

/** The months a run's spend is in. */
const monthOf = (at: Date): string => at.toISOString().slice(0, 7);

/** What core recorded as spent in `months`, in micros, once its records are written. */
const spentIn = async (months: ReadonlySet<string>): Promise<number> => {
  await usageRecorded();
  let total = 0;
  for (const month of months) {
    // oxlint-disable-next-line no-await-in-loop -- a month or two
    total += await spentMicros(month);
  }
  return total;
};

const print = (marker: string, value: unknown): void => {
  console.log(`${marker} ${JSON.stringify(value)}`);
};

describe("the evaluation of extraction against a real model", () => {
  it(`draws every document of the set twice and every probe once, with ${settings.model}, within its budget`, async () => {
    if (!realProviderTakes(settings.model)) {
      throw new Error(unreachableModel(settings.model));
    }
    expect(setProblems(extractionEvalSet)).toStrictEqual([]);
    const months = new Set([monthOf(new Date())]);
    const before = await spentIn(months);
    print(extractionMarkers.run, {
      set: extractionEvalSet.version,
      model: settings.model,
      prompts: {
        read: await promptVersionOf(proposeInstructions),
        check: await promptVersionOf(checkInstructions),
      },
    });
    const spentUsd = async () => {
      months.add(monthOf(new Date()));
      return ((await spentIn(months)) - before) / micros;
    };

    let failure: Error | null = null;
    let stopped = false;
    try {
      ({ stopped } = await runExtractionEval({
        set: extractionEvalSet,
        model: settings.model,
        respond: async (requests) =>
          await realProvider(realKey, () => {
            // Each exchange's tokens come back through the gateway's answer.
          })(() => ({ phase: "prior" }))(requests),
        mayStart: async () => (await spentUsd()) < settings.budgetUsd,
        onDraw: (result) => {
          print(extractionMarkers.draw, result);
        },
        onProbe: (result) => {
          print(extractionMarkers.probe, result);
        },
      }));
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    print(extractionMarkers.end, {
      stopped,
      failed: failure !== null,
      spentUsd: await spentUsd(),
    });
    if (failure !== null) {
      throw failure;
    }
  });
});

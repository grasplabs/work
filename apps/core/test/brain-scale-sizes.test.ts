import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { brainArms, setUpBrainCompany } from "./brain-harness.ts";
import { runBrainScale } from "./brain-scale.ts";
import { brainDistractorSeed } from "./fixtures/brain-distractors.ts";
import {
  brainSuiteDigests,
  brainSuiteVersion,
} from "./fixtures/brain-tasks.ts";
import { mockIdp } from "./idp.ts";
import { testBinding } from "./test-env.ts";

// The Brain baseline at a larger scale size (GRA-678), on request only:
// vite.brain-scale.config.ts says how to run it and passes the size. It
// reports what it measured on the run's output, as one JSON line, and
// checks what must hold at every size: the gate, and the identity.

const scale = z
  .object({
    chunks: z.int().min(1),
    repeats: z.int().min(1),
    seed: z.int().optional(),
  })
  .parse(testBinding("BRAIN_SCALE"));

const idp = mockIdp();

describe("the Brain baseline at a larger scale size", () => {
  it(`runs at ${scale.chunks} distractor chunks and holds its gate`, async () => {
    const seed = scale.seed ?? brainDistractorSeed;
    const report = await runBrainScale(await setUpBrainCompany(idp), {
      chunks: scale.chunks,
      distractorSeed: seed,
      split: "dev",
      repeats: scale.repeats,
      // Every row of a large corpus, twice a trial, would take hours.
      knowledgeState: "counts",
    });
    const { baseline: _baseline, ...measured } = report;
    // The opt-in run's report is its output.
    console.info(`BRAIN_SCALE_REPORT ${JSON.stringify(measured)}`);
    expect({
      suite: report.identity.suite.digest,
      distractors: [
        report.identity.distractors.seed,
        report.identity.distractors.chunks,
      ],
      gate: report.gate.passed,
      leaks: report.distractorLeaks,
      arms: report.arms.map(({ arm }) => arm),
    }).toStrictEqual({
      suite: brainSuiteDigests[brainSuiteVersion],
      distractors: [seed, scale.chunks],
      gate: true,
      leaks: [],
      arms: brainArms,
    });
  });
});

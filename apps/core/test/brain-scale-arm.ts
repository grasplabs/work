/**
 * One arm of the Brain baseline at scale as CI runs it (GRA-678): the
 * smallest scale size, the frozen company grown by its generated
 * distractor chunks, over a cold and a warm repeat, with the gate reading
 * Knowledge by its row counts. Each arm runs in a file of its own
 * (brain-scale.test.ts, brain-scale-agent.test.ts,
 * brain-scale-full-context.test.ts), on a company of its own: one run of
 * all three took over three minutes in CI, a shard's floor (GRA-1094).
 * The arms' trials don't share state: each checks that its own trial left
 * every stored row as it found it, so each arm holds its gate alone as it
 * did beside the others.
 */
import { expect, it } from "vite-plus/test";

import { setUpBrainCompany } from "./brain-harness.ts";
import type { BrainArm, BrainControl } from "./brain-harness.ts";
import { runBrainScale } from "./brain-scale.ts";
import type { BrainScaleReport } from "./brain-scale.ts";
import { brainPersonas } from "./fixtures/brain-corpus.ts";
import type { BrainPersona } from "./fixtures/brain-corpus.ts";
import {
  brainDistractorSeed,
  brainScaleSizes,
  distractorReaders,
} from "./fixtures/brain-distractors.ts";
import { brainTasks } from "./fixtures/brain-tasks.ts";
import type { Idp } from "./idp.ts";

/** Distractor chunks: the smallest scale size. */
export const [scaleChunks] = brainScaleSizes;

const repeats = 2;

const devTasks = brainTasks.filter(({ split }) => split === "dev").length;

/** The arms whose sources come from a search: the agent's and full text's. */
const searchingArms: ReadonlySet<BrainArm> = new Set(["agent", "fullText"]);

/** Each test of a file may wait for its run: the whole run, at worst. */
export const scaleTimeout = 300_000;

/**
 * The scale run of `arm`, started by the first test that asks for it and
 * shared by the others; `controls` run on `controlTasks` after its trials.
 */
export const brainScaleRun = (
  idp: Idp,
  arm: BrainArm,
  {
    controls = [],
    controlTasks = [],
  }: {
    controls?: readonly BrainControl[];
    controlTasks?: readonly string[];
  } = {}
): (() => Promise<BrainScaleReport>) => {
  let report: Promise<BrainScaleReport> | undefined;
  return async () => {
    report ??= (async () =>
      await runBrainScale(await setUpBrainCompany(idp), {
        chunks: scaleChunks,
        distractorSeed: brainDistractorSeed,
        split: "dev",
        repeats,
        arms: [arm],
        knowledgeState: "counts",
        controls,
        controlTasks,
      }))();
    return await report;
  };
};

/**
 * What every arm must show at scale: its gate, and what it records. Full
 * context is truncated past its budget on every trial (`truncatedShare`
 * 1), the searching arms never.
 */
export const scaleArmTests = (
  arm: BrainArm,
  run: () => Promise<BrainScaleReport>,
  truncatedShare: number
): void => {
  it("holds the security gate under restrictive permission sets: nothing a person may not read reaches a model, and no stored row changes", async () => {
    const { gate, distractorLeaks, distractorsReached, arms } = await run();
    // What each person's model was sent of their own teams' collections:
    // the agents are granted them, and a searching arm reads them as the
    // person. Full context reads collections in order until its budget
    // runs out, which may be before any team's: it's left out.
    const ownTeams = (persona: BrainPersona) =>
      (distractorsReached[arm]?.[persona] ?? []).some(
        (collection) =>
          distractorReaders(collection).includes(persona) &&
          collection.startsWith("team")
      );
    const searching = searchingArms.has(arm);
    expect({
      gate,
      distractorLeaks,
      ownTeams: searching ? brainPersonas.map(ownTeams) : [],
      failures: arms.map(({ failures }) => failures),
      trials: arms.map(({ trials }) => trials),
    }).toStrictEqual({
      gate: { passed: true, violations: [] },
      distractorLeaks: [],
      ownTeams: searching ? brainPersonas.map(() => true) : [],
      failures: [0],
      trials: [repeats * devTasks],
    });
  });

  it("records its recall, completion and latency percentiles, and how often its context was truncated", async () => {
    const { arms } = await run();
    expect(
      arms.map(({ arm: each, evidenceRecall, latencyMs, ...rest }) => ({
        arm: each,
        recall: evidenceRecall !== null && evidenceRecall >= 0,
        ordered:
          latencyMs.p50 !== null &&
          latencyMs.p95 !== null &&
          latencyMs.p99 !== null &&
          latencyMs.p50 <= latencyMs.p95 &&
          latencyMs.p95 <= latencyMs.p99,
        truncatedShare: rest.truncatedShare,
      }))
    ).toStrictEqual([{ arm, recall: true, ordered: true, truncatedShare }]);
  });
};

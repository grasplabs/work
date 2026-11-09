/**
 * One arm of the Brain baseline at scale as CI runs it (GRA-678): the
 * smallest scale size, the frozen company grown by its generated
 * distractor chunks, over a cold and a warm repeat, with the gate reading
 * Knowledge by its row counts. Each arm runs in files of its own, on a
 * company of its own: one run of all three took over three minutes in CI,
 * a shard's floor (GRA-1094), and one arm alone up to a minute and a half.
 * So each arm's tasks run in parts, the baseline's
 * (brain-baseline-parts.ts): full text's and the agent's in halves
 * (brain-scale.test.ts and brain-scale-2.test.ts, brain-scale-agent.test.ts
 * and brain-scale-agent-2.test.ts), full context's, whose every question
 * reads every document, in quarters (brain-scale-full-context.test.ts and
 * brain-scale-full-context-2.test.ts to -4). The trials don't share state:
 * each checks that its own trial left every stored row as it found it, so
 * each part holds its gate alone as it did beside the others.
 */
import { expect, it } from "vite-plus/test";

import { brainBaselineParts } from "./brain-baseline-parts.ts";
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
import type { Idp } from "./idp.ts";

/** Distractor chunks: the smallest scale size. */
export const [scaleChunks] = brainScaleSizes;

const repeats = 2;

const [first, second, third, fourth] = brainBaselineParts;

/** The dev split in halves, two of the baseline's parts each. */
export const scaleHalves: readonly (readonly string[])[] = [
  [...first, ...second],
  [...third, ...fourth],
];

/** The dev split in quarters: the baseline's parts. */
export const scaleQuarters: readonly (readonly string[])[] = brainBaselineParts;

/** The arms whose sources come from a search: the agent's and full text's. */
const searchingArms: ReadonlySet<BrainArm> = new Set(["agent", "fullText"]);

/** Each test of a file may wait for its run: the whole run, at worst. */
export const scaleTimeout = 300_000;

/**
 * The scale run of `arm` on `tasks`, started by the first test that asks
 * for it and shared by the others; `controls` run on `controlTasks` after
 * its trials.
 */
export const brainScaleRun = (
  idp: Idp,
  arm: BrainArm,
  tasks: readonly string[],
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
        tasks,
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
 * What every arm must show at scale on `tasks`, from `run`: its gate, and
 * what it records. Full context is truncated past its budget on every
 * trial (`truncatedShare` 1), the searching arms never.
 */
export const scaleArmTests = (
  arm: BrainArm,
  tasks: readonly string[],
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
      trials: [repeats * tasks.length],
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

/**
 * A file's part of `arm`'s scale run: `part` (counted from 1) of `parts`,
 * on a company of its own, held to what every arm must show.
 */
export const scaleArmPart = (
  idp: Idp,
  arm: BrainArm,
  parts: readonly (readonly string[])[],
  part: number,
  truncatedShare: number
): void => {
  const tasks = parts.at(part - 1);
  if (tasks === undefined) {
    throw new RangeError(`The scale run has no part ${part}`);
  }
  scaleArmTests(arm, tasks, brainScaleRun(idp, arm, tasks), truncatedShare);
};

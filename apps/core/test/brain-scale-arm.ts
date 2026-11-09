/**
 * One arm of the Brain baseline at scale as CI runs it (GRA-678): the
 * smallest scale size, the frozen company grown by its generated
 * distractor chunks, over a cold and a warm repeat, with the gate reading
 * Knowledge by its row counts. Each arm runs in files of its own, on a
 * company of its own: one run of all three took over three minutes in CI,
 * a shard's floor (GRA-1094), and one arm alone up to a minute and a half.
 * So each arm's tasks run in parts, the baseline's
 * (brain-baseline-parts.ts), a file each named for its arm and part
 * (`scaleArmPart`): full text's and the agent's in halves
 * (brain-scale-full-text-1-of-2.test.ts and -2-of-2,
 * brain-scale-agent-1-of-2.test.ts and -2-of-2), full context's, whose
 * every question reads every document, in quarters
 * (brain-scale-full-context-1-of-4.test.ts to -4-of-4). The trials don't
 * share state: each checks that its own trial left every stored row as it
 * found it, so each part holds its gate alone as it did beside the others.
 */
import { describe, expect, it } from "vite-plus/test";

import { filePart, partOf } from "../../../scripts/test-file-parts.ts";
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
import { mockIdp } from "./idp.ts";
import type { Idp } from "./idp.ts";

/** Distractor chunks: the smallest scale size. */
export const [scaleChunks] = brainScaleSizes;

const repeats = 2;

/** Each arm by the words a file's name has for it. */
const armsByName: Readonly<Record<string, BrainArm>> = {
  "full-text": "fullText",
  agent: "agent",
  "full-context": "fullContext",
};

/** A file's part of an arm's scale run, which its name says. */
export interface ScaleArmPart {
  arm: BrainArm;
  part: number;
  parts: number;
  tasks: readonly string[];
}

/**
 * The part of an arm's scale run the file `file` (a path or URL) runs,
 * from its own name (scripts/test-file-parts.ts):
 * `brain-scale-<full-text|agent|full-context>-<part>-of-<parts>.test.ts`.
 * Its tasks are that part of the baseline's
 * parts (brain-baseline-parts.ts), whole parts in order: of four, a half
 * is two. Throws on a name of no arm, or a part that would hold no task.
 * brain-baseline.test.ts reads every such file's name and checks that
 * together they run each arm on the whole split, each task once.
 */
export const scaleArmPart = (file: string): ScaleArmPart => {
  const { run, part, parts } = filePart(file);
  const arm = armsByName[run.replace(/^brain-scale-/u, "")];
  if (arm === undefined || !run.startsWith("brain-scale-")) {
    throw new Error(
      `${run} names no arm: brain-scale-<${Object.keys(armsByName).join("|")}>-<part>-of-<parts>.test.ts`
    );
  }
  const tasks = partOf(brainBaselineParts, { part, parts }).flat();
  return { arm, part, parts, tasks };
};

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
 * How often an arm's context is truncated at the scale size: full
 * context's on every trial, every person reading more than its budget
 * holds; the searching arms' never.
 */
export const truncatedShareOf = (arm: BrainArm): number =>
  searchingArms.has(arm) ? 0 : 1;

/**
 * The part of an arm's scale run the file `file` (its `import.meta.url`)
 * names (`scaleArmPart`), on a company of its own, held to what every arm
 * must show.
 */
export const scaleArmPartFile = (file: string): void => {
  const { arm, part, parts, tasks } = scaleArmPart(file);
  const idp = mockIdp();
  describe(
    `the Brain baseline at scale: ${arm}, part ${part} of ${parts}`,
    { timeout: scaleTimeout },
    () => {
      scaleArmTests(
        arm,
        tasks,
        brainScaleRun(idp, arm, tasks),
        truncatedShareOf(arm)
      );
    }
  );
};

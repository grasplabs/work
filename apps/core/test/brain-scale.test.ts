import { describe, expect, it } from "vite-plus/test";

import { brainArms, setUpBrainCompany } from "./brain-harness.ts";
import {
  distractorDigest,
  distractorLeaksIn,
  runBrainScale,
} from "./brain-scale.ts";
import type { BrainScaleReport } from "./brain-scale.ts";
import { normalized } from "./brain-scoring.ts";
import { brainPersonas } from "./fixtures/brain-corpus.ts";
import type { BrainPersona } from "./fixtures/brain-corpus.ts";
import {
  brainDistractorDigests,
  brainDistractorSeed,
  brainDistractorVersion,
  brainScaleSizes,
  distractorCanary,
  distractorDocuments,
  distractorNeedles,
  distractorReaders,
  distractorSectionsPerDocument,
} from "./fixtures/brain-distractors.ts";
import {
  brainSuiteDigests,
  brainSuiteVersion,
  brainTasks,
} from "./fixtures/brain-tasks.ts";
import { mockIdp } from "./idp.ts";

// The Brain baseline at scale (GRA-678) as CI runs it: the smallest scale
// size, the frozen company grown by 1,000 generated distractor chunks, the
// dev split's three arms over a cold and a warm repeat. Its gate reads
// Knowledge as the larger sizes do, by each table's row count (every row,
// twice a trial, would take hours there), and a control shows that this
// still catches a change to Knowledge; core, R2 and the Workspace object
// are read row by row at every size. The larger sizes
// run on request only (brain-scale-sizes.test.ts, vite.brain-scale.config.ts):
// they take far longer than a CI run should.

const idp = mockIdp();

const [chunks] = brainScaleSizes;

const repeats = 2;

const devTasks = brainTasks.filter(({ split }) => split === "dev").length;

/** The arms whose sources come from a search: the agent's and full text's. */
const searchingArms = ["agent", "fullText"] as const;

let report: Promise<BrainScaleReport> | undefined;

const run = async (): Promise<BrainScaleReport> => {
  report ??= (async () =>
    await runBrainScale(await setUpBrainCompany(idp), {
      chunks,
      distractorSeed: brainDistractorSeed,
      split: "dev",
      repeats,
      knowledgeState: "counts",
      controls: ["changesKnowledge"],
      controlTasks: ["dev-fleet-size"],
    }))();
  return await report;
};

describe("the Brain baseline at scale", { timeout: 300_000 }, () => {
  it("generates the same distractors from the same seed and size, and others from another seed", async () => {
    const pinned = `${brainDistractorVersion}/${brainDistractorSeed}/${chunks}`;
    expect({
      again: await distractorDigest({ seed: brainDistractorSeed, chunks }),
      other:
        (await distractorDigest({ seed: brainDistractorSeed + 1, chunks })) ===
        brainDistractorDigests[pinned],
    }).toStrictEqual({ again: brainDistractorDigests[pinned], other: false });
  });

  it("generates exactly the chunks asked for, none holding a task's evidence or anything that must not reach a model", () => {
    const documents = [
      ...distractorDocuments({ seed: brainDistractorSeed, chunks }),
    ];
    const headings = documents.flatMap(({ text }) =>
      text.split("\n").filter((line) => line.startsWith("## "))
    );
    const holding = documents.filter(({ text }) =>
      distractorNeedles.some((needle) => normalized(text).includes(needle))
    );
    expect({
      chunks: documents.reduce((sum, { sections }) => sum + sections, 0),
      headings: headings.length,
      perDocument: Math.max(...documents.map(({ sections }) => sections)),
      holding: holding.map(({ path }) => path),
    }).toStrictEqual({
      chunks,
      headings: chunks,
      perDocument: distractorSectionsPerDocument,
      holding: [],
    });
  });

  it("pins the distractors' version, seed, size and digest next to the unchanged suite's", async () => {
    const { identity } = await run();
    expect({
      suite: [identity.suite.version, identity.suite.digest],
      distractors: identity.distractors,
      knowledgeState: identity.knowledgeState,
    }).toStrictEqual({
      suite: [brainSuiteVersion, brainSuiteDigests[brainSuiteVersion]],
      distractors: {
        version: brainDistractorVersion,
        seed: brainDistractorSeed,
        chunks,
        digest:
          brainDistractorDigests[
            `${brainDistractorVersion}/${brainDistractorSeed}/${chunks}`
          ],
      },
      knowledgeState: "counts",
    });
  });

  it("holds the security gate under restrictive permission sets: nothing a person may not read reaches a model, and no stored row changes", async () => {
    const { gate, distractorLeaks, distractorsReached, arms } = await run();
    // What each person's model was sent of their own teams' collections:
    // the agents are granted them, and the arms read them as the person.
    // Each searching arm on its own, so one that reads them can't hide one
    // that doesn't. Full context reads collections in order until its
    // budget runs out, which may be before any team's: it's left out.
    const ownTeams = (arm: string, persona: BrainPersona) =>
      (distractorsReached[arm]?.[persona] ?? []).some(
        (collection) =>
          distractorReaders(collection).includes(persona) &&
          collection.startsWith("team")
      );
    expect({
      gate,
      distractorLeaks,
      ownTeams: searchingArms.map((arm) =>
        brainPersonas.map((persona) => ownTeams(arm, persona))
      ),
      failures: arms.map(({ failures }) => failures),
      trials: arms.map(({ trials }) => trials),
    }).toStrictEqual({
      gate: { passed: true, violations: [] },
      distractorLeaks: [],
      ownTeams: searchingArms.map(() => brainPersonas.map(() => true)),
      failures: brainArms.map(() => 0),
      trials: brainArms.map(() => repeats * devTasks),
    });
  });

  it("would see a change to Knowledge by its row counts alone", async () => {
    const { baseline } = await run();
    expect(
      baseline.controlGate.violations.map(
        ({ arm, taskId, stateChanged, leaks }) => ({
          arm,
          taskId,
          stateChanged,
          leaked: leaks.length > 0,
        })
      )
    ).toStrictEqual([
      {
        arm: "changesKnowledge",
        taskId: "dev-fleet-size",
        stateChanged: true,
        leaked: false,
      },
    ]);
  });

  it("would see a distractor of a team its person isn't in reach a model", () => {
    // team01 is Ana's, team02 Bram's (brain-distractors.ts).
    const input = `Sources:\nReference: ${distractorCanary("team02")}\nReference: ${distractorCanary("team01")}`;
    expect({
      ana: distractorLeaksIn(input, "ana"),
      bram: distractorLeaksIn(input, "bram"),
    }).toStrictEqual({ ana: ["team02"], bram: ["team01"] });
  });

  it("records each arm's recall, completion and latency percentiles, and truncates full context past its budget", async () => {
    const { arms } = await run();
    expect(
      arms.map(({ arm, evidenceRecall, latencyMs, truncatedShare }) => ({
        arm,
        recall: evidenceRecall !== null && evidenceRecall >= 0,
        ordered:
          latencyMs.p50 !== null &&
          latencyMs.p95 !== null &&
          latencyMs.p99 !== null &&
          latencyMs.p50 <= latencyMs.p95 &&
          latencyMs.p95 <= latencyMs.p99,
        truncatedShare,
      }))
    ).toStrictEqual([
      { arm: "agent", recall: true, ordered: true, truncatedShare: 0 },
      // Every person reads more than the budget holds at this size already.
      { arm: "fullContext", recall: true, ordered: true, truncatedShare: 1 },
      { arm: "fullText", recall: true, ordered: true, truncatedShare: 0 },
    ]);
  });

  it("records the index build, each window's incremental update and what Knowledge stores", async () => {
    const { build, updates, stored } = await run();
    expect({
      build: build.corpusMs > 0 && build.distractorsMs > 0,
      documents: build.documents,
      updates: updates.map(({ window, ms }) => [window, ms > 0]),
      // The distractors and the frozen corpus, every chunk indexed.
      indexed: stored.chunks > chunks,
      bytes: stored.bytes > 0,
    }).toStrictEqual({
      build: true,
      documents: Math.ceil(chunks / distractorSectionsPerDocument),
      updates: [
        ["t1", true],
        ["t2", true],
      ],
      indexed: true,
      bytes: true,
    });
  });
});

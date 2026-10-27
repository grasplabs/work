import { describe, expect, it } from "vite-plus/test";

import {
  brainScaleRun,
  scaleArmTests,
  scaleChunks as chunks,
  scaleTimeout,
} from "./brain-scale-arm.ts";
import { distractorDigest, distractorLeaksIn } from "./brain-scale.ts";
import { normalized } from "./brain-scoring.ts";
import {
  brainDistractorDigests,
  brainDistractorSeed,
  brainDistractorVersion,
  distractorCanary,
  distractorDocuments,
  distractorNeedles,
  distractorSectionsPerDocument,
} from "./fixtures/brain-distractors.ts";
import {
  brainSuiteDigests,
  brainSuiteVersion,
} from "./fixtures/brain-tasks.ts";
import { mockIdp } from "./idp.ts";

// The Brain baseline at scale (GRA-678) as CI runs it: the smallest scale
// size, the frozen company grown by 1,000 generated distractor chunks, the
// dev split's three arms over a cold and a warm repeat, one arm per file
// (brain-scale-arm.ts says why): full text's here, with the distractors'
// generator, the run's identity and build, and the control; the agent's in
// brain-scale-agent.test.ts, full context's in
// brain-scale-full-context.test.ts. Its gate reads Brain as the larger
// sizes do, by each table's row count (every row, twice a trial, would take
// hours there), and a control shows that this still catches a change to
// Brain; core, R2 and the Workspace object are read row by row at
// every size. The larger sizes run on request only
// (brain-scale-sizes.test.ts, vite.brain-scale.config.ts): they take far
// longer than a CI run should.

const idp = mockIdp();

// The control runs after the arm's trials, as it ran after all three.
const run = brainScaleRun(idp, "fullText", {
  controls: ["changesKnowledge"],
  controlTasks: ["dev-fleet-size"],
});

describe("the Brain baseline at scale", { timeout: scaleTimeout }, () => {
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
      brainState: identity.brainState,
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
      brainState: "counts",
    });
  });

  describe("full text", () => {
    scaleArmTests("fullText", run, 0);
  });

  it("would see a change to Brain by its row counts alone", async () => {
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

  it("records the index build, each window's incremental update and what Brain stores", async () => {
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

import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { setUpBrainCompany } from "./brain-harness.ts";
import {
  brainRecallArms,
  runBrainRecallComparison,
} from "./brain-recall-harness.ts";
import type { BrainRecallReport } from "./brain-recall-harness.ts";
import {
  brainRecallCases,
  brainRecallCasesVersion,
} from "./fixtures/brain-recall-cases.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import type { SentRequest } from "./model-provider.ts";

// Experiment E02 (GRA-304) as CI runs it: every case, its three policies
// each asked with both its inputs over two repeats, through the real Knowledge API, recall, permissions, model
// gateway and ledger, with only the reranking model stubbed: it orders the
// pieces by how many of the question's words each holds. It proves the
// harness measures what it reports, that its gate holds and that no kept
// recall outlives a write; whether reranking is worth adopting needs a
// real model's run (brain-recall-real-model.test.ts), which costs money.

const idp = mockIdp();

const repeats = 2;

const rerankInputSchema = z.object({
  question: z.string(),
  pieces: z.array(z.object({ id: z.string(), text: z.string() })),
});

/** The rerank's input, wherever the provider's request carries it. */
const rerankInputOf = (
  value: unknown
): z.infer<typeof rerankInputSchema> | undefined => {
  if (typeof value === "string") {
    if (!value.startsWith('{"question"')) {
      return undefined;
    }
    const parsed = rerankInputSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const each of Object.values(value)) {
      const found = rerankInputOf(each);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
};

const wordPattern = /\p{L}{3,}|\p{N}+/gu;

const wordsOf = (text: string): Set<string> =>
  new Set(text.toLowerCase().match(wordPattern));

/** The stub reranker: the pieces sharing most of the question's words first. */
const lexicalRanking = (requests: readonly SentRequest[]) => {
  const input = rerankInputOf(requests.at(-1)?.body);
  if (input === undefined) {
    throw new Error("Only reranks reach this provider");
  }
  const asked = wordsOf(input.question);
  const overlap = (text: string) =>
    [...wordsOf(text)].filter((word) => asked.has(word)).length;
  const ranking = input.pieces
    .map(({ id, text }, index) => ({ id, index, overlap: overlap(text) }))
    .toSorted((a, b) => b.overlap - a.overlap || a.index - b.index)
    .map(({ id }) => id);
  return {
    text: JSON.stringify({ ranking }),
    inputTokens: 300,
    outputTokens: 30,
  };
};

/** How long the file's one run may take, as one test of the file's. */
const runTimeoutMs = 60_000;

let report: BrainRecallReport | undefined;

/** The file's one run, read by each of its tests. */
const run = (): BrainRecallReport => {
  if (report === undefined) {
    throw new Error("The run didn't finish");
  }
  return report;
};

const armOf = (result: BrainRecallReport, arm: string) => {
  const summary = result.arms.find((each) => each.arm === arm);
  if (summary === undefined) {
    throw new Error(`No arm ${arm} in the report`);
  }
  return summary;
};

const expecting = brainRecallCases.filter(({ marker }) => marker !== undefined);

describe("experiment E02, hybrid recall against full-text search", () => {
  // Run once before the tests, so a run that fails or times out fails the
  // file once, not each test after a wait of its own, and no test ends
  // while the run goes on: once a test ended, its IdP stopped answering,
  // and the run's next sign-in went to Microsoft itself. The IdP answers
  // the run as `mockIdp` has it answer each test. Storage lasts the whole file. An
  // update is asked for once (`lagLimitMs: 0`): workerd writes the index
  // with the document, so an arm that misses it misses it for good, and
  // asking again for seconds measured nothing.
  beforeAll(async () => {
    const answering = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(idp.fetch);
    try {
      const company = await setUpBrainCompany(idp);
      await answeringProvider(lexicalRanking);
      report = await runBrainRecallComparison(company, {
        repeats,
        measured: false,
        lagLimitMs: 0,
        identity: {
          model: "stub: lexical overlap",
          profile: "workerd (Vitest pool), stub reranker",
        },
      });
    } finally {
      answering.mockRestore();
    }
  }, runTimeoutMs);

  it("pins what its numbers depend on and asks every case under every arm, cold and warm", () => {
    const result = run();
    const t0 = brainRecallCases.filter(({ window }) => window === "t0").length;
    const t1 = brainRecallCases.length - t0;

    expect({
      experiment: result.identity.experiment,
      casesVersion: result.identity.casesVersion,
      policies: result.identity.policies,
      recalls: result.arms.map(({ arm, recalls }) => [arm, recalls]),
    }).toStrictEqual({
      experiment: "E02",
      casesVersion: brainRecallCasesVersion,
      policies: {
        fullText: "knowledge.search",
        hybrid: "hybrid@1",
        hybridRerank: "hybrid@1+rerank@1",
      },
      recalls: brainRecallArms.map((arm) => [arm, (t0 * repeats + t1) * 2]),
    });
  });

  it("never hands a reader what they may not read, nor an outdated version, under any arm", () => {
    const result = run();

    expect(result.arms.map(({ arm, leaking }) => [arm, leaking])).toStrictEqual(
      brainRecallArms.map((arm) => [arm, 0])
    );
  });

  it("keeps exact identifiers on a route of their own: hybrid recall ranks each first, however it is asked", () => {
    const result = run();
    const exact = result.scores.filter(
      ({ arm, kind, phase }) =>
        arm.startsWith("hybrid:") && kind === "exact" && phase === "cold"
    );

    expect({
      some: exact.length > 0,
      ranks: new Set(exact.map(({ rank }) => rank)),
    }).toStrictEqual({ some: true, ranks: new Set([1]) });
  });

  it("answers a reader asking again from what it kept, as it ranked it, without paying again", () => {
    const result = run();
    const warmCost = (arm: string) =>
      result.scores
        .filter((score) => score.arm === arm && score.phase === "warm")
        .reduce((total, { costMicros }) => total + costMicros, 0);
    const coldCost = (arm: string) =>
      result.scores
        .filter((score) => score.arm === arm && score.phase === "cold")
        .reduce((total, { costMicros }) => total + costMicros, 0);

    const recalled = brainRecallArms.filter((arm) => arm.startsWith("hybrid"));

    expect(
      recalled.map((arm) => ({
        arm,
        unstable: armOf(result, arm).unstable,
        paidCold: coldCost(arm) > 0,
        warmCost: warmCost(arm),
      }))
    ).toStrictEqual(
      recalled.map((arm) => ({
        arm,
        unstable: 0,
        paidCold: arm.startsWith("hybridRerank:"),
        warmCost: 0,
      }))
    );
  });

  it("finds an update as soon as it is saved, kept recalls or not, wherever it found the case before", () => {
    const result = run();
    const updated = brainRecallCases.filter(({ window }) => window === "t1");
    // Found on the first ask after the write: nothing kept outlived it.
    const caughtUp = { caughtUp: updated.length, never: 0, worstMs: 0 };

    expect({
      measured: result.lags.length,
      byArm: result.lagByArm,
    }).toStrictEqual({
      measured: updated.length * brainRecallArms.length,
      byArm: {
        "fullText:keywords": caughtUp,
        // Full-text search finds nothing for a whole question, updated or not.
        "fullText:question": {
          caughtUp: 0,
          never: updated.length,
          worstMs: null,
        },
        "hybrid:keywords": caughtUp,
        "hybrid:question": caughtUp,
        "hybridRerank:keywords": caughtUp,
        "hybridRerank:question": caughtUp,
      },
    });
  });

  it("compares each candidate with full-text search, paired by case, and adopts nothing a stub measured", () => {
    const result = run();

    const candidates = brainRecallArms.filter((arm) =>
      arm.startsWith("hybrid")
    );

    expect({
      comparisons: result.comparisons.map(({ candidate, baseline, cases }) => ({
        candidate,
        baseline,
        cases,
      })),
      adoptions: result.adoptions.map(({ arm, decision }) => [arm, decision]),
      cited: result.arms.map(({ arm, citationSupport }) => [
        arm,
        citationSupport,
      ]),
    }).toStrictEqual({
      comparisons: candidates.map((candidate) => ({
        candidate,
        baseline: `fullText:${candidate.split(":")[1]}`,
        cases: expecting.length,
      })),
      adoptions: candidates.map((arm) => [arm, "needs-real-model"]),
      // Every result that quotes its evidence cites the document it is in;
      // full-text search asked a whole question found none to cite.
      cited: brainRecallArms.map((arm) => [
        arm,
        arm === "fullText:question" ? null : 1,
      ]),
    });
  });
});

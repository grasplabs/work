import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { isReadCall, runExtractionEval } from "./brain-extraction-eval.ts";
import { proposalOf } from "./fixtures/brain-extraction-eval/plan.ts";
import { scoreExtraction } from "./fixtures/brain-extraction-eval/scoring.ts";
import type {
  DrawResult,
  ProbeResult,
} from "./fixtures/brain-extraction-eval/scoring.ts";
import {
  extractionEvalSet,
  setProblems,
} from "./fixtures/brain-extraction-eval/set.ts";
import { testModel } from "./model-provider.ts";
import type { ProviderReply, SentRequest } from "./model-provider.ts";

// The evaluation of extraction (GRA-1992) run whole through core, with a
// careful model of the test's own in place of a real one: its read call
// proposes exactly the labelled facts of the text it is shown, and its
// check supports every statement but the planted ones. So every number
// the evaluation prints must come out perfect, and any that doesn't is
// the harness or the store, not a model: the run's units, the plants
// reaching the checker, the reads of each team, the newer versions ending
// what they replace and the second sources contesting. The paid run with
// a real model is scripts/brain-eval-extraction.ts.

/** Every text of the set with its facts: documents and second texts. */
const texts = [
  ...extractionEvalSet.documents,
  ...extractionEvalSet.probes.map(({ second }) => second),
];

/** The planted statements, which the careful checker refuses. */
const plantedStatements = new Set(
  extractionEvalSet.documents.flatMap(({ plants }) =>
    plants.map(({ statement }) => statement)
  )
);

/** The text a request's last user message holds. */
const messageOf = (request: SentRequest): string => {
  const body = z
    .object({
      messages: z.array(
        z.object({
          role: z.string(),
          content: z.union([
            z.string(),
            z.array(z.object({ text: z.string().optional() }).loose()),
          ]),
        })
      ),
    })
    .parse(request.body);
  const content = body.messages.findLast(
    ({ role }) => role === "user"
  )?.content;
  return typeof content === "string"
    ? content
    : (content ?? []).map(({ text }) => text ?? "").join("");
};

/** The careful model's answer to `requests`' last. */
const careful = async (
  requests: readonly SentRequest[]
): Promise<ProviderReply> => {
  await Promise.resolve();
  const request = requests.at(-1);
  if (request === undefined) {
    throw new RangeError("No request to answer");
  }
  const message = messageOf(request);
  if (isReadCall(request)) {
    const text = texts.find((candidate) => candidate.text === message);
    if (text === undefined) {
      throw new Error("The read call held no text of the set whole");
    }
    return {
      text: JSON.stringify(proposalOf(text.facts)),
      inputTokens: 100,
      outputTokens: 50,
    };
  }
  const { statements } = z
    .object({
      statements: z.array(z.object({ index: z.int(), statement: z.string() })),
    })
    .parse(JSON.parse(message));
  return {
    text: JSON.stringify({
      supported: statements
        .filter(({ statement }) => !plantedStatements.has(statement))
        .map(({ index }) => index),
    }),
    inputTokens: 100,
    outputTokens: 5,
  };
};

/** A share of all: `count` of `count`. */
const all = (count: number) => ({ count, of: count });

describe("the evaluation of extraction", { timeout: 180_000 }, () => {
  it("scores a careful model perfectly, whole: two draws alike, every plant refused, every label drawn, every change applied and every disagreement contested", async () => {
    expect(setProblems(extractionEvalSet)).toStrictEqual([]);
    const draws: DrawResult[] = [];
    const probes: ProbeResult[] = [];

    await runExtractionEval({
      set: extractionEvalSet,
      model: testModel,
      respond: careful,
      onDraw: (result) => {
        draws.push(result);
      },
      onProbe: (result) => {
        probes.push(result);
      },
    });
    const score = await scoreExtraction(extractionEvalSet, { draws, probes });

    const facts = extractionEvalSet.documents.flatMap(
      (document) => document.facts
    );
    const plants = extractionEvalSet.documents.flatMap(
      (document) => document.plants
    );
    expect({
      agreement: score.agreement,
      planted: score.planted,
      labelled: score.labelled,
      wronglyEnded: score.probes.wronglyEnded.count,
      changeMissed: score.probes.changeMissed,
      wronglyContested: score.probes.wronglyContested.count,
      contestMissed: score.probes.contestMissed,
      parked: score.parked,
    }).toStrictEqual({
      agreement: {
        documents: extractionEvalSet.documents.length,
        same: facts.length,
        valueDiffers: 0,
        onlyOne: 0,
      },
      planted: { count: 0, of: plants.length },
      labelled: {
        precision: all(facts.length),
        recall: all(facts.length),
        valueDiffers: 0,
        unfiled: 0,
      },
      wronglyEnded: 0,
      // The two changes: a renewal date and a team's lead.
      changeMissed: { count: 0, of: 2 },
      wronglyContested: 0,
      // The two disagreements, each a pair.
      contestMissed: { count: 0, of: 4 },
      parked: 0,
    });
  });
});

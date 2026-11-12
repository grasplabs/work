import {
  recallBudgetMax,
  recallLimit,
  vectorModelNameOf,
} from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { brainWorkOverview, recallAs, workBrain } from "../src/brain-next.ts";
import { embedderModel, warmQuestionEmbedder } from "../src/embedder.ts";
import { idIn, setUpEvalCompany } from "./brain-eval-company.ts";
import {
  askerOf,
  brainEvalSet,
  grepRecall,
  groupingOf,
  isLongDocument,
  leaksOf,
  passagesDigestOf,
  passagesOf,
  questionDigestOf,
  rankOf,
  setDigestOf,
  setProblems,
  sourceRankOf,
} from "./fixtures/brain-eval/set.ts";
import type { Returned } from "./fixtures/brain-eval/set.ts";
import { mockIdp } from "./idp.ts";

// The Brain evaluation (GRA-1726), on request only: scripts/brain-eval.ts
// runs it and reports (`vp run brain:eval`). It puts the evaluation's
// company (fixtures/brain-eval/) into a fresh core (brain-eval-company.ts):
// its people as members, its teams, and each source through core's own
// `addSource` with who may read it. Then it asks every question as its asker through core's
// `recallAs`, timing each recall, and asks the same of plain text search
// (`grepRecall` in fixtures/brain-eval/set.ts) over the same passages the
// Brain's chunker cuts the sources into, with the same access. It prints
// what each returned, one JSON line per question (`BRAIN_EVAL_RESULT`),
// for the script to score, and each chunk it returned that the set didn't
// cut (`BRAIN_EVAL_UNCUT`); it fails only when the set is broken, the
// Brain returned something its asker may not read, or it returned a chunk
// the set didn't cut.
//
// With a model (`BRAIN_EVAL_MODEL`, vite.brain-eval.config.ts), it first
// has core embed every passage, through the Brain's queue and core's bulk
// embedders as core's clock would, and loads the question embedder, so
// every recall searches by meaning too, its question embedded inside the
// recall's time.

const { sources, questions, version } = brainEvalSet;

const passages = passagesOf(sources);

/** Each source's passages' texts, by key, as the set cut them. */
const passageTexts = new Map(
  [...Map.groupBy(passages, ({ source }) => source.key)].map(
    ([key, each]) => [key, new Set(each.map(({ text }) => text))] as const
  )
);

const idp = mockIdp();

/** Most ticks the embedding of every passage may take. */
const embeddingTicksMost = 200;

/**
 * Has core embed every current passage with its model, tick after tick of
 * the Brain's work as core's clock runs it, an hour apart so a failed item
 * is due again at once, and load the question embedder: the model's name
 * and build. Null while no model ships.
 */
const embedEverything = async (): Promise<string | null> => {
  const model = await embedderModel();
  if (model === null) {
    return null;
  }
  await warmQuestionEmbedder(env);
  let at = Date.now();
  for (let tick = 0; tick < embeddingTicksMost; tick += 1) {
    at += 60 * 60 * 1000;
    // oxlint-disable-next-line no-await-in-loop -- one tick at a time, as core's clock
    await workBrain(env, new Date(at));
    // oxlint-disable-next-line no-await-in-loop -- read after each tick
    const { embedding } = await brainWorkOverview(env);
    if (
      embedding.rebuilt &&
      embedding.embedded + embedding.unembeddable === embedding.chunks
    ) {
      return vectorModelNameOf(model);
    }
  }
  throw new Error(
    `Not every passage was embedded in ${embeddingTicksMost} ticks`
  );
};

describe("the Brain evaluation", () => {
  it("asks every question of the Brain and of plain text search; nothing reaches an asker who may not read it, and every chunk returned is one the set cut", async () => {
    expect(setProblems(sources, questions)).toStrictEqual([]);

    const people = await setUpEvalCompany(idp, sources);

    const vectors = await embedEverything();

    console.log(
      `BRAIN_EVAL_RUN ${JSON.stringify({
        set: version,
        setDigest: await setDigestOf(brainEvalSet),
        passagesDigest: await passagesDigestOf(sources),
        sources: sources.length,
        longDocuments: sources.filter(isLongDocument).length,
        passages: passages.length,
        questions: questions.length,
        recallLimit,
        vectors,
      })}`
    );

    const leaking: string[] = [];
    const uncut: string[] = [];
    for (const question of questions) {
      const asker = askerOf(question);
      const started = performance.now();
      // oxlint-disable-next-line no-await-in-loop -- timed one at a time
      const recalled = await recallAs(env, idIn(people, asker), {
        personal: true,
        question: question.question,
        // The most a pack may hold, so every item is its whole chunk: the
        // evaluation scores the order the pack ranks passages in.
        budget: { tokens: recallBudgetMax },
      });
      const ms = performance.now() - started;
      // Recall returns a pack of chunks: the question's source is found
      // when a chunk of it holds the quote (`rankOf`), and the leak check
      // reads every chunk returned.
      const brain: Returned = {
        keys: recalled.items.map(({ source }) => source.id),
        texts: recalled.items.map(({ text }) => text),
      };
      const grep = grepRecall(passages, asker, question.question, recallLimit);
      const brainLeaks = leaksOf(sources, question, brain);
      if (brainLeaks.length > 0) {
        leaking.push(`${question.id}: ${brainLeaks.join(", ")}`);
      }
      // The set's checks (a quote whole in exactly one passage, no two
      // passages the same length) and the baseline hold only if the Brain
      // cuts each source as the set did: every chunk it returns of a source
      // of the set must be one of that source's passages.
      for (const { source, text } of recalled.items) {
        const cut = passageTexts.get(source.id);
        if (cut !== undefined && !cut.has(text)) {
          uncut.push(`${question.id}: ${source.id}`);
          console.log(
            `BRAIN_EVAL_UNCUT ${JSON.stringify({
              id: question.id,
              source: source.id,
              start: text.slice(0, 60),
            })}`
          );
        }
      }
      console.log(
        `BRAIN_EVAL_RESULT ${JSON.stringify({
          id: question.id,
          // oxlint-disable-next-line no-await-in-loop -- one per question
          digest: await questionDigestOf(brainEvalSet, question),
          ...groupingOf(sources, question),
          brain: {
            rank: rankOf(question, brain),
            sourceRank: sourceRankOf(question, brain),
            returned: brain.keys.length,
            leaks: brainLeaks,
            ms,
          },
          grep: {
            rank: rankOf(question, grep),
            sourceRank: sourceRankOf(question, grep),
            returned: grep.keys.length,
          },
        })}`
      );
    }
    expect(leaking).toStrictEqual([]);
    expect(uncut).toStrictEqual([]);
  });
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { recallAs } from "../src/brain-next.ts";
import { parseModelRef } from "../src/model-catalog.ts";
import { usageRecorded } from "../src/model-usage.ts";
import { answerAndJudge, bothArms } from "./brain-eval-arms.ts";
import { idIn, setUpEvalCompany } from "./brain-eval-company.ts";
import { realProvider } from "./brain-real-provider.ts";
import type { BrainEvalQuestion } from "./fixtures/brain-eval/company.ts";
import {
  answeringPassageOf,
  costOf,
  everythingBudgetOf,
  everythingFor,
  packTokens,
  questionTokensMax,
  secretsHiddenFrom,
  seededOrder,
  sourceBlock,
} from "./fixtures/brain-eval/everything.ts";
import {
  askerOf,
  brainEvalSet,
  groupingOf,
  setDigestOf,
  setProblems,
} from "./fixtures/brain-eval/set.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import { spentMicros } from "./model-usage.ts";
import { realProviderTakes, unreachableModel } from "./real-providers.ts";
import { testBinding } from "./test-env.ts";

// The Brain evaluation against a real model (GRA-1813), on request only:
// scripts/brain-eval-model.ts says how to run it and scores what it
// prints (vite.brain-eval-model.config.ts). It puts the evaluation's
// company into a fresh core (brain-eval-company.ts), then asks each
// question, in a seeded order, of the model twice, through core's model
// gateway as any of core's calls: once with the Brain's recall pack for
// the asker, once with everything the asker may read
// (fixtures/brain-eval/everything.ts); and for a question with an answer,
// the same model judges each answer against the passage that answers it.
// The model is reached as the Brain baseline's run reached it (GRA-676):
// connect's provider bridge, then the provider's own API with the real key
// (brain-real-provider.ts). It prints one JSON line per question
// (`BRAIN_EVAL_MODEL_RESULT`).
//
// The budget: no question starts once what core recorded as spent, plus
// the most that question can cost at the model's list price, would pass
// it. The provider key's own spend limit is the hard cap.
//
// Access: "everything" holds only sources the asker may read, and the run
// fails before sending it if it held a secret the set keeps from them; an
// answer that holds its question's secret is a leak, which fails the run
// once every question is asked.

const settings = z
  .object({
    model: z.string().min(1),
    budgetUsd: z.number().positive(),
    everythingTokens: z.int().positive().nullable(),
  })
  .parse(testBinding("BRAIN_EVAL_MODEL_RUN"));

/** The provider's real key: never committed. */
const realKey = z.string().min(1).parse(testBinding("BRAIN_MODEL_KEY"));

const { sources, questions, version } = brainEvalSet;

/** Micros in a US dollar. */
const micros = 1_000_000;

const idp = mockIdp();

/** The months a run's spend is in: the one it started in, and now. */
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

describe("the Brain evaluation against a real model", () => {
  it(`answers every question from the recall pack and from everything, with ${settings.model}, within its budget`, async () => {
    const ref = parseModelRef(settings.model);
    if (ref === undefined || !realProviderTakes(settings.model)) {
      throw new Error(unreachableModel(settings.model));
    }
    expect(setProblems(sources, questions)).toStrictEqual([]);
    const people = await setUpEvalCompany(idp, sources);
    await answeringProvider(
      async (requests) =>
        await realProvider(realKey, () => {
          // Each exchange's tokens come back through the gateway's answer.
        })(() => ({ phase: "prior" }))(requests),
      { models: [settings.model] }
    );
    const { contextWindow, cost } = ref.catalog;
    const months = new Set([monthOf(new Date())]);
    const before = await spentIn(months);
    const budget = settings.budgetUsd * micros;

    console.log(
      `BRAIN_EVAL_MODEL_RUN ${JSON.stringify({
        set: version,
        setDigest: await setDigestOf(brainEvalSet),
        model: settings.model,
        questions: questions.length,
        packTokens,
        everythingTokens: settings.everythingTokens,
        budgetUsd: settings.budgetUsd,
        packSearch: "words and exact parts",
      })}`
    );

    const leaking: string[] = [];
    /** One question asked of both arms and judged; false when the budget stops it first. */
    const askOne = async (question: BrainEvalQuestion): Promise<boolean> => {
      const asker = askerOf(question);
      const everything = everythingFor(
        sources,
        asker,
        Math.min(
          everythingBudgetOf(contextWindow, question),
          settings.everythingTokens ?? Number.POSITIVE_INFINITY
        )
      );
      const passage = answeringPassageOf(sources, question);
      months.add(monthOf(new Date()));
      const spent = (await spentIn(months)) - before;
      const most =
        costOf(questionTokensMax(question, everything.tokens, passage), cost) *
        micros;
      if (spent + most > budget) {
        return false;
      }
      const recalled = await recallAs(env, idIn(people, asker), {
        question: question.question,
        budget: { tokens: packTokens },
      });
      const pack = recalled.items
        .map(({ source, text }) => sourceBlock(source.id, text))
        .join("");
      // Each arm is built from what the asker may read only: a context that
      // held what the set keeps from them is never sent.
      const hiddenFromAsker = secretsHiddenFrom(questions, asker);
      for (const [arm, context] of [
        ["pack", pack],
        ["everything", everything.text],
      ] as const) {
        if (hiddenFromAsker.some((secret) => context.includes(secret))) {
          throw new Error(
            `The ${arm} context for ${question.id} held what its asker may not read`
          );
        }
      }
      // Both settle before either's failure is thrown (`bothArms`).
      const { pack: fromPack, everything: fromEverything } = await bothArms(
        async () =>
          await answerAndJudge(
            env,
            settings.model,
            question,
            "pack",
            pack,
            passage
          ),
        async () =>
          await answerAndJudge(
            env,
            settings.model,
            question,
            "everything",
            everything.text,
            passage
          )
      );
      for (const [arm, result] of [
        ["pack", fromPack],
        ["everything", fromEverything],
      ] as const) {
        if (result.leaks.length > 0) {
          leaking.push(`${question.id} (${arm})`);
        }
      }
      console.log(
        `BRAIN_EVAL_MODEL_RESULT ${JSON.stringify({
          id: question.id,
          ...groupingOf(sources, question),
          pack: fromPack,
          everything: {
            ...fromEverything,
            sources: everything.keys.length,
            cut: everything.cut,
          },
        })}`
      );
      return true;
    };

    // One question at a time, for the budget. A call that fails (a
    // provider's error, a context refused) ends the run marked failed,
    // with the results asked before it kept, and then fails the test.
    let asked = 0;
    let stoppedAtBudget = false;
    let failure: Error | null = null;
    try {
      for (const question of seededOrder(questions)) {
        // oxlint-disable-next-line no-await-in-loop -- one at a time, see above
        if (!(await askOne(question))) {
          stoppedAtBudget = true;
          break;
        }
        asked += 1;
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    const spentUsd = ((await spentIn(months)) - before) / micros;
    console.log(
      `BRAIN_EVAL_MODEL_END ${JSON.stringify({ asked, stoppedAtBudget, failed: failure !== null, spentUsd })}`
    );
    if (failure !== null) {
      throw failure;
    }
    expect({
      leaking,
      withinBudget: spentUsd <= settings.budgetUsd,
    }).toStrictEqual({ leaking: [], withinBudget: true });
  });
});

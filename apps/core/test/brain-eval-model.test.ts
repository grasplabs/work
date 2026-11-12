import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { recallAs } from "../src/brain-next.ts";
import { parseModelRef } from "../src/model-catalog.ts";
import { usageRecorded } from "../src/model-usage.ts";
import { models } from "../src/models.ts";
import { idIn, setUpEvalCompany } from "./brain-eval-company.ts";
import { realProvider, realProviderTakes } from "./brain-real-provider.ts";
import type { BrainEvalQuestion } from "./fixtures/brain-eval/company.ts";
import {
  answerInput,
  answerSystem,
  answeringPassageOf,
  costOf,
  everythingBudgetOf,
  everythingFor,
  judgeInput,
  judgeSystem,
  judgedCorrect,
  outputTokensMax,
  packTokens,
  questionTokensMax,
  saidNotFound,
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
    everythingTokens: z.number().nonnegative(),
    sha: z.string().regex(/^[0-9a-f]{40}$/u),
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

/** One answer through core's gateway: its text and the tokens it used. */
const ask = async (
  purpose: string,
  system: string,
  input: string
): Promise<{ text: string; input: number; output: number }> => {
  const { text, usage } = await models(env).call({
    model: settings.model,
    system,
    input,
    purpose,
    trigger: { type: "system" },
    work: { platform: "brain_upkeep" },
    maxTokens: outputTokensMax,
  });
  return { text, input: usage.inputTokens, output: usage.outputTokens };
};

/** Secrets of `question` that `text` holds. */
const leaksIn = (question: BrainEvalQuestion, text: string): string[] =>
  question.expects.kind === "hidden"
    ? question.expects.secrets.filter((secret) => text.includes(secret))
    : [];

/** One arm's answer to `question` from `context`, judged. */
const answerAndJudge = async (
  question: BrainEvalQuestion,
  arm: "pack" | "everything",
  context: string,
  passage: string
) => {
  const answered = await ask(
    `brain.eval.${arm}`,
    answerSystem,
    answerInput(question.question, context)
  );
  const leaks = leaksIn(question, answered.text);
  let correct = saidNotFound(answered.text) && leaks.length === 0;
  let { input } = answered;
  let { output } = answered;
  if (question.expects.kind === "answer") {
    const verdict = await ask(
      "brain.eval.judge",
      judgeSystem,
      judgeInput(question.question, passage, answered.text)
    );
    correct = judgedCorrect(verdict.text);
    input += verdict.input;
    output += verdict.output;
  }
  return { correct, leaks, inputTokens: input, outputTokens: output };
};

describe("the Brain evaluation against a real model", () => {
  it(`answers every question from the recall pack and from everything, with ${settings.model}, within its budget`, async () => {
    const ref = parseModelRef(settings.model);
    if (ref === undefined || !realProviderTakes(settings.model)) {
      throw new Error(
        `A run reaches Anthropic, Mistral and OpenRouter models of the gateway's catalog, not ${settings.model}`
      );
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
      })}`
    );

    let asked = 0;
    let stoppedAtBudget = false;
    const leaking: string[] = [];
    for (const question of seededOrder(questions)) {
      const asker = askerOf(question);
      const everything = everythingFor(
        sources,
        asker,
        Math.min(
          everythingBudgetOf(contextWindow, question),
          settings.everythingTokens > 0
            ? settings.everythingTokens
            : Number.POSITIVE_INFINITY
        )
      );
      const passage = answeringPassageOf(sources, question);
      months.add(monthOf(new Date()));
      // oxlint-disable-next-line no-await-in-loop -- the budget is read before each question
      const spent = (await spentIn(months)) - before;
      const most =
        costOf(questionTokensMax(question, everything.tokens, passage), cost) *
        micros;
      if (spent + most > budget) {
        stoppedAtBudget = true;
        break;
      }
      // oxlint-disable-next-line no-await-in-loop -- one question at a time, for the budget
      const recalled = await recallAs(env, idIn(people, asker), {
        question: question.question,
        budget: { tokens: packTokens },
        personal: true,
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
      // oxlint-disable-next-line no-await-in-loop -- one question at a time, for the budget
      const [fromPack, fromEverything] = await Promise.all([
        answerAndJudge(question, "pack", pack, passage),
        answerAndJudge(question, "everything", everything.text, passage),
      ]);
      for (const [arm, result] of [
        ["pack", fromPack],
        ["everything", fromEverything],
      ] as const) {
        if (result.leaks.length > 0) {
          leaking.push(`${question.id} (${arm})`);
        }
      }
      asked += 1;
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
    }
    const spentUsd = ((await spentIn(months)) - before) / micros;
    console.log(
      `BRAIN_EVAL_MODEL_END ${JSON.stringify({ asked, stoppedAtBudget, spentUsd })}`
    );
    expect({
      leaking,
      withinBudget: spentUsd <= settings.budgetUsd,
    }).toStrictEqual({ leaking: [], withinBudget: true });
  });
});

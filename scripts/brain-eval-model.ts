/**
 * The Brain evaluation's second baseline (GRA-1813): a real model answers
 * each question of the evaluation (GRA-1726) twice, from the Brain's
 * recall pack and from everything the asker may read, and the same model
 * judges each answer. It costs money, so it runs only on request, never
 * in CI or `vp test`, and only with a model's key and the most it may
 * spend:
 *
 *   vp run brain:eval:model
 *       says what a run would do and the most it could cost; spends nothing
 *   BRAIN_MODEL=<provider>/<model> vp run brain:eval:model
 *       the same, for that model (the gateway's name for it)
 *   BRAIN_MODEL=<provider>/<model> BRAIN_MODEL_KEY=… BRAIN_MODEL_BUDGET_USD=<dollars> vp run brain:eval:model
 *       runs it
 *
 * `BRAIN_EVAL_EVERYTHING_TOKENS` cuts "everything" below the model's
 * window. The model is reached as the Brain baseline's opt-in run reached
 * it (GRA-676, apps/core/vite.brain-model.config.ts): through core's
 * model gateway and connect, then to the provider's own API with the real
 * key (Anthropic's, Mistral's or OpenRouter's), which is never committed:
 * give it in the shell. No question starts once what core recorded as
 * spent, plus the most that question can cost, would pass the budget; the
 * provider key's own spend limit is the hard cap. Exits 1 when the run
 * failed or an answer held what its asker may not read; writes the result
 * to `.brain-eval/model-<time>-<sha>.json` (git-ignored) otherwise.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseModelRef } from "../apps/core/src/model-catalog.ts";
import {
  answeringPassageOf,
  costOf,
  everythingBudgetOf,
  everythingCapOf,
  everythingFor,
  judgedAnswerTokensMax,
  packTokens,
  questionTokensMax,
} from "../apps/core/test/fixtures/brain-eval/everything.ts";
import {
  askerOf,
  brainEvalSet,
} from "../apps/core/test/fixtures/brain-eval/set.ts";
import {
  realProviderTakes,
  unreachableModel,
} from "../apps/core/test/real-providers.ts";
import {
  modelReport,
  modelResultSchema,
  modelRunEndSchema,
  modelRunInfoSchema,
  summarizeModelRun,
} from "./brain-eval-model-scoring.ts";

const root = path.join(import.meta.dirname, "..");

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();

/** The model the Brain baseline's run took while none is named. */
const named = process.env.BRAIN_MODEL;
const model =
  named === undefined || named === "" ? "mistral/mistral-large-latest" : named;
const key = process.env.BRAIN_MODEL_KEY ?? "";
const budgetUsd = Number(process.env.BRAIN_MODEL_BUDGET_USD);

const fail: (message: string) => never = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const ref = parseModelRef(model);
if (ref === undefined) {
  fail(
    `The gateway doesn't offer ${model}: name one of its catalog as <provider>/<model>`
  );
}
const { contextWindow, cost } = ref.catalog;
if (!(cost.input > 0 && cost.output > 0)) {
  fail(
    `The gateway's catalog has no price for ${model}: its cost can't be bounded`
  );
}
if (!realProviderTakes(model)) {
  fail(unreachableModel(model));
}
let cap: number | null = null;
try {
  cap = everythingCapOf(process.env.BRAIN_EVAL_EVERYTHING_TOKENS);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const { sources, questions } = brainEvalSet;

/** Each question's "everything" budget: the model's window, or less. */
const budgetOf = (question: (typeof questions)[number]): number =>
  Math.min(
    everythingBudgetOf(contextWindow, question),
    cap ?? Number.POSITIVE_INFINITY
  );

const tightest = Math.min(...questions.map(budgetOf));
if (!(tightest > 0)) {
  fail(
    `${model}'s window (${contextWindow} tokens), or the cut, leaves no room for "everything"`
  );
}

// What a run would send: every question's "everything", as the run builds it.
const planned = questions.map((question) => {
  const everything = everythingFor(
    sources,
    askerOf(question),
    budgetOf(question)
  );
  return {
    everything,
    tokens: questionTokensMax(
      question,
      everything.tokens,
      answeringPassageOf(sources, question)
    ),
  };
});
const most = { input: 0, output: 0 };
for (const { tokens } of planned) {
  most.input += tokens.input;
  most.output += tokens.output;
}
const sizes = planned.map(({ everything }) => everything.tokens);
const mostUsd = costOf(most, cost);
const plan = [
  `Brain evaluation against a model · set ${brainEvalSet.version} · ${questions.length} questions over ${sources.length} sources`,
  `Model: ${model} (window ${contextWindow} tokens; list price $${cost.input} / $${cost.output} per million input / output tokens), also the judge.`,
  `Each question: the model answers from the Brain's recall pack (at most ${packTokens} tokens) and from everything the asker may read, newest first, cut at ${cap === null ? "the model's window" : `${cap} tokens`} (${Math.min(...sizes)} to ${Math.max(...sizes)} tokens; cut for ${planned.filter(({ everything }) => everything.cut).length} questions). The pack arm's recall searches by words and exact parts only: the run embeds no passage. The judge checks each answer to a question with an answer against the passage that answers it, reading at most ${judgedAnswerTokensMax} tokens of it.`,
  `At most ${most.input} input and ${most.output} output tokens (the Brain's token count, above a real tokenizer's; every output at its limit): at most $${mostUsd.toFixed(2)} at list price for every question.`,
].join("\n");

if (key === "" || !(budgetUsd > 0)) {
  process.stdout.write(
    `${plan}\n\nNothing was sent. To run it, give the provider's key and the most it may spend, in US dollars:\n  BRAIN_MODEL=${model} BRAIN_MODEL_KEY=… BRAIN_MODEL_BUDGET_USD=${Math.ceil(mostUsd)} vp run brain:eval:model\nNo question starts once what was spent, plus the most it can cost, would pass the budget.\n`
  );
  process.exit(0);
}

const sha = git("rev-parse", "HEAD");
if (git("status", "--porcelain", "--untracked-files=no") !== "") {
  fail("Commit your changes first: a run pins the commit it ran");
}
process.stdout.write(`${plan}\nBudget: $${budgetUsd}.\n\n`);

const run = spawnSync(
  path.join(root, "node_modules/.bin/vp"),
  [
    "-C",
    "apps/core",
    "test",
    "-c",
    "vite.brain-eval-model.config.ts",
    "--maxWorkers=1",
  ],
  {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, BRAIN_MODEL: model },
  }
);
const output = `${run.stdout}${run.stderr}`;

const linesAfter = (marker: string): unknown[] =>
  output.split("\n").flatMap((line): unknown[] => {
    const at = line.indexOf(`${marker} `);
    return at === -1 ? [] : [JSON.parse(line.slice(at + marker.length + 1))];
  });

const [info] = linesAfter("BRAIN_EVAL_MODEL_RUN").map((line) =>
  modelRunInfoSchema.parse(line)
);
const [end] = linesAfter("BRAIN_EVAL_MODEL_END").map((line) =>
  modelRunEndSchema.parse(line)
);
const results = linesAfter("BRAIN_EVAL_MODEL_RESULT").map((line) =>
  modelResultSchema.parse(line)
);
if (info === undefined || end === undefined || results.length !== end.asked) {
  process.stderr.write(`${output.split("\n").slice(-60).join("\n")}\n`);
  fail("The run did not finish: see its output above. Nothing was kept.");
}
const summary = summarizeModelRun(results, cost);
process.stdout.write(`${modelReport(summary, end, questions.length)}\n`);
// What was asked is kept even when the run failed (a provider's error part
// of the way, a leak), marked so, since it was paid for.
const passed = run.status === 0 && !end.failed && summary.leaks.length === 0;
const out = path.join(root, ".brain-eval");
mkdirSync(out, { recursive: true });
const at = new Date().toISOString();
const file = path.join(
  out,
  `model-${at.replaceAll(":", "-")}-${sha.slice(0, 8)}${passed ? "" : "-failed"}.json`
);
writeFileSync(
  file,
  `${JSON.stringify({ identity: { info, sha, at }, failed: !passed, end, results, summary }, null, 2)}\n`
);
if (!passed) {
  process.stderr.write(
    `\n${run.status === 0 ? "" : `${output.split("\n").slice(-60).join("\n")}\n`}The run failed, or an answer held what its asker may not read: see above.\n`
  );
}
process.stdout.write(`\nResult${passed ? "" : ", marked failed"}: ${file}\n`);
process.exit(passed ? 0 : 1);

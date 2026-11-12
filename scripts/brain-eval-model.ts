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

import type { z } from "zod";

import { parseModelRef } from "../apps/core/src/model-catalog.ts";
import {
  answeringPassageOf,
  costOf,
  everythingBudgetOf,
  everythingCapOf,
  everythingFor,
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
  keptAs,
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

/**
 * `question`'s "everything", as the run builds it: refused, as the run
 * refuses it (`everythingFor`), when the window or the cut leaves no room.
 */
const everythingOf = (question: (typeof questions)[number]) => {
  try {
    return everythingFor(sources, askerOf(question), budgetOf(question));
  } catch (error) {
    return fail(
      `${model} (window ${contextWindow} tokens): ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

// What a run would send: every question's "everything", as the run builds it.
const planned = questions.map((question) => {
  const everything = everythingOf(question);
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
  `Each question: the model answers from the Brain's recall pack (at most ${packTokens} tokens) and from everything the asker may read, newest first, cut at ${cap === null ? "the model's window" : `${cap} tokens`} (${Math.min(...sizes)} to ${Math.max(...sizes)} tokens; cut for ${planned.filter(({ everything }) => everything.cut).length} questions). The pack arm's recall searches by words and exact parts only: the run embeds no passage. The judge checks each answer to a question with an answer against the passage that answers it.`,
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

/**
 * What the run printed after `marker`, a JSON value a line, parsed by
 * `schema`: a line a crash cut short is left out, never the whole run.
 */
const linesAfter = <T>(marker: string, schema: z.ZodType<T>): T[] =>
  output.split("\n").flatMap((line): T[] => {
    const at = line.indexOf(`${marker} `);
    if (at === -1) {
      return [];
    }
    try {
      const parsed = schema.safeParse(
        JSON.parse(line.slice(at + marker.length + 1))
      );
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });

const [info] = linesAfter("BRAIN_EVAL_MODEL_RUN", modelRunInfoSchema);
const [printedEnd] = linesAfter("BRAIN_EVAL_MODEL_END", modelRunEndSchema);
const results = linesAfter("BRAIN_EVAL_MODEL_RESULT", modelResultSchema);
const tail = `${output.split("\n").slice(-60).join("\n")}\n`;
if (info === undefined || (printedEnd === undefined && results.length === 0)) {
  process.stderr.write(tail);
  fail(
    "The run did not finish: see its output above. Nothing was asked, so nothing was kept."
  );
}
// What was asked is kept, since it was paid for: marked failed when the
// run failed, was cut off before its end line or leaked, and partial when
// it stopped at its budget (`keptAs`).
const summary = summarizeModelRun(results, cost);
const { end, failed, partial, suffix } = keptAs(
  run.status,
  printedEnd,
  results,
  summary.leaks.length
);
process.stdout.write(`${modelReport(summary, end, questions.length)}\n`);
const out = path.join(root, ".brain-eval");
mkdirSync(out, { recursive: true });
const at = new Date().toISOString();
const file = path.join(
  out,
  `model-${at.replaceAll(":", "-")}-${sha.slice(0, 8)}${suffix}.json`
);
writeFileSync(
  file,
  `${JSON.stringify({ identity: { info, sha, at }, failed, partial, end, results, summary }, null, 2)}\n`
);
if (failed) {
  process.stderr.write(
    `\n${run.status === 0 ? "" : tail}The run failed, was cut off, or an answer held what its asker may not read: see above.\n`
  );
}
process.stdout.write(
  `\nResult${suffix === "" ? "" : `, marked ${suffix.slice(1)}`}: ${file}\n`
);
process.exit(failed ? 1 : 0);

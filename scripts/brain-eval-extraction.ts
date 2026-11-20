/**
 * The evaluation of extraction (GRA-1992): the Brain's real extraction
 * (its read call and its check call, with their real prompts, through
 * core's model gateway) over a small set written for the purpose
 * (apps/core/test/fixtures/brain-extraction-eval/), scored three ways:
 *
 * - two draws of each document compared (no labels needed);
 * - statements the document doesn't support planted among what the
 *   checker is shown, and the share it lets through (no labels needed);
 * - the clean draws against the labels (precision and recall), and what
 *   a newer version or a second source does to what was drawn: true facts
 *   ended wrongly, memories contested wrongly, changes not applied, real
 *   disagreements not contested.
 *
 * It costs model calls, so it runs only on request, never in CI or
 * `vp test`, and only with a model's key and the most it may spend:
 *
 *   vp run brain:eval:extraction
 *       says what a run would send and about what it costs; spends nothing
 *   BRAIN_MODEL=<provider>/<model> vp run brain:eval:extraction
 *       the same, priced for that model (the gateway's name for it)
 *   BRAIN_MODEL=<provider>/<model> BRAIN_MODEL_KEY=… BRAIN_MODEL_BUDGET_USD=<dollars> vp run brain:eval:extraction
 *       runs it
 *
 * The model is reached as the Brain evaluation's paid run reaches it
 * (scripts/brain-eval-model.ts): through core's model gateway and connect,
 * then to the provider's own API with the real key (Anthropic's,
 * Mistral's or OpenRouter's), which is never committed: give it in the
 * shell. No unit (one document drawn once: two calls) starts once what
 * core recorded as spent reaches the budget; the provider key's own spend
 * limit is the hard cap. Writes what it read, since it was paid for, to
 * `.brain-eval/extraction/extraction-<time>-<sha>.json` (git-ignored),
 * with `-partial` when it stopped at its budget and `-failed` when it
 * failed; exits 1 for that last.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseModelRef } from "../apps/core/src/model-catalog.ts";
import {
  costOf,
  planOf,
} from "../apps/core/test/fixtures/brain-extraction-eval/plan.ts";
import {
  extractionReport,
  readExtractionRun,
  scoreExtraction,
} from "../apps/core/test/fixtures/brain-extraction-eval/scoring.ts";
import {
  extractionEvalSet,
  setProblems,
} from "../apps/core/test/fixtures/brain-extraction-eval/set.ts";
import {
  realProviderTakes,
  unreachableModel,
} from "../apps/core/test/real-providers.ts";

const root = path.join(import.meta.dirname, "..");

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();

/** The model the Brain evaluation's paid run takes while none is named. */
const named = process.env.BRAIN_MODEL;
const model =
  named === undefined || named === "" ? "mistral/mistral-large-latest" : named;
const key = process.env.BRAIN_MODEL_KEY ?? "";
const budgetUsd = Number(process.env.BRAIN_MODEL_BUDGET_USD);

const fail: (message: string) => never = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const problems = setProblems(extractionEvalSet);
if (problems.length > 0) {
  fail(`The set is broken:\n${problems.join("\n")}`);
}
const ref = parseModelRef(model);
if (ref === undefined) {
  fail(
    `The gateway doesn't offer ${model}: name one of its catalog as <provider>/<model>`
  );
}
if (!realProviderTakes(model)) {
  fail(unreachableModel(model));
}
const { cost } = ref.catalog;
const { documents, probes } = extractionEvalSet;
const plan = planOf(extractionEvalSet);
const priced = cost.input > 0 && cost.output > 0;
const summary = [
  `Evaluation of extraction · set ${extractionEvalSet.version} · ${documents.length} documents (each drawn twice: clean, and with its planted statements), ${probes.length} probes (a newer version or a second source)`,
  `Model: ${model}, for the read and the check.`,
  `${plan.units} units, ${plan.calls} model calls (a read and a check each): about ${plan.input} input and ${plan.output} output tokens (the Brain's estimate, above a real tokenizer's; a model that thinks before it answers spends more output).`,
  priced
    ? `About $${costOf(plan, cost).toFixed(2)} at list price ($${cost.input} / $${cost.output} per million input / output tokens).`
    : "The gateway's catalog has no price for this model.",
].join("\n");

if (key === "" || !(budgetUsd > 0)) {
  process.stdout.write(
    `${summary}\n\nNothing was sent. To run it, give the provider's key and the most it may spend, in US dollars:\n  BRAIN_MODEL=${model} BRAIN_MODEL_KEY=… BRAIN_MODEL_BUDGET_USD=<dollars> vp run brain:eval:extraction\nNo unit starts once what was spent reaches the budget.\n`
  );
  process.exit(0);
}

const sha = git("rev-parse", "HEAD");
if (git("status", "--porcelain", "--untracked-files=no") !== "") {
  fail("Commit your changes first: a run pins the commit it ran");
}
process.stdout.write(`${summary}\nBudget: $${budgetUsd}.\n\n`);

const run = spawnSync(
  path.join(root, "node_modules/.bin/vp"),
  [
    "-C",
    "apps/core",
    "test",
    "-c",
    "vite.brain-eval-extraction.config.ts",
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
const tail = `${output.split("\n").slice(-60).join("\n")}\n`;
const read = readExtractionRun(output);
if (read.info === undefined) {
  process.stderr.write(tail);
  fail("The run did not start: see its output above. Nothing was kept.");
}
if (read.unread > 0) {
  process.stderr.write(
    `${read.unread} printed lines could not be read (cut short or garbled) and are left out.\n`
  );
}
const score = await scoreExtraction(extractionEvalSet, read);
process.stdout.write(
  `Prompts: read ${read.info.prompts.read.slice(0, 12)}, check ${read.info.prompts.check.slice(0, 12)}\n${extractionReport(score)}\n`
);
const failed = run.status !== 0 || read.end === undefined || read.end.failed;
const partial = read.end?.stopped === true;
let suffix = "";
if (failed) {
  suffix = "-failed";
} else if (partial) {
  suffix = "-partial";
}
const out = path.join(root, ".brain-eval", "extraction");
mkdirSync(out, { recursive: true });
const at = new Date().toISOString();
const file = path.join(
  out,
  `extraction-${at.replaceAll(":", "-")}-${sha.slice(0, 8)}${suffix}.json`
);
writeFileSync(
  file,
  `${JSON.stringify({ identity: { info: read.info, sha, at }, end: read.end ?? null, failed, partial, score, draws: read.draws, probes: read.probes }, null, 2)}\n`
);
if (failed) {
  process.stderr.write(`\n${tail}The run failed or was cut off: see above.\n`);
}
process.stdout.write(
  `\nSpent: $${(read.end?.spentUsd ?? 0).toFixed(2)}. Result${suffix === "" ? "" : `, marked ${suffix.slice(1)}`}: ${file}\n`
);
process.exit(failed ? 1 : 0);

/**
 * The Brain evaluation (GRA-1726): how well recall finds the passage that
 * answers a question, per language, across languages, in the set written
 * in Dutch and in long documents, against plain text search over the same
 * passages, with a margin of error, and how long each recall takes.
 * Outside the checks on each change: it is in no project the root runs,
 * so neither `vp test` nor CI runs it.
 *
 *   vp run brain:eval                      run it against a local Brain
 *   vp run brain:eval -- --against <file>  compare with that run instead of the last
 *   vp run brain:eval -- --out <dir>       keep results there (default .brain-eval/)
 *
 * It runs apps/core/vite.brain-eval.config.ts: core on workerd, as in the
 * tests, with the evaluation's company (apps/core/test/fixtures/brain-eval/)
 * added through core's own `addSource` and every question asked through
 * `recallAs`. It prints a compact table and writes the result, one JSON
 * file per run, which the next run compares with: per group, better or
 * worse than last time only beyond the margin. Latency is measured on
 * this machine's workerd, not on production. Exits 1 when the run failed:
 * anything reached an asker who may not read it, the Brain returned a chunk
 * the set didn't cut, or anything else; a failed run's result is not kept,
 * so it never becomes the baseline.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import {
  comparable,
  compareRuns,
  latencyTargetsMs,
  questionResultSchema,
  report,
  resultBudget,
  runInfoSchema,
  summarize,
} from "./brain-eval-scoring.ts";

const root = path.join(import.meta.dirname, "..");

const { values: options } = parseArgs({
  options: {
    out: { type: "string", default: path.join(root, ".brain-eval") },
    against: { type: "string" },
  },
});

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();

const runFileSchema = z.object({
  identity: z.object({
    run: runInfoSchema,
    resultBudget: z.int(),
    target: z.string(),
    sha: z.string(),
    dirty: z.boolean(),
    at: z.string(),
  }),
  results: z.array(questionResultSchema),
});
type RunFile = z.infer<typeof runFileSchema>;

/** The run's output: workerd's log lines with Vitest's. */
const runInWorkerd = (): { ok: boolean; output: string } => {
  const run = spawnSync(
    path.join(root, "node_modules/.bin/vp"),
    [
      "-C",
      "apps/core",
      "test",
      "-c",
      "vite.brain-eval.config.ts",
      "--maxWorkers=1",
    ],
    { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }
  );
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}` };
};

const linesAfter = (output: string, marker: string): unknown[] =>
  output.split("\n").flatMap((line): unknown[] => {
    const at = line.indexOf(`${marker} `);
    if (at === -1) {
      return [];
    }
    const json: unknown = JSON.parse(line.slice(at + marker.length + 1));
    return [json];
  });

/** A chunk the Brain returned that the set didn't cut, as the run printed it. */
const uncutSchema = z.object({
  id: z.string(),
  source: z.string(),
  start: z.string(),
});

/** The last lines of the run's output. */
const tailOf = (output: string): string =>
  output.split("\n").slice(-60).join("\n");

/** The newest earlier run in `dir`, if there is one. */
const lastRunIn = (dir: string): string | undefined =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .at(-1);

const { ok, output } = runInWorkerd();
const [info] = linesAfter(output, "BRAIN_EVAL_RUN").map((line) =>
  runInfoSchema.parse(line)
);
const results = linesAfter(output, "BRAIN_EVAL_RESULT").map((line) =>
  questionResultSchema.parse(line)
);
const uncut = linesAfter(output, "BRAIN_EVAL_UNCUT").map((line) =>
  uncutSchema.parse(line)
);
if (info === undefined || results.length !== info.questions) {
  process.stderr.write(`${tailOf(output)}\n`);
  process.stderr.write(
    "The Brain evaluation did not finish: see its output above.\n"
  );
  process.exit(1);
}

mkdirSync(options.out, { recursive: true });
const againstPath =
  options.against ??
  (() => {
    const last = lastRunIn(options.out);
    return last === undefined ? undefined : path.join(options.out, last);
  })();
const before: RunFile | undefined =
  againstPath === undefined
    ? undefined
    : runFileSchema.parse(JSON.parse(readFileSync(againstPath, "utf-8")));

const at = new Date().toISOString();
const sha = git("rev-parse", "HEAD");
const run: RunFile = {
  identity: {
    run: info,
    resultBudget,
    target: "local: core on workerd (Vitest pool), this machine",
    sha,
    dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
    at,
  },
  results,
};
const summary = summarize(results);
const file = path.join(
  options.out,
  `${at.replaceAll(":", "-")}-${sha.slice(0, 8)}.json`
);
// Failed: the run didn't finish cleanly, something reached an asker who may
// not read it, or the Brain returned a chunk the set didn't cut.
const passed = ok && summary.leaks.length === 0 && uncut.length === 0;
if (passed) {
  writeFileSync(file, `${JSON.stringify({ ...run, summary }, null, 2)}\n`);
}

const passagesLine =
  info.longDocuments === undefined || info.passages === undefined
    ? ""
    : ` (${info.longDocuments} long documents, ${info.passages} passages)`;
const head = [
  `Brain evaluation · set ${info.set} · ${info.questions} questions over ${info.sources} sources${passagesLine} · ${run.identity.target} · ${sha.slice(0, 8)}${run.identity.dirty ? " (uncommitted changes)" : ""}`,
  `R@${resultBudget}: the passage that answers the question among the first ${resultBudget} of at most ${info.recallLimit} results. Latency targets (${latencyTargetsMs.p50} ms / ${latencyTargetsMs.p95} ms) are for production; this is not.`,
  before === undefined
    ? "No earlier run to compare with."
    : `Compared with ${againstPath} (set ${before.identity.run.set}, ${before.identity.sha.slice(0, 8)}).`,
  "",
];
process.stdout.write(
  `${head.join("\n")}${report(
    summary,
    before === undefined
      ? null
      : compareRuns(results, before.results, {
          judged: comparable(
            {
              setDigest: before.identity.run.setDigest,
              passagesDigest: before.identity.run.passagesDigest,
              recallLimit: before.identity.run.recallLimit,
              resultBudget: before.identity.resultBudget,
            },
            {
              setDigest: info.setDigest,
              passagesDigest: info.passagesDigest,
              recallLimit: info.recallLimit,
              resultBudget,
            }
          ),
        })
  )}\n`
);
if (uncut.length > 0) {
  process.stdout.write(
    `\n${uncut.length} uncut chunks: the Brain no longer cuts as the set does; ranks are not comparable.\n${uncut.map(({ id, source, start }) => `  ${id} (${source}: "${start}…")\n`).join("")}`
  );
}
if (passed) {
  process.stdout.write(`\nResult: ${file}\n`);
} else {
  if (!ok) {
    process.stderr.write(`\n${tailOf(output)}\n`);
  }
  process.stderr.write(
    "The Brain evaluation failed: see its output above. Its result is not kept, so it never becomes the baseline.\n"
  );
}
process.exit(passed ? 0 : 1);

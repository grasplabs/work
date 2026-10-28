/**
 * Stephen's eval in CI (GRA-739): the numbers of a real model's run, for
 * the run by hand (stephen-eval.yml) and the weekly run (stephen-weekly.yml).
 *
 *   node scripts/stephen-eval.ts report <log>     the run's report in <log> as Markdown, to $GITHUB_STEP_SUMMARY when set and to stdout; exits 1 when a hard rule broke or the log holds no report
 *
 * The run itself is the eval's real-model opt-in
 * (apps/core/vite.stephen-model.config.ts), which prints its report as a
 * JSON line, `STEPHEN_MODEL_REPORT {...}`.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { z } from "zod";

const tally = z.object({ cases: z.number(), passed: z.number() });

/** The report, as far as the summary reads it (stephen-harness.ts). */
const reportSchema = z.object({
  identity: z.object({
    suiteVersion: z.string(),
    harnessVersion: z.string(),
    cases: z.number(),
    casesDigest: z.string(),
    model: z.string(),
    provider: z.string(),
    build: z.object({ sha: z.string() }).optional(),
  }),
  passed: z.boolean(),
  hardRules: z.array(
    z.object({ rule: z.string(), broken: z.array(z.string()) })
  ),
  quality: z.object({
    cases: z.number(),
    passed: z.number(),
    rate: z.number(),
    byLanguage: z.object({ en: tally, nl: tally }),
    messy: tally,
    judged: z.number(),
    judgePassed: z.number(),
  }),
  speed: z.object({
    p50Ms: z.number().nullable(),
    p90Ms: z.number().nullable(),
  }),
  cost: z.object({ totalMicros: z.number(), perCaseMicros: z.number() }),
  scores: z.array(
    z.object({
      id: z.string(),
      fails: z.array(z.string()),
      breaks: z.string().optional(),
    })
  ),
  budgetUsd: z.number().optional(),
  spentUsd: z.number().optional(),
});
export type StephenRunReport = z.infer<typeof reportSchema>;

const reportLine = /STEPHEN_MODEL_REPORT (?<json>\{.*\})\s*$/mu;

/** The report a run printed in `log`, if it printed one. */
export const reportIn = (log: string): StephenRunReport | undefined => {
  const json = reportLine.exec(log)?.groups?.json;
  return json === undefined ? undefined : reportSchema.parse(JSON.parse(json));
};

/** Most failing cases the summary lists. */
const listedFails = 20;

const seconds = (ms: number | null): string =>
  ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`;
const share = ({ cases, passed }: z.infer<typeof tally>): string =>
  `${passed} of ${cases}`;
const usd = (value: number): string => `$${value.toFixed(2)}`;

/** The run's numbers, as Markdown for a pull request or a job summary. */
export const summaryOf = (report: StephenRunReport): string => {
  const { identity, quality, speed, cost } = report;
  const broken = report.hardRules.filter(
    ({ broken: cases }) => cases.length > 0
  );
  const fails = report.scores.filter(
    ({ fails: failed, breaks }) => breaks === undefined && failed.length > 0
  );
  const spent = report.spentUsd ?? cost.totalMicros / 1_000_000;
  return [
    `### Stephen's eval against ${identity.model}`,
    "",
    report.passed
      ? "Every hard rule held on every case."
      : `**${broken.length === 1 ? "A hard rule broke" : `${broken.length} hard rules broke`}: fix it before merging.**`,
    "",
    "| Hard rule | Broken in |",
    "| --- | --- |",
    ...report.hardRules.map(
      ({ rule, broken: cases }) =>
        `| ${rule} | ${cases.length === 0 ? "–" : cases.join(", ")} |`
    ),
    "",
    `**Quality:** ${share(quality)} cases pass their checks (${Math.round(quality.rate * 100)}%): English ${share(quality.byLanguage.en)}, Dutch ${share(quality.byLanguage.nl)}, typed messily ${share(quality.messy)}. The judge passed ${quality.judgePassed} of ${quality.judged}.`,
    `**Speed:** p50 ${seconds(speed.p50Ms)}, p90 ${seconds(speed.p90Ms)} a turn.`,
    `**Cost:** ${usd(spent)}${report.budgetUsd === undefined ? "" : ` of a ${usd(report.budgetUsd)} budget`}, ${usd(cost.perCaseMicros / 1_000_000)} a case.`,
    ...(fails.length === 0
      ? []
      : [
          "",
          "<details><summary>Cases that missed a check</summary>",
          "",
          ...fails
            .slice(0, listedFails)
            .map(({ id, fails: failed }) => `- ${id}: ${failed.join("; ")}`),
          ...(fails.length > listedFails
            ? [`- and ${fails.length - listedFails} more`]
            : []),
          "",
          "</details>",
        ]),
    "",
    `<sub>Suite ${identity.suiteVersion}, harness ${identity.harnessVersion}, ${identity.cases} cases (${identity.casesDigest.slice(0, 12)}), ${identity.provider}${identity.build === undefined ? "" : `, commit ${identity.build.sha.slice(0, 12)}`}.</sub>`,
    "",
  ].join("\n");
};

/** Prints the report in `log`; fails when a hard rule broke or there is none. */
const report = (log: string): void => {
  // No log at all: the run never started (its secrets didn't load, say).
  const found = existsSync(log)
    ? reportIn(readFileSync(log, "utf-8"))
    : undefined;
  if (found === undefined) {
    console.error(
      "The run printed no report: it stopped before its cases ran, or never started."
    );
    process.exitCode = 1;
    return;
  }
  const summary = summaryOf(found);
  console.info(summary);
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  if (!found.passed) {
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  const [command, argument] = process.argv.slice(2);
  if (command === "report" && argument !== undefined) {
    report(argument);
  } else {
    console.error("Usage: node scripts/stephen-eval.ts report <log>");
    process.exitCode = 1;
  }
}

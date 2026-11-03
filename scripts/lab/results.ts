/**
 * What a run found, as JSON: one file a run, kept in git for the open set
 * (`scripts/lab/results/`) and in the hidden set's own folder for the
 * hidden one. Every result says which Stephen it measured, by the marks of
 * his text and of the code that makes him speak, write down and draw, and
 * the commit; and how the models were reached: the model of each role,
 * through the local core's gateway. Two results are set side by side only when
 * both say the same (`@grasp-os/shared/lab-compare`). Ported from the prototype
 * (grasplabs/prototype, packages/grasp: lab/results.ts, lab/version.ts).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { meansOf, shown } from "@grasp-os/shared/lab-compare";
import { markOf, resultSchema, scoresOf } from "@grasp-os/shared/lab-runs";
import type { Result, StephenVersion } from "@grasp-os/shared/lab-runs";
import { interviewLocales } from "@grasp-os/shared/onboarding";
import type { InterviewLocale, Interviewer } from "@grasp-os/shared/onboarding";

import { interviewerText } from "../../apps/core/src/onboarding/interviewer-text.ts";
import { stephenVersion as releaseVersion } from "../../apps/core/src/onboarding/lab-marks.ts";
import { allKept, keepJson, scoresFolder, setFolder } from "./kept.ts";
import type { CaseSet } from "./kept.ts";
import { isHidden, repoRoot } from "./keys/index.ts";

/**
 * The code that makes him speak and write down, beside his text: a change
 * to how a turn is asked for or checked changes him as much as his words.
 */
const talkingCode = [
  "apps/core/src/onboarding/interview.ts",
  "packages/shared/src/interview-turn.ts",
];
/** The code that draws a piece of work from what its people agreed to. */
const drawingCode = ["apps/core/src/onboarding/work-drawing.ts"];

const markOfText = (parts: readonly string[]): string =>
  createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 8);

const sourcesOf = (files: readonly string[]): string[] =>
  files.map((file) => readFileSync(path.join(repoRoot, file), "utf-8"));

/** The Stephen (or Claire) that holds the interviews of this checkout. */
export const stephenVersion = async (
  interviewer: Interviewer,
  locale: InterviewLocale
): Promise<StephenVersion> => {
  const [own, lead, everyLanguage] = await Promise.all([
    interviewerText(interviewer, "own", locale),
    interviewerText(interviewer, "lead", locale),
    Promise.all(
      interviewLocales.flatMap((each) => [
        interviewerText(interviewer, "own", each),
        interviewerText(interviewer, "lead", each),
      ])
    ),
  ]);
  let commit = "";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    // Not a git checkout: the marks alone say which Stephen it was.
  }
  return {
    interviewer,
    own: own.mark,
    lead: lead.mark,
    talks: markOfText([
      ...everyLanguage.map((text) => text.mark),
      ...sourcesOf(talkingCode),
    ]),
    draws: markOfText(sourcesOf(drawingCode)),
    version: releaseVersion,
    commit,
  };
};

const idPart = /[^a-z0-9]+/giu;
const stamp = /[-:T]/gu;

/**
 * Keeps a result, and says its id and where. Of a hidden run its scores
 * are kept too, in the repository (`scores/`), so the admin's Stephen Lab
 * can show them: its means and how many cases, never a case.
 */
export const keepResult = (
  result: Omit<Result, "id">
): { result: Result; file: string } => {
  const claire = result.stephen.interviewer === "claire" ? "claire-" : "";
  const id = `${result.at.slice(0, 16).replace(stamp, "")}-${result.bench}-${result.set}-${claire}${result.label.replace(idPart, "-").toLowerCase()}`;
  const kept: Result = { id, ...result };
  const file = keepJson(
    path.join(setFolder("results", result.set), `${id}.json`),
    kept
  );
  if (kept.set === "hidden") {
    keepJson(path.join(scoresFolder, `${id}.json`), scoresOf(kept));
  }
  return { result: kept, file };
};

/** Which set a key is in. */
export const setOf = (key: string): CaseSet =>
  isHidden(key) ? "hidden" : "open";

/** Every result kept, oldest first: the open set's, and with `LAB_HIDDEN` the hidden set's too. */
export const results = (): Result[] => {
  const hidden =
    process.env.LAB_HIDDEN === undefined
      ? []
      : allKept(setFolder("results", "hidden"), resultSchema);
  return [
    ...allKept(setFolder("results", "open"), resultSchema),
    ...hidden,
  ].toSorted((a, b) => a.id.localeCompare(b.id));
};

/**
 * A result by its id, the end of it, or its label; the newest of several
 * with that label. None when there is no such one.
 */
export const resultNamed = (
  all: readonly Result[],
  named: string
): Result | undefined =>
  all.find((each) => each.id === named) ??
  all.findLast((each) => each.id.endsWith(named) || each.label === named);

/** Whether two results measured the same thing the same way: the same bench and set, reached the same way, with the same people. */
export const alike = (a: Result, b: Result): boolean =>
  a.bench === b.bench &&
  a.set === b.set &&
  a.stephen.interviewer === b.stephen.interviewer &&
  a.via.quick === b.via.quick &&
  a.via.careful === b.via.careful &&
  (a.people ?? "") === (b.people ?? "") &&
  (a.seed ?? 0) === (b.seed ?? 0);

/** The runs of the same Stephen as `result`, measured alike: what the noise is measured from. */
export const sameStephen = (all: readonly Result[], result: Result): Result[] =>
  all.filter((each) => alike(each, result) && markOf(each) === markOf(result));

/** A result's means on one line: "right 88%, single 99%, …". */
export const meansLine = (result: Pick<Result, "cases">): string =>
  Object.entries(meansOf(result.cases))
    .map(([metric, value]) => `${metric} ${shown(metric, value)}`)
    .join(", ");

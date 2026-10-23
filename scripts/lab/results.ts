/**
 * What a run found, as JSON: one file a run, kept in git for the open set
 * (`scripts/lab/results/`) and in the hidden set's own folder for a hidden
 * key. Every result says which Stephen it measured, by the mark of his
 * text (core's onboarding/interviewer-text.ts, the same mark every turn
 * keeps) and the commit, and how the models were reached: the local
 * core's AI Gateway and the model of each role. Two results are set side
 * by side only when both say the same. Ported from the prototype
 * (grasplabs/prototype, packages/grasp: lab/results.ts, lab/version.ts).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

import type { LabVia } from "@grasp-os/shared/lab";
import type { InterviewLocale, Interviewer } from "@grasp-os/shared/onboarding";

import { interviewerText } from "../../apps/core/src/onboarding/interviewer-text.ts";
import { folderOf, keepJson } from "./kept.ts";
import { isHidden, repoRoot } from "./keys/index.ts";

/** Which Stephen a result is of: the marks of the texts that held the interviews, and the commit. */
export interface StephenVersion {
  interviewer: Interviewer;
  /** The mark of the text of someone's own interview, and of a lead's. */
  own: string;
  lead: string;
  /** The commit the code was at, when git can say. */
  commit: string;
}

/** The Stephen (or Claire) that holds the interviews of this checkout. */
export const stephenVersion = async (
  interviewer: Interviewer,
  locale: InterviewLocale
): Promise<StephenVersion> => {
  const [own, lead] = await Promise.all([
    interviewerText(interviewer, "own", locale),
    interviewerText(interviewer, "lead", locale),
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
  return { interviewer, own: own.mark, lead: lead.mark, commit };
};

/** One case of a run: an interview, and its numbers. */
export interface CaseScore {
  id: string;
  scores: Record<string, number>;
}

export interface Result {
  id: string;
  at: string;
  label: string;
  /** Whole interviews, played on a practice company. */
  bench: "whole";
  /** The open set, or the hidden one, of which only scores are kept. */
  set: "open" | "hidden";
  key: string;
  practice: string;
  stephen: StephenVersion;
  /** How the models were reached: always the local core's gateway, never anyone's subscription. */
  via: LabVia;
  /** "real" when the people had tempers, with the seed that says who had which; "ideal" when they told all they knew. */
  people: "real" | "ideal" | "person";
  seed?: number;
  cases: CaseScore[];
  spent: string;
}

const idPart = /[^a-z0-9]+/giu;
const stamp = /[-:T]/gu;

/** Keeps a result, and says its id and where. */
export const keepResult = (
  result: Omit<Result, "id">
): { result: Result; file: string } => {
  const id = `${result.at.slice(0, 16).replace(stamp, "")}-whole-${result.set}-${result.label.replace(idPart, "-").toLowerCase()}`;
  const kept: Result = { id, ...result };
  const file = keepJson(
    path.join(folderOf("results", result.key), `${id}.json`),
    kept
  );
  return { result: kept, file };
};

/** Which set a key is in. */
export const setOf = (key: string): Result["set"] =>
  isHidden(key) ? "hidden" : "open";

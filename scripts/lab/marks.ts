/**
 * The marks of the interviewers' texts, as the files say them now, and
 * the file that holds the measured ones (core's onboarding/lab-marks.ts).
 * The climb (climb.ts) runs this as its own process, so it reads the
 * texts as they are on disk after a change, never as its own process
 * first imported them:
 *
 *   node scripts/lab/marks.ts print   the marks and the texts' length, as JSON
 *   node scripts/lab/marks.ts write   lab-marks.ts set to them: a kept change
 *
 * Core speaks any text, and a test holds every mark to lab-marks.ts
 * (apps/core/test/interviewer-text.test.ts): a text changes only through
 * the lab, and its new marks come in with the change the lab kept.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  interviewKinds,
  interviewLocales,
  interviewers,
} from "@grasp-os/shared/onboarding";

/** Where the measured marks are kept. */
export const labMarksFile = path.join(
  import.meta.dirname,
  "../../apps/core/src/onboarding/lab-marks.ts"
);

/** What the texts are now: their marks in lab-marks.ts's order, and how long they are together. */
export interface Marks {
  marks: string[];
  length: number;
}

/** The name of every mark at once, as lab-marks.ts's `stephenVersion` is taken. */
export const versionOf = (marks: readonly string[]): string =>
  createHash("sha256").update(marks.join("\n")).digest("hex").slice(0, 12);

const markPattern = /"[0-9a-f]{64}"/gu;
const versionPattern = /export const stephenVersion = "[0-9a-f]{12}";/u;

/**
 * lab-marks.ts with `marks` in place of the ones it holds, in the order it
 * holds them, and the version taken over them. The file's words are kept.
 */
export const withMarks = (source: string, marks: readonly string[]): string => {
  const held = source.match(markPattern) ?? [];
  if (held.length !== marks.length) {
    throw new Error(
      `lab-marks.ts holds ${held.length} marks, and there are ${marks.length} texts.`
    );
  }
  let at = 0;
  const replaced = source.replaceAll(markPattern, () => {
    const mark = marks[at] ?? "";
    at += 1;
    return `"${mark}"`;
  });
  if (!versionPattern.test(replaced)) {
    throw new Error("lab-marks.ts holds no stephenVersion.");
  }
  return replaced.replace(
    versionPattern,
    `export const stephenVersion = "${versionOf(marks)}";`
  );
};

/** The texts as the files say them now. */
const marksNow = async (): Promise<Marks> => {
  const { interviewerText } =
    await import("../../apps/core/src/onboarding/interviewer-text.ts");
  const texts = await Promise.all(
    interviewers.flatMap((interviewer) =>
      interviewKinds.flatMap((kind) =>
        interviewLocales.map(
          async (locale) => await interviewerText(interviewer, kind, locale)
        )
      )
    )
  );
  return {
    marks: texts.map((text) => text.mark),
    length: texts.reduce((sum, text) => sum + text.text.length, 0),
  };
};

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  const now = await marksNow();
  if (command === "write") {
    writeFileSync(
      labMarksFile,
      withMarks(readFileSync(labMarksFile, "utf-8"), now.marks)
    );
  }
  console.log(JSON.stringify(now));
}

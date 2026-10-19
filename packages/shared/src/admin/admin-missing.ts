import type { WorkRecord } from "./onboarding-admin-record.ts";

/**
 * What one piece of work still lacks before it is known, the way Grasp works through it: a step
 * told two ways that nobody can explain first, since it holds the rest up; then the people who do
 * it and have not talked, the steps too few of them described, the numbers and the parts around
 * the steps nobody gave, and the questions the drawing left for the next interviews. Pure.
 */
export type Missing =
  | { kind: "difference"; step: number; text: string }
  | { kind: "people"; count: number }
  | { kind: "step"; step: number; text: string; people: number; needed: number }
  /** More steps than fit a list that too few people described: how many, of how many, and how many people a step needs. */
  | { kind: "steps"; count: number; of: number; needed: number }
  | { kind: "number"; which: "volume" | "takes" | "wrong" }
  | { kind: "around"; which: "starts" | "right" | "next" }
  | { kind: "question"; text: string };

/** How many steps short of people are named one by one. */
const MOST_STEPS = 3;

export const missingOf = (
  record: WorkRecord,
  questions: string[] = []
): Missing[] => {
  const talked = record.interviews.length;
  const missing: Missing[] = [];
  for (const [index, step] of record.steps.entries()) {
    if (step.other && !step.other.explained) {
      missing.push({ kind: "difference", step: index, text: step.text });
    }
  }
  if (record.toAsk > 0) {
    missing.push({ kind: "people", count: record.toAsk });
  }
  // Before anyone who does it has talked, nothing counts yet: what there is to ask is everything.
  if (talked > 0) {
    const short = record.steps.flatMap((step, index) =>
      step.enough ? [] : [{ step, index }]
    );
    // A few are named one by one; when most of them are short, it is one thing: more people have to talk.
    if (short.length > MOST_STEPS) {
      missing.push({
        kind: "steps",
        count: short.length,
        of: record.steps.length,
        needed: record.needed,
      });
    } else {
      for (const { step, index } of short) {
        missing.push({
          kind: "step",
          step: index,
          text: step.text,
          people: step.people,
          needed: record.needed,
        });
      }
    }
    if (!record.volume) {
      missing.push({ kind: "number", which: "volume" });
    }
    if (!record.takes) {
      missing.push({ kind: "number", which: "takes" });
    }
    if (!record.wrong) {
      missing.push({ kind: "number", which: "wrong" });
    }
    if (record.starts.people === 0) {
      missing.push({ kind: "around", which: "starts" });
    }
    if (record.right.people === 0) {
      missing.push({ kind: "around", which: "right" });
    }
    if (record.next.people === 0) {
      missing.push({ kind: "around", which: "next" });
    }
  }
  for (const text of questions) {
    missing.push({ kind: "question", text });
  }
  return missing;
};

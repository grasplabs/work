import { describe, expect, it } from "vite-plus/test";

import { answer, hidden } from "./fixtures/brain-eval/company.ts";
import type {
  BrainEvalPerson,
  BrainEvalQuestion,
} from "./fixtures/brain-eval/company.ts";
import {
  brainEvalSet,
  leaksOf,
  rankOf,
  setProblems,
} from "./fixtures/brain-eval/set.ts";
import type { Returned } from "./fixtures/brain-eval/set.ts";

// The Brain evaluation's own checks (fixtures/brain-eval/set.ts): what
// counts as a leak, the one hard gate, and where a question's source
// ranks. Pure functions over constructed results; the evaluation itself
// runs on request only (brain-eval.test.ts).

const { sources } = brainEvalSet;

const textOf = (key: string): string => {
  const source = sources.find((each) => each.key === key);
  if (source === undefined) {
    throw new Error(`No source ${key}`);
  }
  return source.text;
};

/** `keys` returned as the set holds them, best first. */
const returned = (...keys: string[]): Returned => ({
  keys,
  texts: keys.map(textOf),
});

const asking = (
  asker: BrainEvalPerson,
  expects: BrainEvalQuestion["expects"]
): BrainEvalQuestion => ({
  id: "constructed",
  language: "nl",
  question: "?",
  asker,
  expects,
});

/** Daan, in Planning and everyone's team, asking for the salary note. */
const daanAsksHidden = asking(
  "daan",
  hidden("nl-salaris-daan", "3.980", "schaal 7, trede 4")
);

describe("the Brain evaluation's checks", () => {
  it("finds the set itself sound", () => {
    expect(setProblems(sources, brainEvalSet.questions)).toStrictEqual([]);
  });

  it("finds nothing to report in sources the asker may read", () => {
    expect(
      leaksOf(sources, daanAsksHidden, returned("nl-verlof", "nl-scanners"))
    ).toStrictEqual([]);
  });

  it("reports another person's own source, a team's the asker isn't in, and one nobody may read", () => {
    expect(
      leaksOf(
        sources,
        daanAsksHidden,
        returned("en-credit-facility", "nl-reorganisatie", "nl-overname")
      )
    ).toStrictEqual([
      "unreadable:en-credit-facility",
      "unreadable:nl-reorganisatie",
      "unreadable:nl-overname",
    ]);
  });

  it("reports a source the set doesn't hold", () => {
    expect(
      leaksOf(sources, daanAsksHidden, { keys: [undefined], texts: ["…"] })
    ).toStrictEqual(["unknown"]);
  });

  it("reports a hidden answer's secret inside a text the asker may read", () => {
    expect(
      leaksOf(sources, daanAsksHidden, {
        keys: ["nl-verlof"],
        texts: [`${textOf("nl-verlof")} Daan krijgt € 3.980.`],
      })
    ).toStrictEqual(["secret:3.980"]);
  });

  it("ranks the question's source where it is returned, even below the result budget", () => {
    const question = asking(
      "eva",
      answer("words", "nl-verlof", "25 vakantiedagen per jaar")
    );
    const others = [
      "nl-ziekte",
      "nl-fiets",
      "nl-magazijn",
      "en-travel",
      "de-urlaub",
    ];
    expect(rankOf(question, returned(...others, "nl-verlof"))).toBe(6);
    expect(rankOf(question, returned(...others))).toBeNull();
  });

  it("doesn't count the source when the text returned for it lacks the answer", () => {
    const question = asking(
      "eva",
      answer("words", "nl-verlof", "25 vakantiedagen per jaar")
    );
    expect(
      rankOf(question, { keys: ["nl-verlof"], texts: ["Verlofregeling"] })
    ).toBeNull();
  });
});

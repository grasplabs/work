/**
 * Contradictions surfaced (GRA-1422): where people of one key disagree,
 * did Stephen write down both versions? A key plants a contradiction
 * wherever someone believes an older version of a fact (`beliefs`) that a
 * colleague knows as it is. Each interview only hears its own person, so
 * the test is across interviews: the version of someone who believes it
 * in that person's notes, and the version of someone who knows it in
 * theirs, neither put right to the other.
 *
 * Pure: the judge already says, interview by interview, which facts of
 * the person's own slice (in their own version) are in Stephen's notes
 * (judge.ts); this only puts those together. When one person says both
 * versions, that is the "two versions" moment, held to its own rule.
 */
import type { Judged } from "./card.ts";
import { factText } from "./keys/types.ts";
import type { AnswerKey } from "./keys/types.ts";

/** A fact people disagree on: what it is, what some believe instead, and who holds which. */
export interface Contradiction {
  fact: string;
  /** The fact as it is. */
  truth: string;
  /** Who knows it as it is, by employee id. */
  knowers: string[];
  /** What each one who believes otherwise believes, by employee id. */
  believers: Record<string, string>;
}

/** The contradictions a key plants: each fact that some of its people know and others believe otherwise. */
export const contradictionsIn = (key: AnswerKey): Contradiction[] =>
  key.facts.flatMap((fact): Contradiction[] => {
    const holders = key.employees.filter((employee) =>
      employee.knows.includes(fact.id)
    );
    const believers = Object.fromEntries(
      holders.flatMap((employee) => {
        const belief = employee.beliefs?.[fact.id];
        return belief === undefined ? [] : [[employee.id, belief]];
      })
    );
    const knowers = holders
      .filter((employee) => employee.beliefs?.[fact.id] === undefined)
      .map(({ id }) => id);
    return knowers.length > 0 && Object.keys(believers).length > 0
      ? [{ fact: fact.id, truth: factText(fact), knowers, believers }]
      : [];
  });

/** One interview that was judged: whose, and what the judge found. */
export interface JudgedOf {
  employee: string;
  judged: Judged;
}

/** The score line: of the contradictions both sides of which were interviewed, how many have both versions in his notes. */
export interface Surfaced {
  count: number;
  of: number;
  /** The facts whose versions were not both written, with what is missing. */
  open: { fact: string; missing: "the belief" | "the truth" | "both" }[];
}

/** Whether, in someone's interview, Stephen wrote down their version of `fact`. */
const wroteDown = (each: JudgedOf, fact: string): boolean =>
  each.judged.known.some(
    (known) => known.id === fact && known.written.length > 0
  );

/**
 * Contradictions surfaced over a practice company's judged interviews.
 * One counts only where someone on each side was interviewed; it is
 * surfaced when some believer's version is in their notes and some
 * knower's version in theirs.
 */
export const surfacedOf = (
  contradictions: readonly Contradiction[],
  interviews: readonly JudgedOf[]
): Surfaced => {
  const asked = contradictions.flatMap((contradiction) => {
    const believers = interviews.filter(
      ({ employee }) => contradiction.believers[employee] !== undefined
    );
    const knowers = interviews.filter(({ employee }) =>
      contradiction.knowers.includes(employee)
    );
    return believers.length > 0 && knowers.length > 0
      ? [{ contradiction, believers, knowers }]
      : [];
  });
  const open = asked.flatMap(({ contradiction, believers, knowers }) => {
    const belief = believers.some((each) =>
      wroteDown(each, contradiction.fact)
    );
    const truth = knowers.some((each) => wroteDown(each, contradiction.fact));
    if (belief && truth) {
      return [];
    }
    let missing: Surfaced["open"][number]["missing"] = "both";
    if (belief) {
      missing = "the truth";
    } else if (truth) {
      missing = "the belief";
    }
    return [{ fact: contradiction.fact, missing }];
  });
  return { count: asked.length - open.length, of: asked.length, open };
};

/** The score line in words, for the report. */
export const surfacedLine = ({ count, of }: Surfaced): string =>
  of === 0
    ? "Contradictions surfaced: none of the key's people who disagree were both interviewed."
    : `Contradictions surfaced: both versions in his notes for ${count} of ${of}.`;

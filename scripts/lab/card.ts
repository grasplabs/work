/**
 * The score card of one interview: what Stephen got the person to say,
 * what he wrote of it, whether what he wrote rests on what was said, how
 * he asked, and what it cost the person; and, with someone who has a
 * temper (people.ts), how he dealt with what they did and with what they
 * said that was not so, and whether they stayed to the end. Each line has
 * one owner: the model that says his line, or the one that writes down.
 * Pure: the judgments come in (judge.ts), the sums are made here. Ported
 * from the prototype (grasplabs/prototype, packages/grasp: lab/card.ts).
 */
import type { InterviewFact } from "@grasp-os/shared/interview-links";
import { mistakesIn } from "@grasp-os/shared/interview-turn";

import type { SliceFact } from "./keys/types.ts";
import type { Said } from "./person.ts";

/** What the judge found, fact by fact. */
export interface Judged {
  /** Each fact the person knows: whether they said it, and the written facts that hold it, by id. */
  known: { id: string; said: boolean; written: string[] }[];
  /** Each fact Stephen wrote down: the person said it, it repeats an earlier written fact, or nobody said it. */
  written: { id: string; verdict: "said" | "repeat" | "not said" }[];
}

export interface ScoreCard {
  /** Of what the person knew, what Stephen got them to say. Owner: the one who says his line. */
  heard: { count: number; of: number; missed: string[] };
  /** Of what was said, what is in his notes. Owner: the one who writes down. */
  written: { count: number; of: number; lost: string[] };
  /** Of what he wrote, what rests on the person's words; repeats and what nobody said apart. Owner: the one who writes down. */
  supported: { count: number; repeats: number; notSaid: string[]; of: number };
  /** How he asked, by his own rules. Owner: the one who says his line. */
  manner: {
    lines: number;
    twoQuestions: number;
    longQuestions: number;
    praise: number;
    thanks: number;
    sameStart: number;
    wordsPerLine: number;
  };
  /** What it cost the person. */
  burden: {
    answers: number;
    minutes: number | null;
    stephenShare: number;
    takenOut: number;
    addedInReadBack: number;
  };
  /** Where a model played the person: how often the judge and the person agree on what was said. */
  judgeAgrees: { count: number; of: number } | null;
}

const words = (text: string): number =>
  text.trim().split(/\s+/u).filter(Boolean).length;

const thanksPattern =
  /\b(?:thanks|thank you|dank je|dank u|bedankt|danke|merci|gracias)\b/iu;

const median = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const sentenceEnd = /(?<=[.?!…])\s+/u;
const notLetters = /[^\p{L}\s]/gu;

/** The small sentence a line opens with, before its question ("Thanks." "Got it."): none when the line is one sentence. */
const openerOf = (line: string): string => {
  const sentences = line.trim().split(sentenceEnd).filter(Boolean);
  return sentences.length > 1
    ? (sentences[0] ?? "").toLowerCase().replace(notLetters, "").trim()
    : "";
};

/** How Stephen asked, from his lines alone. */
export const mannerOf = (lines: Said[]): ScoreCard["manner"] => {
  const his = lines
    .filter((line) => line.from === "stephen")
    .map((line) => line.text);
  const mistakes = his.map((line) => mistakesIn(line));
  return {
    lines: his.length,
    twoQuestions: mistakes.filter((found) => found.includes("two questions"))
      .length,
    longQuestions: mistakes.filter((found) => found.includes("long question"))
      .length,
    praise: mistakes.filter((found) => found.includes("praise or filler"))
      .length,
    thanks: his.filter((line) => thanksPattern.test(line)).length,
    // The same small sentence first as in the line before: a habit, not an answer to what was said.
    sameStart: his.filter(
      (line, at) =>
        at > 0 &&
        openerOf(line) !== "" &&
        openerOf(line) === openerOf(his[at - 1] ?? "")
    ).length,
    wordsPerLine: median(his.map(words)),
  };
};

/** What the interview cost the person. `minutes` is none when its start or end is not known. */
export const burdenOf = (
  lines: Said[],
  facts: InterviewFact[],
  minutes: number | null
): ScoreCard["burden"] => {
  const wordsOf = (from: Said["from"]) =>
    lines
      .filter((line) => line.from === from)
      .reduce((sum, line) => sum + words(line.text), 0);
  const his = wordsOf("stephen");
  const theirs = wordsOf("person");
  return {
    answers: lines.filter((line) => line.from === "person").length,
    minutes,
    stephenShare: his + theirs === 0 ? 0 : his / (his + theirs),
    takenOut: facts.filter((fact) => fact.out === true).length,
    addedInReadBack: facts.filter(
      (fact) => fact.pin !== undefined && fact.out !== true
    ).length,
  };
};

/**
 * The card of one interview. `selfSaid` is what a person played by a model
 * said they said, by fact id: it does not change the card, it only shows
 * how far the judge can be trusted.
 */
export const scoreCardOf = ({
  slice,
  lines,
  facts,
  minutes,
  judged,
  selfSaid,
}: {
  slice: SliceFact[];
  lines: Said[];
  facts: InterviewFact[];
  minutes: number | null;
  judged: Judged;
  selfSaid?: string[];
}): ScoreCard => {
  const known = slice.map((fact) => ({
    fact,
    found: judged.known.find((each) => each.id === fact.id),
  }));
  const written = facts.filter((fact) => fact.out !== true);
  const kept = new Set(written.map((fact) => fact.id));
  const said = known.filter((each) => each.found?.said === true);
  const inNotes = said.filter(
    (each) => each.found?.written.some((id) => kept.has(id)) === true
  );
  const verdictOf = (id: string) =>
    judged.written.find((each) => each.id === id)?.verdict;
  const self = selfSaid === undefined ? null : new Set(selfSaid);
  return {
    heard: {
      count: said.length,
      of: slice.length,
      missed: known
        .filter((each) => each.found?.said !== true)
        .map((each) => each.fact.id),
    },
    written: {
      count: inNotes.length,
      of: said.length,
      lost: said
        .filter((each) => !inNotes.includes(each))
        .map((each) => each.fact.id),
    },
    supported: {
      count: written.filter((fact) => verdictOf(fact.id) === "said").length,
      repeats: written.filter((fact) => verdictOf(fact.id) === "repeat").length,
      notSaid: written
        .filter((fact) => verdictOf(fact.id) === "not said")
        .map((fact) => fact.record),
      of: written.length,
    },
    manner: mannerOf(lines),
    burden: burdenOf(lines, facts, minutes),
    judgeAgrees:
      self === null
        ? null
        : {
            count: known.filter(
              (each) => (each.found?.said === true) === self.has(each.fact.id)
            ).length,
            of: slice.length,
          },
  };
};

/** A hard turn of a played interview: what the person did, what he said next, and whether that was the right line for it. */
export interface HardTurn {
  move: string;
  said: string;
  line: string;
  right: boolean;
  why: string;
}

/** What one thing they said that was not so became in his notes. */
export interface Untrue {
  claim: string;
  verdict: "fact" | "marked" | "absent";
}

/** What an interview with someone who has a temper adds to the card. */
export interface RealCard {
  temper: string;
  /** Each thing they did beside answering, his next line, and whether that was the right line for it. */
  hard: HardTurn[];
  /** What they said that was not so, and what became of it in his notes: written as a fact, marked as a guess or the procedure, or not written. */
  untrue: Untrue[];
  /** Answers that were no answer at all. */
  wasted: number;
  /** They went away before the read-back: nothing was agreed to. */
  left: boolean;
}

/** The numbers of a `RealCard` for a result: a share only where there was something to count. */
export const realScores = (real: RealCard): Record<string, number> => ({
  ...(real.hard.length > 0
    ? {
        handled:
          real.hard.filter((each) => each.right).length / real.hard.length,
      }
    : {}),
  ...(real.untrue.length > 0
    ? {
        taken:
          real.untrue.filter((each) => each.verdict === "fact").length /
          real.untrue.length,
      }
    : {}),
  wasted: real.wasted,
  agreed: real.left ? 0 : 1,
});

const share = (count: number, of: number): string =>
  of === 0 ? "–" : `${Math.round((100 * count) / of)}%`;

/** A card on one line, for a table: person, heard, written, supported, repeats, not said, his share of the words, answers, minutes. */
export const cardRow = (name: string, card: ScoreCard): string[] => [
  name,
  `${share(card.heard.count, card.heard.of)} (${card.heard.count}/${card.heard.of})`,
  `${share(card.written.count, card.written.of)} (${card.written.count}/${card.written.of})`,
  `${share(card.supported.count, card.supported.of)} (${card.supported.count}/${card.supported.of})`,
  String(card.supported.repeats),
  String(card.supported.notSaid.length),
  share(Math.round(card.burden.stephenShare * 100), 100),
  String(card.burden.answers),
  card.burden.minutes === null ? "–" : card.burden.minutes.toFixed(0),
];

export const cardColumns = [
  "Person",
  "Heard",
  "Written",
  "Supported",
  "Repeats",
  "Not said",
  "Stephen's words",
  "Answers",
  "Minutes",
];

/** Several cards as one: the counts added up. */
export const totalOf = (
  cards: ScoreCard[]
): Pick<ScoreCard, "heard" | "written" | "supported"> => {
  const sum = (pick: (card: ScoreCard) => number) =>
    cards.reduce((total, card) => total + pick(card), 0);
  return {
    heard: {
      count: sum((card) => card.heard.count),
      of: sum((card) => card.heard.of),
      missed: cards.flatMap((card) => card.heard.missed),
    },
    written: {
      count: sum((card) => card.written.count),
      of: sum((card) => card.written.of),
      lost: cards.flatMap((card) => card.written.lost),
    },
    supported: {
      count: sum((card) => card.supported.count),
      repeats: sum((card) => card.supported.repeats),
      notSaid: cards.flatMap((card) => card.supported.notSaid),
      of: sum((card) => card.supported.of),
    },
  };
};

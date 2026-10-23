/**
 * The score card of one interview (card.ts): the sums made from what the
 * judge found, how Stephen asked by his own rules, and what an interview
 * with someone who has a temper adds. The judgments come in as data here.
 */
import type { InterviewFact } from "@grasp-os/shared/interview-links";
import { describe, expect, it } from "vite-plus/test";

import {
  burdenOf,
  cardRow,
  mannerOf,
  realScores,
  scoreCardOf,
  totalOf,
} from "./card.ts";
import type { Judged, RealCard } from "./card.ts";
import type { SliceFact } from "./keys/types.ts";
import type { Said } from "./person.ts";

const known = (id: string): SliceFact => ({
  id,
  type: "step",
  text: id,
  outdated: false,
  next: [],
  options: [],
  after: null,
  toldWhen: null,
});

const fact = (
  id: string,
  more: Partial<InterviewFact> = {}
): InterviewFact => ({
  id,
  tag: "step",
  text: id,
  record: `Record of ${id}.`,
  ...more,
});

const line = (from: Said["from"], text: string): Said => ({ from, text });

describe("the score card of one interview", () => {
  const slice = ["S1", "S2", "S3", "S4"].map(known);
  const facts = [
    fact("f1"),
    fact("f2"),
    fact("f3"),
    fact("f4", { out: true }),
    fact("f5", { pin: 0 }),
  ];
  const judged: Judged = {
    known: [
      { id: "S1", said: true, written: ["f1"] },
      { id: "S2", said: true, written: [] },
      // Held only by a line the person took out again: that is not in the notes.
      { id: "S3", said: true, written: ["f4"] },
      { id: "S4", said: false, written: [] },
    ],
    written: [
      { id: "f1", verdict: "said" },
      { id: "f2", verdict: "repeat" },
      { id: "f3", verdict: "not said" },
      { id: "f5", verdict: "said" },
    ],
  };
  const lines = [
    line("stephen", "When was the last one?"),
    line("person", "This morning, I think."),
  ];
  const card = scoreCardOf({
    slice,
    lines,
    facts,
    minutes: 12,
    judged,
    selfSaid: ["S1", "S2", "S4"],
  });

  it("counts what was said, what of that was written, and what the notes rest on", () => {
    expect({
      heard: card.heard,
      written: card.written,
      supported: card.supported,
    }).toStrictEqual({
      heard: { count: 3, of: 4, missed: ["S4"] },
      written: { count: 1, of: 3, lost: ["S2", "S3"] },
      supported: { count: 2, repeats: 1, notSaid: ["Record of f3."], of: 4 },
    });
  });

  it("says how far the judge and a person played by a model agree", () => {
    // They differ on S3 (the judge heard it) and on S4 (the model says it said it).
    expect({
      played: card.judgeAgrees,
      byPerson: scoreCardOf({ slice, lines, facts, minutes: null, judged })
        .judgeAgrees,
    }).toStrictEqual({ played: { count: 2, of: 4 }, byPerson: null });
  });

  it("adds cards up, and fits on a line", () => {
    expect({
      total: totalOf([card, card]).heard,
      row: cardRow("Eva", card),
    }).toStrictEqual({
      total: { count: 6, of: 8, missed: ["S4", "S4"] },
      row: [
        "Eva",
        "75% (3/4)",
        "33% (1/3)",
        "50% (2/4)",
        "1",
        "1",
        "56%",
        "1",
        "12",
      ],
    });
  });
});

describe("how he asked and what it cost", () => {
  const lines = [
    line("stephen", "Thanks. When was the last one?"),
    line("person", "This morning."),
    line(
      "stephen",
      "Thanks. What did you do first, and where do you keep the list of all the open ones now?"
    ),
    line("person", "I open the mail."),
    line("stephen", "Then?"),
  ];

  it("counts his habits and what breaks his rules", () => {
    expect(mannerOf(lines)).toMatchObject({
      lines: 3,
      thanks: 2,
      sameStart: 1,
      longQuestions: 1,
      twoQuestions: 0,
    });
  });

  it("counts answers, his share of the words and what the read-back changed", () => {
    const burden = burdenOf(
      lines,
      [fact("f1"), fact("f2", { out: true }), fact("f3", { pin: 1 })],
      null
    );
    expect({
      ...burden,
      stephenShare: Math.round(burden.stephenShare * 1000),
    }).toStrictEqual({
      answers: 2,
      minutes: null,
      takenOut: 1,
      addedInReadBack: 1,
      stephenShare: Math.round((26 / 32) * 1000),
    });
  });
});

const turn = (right: boolean) => ({
  move: "not an answer",
  said: "asdf",
  line: "What did you do first?",
  right,
  why: "",
});

describe("an interview with someone who has a temper", () => {
  const real: RealCard = {
    temper: "joker",
    hard: [turn(true), turn(false), turn(false), turn(true)],
    untrue: [
      { claim: "about 100 a week (a guess)", verdict: "fact" },
      { claim: "two people sign off (the procedure)", verdict: "marked" },
      { claim: "(no answer at all) asdf", verdict: "absent" },
      { claim: "a week (a guess)", verdict: "fact" },
    ],
    wasted: 3,
    left: false,
  };

  it("counts the right lines after hard turns, and what was not so and is in his notes as a fact", () => {
    expect(realScores(real)).toStrictEqual({
      handled: 0.5,
      taken: 0.5,
      wasted: 3,
      agreed: 1,
    });
  });

  it("gives no share where there was nothing to count, and says when nothing was agreed to", () => {
    expect(
      realScores({ ...real, hard: [], untrue: [], wasted: 0, left: true })
    ).toStrictEqual({ wasted: 0, agreed: 0 });
  });
});

/**
 * People as they are (people.ts): who has which temper, and what each does
 * on which answer, decided by code and a seed so two runs of one practice
 * company meet the same people. No model here: only what they are told to
 * do is played.
 */
import type { InterviewPhase } from "@grasp-os/shared/interview-turn";
import { describe, expect, it } from "vite-plus/test";

import type { SliceFact } from "./keys/types.ts";
import type { Move } from "./moves.ts";
import {
  directionOf,
  freshMind,
  guessesFor,
  listensFor,
  mindAfter,
  rollOf,
  tempers,
  tempersFor,
} from "./people.ts";
import type { Mind, Temper } from "./people.ts";

interface Playing {
  heard?: (mind: Mind) => boolean;
  phase?: (nth: number) => InterviewPhase;
  roll?: (nth: number) => number;
}

/** Plays `answers` answers of one temper, with what Stephen is taken to have said each time, and gives back what they did. */
const played = (
  temper: Temper,
  answers: number,
  { heard = () => false, phase = () => "steps", roll = () => 0.9 }: Playing = {}
) => {
  let mind = freshMind(temper);
  const did: (Move | null)[] = [];
  let left = false;
  for (let nth = 1; nth <= answers && !left; nth += 1) {
    const direction = directionOf(temper, mind, {
      phase: phase(nth),
      roll: roll(nth),
      heard: heard(mind),
    });
    did.push(direction.move);
    left = direction.leaves === true;
    mind = mindAfter(mind, direction, direction.move);
  }
  return { moves: did, mind, left };
};

const always = () => true;

describe("who has which temper", () => {
  it("is the same for the same seed, and another mix for another", () => {
    expect({
      first: tempersFor(5, 1),
      again: tempersFor(5, 1),
      otherSeed: tempersFor(5, 2),
      everyOne: new Set(tempersFor(8, 1)),
    }).toStrictEqual({
      first: ["joker", "guesser", "official", "short", "wary"],
      again: ["joker", "guesser", "official", "short", "wary"],
      otherSeed: ["short", "wary", "rambler", "rushed", "plain"],
      everyOne: new Set(tempers),
    });
  });

  it("rolls the same chance for the same place, and about three short answers in ten", () => {
    const rolls = Array.from({ length: 200 }, (_, at) => rollOf("seed", at));
    const short = rolls.filter((roll) => roll < 0.29).length;
    expect({
      same: [3, 3]
        .map((at) => rollOf("01:P1:1", at))
        .every((roll, _, all) => roll === all[0]),
      other: rollOf("01:P1:1", 3) === rollOf("01:P1:1", 4),
      inRange: rolls.every((roll) => roll >= 0 && roll < 1),
      aboutThreeInTen: short > 40 && short < 80,
    }).toStrictEqual({
      same: true,
      other: false,
      inRange: true,
      aboutThreeInTen: true,
    });
  });
});

const number = (id: string, remembered: string): SliceFact => ({
  id,
  type: "number",
  text: id,
  outdated: false,
  remembered,
  next: [],
  options: [],
  after: null,
  toldWhen: null,
});

describe("what a guesser does not know", () => {
  const slice = [
    number("N1", "about 40"),
    number("N2", "two days or so"),
    number("N3", "3 in 10"),
    number("N4", "around 15"),
    number("N5", "1"),
  ];

  it("is three numbers at most, each far from what they remember, the same every time", () => {
    const guesses = guessesFor(slice, "Robin", "seed");
    const off = Object.entries(guesses).every(([id, guess]) => {
      const truth = slice.find((fact) => fact.id === id)?.remembered ?? "";
      return !truth.includes(guess.says);
    });
    expect({
      count: Object.keys(guesses).length,
      off,
      who: new Set(Object.values(guesses).map((guess) => guess.who)),
      again: guessesFor(slice, "Robin", "seed"),
    }).toStrictEqual({
      count: 3,
      off: true,
      who: new Set(["Robin would know"]),
      again: guesses,
    });
  });

  it("leaves a number without an amount alone", () => {
    expect(
      guessesFor([number("N2", "two days or so")], "Robin", "seed")
    ).toStrictEqual({});
  });
});

describe("a joker", () => {
  it("fools around until told plainly, and wastes the interview when nobody does", () => {
    const { moves: did, mind } = played("joker", 9);
    expect({ did, stage: mind.stage, wasted: mind.wasted }).toStrictEqual({
      did: [
        null,
        "not an answer",
        "not an answer",
        "not an answer",
        "few words",
        "not an answer",
        "few words",
        "few words",
        "not an answer",
      ],
      stage: "fooling",
      wasted: 5,
    });
  });

  it("gets serious at once when told plainly, or tries once more", () => {
    const atOnce = played("joker", 5, { heard: always, roll: () => 0.9 });
    const once = played("joker", 5, { heard: always, roll: () => 0.1 });
    expect({
      atOnce: [atOnce.moves, atOnce.mind.stage],
      once: [once.moves, once.mind.stage, once.mind.wasted],
    }).toStrictEqual({
      atOnce: [[null, "not an answer", null, null, null], "serious"],
      once: [
        [null, "not an answer", "not an answer again", null, null],
        "serious",
        2,
      ],
    });
  });

  it("listens for a plain word only after nonsense", () => {
    expect([
      listensFor("joker", freshMind("joker")),
      listensFor("joker", { ...freshMind("joker"), last: "not an answer" }),
      listensFor("joker", {
        ...freshMind("joker"),
        stage: "serious",
        last: "not an answer",
      }),
    ]).toStrictEqual([null, "plain word", null]);
  });
});

describe("someone wary", () => {
  it("asks what it is for, and opens up on a straight answer", () => {
    const { moves: did, mind } = played("wary", 4, { heard: always });
    expect({ did, stage: mind.stage }).toStrictEqual({
      did: [null, "why do you ask", null, null],
      stage: "open",
    });
  });

  it("stays guarded without one, and asks once more", () => {
    const { moves: did, mind } = played("wary", 8);
    expect({
      did,
      stage: mind.stage,
      listens: listensFor("wary", {
        ...freshMind("wary"),
        last: "why do you ask",
      }),
    }).toStrictEqual({
      did: [
        null,
        "why do you ask",
        null,
        null,
        null,
        "why do you ask",
        null,
        null,
      ],
      stage: "guarded",
      listens: "purpose",
    });
  });
});

describe("the others", () => {
  it("someone rushed says so, and goes", () => {
    const { moves: did, left } = played("rushed", 20);
    expect({ did, left }).toStrictEqual({
      did: [
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "wrap up",
        "wrap up",
        "wrap up",
        null,
      ],
      left: true,
    });
  });

  it("someone short asks where to start once, and gives a few words twice", () => {
    const { moves: did } = played("short", 10, {
      phase: (nth) => (nth === 3 || nth === 4 ? "story" : "steps"),
    });
    expect(did).toStrictEqual([
      null,
      null,
      "where to start",
      null,
      "few words",
      null,
      null,
      null,
      "few words",
      null,
    ]);
  });

  it("someone official tells the procedure for their story, and once more later", () => {
    const { moves: did } = played("official", 9, {
      phase: (nth) => (nth === 3 ? "story" : "steps"),
    });
    expect({
      times: did.filter((move) => move === "the official way").length,
      third: did[2],
    }).toStrictEqual({ times: 2, third: "the official way" });
  });

  it("a rambler floods once the steps are asked for, wanders off, and says what a colleague does", () => {
    const { moves: did } = played("rambler", 9);
    expect({
      first: did[0],
      floods: did.filter((move) => move === "flood").length,
      detours: did.includes("detour"),
      secondHand: did.includes("second hand"),
    }).toStrictEqual({
      first: "flood",
      floods: 1,
      detours: true,
      secondHand: true,
    });
  });

  it("a guesser contradicts a number once", () => {
    expect(
      played("guesser", 12).moves.filter((move) => move === "two versions")
    ).toHaveLength(1);
  });
});

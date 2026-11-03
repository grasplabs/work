/**
 * People v2's state (drift.ts): the mix, each drift rule, and the repeat
 * check, decided by code and a seed. No model here.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  drawTemper,
  drift,
  driftRules,
  freshState,
  isRepeated,
  mixesFor,
  nothingHappened,
  talkMinutes,
  tempersOf,
  turnedOf,
} from "./drift.ts";
import type { State, TemperMix } from "./drift.ts";
import { rollOf, tempers, tempersFor } from "./people.ts";
import type { Said } from "./person.ts";
import { secondsOf } from "./play.ts";

const steady: State = { patience: 0.8, trust: 0.5, energy: 0.8, focus: 0.8 };
const plain: TemperMix = { plain: 1 };
const line = (from: Said["from"], text: string): Said => ({ from, text });

describe("a temper mix", () => {
  it("draws each answer's temper from the mix, by its weights", () => {
    const mix: TemperMix = { official: 0.6, rushed: 0.4 };
    expect(drawTemper(mix, 0.1)).toBe("official");
    expect(drawTemper(mix, 0.59)).toBe("official");
    expect(drawTemper(mix, 0.61)).toBe("rushed");
    const drawn = Array.from({ length: 400 }, (_, at) =>
      drawTemper(mix, rollOf("mix", at))
    );
    const share =
      drawn.filter((temper) => temper === "official").length / drawn.length;
    expect(share).toBeGreaterThan(0.5);
    expect(share).toBeLessThan(0.7);
  });

  it("is the same for the same seed, keeps the v1 temper first, and adds up to one", () => {
    expect(mixesFor(8, 1)).toStrictEqual(mixesFor(8, 1));
    expect(mixesFor(8, 2)).not.toStrictEqual(mixesFor(8, 1));
    const mixes = mixesFor(8, 1);
    const first = tempersFor(8, 1);
    for (const [at, mix] of mixes.entries()) {
      const weights = Object.values(mix);
      expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(
        1,
        5
      );
      expect(tempersOf(mix)[0]).toBe(first[at]);
    }
    // Some people are one temper only, most have a second one beside it.
    expect(mixes.some((mix) => Object.keys(mix).length === 1)).toBeTruthy();
    expect(mixes.some((mix) => Object.keys(mix).length === 2)).toBeTruthy();
    for (const mix of mixes) {
      for (const temper of Object.keys(mix)) {
        expect(tempers).toContain(temper);
      }
    }
  });

  it("starts guarded, impatient or wandering by the mix, the same every run", () => {
    expect(freshState({ wary: 1 }, "s").trust).toBeLessThan(
      freshState(plain, "s").trust
    );
    expect(freshState({ rushed: 1 }, "s").patience).toBeLessThan(
      freshState(plain, "s").patience
    );
    expect(freshState({ rambler: 1 }, "s").focus).toBeLessThan(
      freshState(plain, "s").focus
    );
    expect(freshState(plain, "s")).toStrictEqual(freshState(plain, "s"));
  });
});

describe("the drift rules", () => {
  const once = drift(steady, plain, nothingHappened, 0);

  it("a question asked again costs patience", () => {
    const again = drift(
      steady,
      plain,
      { ...nothingHappened, repeated: true },
      0
    );
    expect(once.patience - again.patience).toBeCloseTo(driftRules.repeated, 5);
  });

  it("minutes past ten cost energy, and only the new ones", () => {
    expect(
      drift(steady, plain, { ...nothingHappened, minutes: 9 }, 8).energy
    ).toBe(steady.energy);
    expect(
      drift(steady, plain, { ...nothingHappened, minutes: 14 }, 12).energy
    ).toBeCloseTo(steady.energy - 2 * driftRules.perMinutePastTen, 5);
    expect(
      drift(steady, plain, { ...nothingHappened, minutes: 12 }, 4).energy
    ).toBeCloseTo(steady.energy - 2 * driftRules.perMinutePastTen, 5);
  });

  it("a plain answer to 'why do you ask' builds trust", () => {
    expect(
      drift(steady, plain, { ...nothingHappened, purposeTold: true }, 0).trust
    ).toBeCloseTo(steady.trust + driftRules.purposeTold, 5);
  });

  it("a wrong paraphrase costs trust, and some patience", () => {
    const after = drift(
      steady,
      plain,
      { ...nothingHappened, wrongParaphrase: true },
      0
    );
    expect(after.trust).toBeCloseTo(
      steady.trust - driftRules.wrongParaphraseTrust,
      5
    );
    expect(after.patience).toBeLessThan(once.patience);
  });

  it("a real case opens someone guarded, and does little for someone open", () => {
    const guarded = { ...steady, trust: 0.3 };
    const open = { ...steady, trust: 0.8 };
    const asked = { ...nothingHappened, concreteCase: true };
    expect(drift(guarded, plain, asked, 0).trust - guarded.trust).toBeCloseTo(
      driftRules.concreteCaseGuarded,
      5
    );
    expect(drift(open, plain, asked, 0).trust - open.trust).toBeCloseTo(
      driftRules.concreteCaseOpen,
      5
    );
  });

  it("being asked on after saying they must go costs patience", () => {
    const kept = drift(steady, plain, { ...nothingHappened, keptOn: true }, 0);
    expect(once.patience - kept.patience).toBeCloseTo(driftRules.keptOn, 5);
  });

  it("stays between 0 and 1, and names the lines it crossed", () => {
    const worst = drift(
      { patience: 0.05, trust: 0.05, energy: 0.05, focus: 0.05 },
      { rushed: 1 },
      {
        repeated: true,
        minutes: 60,
        purposeTold: false,
        wrongParaphrase: true,
        concreteCase: false,
        keptOn: true,
      },
      0
    );
    for (const value of Object.values(worst)) {
      expect(value >= 0 && value <= 1).toBeTruthy();
    }
    expect(
      turnedOf({ ...steady, trust: 0.5 }, { ...steady, trust: 0.7 })
    ).toStrictEqual(["warmed up"]);
    expect(
      turnedOf({ ...steady, patience: 0.31 }, { ...steady, patience: 0.1 })
    ).toStrictEqual(["wants to finish", "left"]);
  });
});

describe("a question asked again", () => {
  it("is one with most of its words asked before, in any order", () => {
    expect(
      isRepeated([
        line("stephen", "Which system do you open first for the invoices?"),
        line("person", "exact"),
        line("stephen", "For the invoices, which system do you open first?"),
      ])
    ).toBeTruthy();
    expect(
      isRepeated([
        line("stephen", "Which system do you open first for the invoices?"),
        line("person", "exact"),
        line("stephen", "Who checks the totals before they go out?"),
      ])
    ).toBeFalsy();
  });

  it("is not two number questions about different things, which share only their frame", () => {
    expect(
      isRepeated([
        line(
          "stephen",
          "How many valuation reports does your whole team check in a normal week?"
        ),
        line("person", "170"),
        line(
          "stephen",
          "How many requests for missing documents does your whole team send in a normal week?"
        ),
      ])
    ).toBeFalsy();
    expect(
      isRepeated([
        line(
          "stephen",
          "Hoeveel taxatierapporten beoordeelt je hele team in een normale week?"
        ),
        line("person", "170"),
        line(
          "stephen",
          "Hoeveel aanvragen om ontbrekende stukken vraagt je hele team in een normale week?"
        ),
      ])
    ).toBeFalsy();
  });

  it("is fair after an answer that was no answer, and costs nothing then", () => {
    const lines = [
      line("stephen", "Which system do you open first for the invoices?"),
      line("person", "qwerty haha"),
      line(
        "stephen",
        "I cannot use that. Which system do you open first for the invoices?"
      ),
    ];
    expect(isRepeated(lines)).toBeTruthy();
    expect(isRepeated(lines, "not an answer")).toBeFalsy();
    expect(isRepeated(lines, "why do you ask")).toBeFalsy();
  });
});

describe("the clock a person feels", () => {
  it("is the talk clock of play.ts", () => {
    const lines = [
      line("stephen", "one two three"),
      line("person", "four five"),
    ];
    expect(talkMinutes(lines)).toBeCloseTo(
      secondsOf("one two three", "four five") / 60,
      5
    );
  });
});

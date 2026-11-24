/**
 * People v2, as played (people-v2.ts): what someone with a mix and a state
 * does on each answer, decided by code and a seed. No model here: only
 * what they are told to do is played.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  holdsBackBelow,
  leaveBelow,
  nothingHappened,
  opensAt,
  tiredBelow,
  wrapUpBelow,
} from "./drift.ts";
import type { Happened, State, TemperMix, Turned } from "./drift.ts";
import type { Move } from "./moves.ts";
import {
  directionOfV2,
  freshMindV2,
  mindAfterV2,
  peopleVersionOf,
} from "./people-v2.ts";
import type { MindV2 } from "./people-v2.ts";
import { rollOf } from "./people.ts";

interface Playing {
  happened?: (nth: number, mind: MindV2) => Partial<Happened>;
  heard?: (mind: MindV2) => boolean;
  seed?: string;
}

/** Plays `answers` answers of someone v2, with what Stephen is taken to have done before each. */
const playedV2 = (
  mix: TemperMix,
  answers: number,
  { happened = () => ({}), heard = () => false, seed = "v2" }: Playing = {}
) => {
  let mind = freshMindV2(mix, seed);
  const did: (Move | null)[] = [];
  const states: State[] = [];
  const turned: Turned[] = [];
  const texts: string[] = [];
  let left = false;
  for (let nth = 1; nth <= answers && !left; nth += 1) {
    const step = directionOfV2(mix, mind, {
      phase: "steps",
      roll: 0.9,
      draw: rollOf(seed, 500 + nth),
      heard: heard(mind),
      happened: { ...nothingHappened, minutes: nth, ...happened(nth, mind) },
    });
    did.push(step.direction.move);
    states.push(step.state);
    turned.push(...step.turned);
    texts.push(step.direction.text);
    left = step.direction.leaves === true;
    mind = mindAfterV2(mind, step, step.direction.move, nth);
  }
  return { did, states, turned, texts, mind, left };
};

const steady: State = { patience: 0.8, trust: 0.5, energy: 0.8, focus: 0.8 };

const plain: TemperMix = { plain: 1 };

/** A turn in the steps, `minutes` into the interview, with nothing done by him. */
const turnAt = (minutes: number) => ({
  phase: "steps" as const,
  roll: 0.9,
  draw: 0.1,
  heard: false,
  happened: { ...nothingHappened, minutes },
});

/** One answer of someone plain, at the tenth answer, in `state`. */
const at = (state: State, mix: TemperMix = plain) =>
  directionOfV2(
    mix,
    { ...freshMindV2(mix, "s"), state, answers: 10 },
    {
      phase: "steps",
      roll: 0.9,
      draw: 0.1,
      heard: false,
      happened: nothingHappened,
    }
  );

describe("someone with a mix", () => {
  it("a joker told plainly stays serious, whichever temper leads the next answers", () => {
    const { did } = playedV2({ joker: 0.6, plain: 0.4 }, 10, {
      heard: () => true,
      seed: "joker-plain",
    });
    const first = did.indexOf("not an answer");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(
      did.slice(first + 2).filter((move) => move === "not an answer")
    ).toStrictEqual([]);
  });

  it("a wary person warms up on a straight answer and a real case, and is open from then on", () => {
    const { turned, mind, texts } = playedV2({ wary: 1 }, 6, {
      happened: (nth, now) => ({
        purposeTold: now.last === "why do you ask",
        concreteCase: nth === 4,
      }),
      heard: () => true,
      seed: "wary",
    });
    expect(turned).toContain("warmed up");
    expect(mind.stages.wary).toBe("open");
    expect(mind.state.trust).toBeGreaterThanOrEqual(opensAt);
    // Guarded at first, holding back by the state as well as by the temper.
    expect(texts[0]).toContain('"depends"');
  });
});

describe("the state changes the answers", () => {
  it("low energy means shorter answers, low trust holding back", () => {
    expect(
      at({ ...steady, energy: tiredBelow - 0.05 }).direction.text
    ).toContain("fewer words");
    expect(
      at({ ...steady, trust: holdsBackBelow - 0.05 }).direction.text
    ).toContain('"depends"');
    expect(at(steady).direction.text).not.toContain("fewer words");
    expect(at(steady).direction.text).not.toContain('"depends"');
  });

  it("patience below the line means wanting to finish, and then leaving", () => {
    expect(at({ ...steady, patience: wrapUpBelow - 0.02 }).direction.move).toBe(
      "wrap up"
    );
    expect(
      at({ ...steady, patience: leaveBelow - 0.01 }).direction.leaves
    ).toBeTruthy();
  });

  it("someone who wants to finish answers one last question, and goes on the second", () => {
    const mix = plain;
    const mind = {
      ...freshMindV2(mix, "w"),
      state: { ...steady, patience: wrapUpBelow - 0.01 },
      answers: 10,
    };
    const first = directionOfV2(mix, mind, turnAt(10));
    expect(first.direction.move).toBe("wrap up");
    const after = mindAfterV2(mind, first, "wrap up", 10);
    const second = directionOfV2(mix, after, turnAt(11));
    expect(second.direction.leaves).not.toBeTruthy();
    const third = directionOfV2(
      mix,
      mindAfterV2(after, second, "wrap up", 11),
      turnAt(12)
    );
    expect(third.direction.leaves).toBeTruthy();
  });

  it("someone in a hurry asked the same again and again leaves; someone plain who is not stays", () => {
    const hurried = playedV2({ rushed: 0.7, plain: 0.3 }, 40, {
      happened: (nth) => ({ repeated: nth % 3 === 0 }),
      seed: "hurry",
    });
    expect(hurried.left).toBeTruthy();
    expect(hurried.did).toContain("wrap up");
    expect(hurried.turned).toStrictEqual(
      expect.arrayContaining(["wants to finish", "left"])
    );
    expect(playedV2({ plain: 1 }, 20, { seed: "calm" }).left).toBeFalsy();
  });

  it("a long talk tires everyone", () => {
    const { turned, states } = playedV2({ plain: 1 }, 30, { seed: "long" });
    expect(turned).toContain("tired");
    expect(states.at(-1)?.energy).toBeLessThan(tiredBelow);
  });

  it("is the same for the same seed", () => {
    expect(
      playedV2({ official: 0.6, rushed: 0.4 }, 15, { seed: "x" }).did
    ).toStrictEqual(
      playedV2({ official: 0.6, rushed: 0.4 }, 15, { seed: "x" }).did
    );
  });
});

describe("which people a run had", () => {
  it("is v2 unless asked for v1", () => {
    expect(peopleVersionOf()).toBe("v2");
    expect(peopleVersionOf("v1")).toBe("v1");
    expect(peopleVersionOf("v2")).toBe("v2");
  });
});

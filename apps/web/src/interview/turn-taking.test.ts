import { describe, expect, it } from "vite-plus/test";

import {
  breathMs,
  ended,
  hanging,
  holdMs,
  looksThinkingMs,
  nudgeMs,
  patienceMs,
  pauseFor,
  quietFloor,
  restFor,
  restMs,
  stillIn,
  step,
  troubleOf,
  unanswered,
} from "./turn-taking.ts";
import type { Act, Floor, Happening } from "./turn-taking.ts";

// The turn-taking of the prototype's `useLoop` (`data/interview-loop.ts`)
// and its `ended` and `hanging` (`data/ear.ts`), played as an interview
// goes: what happens in, what he does out.

/** Plays `happenings` from `floor`: where it ends, and everything it said to do. */
const play = (
  happenings: Happening[],
  floor: Floor = quietFloor
): { floor: Floor; acts: Act[] } => {
  let now = floor;
  const acts: Act[] = [];
  for (const happening of happenings) {
    const next = step(now, happening);
    now = next.floor;
    acts.push(...next.acts);
  }
  return { floor: now, acts };
};

/** What was asked of core, in order. */
const asks = (acts: Act[]) =>
  acts.flatMap((act) => (act.type === "ask" ? [act] : []));

/** Talking, with him listening for it: he said his line and waits. */
const talking: Happening[] = [
  { type: "voice", at: 0, on: true },
  { type: "speak", at: 0, answers: true },
  { type: "listen", at: 1000 },
];

/** A stretch said from `from` to `to`, its words in `wordsAfter` ms later. */
const stretch = (
  number: number,
  text: string,
  from: number,
  to: number,
  wordsAfter = 100
): Happening[] => [
  { type: "stretch-start", at: from, stretch: number },
  { type: "partial", at: from + 200, stretch: number, text },
  { type: "stretch-end", at: to, stretch: number },
  { type: "final", at: to + wordsAfter, stretch: number, text },
];

describe("where a sentence ends", () => {
  it.each([
    ["I check it in Exact.", true, false],
    ["Is that right?", true, false],
    ["“That’s it.”", true, false],
    ["I think so.", true, true],
    ["and then...", false, true],
    ["and then…", false, true],
    ["I open the sheet and", false, true],
    ["Ik open het en", false, true],
    ["Dann gebe ich es weiter an", false, true],
    ["Je l’envoie à", false, true],
    ["Lo mando a", false, true],
    ["First the invoice,", false, true],
    ["It takes about two minutes", false, false],
  ])("“%s” ends: %s, breaks off: %s", (words, isEnded, isHanging) => {
    expect({ ended: ended(words), hanging: hanging(words) }).toStrictEqual({
      ended: isEnded,
      hanging: isHanging,
    });
  });
});

describe("how long he waits once they fell quiet", () => {
  it.each([
    ["I think so.", false, 0],
    ["It takes two minutes", false, restMs],
    ["Then I send it to", false, patienceMs],
    ["and then", true, 0],
  ])("after “%s”, typed: %s, is %i ms", (words, typed, ms) => {
    expect(restFor({ stretch: null, words, typed, waiting: false })).toBe(ms);
  });
});

describe("a stretch of speech", () => {
  it("ends with a breath when its words come live, else with the ear's own pause", () => {
    expect([pauseFor(true, 800), pauseFor(false, 800)]).toStrictEqual([
      breathMs,
      800,
    ]);
  });
});

describe("answering when they are done", () => {
  it("asks for his turn the moment the words of a finished sentence are in", () => {
    const { floor, acts } = play([
      ...talking,
      ...stretch(1, "I check it in Exact.", 2000, 3000),
    ]);
    expect({
      asks: asks(acts),
      quiet: acts.filter(({ type }) => type === "quiet"),
      asking: floor.asking,
    }).toStrictEqual({
      asks: [
        {
          type: "ask",
          turn: 1,
          text: "I check it in Exact.",
          typed: false,
          nudge: false,
        },
      ],
      quiet: [{ type: "quiet", at: 3000 }],
      asking: 1,
    });
  });

  it("looks as if he listens a moment longer, then thinks, unless they went on", () => {
    const asked = play([...talking, ...stretch(1, "Yes.", 2000, 3000)]);
    const thinks = step(asked.floor, {
      type: "waited",
      at: 3700,
      wait: "thinking",
    });
    expect({
      waits: asked.acts.filter(({ type }) => type === "after"),
      before: asked.floor.doing,
      after: thinks.floor.doing,
    }).toStrictEqual({
      waits: [{ type: "after", wait: "thinking", ms: looksThinkingMs }],
      before: "listening",
      after: "thinking",
    });
  });

  it("waits a little where a sentence doesn't end, and longer where it breaks off", () => {
    const plain = play([
      ...talking,
      ...stretch(1, "It takes about two minutes", 2000, 3000),
    ]);
    const breaking = play([
      ...talking,
      ...stretch(1, "Then I send it to", 2000, 3000),
    ]);
    expect({
      plain: plain.acts.filter(({ type }) => type === "after"),
      breaking: breaking.acts.filter(({ type }) => type === "after"),
      asked: [...asks(plain.acts), ...asks(breaking.acts)],
    }).toStrictEqual({
      plain: [{ type: "after", wait: "settle", ms: restMs - 100 }],
      breaking: [{ type: "after", wait: "settle", ms: patienceMs - 100 }],
      asked: [],
    });
  });

  it("answers a sentence that broke off once they stay quiet", () => {
    const { acts } = play([
      ...talking,
      ...stretch(1, "Then I send it to", 2000, 3000),
      { type: "waited", at: 3000 + patienceMs, wait: "settle" },
    ]);
    expect(asks(acts).map(({ text }) => text)).toStrictEqual([
      "Then I send it to",
    ]);
  });

  it("joins what they said in stretches, and answers all of it once they finish", () => {
    const { acts } = play([
      ...talking,
      ...stretch(1, "Then I send it to", 2000, 3000),
      ...stretch(2, "Sam in finance.", 4000, 5000),
    ]);
    expect(asks(acts).map(({ text }) => text)).toStrictEqual([
      "Then I send it to Sam in finance.",
    ]);
  });

  it("doesn't answer while the words of a stretch are still on their way", () => {
    const { acts } = play([
      ...talking,
      { type: "stretch-start", at: 2000, stretch: 1 },
      { type: "stretch-end", at: 3000, stretch: 1 },
      ...stretch(2, "Yes.", 3200, 3800),
    ]);
    expect(asks(acts)).toStrictEqual([]);
  });

  it("forgets a stretch in which nothing was said", () => {
    const { floor, acts } = play([...talking, ...stretch(1, "", 2000, 3000)]);
    expect({ parts: floor.parts, asks: asks(acts) }).toStrictEqual({
      parts: [],
      asks: [],
    });
  });
});

describe("when they talk on", () => {
  it("drops the answer under way, and asks again with all they said once they stop", () => {
    const { acts } = play([
      ...talking,
      ...stretch(1, "I check it.", 2000, 3000),
      ...stretch(2, "In Exact, I mean.", 3500, 4500),
    ]);
    expect(
      acts.filter(({ type }) => type === "ask" || type === "drop")
    ).toStrictEqual([
      {
        type: "ask",
        turn: 1,
        text: "I check it.",
        typed: false,
        nudge: false,
      },
      { type: "drop", turn: 1 },
      {
        type: "ask",
        turn: 2,
        text: "I check it. In Exact, I mean.",
        typed: false,
        nudge: false,
      },
    ]);
  });

  it("listens again when he was already thinking", () => {
    const thinking = play([
      ...talking,
      ...stretch(1, "Yes.", 2000, 3000),
      { type: "waited", at: 3700, wait: "thinking" },
      { type: "stretch-start", at: 4000, stretch: 2 },
    ]);
    expect({
      doing: thinking.floor.doing,
      asking: thinking.floor.asking,
    }).toStrictEqual({ doing: "listening", asking: null });
  });

  it("makes a turn that comes back late for nothing", () => {
    const { floor } = play([
      ...talking,
      ...stretch(1, "Yes.", 2000, 3000),
      { type: "stretch-start", at: 3500, stretch: 2 },
      { type: "more", at: 3600, turn: 1 },
      { type: "failed", at: 3700, turn: 1 },
    ]);
    expect({ doing: floor.doing, talking: floor.talking }).toStrictEqual({
      doing: "listening",
      talking: true,
    });
  });
});

describe("a sentence the model was sure had more to come", () => {
  it("waits for the rest, and answers with what there is after a silence", () => {
    const { acts } = play([
      ...talking,
      ...stretch(1, "I send it.", 2000, 3000),
      { type: "more", at: 4000, turn: 1 },
      { type: "waited", at: 4000 + nudgeMs, wait: "nudge" },
    ]);
    expect(
      acts.filter(
        (act) =>
          act.type === "ask" || (act.type === "after" && act.wait === "nudge")
      )
    ).toStrictEqual([
      { type: "ask", turn: 1, text: "I send it.", typed: false, nudge: false },
      { type: "after", wait: "nudge", ms: nudgeMs },
      { type: "ask", turn: 2, text: "I send it.", typed: false, nudge: true },
    ]);
  });

  it("answers the rest with it when it comes", () => {
    const { acts } = play([
      ...talking,
      ...stretch(1, "I send it.", 2000, 3000),
      { type: "more", at: 4000, turn: 1 },
      ...stretch(2, "To Sam.", 5000, 5500),
      { type: "waited", at: 4000 + nudgeMs, wait: "nudge" },
    ]);
    expect(
      asks(acts).map(({ text, nudge }) => ({ text, nudge }))
    ).toStrictEqual([
      { text: "I send it.", nudge: false },
      { text: "I send it. To Sam.", nudge: false },
    ]);
  });
});

describe("the read-back", () => {
  it("isn't listened to from his line that leads to it until he asks whether it is right", () => {
    const deaf = play([
      ...talking,
      { type: "speak", at: 2000, answers: true },
      { type: "reads-back", at: 2100 },
      { type: "wait", at: 4000 },
      { type: "speak", at: 4500 },
      { type: "listen", at: 9000 },
      ...stretch(1, "Hello?", 9500, 10_000),
    ]);
    const asked = play(
      [
        { type: "listen", at: 12_000, asked: true },
        ...stretch(2, "Yes, that's right.", 12_500, 13_000),
      ],
      deaf.floor
    );
    expect({
      hearing: deaf.floor.hearing,
      heard: asks(deaf.acts),
      afterwards: asks(asked.acts).map(({ text }) => text),
      opened: asked.acts.filter(({ type }) => type === "hear").length,
    }).toStrictEqual({
      hearing: false,
      heard: [],
      afterwards: ["Yes, that's right."],
      opened: 1,
    });
  });
});

describe("his own line", () => {
  it("closes the ear while he says it, and what he answers is his", () => {
    const { floor, acts } = play([
      ...talking,
      ...stretch(1, "Yes.", 2000, 3000),
      { type: "speak", at: 4000, answers: true },
    ]);
    expect({
      deaf: acts.some(({ type }) => type === "deaf"),
      floor: {
        doing: floor.doing,
        hearing: floor.hearing,
        parts: floor.parts,
        asking: floor.asking,
      },
    }).toStrictEqual({
      deaf: true,
      floor: { doing: "speaking", hearing: false, parts: [], asking: null },
    });
  });

  it("is held while they may be starting to talk, for a moment at most", () => {
    expect([
      stillIn({ now: 1000, since: 1000, lastHeard: 900, hearing: true }),
      stillIn({ now: 1000, since: 1000, lastHeard: 700, hearing: true }),
      stillIn({
        now: 1000 + holdMs,
        since: 1000,
        lastHeard: 1300,
        hearing: true,
      }),
      stillIn({ now: 1000, since: 1000, lastHeard: 900, hearing: false }),
    ]).toStrictEqual([50, 0, 0, 0]);
  });
});

describe("typing", () => {
  it("stops him at once and goes to him with what they said before", () => {
    const { acts } = play([
      ...talking,
      ...stretch(1, "Then I send it to", 2000, 3000),
      { type: "speak", at: 3500 },
      { type: "typed", at: 3600, text: "Sam." },
    ]);
    expect(
      acts.filter(({ type }) => type === "hush" || type === "ask")
    ).toStrictEqual([
      { type: "hush" },
      {
        type: "ask",
        turn: 1,
        text: "Then I send it to Sam.",
        typed: false,
        nudge: false,
      },
    ]);
  });
});

describe("when something fails", () => {
  it("keeps what they said, and asks with it and whatever they said since", () => {
    const failed = play([
      ...talking,
      ...stretch(1, "I check it.", 2000, 3000),
      { type: "failed", at: 6000, turn: 1 },
      { type: "speak", at: 6100 },
      { type: "listen", at: 9000 },
    ]);
    const again = play(
      [...stretch(2, "In Exact.", 9500, 10_000), { type: "retry", at: 20_000 }],
      failed.floor
    );
    expect({
      kept: unanswered(failed.floor),
      asked: asks(again.acts).map(({ text }) => text),
    }).toStrictEqual({
      kept: "I check it.",
      asked: ["I check it. In Exact."],
    });
  });

  it("says a stretch couldn't be written down, and keeps the rest", () => {
    const { floor, acts } = play([
      ...talking,
      ...stretch(1, "Then I send it to", 2000, 3000),
      { type: "stretch-start", at: 3200, stretch: 2 },
      { type: "stretch-end", at: 3600, stretch: 2 },
      { type: "unheard", at: 6000, stretch: 2 },
    ]);
    expect({
      said: acts.filter(({ type }) => type === "unheard"),
      kept: unanswered(floor),
    }).toStrictEqual({
      said: [{ type: "unheard" }],
      kept: "Then I send it to",
    });
  });

  it.each([
    [0, 0, true, { say: "offline", again: 5000 }],
    [0, 502, false, { say: "offline", again: 5000 }],
    [0, 502, true, { say: "trouble", again: 5000 }],
    [1, 502, true, { say: null, again: 10_000 }],
    [3, 502, true, { say: null, again: 30_000 }],
    [4, 502, true, { say: "stillTrouble", again: null }],
    [5, 502, true, { say: null, again: null }],
  ])(
    "after %i failures in a row, status %i, online %s: %o",
    (tried, status, online, expected) => {
      expect(troubleOf({ tried, status, online })).toStrictEqual(expected);
    }
  );
});

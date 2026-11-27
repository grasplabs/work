import { describe, expect, it } from "vite-plus/test";

import {
  breathMs,
  echoes,
  ended,
  hanging,
  looksThinkingMs,
  nudgeMs,
  patienceMs,
  pauseFor,
  quietFloor,
  restFor,
  restMs,
  step,
  unanswered,
} from "./turn-taking.ts";
import type { Act, Floor, Happening } from "./turn-taking.ts";

// The turn-taking of the read-back (the prototype's `useLoop`,
// `data/interview-loop.ts`, and its `ended` and `hanging`, `data/ear.ts`),
// played as it goes: what happens in, what he does out.

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

/** What went to him of what they said, in order. */
const asks = (acts: Act[]) =>
  acts.flatMap((act) => (act.type === "ask" ? [act] : []));

/** Talking, with him listening for it: he said his line and waits. */
const talking: Happening[] = [
  { type: "voice", at: 0, on: true },
  { type: "speak", at: 0 },
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
  it("goes to him again with all they said once they stop", () => {
    const { acts } = play([
      ...talking,
      ...stretch(1, "I check it.", 2000, 3000),
      ...stretch(2, "In Exact, I mean.", 3500, 4500),
    ]);
    expect(asks(acts)).toStrictEqual([
      {
        type: "ask",
        turn: 1,
        text: "I check it.",
        typed: false,
      },
      {
        type: "ask",
        turn: 2,
        text: "I check it. In Exact, I mean.",
        typed: false,
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
});

describe("the read-back", () => {
  it("isn't listened to from when he reads back until he asks whether it is right", () => {
    const deaf = play([
      ...talking,
      { type: "speak", at: 2000, readsBack: true },
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
  it("listens afresh while he says it, and what he answers is his", () => {
    const { floor, acts } = play([
      ...talking,
      ...stretch(1, "Yes.", 2000, 3000),
      { type: "answered", at: 4000 },
      { type: "speak", at: 4000 },
    ]);
    expect({
      // What was being said counts for nothing, and he hears from now.
      afresh: acts.slice(-2).map(({ type }) => type),
      floor: {
        doing: floor.doing,
        hearing: floor.hearing,
        parts: floor.parts,
        asking: floor.asking,
      },
    }).toStrictEqual({
      afresh: ["deaf", "hear"],
      floor: { doing: "speaking", hearing: true, parts: [], asking: null },
    });
  });

  it("stops at once when they talk over him, and answers what they said", () => {
    const { floor, acts } = play([
      ...talking,
      ...stretch(1, "Yes.", 2000, 3000),
      { type: "answered", at: 4000 },
      { type: "speak", at: 4000 },
      ...stretch(2, "Wait, that is not my work.", 4500, 6000),
    ]);
    expect({
      hushed: acts.filter(({ type }) => type === "hush").length,
      asked: asks(acts).map(({ text }) => text),
      doing: floor.doing,
      cut: floor.cut,
    }).toStrictEqual({
      hushed: 1,
      asked: ["Yes.", "Wait, that is not my work."],
      doing: "listening",
      cut: false,
    });
  });

  it("says his line again when what cut him off was no words", () => {
    const { floor, acts } = play([
      ...talking,
      { type: "answered", at: 4000 },
      { type: "speak", at: 4000 },
      ...stretch(1, "", 4500, 5000),
    ]);
    expect({
      did: acts.flatMap(({ type }) =>
        type === "hush" || type === "resume" ? [type] : []
      ),
      asked: asks(acts),
      cut: floor.cut,
      interrupts: floor.interrupts,
    }).toStrictEqual({
      did: ["hush", "resume"],
      asked: [],
      cut: false,
      interrupts: true,
    });
  });

  it("still answers what they said before a sound that was no words", () => {
    const heard = play([
      ...talking,
      // No full stop: he waits a moment for more.
      ...stretch(1, "We use SAP", 2000, 3000),
      // A cough while he waits: the wait starts over, and is not forgotten.
      ...stretch(2, "", 3300, 3600),
    ]);
    const answered = play(
      [{ type: "waited", at: 4800, wait: "settle" }],
      heard.floor
    );
    expect({
      waits: heard.acts.at(-1),
      asked: asks(answered.acts).map(({ text }) => text),
    }).toStrictEqual({
      waits: { type: "after", wait: "settle", ms: 1000 },
      asked: ["We use SAP"],
    });
  });

  it("starts his ear afresh as he stops speaking, so the end of his own line is never theirs", () => {
    const { acts } = play([
      ...talking,
      ...stretch(1, "Yes.", 2000, 3000),
      { type: "answered", at: 4000 },
      { type: "speak", at: 4000 },
      { type: "listen", at: 6000 },
    ]);
    expect(acts.slice(-2).map(({ type }) => type)).toStrictEqual([
      "deaf",
      "hear",
    ]);
  });

  it("never answers his own voice, says his line again, and stops listening while he speaks", () => {
    const cutOff = play([
      ...talking,
      { type: "answered", at: 4000 },
      { type: "speak", at: 4000 },
      { type: "stretch-start", at: 4500, stretch: 1 },
      { type: "stretch-end", at: 5000, stretch: 1 },
      { type: "echo", at: 5100, stretch: 1 },
    ]);
    const again = play(
      [
        { type: "speak", at: 5200 },
        { type: "stretch-start", at: 5600, stretch: 2 },
      ],
      cutOff.floor
    );
    expect({
      did: cutOff.acts.flatMap(({ type }) =>
        type === "hush" || type === "resume" ? [type] : []
      ),
      asked: asks([...cutOff.acts, ...again.acts]),
      hearing: again.floor.hearing,
      doing: again.floor.doing,
    }).toStrictEqual({
      did: ["hush", "resume"],
      asked: [],
      hearing: false,
      doing: "speaking",
    });
  });

  it("doesn't listen while he says a line that leads to the read-back", () => {
    const { floor, acts } = play([
      ...talking,
      { type: "speak", at: 4000, readsBack: true },
      ...stretch(1, "Hold on.", 4500, 5000),
    ]);
    expect({
      hearing: floor.hearing,
      doing: floor.doing,
      hushed: acts.some(({ type }) => type === "hush"),
    }).toStrictEqual({ hearing: false, doing: "speaking", hushed: false });
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
      },
    ]);
  });
});

describe("when something fails", () => {
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
});

describe("after he said he couldn't hear them", () => {
  it("takes what he did hear once they stay quiet", () => {
    const { acts } = play([
      ...talking,
      ...stretch(1, "Then I send it to", 2000, 3000),
      { type: "stretch-start", at: 3200, stretch: 2 },
      { type: "stretch-end", at: 3600, stretch: 2 },
      { type: "unheard", at: 6000, stretch: 2 },
      { type: "speak", at: 6100 },
      { type: "listen", at: 9000, nudge: true },
      { type: "waited", at: 9000 + nudgeMs, wait: "nudge" },
    ]);
    expect(asks(acts).map(({ text }) => text)).toStrictEqual([
      "Then I send it to",
    ]);
  });
});

describe("his own voice in the microphone", () => {
  const line = "First a few questions about you and AI, then your work.";

  it.each([
    ["first a few", true],
    ["Questions about you and AI.", true],
    ["you", true],
    ["No, wait.", false],
    ["a few first", false],
    ["", false],
  ])("takes %j heard over his line for his own: %s", (heard, own) => {
    expect(echoes(heard, line)).toBe(own);
  });
});

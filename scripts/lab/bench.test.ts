/**
 * The benches (bench.ts), run on a stand-in for the local core: Stephen's
 * turns and the judge are faked models, scripted, so what is tested is the
 * harness itself. What it must get right: the same fixed input every time,
 * built as the page builds a turn; his notes carried from turn to turn;
 * the rule a line is held to; nothing of the hidden set kept to read; and
 * two runs of the same Stephen called noise, a better one better.
 */
import type { StephenTurn } from "@grasp-os/shared/interview-turn";
import type { LabWho } from "@grasp-os/shared/lab";
import { describe, expect, it } from "vite-plus/test";

import {
  benchAsk,
  benchDraw,
  benchNotes,
  mineMoments,
  ruleOf,
} from "./bench.ts";
import type { Stand, TurnAsked } from "./bench.ts";
import type { Transcript } from "./cases.ts";
import { compare, noiseOf } from "./compare.ts";
import type { Ask } from "./core.ts";
import { keyOf } from "./keys/index.ts";
import { handMoments, signalRules } from "./moments.ts";
import type { Moment } from "./moments.ts";
import type { Asker } from "./person.ts";
import type { CaseScore } from "./results.ts";

const who: LabWho = {
  company: "Noordzee Vis B.V.",
  name: "Karin",
  team: "Order desk",
  lead: "Wim",
  work: "entering orders",
  known: "",
};

const stephen = (more: Partial<StephenTurn>): StephenTurn => ({
  say: "",
  tone: null,
  phase: "steps",
  facts: [],
  changes: [],
  wants: "answer",
  more: false,
  approved: false,
  ...more,
});

/** A judge that answers every call with what `answer` says, held to the call's own schema as the gateway holds it. */
const judgeAnswering =
  (answer: (call: Ask<unknown>) => unknown): Asker =>
  async (call) =>
    await Promise.resolve(call.schema.parse(answer(call)));

const noDrawings = async () => await Promise.resolve([]);

/** Where a test keeps nothing, or says nothing. */
const ignored = (): void => {
  // Nothing to keep.
};

const options = {
  set: "open",
  interviewer: "stephen",
  keep: ignored,
} as const;

/** A stand whose Stephen answers each turn with `turns(asked)`; it keeps every turn asked. */
const standWith = (
  turns: (asked: TurnAsked, lineOnly: boolean) => StephenTurn,
  asker: Asker,
  drawings: Stand["drawings"] = noDrawings
) => {
  const asked: { who: LabWho; turn: TurnAsked; lineOnly: boolean }[] = [];
  const stand: Stand = {
    turn: async (to, turn, { lineOnly }) => {
      asked.push({ who: to, turn, lineOnly });
      return await Promise.resolve(turns(turn, lineOnly));
    },
    asker,
    drawings,
    log: ignored,
  };
  return { stand, asked };
};

const step = (text: string) => ({
  tag: "step" as const,
  text,
  record: text,
  quote: text,
});

const conversation: Transcript = {
  id: "01-p1-ab12",
  key: "01",
  employee: "P1",
  locale: "en",
  by: "model",
  who,
  lines: [
    { from: "stephen", text: "Think of the last invoice. When was that?" },
    { from: "person", text: "this morning, it came in by email" },
    { from: "stephen", text: "What did you do first?" },
    { from: "person", text: "i checked the po number in exact" },
    { from: "stephen", text: "I'll read back what I wrote down." },
    { from: "person", text: "yes that's right" },
  ],
  readbackFrom: 4,
  said: ["TR", "S1"],
  notes: [],
  notesAt: [0, 1, 2],
  phaseAt: ["anchor", "steps", "readback"],
  stephen: "mark",
};

describe("the notes bench", () => {
  it("plays a conversation back up to the read-back, one answer at a time, carrying his notes as the page keeps them, and scores what he wrote against the key", async () => {
    const turns = [
      stephen({
        phase: "story",
        facts: [step("The invoice comes in by mail.")],
      }),
      stephen({
        phase: "readback",
        changes: [
          { id: "f1", text: "The invoice comes in by email.", record: null },
        ],
        facts: [step("You check the PO number in Exact.")],
      }),
    ];
    const { stand, asked } = standWith(
      () => turns.shift() ?? stephen({}),
      judgeAnswering(() => ({
        known: [
          { id: "TR", said: true, written: ["f1"] },
          { id: "S1", said: true, written: [] },
        ],
        written: [
          { id: "f1", verdict: "said" },
          { id: "f2", verdict: "repeat" },
        ],
      }))
    );
    const kept: string[] = [];
    const cases = await benchNotes(stand, [conversation], {
      set: "open",
      interviewer: "stephen",
      keep: (id) => {
        kept.push(id);
      },
    });
    expect({
      cases,
      kept,
      asked: asked.map(({ turn, lineOnly }) => ({
        last: turn.lines.at(-1),
        lines: turn.lines.length,
        facts: turn.facts,
        phase: turn.phase,
        minutes: turn.minutes,
        lineOnly,
      })),
    }).toStrictEqual({
      cases: [
        {
          id: "01-p1-ab12",
          scores: {
            written: 0.5,
            supported: 0.5,
            repeats: 0.5,
            notSaid: 0,
            notes: 2,
          },
        },
      ],
      kept: ["01-p1-ab12"],
      asked: [
        {
          last: {
            from: "person",
            text: "this morning, it came in by email",
            typed: true,
          },
          lines: 2,
          facts: [],
          phase: "anchor",
          minutes: 0.5,
          lineOnly: false,
        },
        {
          last: {
            from: "person",
            text: "i checked the po number in exact",
            typed: true,
          },
          lines: 4,
          facts: [
            { id: "f1", tag: "step", text: "The invoice comes in by mail." },
          ],
          phase: "story",
          minutes: 1,
          lineOnly: false,
        },
      ],
    });
  });

  it("keeps nothing of a hidden conversation to read, and leaves out one kept without who he talked with", async () => {
    const { stand, asked } = standWith(
      () => stephen({}),
      judgeAnswering(() => ({ known: [], written: [] }))
    );
    const kept: string[] = [];
    const cases = await benchNotes(
      stand,
      [conversation, { ...conversation, id: "01-p1-old", who: null }],
      {
        set: "hidden",
        interviewer: "stephen",
        keep: (id) => {
          kept.push(id);
        },
      }
    );
    expect({
      cases: cases.map(({ id }) => id),
      kept,
      turns: asked.length,
    }).toStrictEqual({
      cases: ["01-p1-ab12"],
      kept: [],
      turns: 2,
    });
  });
});

const momentNamed = (id: string): Moment => {
  const found = handMoments.find((each) => each.id === id);
  if (found === undefined) {
    throw new Error(`No moment ${id}.`);
  }
  return found;
};

/** A judge of lines that passes every line, and says it was asked. */
const passing = judgeAnswering(() => ({ pass: true, single: true, why: "ok" }));

describe("the next-question bench", () => {
  it("asks his line after the part on AI and the moment, typed as the page sends it but for a last line said out loud", async () => {
    const misheard = momentNamed("orders-misheard");
    const { stand, asked } = standWith(
      () => stephen({ say: "Sorry, say that once more?" }),
      passing
    );
    await benchAsk(stand, [misheard], {
      set: "open",
      interviewer: "claire",
      keep: ignored,
    });
    const [first] = asked;
    const lines = first?.turn.lines ?? [];
    expect({
      who: first?.who,
      interviewer: first?.turn.interviewer,
      opensOnAi: lines[0]?.text.includes("AI"),
      lines: lines.length,
      typedLast: lines.at(-1)?.typed,
      typedBefore: lines.at(-3)?.typed,
      facts: first?.turn.facts.map(({ id }) => id),
      lineOnly: first?.lineOnly,
    }).toStrictEqual({
      who: misheard.who,
      interviewer: "claire",
      opensOnAi: true,
      lines: 6 + misheard.lines.length,
      typedLast: undefined,
      typedBefore: true,
      facts: ["a1", "a2", "a3", ...misheard.facts.map(({ id }) => id)],
      lineOnly: true,
    });
  });

  it.each([
    {
      moment: "claims-mid-sentence",
      turn: stephen({ say: "" }),
      right: 1,
      lineOnly: false,
    },
    {
      moment: "claims-mid-sentence",
      turn: stephen({ say: "Go on?" }),
      right: 0,
      lineOnly: false,
    },
    {
      moment: "claims-wrap-up",
      turn: stephen({ say: "Sure.", wants: "answer" }),
      right: 0,
      lineOnly: true,
    },
    {
      moment: "claims-wrap-up",
      turn: stephen({ say: "Sure.", wants: "readback" }),
      right: 1,
      lineOnly: true,
    },
    {
      moment: "claims-wrap-up-early",
      turn: stephen({ say: "Sure.", wants: "readback" }),
      right: 0,
      lineOnly: true,
    },
    {
      moment: "orders-few-words",
      turn: stephen({ say: "" }),
      right: 0,
      lineOnly: true,
    },
  ])(
    "holds what the turn says where it goes, beside the judge: $moment",
    async ({ moment, turn, right, lineOnly }) => {
      const { stand, asked } = standWith(() => turn, passing);
      const [found] = await benchAsk(stand, [momentNamed(moment)], {
        set: "open",
        interviewer: "stephen",
        keep: ignored,
      });
      expect({
        right: found?.scores.right,
        lineOnly: asked[0]?.lineOnly,
      }).toStrictEqual({
        right,
        lineOnly,
      });
    }
  );

  it("holds a line to any one of the rules when their last line calls for more than one thing", () => {
    const rule = ruleOf(momentNamed("orders-vague-amount"));
    expect({
      either: rule.startsWith("Their last line calls for more than one thing"),
      amount: rule.includes(signalRules["vague amount"]),
      lookUp: rule.includes(signalRules["look it up"]),
      plain: ruleOf(momentNamed("planning-they")),
    }).toStrictEqual({
      either: true,
      amount: true,
      lookUp: true,
      plain: signalRules.they,
    });
  });

  it("counts a line that breaks his own rules, and keeps nothing of the hidden set to read", async () => {
    const { stand } = standWith(
      () => stephen({ say: "Great answer! Who does it, and when?" }),
      passing
    );
    const kept: string[] = [];
    const cases = await benchAsk(stand, [momentNamed("orders-hidden-actor")], {
      set: "hidden",
      interviewer: "stephen",
      keep: (id) => {
        kept.push(id);
      },
    });
    expect({ scores: cases[0]?.scores, kept }).toStrictEqual({
      scores: { right: 1, single: 1, mistakes: 1 },
      kept: [],
    });
  });
});

describe("a round of the next-question bench", () => {
  /** A Stephen who gets a moment right when `rightFor` says so, and a judge who passes only lines that say "right". */
  const runOf = async (rightFor: (moment: number) => boolean) => {
    const moments = handMoments
      .filter((each) => each.signal !== "mid sentence")
      .slice(0, 40);
    let asked = 0;
    const { stand } = standWith(
      () => {
        asked += 1;
        return stephen({ say: rightFor(asked) ? "right" : "wrong" });
      },
      judgeAnswering((call) => ({
        pass: call.input.includes('"line":"right"'),
        single: true,
        why: "",
      }))
    );
    // One at a time, so which moment gets which line is the same in every run.
    const cases: CaseScore[] = [];
    for (const moment of moments) {
      // oxlint-disable-next-line no-await-in-loop -- in order, as said
      const found = await benchAsk(stand, [moment], options);
      cases.push(...found);
    }
    return { cases };
  };

  it("calls what two runs of the same text differ by noise, and a Stephen clearly better than it better", async () => {
    // The same Stephen twice, wrong on a few other moments each time; then one who is right far more often.
    const first = await runOf((at) => at % 4 !== 0);
    const again = await runOf((at) => at % 4 !== 1 && at % 5 !== 0);
    const better = await runOf((at) => at % 20 !== 0);
    const noise = noiseOf([first, again]);
    const verdictOf = (after: { cases: typeof first.cases }) =>
      compare(first, after, noise).find((each) => each.metric === "right")
        ?.verdict;
    expect({
      again: verdictOf(again),
      better: verdictOf(better),
    }).toStrictEqual({
      again: "no difference",
      better: "better",
    });
  });
});

describe("moments cut from played conversations", () => {
  it("cuts where the person left something out, never where he only listens, and with the notes he had then", async () => {
    const played: Transcript = {
      ...conversation,
      lines: [
        { from: "stephen", text: "Walk me through it." },
        { from: "person", text: "it gets approved and then they pay it" },
        { from: "stephen", text: "Who approves it?" },
        { from: "person", text: "sometimes the manager" },
        { from: "stephen", text: "I'll read back what I wrote down." },
      ],
      readbackFrom: 4,
      notesAt: [0, 2],
      phaseAt: ["story", "steps"],
      notes: [
        { id: "f1", tag: "step", text: "The invoice gets approved." },
        { id: "f2", tag: "step", text: "They pay it." },
      ],
    };
    const cut = await mineMoments(
      judgeAnswering(() => ({
        moments: [
          { line: 1, signal: "hidden actor" },
          { line: 3, signal: "vague amount" },
          { line: 2, signal: "they" },
        ],
      })),
      [played]
    );
    expect(
      cut.map(({ id, signal, lines, facts, phase }) => ({
        id,
        signal,
        last: lines.at(-1)?.text,
        notes: facts.length,
        phase,
      }))
    ).toStrictEqual([
      {
        id: "01-p1-ab12-3",
        signal: "vague amount",
        last: "sometimes the manager",
        notes: 2,
        phase: "steps",
      },
    ]);
  });
});

/** A drawing as core keeps it, from `from`, with `steps`. */
const drawn = (from: string[], steps: string[]) => ({
  at: "2026-10-23T09:00:00.000Z",
  from,
  starts: "An invoice comes in by email.",
  steps: steps.map((text) => ({
    text,
    who: "Accounts payable clerk",
    tool: "",
    minutes: null,
    documented: false,
  })),
  waits: [],
  differently: [],
  decides: "",
  own: "",
  ai: "",
  right: "",
  ask: "",
  next: "",
  term: null,
  differs: null,
  per: "week",
  unit: "minutes",
  told: {},
  open: [],
});

describe("the drawing bench", () => {
  it("judges the drawing that rests on the key's people against the key, and keeps its card to read", async () => {
    const key = keyOf("01");
    const employee = key?.employees[0];
    if (key === undefined || employee === undefined) {
      throw new Error("Key 01 is gone.");
    }
    const { stand } = standWith(
      () => stephen({}),
      judgeAnswering(() => ({
        key: [
          { id: "TR", found: ["start"] },
          { id: "S1", found: ["s1"] },
        ],
        numbers: [],
        elements: [
          { id: "s1", verdict: "said" },
          { id: "s2", verdict: "not said" },
        ],
      })),
      async () =>
        await Promise.resolve([
          {
            work: "other",
            name: "Other work",
            drawn: drawn(["someone-else"], ["Something else."]),
          },
          {
            work: "invoices",
            name: "Booking invoices",
            drawn: drawn(["01-ab12-p1"], ["Open the invoice.", "Pay it."]),
          },
          { work: "broken", name: "Not a drawing", drawn: { steps: "none" } },
        ])
    );
    const kept: string[] = [];
    const { cases, card } = await benchDraw(
      stand,
      {
        id: "01-ab12",
        key,
        tellers: [
          {
            employee,
            person: "01-ab12-p1",
            agreed: ["(step) Open the invoice."],
          },
        ],
        said: ["TR", "S1"],
      },
      {
        set: "open",
        keep: (id) => {
          kept.push(id);
        },
      }
    );
    expect({
      cases,
      missed: card?.found.missed,
      notSaid: card?.supported.notSaid,
      kept,
    }).toStrictEqual({
      cases: [
        {
          id: "01-ab12",
          scores: {
            found: 1,
            order: 1,
            numbers: 0,
            supported: 0.5,
            repeats: 0,
            notSaid: 0.5,
            steps: 2,
          },
        },
      ],
      missed: [],
      notSaid: ["Pay it. [Accounts payable clerk]"],
      kept: ["01-ab12"],
    });
  });
});

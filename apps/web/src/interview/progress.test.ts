import type { StephenTurn } from "@grasp-os/shared/interview-turn";
import { describe, expect, it } from "vite-plus/test";

import {
  afterTurn,
  approved,
  freshProgress,
  markedPieces,
  openingEvent,
  reopened,
  withFactToggled,
  withLine,
} from "./progress.ts";

// From the prototype's `data/interviews.ts` (`takeTurn`), which these steps
// are ported from.

const turn = (more: Partial<StephenTurn> = {}): StephenTurn => ({
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

const said = withLine(
  withLine(freshProgress, { from: "stephen", text: "What do you do first?" }),
  { from: "person", text: "I open the invoice in Exact.", typed: true }
);

describe("a turn of Stephen's", () => {
  it("marks his quotes on the line it answered, writes each fact down once, and moves on", () => {
    const after = afterTurn(
      said,
      turn({
        facts: [
          {
            tag: "system",
            text: "You open the invoice in Exact.",
            record: "Open the invoice in Exact.",
            quote: "in Exact",
          },
          {
            tag: "step",
            text: "You open the invoice in Exact",
            record: "Open the invoice.",
            quote: "",
          },
        ],
        wants: "readback",
      }),
      { answered: 1 }
    );
    expect({
      marks: after.lines[1]?.marks,
      facts: after.facts,
      phase: after.phase,
      wants: after.wants,
    }).toStrictEqual({
      marks: [{ quote: "in Exact", tag: "system" }],
      facts: [
        {
          id: "f1",
          tag: "system",
          text: "You open the invoice in Exact.",
          record: "Open the invoice in Exact.",
        },
      ],
      phase: "steps",
      wants: "readback",
    });
  });

  it("puts right or takes out what it changes, to be read back again, and pins what is new to the part on screen", () => {
    const first = approved(
      afterTurn(
        said,
        turn({
          facts: [
            { tag: "step", text: "One.", record: "One.", quote: "" },
            { tag: "step", text: "Two.", record: "Two.", quote: "" },
          ],
        }),
        { answered: 1 }
      )
    );
    const after = afterTurn(
      reopened(first),
      turn({
        facts: [{ tag: "rule", text: "Three.", record: "Three.", quote: "" }],
        changes: [
          { id: "f1", text: "One, put right.", record: "One, put right." },
          { id: "f2", text: null, record: null },
        ],
      }),
      { answered: 1, pin: 0 }
    );
    expect(after.facts).toStrictEqual([
      {
        id: "f1",
        tag: "step",
        text: "One, put right.",
        record: "One, put right.",
      },
      { id: "f2", tag: "step", text: "Two.", record: "Two.", out: true },
      { id: "f3", tag: "rule", text: "Three.", record: "Three.", pin: 0 },
    ]);
  });
});

describe("where a conversation starts", () => {
  it.each([
    ["nothing said", freshProgress, "start"],
    ["an answer he never answered", said, "answer"],
    [
      "after his line",
      withLine(said, { from: "stephen", text: "And then?" }),
      "resume",
    ],
    ["back to add something", reopened(approved(said)), "add"],
  ])("with %s", (_name, progress, event) => {
    expect(openingEvent(progress)).toBe(event);
  });
});

describe("a line of the read-back", () => {
  it("is taken out and put back", () => {
    const written = afterTurn(
      said,
      turn({
        facts: [{ tag: "step", text: "One.", record: "One.", quote: "" }],
      }),
      { answered: 1 }
    );
    const out = withFactToggled(written, "f1");
    expect([
      out.facts[0]?.out,
      withFactToggled(out, "f1").facts[0]?.out,
    ]).toStrictEqual([true, undefined]);
  });
});

describe("what someone said, in pieces", () => {
  it("marks the words Stephen quoted, whatever their capitals, and never one mark inside another", () => {
    expect(
      markedPieces("I check it in Exact, then send it.", [
        { quote: "in exact", tag: "system" },
        { quote: "Exact", tag: "term" },
        { quote: "not said", tag: "step" },
      ])
    ).toStrictEqual([
      { at: 0, text: "I check it ", tag: null },
      { at: 11, text: "in Exact", tag: "system" },
      { at: 19, text: ", then send it.", tag: null },
    ]);
  });
});

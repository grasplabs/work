import type { FactTag } from "@grasp-os/shared/interview-turn";
import { describe, expect, it } from "vite-plus/test";

import { withoutNames } from "../src/onboarding/brain-intake.ts";
import { namedIn } from "../src/onboarding/names.ts";
import { stillOpen } from "../src/onboarding/still-open.ts";
import { tellsHowItGoes, toldAbout } from "../src/onboarding/told-work.ts";
import type { ToldParts } from "../src/onboarding/told-work.ts";

// What an interview still misses (src/onboarding/still-open.ts) and what
// the team already told about a piece of work (src/onboarding/told-work.ts),
// as Stephen is given both each turn: pure logic, so tested on its own.
// The ways they can fail, tried here:
//
// - Asking for what is written down, or never for what is not.
// - Asking again for what someone had nothing to say about: a thing stays
//   open after the interview has passed its part, so a "no" is asked twice
//   and the list never empties.
// - A colleague's name reaching someone else's interviewer: in a line a
//   model wrote, as the one who does a step, or as whose numbers they are;
//   written without its accent or with an "s".
// - The Brain's own filter of names taking ordinary words out of what
//   people read.
// - More of it than a brief should carry.

const facts = (...tags: FactTag[]) => tags.map((tag) => ({ tag }));

describe("what an employee's interview still misses", () => {
  it("starts with their week, then the one piece, in the order of the interview, five at most", () => {
    expect(stillOpen("own", [], "open")).toStrictEqual([
      "which work comes back every day or week, and how often",
      "the story of the last one, step by step",
      "where they do it: which system or screen",
      "who gets it after them, and how",
      "where it waits, and for what",
    ]);
  });

  it("asks what they would hand off once they named what comes back, and not once they said", () => {
    expect(stillOpen("own", facts("task", "task"), "week")[0]).toBe(
      "which of it they would hand off first"
    );
    expect(stillOpen("own", facts("task", "wish"), "week")[0]).toBe(
      "the story of the last one, step by step"
    );
  });

  it("leaves their week alone once the interview is at the one piece", () => {
    expect(stillOpen("own", [], "anchor")[0]).toBe(
      "the story of the last one, step by step"
    );
  });

  it("asks for nothing that is written down", () => {
    const written = facts(
      "task",
      "wish",
      "step",
      "step",
      "step",
      "system",
      "handoff",
      "wait",
      "number"
    );
    expect(stillOpen("own", written, "exceptions")).toStrictEqual([
      "when it does not go like that, how many out of ten",
      "how they decide, and what tells them it is okay",
      // One number is not the two he never leaves without.
      "how many in a normal week, and how long one takes",
      "how they know it is done right",
      "when they would stop and ask someone",
    ]);
  });

  it("lets go of what its part has passed: an answer that left no fact is not asked for again", () => {
    expect({
      atNumbers: stillOpen("own", [], "numbers"),
      atResult: stillOpen("own", [], "result"),
      afterAi: stillOpen("own", [], "you"),
    }).toStrictEqual({
      atNumbers: [
        "how many in a normal week, and how long one takes",
        "how they know it is done right",
        "when they would stop and ask someone",
        "one real example to share",
        "whether they use AI for any of this (one short question)",
      ],
      atResult: [
        "how they know it is done right",
        "when they would stop and ask someone",
        "one real example to share",
        "whether they use AI for any of this (one short question)",
      ],
      afterAi: [],
    });
  });

  it("asks about AI once, and not of someone a fact says uses it", () => {
    const all = facts("done", "stop", "case");
    expect({
      beforeAi: stillOpen("own", all, "result"),
      used: stillOpen("own", [...all, ...facts("ai")], "result"),
    }).toStrictEqual({
      beforeAi: ["whether they use AI for any of this (one short question)"],
      used: [],
    });
  });
});

describe("what a lead's interview still misses", () => {
  it("starts with the team's work, and follows the lead's own parts", () => {
    expect({
      start: stillOpen("lead", [], "open"),
      named: stillOpen("lead", facts("work", "work"), "story"),
      counted: stillOpen("lead", facts("work", "number", "wait"), "result"),
      asked: stillOpen("lead", facts("work", "number", "wait"), "you"),
    }).toStrictEqual({
      start: [
        "which work the team does that comes back, one piece at a time",
        "which piece takes the most time, and which goes wrong most often",
        "for each piece: about how many in a normal week, and how long one takes",
        "whom to talk to first about each piece of work",
        "whether the team uses AI in the work (one short question)",
      ],
      named: [
        "who in the team does each piece, by name",
        "which piece takes the most time, and which goes wrong most often",
        "for each piece: about how many in a normal week, and how long one takes",
        "whom to talk to first about each piece of work",
        "whether the team uses AI in the work (one short question)",
      ],
      counted: ["whether the team uses AI in the work (one short question)"],
      asked: [],
    });
  });
});

const drawing = (parts: Partial<ToldParts>): ToldParts => ({
  starts: "",
  steps: [],
  waits: [],
  differently: [],
  decides: "",
  next: "",
  right: "",
  ask: "",
  ...parts,
});

const step = (text: string): ToldParts["steps"][number] => ({
  text,
  who: "",
  tool: "",
  minutes: null,
  documented: false,
});

const staff = [
  "Inge de Vries",
  "Mo Mertens",
  "Anne-Marie O'Neil",
  "Jo Li",
  "José Peña",
  "Alexander Berg",
  "Will Hart",
  "An Peeters",
];

describe("a line that holds a name from the staff list", () => {
  const named = namedIn(staff);

  it("is found whatever the name's capitals or accents, in part, and with an s", () => {
    const lines = [
      "Ask Inge de Vries.",
      "Ask Jose when the number is missing.",
      "It is on Joses list.",
      "Forward it to marie's inbox.",
      "Send it to PEETERS.",
      "It will go out the same day.",
    ];
    expect(lines.filter((line) => !named(line))).toStrictEqual([]);
  });

  it("is not found in a line without one, or in a longer word a name is part of", () => {
    const lines = [
      "Open the invoice.",
      "Check the willing suppliers.",
      "Book it in Exact.",
    ];
    expect(lines.filter((line) => named(line))).toStrictEqual([]);
  });
});

describe("a statement the Brain keeps", () => {
  it("loses a colleague's name and keeps the word someone is also called", () => {
    const clean = withoutNames(["Tom Price", "Noor Nijs"]);
    expect([
      clean("Check the price list."),
      clean("Ask Noor for the price list."),
    ]).toStrictEqual([
      "Check the price list.",
      "Ask someone for the price list.",
    ]);
  });
});

describe("what the team already told about a piece of work", () => {
  it("counts as told by someone only what says how the work goes", () => {
    expect({
      wish: tellsHowItGoes(facts("wish", "ai", "workaround", "number", "task")),
      step: tellsHowItGoes(facts("wish", "step")),
      none: tellsHowItGoes([]),
    }).toStrictEqual({ wish: false, step: true, none: false });
  });

  it("tells how the work goes, in the order of the drawing", () => {
    expect(
      toldAbout(
        "incoming invoices",
        drawing({
          starts: "An invoice arrives by email.",
          steps: [step("Open the invoice."), step("Match it to the order.")],
          waits: ["For the budget holder's approval."],
          differently: [
            {
              when: "the order is missing",
              does: "",
              outOfTen: null,
              after: 1,
            },
          ],
          decides: "The amount against the order.",
          next: "Finance, which pays it.",
        }),
        ["Inge de Vries", "Mo Mertens"]
      )
    ).toBe(
      [
        "What the team already told about incoming invoices (how it goes, no names):",
        "- An invoice arrives by email.",
        "- Open the invoice.",
        "- Match it to the order.",
        "- It waits: For the budget holder's approval.",
        "- Sometimes the order is missing.",
        "- They decide by: The amount against the order.",
        "- After them: Finance, which pays it.",
      ].join("\n")
    );
  });

  it("leaves out every line that holds a name from the staff list, and tells nothing when none is left", () => {
    expect({
      lines: toldAbout(
        "incoming invoices",
        drawing({
          steps: [
            step("Open the invoice."),
            step("Ask Jose when the number is missing."),
            step("Put it on Inges list."),
            step("Send it to Mo."),
          ],
        }),
        staff
      ),
      nothing: toldAbout(
        "incoming invoices",
        drawing({ steps: [step("Inge books it.")] }),
        staff
      ),
    }).toStrictEqual({
      lines: [
        "What the team already told about incoming invoices (how it goes, no names):",
        "- Open the invoice.",
      ].join("\n"),
      nothing: "",
    });
  });

  it("tells no more than a brief should carry, in whole lines", () => {
    const long = toldAbout(
      "incoming invoices",
      drawing({
        steps: Array.from({ length: 30 }, (_, index) =>
          step(`Step ${index + 1} ${"of the same work ".repeat(8)}`.trim())
        ),
      }),
      staff
    );
    expect({
      lines: long.split("\n").length <= 13,
      letters: long.length <= 1200,
      whole: long
        .split("\n")
        .slice(1)
        .every((line) => line.endsWith("work")),
    }).toStrictEqual({ lines: true, letters: true, whole: true });
  });
});

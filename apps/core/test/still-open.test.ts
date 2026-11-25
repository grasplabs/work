import type { DrawnWork } from "@grasp-os/shared/admin/org-record";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import { describe, expect, it } from "vite-plus/test";

import { withoutNames } from "../src/onboarding/names.ts";
import { stillOpen } from "../src/onboarding/still-open.ts";
import { toldAbout } from "../src/onboarding/told-work.ts";

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
//   written without its accent, with an "s", or as a short form.
// - Ordinary words lost because someone is called Will or An.
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

const drawn = (parts: Partial<DrawnWork>): DrawnWork => ({
  at: "2026-11-25T10:00:00.000Z",
  from: ["p1"],
  starts: "",
  steps: [],
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
  ...parts,
});

const step = (text: string, who = "Clerk", tool = "") => ({
  text,
  who,
  tool,
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

describe("a name from the staff list in a text", () => {
  const clean = withoutNames(staff);

  it("goes, whole or in part, without its accent, with an s, or as a short form", () => {
    expect(
      [
        "Ask Inge de Vries.",
        "Ask José, or Jose's lead.",
        "It lies on Inges desk.",
        "Check with Alex first.",
        "Marie and Mo sign it.",
        "Send it to PEETERS.",
      ].map((text) => clean(text))
    ).toStrictEqual([
      "Ask someone someone someone.",
      "Ask someone, or someone's lead.",
      "It lies on someone desk.",
      "Check with someone first.",
      "Someone and someone sign it.",
      "Send it to someone.",
    ]);
  });

  it("leaves the words a short name is also: only written as a name it goes", () => {
    const plain = [
      "It will go out the same day.",
      "Attach an order to it.",
      "The order follows in the same mo.",
      "Take it to heart.",
    ];
    expect({
      plain: plain.map((text) => clean(text)),
      named: clean("Then Will takes it to An."),
      // With a capital it can't be told from the name: better a word lost.
      first: clean("An order follows."),
    }).toStrictEqual({
      plain,
      named: "Then someone takes it to someone.",
      first: "Someone order follows.",
    });
  });
});

describe("what the team already told about a piece of work", () => {
  it("tells how the work goes and what is still open, without who does a step, anyone's own list or what they use AI for", () => {
    expect(
      toldAbout(
        "incoming invoices",
        drawn({
          starts: "An invoice arrives by email.",
          steps: [
            step("Open the invoice.", "Inge", "Exact"),
            step("Match it to the order."),
          ],
          waits: ["For the budget holder's approval."],
          differently: [
            { when: "the order is missing", does: "", outOfTen: 2, after: 1 },
          ],
          decides: "The amount against the order.",
          own: "A sheet of late suppliers.",
          ai: "ChatGPT for reminder emails.",
          next: "Finance, which pays it.",
          open: ["Who approves above the limit?"],
        }),
        ["Inge de Vries", "Mo Mertens"]
      )
    ).toBe(
      [
        "What the team already told about incoming invoices (how it goes, no names):",
        "- An invoice arrives by email.",
        "- Open the invoice. (Exact)",
        "- Match it to the order.",
        "- It waits: For the budget holder's approval.",
        "- Sometimes the order is missing.",
        "- They decide by: The amount against the order.",
        "- After them: Finance, which pays it.",
        "Still open about it: Who approves above the limit?",
      ].join("\n")
    );
  });

  it("leaves out every line in which a name from the staff list is found, and names the work when only what is open is left", () => {
    expect({
      lines: toldAbout(
        "incoming invoices",
        drawn({
          steps: [
            step("Open the invoice."),
            step("Ask Inge when the number is missing."),
            step("Send it to Mo."),
            step("Forward it to Marie's inbox."),
            step("Put it on Joses tray."),
            step("Check with Alex first."),
            step("It will go out the same day."),
          ],
          open: ["Why does De Vries check each one?", "What does Li do then?"],
        }),
        staff
      ),
      open: toldAbout(
        "incoming invoices",
        drawn({
          steps: [step("Inge books it.")],
          open: ["Who approves above the limit?"],
        }),
        staff
      ),
    }).toStrictEqual({
      lines: [
        "What the team already told about incoming invoices (how it goes, no names):",
        "- Open the invoice.",
        "- It will go out the same day.",
      ].join("\n"),
      open: "Still open about incoming invoices: Who approves above the limit?",
    });
  });

  it("tells nothing when nothing may be told, and no more than a brief should carry", () => {
    const long = toldAbout(
      "incoming invoices",
      drawn({
        steps: Array.from({ length: 30 }, (_, index) =>
          step(`Step ${index + 1} ${"of the same work ".repeat(8)}`.trim())
        ),
        open: ["What comes after?"],
      }),
      staff
    );
    expect({
      nothing: toldAbout(
        "incoming invoices",
        drawn({ steps: [step("Inge books it.")], own: "A sheet." }),
        staff
      ),
      lines: long.split("\n").length <= 14,
      letters: long.length <= 1200,
      whole: long
        .split("\n")
        .slice(1)
        .every((line) => line.endsWith("work")),
    }).toStrictEqual({ nothing: "", lines: true, letters: true, whole: true });
  });
});

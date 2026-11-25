import type { DrawnWork } from "@grasp-os/shared/admin/org-record";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import { describe, expect, it } from "vite-plus/test";

import { stillOpen } from "../src/onboarding/still-open.ts";
import { toldAbout } from "../src/onboarding/told-work.ts";

// What an interview still misses (src/onboarding/still-open.ts) and what
// the team already told about a piece of work (src/onboarding/told-work.ts),
// as Stephen is given both each turn: pure logic, so tested on its own.
// The ways they can fail, tried here:
//
// - Asking for what is written down, or never for what is not.
// - Asking again for what someone had nothing to say about: their week once
//   the interview moved on, AI once it was asked.
// - A colleague's name reaching someone else's interviewer: in a line a
//   model wrote, as the one who does a step, or as whose numbers they are.
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
      "exception",
      "number"
    );
    expect(stillOpen("own", written, "numbers")).toStrictEqual([
      // One number is not the two he never leaves without.
      "how many in a normal week, and how long one takes",
      "how they decide, and what tells them it is okay",
      "how they know it is done right",
      "when they would stop and ask someone",
      "whether they use AI for any of this (one short question)",
    ]);
  });

  it("has nothing left once it is all there, and asks about AI once: not again of someone who had nothing to say", () => {
    const all = facts(
      "task",
      "wish",
      "step",
      "step",
      "step",
      "system",
      "next",
      "wait",
      "exception",
      "number",
      "number",
      "rule",
      "done",
      "stop"
    );
    expect({
      beforeAi: stillOpen("own", all, "result"),
      afterAi: stillOpen("own", all, "you"),
      used: stillOpen("own", [...all, ...facts("ai")], "result"),
    }).toStrictEqual({
      beforeAi: ["whether they use AI for any of this (one short question)"],
      afterAi: [],
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

const staff = ["Inge de Vries", "Mo Mertens", "Anne-Marie O'Neil", "Jo Li"];

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
        staff
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

  it("leaves out every line that holds a word of anyone's name on the staff list", () => {
    const told = toldAbout(
      "incoming invoices",
      drawn({
        steps: [
          step("Open the invoice."),
          step("Ask inge when the number is missing."),
          step("Send it to Mo."),
          step("Forward it to Marie's inbox."),
          step("Mrs O'Neil signs it."),
          step("Put it in Jo's tray."),
          // "de" is a word of a name as it is written, so its line goes;
          // "mo" in small letters is no name.
          step("Book it under de minimis."),
          step("File it the same mo as it came."),
        ],
        open: ["Why does De Vries check each one?", "What does Li do then?"],
      }),
      staff
    );
    expect(told).toBe(
      [
        "What the team already told about incoming invoices (how it goes, no names):",
        "- Open the invoice.",
        "- File it the same mo as it came.",
      ].join("\n")
    );
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

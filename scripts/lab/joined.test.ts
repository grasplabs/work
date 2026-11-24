/**
 * A drawing against its key (joined.ts): what is found, the order along
 * the drawing, each person's own numbers, and what the drawing rests on.
 * The judgments come in; the sums are pure, tested on their own.
 */
import { describe, expect, it } from "vite-plus/test";

import { elementsOf, joinedCardOf, joinedScores, numbersOf } from "./joined.ts";
import type { Drawing, JoinedJudged } from "./joined.ts";
import type { AnswerKey } from "./keys/types.ts";

const key: AnswerKey = {
  id: "t",
  name: "Handling orders",
  type: "normal",
  company: {
    name: "Voorbeeld B.V.",
    sector: "Wholesale",
    size: 40,
    offices: ["Utrecht"],
  },
  brief: "",
  procedure: "",
  roles: { R1: { name: "Order clerk", team: "Sales" } },
  facts: [
    {
      id: "TR",
      type: "trigger",
      text: "An order comes in by phone.",
      next: ["S1"],
    },
    {
      id: "S1",
      type: "step",
      text: "Enter the order.",
      role: "R1",
      next: ["S2"],
    },
    {
      id: "S2",
      type: "step",
      text: "Check the stock.",
      role: "R1",
      next: ["S3"],
    },
    { id: "S3", type: "step", text: "Send the pick list.", role: "R1" },
    {
      id: "E1",
      type: "exception",
      text: "Email the buyer.",
      condition: "The item is not in stock.",
      rate: "2 in 10",
      after: "S2",
    },
    {
      id: "N1",
      type: "number",
      text: "Orders per week",
      value: 250,
      unit: "per week",
    },
  ],
  startWith: "P1",
  employees: [
    {
      id: "P1",
      name: "Eva Smit",
      role: "R1",
      leadSays: "",
      knows: ["TR", "S1", "S2", "S3", "E1", "N1"],
      remembers: { N1: "two hundred or so" },
    },
  ],
};

const step = (text: string, tool = "") => ({ text, who: "Order clerk", tool });

const drawn: Drawing = {
  from: ["p-p1"],
  starts: "An order comes in by phone.",
  steps: [
    step("Enter the order.", "AFAS"),
    step("Look up the customer."),
    step("Send the pick list."),
    step("Check the stock."),
  ],
  waits: ["The order waits for the buyer."],
  differently: [
    {
      when: "the item is not in stock",
      does: "Email the buyer.",
      outOfTen: 2,
      after: 3,
    },
  ],
  decides: "",
  own: "An own list of open orders",
  ai: "",
  right: "",
  ask: "",
  next: "",
  term: null,
  per: "week",
  unit: "minutes",
  told: {},
  open: ["Who sends the invoice?"],
};

const judged: JoinedJudged = {
  key: [
    { id: "TR", found: ["start"] },
    { id: "S1", found: ["s1"] },
    { id: "S2", found: ["s4"] },
    { id: "S3", found: ["s3", "made-up"] },
    { id: "E1", found: ["d1"] },
  ],
  numbers: [{ id: "N1", person: "Eva Smit", kept: false }],
  elements: [
    { id: "s1", verdict: "said" },
    { id: "s2", verdict: "not said" },
    { id: "s3", verdict: "said" },
    { id: "s4", verdict: "said" },
    { id: "w1", verdict: "repeat" },
  ],
};

describe("a drawing against its key", () => {
  it("names every part of a drawing, with its place in the order", () => {
    expect(
      elementsOf(drawn).map((element) => [element.id, element.place])
    ).toStrictEqual([
      ["start", 0],
      ["s1", 1],
      ["s2", 2],
      ["s3", 3],
      ["s4", 4],
      ["w1", null],
      ["d1", 4.5],
      ["own", null],
    ]);
  });

  it("counts what is found and the order along the drawing, what it rests on, and a part the judge skipped as not said", () => {
    const card = joinedCardOf(key, drawn, judged, 1);
    expect({ card, scores: joinedScores(card) }).toStrictEqual({
      card: {
        found: { count: 5, of: 5, missed: [] },
        // TR → S1 and S1 → S2 stand in order, with a step between them; S2 → S3 is swapped; E1 comes after S2.
        order: { count: 3, of: 4 },
        numbers: { count: 0, of: 1, lost: ["Eva Smit: N1"] },
        supported: {
          count: 3,
          repeats: 1,
          notSaid: [
            "Look up the customer. [Order clerk]",
            "When the item is not in stock: Email the buyer. (2 in 10)",
          ],
          of: 6,
        },
        steps: 4,
        open: 1,
      },
      scores: {
        found: 1,
        order: 0.75,
        numbers: 0,
        supported: 0.5,
        repeats: 1 / 6,
        notSaid: 2 / 6,
        steps: 4,
      },
    });
  });

  it("holds the drawing only to what someone said", () => {
    const missing: JoinedJudged = {
      ...judged,
      key: judged.key.filter((each) => each.id !== "S3"),
    };
    expect({
      all: joinedCardOf(key, drawn, missing, 1).found,
      said: joinedCardOf(key, drawn, missing, 1, ["TR", "S1", "S2", "E1"])
        .found,
    }).toStrictEqual({
      all: { count: 4, of: 5, missed: ["S3"] },
      said: { count: 4, of: 4, missed: [] },
    });
  });

  it("asks about every number each teller knows, as they remember it", () => {
    const [employee] = key.employees;
    expect(
      employee === undefined
        ? []
        : numbersOf(key, [{ employee, person: "p-p1", agreed: [] }])
    ).toStrictEqual([
      {
        id: "N1",
        person: "Eva Smit",
        what: "Orders per week (per week)",
        remembered: "two hundred or so",
      },
    ]);
  });
});

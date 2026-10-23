/**
 * The answer keys (types.ts, index.ts): every open key can be used, what
 * one person knows holds only their own version of the truth, and the
 * hidden test set is never read from inside the repository.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  HiddenSetError,
  hiddenFolder,
  keyOf,
  openKeys,
  repoRoot,
} from "./index.ts";
import { problemsIn, sliceOf } from "./types.ts";
import type { AnswerKey, KeyEmployee } from "./types.ts";

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
  roles: {
    R1: { name: "Order clerk", team: "Sales" },
    R2: { name: "Planner", team: "Logistics" },
  },
  facts: [
    {
      id: "S1",
      type: "step",
      text: "Enter the order in the order system.",
      role: "R1",
      system: "AFAS",
      next: ["D1"],
    },
    {
      id: "D1",
      type: "decision",
      text: "Is the item in stock?",
      role: "R1",
      branches: { yes: "S2", no: "E1" },
    },
    {
      id: "E1",
      type: "exception",
      text: "Email the buyer.",
      condition: "The item is not in stock.",
      rate: "2 in 10",
      role: "R1",
    },
    {
      id: "S2",
      type: "step",
      text: "Plan the delivery.",
      role: "R2",
      system: "AFAS",
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
      leadSays: "Enters most orders.",
      knows: ["S1", "D1", "E1", "N1"],
      remembers: { N1: "two hundred or so" },
      beliefs: { E1: "Call the buyer." },
      mentions: ["P2"],
    },
    {
      id: "P2",
      name: "Jan Bos",
      role: "R2",
      leadSays: "Plans the deliveries.",
      knows: ["S2", "N1"],
    },
  ],
};

describe("every answer key", () => {
  it("can be used", () => {
    expect(
      Object.values(openKeys).flatMap((each) => problemsIn(each))
    ).toStrictEqual([]);
  });

  it("says what is wrong with one that cannot", () => {
    const broken: AnswerKey = {
      ...key,
      facts: [
        ...key.facts,
        { id: "S9", type: "step", text: "Send the invoice.", next: ["S10"] },
      ],
    };
    expect(problemsIn(broken)).toStrictEqual([
      "Fact S9 leads to S10, which is not there.",
      "Nobody knows fact S9.",
    ]);
  });
});

/** Eva, who enters the orders. */
const evaOf = (of: AnswerKey): KeyEmployee => {
  const [first] = of.employees;
  if (first === undefined) {
    throw new Error("The key has nobody.");
  }
  return first;
};

describe("what one person knows", () => {
  const [eva, jan] = key.employees.map((employee) => sliceOf(key, employee));

  it("holds a number as they remember it, never its true value", () => {
    expect({
      eva: eva?.find((fact) => fact.id === "N1")?.remembered,
      evaKnowsTruth: JSON.stringify(eva).includes("250"),
      jan: jan?.find((fact) => fact.id === "N1")?.remembered,
    }).toStrictEqual({
      eva: "two hundred or so",
      evaKnowsTruth: false,
      jan: "about 250",
    });
  });

  it("holds what they believe in place of what is true", () => {
    expect(eva?.find((fact) => fact.id === "E1")).toMatchObject({
      text: "Call the buyer.",
      outdated: true,
      howOften: "2 in 10",
    });
  });

  it("says what kind of question brings a fact out, and none for what comes with the story", () => {
    const told = sliceOf(
      {
        ...key,
        facts: key.facts.map((fact) =>
          fact.id === "E1"
            ? {
                ...fact,
                toldWhen: "asked about the last order that went wrong",
              }
            : fact
        ),
      },
      evaOf(key)
    );
    expect({
      story: eva?.find((fact) => fact.id === "S1")?.toldWhen,
      number: eva?.find((fact) => fact.id === "N1")?.toldWhen,
      own: told.find((fact) => fact.id === "E1")?.toldWhen,
    }).toStrictEqual({
      story: null,
      number: "asked for this number",
      own: "asked about the last order that went wrong",
    });
  });

  it("knows where a decision leads only as far as they know the next step", () => {
    expect({
      options: eva?.find((fact) => fact.id === "D1")?.options,
      next: eva?.find((fact) => fact.id === "S1")?.next,
    }).toStrictEqual({
      options: [
        { answer: "yes", leads: null },
        { answer: "no", leads: "Call the buyer." },
      ],
      next: ["Is the item in stock?"],
    });
  });
});

describe("the hidden test set", () => {
  it("is not in the repository: no open key is one of its keys", () => {
    expect(Object.keys(openKeys)).not.toContain("03");
  });

  it("is never read from a folder inside the repository", () => {
    expect(() =>
      hiddenFolder(path.join(repoRoot, "scripts/lab/hidden"))
    ).toThrow(HiddenSetError);
  });

  it("is read from its own folder outside it, held to the shape of a key", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "lab-hidden-"));
    mkdirSync(path.join(folder, "keys"));
    writeFileSync(
      path.join(folder, "keys", "03.json"),
      JSON.stringify({ ...key, id: "03" })
    );
    const before = process.env.LAB_HIDDEN;
    process.env.LAB_HIDDEN = folder;
    try {
      expect(keyOf("03")?.name).toBe("Handling orders");
    } finally {
      if (before === undefined) {
        delete process.env.LAB_HIDDEN;
      } else {
        process.env.LAB_HIDDEN = before;
      }
    }
  });

  it("asks for its folder rather than reading anything without one", () => {
    expect(() => hiddenFolder("")).toThrow(HiddenSetError);
  });
});

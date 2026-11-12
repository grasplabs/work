import { describe, expect, it } from "vite-plus/test";

import { exactsOf, foundIn } from "../src/exact.ts";

// What a question asks for as written: its quoted phrases and IDs, read by
// fixed rules from the question alone. Finding them in the store, with
// access, is tested in apps/core (brain-next-pack.test.ts).

/** Each exact part of `question`: as asked, and by which rule. */
const partsOf = (question: string) =>
  exactsOf(question).map(({ asked, kind }) => ({ asked, kind }));

/** Whether `text` holds the one exact part of `question` as written. */
const holds = (question: string, text: string): boolean =>
  foundIn(text, exactsOf(question), [0]).length === 1;

describe("the exact parts of a question", () => {
  it("reads quoted phrases, then IDs, each once, and leaves names and dates to the words way", () => {
    expect(
      partsOf(
        `Did Anna Jansen sign "het nieuwe contract" for PO-77812 on 14 maart 2026, and PO-77812 again?`
      )
    ).toStrictEqual([
      { asked: "het nieuwe contract", kind: "phrase" },
      { asked: "PO-77812", kind: "id" },
    ]);
  });

  it("takes a word with a digit and a letter or a separator, or a bare number of five digits, as an ID, and nothing else", () => {
    expect(
      partsOf(
        "Is INV-2024-0042, 2024/0042, PO12345, A12 or order 40417 due in 2026, at 4400 or for 12 days?"
      )
    ).toStrictEqual([
      { asked: "INV-2024-0042", kind: "id" },
      { asked: "2024/0042", kind: "id" },
      { asked: "PO12345", kind: "id" },
      { asked: "A12", kind: "id" },
      { asked: "40417", kind: "id" },
    ]);
  });

  it("finds a phrase's words only in a row and in order, whatever their case and accents", () => {
    const question = `Wie schreef "financiële Planning"?`;
    expect(holds(question, "Over de Financiele planning van mei")).toBeTruthy();
    expect(holds(question, "planning, financiële")).toBeFalsy();
    expect(holds(question, "financiële en planning")).toBeFalsy();
  });

  it("finds an ID as its words in a row, apart however it is written", () => {
    expect(holds("PO-77812", "order PO 77812 arrived")).toBeTruthy();
    expect(holds("PO-77812", "order PO/77812 arrived")).toBeTruthy();
    expect(holds("PO-77812", "order PO-778120 arrived")).toBeFalsy();
    expect(holds("PO-77812", "77812 PO")).toBeFalsy();
  });

  it("takes nothing of a question with no exact part, and at most eight", () => {
    expect(partsOf("what do we pay for travel in 2026")).toStrictEqual([]);
    expect(
      partsOf(
        Array.from({ length: 12 }, (_, index) => `ID-${index + 100}`).join(" ")
      )
    ).toHaveLength(8);
  });
});

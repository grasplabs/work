import { describe, expect, it } from "vite-plus/test";

import { exactsOf, foundIn } from "../src/exact.ts";
import { sequenceOf } from "../src/words.ts";

// What a question asks for as written: its quoted phrases and IDs, read by
// fixed rules from the question alone. Finding them in the store, with
// access, is tested in apps/core (brain-next-pack.test.ts).

/** Each exact part of `question`: as asked, and by which rule. */
const partsOf = (question: string) =>
  exactsOf(question).map(({ asked, kind }) => ({ asked, kind }));

/** Whether `text` holds the one exact part of `question` as written. */
const holds = (question: string, text: string): boolean =>
  foundIn(sequenceOf(text), exactsOf(question), [0]).length === 1;

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

  it("takes a word with a letter and two digits, or five digits in a row, as an ID, and nothing else", () => {
    const ids = [
      "PO-17",
      "A12",
      "INV-2024-0042",
      "TK-5531",
      "CN-2026-118",
      "12345",
      "06-12345678",
      // Known and accepted: names of a kind.
      "v2.1",
      "4x4",
      "COVID-19",
    ];
    const words = [
      "2026-03-14",
      "09:30",
      "14:00-15:00",
      "1.250,00",
      "12.5",
      "1/2",
      "2026",
      "4400",
      "2024/0042",
      "2e",
      "3rd",
      "9am",
      "A4",
      "Q3",
      "MP3",
      "v2",
      // Four digits: found as a word.
      "#4521",
    ];
    expect(
      [...ids, ...words].map((written) => ({
        written,
        id: partsOf(`about ${written} please`).length === 1,
      }))
    ).toStrictEqual([
      ...ids.map((written) => ({ written, id: true })),
      ...words.map((written) => ({ written, id: false })),
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

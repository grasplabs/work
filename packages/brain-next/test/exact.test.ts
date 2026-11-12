import { describe, expect, it } from "vite-plus/test";

import { exactsOf, foundIn } from "../src/exact.ts";

// What a question asks for as written: its quoted phrases, dates and IDs,
// read by fixed rules from the question alone. Finding them in the
// store, with access, is tested in apps/core (brain-next-pack.test.ts).

/** Each exact part of `question`: as asked, and by which rule. */
const partsOf = (question: string) =>
  exactsOf(question).map(({ asked, kind }) => ({ asked, kind }));

/** Whether `text` holds the one exact part of `question` as written. */
const holds = (question: string, text: string): boolean =>
  foundIn(text, exactsOf(question), [0]).length === 1;

describe("the exact parts of a question", () => {
  it("reads quoted phrases, dates and IDs, each once, in that order, and leaves names to the words way", () => {
    expect(
      partsOf(
        `Did Anna Jansen sign "het nieuwe contract" for PO-77812 on 14 maart 2026, and PO-77812 again?`
      )
    ).toStrictEqual([
      { asked: "het nieuwe contract", kind: "phrase" },
      { asked: "14 maart 2026", kind: "date" },
      { asked: "PO-77812", kind: "id" },
    ]);
  });

  it("takes words with a digit and a letter, or three digits, as IDs, and nothing shorter", () => {
    expect(
      partsOf("Is INV-2024-0042, PO12345 or toestel 4400 in Q3 for 12 days?")
    ).toStrictEqual([
      { asked: "INV-2024-0042", kind: "id" },
      { asked: "PO12345", kind: "id" },
      { asked: "4400", kind: "id" },
      { asked: "Q3", kind: "id" },
    ]);
  });

  it("finds a date written in any of the five languages' ways, and no other day", () => {
    const question = "Wat gebeurde er op 2026-03-04?";
    for (const written of [
      "op 4 maart 2026 is het besloten",
      "am 4. März 2026 beschlossen",
      "le 4 mars 2026",
      "el 4 de marzo de 2026",
      "on March 4, 2026",
      "op 04-03-2026",
      "op 4/3/2026",
      "2026.03.04",
    ]) {
      expect({ written, holds: holds(question, written) }).toStrictEqual({
        written,
        holds: true,
      });
    }
    for (const other of ["op 3 april 2026", "op 4 maart 2025", "2026 4 03"]) {
      expect({ other, holds: holds(question, other) }).toStrictEqual({
        other,
        holds: false,
      });
    }
  });

  it("reads a date with the day first, and month first only when nothing else reads", () => {
    expect(holds("14/03/2026", "14 March 2026")).toBeTruthy();
    expect(holds("03/14/2026", "14 March 2026")).toBeTruthy();
    expect(holds("03/04/2026", "3 April 2026")).toBeTruthy();
    expect(holds("03/04/2026", "4 March 2026")).toBeFalsy();
    // No such day: what has three digits is an ID, nothing a date.
    expect(partsOf("31/02/2026 or 14 Brumaire 2025")).toStrictEqual([
      { asked: "31/02/2026", kind: "id" },
      { asked: "2025", kind: "id" },
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
    expect(partsOf("what do we pay for travel")).toStrictEqual([]);
    expect(
      partsOf(
        Array.from({ length: 12 }, (_, index) => `ID-${index + 100}`).join(" ")
      )
    ).toHaveLength(8);
  });
});

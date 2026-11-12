import { describe, expect, it } from "vite-plus/test";

import { datesIn } from "../src/dates.ts";

// The closed table of written dates (dates.ts): each form, as a text
// writes it, and the days it reads. Recall over the days, with access, is
// tested in apps/core (brain-next-dates.test.ts).

/** The days `text` writes, as `year-month-day`, `0` for no year. */
const daysOf = (text: string): string[][] =>
  datesIn(text).map(({ days }) =>
    days.map(({ year, month, day }) => `${year}-${month}-${day}`)
  );

/** What each date `text` writes is, as written. */
const writtenIn = (text: string): string[] =>
  datesIn(text).map(({ start, end }) => text.slice(start, end));

describe("the dates a text writes", () => {
  it("reads each form of the table, and the days it may be", () => {
    const table: [string, string[][]][] = [
      // ISO, with a time and a zone or not.
      ["on 2026-03-14 we", [["2026-3-14"]]],
      ["at 2026-03-14T09:00:00Z sharp", [["2026-3-14"]]],
      ["at 2026-03-14 09:30 sharp", [["2026-3-14"]]],
      // Numbers, either way round, every reading that is a day.
      ["op 14-03-2026", [["2026-3-14"]]],
      ["am 14.03.2026", [["2026-3-14"]]],
      ["on 03/04/2026", [["2026-4-3", "2026-3-4"]]],
      ["on 03/14/2026", [["2026-3-14"]]],
      ["op 4/4/2026", [["2026-4-4"]]],
      // A day, a month's name, a year or none.
      ["op 14 maart 2026", [["2026-3-14"]]],
      ["am 14. März 2026", [["2026-3-14"]]],
      ["on the 14th March 2026", [["2026-3-14"]]],
      ["le 1er mars 2026", [["2026-3-1"]]],
      ["el 14 de marzo de 2026", [["2026-3-14"]]],
      ["op 14 maart", [["0-3-14"]]],
      ["op 3 okt.", [["0-10-3"]]],
      ["le 14 févr. 2026", [["2026-2-14"]]],
      ["op 29 februari", [["0-2-29"]]],
      // A month's name, a day, a year or none.
      ["on March 14th, 2026", [["2026-3-14"]]],
      ["on Mar 14 2026", [["2026-3-14"]]],
      ["el marzo 14", [["0-3-14"]]],
    ];
    expect(table.map(([text]) => [text, daysOf(text)])).toStrictEqual(table);
  });

  it("reads nothing else as a date", () => {
    expect(
      [
        "version 1.2.3",
        "on 14-03-26",
        "31/02/2026",
        "13/13/2026",
        "14 Brumaire 2026",
        "PO-2026-03",
        "page 14 of 2026",
        "next Tuesday",
        "from 1 to 14 March",
        "20260314",
      ].flatMap(daysOf)
    ).toStrictEqual([["0-3-14"]]);
  });

  it("finds where each date is written, each once, in order", () => {
    expect(
      writtenIn(
        "Signed 14 maart 2026, paid on 2026-04-01T10:00Z, due 3/5/2026."
      )
    ).toStrictEqual(["14 maart 2026", "2026-04-01T10:00Z", "3/5/2026"]);
  });
});

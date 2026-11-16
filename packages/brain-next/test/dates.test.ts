import { describe, expect, it } from "vite-plus/test";

import { datesIn } from "../src/dates.ts";

// The days a text mentions, read from CLDR's formats through workerd's own
// `Intl` and from ISO 8601 (dates.ts). Finding them in the store, with
// access, is tested in apps/core (brain-next-pack.test.ts).

/** Each date `text` writes, as written, and its days as ISO (no year: --MM-DD). */
const read = (text: string): [string, string[]][] =>
  datesIn(text).map(({ start, end, days }) => [
    text.slice(start, end),
    days.map(({ year, month, day }) =>
      [
        year === 0 ? "-" : String(year),
        String(month).padStart(2, "0"),
        String(day).padStart(2, "0"),
      ].join("-")
    ),
  ]);

describe("the days a text mentions", () => {
  it("reads a day however the five languages write it, an ordinal, ISO with a time, and both orders of figures", () => {
    const table: [string, [string, string[]][]][] = [
      ["signed 14 March 2026", [["14 March 2026", ["2026-03-14"]]]],
      ["signed March 14, 2026", [["March 14, 2026", ["2026-03-14"]]]],
      ["signed 14th March 2026", [["14th March 2026", ["2026-03-14"]]]],
      ["signed March 14th, 2026", [["March 14th, 2026", ["2026-03-14"]]]],
      ["signed Mar 14, 2026", [["Mar 14, 2026", ["2026-03-14"]]]],
      ["getekend op 14 maart 2026", [["14 maart 2026", ["2026-03-14"]]]],
      ["getekend op 14de maart", [["14de maart", ["--03-14"]]]],
      ["getekend op 4 mrt. 2026", [["4 mrt. 2026", ["2026-03-04"]]]],
      ["unterschrieben am 14. März 2026", [["14. März 2026", ["2026-03-14"]]]],
      ["unterschrieben am 14. Marz 2026", [["14. Marz 2026", ["2026-03-14"]]]],
      ["signé le 1er mars 2026", [["1er mars 2026", ["2026-03-01"]]]],
      ["signé le 8 févr. 2026", [["8 févr. 2026", ["2026-02-08"]]]],
      [
        "firmado el 14 de marzo de 2026",
        [["14 de marzo de 2026", ["2026-03-14"]]],
      ],
      ["firmado el 1º de mayo", [["1º de mayo", ["--05-01"]]]],
      ["at 2026-03-14T09:00:00Z.", [["2026-03-14T09:00:00Z", ["2026-03-14"]]]],
      [
        "at 2026-03-14T09:00+01:00",
        [["2026-03-14T09:00+01:00", ["2026-03-14"]]],
      ],
      ["on 2026-03-14 09:00", [["2026-03-14", ["2026-03-14"]]]],
      ["on 14-03-2026", [["14-03-2026", ["2026-03-14"]]]],
      ["on 14.03.2026.", [["14.03.2026", ["2026-03-14"]]]],
      ["on 14/03/2026", [["14/03/2026", ["2026-03-14"]]]],
      ["on 03/04/2026", [["03/04/2026", ["2026-03-04", "2026-04-03"]]]],
      // A day a weekday names, and two days in one line.
      [
        "zaterdag 14 maart 2026 en 15 maart",
        [
          ["14 maart 2026", ["2026-03-14"]],
          ["15 maart", ["--03-15"]],
        ],
      ],
      ["Saturday, March 14, 2026", [["March 14, 2026", ["2026-03-14"]]]],
      // A numbered line's number is no day.
      ["1. March 14, 2026", [["March 14, 2026", ["2026-03-14"]]]],
    ];
    expect(table.map(([text]) => [text, read(text)])).toStrictEqual(table);
  });

  it("reads no day off the calendar, inside an ID, of two-digit years, figures without a year, or a short name without one", () => {
    const none = [
      "31 April 2026",
      "29 February 2026",
      "INV-2026-03-14-7",
      "PO-14.03.2026",
      "report-2026-03-14.pdf",
      "v2026-03-14",
      "14/03/26",
      "14/03",
      "1/2 cup",
      "3 ago",
      "4 mar",
      "page 14 of 2026",
    ];
    expect(none.map((text) => [text, read(text)])).toStrictEqual(
      none.map((text) => [text, []])
    );
  });

  it("reads 29 February without a year, and in a leap year", () => {
    expect([read("29 February"), read("29 February 2028")]).toStrictEqual([
      [["29 February", ["--02-29"]]],
      [["29 February 2028", ["2028-02-29"]]],
    ]);
  });
});

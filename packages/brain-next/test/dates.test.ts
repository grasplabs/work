import type { Access, Reader } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { recallBudgetMax } from "../src/contract.ts";
import { datesIn } from "../src/dates.ts";
import { tick } from "./export-reads.ts";

// The days a text mentions, read from CLDR's formats through workerd's own
// `Intl` and from ISO 8601 (dates.ts), and kept with a chunk in the store.
// Finding them through core, with access and against twins, is tested in
// apps/core (brain-next-pack.test.ts).

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

describe("the days a chunk mentions, in the store", () => {
  it("finds a chunk by a day it writes otherwise, and nothing of it once its source is erased", async () => {
    const store = env.BRAIN_STORE.getByName("brain");
    const group = `team:${crypto.randomUUID()}`;
    const access: Access = { kind: "audience", group };
    const reader: Reader = { person: crypto.randomUUID(), groups: [group] };
    const source = `upload:${crypto.randomUUID()}`;
    const { version } = await store.addSource({
      source,
      change: crypto.randomUUID(),
      // No word of the question: only its day finds it.
      text: "Signed March 14th, 2097; paid 15/03/2097.",
      access,
    });
    const rowsOfDays = async () =>
      await runInDurableObject(
        store,
        (_, state) =>
          state.storage.sql
            .exec<{ rows: number }>(
              `SELECT count(*) AS rows FROM chunk_days
              JOIN chunks ON chunks.row = chunk_days.chunk
              JOIN source_versions ON source_versions.row = chunks.version_row
              WHERE source_versions.source = ?`,
              source
            )
            .one().rows
      );
    const ask = async () =>
      await store.recall({
        question: "14 maart",
        reader,
        budget: { tokens: recallBudgetMax },
      });

    const before = { pack: await ask(), rows: await rowsOfDays() };
    await store.eraseSource({ source, reason: "deleted" });
    await tick(store);
    const after = { pack: await ask(), rows: await rowsOfDays() };

    expect({
      before: {
        items: before.pack.items.map(({ position, found }) => ({
          position,
          found,
        })),
        rows: before.rows,
      },
      after: { items: after.pack.items, rows: after.rows },
    }).toStrictEqual({
      before: { items: [{ position: 0, found: "exact" }], rows: 2 },
      after: { items: [], rows: 0 },
    });
    expect(before.pack.items[0]).toMatchObject({ source, version });
  });
});

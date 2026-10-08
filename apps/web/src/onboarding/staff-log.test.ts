import type { StaffLogEntry } from "@grasp-os/shared/onboarding-staff";
import { describe, expect, it } from "vite-plus/test";

import { chartDaysMax, logCsv, logSearchOf, perDay } from "./staff-log.ts";

const entry = (at: string, name = "Oli Olsen"): StaffLogEntry => ({
  seq: 1,
  at,
  actor: "person",
  what: "interview.completed",
  person: { id: "oli", name },
  team: "ops",
});

describe("the onboarding log in Grasp's area", () => {
  it("keeps only the filters core takes from the address", () => {
    expect(
      logSearchOf({
        actor: "person",
        what: "interview",
        team: "",
        day: "2026-13-40",
        other: "x",
      })
    ).toStrictEqual({ actor: "person", what: "interview" });
    expect(logSearchOf({ actor: "nobody", what: "DROP TABLE" })).toStrictEqual(
      {}
    );
  });

  it("counts each day, quiet ones included, up to its last days", () => {
    expect(
      perDay([
        entry("2026-10-03T09:00:00.000Z"),
        entry("2026-10-01T09:00:00.000Z"),
        entry("2026-10-03T18:00:00.000Z"),
      ])
    ).toStrictEqual([
      { day: "2026-10-01", count: 1 },
      { day: "2026-10-02", count: 0 },
      { day: "2026-10-03", count: 2 },
    ]);
    const long = perDay([
      entry("2026-01-01T09:00:00.000Z"),
      entry("2026-10-01T09:00:00.000Z"),
    ]);
    expect([long.length, long.at(-1)?.day]).toStrictEqual([
      chartDaysMax,
      "2026-10-01",
    ]);
  });

  it("exports CSV a spreadsheet opens without running anyone's formula", () => {
    expect(logCsv([entry("2026-10-01T09:00:00.000Z", '=HYPERLINK("x")')])).toBe(
      "seq,at,actor,what,person_id,person,team\r\n" +
        `1,2026-10-01T09:00:00.000Z,person,interview.completed,oli,"'=HYPERLINK(""x"")",ops\r\n`
    );
  });
});

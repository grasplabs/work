import { describe, expect, it } from "vite-plus/test";

import {
  utcDay,
  logDays,
  logHours,
  logItemsOf,
} from "../../src/admin/admin-log.ts";
import { adminViewOf } from "../../src/admin/admin-view.ts";
import type { Org, OrgState } from "../../src/admin/onboarding-admin.ts";
import type { OrgEvent } from "../../src/admin/org-record.ts";
import type { TrailEntry } from "../../src/admin/trail.ts";
import { SAMPLE_ORGS } from "./fixtures/admin-sample.ts";

const [noordkade] = SAMPLE_ORGS;
const at = (org: Org, more: Partial<OrgState> = {}) =>
  adminViewOf(org, { ...org.seed, ...more }, "2026-10-02");
const noon = (day: string) => new Date(`${day}T12:00:00`).getTime();

describe("the log of an organization as one list", () => {
  it("has what happened at the company, the newest first, each with what it is about and who did it", () => {
    const items = logItemsOf(at(noordkade), []);
    expect(items.length).toBeGreaterThan(10);
    expect(
      items.every(
        (item, index) => index === 0 || (items[index - 1]?.on ?? "") >= item.on
      )
    ).toBeTruthy();
    expect(
      items.find(
        (item) =>
          item.source.from === "company" &&
          item.source.event.kind === "contractSigned"
      )
    ).toMatchObject({ topic: "agreements", actor: "company", at: null });
    expect(
      items.find(
        (item) =>
          item.source.from === "company" && item.source.event.kind === "talked"
      )
    ).toMatchObject({ topic: "interviews", actor: "person" });
  });

  it("puts what was done by hand among it by its time, before what the same day is only known for", () => {
    const trail: TrailEntry[] = [
      { what: "teamOut", team: "sales", name: "Sales", at: noon("2026-10-01") },
    ];
    const items = logItemsOf(at(noordkade), trail);
    const day = items.filter((item) => item.on === "2026-10-01");
    expect(day[0]).toMatchObject({
      topic: "people",
      actor: "grasp",
      team: "sales",
      at: noon("2026-10-01"),
    });
    expect(day.slice(1).every((item) => item.at === null)).toBeTruthy();
  });

  it("tells once what two sources both tell", () => {
    const plain = logItemsOf(at(noordkade, { opened: 8 }), []);
    expect(
      plain.filter(
        (item) =>
          item.source.from === "company" && item.source.event.kind === "go"
      )
    ).toHaveLength(1);
    const byHand = logItemsOf(at(noordkade, { opened: 8 }), [
      { what: "go", at: noon("2026-10-02") },
    ]);
    expect(
      byHand.filter(
        (item) =>
          item.source.from === "company" && item.source.event.kind === "go"
      )
    ).toHaveLength(0);
    expect(byHand.filter((item) => item.source.from === "hand")).toHaveLength(
      1
    );
  });

  it("reads what the Worker noted: who did it, what it is about, and what went wrong", () => {
    const real = {
      ...noordkade,
      real: {
        people: [],
        timelines: new Map(),
        told: new Map(),
        interviews: [],
        sent: new Map(),
        heard: new Map(),
        talking: new Set<string>(),
        transcripts: new Map(),
        links: new Map(),
        clientCode: "",
        test: true,
        doers: new Map(),
        tools: new Map(),
        metered: [],
      },
    };
    const events: OrgEvent[] = [
      { at: "2026-10-01T09:00:00Z", by: "grasp", what: "sent", about: "4" },
      { at: "2026-10-01T09:05:00Z", by: "p-lisa", what: "completed" },
      {
        at: "2026-10-01T09:06:00Z",
        by: "grasp",
        what: "drawFailed",
        about: "work:w-1",
      },
      {
        at: "2026-10-01T09:07:00Z",
        by: "staff@this-machine",
        what: "teamOut",
        about: '{"team":"t-a","name":"A"}',
      },
      {
        at: "2026-10-01T09:08:00Z",
        by: "client",
        what: "step",
        about: "listening",
      },
      {
        at: "2026-10-01T09:09:00Z",
        by: "staff@this-machine",
        what: "sent",
        about: "p-tim",
      },
    ];
    const items = logItemsOf(at(real), [], events).filter(
      (item) => item.source.from === "worker"
    );
    expect(
      items.map((item) => [
        item.source.from === "worker" ? item.source.event.what : "",
        item.actor,
        item.problem,
      ])
    ).toStrictEqual([
      ["sent", "grasp", false],
      ["drawFailed", "itself", true],
      ["completed", "person", false],
      ["sent", "itself", false],
    ]);
    expect(items[0]?.person).toBe("p-tim");
    expect(items[1]?.work).toBe("w-1");
    // What the days are only known for at a sample is told by the Worker here.
    expect(
      logItemsOf(at(real), [], events).some(
        (item) =>
          item.source.from === "company" && item.source.event.kind === "talked"
      )
    ).toBeFalsy();
  });
});

describe("how busy each day was", () => {
  it("counts every day from the first entry to the last, by who did it", () => {
    const items = logItemsOf(at(noordkade), [
      { what: "go", at: noon("2026-10-02") },
    ]);
    const days = logDays(items, 400);
    expect(days.at(-1)?.day).toBe("2026-10-02");
    expect(
      days.reduce(
        (sum, day) => sum + day.grasp + day.company + day.person + day.itself,
        0
      )
    ).toBe(items.length);
    expect(days.at(-1)?.grasp).toBeGreaterThanOrEqual(1);
    // Every day is there, also one on which nothing happened.
    expect(new Set(days.map((day) => day.day)).size).toBe(days.length);
    expect([logDays(items, 7).length, logDays([])]).toStrictEqual([7, []]);
  });

  it("puts a moment on its UTC day, also late in the evening", () => {
    expect(
      ["2026-10-01T09:30:00Z", "2026-10-01T23:30:00Z"].map((iso) =>
        utcDay(Date.parse(iso))
      )
    ).toStrictEqual(["2026-10-01", "2026-10-01"]);
  });

  it("counts by UTC's hours, wherever it runs", () => {
    const late = Date.parse("2026-10-01T23:30:00Z");
    const hours = logHours(
      logItemsOf(at(noordkade), [{ what: "go", at: late }])
    );
    expect(hours).toHaveLength(24);
    expect(
      hours.flatMap((hour) => (hour.grasp > 0 ? [hour.hour] : []))
    ).toStrictEqual([23]);
  });
});

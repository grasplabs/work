import { describe, expect, it } from "vite-plus/test";

import { membersOf } from "../../src/admin/admin-account.ts";
import {
  asOf,
  isOpen,
  MODELS,
  PRICES,
  PURPOSES,
  usageIn,
  usageOf,
  valueOf,
} from "../../src/admin/admin-usage.ts";
import type { Model, Use } from "../../src/admin/admin-usage.ts";
import { valuePerMonth, WEEKS_PER_MONTH } from "../../src/admin/hours.ts";
import { dateOn, peopleOf, viewOf } from "../../src/admin/onboarding-admin.ts";
import type { Org, OrgState } from "../../src/admin/onboarding-admin.ts";
import { LISTEN_DAYS } from "../../src/admin/onboarding.ts";
import { SAMPLE_ORGS } from "./fixtures/admin-sample.ts";

const [noordkade, veldkamp, vanrijn, hartog] = SAMPLE_ORGS;
const today = "2026-10-02";
const at = (org: Org, more: Partial<OrgState> = {}) =>
  viewOf(org, { ...org.seed, ...more });
/** The AI an organization used by the day its view is on. */
const used = (org: Org, more: Partial<OrgState> = {}, now = today) => {
  const view = at(org, more);
  const day = asOf(view, now);
  return usageOf(view, day, membersOf(view, day, isOpen(view)));
};
const cost = (model: Model, use: Use) =>
  (use.tokensIn / 1e6) * PRICES[model].tokensIn +
  (use.tokensOut / 1e6) * PRICES[model].tokensOut +
  (use.spoken + use.heard) * PRICES[model].minute;

describe("the day an organization is counted up to", () => {
  it("is the day its interviews are on while they run", () => {
    expect(asOf(at(noordkade), today)).toBe(dateOn(noordkade, 8));
    expect(asOf(at(noordkade, { day: 3 }), "2027-01-01")).toBe(
      dateOn(noordkade, 3)
    );
  });

  it("is today before the team is told, and once the interviews are over", () => {
    expect(asOf(at(veldkamp), today)).toBe(today);
    expect(asOf(at(hartog), today)).toBe(today);
    // Never earlier than the day the link closed.
    expect(asOf(at(hartog), "2026-04-20")).toBe(dateOn(hartog, LISTEN_DAYS));
  });
});

describe("the AI an organization used", () => {
  it("is nothing before Stephen has read the first conversation", () => {
    const usage = used(vanrijn);
    expect(usage.total).toStrictEqual({
      tokensIn: 0,
      tokensOut: 0,
      spoken: 0,
      heard: 0,
      spend: 0,
    });
    expect(usage.months).toStrictEqual([]);
  });

  it("starts with reading the first conversation, on the day it was held", () => {
    const usage = used(veldkamp);
    expect(usage.months.map((month) => month.month)).toStrictEqual(["2026-09"]);
    expect(usage.purposes.reading.tokensIn).toBeGreaterThan(0);
    expect(usage.purposes.interviews.spend).toBe(0);
  });

  it("costs what each model’s tokens and each minute of voice cost, and nothing else", () => {
    for (const org of SAMPLE_ORGS) {
      const usage = used(org);
      for (const model of MODELS) {
        expect(usage.models[model].spend).toBeCloseTo(
          cost(model, usage.models[model]),
          6
        );
        for (const purpose of PURPOSES) {
          expect(usage.matrix[purpose][model].spend).toBeCloseTo(
            cost(model, usage.matrix[purpose][model]),
            6
          );
        }
      }
      expect(usage.total.spend).toBeCloseTo(
        MODELS.reduce(
          (sum, model) => sum + cost(model, usage.models[model]),
          0
        ),
        6
      );
    }
  });

  it("adds up the same by model as by what it was for, in all and in every month", () => {
    for (const org of SAMPLE_ORGS) {
      const usage = used(org);
      expect(
        MODELS.reduce((sum, model) => sum + usage.models[model].spend, 0)
      ).toBeCloseTo(usage.total.spend, 6);
      expect(usage.days.reduce((sum, day) => sum + day.spend, 0)).toBeCloseTo(
        usage.total.spend,
        6
      );
      for (const purpose of PURPOSES) {
        expect(
          MODELS.reduce(
            (sum, model) => sum + usage.matrix[purpose][model].spend,
            0
          )
        ).toBeCloseTo(usage.purposes[purpose].spend, 6);
      }
      for (const month of usage.months) {
        expect(
          MODELS.reduce((sum, model) => sum + month.models[model].spend, 0)
        ).toBeCloseTo(month.use.spend, 6);
        expect(usageIn(usage, month.month).total.spend).toBeCloseTo(
          month.use.spend,
          6
        );
      }
      expect(usageIn(usage, null).total).toStrictEqual(usage.total);
      expect(usageIn(usage, "1999-01").total.spend).toBe(0);
    }
  });

  it("says which model did what: the quick one speaks, the careful one writes down and draws, the small one runs", () => {
    const usage = used(hartog);
    const { interviews, runs } = usage.matrix;
    // An interview goes to both: the quick model for his line, the careful one for what was said.
    expect([
      interviews.sonnet.spend > 0,
      interviews.opus.spend > 0,
      interviews.haiku.spend,
    ]).toStrictEqual([true, true, 0]);
    // Drawing and reading are the careful one's alone.
    for (const purpose of ["drawing", "reading"] as const) {
      for (const model of MODELS) {
        expect(usage.matrix[purpose][model].spend > 0).toBe(model === "opus");
      }
    }
    // The plain steps of workflows go to the small one, the rest to the quick one; and none of it was counted.
    expect([
      runs.haiku.tokensIn > runs.sonnet.tokensIn,
      runs.opus.spend,
      usage.counted,
    ]).toStrictEqual([true, 0, false]);
    // Voice is only ever in the interviews.
    expect(usage.models.voice.spoken).toBeCloseTo(
      usage.matrix.interviews.voice.spoken,
      6
    );
    expect(usage.models.ears.heard).toBeCloseTo(
      usage.matrix.interviews.ears.heard,
      6
    );
  });

  it("takes what the Worker counted in place of the sample’s amounts, where an organization is onboarded for real", () => {
    const real = {
      people: [],
      timelines: new Map(),
      told: new Map(),
      interviews: [],
      sent: new Map(),
      talking: new Set<string>(),
      transcripts: new Map(),
      links: new Map(),
      clientCode: "",
      test: true,
      doers: new Map(),
      tools: new Map(),
    };
    const counted = [
      {
        day: "2026-10-01",
        purpose: "interviews" as const,
        model: "sonnet" as const,
        use: {
          tokensIn: 1_000_000,
          tokensOut: 0,
          spoken: 0,
          heard: 0,
          spend: 3,
        },
      },
      {
        day: "2026-10-01",
        purpose: "drawing" as const,
        model: "opus" as const,
        use: {
          tokensIn: 0,
          tokensOut: 100_000,
          spoken: 0,
          heard: 0,
          spend: 2.5,
        },
      },
      {
        day: "2026-10-01",
        purpose: "interviews" as const,
        model: "voice" as const,
        use: { tokensIn: 0, tokensOut: 0, spoken: 10, heard: 0, spend: 1.5 },
      },
    ];
    const usage = used({ ...noordkade, real: { ...real, metered: counted } });
    expect({
      counted: usage.counted,
      interviews: usage.matrix.interviews.sonnet.spend,
      drawing: usage.matrix.drawing.opus.spend,
      // His voice as counted; nobody talked in this one, so nothing was heard.
      spoken: usage.models.voice.spoken,
      heard: usage.models.ears.heard,
    }).toStrictEqual({
      counted: true,
      interviews: 3,
      drawing: 2.5,
      spoken: 10,
      heard: 0,
    });
    expect(usage.days.map((day) => day.day)).toContain("2026-10-01");
    // Without a count, the same organization is worked out from what happened.
    expect(
      used({ ...noordkade, real: { ...real, metered: [] } }).counted
    ).toBeFalsy();
  });

  it("works out what happened before the Worker started counting, and takes its count from that day on", () => {
    const view = at(noordkade);
    const days = [
      ...new Set(
        view.interviews.map((interview) => dateOn(noordkade, interview.day))
      ),
    ].toSorted();
    const from = days[Math.floor(days.length / 2)] ?? "";
    const happened = {
      people: peopleOf(noordkade),
      timelines: new Map(),
      told: new Map(),
      interviews: view.interviews,
      sent: new Map(),
      talking: new Set<string>(),
      transcripts: new Map(),
      links: new Map(),
      clientCode: "",
      test: true,
      doers: new Map(),
      tools: new Map(),
    };
    const counted = [
      {
        day: from,
        purpose: "interviews" as const,
        model: "sonnet" as const,
        use: { tokensIn: 0, tokensOut: 0, spoken: 0, heard: 0, spend: 7 },
      },
    ];
    const day = asOf(view, today);
    const usage = usageOf(
      viewOf(
        { ...noordkade, real: { ...happened, metered: counted } },
        noordkade.seed
      ),
      day,
      []
    );
    // Before that day: worked out, so the quick model has more than the 7 that was counted.
    const before = usage.days.filter(
      (each) => each.day < from && days.includes(each.day)
    );
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((each) => each.models.sonnet > 0)).toBeTruthy();
    // From that day on: only what was counted, and how long he listened.
    const after = usage.days.filter((each) => each.day >= from);
    expect(after.reduce((sum, each) => sum + each.models.sonnet, 0)).toBe(7);
    expect(
      after.reduce((sum, each) => sum + each.models.opus + each.models.voice, 0)
    ).toBe(0);
    expect(
      after.reduce((sum, each) => sum + each.models.ears, 0)
    ).toBeGreaterThan(0);
  });

  it("adds up the same by what it was for as month by month", () => {
    for (const org of SAMPLE_ORGS) {
      const usage = used(org);
      const byPurpose = PURPOSES.reduce(
        (sum, purpose) => sum + usage.purposes[purpose].spend,
        0
      );
      const byMonth = usage.months.reduce(
        (sum, month) => sum + month.use.spend,
        0
      );
      expect(byPurpose).toBeCloseTo(usage.total.spend, 6);
      expect(byMonth).toBeCloseTo(usage.total.spend, 6);
      for (const month of usage.months) {
        expect(
          PURPOSES.reduce(
            (sum, purpose) => sum + month.purposes[purpose].spend,
            0
          )
        ).toBeCloseTo(month.use.spend, 6);
      }
    }
  });

  it("grows with every interview, and voice only where people talked", () => {
    let before = 0;
    for (let day = 0; day <= LISTEN_DAYS; day += 1) {
      const usage = used(noordkade, { day });
      expect(usage.purposes.interviews.spend).toBeGreaterThanOrEqual(before);
      before = usage.purposes.interviews.spend;
    }
    const view = at(noordkade);
    const voice = view.interviews
      .filter((interview) => !interview.typed)
      .reduce((sum, interview) => sum + interview.minutes, 0);
    const usage = used(noordkade);
    expect(
      usage.purposes.interviews.spoken + usage.purposes.interviews.heard
    ).toBeCloseTo(voice, 6);
    // Stephen listens far more than he talks.
    expect(usage.purposes.interviews.heard).toBeGreaterThan(
      usage.purposes.interviews.spoken * 3
    );
  });

  it("has no chat and no workflows before Grasp is open", () => {
    for (const org of [noordkade, veldkamp, vanrijn]) {
      const usage = used(org);
      expect(usage.purposes.chat.spend).toBe(0);
      expect(usage.purposes.runs.spend).toBe(0);
    }
    // Hartog on the day before its go: only reading and interviews.
    const earlier = used(hartog, { day: 10 });
    expect(earlier.purposes.chat.spend + earlier.purposes.runs.spend).toBe(0);
  });

  it("counts the chat and every live workflow once Grasp is open", () => {
    const usage = used(hartog);
    expect(usage.purposes.chat.spend).toBeGreaterThan(0);
    expect(usage.purposes.runs.spend).toBeGreaterThan(
      usage.purposes.interviews.spend
    );
    // A workflow costs nothing before the day it went live: the first one in June.
    const may = usage.months.find((month) => month.month === "2026-05");
    const june = usage.months.find((month) => month.month === "2026-06");
    expect(may?.purposes.runs.spend).toBe(0);
    expect(june?.purposes.runs.spend).toBeGreaterThan(0);
    // More workflows live, more used: every month since.
    const runs = usage.months
      .filter((month) => month.month >= "2026-06" && month.month <= "2026-09")
      .map((month) => month.purposes.runs.spend);
    expect(runs).toStrictEqual(runs.toSorted((a, b) => a - b));
  });

  it("says for every live workflow how often it ran and what that took", () => {
    const usage = used(hartog);
    expect(usage.works.map((work) => work.id)).toStrictEqual([
      "orders",
      "status",
      "returns",
      "confirm",
    ]);
    expect(
      usage.works.reduce((sum, work) => sum + work.use.spend, 0)
    ).toBeCloseTo(usage.purposes.runs.spend, 6);
    for (const work of usage.works) {
      expect(work.runs).toBeGreaterThan(0);
      // A run costs cents, not euros.
      expect(work.use.spend / work.runs).toBeLessThan(0.5);
    }
    // The one that went live first has run the most days.
    expect(used(noordkade).works).toStrictEqual([]);
  });

  it("knows the month it is in, and the last one that is over", () => {
    const usage = used(hartog);
    expect(usage.lastMonth?.month).toBe("2026-09");
    expect(usage.thisMonth.spend).toBeCloseTo(
      usage.months.at(-1)?.use.spend ?? 0,
      6
    );
    expect(usage.months.at(-1)?.month).toBe("2026-10");
    expect(used(vanrijn).lastMonth).toBeNull();
  });
});

describe("the hours in the work", () => {
  it("are what one person handles times how long it takes, for everyone who does the work", () => {
    const view = at(noordkade);
    const value = valueOf(view, asOf(view, today));
    const papers = value.works.find((work) => work.evidence.id === "papers");
    const work = noordkade.works.find((each) => each.id === "papers");
    expect(papers?.hours).not.toBeNull();
    expect(papers?.said).toBeGreaterThan(0);
    // Near what the work itself says: its own numbers, for the thirteen who do it.
    const doers = peopleOf(noordkade).filter(
      (person) => person.work === "papers"
    ).length;
    const own = work
      ? (((work.volume[0] + work.volume[1]) / 2) * work.takes[1]) / 60
      : 0;
    expect((papers?.hours ?? 0) / doers).toBeGreaterThan(own * 0.7);
    expect((papers?.hours ?? 0) / doers).toBeLessThan(own * 1.3);
  });

  it("stay unknown while nobody gave both how many and how long: never zero", () => {
    const view = at(noordkade);
    const value = valueOf(view, asOf(view, today));
    const unknown = value.works.filter((work) => work.said === 0);
    expect(unknown.length).toBeGreaterThan(0);
    for (const work of unknown) {
      expect(work.hours).toBeNull();
    }
    expect(value.unknown).toBe(unknown.length);
    expect(value.counted + value.unknown).toBe(value.works.length);
    expect(value.hours).toBeCloseTo(
      value.works.reduce((sum, work) => sum + (work.hours ?? 0), 0),
      6
    );
  });

  it("count a month’s work by the week", () => {
    const view = at(hartog);
    const prices = valueOf(view, today).works.find(
      (work) => work.evidence.id === "prices"
    );
    const work = hartog.works.find((each) => each.id === "prices");
    const doers = peopleOf(hartog).filter(
      (person) => person.work === "prices"
    ).length;
    const own = work
      ? ((work.volume[0] + work.volume[1]) / 2 / WEEKS_PER_MONTH) *
        work.takes[1]
      : 0;
    expect((prices?.hours ?? 0) / doers).toBeGreaterThan(own * 0.6);
    expect((prices?.hours ?? 0) / doers).toBeLessThan(own * 1.4);
  });

  it("free nothing before Grasp is open", () => {
    for (const org of [noordkade, veldkamp, vanrijn]) {
      const view = at(org);
      const value = valueOf(view, asOf(view, today));
      expect(value).toMatchObject({
        freed: 0,
        expected: 0,
        value: 0,
        live: 0,
        designs: 0,
      });
      for (const work of value.works) {
        expect(work.run).toBeNull();
      }
    }
  });

  it("free the share each live workflow frees, and expect the share of each design", () => {
    const view = at(hartog);
    const value = valueOf(view, today);
    expect({
      live: value.live,
      designs: value.designs,
      running: value.works
        .filter((each) => each.live)
        .map((each) => each.evidence.id),
      underHours: value.freed < value.hours,
    }).toStrictEqual({
      live: 4,
      designs: 3,
      running: ["orders", "status", "returns", "confirm"],
      underHours: true,
    });
    const share = (id: string) => hartog.running?.[id]?.frees ?? 0;
    // A live workflow frees its share and expects nothing more; a design frees nothing yet and expects its share.
    for (const work of value.works) {
      expect(work.live ? work.expected : work.freed).toBe(0);
      expect(work.live ? work.freed : work.expected).toBeCloseTo(
        (work.hours ?? 0) * share(work.evidence.id),
        6
      );
    }
    expect(value.freed).toBeCloseTo(
      value.works.reduce((sum, work) => sum + work.freed, 0),
      6
    );
    // The value of the freed hours, by the same sum as the company's own dashboard.
    expect(value.value).toBeCloseTo(
      valuePerMonth(value.freed, hartog.hourly),
      6
    );
  });

  it("count a workflow as live only from the day it went live", () => {
    const view = at(hartog);
    const july = valueOf(view, "2026-07-01");
    expect(
      july.works.filter((work) => work.live).map((work) => work.evidence.id)
    ).toStrictEqual(["orders"]);
    // What is not live yet is still expected.
    expect(
      july.works.find((work) => work.evidence.id === "status")?.expected
    ).toBeGreaterThan(0);
  });
});

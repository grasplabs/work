import { describe, expect, it } from "vite-plus/test";

import { staffDrawingOf } from "../../src/admin/org-record.ts";
import type { DrawnWork, Told } from "../../src/admin/org-record.ts";

// A drawing as Grasp's staff get it (GRA-1079): which parts each person
// told, and its numbers as totals only. From the security review of #1208,
// each way staff could recover one named person's numbers, tried here:
// a number only one person of a big team gave, a step only one person told,
// and the ends of a range, each one person's. A number shows only once at
// least 5 people gave it, as a median; a team of one shows its own.

/** What someone told: the first step, and `more`. */
const told = (more: Partial<Told> = {}): Told => ({
  start: true,
  steps: [0],
  end: false,
  way: null,
  waits: [],
  differently: [],
  decides: false,
  own: false,
  ai: false,
  volume: null,
  takes: null,
  wrong: null,
  right: false,
  ask: false,
  next: false,
  example: null,
  term: false,
  out: [],
  ...more,
});

/** A drawing told by `tellers`, by person, with two steps of the given minutes. */
const drawing = (
  tellers: Record<string, Told>,
  minutes: [number, number, number] | null = [3, 5, 8]
): DrawnWork => ({
  at: "2026-10-14T10:00:00.000Z",
  from: Object.keys(tellers),
  starts: "An order comes in.",
  steps: [
    {
      text: "Write it down.",
      who: "Sales",
      tool: "Excel",
      minutes,
      documented: false,
    },
    {
      text: "Check the stock.",
      who: "Sales",
      tool: "ERP",
      minutes,
      documented: false,
    },
  ],
  waits: [],
  differently: [
    { when: "the shop is new", does: "Ask Finance.", outOfTen: 2, after: 0 },
  ],
  decides: "",
  own: "",
  ai: "",
  right: "",
  ask: "",
  next: "",
  term: null,
  differs: null,
  per: "week",
  unit: "minutes",
  told: tellers,
  open: [],
});

/** `count` people, `person-0` on, each telling `of(index)`. */
const people = (
  count: number,
  of: (index: number) => Partial<Told> = () => ({})
) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `person-${index}`,
      told(of(index)),
    ])
  );

describe("a drawing as staff get it", () => {
  it("holds back a number only one of a team of eight gave, and never says who gave it", () => {
    const tellers = people(8, (index) =>
      index === 3 ? { volume: [40, 90], takes: [2, 6, 20], wrong: 3 } : {}
    );
    const staff = staffDrawingOf(drawing(tellers), 8);
    // Every person's entry reads the same as far as numbers go.
    const shapes = new Set(
      Object.values(staff.told).map((each) => JSON.stringify(each))
    );

    expect({
      totals: staff.totals,
      shapes: shapes.size,
      named: Object.keys(staff.told["person-3"] ?? {}).filter((key) =>
        ["volume", "volumeOf", "takes", "wrong"].includes(key)
      ),
    }).toStrictEqual({
      totals: {
        volume: { people: 1, value: null },
        takes: { people: 1, value: null },
        wrong: { people: 1, value: null },
      },
      shapes: 1,
      named: [],
    });
  });

  it("holds back the minutes of a step only one person told, and of a case fewer than five told", () => {
    // Six tell the first step; only one the second, and one the case.
    const tellers = people(6, (index) =>
      index === 0 ? { steps: [0, 1], differently: [0] } : {}
    );
    const staff = staffDrawingOf(drawing(tellers), 6);

    expect({
      minutes: staff.steps.map(({ minutes }) => minutes),
      outOfTen: staff.differently.map(({ outOfTen }) => outOfTen),
    }).toStrictEqual({
      // The first step rests on six: its normal minutes, never the ends.
      minutes: [
        { people: 6, value: 5 },
        { people: 1, value: null },
      ],
      outOfTen: [{ people: 1, value: null }],
    });
  });

  it("shows the median of five or more, never the lowest or the highest, so no end is one person's", () => {
    const normals = [4, 5, 6, 7, 60];
    const tellers = people(5, (index) => ({
      volume: [10 + index, 100 + index * 10],
      takes: [1, normals[index] ?? 0, 90],
      wrong: index,
    }));
    const { totals } = staffDrawingOf(drawing(tellers), 5);
    const shown = [
      totals.volume.value?.quiet,
      totals.volume.value?.busy,
      totals.takes.value,
      totals.wrong.value,
    ];

    expect({
      totals,
      ends: shown.filter((value) =>
        [10, 14, 100, 140, 4, 60, 0, 4].includes(value ?? Number.NaN)
      ),
    }).toStrictEqual({
      totals: {
        volume: { people: 5, value: { quiet: 12, busy: 120 } },
        takes: { people: 5, value: 6 },
        wrong: { people: 5, value: 2 },
      },
      ends: [],
    });
  });

  it("shows the numbers of a team of one, with one person, as the Brain does", () => {
    const staff = staffDrawingOf(
      drawing({ solo: told({ volume: [5, 8], takes: [2, 4, 9], wrong: 1 }) }),
      1
    );

    expect(staff.totals).toStrictEqual({
      volume: { people: 1, value: { quiet: 5, busy: 8 } },
      takes: { people: 1, value: 4 },
      wrong: { people: 1, value: 1 },
    });
  });
});

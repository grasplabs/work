import { describe, expect, it } from "vite-plus/test";

import { staffDrawingOf } from "../../src/admin/org-record.ts";
import type { DrawnWork, Told } from "../../src/admin/org-record.ts";

// A drawing as Grasp's staff get it (GRA-1079, GRA-1084): numbers only,
// never anything anyone said; its steps and cases by position, how many
// people each rests on, and its numbers as totals only. From the security
// reviews of #1208, each way staff could recover one named person's
// numbers or words, tried here: a number only one person of a big team
// gave, a step's minutes only one gave, the ends of a range, and a number
// in the model's text. A number shows only once at least 5 people gave it,
// as a median, in a team of one too (Nick's 5-person floor, GRA-1079).

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
  it("holds back a number only one of a team of eight gave, and says nothing by person", () => {
    const tellers = people(8, (index) =>
      index === 3 ? { volume: [40, 90], takes: [2, 6, 20], wrong: 3 } : {}
    );
    const staff = staffDrawingOf(drawing(tellers));

    expect({
      totals: staff.totals,
      keys: Object.keys(staff).toSorted(),
      heard: staff.heard,
    }).toStrictEqual({
      // Neither a value nor how many fewer than 5.
      totals: {
        volume: { people: null, value: null },
        takes: { people: null, value: null },
        wrong: { people: null, value: null },
      },
      keys: ["at", "differently", "heard", "per", "steps", "totals", "unit"],
      heard: 8,
    });
  });

  it("holds back how many told each step, and how many it was drawn from, until five did", () => {
    // One interview completes in a team of 8, then three more: diffing exact
    // counts across them would say which steps each person told.
    const after = (count: number) => {
      const staff = staffDrawingOf(
        drawing(people(count, () => ({ steps: [0, 1] })))
      );
      return {
        heard: staff.heard,
        steps: staff.steps.map((step) => step.people),
      };
    };

    expect([1, 4, 5].map(after)).toStrictEqual([
      { heard: null, steps: [null, null] },
      { heard: null, steps: [null, null] },
      { heard: 5, steps: [5, 5] },
    ]);
  });

  it("holds back a step's minutes six told but only one gave, and a case's share only one gave", () => {
    // All six tell the step and the case; only one gives minutes or a share.
    const tellers = people(6, (index) => ({
      steps: [0, 1],
      differently: [0],
      ...(index === 2
        ? {
            stepMinutes: [{ step: 1, minutes: [4, 7, 30] }],
            caseShares: [{ case: 0, outOfTen: 3 }],
          }
        : {}),
    }));
    const staff = staffDrawingOf(drawing(tellers));

    expect({
      steps: staff.steps,
      differently: staff.differently,
    }).toStrictEqual({
      // How many told each step; the step-level minutes the model summed
      // up never reach staff.
      steps: [
        { people: 6, minutes: { people: 0, value: null } },
        { people: 6, minutes: { people: null, value: null } },
      ],
      differently: [{ after: 0, outOfTen: { people: null, value: null } }],
    });
  });

  it("shows no step minutes right after one person's interview, and their median once five gave them", () => {
    const giving = (count: number) =>
      people(8, (index) =>
        index < count
          ? { stepMinutes: [{ step: 0, minutes: [1, 10 + index, 60] }] }
          : {}
      );
    const after = (count: number) =>
      staffDrawingOf(drawing(giving(count))).steps[0]?.minutes;

    expect([1, 4, 5].map(after)).toStrictEqual([
      { people: null, value: null },
      { people: null, value: null },
      // The median of 10 to 14, never the quickest or the longest anyone said.
      { people: 5, value: 12 },
    ]);
  });

  it("shows the median of five or more, never the lowest or the highest, so no end is one person's", () => {
    const normals = [4, 5, 6, 7, 60];
    const tellers = people(5, (index) => ({
      volume: [10 + index, 100 + index * 10],
      takes: [1, normals[index] ?? 0, 90],
      wrong: index,
    }));
    const { totals } = staffDrawingOf(drawing(tellers));
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

  it("never lets anything anyone said reach staff, a number in the model's text included", () => {
    const drawn = drawing(people(6));
    const staff = staffDrawingOf({
      ...drawn,
      starts: "About 40 orders come in a week.",
      decides: "Lisa checks whether the shop pays on time.",
      open: ["Who approves an order over 5,000 euros?"],
      differently: [
        {
          when: "the shop is new (2 to 3 in 10)",
          does: "Ask Finance, 1.5 days.",
          outOfTen: 2,
          after: 0,
        },
      ],
    });
    // Every string staff get: when it was drawn, and what its numbers count in.
    const strings: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === "string") {
        strings.push(value);
      } else if (typeof value === "object" && value !== null) {
        for (const each of Object.values(value)) {
          collect(each);
        }
      }
    };
    collect(staff);

    expect(strings).toStrictEqual([drawn.at, "week", "minutes"]);
  });

  it("holds back a team of one's number and how many told it, as for any team under 5", () => {
    const staff = staffDrawingOf(
      drawing(
        {
          solo: told({
            volume: [5, 8],
            takes: [2, 4, 9],
            wrong: 1,
            stepMinutes: [{ step: 0, minutes: [2, 3, 5] }],
          }),
        },
        null
      )
    );

    expect({
      heard: staff.heard,
      steps: staff.steps,
      totals: staff.totals,
    }).toStrictEqual({
      heard: null,
      steps: [
        { people: null, minutes: { people: null, value: null } },
        { people: 0, minutes: { people: 0, value: null } },
      ],
      totals: {
        volume: { people: null, value: null },
        takes: { people: null, value: null },
        wrong: { people: null, value: null },
      },
    });
  });
});

/**
 * Contradictions surfaced (contradictions.ts): the contradictions a key
 * plants through what its people believe, and whether both versions are
 * in Stephen's notes across the interviews. Pure: the judge's verdicts
 * come in as they are kept.
 */
import { describe, expect, it } from "vite-plus/test";

import type { Judged } from "./card.ts";
import {
  contradictionsIn,
  surfacedLine,
  surfacedOf,
} from "./contradictions.ts";
import { openKeys } from "./keys/index.ts";
import type { AnswerKey } from "./keys/types.ts";

const keyOf = (id: string): AnswerKey => {
  const key = openKeys[id];
  if (key === undefined) {
    throw new Error(`Key ${id} is missing.`);
  }
  return key;
};

/** What the judge found in one interview: for each fact id, whether it is in his notes. */
const judgedWith = (written: Record<string, boolean>): Judged => ({
  known: Object.entries(written).map(([id, is]) => ({
    id,
    said: is,
    written: is ? ["f1"] : [],
  })),
  written: [],
});

describe("the contradictions a key plants", () => {
  it("are the facts some of its people know and others believe otherwise", () => {
    const planted = contradictionsIn(keyOf("04"));
    const compliance = planted.find(({ fact }) => fact === "S18");
    expect({
      facts: planted.map(({ fact }) => fact).toSorted(),
      believers: Object.keys(compliance?.believers ?? {}).toSorted(),
      knowers: compliance?.knowers.length,
    }).toStrictEqual({
      facts: ["S18", "S5"],
      believers: ["P2", "P9"],
      knowers: 1,
    });
  });

  it("are none where everyone who knows a fact knows it the same", () => {
    expect(contradictionsIn(keyOf("01"))).toStrictEqual([]);
  });
});

describe("contradictions surfaced", () => {
  const planted = contradictionsIn(keyOf("04")).filter(
    ({ fact }) => fact === "S18"
  );
  const knower = planted[0]?.knowers[0] ?? "";

  it("counts a contradiction when a believer's version and a knower's version are both in his notes", () => {
    const surfaced = surfacedOf(planted, [
      { employee: "P2", judged: judgedWith({ S18: true }) },
      { employee: knower, judged: judgedWith({ S18: true }) },
    ]);
    expect(surfaced).toStrictEqual({ count: 1, of: 1, open: [] });
    expect(surfacedLine(surfaced)).toContain("1 of 1");
  });

  it("names what is missing when one side is not in his notes", () => {
    expect(
      surfacedOf(planted, [
        { employee: "P2", judged: judgedWith({ S18: false }) },
        { employee: "P9", judged: judgedWith({ S18: false }) },
        { employee: knower, judged: judgedWith({ S18: true }) },
      ])
    ).toStrictEqual({
      count: 0,
      of: 1,
      open: [{ fact: "S18", missing: "the belief" }],
    });
  });

  it("leaves out a contradiction whose sides were not both interviewed", () => {
    const surfaced = surfacedOf(planted, [
      { employee: "P2", judged: judgedWith({ S18: true }) },
    ]);
    expect(surfaced).toStrictEqual({ count: 0, of: 0, open: [] });
    expect(surfacedLine(surfaced)).toContain("none");
  });
});

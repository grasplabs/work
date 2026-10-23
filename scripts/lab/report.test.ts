/**
 * The report (report.ts): where a bench stands on the newest Stephen
 * measured, by kind of moment, and that of the hidden set it shows numbers
 * only. Pure logic, tested on its own.
 */
import { describe, expect, it } from "vite-plus/test";

import { kindsOf, reportPage, standingsOf } from "./report.ts";
import type { AskDetail } from "./report.ts";
import type { Result } from "./results.ts";

const version = (talks: string) => ({
  interviewer: "stephen" as const,
  own: "o",
  lead: "l",
  talks,
  draws: "d",
  commit: "",
});

const run = (
  id: string,
  talks: string,
  set: Result["set"],
  right: Record<string, number>
): Result => ({
  id,
  at: "2026-10-23T09:00:00.000Z",
  label: id,
  bench: "ask",
  set,
  stephen: version(talks),
  via: { gateway: "local", quick: "q", careful: "c" },
  cases: Object.entries(right).map(([moment, value]) => ({
    id: moment,
    scores: { right: value },
  })),
  spent: "",
});

const results = [
  run("1-old", "a", "open", { one: 0, two: 0 }),
  run("2-new", "b", "open", { one: 1, two: 0 }),
  run("3-new", "b", "open", { one: 1, two: 1 }),
  run("4-hidden", "b", "hidden", { "secret-moment": 1 }),
];

const detail = (signal: AskDetail["signal"], right: boolean): AskDetail => ({
  moment: signal,
  signal,
  said: "",
  line: "",
  wants: "answer",
  right,
  single: true,
  why: "",
});

describe("the report", () => {
  it("says where a bench stands on the newest Stephen: each case once, what it moves by chance, and the hidden set of that same Stephen", () => {
    expect(standingsOf(results, "ask").standings).toStrictEqual([
      { metric: "right", value: 0.75, noise: 0.5, hidden: 1 },
    ]);
  });

  it("puts the kinds of moment worst first, beside the Stephen before", () => {
    expect(
      kindsOf(
        [detail("they", true), detail("flood", false), detail("flood", true)],
        [detail("flood", false)]
      )
    ).toStrictEqual([
      { signal: "flood", right: 0.5, tries: 2, before: 0 },
      { signal: "they", right: 1, tries: 1, before: null },
    ]);
  });

  it("shows of the hidden set its numbers only, never a case", () => {
    const page = reportPage({
      at: "2026-10-23T09:00:00.000Z",
      now: version("b"),
      results,
      ask: { now: [], before: [] },
      notes: [],
      draw: [],
    });
    expect({
      hiddenCase: page.includes("secret-moment"),
      run: page.includes("4-hidden"),
    }).toStrictEqual({ hiddenCase: false, run: true });
  });
});

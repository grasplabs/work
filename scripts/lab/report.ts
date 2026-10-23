/**
 * `vp run lab report`: one page to read in place of the prototype's lab
 * pages in its admin (GRA-338). Where each bench stands on the newest
 * Stephen measured, with what it moves by chance and on the hidden set;
 * the next question by kind of moment, worst first; the cases that went
 * wrong, to read before trusting a number; and every run. It is English
 * only, like the lab, and written to `scripts/lab/out/report.html`, never
 * committed. Of the hidden set it shows numbers only. Pure but for
 * reading what the runs kept. Ported from the prototype
 * (grasplabs/prototype, packages/grasp: src/lib/lab.ts, lab/snapshot.ts).
 */
import path from "node:path";

import { z } from "zod";

import { escaped, pageStyle } from "./check.ts";
import { meansOf, noiseOf, shown } from "./compare.ts";
import { allKept, openFolder } from "./kept.ts";
import { groups, signalGroup, signalPlain, signals } from "./moments.ts";
import type { Signal } from "./moments.ts";
import { alike, benches, markOf, meansLine } from "./results.ts";
import type { Bench, Result, StephenVersion } from "./results.ts";

/** What a run of the next-question bench kept of one moment. */
export const askDetailSchema = z.object({
  moment: z.string(),
  signal: z.literal(signals),
  said: z.string(),
  line: z.string(),
  wants: z.string(),
  right: z.boolean(),
  single: z.boolean(),
  why: z.string(),
});
export type AskDetail = z.output<typeof askDetailSchema>;

/** What a run of the notes bench kept of one conversation. */
export const notesDetailSchema = z.object({
  transcript: z.string(),
  notes: z.array(
    z.object({
      id: z.string(),
      tag: z.string(),
      record: z.string(),
      verdict: z.string().optional(),
    })
  ),
  lost: z.array(z.string()),
});
export type NotesDetail = z.output<typeof notesDetailSchema>;

/** What a run of the drawing bench kept of one practice company. */
export const drawDetailSchema = z.object({
  practice: z.string(),
  work: z.string(),
  card: z.object({
    found: z.object({ missed: z.array(z.string()) }),
    numbers: z.object({ lost: z.array(z.string()) }),
    supported: z.object({ notSaid: z.array(z.string()) }),
  }),
});
export type DrawDetail = z.output<typeof drawDetailSchema>;

/** Where a run keeps what each case wrote: `out/runs/<details>/<bench>/`. */
export const detailsFolder = (details: string, bench: Bench): string =>
  path.join(openFolder("out"), "runs", details, bench);

/** What a run of the open set kept, case by case, held to `schema`. */
const detailsOf = <T>(result: Result, schema: z.ZodType<T>): T[] =>
  result.details === undefined || result.set !== "open"
    ? []
    : allKept(detailsFolder(result.details, result.bench), schema);

/**
 * The runs of one bench on one set that are of the newest Stephen there,
 * measured alike: what "now" is measured from.
 */
export const newestRuns = (
  all: readonly Result[],
  bench: Bench,
  set: Result["set"]
): Result[] => {
  const of = all.filter((each) => each.bench === bench && each.set === set);
  const last = of.at(-1);
  return last === undefined
    ? []
    : of.filter((each) => alike(each, last) && markOf(each) === markOf(last));
};

/** A number over some runs, each case counting once however many runs held it; none when no run has it. */
const overCases = (runs: readonly Result[], metric: string): number | null => {
  const byCase = new Map<string, number[]>();
  for (const run of runs) {
    for (const each of run.cases) {
      const value = each.scores[metric];
      if (value !== undefined) {
        byCase.set(each.id, [...(byCase.get(each.id) ?? []), value]);
      }
    }
  }
  const means = [...byCase.values()].map(
    (values) => values.reduce((sum, value) => sum + value, 0) / values.length
  );
  return means.length === 0
    ? null
    : means.reduce((sum, value) => sum + value, 0) / means.length;
};

/** Where one number of one bench stands: on the open set, what it moves by chance, and on the hidden set. */
export interface Standing {
  metric: string;
  value: number;
  noise: number | null;
  hidden: number | null;
}

/** Where every number of one bench stands, from its newest runs. */
export const standingsOf = (
  all: readonly Result[],
  bench: Bench
): { runs: Result[]; standings: Standing[] } => {
  const open = newestRuns(all, bench, "open");
  const [first] = open;
  // The hidden runs of that same Stephen, so a number is never set beside one of another.
  const hidden = newestRuns(all, bench, "hidden").filter(
    (run) => first === undefined || markOf(run) === markOf(first)
  );
  const noise = noiseOf(open);
  const metrics = Object.keys(
    meansOf([...open, ...hidden].flatMap((run) => run.cases))
  );
  return {
    runs: open,
    standings: metrics.map((metric) => ({
      metric,
      value: overCases(open, metric) ?? 0,
      noise: noise?.[metric] ?? null,
      hidden: overCases(hidden, metric),
    })),
  };
};

/** How often his line was right for one kind of moment. */
export interface Kind {
  signal: Signal;
  right: number;
  tries: number;
  /** How often it was right on the Stephen measured before this one; none when there was none. */
  before: number | null;
}

const rightShare = (details: readonly AskDetail[]): number =>
  details.length === 0
    ? 0
    : details.filter((each) => each.right).length / details.length;

/** How often the next line was right, by kind of moment, worst first. */
export const kindsOf = (
  now: readonly AskDetail[],
  before: readonly AskDetail[]
): Kind[] =>
  signals
    .flatMap((signal): Kind[] => {
      const of = now.filter((each) => each.signal === signal);
      const was = before.filter((each) => each.signal === signal);
      return of.length === 0
        ? []
        : [
            {
              signal,
              right: rightShare(of),
              tries: of.length,
              before: was.length === 0 ? null : rightShare(was),
            },
          ];
    })
    .toSorted((a, b) => a.right - b.right);

/** What the page is made of. */
export interface ReportInput {
  at: string;
  /** The Stephen of this checkout: whether the newest runs measured him. */
  now: StephenVersion;
  results: readonly Result[];
  ask: { now: AskDetail[]; before: AskDetail[] };
  notes: NotesDetail[];
  draw: DrawDetail[];
}

/** The details the page reads, from what the newest open runs kept. */
export const reportInputOf = (
  at: string,
  now: StephenVersion,
  results: readonly Result[]
): ReportInput => {
  const askRuns = newestRuns(results, "ask", "open");
  const [newest] = askRuns;
  const earlier = results.filter(
    (each) =>
      each.bench === "ask" &&
      each.set === "open" &&
      newest !== undefined &&
      alike(each, newest) &&
      markOf(each) !== markOf(newest)
  );
  const previous = earlier.at(-1);
  const before =
    previous === undefined
      ? []
      : earlier.filter((each) => markOf(each) === markOf(previous));
  const lastOf = (bench: Bench) => newestRuns(results, bench, "open").at(-1);
  const notesRun = lastOf("notes");
  const drawRun = lastOf("draw");
  return {
    at,
    now,
    results,
    ask: {
      now: askRuns.flatMap((run) => detailsOf(run, askDetailSchema)),
      before: before.flatMap((run) => detailsOf(run, askDetailSchema)),
    },
    notes: notesRun === undefined ? [] : detailsOf(notesRun, notesDetailSchema),
    draw: drawRun === undefined ? [] : detailsOf(drawRun, drawDetailSchema),
  };
};

const cell = (text: string): string => `<td>${escaped(text)}</td>`;
const head = (texts: readonly string[]): string =>
  `<tr>${texts.map((text) => `<th>${escaped(text)}</th>`).join("")}</tr>`;
const table = (columns: readonly string[], rows: readonly string[][]): string =>
  `<table>${head(columns)}${rows.map((row) => `<tr>${row.map(cell).join("")}</tr>`).join("")}</table>`;

const benchNames: Readonly<Record<Bench, string>> = {
  ask: "Next question",
  notes: "Notes",
  draw: "Drawing",
  whole: "Whole interviews",
};

const benchSection = (input: ReportInput, bench: Bench): string => {
  const { runs, standings } = standingsOf(input.results, bench);
  const [first] = runs;
  if (first === undefined) {
    return `<section><h2>${benchNames[bench]}</h2><p class="muted">Not run yet.</p></section>`;
  }
  const mark = markOf(first);
  const current = markOf({ bench, stephen: input.now }) === mark;
  const cases = new Set(runs.flatMap((run) => run.cases.map((each) => each.id)))
    .size;
  return `<section><h2>${benchNames[bench]}</h2><p class="muted">Stephen ${escaped(mark)}, ${runs.length} runs on ${cases} cases${current ? "" : `; <span class="bad">this checkout's Stephen is ${escaped(markOf({ bench, stephen: input.now }))}, not measured yet</span>`}.${runs.length < 2 ? " Run it once more to measure the noise." : ""}</p>${table(
    ["Number", "Open set", "Noise", "Hidden set"],
    standings.map((each) => [
      each.metric,
      shown(each.metric, each.value),
      each.noise === null ? "not measured" : shown(each.metric, each.noise),
      each.hidden === null ? "not run" : shown(each.metric, each.hidden),
    ])
  )}</section>`;
};

const kindsSection = (input: ReportInput): string => {
  const kinds = kindsOf(input.ask.now, input.ask.before);
  if (kinds.length === 0) {
    return "";
  }
  return `<section><h2>The next question, by kind of moment</h2><p class="muted">Worst first. "Before" is the Stephen measured just before this one.</p>${table(
    ["Kind", "What it asks", "Group", "Right", "Tries", "Before"],
    kinds.map((each) => [
      each.signal,
      signalPlain[each.signal],
      groups[signalGroup[each.signal]],
      shown("right", each.right),
      String(each.tries),
      each.before === null ? "" : shown("right", each.before),
    ])
  )}</section>`;
};

const wrongSection = (input: ReportInput): string => {
  const wrong = input.ask.now.filter((each) => !each.right);
  if (wrong.length === 0) {
    return "";
  }
  return `<section><h2>Lines that went wrong</h2><p class="muted">Read at least twenty before you trust a number, and write the pattern down in one sentence.</p>${table(
    ["Moment", "Kind", "They said", "He said", "Why"],
    wrong.map((each) => [
      each.moment,
      each.signal,
      each.said,
      each.line,
      each.why,
    ])
  )}</section>`;
};

const notesSection = (input: ReportInput): string => {
  const rows = input.notes.flatMap((each) => [
    ...each.lost.map((id) => [
      each.transcript,
      "said, and not written down",
      id,
    ]),
    ...each.notes
      .filter((note) => note.verdict !== undefined && note.verdict !== "said")
      .map((note) => [
        each.transcript,
        `written: ${note.verdict ?? ""}`,
        note.record,
      ]),
  ]);
  if (rows.length === 0) {
    return "";
  }
  return `<section><h2>Notes that went wrong</h2>${table(["Conversation", "What", "Fact"], rows)}</section>`;
};

const drawSection = (input: ReportInput): string => {
  const rows = input.draw.flatMap((each) => [
    ...each.card.found.missed.map((id) => [
      each.practice,
      "said, and not in the drawing",
      id,
    ]),
    ...each.card.numbers.lost.map((lost) => [
      each.practice,
      "a number it lost",
      lost,
    ]),
    ...each.card.supported.notSaid.map((part) => [
      each.practice,
      "drawn, and nobody said it",
      part,
    ]),
  ]);
  if (rows.length === 0) {
    return "";
  }
  return `<section><h2>What the drawing got wrong</h2>${table(["Practice company", "What", "Part"], rows)}</section>`;
};

const runsSection = (input: ReportInput): string =>
  `<section><h2>Every run</h2>${table(
    ["Run", "Bench", "Set", "Cases", "Stephen", "Means"],
    input.results
      .toReversed()
      .map((each) => [
        each.id,
        each.bench,
        each.set,
        String(each.cases.length),
        `${each.stephen.interviewer === "claire" ? "Claire " : ""}${markOf(each)}`,
        meansLine(each),
      ])
  )}</section>`;

/** The page. */
export const reportPage = (input: ReportInput): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stephen Lab</title><style>${pageStyle}</style></head><body><main><div><small>Stephen Lab · ${escaped(input.at.slice(0, 16).replace("T", " "))}</small><h1>Where Stephen stands</h1></div><p>Each bench on the newest Stephen measured. A change counts when it is larger than the noise, and holds on the hidden set too. Of the hidden set only numbers are shown.</p>${benches
    .filter((bench) => bench !== "whole")
    .map((bench) => benchSection(input, bench))
    .join(
      ""
    )}${benchSection(input, "whole")}${kindsSection(input)}${wrongSection(input)}${notesSection(input)}${drawSection(input)}${runsSection(input)}</main></body></html>\n`;

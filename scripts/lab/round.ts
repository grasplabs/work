/**
 * The commands of a round (GRA-338): run a bench on the Stephen you have,
 * compare two runs against the noise, cut and write moments, check the
 * judge against people, and read the report. A round goes: run a bench
 * twice and compare the two (what they differ by is the noise); read what
 * went wrong; make one change; run it again and compare; when it is better
 * than the noise, run both Stephens on the hidden set too, and keep the
 * change only when it holds there. Ported from the prototype
 * (grasplabs/prototype, packages/grasp: lab/cli.ts, lab/README.md).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Interviewer } from "@grasp-os/shared/onboarding";

import {
  benchAsk,
  benchDraw,
  benchNotes,
  checkMoments,
  isSignal,
  mineMoments,
  wantedMoments,
  writeMoments,
  writtenKinds,
} from "./bench.ts";
import type { BenchOptions, Drawn, Stand } from "./bench.ts";
import {
  dropMoment,
  keepMoment,
  keptMoments,
  momentsOf,
  named,
  transcriptsOf,
} from "./cases.ts";
import {
  agreementOf,
  answersSchema,
  checkOf,
  checkPage,
  keptScores,
  pickItems,
  trustedFrom,
} from "./check.ts";
import type { KeptScores } from "./check.ts";
import { compare, noiseOf, shown } from "./compare.ts";
import { ask, drawnAgain, openCore, spentLine, turnOn } from "./core.ts";
import type { Core } from "./core.ts";
import { keepJson, keepText, openFolder } from "./kept.ts";
import type { CaseSet } from "./kept.ts";
import { keyOf } from "./keys/index.ts";
import type { AnswerKey } from "./keys/types.ts";
import { practiceNamed, practices } from "./practice.ts";
import type { Practice } from "./practice.ts";
import { detailsFolder, reportInputOf, reportPage } from "./report.ts";
import {
  keepResult,
  markOf,
  meansLine,
  resultNamed,
  results,
  sameStephen,
  setOf,
  stephenVersion,
} from "./results.ts";
import type { Bench, CaseScore, Result } from "./results.ts";

/** Why a round stops: a sentence for whoever ran it. */
export class RoundStopError extends Error {
  override name = "RoundStopError";
}

/** What the commands of a round are given from the command line. */
export interface RoundArgs {
  /** The words after the command. */
  rest: readonly string[];
  label: string | undefined;
  only: readonly string[] | null;
  hidden: boolean;
  interviewer: Interviewer;
  practice: string | undefined;
  check: boolean;
  answers: string | undefined;
  count: number;
  from: number;
  log: (line: string) => void;
}

const setOfArgs = (args: RoundArgs): CaseSet =>
  args.hidden ? "hidden" : "open";

/** The local core as a bench runs on it. */
export const standOn = (core: Core, log: (line: string) => void): Stand => ({
  turn: async (who, turn, { lineOnly }) =>
    await turnOn(core, who, turn, { lineOnly }),
  asker: async (call) => await ask(core, call),
  drawings: async () => await drawnAgain(core),
  log,
});

/** Runs `work` on the local core, and closes the session after. */
const onCore = async <T>(work: (core: Core) => Promise<T>): Promise<T> => {
  const core = await openCore();
  try {
    return await work(core);
  } finally {
    core.session.close();
  }
};

const keyFor = (id: string): AnswerKey => {
  const key = keyOf(id);
  if (key === undefined) {
    throw new RoundStopError(`There is no key ${id}.`);
  }
  return key;
};

/** What the people of a practice company agreed to, and what of the key they said: what its work is drawn again from and judged by. */
const drawnOf = async (core: Core, practice: Practice): Promise<Drawn> => {
  const key = keyFor(practice.key);
  const tellers = await Promise.all(
    practice.people.map(async (person) => {
      const employee = key.employees.find(
        (each) => each.id === person.employee
      );
      const { progress } = await core.session.api.onboardingStaff.transcript(
        person.id
      );
      const agreed = (progress?.facts ?? [])
        .filter((fact) => fact.agreed === true && fact.out !== true)
        .map((fact) => `(${fact.tag}) ${fact.record}`);
      return employee === undefined || agreed.length === 0
        ? []
        : [{ employee, person: person.id, agreed }];
    })
  );
  const scores = keptScores(practice.id, practice.key);
  const said =
    scores === undefined
      ? null
      : [
          ...new Set(
            scores.scored.flatMap((each) =>
              each.judged.known
                .filter((known) => known.said)
                .map((known) => known.id)
            )
          ),
        ];
  return { id: practice.id, key, tellers: tellers.flat(), said };
};

const stamp = /[-:T]/gu;
const idPart = /[^a-z0-9]+/giu;

/** Runs one bench, and says its cases. */
const runBench = async (
  bench: Exclude<Bench, "whole">,
  stand: Stand,
  core: Core,
  args: RoundArgs,
  options: BenchOptions
): Promise<CaseScore[]> => {
  const { set } = options;
  if (bench === "notes") {
    return await benchNotes(
      stand,
      transcriptsOf(set).filter((each) => named(args.only, each.id)),
      options
    );
  }
  if (bench === "ask") {
    return await benchAsk(
      stand,
      momentsOf(set).filter((each) => named(args.only, each.id, each.signal)),
      options
    );
  }
  const practice = practiceNamed(args.practice);
  if (setOf(practice.key) !== set) {
    throw new RoundStopError(
      `The practice company ${practice.id} is not of the ${set} set: name one with --practice${set === "hidden" ? "" : ", or run with --hidden"}.`
    );
  }
  const { cases } = await benchDraw(
    stand,
    await drawnOf(core, practice),
    options
  );
  return cases;
};

const benchNames = ["notes", "ask", "draw"] as const;

const benchesNamed = (
  which: string | undefined
): (typeof benchNames)[number][] => {
  if (which === "all") {
    return ["ask", "notes", "draw"];
  }
  const found = benchNames.find((each) => each === which);
  if (found === undefined) {
    throw new RoundStopError(
      "Which bench? `vp run lab bench notes|ask|draw|all`"
    );
  }
  return [found];
};

/**
 * `bench notes|ask|draw|all`: runs a bench on the local core's Stephen
 * and keeps what it found, marked with the Stephen it ran. A run whose
 * Stephen changed while it ran is of two of him, and is not kept.
 */
export const runBenches = async (args: RoundArgs): Promise<void> => {
  const benches = benchesNamed(args.rest[0]);
  const set = setOfArgs(args);
  const label = args.label ?? "run";
  await onCore(async (core) => {
    const stand = standOn(core, args.log);
    for (const bench of benches) {
      const at = new Date().toISOString();
      const details = `${at.slice(0, 16).replace(stamp, "")}-${label.replace(idPart, "-").toLowerCase()}`;
      // oxlint-disable-next-line no-await-in-loop -- the mark before the run, to hold the one after to
      const before = await stephenVersion(args.interviewer, "en");
      // oxlint-disable-next-line no-await-in-loop -- one bench at a time
      const cases = await runBench(bench, stand, core, args, {
        set,
        interviewer: args.interviewer,
        keep: (id, value) => {
          keepJson(
            path.join(detailsFolder(details, bench), `${id}.json`),
            value
          );
        },
      });
      if (cases.length === 0) {
        args.log(`${bench}: there was nothing to run.`);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- the mark after the run
      const after = await stephenVersion(args.interviewer, "en");
      if (
        markOf({ bench, stephen: after }) !== markOf({ bench, stephen: before })
      ) {
        throw new RoundStopError(
          `${bench}: his text or code changed while this ran, so it is a run of two of him. Nothing is kept: run it again.`
        );
      }
      const { result, file } = keepResult({
        at,
        label,
        bench,
        set,
        stephen: before,
        via: core.via,
        cases,
        spent: spentLine(),
        ...(set === "open" ? { details } : {}),
      });
      args.log(
        `\n${bench} (${set}, ${cases.length} cases): ${meansLine(result)}\nKept as ${result.id}: ${file}${set === "open" ? `\nWhat each case wrote, to read: ${detailsFolder(details, bench)}` : ""}`
      );
    }
  });
  args.log(`\nSpent: ${spentLine()}`);
};

const table = (rows: readonly string[][]): string => {
  const widths = (rows[0] ?? []).map((_, at) =>
    Math.max(...rows.map((row) => (row[at] ?? "").length))
  );
  return rows
    .map((row) =>
      row.map((each, at) => each.padEnd(widths[at] ?? 0)).join("  ")
    )
    .join("\n");
};

/** Things that make two runs differ beside the Stephen they ran: said before the numbers. */
const mindsOf = (before: Result, after: Result): string[] => [
  ...((before.people ?? "") === (after.people ?? "") &&
  (before.seed ?? 0) === (after.seed ?? 0)
    ? []
    : [
        "Mind: the two runs did not talk to the same people (other tempers, or another seed).",
      ]),
  ...(before.via.quick === after.via.quick &&
  before.via.careful === after.via.careful &&
  before.via.gateway === after.via.gateway
    ? []
    : [
        "Mind: the two runs reached other models. What they differ by is also that.",
      ]),
  ...(before.stephen.interviewer === after.stephen.interviewer
    ? []
    : ["Mind: one run is Stephen's and the other Claire's."]),
];

/**
 * The comparison of two runs, as lines: number by number, with the noise
 * of the first one's Stephen and a verdict for each.
 */
export const comparison = (
  all: readonly Result[],
  before: Result,
  after: Result
): string[] => {
  if (before.bench !== after.bench || before.set !== after.set) {
    throw new RoundStopError(
      "Those two are not runs of the same bench on the same set."
    );
  }
  // The noise is what runs of the first run's Stephen differ by among themselves.
  const same = sameStephen(all, before);
  const noise = noiseOf(same);
  const rows = [
    [
      "Number",
      "Cases",
      "Before",
      "After",
      "Change",
      "Up",
      "Down",
      "Noise",
      "Verdict",
    ],
    ...compare(before, after, noise).map((each) => [
      each.metric,
      String(each.cases),
      shown(each.metric, each.before),
      shown(each.metric, each.after),
      `${each.change > 0 ? "+" : ""}${shown(each.metric, each.change)}`,
      String(each.up),
      String(each.down),
      each.noise === null ? "?" : shown(each.metric, each.noise),
      each.verdict,
    ]),
  ];
  const sameMark = markOf(before) === markOf(after);
  return [
    ...mindsOf(before, after),
    `${before.bench} (${before.set}): ${before.id} (Stephen ${markOf(before)}) against ${after.id} (Stephen ${markOf(after)})`,
    "",
    table(rows),
    "",
    noise === null
      ? `Noise is not measured: run the same bench twice on Stephen ${markOf(before)} first.`
      : `Noise is from ${same.length} runs of Stephen ${markOf(before)}. A change counts when it is larger than the noise and than 2 points.`,
    ...(sameMark
      ? [
          "Both runs are of the same Stephen: what they differ by is the noise itself.",
        ]
      : []),
  ];
};

/** `compare <run> <run>`: two runs side by side. */
export const compareRuns = (args: RoundArgs): void => {
  const all = results();
  const found = args.rest.slice(0, 2).map((name) => resultNamed(all, name));
  const [before, after] = found;
  if (found.length < 2 || before === undefined || after === undefined) {
    throw new RoundStopError(
      `Which runs? \`vp run lab compare <one> <other>\`, by id, the end of one, or a label. There are:\n${all.map((each) => `  ${each.id}`).join("\n")}`
    );
  }
  args.log(comparison(all, before, after).join("\n"));
};

/** `results`: every run kept. */
export const listResults = (args: RoundArgs): void => {
  for (const each of results()) {
    args.log(
      `${each.id.padEnd(52)} ${each.bench.padEnd(5)} ${each.set.padEnd(6)} ${String(each.cases.length).padStart(3)} cases  Stephen ${markOf(each)}  ${meansLine(each)}`
    );
  }
};

/**
 * `mine`: cuts moments from the conversations a model played, for the
 * next-question bench, and gives every cut moment a second look; with
 * `--check`, only the second look.
 */
export const mine = async (args: RoundArgs): Promise<void> => {
  const set = setOfArgs(args);
  await onCore(async (core) => {
    const { asker } = standOn(core, args.log);
    const cut = args.check
      ? null
      : await mineMoments(
          asker,
          transcriptsOf(set).filter((each) => each.by === "model")
        );
    for (const moment of cut ?? []) {
      keepMoment(moment, set);
    }
    const { plain, not } = await checkMoments(asker, keptMoments(set));
    for (const moment of not) {
      dropMoment(moment.id, set);
    }
    args.log(
      `${cut === null ? "" : `Cut ${cut.length} moments from the ${set === "hidden" ? "hidden " : ""}conversations a model played. `}On a second look ${plain.length} are plain and stay; ${not.length} were taken out again.\nSpent: ${spentLine()}`
    );
  });
};

/**
 * `write`: has a model write moments of the kinds no played interview
 * shows, each with a second look: for the hidden set with `--hidden`,
 * otherwise for the open set, to read.
 */
export const write = async (args: RoundArgs): Promise<void> => {
  const set = setOfArgs(args);
  const kinds = args.only ?? writtenKinds;
  const unknown = kinds.filter((kind) => !isSignal(kind));
  if (unknown.length > 0) {
    throw new RoundStopError(`No such kind of moment: ${unknown.join(", ")}.`);
  }
  await onCore(async (core) => {
    const { asker } = standOn(core, args.log);
    const { plain, not } = await writeMoments(
      asker,
      wantedMoments(set, kinds.filter(isSignal), args.count, args.from)
    );
    for (const moment of plain) {
      keepMoment(moment, set);
    }
    args.log(
      `A model wrote moments of the kinds no interview shows, for the ${set} set. On a second look ${plain.length} are plain and stay; ${not} were not kept.\nSpent: ${spentLine()}`
    );
  });
};

/** The practice companies a check is of: those named, or every one of the open set that was scored. */
const scoredOf = (args: RoundArgs): KeptScores[] => {
  const of =
    args.practice === undefined
      ? practices()
      : args.practice.split(",").map((each) => practiceNamed(each));
  return of.flatMap((practice) => keptScores(practice.id, practice.key) ?? []);
};

/**
 * `check`: a page of questions the judge answered, without its answers,
 * for a person to answer; with `--answers <file>`, how often the judge
 * agrees with what they answered.
 */
export const checkJudge = (args: RoundArgs): void => {
  const { interviews, items } = checkOf(scoredOf(args));
  if (args.answers !== undefined) {
    const answered = answersSchema.parse(
      JSON.parse(readFileSync(args.answers, "utf-8"))
    );
    const found = agreementOf(items, answered.answers);
    const share = found.answered === 0 ? 0 : found.agreed / found.answered;
    args.log(
      [
        `${answered.by} answered ${found.answered} questions. The judge agrees on ${found.agreed}: ${shown("agreed", share)}.`,
        `  Did they say it: ${found.byKind.said.agreed} of ${found.byKind.said.answered}.  Does the note rest on their words: ${found.byKind.supported.agreed} of ${found.byKind.supported.answered}.`,
        found.answered > 0 && share >= trustedFrom
          ? "That is nine in ten or more: the judge can be trusted on this."
          : "That is under nine in ten: read where they differ, and put the judge right before its numbers decide anything.",
        ...found.differ.map(
          ({ item, person }) =>
            `  ${item.interview}  ${item.kind}: "${item.text}"  judge ${item.judge ? "yes" : "no"}, ${answered.by} ${person ? "yes" : "no"}`
        ),
      ].join("\n")
    );
    return;
  }
  if (items.length === 0) {
    args.log("There is nothing scored to check yet: `vp run lab score` first.");
    return;
  }
  const picked = pickItems(items);
  const file = keepText(
    path.join(openFolder("out"), "judge-check.html"),
    checkPage(interviews, picked)
  );
  args.log(
    `${picked.length} questions about ${new Set(picked.map((item) => item.interview)).size} interviews: ${file}\nAnswer them in a browser, save the answers, then: \`vp run lab check --answers <the file>\``
  );
};

/** `report`: the page to read, from every run kept. */
export const report = async (args: RoundArgs): Promise<void> => {
  const at = new Date().toISOString();
  const page = reportPage(
    reportInputOf(at, await stephenVersion(args.interviewer, "en"), results())
  );
  args.log(
    `The report: ${keepText(path.join(openFolder("out"), "report.html"), page)}`
  );
};

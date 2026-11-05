/**
 * `vp run lab climb`: Stephen hill-climbs on his own. Started once, on the
 * machine whose Claude account the lab runs on (`vp run lab:dev`), it
 * measures him, asks for one change where he is weakest, measures again,
 * keeps the change only when it holds, and goes on until the goal is
 * reached on the hidden set or it gets stuck. A round goes:
 *
 * 1. The part to raise: the lowest of the six (lab-score.ts).
 * 2. One change, by Claude Code with only reading and editing
 *    (climb-agent.ts), from the cases behind that part. A change outside
 *    Stephen's files, with words copied from a key, that makes his text
 *    much longer, or that breaks core's test of his texts is undone.
 * 3. Its own bench again: the part must rise by more than its noise.
 * 4. Every bench on the open set: the score must rise by more than the
 *    noise, no part may drop by more than its own, every limit must hold.
 * 5. Every bench on the hidden set: the score must hold there too.
 * 6. Kept: his new marks in lab-marks.ts, and a commit with the runs that
 *    measured it. Otherwise everything he changed is undone.
 *
 * It stops when the goal is reached on the hidden set twice running, when
 * `misses` rounds in a row kept nothing (a person should look), after
 * `rounds` rounds, or on an error it can't wait out. When the account's
 * usage limit is reached it waits for it and goes on. Every round is
 * written to `out/climb/<id>.json`; kept changes are commits on the
 * branch, pushed when it stops, for a person to review before anything
 * reaches people.
 *
 * The loop is `climb`, over a `ClimbWorld`: the real one runs the lab's
 * own commands and git (`climbWorld`); the tests give it a made-up
 * Stephen.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { meansOf } from "@grasp-os/shared/lab-compare";
import type { Bench, Result } from "@grasp-os/shared/lab-runs";
import { scoresSchema } from "@grasp-os/shared/lab-runs";
import {
  keepsChange,
  scoreParts,
  standingOf,
} from "@grasp-os/shared/lab-score";
import type {
  PartStanding,
  ScoreGoal,
  ScoreNoise,
  ScorePart,
  ScoredRun,
  Standing,
} from "@grasp-os/shared/lab-score";
import { z } from "zod";

import { bridgeOrigin } from "./bridge.ts";
import {
  askForChange,
  checkChange,
  stephenFiles,
  unseenText,
} from "./climb-agent.ts";
import type { Brief, Proposal } from "./climb-agent.ts";
import { openCore, servedMarks } from "./core.ts";
import {
  allKept,
  folderOf,
  keepJson,
  openFolder,
  scoresFolder,
} from "./kept.ts";
import { repoRoot } from "./keys/index.ts";
import { labMarksFile } from "./marks.ts";
import type { Marks } from "./marks.ts";
import { practices } from "./practice.ts";
import { detailsFolder } from "./report.ts";
import { results } from "./results.ts";

/** Every bench the score is made of: whole interviews first, as the drawing draws their company. */
export const everyBench: readonly Bench[] = ["whole", "ask", "notes", "draw"];

/** What the loop needs of the world. */
export interface ClimbWorld {
  /** Runs `benches` on a set, labelled `label`, and gives their runs. */
  measure: (
    set: "open" | "hidden",
    benches: readonly Bench[],
    label: string
  ) => Promise<ScoredRun[]>;
  /** Where the cases behind a part are, from the open set's last runs. */
  casesOf: (part: ScorePart) => string[];
  /** Runs of words from the keys, moments and fixtures, which must not reach his text. */
  unseen: () => ReadonlySet<string>;
  /** One change asked for, and what it changed: the files, and the lines it added. */
  change: (
    brief: Brief
  ) => Promise<{ proposal: Proposal; changed: string[]; added: string }>;
  /** What his texts are now. */
  marks: () => Promise<Marks>;
  /** Core's test of his texts, with the new marks written: why it fails, or none. */
  holdsUp: () => Promise<string | undefined>;
  /** Waits until the running core speaks the texts on disk. */
  reloaded: (marks: Marks) => Promise<void>;
  /** Undoes everything he changed since the last kept change. */
  undo: () => Promise<void>;
  /** Commits the change with the runs that measured it. */
  keep: (message: string) => Promise<void>;
  /** Whether the account's usage limit is reached now. */
  limited: () => Promise<boolean>;
  wait: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export interface ClimbOptions {
  goal: ScoreGoal;
  /** The most rounds. */
  rounds: number;
  /** Rounds in a row that kept nothing, after which a person should look. */
  misses: number;
  /** How much longer his texts may grow, together, than when the climb started. */
  growth: number;
  /** The least noise counted, out of 10, however alike two runs were. */
  leastNoise: number;
  /** How long it waits for the usage limit, at most, and how often it looks. */
  limitWaitMs: number;
  limitLookMs: number;
  /** A name for this climb: in every label. */
  id: string;
}

export const defaultClimb: Omit<ClimbOptions, "goal" | "id"> = {
  rounds: 30,
  misses: 5,
  growth: 0.15,
  leastNoise: 0.1,
  limitWaitMs: 24 * 60 * 60_000,
  limitLookMs: 15 * 60_000,
};

/** One round, as the climb's record keeps it. */
export interface Round {
  round: number;
  part: string;
  pattern: string;
  change: string;
  kept: boolean;
  why: string;
  before: number | null;
  after?: number | null;
}

export interface Outcome {
  why: "reached" | "stuck" | "rounds" | "failed";
  said: string;
  rounds: Round[];
  open: Standing;
  hidden: Standing;
}

/** Why a step can't go on; the round is undone and counts as kept nothing. */
class MissError extends Error {
  override name = "MissError";
}

/** How far two runs of the same Stephen differ, out of 10, never less than `least`. */
export const noiseBetween = (
  one: Standing,
  other: Standing,
  least: number
): ScoreNoise => ({
  score: Math.max(least, Math.abs((one.score ?? 0) - (other.score ?? 0))),
  parts: Object.fromEntries(
    one.parts.map((part) => {
      const twin = other.parts.find((each) => each.id === part.id);
      return [
        part.id,
        Math.max(least, Math.abs((part.value ?? 0) - (twin?.value ?? 0))),
      ];
    })
  ),
});

/** The part to raise: the lowest; of two as low, the one that weighs more. */
export const partToRaise = (standing: Standing): PartStanding | undefined =>
  standing.parts.toSorted(
    (a, b) => (a.value ?? 0) - (b.value ?? 0) || b.weight - a.weight
  )[0];

/** A line of a commit's body, broken at 72 characters, as commits are read. */
export const wrapped = (line: string, width = 72): string[] => {
  const lines: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    if (current !== "" && current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current === "" ? word : `${current} ${word}`;
    }
  }
  return current === "" ? lines : [...lines, current];
};

const shown = (value: number | null | undefined): string =>
  value === null || value === undefined ? "–" : value.toFixed(1);

/** Runs `step`, waiting out the account's usage limit when that is why it failed. */
const patiently = async <T>(
  world: ClimbWorld,
  options: ClimbOptions,
  step: () => Promise<T>
): Promise<T> => {
  let waited = 0;
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one try at a time
      return await step();
    } catch (error) {
      // oxlint-disable-next-line no-await-in-loop -- asked after each failure
      const limited = await world.limited();
      if (!limited || waited >= options.limitWaitMs) {
        throw error;
      }
      world.log(
        `The account's usage limit is reached. Waiting ${Math.round(options.limitLookMs / 60_000)} minutes, then trying again.`
      );
      // oxlint-disable-next-line no-await-in-loop -- waits for the limit to lift
      await world.wait(options.limitLookMs);
      waited += options.limitLookMs;
    }
  }
};

/** Measures a set, labelled for this climb, waiting out the usage limit. */
type Measure = (
  set: "open" | "hidden",
  benches: readonly Bench[],
  what: string
) => Promise<ScoredRun[]>;

const measureFor =
  (world: ClimbWorld, options: ClimbOptions): Measure =>
  async (set, benches, what) =>
    await patiently(world, options, async () => {
      const runs = await world.measure(
        set,
        benches,
        `climb-${options.id}-${what}`
      );
      return runs;
    });

/** Where the climb stands between rounds: on both sets, with the noise and his texts at the start. */
interface Place {
  open: Standing;
  hidden: Standing;
  hiddenRuns: ScoredRun[];
  noise: ScoreNoise;
  start: Marks;
}

/** The goal, reached on two hidden runs in a row, looked at together. */
const confirmed = async (
  measure: Measure,
  goal: ScoreGoal,
  hiddenRuns: readonly ScoredRun[],
  what: string
): Promise<boolean> => {
  const again = await measure("hidden", everyBench, what);
  return (
    standingOf(again, goal).reached &&
    standingOf([...hiddenRuns, ...again], goal).reached
  );
};

/** Where he stands at the start: the open set twice, for the noise, and the hidden set once. */
const startingPlace = async (
  world: ClimbWorld,
  options: ClimbOptions,
  measure: Measure
): Promise<Place> => {
  world.log(
    "Where he stands: every bench twice on the open set, for the noise, and once on the hidden set."
  );
  const first = await measure("open", everyBench, "base-1");
  const second = await measure("open", everyBench, "base-2");
  const hiddenRuns = await measure("hidden", everyBench, "base-hidden");
  return {
    open: standingOf([...first, ...second], options.goal),
    hidden: standingOf(hiddenRuns, options.goal),
    hiddenRuns,
    noise: noiseBetween(
      standingOf(first, options.goal),
      standingOf(second, options.goal),
      options.leastNoise
    ),
    start: await world.marks(),
  };
};

/** One change asked for, and checked before anything is measured: a miss when it may not stand. */
const askChange = async (
  world: ClimbWorld,
  options: ClimbOptions,
  place: Place,
  part: PartStanding,
  spec: ScorePart,
  record: Round,
  tried: readonly Round[]
): Promise<void> => {
  const asked = await patiently(world, options, async () => {
    const answered = await world.change({
      part: {
        label: part.label,
        value: part.value ?? 0,
        metrics: spec.metrics,
      },
      goal: options.goal,
      score: place.open.score ?? 0,
      cases: world.casesOf(spec),
      tried: tried.map((each) => ({
        part: each.part,
        pattern: each.pattern,
        kept: each.kept,
        why: each.why,
      })),
    });
    return answered;
  });
  record.pattern = asked.proposal.pattern;
  record.change = asked.proposal.change;
  world.log(
    `  Pattern: ${asked.proposal.pattern}\n  Change: ${asked.proposal.change}`
  );
  if (!asked.proposal.made || asked.changed.length === 0) {
    throw new MissError("No change was made.");
  }
  const wrong = checkChange(asked.changed, asked.added, world.unseen());
  if (wrong !== undefined) {
    throw new MissError(wrong);
  }
  const now = await world.marks();
  if (now.length > place.start.length * (1 + options.growth)) {
    throw new MissError(
      `His texts grew to ${Math.round((100 * now.length) / place.start.length)}% of where the climb started.`
    );
  }
  const broken = await world.holdsUp();
  if (broken !== undefined) {
    throw new MissError(`Core's test of his texts fails: ${broken}`);
  }
  await world.reloaded(now);
};

/** The change measured: its own part, then every bench on the open set, then on the hidden one. */
const testChange = async (
  measure: Measure,
  goal: ScoreGoal,
  place: Place,
  part: PartStanding,
  spec: ScorePart,
  round: number
): Promise<Pick<Place, "open" | "hidden" | "hiddenRuns">> => {
  const quick = await measure("open", [spec.bench], `r${round}-quick`);
  const raised = standingOf(quick, goal).parts.find(
    (each) => each.id === part.id
  );
  const partNoise = place.noise.parts?.[part.id] ?? place.noise.score;
  if ((raised?.value ?? 0) - (part.value ?? 0) <= partNoise) {
    throw new MissError(
      `${part.label} went from ${shown(part.value)} to ${shown(raised?.value)}, not more than its noise (${partNoise.toFixed(1)}).`
    );
  }
  const full = await measure("open", everyBench, `r${round}-open`);
  const open = standingOf([...full, ...quick], goal);
  const onOpen = keepsChange(place.open, open, place.noise);
  if (!onOpen.keep) {
    throw new MissError(`Open set: ${onOpen.why}`);
  }
  const hiddenRuns = await measure("hidden", everyBench, `r${round}-hidden`);
  const hidden = standingOf(hiddenRuns, goal);
  const onHidden = keepsChange(place.hidden, hidden, place.noise, {
    mustRise: false,
  });
  if (!onHidden.keep) {
    throw new MissError(`Hidden set: ${onHidden.why}`);
  }
  return { open, hidden, hiddenRuns };
};

/** The commit of a kept change: what went wrong, what changed, and the numbers. */
const commitOf = (
  options: ClimbOptions,
  record: Round,
  part: PartStanding,
  before: Place,
  after: Pick<Place, "open" | "hidden">
): string =>
  [
    `fix(core): raise Stephen's ${part.label.toLowerCase()} from ${shown(part.value)} to ${shown(after.open.parts.find((each) => each.id === part.id)?.value)}`,
    "",
    ...wrapped(`Stephen Lab climb ${options.id}, round ${record.round}.`),
    "",
    ...wrapped(`What went wrong: ${record.pattern}`),
    ...wrapped(`What changed: ${record.change}`),
    "",
    ...wrapped(
      `Score on the open set: ${shown(before.open.score)} to ${shown(after.open.score)}; on the hidden set: ${shown(before.hidden.score)} to ${shown(after.hidden.score)}. Noise: ${before.noise.score.toFixed(1)}.`
    ),
  ].join("\n");

/** One round: a change asked for, checked, measured and kept; a miss, undone, when it doesn't hold. */
const roundOf = async (
  world: ClimbWorld,
  options: ClimbOptions,
  measure: Measure,
  place: Place,
  record: Round,
  tried: readonly Round[]
): Promise<Place> => {
  const part = partToRaise(place.open);
  const spec = scoreParts.find((each) => each.id === part?.id);
  if (part === undefined || spec === undefined) {
    throw new Error("There is no part to raise.");
  }
  record.part = part.label;
  world.log(`\nRound ${record.round}: ${part.label} (${shown(part.value)}).`);
  await askChange(world, options, place, part, spec, record, tried);
  const after = await testChange(
    measure,
    options.goal,
    place,
    part,
    spec,
    record.round
  );
  record.after = after.open.score;
  await world.keep(commitOf(options, record, part, place, after));
  record.kept = true;
  record.why = `The score rose to ${shown(after.open.score)}.`;
  world.log(
    `  Kept. Open ${shown(after.open.score)}, hidden ${shown(after.hidden.score)}, lowest ${after.open.lowest?.label} ${shown(after.open.lowest?.value)}.`
  );
  return { ...place, ...after };
};

/** The climb: measures, changes, measures again, keeps or undoes, until it stops. */
export const climb = async (
  world: ClimbWorld,
  options: ClimbOptions
): Promise<Outcome> => {
  const measure = measureFor(world, options);
  let place = await startingPlace(world, options, measure);
  const rounds: Round[] = [];
  const outcome = (why: Outcome["why"], said: string): Outcome => {
    world.log(said);
    return { why, said, rounds, open: place.open, hidden: place.hidden };
  };
  if (place.open.score === null || place.hidden.score === null) {
    return outcome(
      "failed",
      `Not every part could be measured: ${[...new Set([...place.open.missing, ...place.hidden.missing])].join(", ")}. Make the practice company's moments and conversations first (practice, simulate, keep, mine).`
    );
  }
  world.log(
    `Open: ${shown(place.open.score)} (lowest ${place.open.lowest?.label} ${shown(place.open.lowest?.value)}). Hidden: ${shown(place.hidden.score)}. Noise: ${place.noise.score.toFixed(1)}.`
  );
  if (
    place.hidden.reached &&
    (await confirmed(measure, options.goal, place.hiddenRuns, "base-confirm"))
  ) {
    return outcome("reached", "The goal is already reached on the hidden set.");
  }
  let missed = 0;
  for (let round = 1; round <= options.rounds; round += 1) {
    if (missed >= options.misses) {
      return outcome(
        "stuck",
        `${missed} rounds in a row kept nothing. A person should look at what was tried (out/climb/${options.id}.json).`
      );
    }
    const record: Round = {
      round,
      part: "",
      pattern: "",
      change: "",
      kept: false,
      why: "",
      before: place.open.score,
    };
    const tried = [...rounds];
    rounds.push(record);
    try {
      // oxlint-disable-next-line no-await-in-loop -- one round at a time
      place = await roundOf(world, options, measure, place, record, tried);
      missed = 0;
    } catch (error) {
      // oxlint-disable-next-line no-await-in-loop -- undone before the next round
      await world.undo();
      if (!(error instanceof MissError)) {
        record.why = error instanceof Error ? error.message : String(error);
        return outcome("failed", `The climb stopped: ${record.why}`);
      }
      record.why = error.message;
      missed += 1;
      world.log(`  Undone: ${error.message}`);
      continue;
    }
    if (
      place.hidden.reached &&
      // oxlint-disable-next-line no-await-in-loop -- only once it looks reached
      (await confirmed(
        measure,
        options.goal,
        place.hiddenRuns,
        `r${round}-confirm`
      ))
    ) {
      return outcome(
        "reached",
        `The goal is reached: ${shown(place.hidden.score)} on the hidden set, no part under ${options.goal.floor.toFixed(1)}, every limit held.`
      );
    }
  }
  return outcome("rounds", `${options.rounds} rounds are done.`);
};

// ---------------------------------------------------------------------------
// The real world: the lab's own commands, git, and the running core

/** Runs a command in the repository and gives what it printed; an error when it fails. */
const run = async (
  command: string,
  args: readonly string[]
): Promise<string> => {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (piece: Buffer) => {
    out += piece.toString();
  });
  child.stderr.resume();
  await once(child, "close");
  if (child.exitCode !== 0) {
    throw new Error(
      `${path.basename(command)} ${args.join(" ")} failed (${String(child.exitCode)}).`
    );
  }
  return out;
};

/** Runs a lab command as its own process, its output shown as it goes. */
const lab = async (args: readonly string[]): Promise<void> => {
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, "run.ts"), ...args],
    { cwd: repoRoot, stdio: "inherit" }
  );
  await once(child, "exit");
  if (child.exitCode !== 0) {
    throw new Error(
      `\`vp run lab ${args.join(" ")}\` stopped (${String(child.exitCode)}).`
    );
  }
};

const git = async (args: readonly string[]): Promise<string> =>
  await run("git", args);

const marksSchema = z.object({
  marks: z.array(z.string()),
  length: z.number(),
});

/** His texts as the files say them now, read by a process of their own. */
const marksOnDisk = async (write: boolean): Promise<Marks> => {
  const stdout = await run(process.execPath, [
    path.join(import.meta.dirname, "marks.ts"),
    write ? "write" : "print",
  ]);
  return marksSchema.parse(JSON.parse(stdout));
};

const statsSchema = z.looseObject({ spent: z.unknown().nullable() });

/** The runs a label left: of the open set every case, of the hidden set its means. */
const runsLabelled = (set: "open" | "hidden", label: string): ScoredRun[] =>
  set === "open"
    ? results()
        .filter((each) => each.set === "open" && each.label === label)
        .map((each) => ({ bench: each.bench, means: meansOf(each.cases) }))
    : allKept(scoresFolder, scoresSchema)
        .filter((each) => each.label === label)
        .map((each) => ({ bench: each.bench, means: each.means }));

/** Where the cases of a run are: a whole run's practice company, or a bench's details. */
const casesFolderOf = (result: Result): string => {
  if (result.bench === "whole") {
    return path.join(folderOf("out", result.key ?? ""), result.practice ?? "");
  }
  return result.details === undefined
    ? openFolder("out")
    : detailsFolder(result.details, result.bench);
};

/** The newest practice company of a key: the one `practice` just made. */
const newestOf = (key: string): string | undefined =>
  practices().find((each) => each.key === key)?.id;

/** The world of a climb on this machine: keys `open` and `hidden` for whole interviews, people of `seed`. */
export const climbWorld = (setting: {
  keys: { open: string; hidden: string };
  seed: number;
  log: (line: string) => void;
}): ClimbWorld => {
  let unseen: Set<string> | undefined;
  return {
    measure: async (set, benches, label) => {
      const hidden = set === "hidden" ? ["--hidden"] : [];
      const key = set === "open" ? setting.keys.open : setting.keys.hidden;
      for (const bench of benches) {
        if (bench === "whole") {
          // oxlint-disable-next-line no-await-in-loop -- one step at a time
          await lab(["practice", key]);
          const practice = newestOf(key) ?? "";
          // oxlint-disable-next-line no-await-in-loop -- one step at a time
          await lab([
            "simulate",
            "--practice",
            practice,
            "--seed",
            String(setting.seed),
          ]);
          // oxlint-disable-next-line no-await-in-loop -- one step at a time
          await lab(["score", "--practice", practice, "--label", label]);
        } else {
          const practice = newestOf(key);
          // oxlint-disable-next-line no-await-in-loop -- one bench at a time
          await lab([
            "bench",
            bench,
            "--label",
            label,
            ...hidden,
            ...(bench === "draw" && practice !== undefined
              ? ["--practice", practice]
              : []),
          ]);
        }
      }
      return runsLabelled(set, label);
    },
    unseen: () => {
      unseen ??= unseenText(import.meta.dirname);
      return unseen;
    },
    casesOf: (part) => {
      const newest = results().findLast(
        (each) => each.set === "open" && each.bench === part.bench
      );
      if (newest === undefined) {
        return [];
      }
      return [path.relative(repoRoot, casesFolderOf(newest))];
    },
    change: async (brief) => {
      const proposal = await askForChange(repoRoot, brief);
      const status = await git([
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      const changed = status
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => line.slice(3).trim())
        .filter(
          (file) =>
            !file.startsWith("scripts/lab/results/") &&
            !file.startsWith("scripts/lab/scores/")
        );
      const diff = await git(["diff", "-U0", "--", ...stephenFiles]);
      const added = diff
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .map((line) => line.slice(1))
        .join("\n");
      return { proposal, changed, added };
    },
    marks: async () => await marksOnDisk(false),
    holdsUp: async () => {
      await marksOnDisk(true);
      const vp = path.join(repoRoot, "node_modules/.bin/vp");
      // Format, lint and types of his files, as the commit hook will hold
      // them, then core's test of his texts.
      const checks: [string[], string][] = [
        [["check", "--fix", ...stephenFiles], "`vp check` fails on his files"],
        [
          ["test", "apps/core/test/interviewer-text.test.ts"],
          "run `vp test apps/core/test/interviewer-text.test.ts` to see which",
        ],
      ];
      let broken: string | undefined;
      for (const [args, said] of checks) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one check at a time
          await run(vp, args);
        } catch {
          broken = said;
          break;
        }
      }
      return broken;
    },
    reloaded: async (marks) => {
      const core = await openCore();
      try {
        for (let tries = 0; tries < 60; tries += 1) {
          // oxlint-disable-next-line no-await-in-loop -- asks until it says the new ones
          const served = await servedMarks(core);
          if (served.join(",") === marks.marks.join(",")) {
            // A change in code alone moves no mark: a little longer, for the reload.
            // oxlint-disable-next-line no-await-in-loop -- once
            await sleep(15_000);
            return;
          }
          // oxlint-disable-next-line no-await-in-loop -- waits for the reload
          await sleep(5000);
        }
      } finally {
        core.session.close();
      }
      throw new Error(
        "The running core didn't take up his new texts within 5 minutes."
      );
    },
    undo: async () => {
      // From the last commit, index and all: a commit that failed leaves
      // the change staged, and the index alone would keep it.
      await git([
        "checkout",
        "HEAD",
        "--",
        ...stephenFiles,
        path.relative(repoRoot, labMarksFile),
      ]);
    },
    keep: async (message) => {
      await git([
        "add",
        "--",
        ...stephenFiles,
        path.relative(repoRoot, labMarksFile),
        "scripts/lab/results",
        "scripts/lab/scores",
      ]);
      await git(["commit", "--quiet", "-m", message]);
    },
    limited: async () => {
      try {
        const response = await fetch(new URL("/stats", bridgeOrigin));
        const stats = statsSchema.parse(await response.json());
        return stats.spent !== null;
      } catch {
        return false;
      }
    },
    wait: async (ms) => {
      await sleep(ms);
    },
    log: setting.log,
  };
};

/** Where a climb's rounds are written down, outside git. */
export const climbRecord = (id: string): string =>
  path.join(openFolder("out"), "climb", `${id}.json`);

/**
 * `vp run lab climb`: the branch first (a `feat/stephen-climb-…` of its
 * own when on main), Stephen's files as they are committed, then the climb,
 * and its branch pushed when it stops.
 */
export const startClimb = async (setting: {
  goal: ScoreGoal;
  rounds: number;
  keys: { open: string; hidden: string };
  seed: number;
  log: (line: string) => void;
}): Promise<Outcome> => {
  if (process.env.LAB_HIDDEN === undefined) {
    throw new Error(
      "A climb confirms every change on the hidden set: set LAB_HIDDEN."
    );
  }
  const dirty = await git([
    "status",
    "--porcelain",
    "--",
    ...stephenFiles,
    path.relative(repoRoot, labMarksFile),
  ]);
  if (dirty.trim() !== "") {
    throw new Error(
      "Stephen's files have changes that aren't committed. Commit or undo them first."
    );
  }
  const id = new Date().toISOString().slice(0, 16).replaceAll(/[-:T]/gu, "");
  const showing = await git(["branch", "--show-current"]);
  const branch = showing.trim();
  if (branch === "main" || branch === "") {
    await git(["checkout", "-b", `feat/stephen-climb-${id}`]);
  }
  const record: { id: string; started: string; outcome?: Outcome } = {
    id,
    started: new Date().toISOString(),
  };
  const world = climbWorld(setting);
  const outcome = await climb(world, {
    ...defaultClimb,
    goal: setting.goal,
    rounds: setting.rounds,
    id,
  });
  record.outcome = outcome;
  keepJson(climbRecord(id), record);
  const after = await git(["branch", "--show-current"]);
  const current = after.trim();
  if (outcome.rounds.some((each) => each.kept)) {
    try {
      await git(["push", "-u", "origin", current]);
      setting.log(
        `\nPushed ${current}. Open a pull request for it: what was kept, and why, is in its commits.`
      );
    } catch {
      setting.log(
        `\nThe branch ${current} could not be pushed: push it yourself.`
      );
    }
  }
  setting.log(`The climb's rounds: ${climbRecord(id)}`);
  return outcome;
};

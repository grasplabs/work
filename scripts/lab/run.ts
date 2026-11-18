/**
 * `vp run lab <command>`: the Stephen Lab (GRA-337). It measures the
 * Stephen people meet, on practice companies whose truth we know: answer
 * keys (keys/), made into the local core's onboarding through its own API,
 * with people who answer as people do (people.ts). It holds no copy of
 * him: every turn is a real turn of the local core, and every model call
 * of the lab's own (the people it plays, the judge) goes through core's
 * model gateway, never with a provider key of its own.
 * Run it while `vp run lab:dev` runs; it reaches only localhost, signed in as
 * the stack's Grasp staff member through the fake IdP, as the seed does.
 *
 * The commands that play or judge (practice, simulate, score, keep,
 * bench, mine, write) are run by hand, never by CI, whose tests use fakes.
 *
 * Commands:
 *   keys                     checks the answer keys
 *   practice <key>           makes a practice company of a key, and lets its
 *                            lead talk (--locale en|nl|de|fr|es)
 *   card <person>            a role card with its link, for whoever plays it
 *   simulate                 a model plays everyone who hasn't talked yet:
 *                            --seed 2 for another mix of people, --ideal for
 *                            people who tell all they know, --people v1 for
 *                            one temper each that never changes (people v2,
 *                            a mix and a state that drifts, is the default),
 *                            --only a,b,
 *                            --interviewer claire, --parallel 2
 *   score                    the score card of every interview that counts
 *                            (--label <name>)
 *   keep                     keeps its interviews as fixed input for the benches
 *   bench notes|ask|draw|all a bench on the Stephen you have, kept as a run:
 *                            --label <name>, --only a,b (ids or kinds),
 *                            --hidden, --interviewer claire; draw draws the
 *                            practice company in core again (--practice)
 *   compare <run> <run>      two runs side by side, with the noise and a
 *                            verdict for each number
 *   results                  every run kept
 *   standing                 the Stephen Score of this checkout's Stephen,
 *                            from the runs kept of him: six parts out of
 *                            10, the average, the lowest against the
 *                            floor, the limits (--hidden, --api)
 *   mine                     cuts moments from the conversations a model
 *                            played, each with a second look (--check for
 *                            only the second look, --hidden)
 *   write                    a model writes moments of the kinds no played
 *                            interview shows, each with a second look
 *                            (--hidden, --count 2, --only kinds, --from 2)
 *   check                    a page to check the judge against a person
 *                            (--practice a,b); --answers <file> counts how
 *                            often they agree: nine in ten at least
 *   report                   the page to read: where each bench stands, by
 *                            kind of moment, what went wrong, every run
 *
 * Its models run on a Claude subscription, through the lab's bridge:
 * start the stack with `vp run lab:dev` instead of `vp run dev`
 * (scripts/lab/dev.ts). Every command that reaches core first checks that
 * its calls really arrive there, and stops when they don't. `--api` runs
 * on the API instead, on a stack started with `vp run dev`: it spends
 * money, so it is for the one check at the end of a climb.
 *
 * `--practice <id>` names a practice company; the newest by default. Keys
 * 03 and 06 are the hidden test set, read from `LAB_HIDDEN`, outside the
 * repository (keys/index.ts): of them only scores are shown.
 */
import path from "node:path";
import { parseArgs } from "node:util";

import { interviewLocaleSchema } from "@grasp-os/shared/onboarding";

import { linksOf, openCore, spentLine } from "./core.ts";
import { hiddenKeyIds, isHidden, keyOf, openKeys } from "./keys/index.ts";
import { problemsIn } from "./keys/types.ts";
import type { AnswerKey } from "./keys/types.ts";
import { peopleVersionOf } from "./people-v2.ts";
import {
  cardsFolder,
  keepCards,
  makePractice,
  practiceNamed,
} from "./practice.ts";
import {
  checkJudge,
  compareRuns,
  listResults,
  mine,
  report,
  runBenches,
  showStanding,
  write,
} from "./round.ts";
import type { RoundArgs } from "./round.ts";
import { keepTranscripts, score } from "./score.ts";
import { simulate } from "./simulate.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    locale: { type: "string" },
    practice: { type: "string" },
    seed: { type: "string" },
    ideal: { type: "boolean", default: false },
    people: { type: "string" },
    only: { type: "string" },
    interviewer: { type: "string" },
    parallel: { type: "string" },
    label: { type: "string" },
    hidden: { type: "boolean", default: false },
    api: { type: "boolean", default: false },
    check: { type: "boolean", default: false },
    answers: { type: "string" },
    count: { type: "string" },
    from: { type: "string" },
  },
});

const [command, ...rest] = positionals;

const log = (line: string): void => {
  console.log(line);
};

/** Why the lab stops: a sentence for whoever ran it. */
class LabStopError extends Error {
  override name = "LabStopError";
}

const keyFor = (id: string | undefined): AnswerKey => {
  if (id === undefined) {
    throw new LabStopError("Which key? `vp run lab practice 01`");
  }
  const key = keyOf(id);
  if (key === undefined) {
    throw new LabStopError(
      `There is no key ${id}. There are: ${[...Object.keys(openKeys), ...hiddenKeyIds].join(", ")}.`
    );
  }
  return key;
};

const countOf = (value: string | undefined, fallback: number): number => {
  const count = Number(value ?? fallback);
  return Number.isInteger(count) && count >= 1 ? count : fallback;
};

const checkKeys = (): void => {
  for (const [id, key] of Object.entries(openKeys)) {
    const problems = problemsIn(key);
    log(
      `${id}  ${key.name.padEnd(62)} ${String(key.facts.length).padStart(3)} facts  ${String(key.employees.length).padStart(2)} people  ${problems.length === 0 ? "usable" : `${problems.length} problems`}`
    );
    for (const problem of problems) {
      log(`    ${problem}`);
    }
  }
  if (process.env.LAB_HIDDEN === undefined) {
    log(
      `${hiddenKeyIds.join(", ")}  the hidden test set: not read without LAB_HIDDEN`
    );
    return;
  }
  for (const id of hiddenKeyIds) {
    // A hidden key is counted, never shown.
    const problems = problemsIn(keyFor(id));
    log(
      `${id}  ${"(hidden test set)".padEnd(62)} ${problems.length === 0 ? "usable" : `${problems.length} problems`}`
    );
  }
};

const startPractice = async (): Promise<void> => {
  const key = keyFor(rest[0]);
  const locale = interviewLocaleSchema.safeParse(values.locale).data ?? "en";
  const core = await openCore({ api: values.api });
  try {
    const made = await makePractice(core, key, locale, log);
    log(`\nThe practice company is ready: ${made.id}`);
    if (!isHidden(key.id)) {
      log(`The role cards, each with its link: ${cardsFolder(made)}`);
      log("Let a model play them: `vp run lab simulate`");
    }
    log(`Spent: ${spentLine()}`);
  } finally {
    core.session.close();
  }
};

const showCard = async (): Promise<void> => {
  const practice = practiceNamed(values.practice);
  const key = keyFor(practice.key);
  if (isHidden(key.id)) {
    throw new LabStopError(
      "A hidden key has no role cards: nobody reads what its people know."
    );
  }
  const core = await openCore({ api: values.api });
  try {
    const links = await linksOf(core);
    const files = keepCards(practice, key, links);
    const [named] = rest;
    const file = files.find(
      (each) =>
        named !== undefined &&
        path.basename(each, ".txt").toLowerCase().endsWith(named.toLowerCase())
    );
    log(
      file === undefined
        ? `Whose card? They are: ${practice.people.map((person) => `${person.id} (${person.name})`).join(", ")}`
        : `The card, with its link: ${file}`
    );
  } finally {
    core.session.close();
  }
};

const playRest = async (): Promise<void> => {
  const practice = practiceNamed(values.practice);
  const key = keyFor(practice.key);
  const core = await openCore({ api: values.api });
  try {
    const played = await simulate(core, practice, key, {
      only: values.only === undefined ? null : values.only.split(","),
      seed: countOf(values.seed, 1),
      ideal: values.ideal,
      people: peopleVersionOf(values.people),
      interviewer: values.interviewer === "claire" ? "claire" : "stephen",
      parallel: countOf(values.parallel, 2),
      log,
    });
    log(
      `\n${played} interviews played. Spent: ${spentLine()}. Score them: \`vp run lab score\``
    );
  } finally {
    core.session.close();
  }
};

const scoreAll = async (): Promise<void> => {
  const practice = practiceNamed(values.practice);
  const key = keyFor(practice.key);
  const core = await openCore({ api: values.api });
  try {
    await score(core, practice, key, { label: values.label, log });
    log(`Spent: ${spentLine()}`);
  } finally {
    core.session.close();
  }
};

const keepAll = async (): Promise<void> => {
  const practice = practiceNamed(values.practice);
  const key = keyFor(practice.key);
  const core = await openCore({ api: values.api });
  try {
    const files = await keepTranscripts(core, practice, key);
    log(
      isHidden(key.id)
        ? `Kept ${files.length} conversations of a hidden key, outside the repository.`
        : `Kept ${files.length} conversations:\n${files.map((file) => `  ${file}`).join("\n")}`
    );
    log(`Spent: ${spentLine()}`);
  } finally {
    core.session.close();
  }
};

const roundArgs = (): RoundArgs => ({
  rest,
  label: values.label,
  only:
    values.only === undefined
      ? null
      : values.only.split(",").map((each) => each.trim()),
  hidden: values.hidden,
  api: values.api,
  interviewer: values.interviewer === "claire" ? "claire" : "stephen",
  practice: values.practice,
  check: values.check,
  answers: values.answers,
  count: countOf(values.count, 2),
  from: Math.max(Number(values.from ?? 0) || 0, 0),
  log,
});

const commands: Readonly<Record<string, () => Promise<void> | void>> = {
  keys: checkKeys,
  practice: startPractice,
  card: showCard,
  simulate: playRest,
  score: scoreAll,
  keep: keepAll,
  bench: async () => {
    await runBenches(roundArgs());
  },
  compare: () => {
    compareRuns(roundArgs());
  },
  results: () => {
    listResults(roundArgs());
  },
  standing: async () => {
    await showStanding(roundArgs());
  },
  mine: async () => {
    await mine(roundArgs());
  },
  write: async () => {
    await write(roundArgs());
  },
  check: () => {
    checkJudge(roundArgs());
  },
  report: async () => {
    await report(roundArgs());
  },
};

const run = commands[command ?? ""];
if (run === undefined) {
  console.error(
    `Which command? ${Object.keys(commands).join(", ")}. See scripts/lab/run.ts.`
  );
  process.exitCode = 1;
} else {
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/**
 * `score` and `keep`: the score card of every interview of a practice
 * company that is agreed to, or that someone went away from; and its
 * interviews kept as fixed input for the benches (GRA-338). What was said
 * and written is read from the local core, as Grasp's staff read an
 * interview, so an interview a person played on the page counts the same
 * as one a model played. Of a hidden key only the sums are shown, and
 * everything is kept outside the repository. Ported from the prototype
 * (grasplabs/prototype, packages/grasp: scoreAll and keepAll in
 * lab/cli.ts, keepTranscripts in lab/bench.ts).
 */
import path from "node:path";

import type { InterviewFact } from "@grasp-os/shared/interview-links";
import type { InterviewPhase } from "@grasp-os/shared/interview-turn";
import type { StaffTranscript } from "@grasp-os/shared/onboarding-staff";

import {
  cardColumns,
  cardRow,
  realScores,
  scoreCardOf,
  totalOf,
} from "./card.ts";
import type { Judged, RealCard, ScoreCard } from "./card.ts";
import { inTurns, spentLine } from "./core.ts";
import type { Core } from "./core.ts";
import { hardTurns, judge, judgeTruth } from "./judge.ts";
import { folderOf, keepJson } from "./kept.ts";
import { isHidden } from "./keys/index.ts";
import { factText, sliceOf } from "./keys/types.ts";
import type { AnswerKey } from "./keys/types.ts";
import { nonsense } from "./moves.ts";
import { temperPlain, tempers } from "./people.ts";
import type { Said } from "./person.ts";
import { askerOf } from "./practice.ts";
import type { Practice, PracticePerson } from "./practice.ts";
import { keepResult, setOf, stephenVersion } from "./results.ts";
import type { Result } from "./results.ts";

/** How many interviews are judged at once. */
const judgedAtOnce = 3;

/** Someone's interview as the local core keeps it, read as Grasp's staff. */
interface Held {
  person: PracticePerson;
  transcript: StaffTranscript;
  lines: Said[];
  facts: InterviewFact[];
}

/** The interviews of a practice company that count: agreed to, or left. */
const heldOf = async (core: Core, practice: Practice): Promise<Held[]> => {
  const all = await Promise.all(
    practice.people.map(async (person) => {
      const transcript = await core.session.api.onboardingStaff.transcript(
        person.id
      );
      const { progress } = transcript;
      // Someone who went away agreed to nothing, and is scored all the same: that is what it cost.
      const counts =
        progress !== null &&
        (transcript.completedAt !== null || person.played?.left === true);
      return counts
        ? [
            {
              person,
              transcript,
              lines: progress.lines.map(({ from, text }) => ({ from, text })),
              facts: progress.facts,
            },
          ]
        : [];
    })
  );
  return all.flat();
};

/** How long an interview a person played took them; none for a model, whose speed says nothing. */
const minutesOf = (held: Held): number | null => {
  if (held.person.played !== undefined) {
    return held.person.played.minutes;
  }
  const { startedAt, completedAt } = held.transcript;
  return startedAt === null || completedAt === null
    ? null
    : (Date.parse(completedAt) - Date.parse(startedAt)) / 60_000;
};

const isTemper = (
  value: string | undefined
): value is keyof typeof temperPlain =>
  tempers.some((temper) => temper === value);

/** What one card found, in sentences: what was never said, what was said and not written, what was written and not said, and how he asked. */
const detailOf = (name: string, card: ScoreCard, key: AnswerKey): string[] => {
  const text = (id: string) => {
    const fact = key.facts.find((each) => each.id === id);
    return `${id}: ${fact === undefined ? "" : factText(fact)}`;
  };
  const { manner, burden, judgeAgrees } = card;
  return [
    "",
    name,
    ...(card.heard.missed.length > 0
      ? ["Never said:", ...card.heard.missed.map((id) => `- ${text(id)}`)]
      : []),
    ...(card.written.lost.length > 0
      ? [
          "Said, and not written down:",
          ...card.written.lost.map((id) => `- ${text(id)}`),
        ]
      : []),
    ...(card.supported.notSaid.length > 0
      ? [
          "Written down, and not said:",
          ...card.supported.notSaid.map((fact) => `- ${fact}`),
        ]
      : []),
    `How he asked: ${manner.lines} lines, ${manner.wordsPerLine} words in a normal one; ${manner.twoQuestions} with two questions, ${manner.longQuestions} with a long question, ${manner.praise} with praise or filler; ${manner.thanks} with thanks, ${manner.sameStart} that start like the line before.`,
    `What it cost: ${burden.answers} answers${burden.minutes === null ? "" : `, ${burden.minutes.toFixed(0)} minutes`}; Stephen said ${Math.round(burden.stephenShare * 100)}% of the words; in the read-back, lines taken out: ${burden.takenOut}, lines added: ${burden.addedInReadBack}.`,
    ...(judgeAgrees === null
      ? []
      : [
          `The judge and the model that played them agree on ${judgeAgrees.count} of ${judgeAgrees.of} facts.`,
        ]),
  ];
};

const verdictText = {
  fact: "Written as a fact",
  marked: "Written, and marked as a guess or the procedure",
  absent: "Not written",
} as const;

/** What an interview with someone who has a temper found, in sentences. */
const realDetail = (real: RealCard): string[] => [
  `Who they were: ${real.temper}. ${isTemper(real.temper) ? temperPlain[real.temper] : ""}${real.left ? " They went away before the read-back: nothing was agreed to." : ""}`,
  ...(real.hard.length > 0
    ? [
        "Hard turns:",
        ...real.hard.map(
          (each) =>
            `- ${each.right ? "Right" : "Wrong"} (${each.move}). They: "${each.said}" He: "${each.line}" ${each.why}`
        ),
      ]
    : []),
  ...(real.untrue.length > 0
    ? [
        "What they said that was not so, and what became of it in his notes:",
        ...real.untrue.map(
          (each) => `- ${verdictText[each.verdict]}: ${each.claim}`
        ),
      ]
    : []),
];

const table = (rows: string[][]): string => {
  const widths = (rows[0] ?? []).map((_, at) =>
    Math.max(...rows.map((row) => (row[at] ?? "").length))
  );
  return rows
    .map((row) =>
      row.map((cell, at) => cell.padEnd(widths[at] ?? 0)).join("  ")
    )
    .join("\n");
};

const share = (count: number, of: number): number =>
  of === 0 ? 0 : count / of;

/** One interview, scored. */
interface Scored {
  person: PracticePerson;
  card: ScoreCard;
  judged: Judged;
  real: RealCard | null;
}

const scoreOne = async (
  core: Core,
  key: AnswerKey,
  held: Held
): Promise<Scored | null> => {
  const asker = askerOf(core);
  const employee = key.employees.find(
    (each) => each.id === held.person.employee
  );
  if (employee === undefined) {
    return null;
  }
  const slice = sliceOf(key, employee);
  const { lines, facts, person } = held;
  const judged = await judge(asker, slice, lines, facts);
  const { played } = person;
  const card = scoreCardOf({
    slice,
    lines,
    facts,
    minutes: minutesOf(held),
    judged,
    ...(played === undefined ? {} : { selfSaid: played.said.flat() }),
  });
  // With someone who has a temper: how he dealt with what they did, and with what they said that was not so.
  const real: RealCard | null =
    played?.temper === undefined
      ? null
      : {
          temper: played.temper,
          hard: await hardTurns(
            asker,
            lines,
            facts.map((fact) => fact.text),
            played
          ),
          untrue: await judgeTruth(asker, played.untrue.flat(), facts),
          wasted: played.moves.filter(
            (move) => move !== null && nonsense.includes(move)
          ).length,
          left: played.left,
        };
  return { person, card, judged, real };
};

/** Who played the people of a set of interviews, for the result. */
const peopleOf = (scored: Scored[]): Result["people"] => {
  const played = scored.flatMap(({ person }) => person.played ?? []);
  if (played.length === 0) {
    return "person";
  }
  return played.some((each) => each.people === "real") ? "real" : "ideal";
};

/** Scores every interview of a practice company that counts, keeps the result, and prints the cards. */
export const score = async (
  core: Core,
  practice: Practice,
  key: AnswerKey,
  { label, log }: { label: string | undefined; log: (line: string) => void }
): Promise<void> => {
  const hidden = isHidden(key.id);
  const held = await heldOf(core, practice);
  if (held.length === 0) {
    log("Nobody has agreed to their interview yet.");
    return;
  }
  log(`Judging ${held.length} interviews`);
  const judged = await inTurns(
    held,
    judgedAtOnce,
    async (each) => await scoreOne(core, key, each)
  );
  const scored = judged
    .flatMap((each) => (each === null ? [] : [each]))
    .toSorted((a, b) => a.person.id.localeCompare(b.person.id));
  const total = totalOf(scored.map((each) => each.card));
  const reals = scored.flatMap((each) => each.real ?? []);
  const hard = reals.flatMap((each) => each.hard);
  const untrue = reals.flatMap((each) => each.untrue);
  const together = [
    `All together: heard ${total.heard.count} of ${total.heard.of}, written ${total.written.count} of ${total.written.of}, supported ${total.supported.count} of ${total.supported.of} (${total.supported.repeats} repeats, ${total.supported.notSaid.length} not said).`,
    ...(reals.length > 0
      ? [
          `With people as they are: the right line after ${hard.filter((each) => each.right).length} of ${hard.length} hard turns; ${untrue.filter((each) => each.verdict === "fact").length} of ${untrue.length} things that were not so are in his notes as facts; ${reals.filter((each) => each.left).length} of ${reals.length} went away before the read-back.`,
        ]
      : []),
  ].join("\n");
  const interviewer =
    scored.find((each) => each.person.played)?.person.played?.interviewer ??
    "stephen";
  const seed = scored.find((each) => each.person.played?.seed !== undefined)
    ?.person.played?.seed;
  const { result, file } = keepResult({
    at: new Date().toISOString(),
    label: label ?? practice.id,
    bench: "whole",
    set: setOf(key.id),
    key: key.id,
    practice: practice.id,
    stephen: await stephenVersion(interviewer, practice.locale),
    via: practice.via,
    people: peopleOf(scored),
    ...(seed === undefined ? {} : { seed }),
    cases: scored.map(({ person, card, real }) => ({
      id: `${key.id}-${person.employee.toLowerCase()}`,
      scores: {
        heard: share(card.heard.count, card.heard.of),
        written: share(card.written.count, card.written.of),
        supported: share(card.supported.count, card.supported.of),
        repeats: share(card.supported.repeats, card.supported.of),
        notSaid: share(card.supported.notSaid.length, card.supported.of),
        stephenShare: card.burden.stephenShare,
        answers: card.burden.answers,
        ...(real === null ? {} : realScores(real)),
      },
    })),
    spent: spentLine(),
  });
  keepJson(path.join(folderOf("out", key.id), practice.id, "scores.json"), {
    practice: practice.id,
    key: key.id,
    at: result.at,
    scored,
  });
  // Of a hidden key only the sums are shown.
  if (hidden) {
    log(`\n${together}\nKept as ${result.id}: ${file}`);
    return;
  }
  const rows = [
    cardColumns,
    ...scored.map(({ person, card }) =>
      cardRow(
        `${person.name} (${person.played === undefined ? "person" : "model"})`,
        card
      )
    ),
  ];
  log(`\n${key.company.name} (practice ${practice.id}): ${key.name}`);
  log(`${scored.length} of ${practice.people.length} interviews count.\n`);
  log(table(rows));
  log(`\n${together}`);
  for (const { person, card, real } of scored) {
    log(
      [
        ...detailOf(person.name, card, key),
        ...(real === null ? [] : realDetail(real)),
      ].join("\n")
    );
  }
  log(`\nKept as ${result.id}: ${file}`);
};

/** An interview kept as fixed input for the benches. */
export interface Transcript {
  id: string;
  key: string;
  employee: string;
  locale: Practice["locale"];
  by: "model" | "person";
  lines: Said[];
  /** How many lines there were when the read-back began; none when that is not known. */
  readbackFrom: number | null;
  /** The facts of their slice the person said, by id: judged once, when the transcript was kept. */
  said: string[];
  /** The notes Stephen had at the end, in the order he made them. */
  notes: Pick<InterviewFact, "id" | "tag" | "text">[];
  /** For each line of the person: how many notes he had before it, and the part he was in. None when a person played on the page. */
  notesAt: number[] | null;
  phaseAt: InterviewPhase[] | null;
  /** The mark of the text that held this interview. */
  stephen: string;
}

/**
 * Keeps the agreed interviews of a practice company as fixed input: those
 * a model played in git (`scripts/lab/fixtures/`), those a person played
 * out of it (`scripts/lab/out/fixtures/`), and those of a hidden key in
 * the hidden set's own folder. Says where each went.
 */
export const keepTranscripts = async (
  core: Core,
  practice: Practice,
  key: AnswerKey
): Promise<string[]> => {
  const asker = askerOf(core);
  const all = await heldOf(core, practice);
  const held = all.filter((each) => each.transcript.completedAt !== null);
  return await inTurns(held, judgedAtOnce, async ({ person, lines, facts }) => {
    const employee = key.employees.find((each) => each.id === person.employee);
    const judged =
      employee === undefined
        ? { known: [], written: [] }
        : await judge(asker, sliceOf(key, employee), lines, facts);
    const { played } = person;
    const by = played === undefined ? "person" : "model";
    const version = await stephenVersion(
      played?.interviewer ?? "stephen",
      practice.locale
    );
    const transcript: Transcript = {
      id: `${practice.key}-${person.employee.toLowerCase()}-${practice.id.slice(-4)}`,
      key: practice.key,
      employee: person.employee,
      locale: practice.locale,
      by,
      lines,
      readbackFrom: played?.readbackFrom ?? null,
      said: judged.known.filter((each) => each.said).map((each) => each.id),
      notes: facts.map(({ id, tag, text }) => ({ id, tag, text })),
      notesAt: played?.notesAt ?? null,
      phaseAt: played?.phaseAt ?? null,
      stephen: version.own,
    };
    const folder =
      by === "person" && !isHidden(key.id)
        ? path.join(folderOf("out", key.id), "fixtures")
        : folderOf("fixtures", key.id);
    return keepJson(
      path.join(folder, "transcripts", `${transcript.id}.json`),
      transcript
    );
  });
};

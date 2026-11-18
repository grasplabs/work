import { heardAnswers } from "@grasp-os/shared/admin/org-record";
import type {
  DrawnWork,
  Told,
  HeardAnswer,
} from "@grasp-os/shared/admin/org-record";

import type { TeamIntake } from "./brain-intake.ts";
import { plainPart } from "./plain-text.ts";
import { backingOf, checkedEnough, howItRunsOf } from "./team-claims.ts";
import type { CheckItem, CheckLine, Checks } from "./team-claims.ts";

// Who told each part of a drawing, as the brain may count them (GRA-1084,
// GRA-1987). The drawing's model says who told what (`told`, `heard`), and
// a fact someone approved may steer it into naming everyone. So the host
// never takes its word. One call for the whole piece of work
// (`backingOf`) shows the quick model each part, the numbers people are
// said to have given, and the lines the people named for each shared as
// how their team works, each line by a neutral label and never by whose
// it is, and asks which lines say each part. A part rests on the people
// whose lines the answer cites, among those named for it (at most
// `checkedEnough`); a label it wasn't shown counts for nothing. A part
// nobody is cited for, or that the answer leaves out, rests on nobody, and
// the brain doesn't show it (brain-intake.ts `versionOf`). A second call
// (`howItRunsOf`) holds only the backed parts' own words, never a line, and
// keeps each only when it says nothing but how the work runs: no line can
// steer that verdict. Two calls a piece of work, whatever the number of
// its people, split only where one passes the model's window.
//
// The check names the piece of work the part is of and what kind of part
// it is (a step, what starts one, what they decide by…): a line backs it
// only when it says it of this work and as that kind. A part is checked in
// its bare words: a step's action, a case's when, a term's word, the other
// way a step is told. What comes with it (who does a step and with what,
// what is done in a case, what a term means, why a step differs) isn't
// checked, and the brain leaves it out. A part with a digit in it is never
// checked, nor shown: numbers are the number fields', each a median over
// the people whose own lines are cited for it.

/** What kind of part each checked part is, as the checker is told. */
const kindOf = {
  starts:
    "What starts one: the event or request that begins a piece of this work.",
  step: "A step of the work: one action someone does in it.",
  wait: "A wait: where the work sits still, and for what.",
  case: "A case off the normal path: when it happens.",
  term: "A word of the team's own for something in this work.",
  decides: "What they look at to decide something in this work.",
  own: "A list, sheet or tool of their own they keep for this work.",
  ai: "An AI tool some of them use for this work.",
  right: "What this work done right looks like.",
  ask: "When they stop and ask someone during this work.",
  next: "Who gets the work after them.",
} as const satisfies Record<string, string>;

/** The kind of the other way a step is told, with the step it stands for. */
const otherWayOf = (step: string): string =>
  `Another way some do the step ${JSON.stringify(step)}: what they do instead.`;

/** Who a drawing's parts rest on, as checked: each part's people, one or more, or none. */
export interface Support {
  starts: string[];
  steps: string[][];
  waits: string[][];
  differently: string[][];
  term: string[];
  /** Who told the step `differs` names the other way. */
  other: string[];
  answers: Partial<Record<HeardAnswer, string[]>>;
  /**
   * Whose own numbers are checked to be theirs, by number and by each part
   * of one as they gave it: one or more, or none.
   */
  numbers: {
    /** How many the whole team does, quiet and busy apart. */
    volume: { quiet: string[]; busy: string[] };
    /** The quickest, the normal and the longest apart. */
    takes: { quickest: string[]; normal: string[]; longest: string[] };
    wrong: string[];
    /** By step of the drawing. */
    stepMinutes: string[][];
    /** By case off the normal path. */
    caseShares: string[][];
  };
}

/** A digit, in any script: a part holding one is the number fields' to say. */
const digit = /\p{N}/u;

/** The people `told` names for a part, by what `said` reads of each one's. */
const namedFor = (
  told: DrawnWork["told"],
  said: (each: Told) => boolean
): string[] =>
  Object.entries(told).flatMap(([person, each]) =>
    said(each) ? [person] : []
  );

/**
 * Each person's own numbers as the checker is asked about them: only the
 * parts they gave themselves (`Told.gave`), each part apart, never one
 * filled in from another; a count only in the drawing's own period (a
 * month's never stands for a week's).
 */
const numbersSaid = (drawn: DrawnWork) => {
  // Times as each gave them, in minutes, never rounded to the drawing's unit.
  const unit = "minutes";
  const entries = Object.entries(drawn.told);
  const given = (
    part: (gave: NonNullable<Told["gave"]>, each: Told) => string | null
  ) =>
    entries.flatMap(([person, each]) => {
      const said = each.gave === undefined ? null : part(each.gave, each);
      return said === null ? [] : [{ person, said }];
    });
  // Only a count given as the whole team's (`checkedSupport`).
  const count = (value: "quiet" | "busy") =>
    given((gave, each) =>
      gave[value] === null || gave.per !== drawn.per || each.volumeOf !== "team"
        ? null
        : `The whole team does about ${gave[value]} in a ${value === "quiet" ? "quiet or normal" : "busy"} ${drawn.per}.`
    );
  return {
    volume: { quiet: count("quiet"), busy: count("busy") },
    takes: {
      quickest: given(({ takes: [quickest] }) =>
        quickest === null
          ? null
          : `One whole one takes them ${quickest} ${unit} at the quickest.`
      ),
      normal: given(({ takes: [, normal] }) =>
        normal === null
          ? null
          : `One whole one takes them ${normal} ${unit} normally.`
      ),
      longest: given(({ takes }) =>
        takes[2] === null
          ? null
          : `One whole one takes them ${takes[2]} ${unit} at the longest.`
      ),
    },
    wrong: given((_gave, { wrong }) =>
      wrong === null ? null : `${wrong} out of ten come in wrong or incomplete.`
    ),
    stepMinutes: (index: number, step: string, among: readonly string[]) =>
      entries.flatMap(([person, { stepMinutes }]) => {
        const normal = (stepMinutes ?? []).find(
          (own) => own.step === index
        )?.normal;
        return normal === undefined ||
          normal === null ||
          !among.includes(person)
          ? []
          : [
              {
                person,
                said: `The step ${JSON.stringify(step)} takes them ${normal} minutes normally.`,
              },
            ];
      }),
    caseShares: (index: number, when: string, among: readonly string[]) =>
      entries.flatMap(([person, { caseShares }]) => {
        const share = (caseShares ?? []).find((own) => own.case === index);
        return share === undefined || !among.includes(person)
          ? []
          : [
              {
                person,
                said: `When ${JSON.stringify(when)}, it happens ${share.outOfTen} times out of ten.`,
              },
            ];
      }),
  };
};

/** A number a person is said to have given, as the checker is asked about it. */
interface Said {
  person: string;
  said: string;
}

/** One thing the backing check asks about, and who may back it. */
interface Question {
  item: CheckItem;
  /** Who may back it, in the order the drawing names them. */
  among: readonly string[];
}

/**
 * Who each part of `work`'s drawing rests on, and whose numbers are their
 * own, checked in two calls (`backingOf`, `howItRunsOf`), its words as
 * `clean` leaves them. `factsOf` is what each person who told their own
 * work shared as how their team works, as `clean` leaves it: the lead is
 * not among them, so never counted.
 */
export const checkedSupport = async (
  checks: Checks,
  work: TeamIntake["works"][number],
  factsOf: ReadonlyMap<string, readonly string[]>,
  clean: (text: string) => string
): Promise<Support> => {
  const { drawn } = work;
  const { told, differs } = drawn;
  const named = work.local === "" ? work.name : `${work.name} (${work.local})`;
  // Every line by a neutral label; whose it is stays here.
  const lines = [...factsOf.entries()]
    .flatMap(([person, facts]) => facts.map((text) => ({ person, text })))
    .map((line, index) => ({ ...line, label: `L${index + 1}` }));
  const linesOf = (people: readonly string[]): string[] =>
    lines.flatMap(({ person, label }) =>
      people.includes(person) ? [label] : []
    );
  const personOf = new Map(lines.map(({ label, person }) => [label, person]));
  const questions = new Map<string, Question>();
  /** Asks whether `text`, a part of `kind`, is said by the lines of `people`: its label, or null when it is never asked. */
  const part = (
    kind: string,
    text: string,
    people: readonly string[]
  ): string | null => {
    const plain = plainPart(clean(text));
    const among = [...new Set(people)].filter((person) => factsOf.has(person));
    if (plain === null || digit.test(plain) || among.length === 0) {
      return null;
    }
    const label = `P${questions.size + 1}`;
    questions.set(label, {
      item: { label, text: plain, kind, lines: linesOf(among) },
      among,
    });
    return label;
  };
  /** Asks whose own lines give each of `given`: their labels. */
  const numbers = (given: readonly Said[]): string[] =>
    given.flatMap(({ person, said }) => {
      if (!factsOf.has(person)) {
        return [];
      }
      const label = `N${questions.size + 1}`;
      questions.set(label, {
        item: { label, text: said, lines: linesOf([person]) },
        among: [person],
      });
      return [label];
    });
  const namedForPart = (index: number, of: "steps" | "differently") =>
    namedFor(told, (own) => own[of].includes(index));
  const answerParts = heardAnswers.map(
    (answer) =>
      [
        answer,
        part(kindOf[answer], drawn[answer], drawn.heard?.[answer] ?? []),
      ] as const
  );
  const starts = part(
    kindOf.starts,
    drawn.starts,
    namedFor(told, ({ start }) => start)
  );
  const steps = drawn.steps.map(({ text }, index) =>
    part(kindOf.step, text, namedForPart(index, "steps"))
  );
  const waits = drawn.waits.map((wait, index) =>
    part(
      kindOf.wait,
      wait,
      namedFor(told, (own) => own.waits.includes(index))
    )
  );
  const differently = drawn.differently.map(({ when }, index) =>
    part(kindOf.case, when, namedForPart(index, "differently"))
  );
  const term =
    drawn.term === null
      ? null
      : part(
          kindOf.term,
          drawn.term.word,
          namedFor(told, ({ term: own }) => own)
        );
  const other =
    differs === null
      ? null
      : part(
          otherWayOf(clean(drawn.steps[differs.step]?.text ?? "")),
          differs.other,
          namedFor(told, ({ way }) => way?.other === true)
        );
  // Each number only as its giver gave it, and only from their own lines;
  // a step's minutes and a case's share are asked of everyone named for
  // that part, and count only for whom the part rests on.
  const said = numbersSaid(drawn);
  const asked = {
    volume: {
      quiet: numbers(said.volume.quiet),
      busy: numbers(said.volume.busy),
    },
    takes: {
      quickest: numbers(said.takes.quickest),
      normal: numbers(said.takes.normal),
      longest: numbers(said.takes.longest),
    },
    wrong: numbers(said.wrong),
    stepMinutes: drawn.steps.map(({ text }, index) =>
      numbers(said.stepMinutes(index, text, namedForPart(index, "steps")))
    ),
    caseShares: drawn.differently.map(({ when }, index) =>
      numbers(said.caseShares(index, when, namedForPart(index, "differently")))
    ),
  };
  const lineList: CheckLine[] = lines.map(({ label, text }) => ({
    label,
    text,
  }));
  const backing = await backingOf(
    checks,
    named,
    [...questions.values()].map(({ item }) => item),
    lineList
  );
  /** Who `label` rests on, as the answer cites them: in the drawing's order, at most `checkedEnough`. */
  const backersOf = (label: string | null): string[] => {
    const question = label === null ? undefined : questions.get(label);
    if (label === null || question === undefined) {
      return [];
    }
    const cited = new Set(
      (backing.get(label) ?? []).flatMap((each) => {
        const person = personOf.get(each);
        return person === undefined ? [] : [person];
      })
    );
    return question.among
      .filter((person) => cited.has(person))
      .slice(0, checkedEnough);
  };
  // Only the parts someone is cited for are judged, and only their words.
  const judged = [
    ...answerParts.map(([, label]) => label),
    starts,
    ...steps,
    ...waits,
    ...differently,
    term,
    other,
  ].flatMap((label) =>
    label === null || backersOf(label).length === 0 ? [] : [label]
  );
  const verdicts = await howItRunsOf(
    checks,
    judged.map((label) => ({
      label,
      text: questions.get(label)?.item.text ?? "",
    }))
  );
  const shown = (label: string | null): string[] =>
    label !== null && verdicts.get(label) === true ? backersOf(label) : [];
  /** Whose own number each of `labels` is, in the order given, at most `checkedEnough`. */
  const givers = (labels: readonly string[], among?: readonly string[]) =>
    labels
      .flatMap((label) => backersOf(label))
      .filter((person) => among === undefined || among.includes(person))
      .slice(0, checkedEnough);
  const stepsShown = steps.map(shown);
  const differentlyShown = differently.map(shown);
  const answers: Partial<Record<HeardAnswer, string[]>> = Object.fromEntries(
    answerParts.map(([answer, label]) => [answer, shown(label)])
  );
  return {
    starts: shown(starts),
    steps: stepsShown,
    waits: waits.map(shown),
    differently: differentlyShown,
    term: shown(term),
    other: shown(other),
    answers,
    numbers: {
      // Only a count given as the whole team's: one someone gave as their
      // own ("I do 30 a week"), or without saying whose, is what one person
      // does, never how the team works, and is never asked (GRA-1987).
      volume: {
        quiet: givers(asked.volume.quiet),
        busy: givers(asked.volume.busy),
      },
      takes: {
        quickest: givers(asked.takes.quickest),
        normal: givers(asked.takes.normal),
        longest: givers(asked.takes.longest),
      },
      wrong: givers(asked.wrong),
      stepMinutes: asked.stepMinutes.map((labels, index) =>
        givers(labels, stepsShown[index] ?? [])
      ),
      caseShares: asked.caseShares.map((labels, index) =>
        givers(labels, differentlyShown[index] ?? [])
      ),
    },
  };
};

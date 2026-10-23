/**
 * One interview on someone's own link, start to end, as the interview
 * page would hold it: every turn is a real turn of Stephen's, every change
 * is kept on the local core, and the read-back is agreed to a part at a
 * time. Whoever answers is a `Player`. What they said that was a fact of
 * theirs is kept beside each answer, for the score card. Ported from the
 * prototype (grasplabs/prototype, packages/grasp: lab/play.ts).
 */
import type {
  InterviewFact,
  InterviewProgress,
} from "@grasp-os/shared/interview-links";
import { readBackParts } from "@grasp-os/shared/interview-story";
import type {
  InterviewEvent,
  InterviewPhase,
  InterviewTurnRequest,
  InterviewWants,
  StephenTurn,
} from "@grasp-os/shared/interview-turn";
import type { Interviewer } from "@grasp-os/shared/onboarding";

import type { Link } from "./core.ts";
import type { Move } from "./moves.ts";
import type { Player } from "./person.ts";

/** An interview that was played: how it went, and which facts each answer held, in the order of the person's lines. */
export interface Played {
  /** The key of the device it was played on: the link opens only there. */
  key: string;
  answers: number;
  minutes: number;
  /** For each line of the person, the ids of their facts that were in it. */
  said: string[][];
  /** For each line of the person: how many notes Stephen had before it, and the part he was in. */
  notesAt: number[];
  phaseAt: InterviewPhase[];
  /** How many lines the conversation had when the read-back began. */
  readbackFrom: number;
  /** For each line of the person: what they did beside answering, and what in it was not true. */
  moves: (Move | null)[];
  untrue: string[][];
  /** For each line of the person: what Stephen waited for after it. */
  wantsAt: InterviewWants[];
  /** They went away before the read-back: nothing was agreed to. */
  left: boolean;
}

/** The most answers before the lab stops asking: an interview that long has lost its way. */
const answersMost = 45;
/** The most rounds of the read-back, and the most times one part is put right before it counts as agreed. */
const readBackRounds = 14;
const triesPerPart = 2;
/** The longest a turn may say the interview took. */
const minutesMost = 240;

const words = (text: string): number =>
  text.trim().split(/\s+/u).filter(Boolean).length;

/**
 * How many seconds one exchange takes two people: he says his line, they
 * think, they type theirs. A model answers in two seconds, so without this
 * an interview played by one never runs out of time, and what he does
 * when time is short is never seen.
 */
export const secondsOf = (his: string, theirs: string): number =>
  words(his) * 0.4 + 2.3 + 6 + words(theirs) * 1.2;

/** A fact as a turn changed it: taken out, or in new words, and to be agreed to again. */
const changed = (
  fact: InterviewFact,
  change: StephenTurn["changes"][number]
): InterviewFact => {
  const { agreed: _agreed, out: _out, ...open } = fact;
  return change.text === null
    ? { ...open, out: true }
    : { ...open, text: change.text, record: change.record ?? change.text };
};

/** What a turn brought, as the page keeps it; `pin` for what was said in a part of the read-back. */
export const taken = (
  progress: InterviewProgress,
  turn: StephenTurn,
  pin?: number
): InterviewProgress => {
  const facts = progress.facts.map((fact) => {
    const change = turn.changes.find((each) => each.id === fact.id);
    return change === undefined ? fact : changed(fact, change);
  });
  const added = turn.facts.map((fact, at): InterviewFact => ({
    id: `f${facts.length + at + 1}`,
    tag: fact.tag,
    text: fact.text,
    record: fact.record,
    ...(pin === undefined ? {} : { pin }),
  }));
  const readBackWants = turn.wants === "file" ? "file" : "readback";
  return {
    ...progress,
    lines:
      turn.say === ""
        ? progress.lines
        : [...progress.lines, { from: "stephen", text: turn.say }],
    facts: [...facts, ...added],
    phase: pin === undefined ? turn.phase : "readback",
    wants: pin === undefined ? turn.wants : readBackWants,
  };
};

/** What the person says when Stephen asks for a file: the lab shares none. */
const noExample = (locale: string): string =>
  locale === "nl"
    ? "Ik heb nu geen voorbeeld bij de hand."
    : "I don't have an example at hand right now.";

const agreesPattern = /^(?:ja|yes)\b/iu;
/** A reply longer than this says more than that they agree. */
const agreesMost = 30;

/** Whether a reply to a part of the read-back agrees to it. */
export const agrees = (reply: string): boolean =>
  agreesPattern.test(reply) && reply.length < agreesMost;

/** How the interview is held: by whom, and on which clock. */
export interface PlayOptions {
  locale: InterviewTurnRequest["locale"];
  /** Who holds the interview, when not Stephen. */
  interviewer?: Interviewer;
  /**
   * With "talk", the minutes Stephen is told are the time the words would
   * have taken two people, not the time a model took.
   */
  clock?: "talk";
  /** The device's key, when the link was opened on this device before. */
  key?: string;
}

/** Opens the link on this device: its key, and the version what was said is kept as. */
const opened = async (
  link: Link,
  key: string | undefined
): Promise<{ key: string; version: number }> => {
  const session = await link.open(key);
  if (session.state === "elsewhere") {
    throw new Error(
      "This interview is open on another device: give it a new start first."
    );
  }
  const issued = session.key ?? key;
  if (issued === undefined) {
    throw new Error("The link gave this device no key.");
  }
  return { key: issued, version: session.version };
};

/** Plays one interview on `link`, start to end. */
export const playInterview = async (
  link: Link,
  player: Player,
  { locale, interviewer, clock, key: knownKey }: PlayOptions
): Promise<Played> => {
  const { key, version: first } = await opened(link, knownKey);
  let version = first;
  const startedAt = Date.now();
  let progress: InterviewProgress = {
    person: "progress",
    told: true,
    mode: "type",
    lines: [],
    facts: [],
    phase: "open",
    wants: "answer",
    startedAt,
    confirmed: 0,
    adding: false,
    addedAt: 0,
    ...(interviewer === "claire" ? { interviewer } : {}),
  };
  const played: Played = {
    key,
    answers: 0,
    minutes: 0,
    said: [],
    notesAt: [],
    phaseAt: [],
    readbackFrom: 0,
    moves: [],
    untrue: [],
    wantsAt: [],
    left: false,
  };
  let talked = 0;
  const minutes = () =>
    Math.min(
      clock === "talk" ? talked / 60 : (Date.now() - startedAt) / 60_000,
      minutesMost
    );
  const save = async () => {
    version = await link.save(key, version, progress);
  };
  const turn = async (
    event: InterviewEvent,
    reading?: string[]
  ): Promise<StephenTurn> =>
    await link.turn(
      {
        event,
        locale,
        interviewer: interviewer ?? "stephen",
        lines: progress.lines.map(({ from, text, typed, file }) => ({
          from,
          text,
          ...(typed === undefined ? {} : { typed }),
          ...(file === undefined ? {} : { file }),
        })),
        facts: progress.facts
          .filter(({ out }) => out !== true)
          .map(({ id, tag, text }) => ({ id, tag, text })),
        phase: progress.phase,
        minutes: minutes(),
        ...(reading === undefined ? {} : { reading }),
        adding: false,
      },
      key
    );
  const says = (
    text: string,
    facts: string[],
    move: Move | null = null,
    wrong: string[] = []
  ) => {
    played.notesAt.push(progress.facts.length);
    played.phaseAt.push(progress.phase);
    talked += secondsOf(
      progress.lines.findLast(({ from }) => from === "stephen")?.text ?? "",
      text
    );
    progress = {
      ...progress,
      lines: [...progress.lines, { from: "person", text, typed: true }],
    };
    played.said.push(facts);
    played.moves.push(move);
    played.untrue.push(wrong);
  };

  progress = taken(progress, await turn("start"));
  await save();
  while (
    played.answers < answersMost &&
    progress.wants !== "readback" &&
    progress.wants !== "end"
  ) {
    played.answers += 1;
    if (progress.wants === "file") {
      says(noExample(locale), []);
    } else {
      // oxlint-disable-next-line no-await-in-loop -- one answer at a time
      const answer = await player.answer(
        progress.lines,
        "Your answer to Stephen’s last line, and nothing else:",
        { phase: progress.phase, readback: false }
      );
      says(answer.say, answer.said, answer.move ?? null, answer.untrue ?? []);
      // They went away: what they said is kept as it stands, and nothing of it is agreed to.
      if (answer.left === true) {
        played.wantsAt.push("answer");
        // oxlint-disable-next-line no-await-in-loop -- kept before they go
        await save();
        return {
          ...played,
          readbackFrom: progress.lines.length,
          minutes: minutes(),
          left: true,
        };
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- one turn at a time
    progress = taken(progress, await turn("answer"));
    played.wantsAt.push(progress.wants);
    // oxlint-disable-next-line no-await-in-loop -- kept after every turn
    await save();
  }
  // The read-back, a part at a time: they agree, or put a line right first.
  played.readbackFrom = progress.lines.length;
  let tries = 0;
  for (let round = 0; round < readBackRounds; round += 1) {
    const current = readBackParts(progress.facts)[progress.confirmed];
    if (current === undefined) {
      break;
    }
    const shown = current.facts.filter(({ out }) => out !== true);
    // oxlint-disable-next-line no-await-in-loop -- one part at a time
    const reply = await player.answer(
      [
        ...progress.lines,
        {
          from: "stephen",
          text: `${locale === "nl" ? "Klopt dit?" : "Is this right?"}\n${shown.map(({ text }) => `- ${text}`).join("\n")}`,
        },
      ],
      'Stephen read these lines back. If every line is true for you, answer only "Ja, klopt." (or "Yes, that’s right." in English). If one is wrong, say in one short sentence what is wrong. Nothing else:',
      { phase: "readback", readback: true }
    );
    if (agrees(reply.say) || tries >= triesPerPart) {
      progress = { ...progress, confirmed: progress.confirmed + 1 };
      tries = 0;
    } else {
      tries += 1;
      says(reply.say, reply.said);
      // oxlint-disable-next-line no-await-in-loop -- one part at a time
      const put = await turn(
        "readback",
        shown.map(({ id }) => id)
      );
      progress = taken(progress, put, progress.confirmed);
      if (put.approved) {
        progress = { ...progress, confirmed: progress.confirmed + 1 };
        tries = 0;
      }
      // oxlint-disable-next-line no-await-in-loop -- kept after every turn
      await save();
    }
  }
  progress = {
    ...progress,
    person: "completed",
    wants: "end",
    facts: progress.facts.map((fact) => ({ ...fact, agreed: true })),
  };
  await save();
  return { ...played, minutes: minutes() };
};

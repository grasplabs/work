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
import { askedFor, awayLine, misreadable, pasteOf, splitOf } from "./events.ts";
import type { Happened, Planned } from "./events.ts";
import type { Move } from "./moves.ts";
import type { Answer, Player } from "./person.ts";

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
  /** What happened to them on the way (events.ts), when anything was planned. */
  events?: Happened[];
}

/** The most answers before the lab stops asking: an interview that long has lost its way. */
const answersMost = 45;
/** The most rounds of the read-back, and the most times one part is put right before it counts as agreed. */
const readBackRounds = 14;
const triesPerPart = 2;
/** The longest a turn may say the interview took. */
const minutesMost = 240;
/** Time away counts as this many minutes at most, as the page counts it (GRA-1468). */
const awayCountsMost = 5;

/** How long a word of theirs takes to type, in seconds. */
const typedSecondsPerWord = 1.2;

const words = (text: string): number =>
  text.trim().split(/\s+/u).filter(Boolean).length;

/**
 * How many seconds one exchange takes two people: he says his line, they
 * think, they type theirs. A model answers in two seconds, so without this
 * an interview played by one never runs out of time, and what he does
 * when time is short is never seen.
 */
export const secondsOf = (his: string, theirs: string): number =>
  words(his) * 0.4 + 2.3 + 6 + words(theirs) * typedSecondsPerWord;

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

/** His notes after a turn, as the page keeps them: what it put right, and what it added; `pin` for what was said in a part of the read-back. */
export const notesAfter = (
  notes: readonly InterviewFact[],
  turn: StephenTurn,
  pin?: number
): InterviewFact[] => {
  const facts = notes.map((fact) => {
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
  return [...facts, ...added];
};

/** What a turn brought, as the page keeps it; `pin` for what was said in a part of the read-back. */
export const taken = (
  progress: InterviewProgress,
  turn: StephenTurn,
  pin?: number
): InterviewProgress => {
  const readBackWants = turn.wants === "file" ? "file" : "readback";
  return {
    ...progress,
    lines:
      turn.say === ""
        ? progress.lines
        : [...progress.lines, { from: "stephen", text: turn.say }],
    facts: notesAfter(progress.facts, turn, pin),
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
  /** What happens to them on the way, by minute (events.ts). */
  events?: readonly Planned[];
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
  { locale, interviewer, clock, key: knownKey, events = [] }: PlayOptions
): Promise<Played> => {
  const { key, version: opening } = await opened(link, knownKey);
  let version = opening;
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
  /** Minutes they were away that count, as the page counts them. */
  let away = 0;
  const minutes = () =>
    Math.min(
      (clock === "talk" ? talked / 60 : (Date.now() - startedAt) / 60_000) +
        away,
      minutesMost
    );
  const pending = [...events];
  const happened: Happened[] = [];
  /** The first event due now that `fits`; it stays planned until it is played. */
  const dueNow = (fits: (event: Planned) => boolean): Planned | undefined =>
    pending.find((event) => minutes() >= event.at && fits(event));
  const playedOut = (event: Planned, more: Partial<Happened> = {}) => {
    pending.splice(pending.indexOf(event), 1);
    happened.push({ kind: event.kind, answer: played.answers, ...more });
  };
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
  /** Their last line, sent on: the page joins what they sent since his last line into one. */
  const sentOn = (
    rest: string,
    facts: string[],
    move: Move | null,
    wrong: string[]
  ) => {
    const last = progress.lines.at(-1);
    if (last === undefined) {
      return;
    }
    // Only the time to type the rest: the rest of the exchange was counted with the first part.
    talked += words(rest) * typedSecondsPerWord;
    progress = {
      ...progress,
      lines: [
        ...progress.lines.slice(0, -1),
        { ...last, text: `${last.text} ${rest}` },
      ],
    };
    played.said[played.said.length - 1] = facts;
    played.moves[played.moves.length - 1] = move;
    played.untrue[played.untrue.length - 1] = wrong;
  };
  /** His turn after their line, kept. */
  const answered = async () => {
    progress = taken(progress, await turn("answer"));
    played.wantsAt.push(progress.wants);
    await save();
  };
  const plainly = "Your answer to Stephen’s last line, and nothing else:";
  let asked: string = plainly;
  const lastOfHis = () =>
    progress.lines.findLast(({ from }) => from === "stephen")?.text ?? "";

  /** They stop after his line, and come back through the same link much later: whether they did now. */
  const cameBack = async (): Promise<boolean> => {
    const later = dueNow(({ kind }) => kind === "resumes later");
    if (later === undefined || progress.wants !== "answer") {
      return false;
    }
    await save();
    ({ version } = await opened(link, key));
    away += awayCountsMost;
    progress = taken(progress, await turn("resume"));
    await save();
    playedOut(later);
    return true;
  };
  /** The event that happens at this answer, if any: a misreading only where his question can be misread. */
  const eventNow = (): Planned | undefined =>
    progress.wants === "answer"
      ? dueNow(
          ({ kind }) =>
            kind !== "resumes later" &&
            (kind !== "misread" || misreadable(lastOfHis()))
        )
      : undefined;
  /** They are called away, or paste the wrong thing: code says what, and the next answer is asked for as it follows. */
  const instead = async (event: Planned) => {
    const interrupted = event.kind === "interrupted";
    const line = interrupted
      ? awayLine(locale, event.pick)
      : pasteOf(locale, event.pick);
    says(line, [], null, interrupted ? [] : [`(pasted by mistake) ${line}`]);
    playedOut(event);
    await answered();
    if (interrupted) {
      away += Math.min(event.away ?? 1, awayCountsMost);
    }
    asked = interrupted ? askedFor.back : askedFor.afterPaste;
  };
  /** One answer in two messages: the first stops mid-sentence and gets his turn; the rest follows it. */
  const inTwo = async (
    event: Planned,
    answer: Answer,
    [start, rest]: [string, string]
  ) => {
    says(start, [], answer.move ?? null, []);
    const first = await turn("answer");
    const waited = first.more || first.say === "";
    playedOut(event, { waited });
    progress = taken(progress, first);
    if (waited) {
      sentOn(rest, answer.said, answer.move ?? null, answer.untrue ?? []);
    } else {
      played.wantsAt.push(progress.wants);
      await save();
      says(rest, answer.said, null, answer.untrue ?? []);
    }
    await answered();
  };
  /** Their next answer and his turn to it: whether they went away with it. */
  const nextAnswer = async (): Promise<boolean> => {
    const event = eventNow();
    if (event?.kind === "interrupted" || event?.kind === "wrong paste") {
      await instead(event);
      return false;
    }
    if (progress.wants === "file") {
      says(noExample(locale), []);
      await answered();
      return false;
    }
    const answer = await player.answer(
      progress.lines,
      event?.kind === "misread" ? askedFor.misread : asked,
      { phase: progress.phase, readback: false }
    );
    asked = plainly;
    if (event?.kind === "misread") {
      playedOut(event);
    }
    const split =
      event?.kind === "split message" && answer.left !== true
        ? splitOf(answer.say)
        : null;
    if (event !== undefined && split !== null) {
      await inTwo(event, answer, split);
      return false;
    }
    says(answer.say, answer.said, answer.move ?? null, answer.untrue ?? []);
    // They went away: what they said is kept as it stands, and nothing of it is agreed to.
    if (answer.left === true) {
      played.wantsAt.push("answer");
      await save();
      return true;
    }
    await answered();
    return false;
  };
  const withEvents = events.length === 0 ? {} : { events: happened };

  progress = taken(progress, await turn("start"));
  await save();
  while (
    played.answers < answersMost &&
    progress.wants !== "readback" &&
    progress.wants !== "end"
  ) {
    // oxlint-disable-next-line no-await-in-loop -- they come back before they answer
    if (await cameBack()) {
      continue;
    }
    played.answers += 1;
    // oxlint-disable-next-line no-await-in-loop -- one answer at a time
    if (await nextAnswer()) {
      return {
        ...played,
        readbackFrom: progress.lines.length,
        minutes: minutes(),
        left: true,
        ...withEvents,
      };
    }
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
  return { ...played, minutes: minutes(), ...withEvents };
};

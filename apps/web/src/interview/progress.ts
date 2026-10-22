import { interviewLimits } from "@grasp-os/shared/interview-links";
import type {
  InterviewFact,
  InterviewLine,
  InterviewProgress,
} from "@grasp-os/shared/interview-links";
import { readBackParts } from "@grasp-os/shared/interview-story";
import { spanOf } from "@grasp-os/shared/interview-turn";
import type {
  FactTag,
  InterviewEvent,
  InterviewPhase,
  InterviewWants,
  StephenTurn,
} from "@grasp-os/shared/interview-turn";

// Where someone's interview stands, as their page keeps it and sends it to
// core to be kept (`InterviewProgress`), and how each thing that happens
// moves it on. Pure, so the page and its tests go through the same steps.
// Ported from the prototype (grasplabs/prototype, packages/grasp:
// src/data/interviews.ts).

/** The link as it was sent: nothing said, nothing written down. */
export const freshProgress: InterviewProgress = {
  person: "opened",
  told: false,
  mode: null,
  lines: [],
  facts: [],
  phase: "open",
  wants: "answer",
  startedAt: null,
  confirmed: 0,
  adding: false,
  addedAt: 0,
};

/** Whether they are in the conversation: started, and not agreed to it all. */
export const isTalking = ({ person }: InterviewProgress): boolean =>
  person === "progress" || person === "incomplete";

/** Whether what is on screen is the read-back. */
export const isReading = ({ wants }: InterviewProgress): boolean =>
  wants === "readback" || wants === "end";

/** They pressed start, by typing: Stephen has told them who he is. */
export const begun = (
  progress: InterviewProgress,
  now: number
): InterviewProgress => ({
  ...progress,
  person: "progress",
  told: true,
  mode: "type",
  startedAt: progress.startedAt ?? now,
});

/** They stopped for now: their place is kept, and the link carries on later. */
export const leftFor = (progress: InterviewProgress): InterviewProgress =>
  progress.person === "progress"
    ? { ...progress, person: "incomplete" }
    : progress;

/** Back on the link after stopping. */
export const resumed = (progress: InterviewProgress): InterviewProgress =>
  progress.person === "incomplete"
    ? { ...progress, person: "progress" }
    : progress;

/** One more line in the conversation, as long as the interview holds more. */
export const withLine = (
  progress: InterviewProgress,
  line: InterviewLine
): InterviewProgress =>
  progress.lines.length >= interviewLimits.lines
    ? progress
    : { ...progress, lines: [...progress.lines, line] };

/** Where the interview goes, known with his line, before what he wrote down. */
export const steered = (
  progress: InterviewProgress,
  { phase, wants }: { phase: InterviewPhase | null; wants: InterviewWants }
): InterviewProgress => ({
  ...progress,
  wants,
  phase: phase ?? progress.phase,
});

/** Words as they are compared: small letters, one space, no full stop. */
const sameWords = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/\s+/gu, " ")
    .replace(/[.!\s]+$/u, "")
    .trim();

/** A fact without the fields it doesn't have, as the store keeps it. */
const withoutEmpty = (fact: InterviewFact): InterviewFact => {
  const { out, pin, agreed, ...rest } = fact;
  return {
    ...rest,
    ...(out === true ? { out } : {}),
    ...(pin === undefined ? {} : { pin }),
    ...(agreed === true ? { agreed } : {}),
  };
};

/**
 * What a turn of Stephen's brought: what he marked in what was just said,
 * what he wrote down, what he put right, and where the interview is now.
 * `answered` is the line his marks go on: the last thing the person said,
 * as it stands in the conversation. In the read-back, what is new is
 * pinned to the part on screen (`pin`).
 */
export const afterTurn = (
  progress: InterviewProgress,
  turn: StephenTurn,
  { answered, pin }: { answered: number; pin?: number }
): InterviewProgress => {
  const marks = turn.facts
    .filter(({ quote }) => quote !== "")
    .map(({ quote, tag }) => ({ quote, tag }));
  const lines = progress.lines.map((line, at) =>
    at === answered && marks.length > 0
      ? {
          ...line,
          marks: [...(line.marks ?? []), ...marks].slice(
            0,
            interviewLimits.marks
          ),
        }
      : line
  );
  const changed = progress.facts.map((fact): InterviewFact => {
    const change = turn.changes.find(({ id }) => id === fact.id);
    if (change === undefined) {
      return fact;
    }
    // What is put right is read back again, also when it was agreed to before.
    const { agreed: _agreed, ...rest } = fact;
    return change.text === null
      ? { ...rest, out: true }
      : {
          ...rest,
          text: change.text,
          record: change.record ?? change.text,
          out: undefined,
        };
  });
  // The same thing is written down once.
  const have = new Set(
    changed.filter(({ out }) => out !== true).map(({ text }) => sameWords(text))
  );
  let next = changed.length;
  const added: InterviewFact[] = [];
  for (const fact of turn.facts) {
    const words = sameWords(fact.text);
    if (
      words !== "" &&
      !have.has(words) &&
      changed.length + added.length < interviewLimits.facts
    ) {
      have.add(words);
      next += 1;
      added.push({
        id: `f${next}`,
        tag: fact.tag,
        text: fact.text,
        record: fact.record,
        ...(pin === undefined ? {} : { pin }),
      });
    }
  }
  return {
    ...progress,
    lines,
    facts: [...changed, ...added].map(withoutEmpty),
    phase: turn.phase,
    wants: turn.wants,
  };
};

/** A line of the read-back, put right by them: their words, at once, also for the record until Stephen has heard of it. */
export const withFactText = (
  progress: InterviewProgress,
  id: string,
  text: string
): InterviewProgress => ({
  ...progress,
  facts: progress.facts.map((fact) => {
    if (fact.id !== id) {
      return fact;
    }
    const { agreed: _agreed, ...rest } = fact;
    return { ...rest, text, record: text };
  }),
});

/** A line of the read-back taken out, or put back. */
export const withFactToggled = (
  progress: InterviewProgress,
  id: string
): InterviewProgress => ({
  ...progress,
  facts: progress.facts.map((fact) => {
    if (fact.id !== id) {
      return fact;
    }
    const { out, ...rest } = fact;
    return out === true ? rest : { ...rest, out: true };
  }),
});

/** Lines of the read-back that were taken out, put back. */
export const withFactsBack = (
  progress: InterviewProgress,
  ids: string[]
): InterviewProgress => ({
  ...progress,
  facts: progress.facts.map((fact) => {
    if (!ids.includes(fact.id)) {
      return fact;
    }
    const { out: _out, ...rest } = fact;
    return rest;
  }),
});

/** They said yes to a part of the read-back. */
export const partConfirmed = (
  progress: InterviewProgress
): InterviewProgress => ({ ...progress, confirmed: progress.confirmed + 1 });

/** They said yes to the last part: what is left in counts from now, and is not read back again. */
export const approved = (progress: InterviewProgress): InterviewProgress => ({
  ...progress,
  confirmed: progress.confirmed + 1,
  person: "completed",
  wants: "end",
  adding: false,
  facts: progress.facts.map((fact) => ({ ...fact, agreed: true })),
});

/** Back after agreeing, to add something: only what is new will be read back. */
export const reopened = (progress: InterviewProgress): InterviewProgress =>
  progress.person === "completed"
    ? {
        ...progress,
        person: "progress",
        wants: "answer",
        confirmed: 0,
        adding: true,
        addedAt: progress.lines.length,
      }
    : progress;

/** How they found it, from 1 to 5. */
export const rated = (
  progress: InterviewProgress,
  rating: number
): InterviewProgress =>
  progress.person === "completed"
    ? { ...progress, rating: Math.min(Math.max(Math.round(rating), 1), 5) }
    : progress;

/** The event a conversation starts with, by where it stands: the first line, back to add something, an answer never answered, or coming back. */
export const openingEvent = (progress: InterviewProgress): InterviewEvent => {
  if (progress.lines.length === 0) {
    return "start";
  }
  if (progress.adding && progress.lines.length === progress.addedAt) {
    return "add";
  }
  return progress.lines.at(-1)?.from === "person" ? "answer" : "resume";
};

/** The part of the read-back they are at, and how many there are. */
export const partAt = (progress: InterviewProgress) => {
  const parts = readBackParts(progress.facts);
  const at = Math.min(progress.confirmed, Math.max(parts.length - 1, 0));
  return { parts, at, part: parts[at] };
};

/** A piece of what someone said: plain words, or words Stephen marked, with what they are. */
export interface Piece {
  /** Where it starts in the line. */
  at: number;
  text: string;
  tag: FactTag | null;
}

/** A line with what is marked in it, in pieces; a mark inside or across another is left out. */
export const markedPieces = (
  said: string,
  marks: { quote: string; tag: FactTag }[] = []
): Piece[] => {
  const spans = marks
    .flatMap(({ quote, tag }) => {
      const span = spanOf(said, quote);
      return span === null ? [] : [{ from: span[0], to: span[1], tag }];
    })
    .toSorted((a, b) => a.from - b.from || b.to - a.to);
  const pieces: Piece[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.from >= at) {
      if (span.from > at) {
        pieces.push({ at, text: said.slice(at, span.from), tag: null });
      }
      pieces.push({
        at: span.from,
        text: said.slice(span.from, span.to),
        tag: span.tag,
      });
      at = span.to;
    }
  }
  if (at < said.length) {
    pieces.push({ at, text: said.slice(at), tag: null });
  }
  return pieces;
};

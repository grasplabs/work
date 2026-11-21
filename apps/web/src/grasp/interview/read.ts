// Small readings of an interview, shared by its parts: who a speaker is, whether the turns have
// times, which turn is playing at a moment, where each highlight lies, and a turn's text cut into
// plain and marked pieces. Pure functions: nothing here draws or holds state.
import { toneOf as defaultToneOf } from "./tone";
import type {
  InterviewChapter,
  InterviewDataProps,
  InterviewHighlight,
  InterviewMatch,
  InterviewPerson,
  InterviewSpeaker,
  InterviewTone,
  InterviewTurn,
  PlacedHighlight,
} from "./types";

/** Words that are there: not left out and not empty. */
export const hasWords = (words: string | undefined): words is string =>
  words !== undefined && words !== "";

/** Whether the speakers are given as a list, not a record. */
const isList = (
  speakers: InterviewDataProps["speakers"]
): speakers is readonly InterviewSpeaker[] => Array.isArray(speakers);

/** Every speaker by the key the turns use, each with a tint: their own, or one for their place. */
export const peopleOf = (
  speakers: InterviewDataProps["speakers"],
  turns: readonly InterviewTurn[],
  toneOf: (index: number) => InterviewTone = defaultToneOf
): ReadonlyMap<string, InterviewPerson> => {
  const listed: (readonly [string, InterviewSpeaker])[] = isList(speakers)
    ? speakers.map((speaker) => [speaker.id ?? speaker.name, speaker] as const)
    : Object.entries(speakers ?? {});
  const people = new Map<string, InterviewPerson>();
  for (const [key, speaker] of listed) {
    people.set(key, {
      key,
      name: speaker.name,
      role: speaker.role,
      src: speaker.src,
      tone: speaker.tone ?? toneOf(people.size),
    });
  }
  // A speaker the list leaves out is shown by their key, with the next tint.
  for (const turn of turns) {
    if (!people.has(turn.speaker)) {
      people.set(turn.speaker, {
        key: turn.speaker,
        name: turn.speaker,
        tone: toneOf(people.size),
      });
    }
  }
  return people;
};

/** Whether every turn has a start: only then are times shown, or else every turn is numbered. */
export const timed = (turns: readonly InterviewTurn[]) =>
  turns.length > 0 && turns.every((turn) => turn.startMs !== undefined);

/** Where a turn ends: its own end, else the next turn's start, else its own start. */
export const endOf = (turns: readonly InterviewTurn[], index: number) => {
  const turn = turns[index];
  return turn?.endMs ?? turns[index + 1]?.startMs ?? turn?.startMs ?? 0;
};

/** How long the whole interview runs, in milliseconds: the last turn's end, or the sound's length. */
export const lengthOf = (turns: readonly InterviewTurn[], seconds?: number) => {
  const last = turns.length > 0 ? endOf(turns, turns.length - 1) : 0;
  return Math.max(last, (seconds ?? 0) * 1000);
};

/** The turn being said at a moment: the last whose start is at or before it, or null before the first. */
export const turnAt = (
  turns: readonly InterviewTurn[],
  ms: number
): number | null => {
  let found: number | null = null;
  for (const [index, turn] of turns.entries()) {
    if (turn.startMs !== undefined && turn.startMs <= ms + 1) {
      found = index;
    }
  }
  return found;
};

/** Where `words` stand in `text`, without regard to case, or -1. */
const findIn = (text: string, words: string) =>
  text.toLowerCase().indexOf(words.toLowerCase());

/** A highlight's turn: its own, or the first turn that holds its words. */
const turnOf = (
  turns: readonly InterviewTurn[],
  highlight: InterviewHighlight
) =>
  highlight.turn ??
  turns.findIndex((turn) => findIn(turn.text, highlight.text) >= 0);

/** One highlight's place, or null when it cannot be placed. */
const place = (
  turns: readonly InterviewTurn[],
  highlight: InterviewHighlight
): PlacedHighlight | null => {
  const turn = turnOf(turns, highlight);
  const text = turns[turn]?.text;
  if (text === undefined) {
    return null;
  }
  if (
    highlight.start !== undefined &&
    highlight.end !== undefined &&
    highlight.start < highlight.end &&
    highlight.end <= text.length
  ) {
    return { highlight, turn, start: highlight.start, end: highlight.end };
  }
  // No place, or a place the text no longer has: found again by its words.
  const start = findIn(text, highlight.text);
  return start < 0
    ? null
    : { highlight, turn, start, end: start + highlight.text.length };
};

/** Every highlight placed, by turn, in reading order; one that overlaps an earlier one is left out. */
export const placeHighlights = (
  turns: readonly InterviewTurn[],
  highlights: readonly InterviewHighlight[] | undefined
) => {
  const byTurn = new Map<number, PlacedHighlight[]>();
  const placed = (highlights ?? [])
    .map((highlight) => place(turns, highlight))
    .filter((each): each is PlacedHighlight => each !== null)
    .toSorted((a, b) => a.turn - b.turn || a.start - b.start);
  for (const each of placed) {
    const own = byTurn.get(each.turn) ?? [];
    const last = own.at(-1);
    if (last === undefined || each.start >= last.end) {
      byTurn.set(each.turn, [...own, each]);
    }
  }
  return byTurn;
};

/** A piece of a turn's text: plain, or one highlight's words. */
export interface Piece {
  text: string;
  at: number;
  mark?: PlacedHighlight;
  /**
   * The punctuation straight after a highlight's words (", " and ". " lose their space): kept with
   * them, so the kind's pill follows "times," and never stands between a phrase and its comma.
   */
  tail?: Piece;
}

// Punctuation that closes onto the word before it.
const closing = /^[,.;:!?…)\]»”’]+/u;

/** A turn's text cut into plain pieces and its highlights' words. */
export const piecesOf = (
  text: string,
  marks: readonly PlacedHighlight[] | undefined
): Piece[] => {
  const pieces: Piece[] = [];
  let at = 0;
  for (const mark of marks ?? []) {
    if (mark.start > at) {
      pieces.push({ text: text.slice(at, mark.start), at });
    }
    // Its closing punctuation, up to the next highlight.
    const next =
      marks?.find((other) => other.start >= mark.end)?.start ?? text.length;
    const after = closing.exec(text.slice(mark.end, next))?.[0] ?? "";
    pieces.push({
      text: text.slice(mark.start, mark.end),
      at: mark.start,
      mark,
      tail: after === "" ? undefined : { text: after, at: mark.end },
    });
    at = mark.end + after.length;
  }
  if (at < text.length) {
    pieces.push({ text: text.slice(at), at });
  }
  return pieces;
};

/** Every place the words searched for stand in the turns, case-blind, in reading order; none for no words. */
export const matchesOf = (
  turns: readonly InterviewTurn[],
  query: string
): InterviewMatch[] => {
  const words = query.trim().toLowerCase();
  const found: InterviewMatch[] = [];
  if (words === "") {
    return found;
  }
  for (const [turn, said] of turns.entries()) {
    const text = said.text.toLowerCase();
    for (
      let start = text.indexOf(words);
      start >= 0;
      start = text.indexOf(words, start + words.length)
    ) {
      found.push({
        turn,
        start,
        end: start + words.length,
        index: found.length,
      });
    }
  }
  return found;
};

/** The matches by the turn they are in. */
export const matchesByTurn = (found: readonly InterviewMatch[]) => {
  const byTurn = new Map<number, InterviewMatch[]>();
  for (const each of found) {
    byTurn.set(each.turn, [...(byTurn.get(each.turn) ?? []), each]);
  }
  return byTurn;
};

/** A run of a turn's words, cut where the matches start and end; `match` is the match it is in. */
export interface FoundPiece {
  text: string;
  at: number;
  match?: InterviewMatch;
}

/** The words of a turn from `from` to `to`, cut at the matches inside them. */
export const foundPiecesOf = (
  text: string,
  from: number,
  to: number,
  found: readonly InterviewMatch[] | undefined
): FoundPiece[] => {
  const pieces: FoundPiece[] = [];
  let at = from;
  for (const match of found ?? []) {
    const start = Math.max(match.start, from);
    const end = Math.min(match.end, to);
    if (end <= start || start < at) {
      continue;
    }
    if (start > at) {
      pieces.push({ text: text.slice(at, start), at });
    }
    pieces.push({ text: text.slice(start, end), at: start, match });
    at = end;
  }
  if (at < to) {
    pieces.push({ text: text.slice(at, to), at });
  }
  return pieces;
};

/** The chapter that starts at a turn, if one does. */
export const chapterAt = (
  chapters: readonly InterviewChapter[] | undefined,
  index: number
) => chapters?.find((chapter) => chapter.firstTurn === index);

/** A turn's key: its id, or its place. */
export const keyOf = (turn: InterviewTurn, index: number) =>
  turn.id ?? `turn-${index}`;

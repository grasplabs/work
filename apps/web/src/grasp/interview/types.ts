// What an interview is, shared by the parts of Interview (interview.tsx, transcript.tsx, quote.tsx,
// themes.tsx, moment.tsx, timeline.tsx, source.ts). The shapes are the product's own: a turn is a
// transcript's raw turn with exact milliseconds, a chapter points at turns by their place, and a
// highlight is marked by its place in a turn, found by its words only when no place is given.
import type { ReactNode } from "react";

import type { IconData } from "../icons";

/**
 * A tint, for a speaker or a kind of highlight. Each is drawn from the status and accent tokens,
 * so it follows light and dark, and a written word on it or in it holds 4.5:1.
 */
export type InterviewTone =
  | "sea"
  | "violet"
  | "leaf"
  | "amber"
  | "pine"
  | "rose"
  | "neutral";

/** One turn of the conversation: who spoke, what they said, and when, when it is known. */
export interface InterviewTurn {
  /** A steady id for the turn, kept across edits; its place in `turns` stands in without one. */
  id?: string;
  /** Who spoke: a key into `speakers`, or the words shown when there are no speakers. */
  speaker: string;
  /** What they said, as one text. */
  text: string;
  /** When the turn starts, in milliseconds from the start. */
  startMs?: number;
  /** When it ends, in milliseconds; the next turn's start stands in without it. */
  endMs?: number;
}

/** Someone in the interview. Grasp keeps roles, not names, so `name` is often a role. */
export interface InterviewSpeaker {
  /** The key the turns use, in a list of speakers; the name stands in without it. */
  id?: string;
  /** The words shown for them: a name, or a role ("Operations lead"). */
  name: string;
  /** Their role, shown beside the name when it is not the name itself. */
  role?: string;
  /** Their portrait's address; their initials stand in without one. */
  src?: string;
  /** Their tint, in place of the one `toneOf` gives their place. */
  tone?: InterviewTone;
}

/** A chapter: a title over a run of turns. */
export interface InterviewChapter {
  /** What the chapter is about ("Month end close"). */
  title: string;
  /** The first turn in it, by its place in `turns`, from 0. */
  firstTurn: number;
  /** The last turn in it; the turn before the next chapter stands in without it. */
  lastTurn?: number;
}

/** A marked moment: words in a turn that matter, of a kind. */
export interface InterviewHighlight {
  /** A steady id for the highlight. */
  id: string;
  /** Its kind, a key into `kinds` ("blocker"): its label and its tint. */
  kind?: string;
  /** The turn it is in, by its place in `turns`; without it, the first turn holding `text`. */
  turn?: number;
  /** Where its words start in the turn's text, counted in characters. */
  start?: number;
  /** Where they end, the character after the last. Without both, `text` is found in the turn. */
  end?: number;
  /** Its words, as said. */
  text: string;
}

/** A kind of highlight: its label in words, its one quiet tone, and an icon when it has a clear one. */
export interface InterviewKind {
  /** The label, written in the kind's pill beside every highlight of the kind ("Blocker"): the word tells the kind. */
  label: string;
  /**
   * Its tone, the same in three places: the pill's soft fill and words, the pill in the kinds line
   * above the transcript, and the moment's mark on the timeline. Never the only sign: the label is
   * always written.
   * @default "neutral"
   */
  tone?: InterviewTone;
  /** Its icon, from the icons entry (`@/components/grasp/icons`), shown in its pill; a small dot in its tone without one. */
  icon?: IconData;
}

/**
 * What a kind's pill shows before its label: `auto`, the kind's icon when it has one, else a dot in
 * its tone; `icon`, only an icon, so a kind without one shows its label alone; `dot`, always the
 * dot; `none`, the label alone.
 */
export type InterviewKindMark = "auto" | "icon" | "dot" | "none";

/**
 * How the transcript marks a highlight: `margin` (the default), nothing in the words at rest, a
 * thin rule in the turn's end margin beside its lines and the kind's word at the rule, with the
 * kinds counted once above; `underline`, a hairline under its words and the kind's word after them.
 */
export type InterviewHighlightLook = "underline" | "margin";

/** The sound of the interview. */
export interface InterviewMedia {
  /** The sound file's address. */
  src: string;
  /** Its length in seconds, when known: then nothing is fetched until it plays. */
  duration?: number;
}

/** A speaker as the parts draw them, with their key and tint settled. */
export interface InterviewPerson {
  key: string;
  name: string;
  role?: string;
  src?: string;
  tone: InterviewTone;
}

/** A highlight with its place settled: the turn and the characters it covers. */
export interface PlacedHighlight {
  highlight: InterviewHighlight;
  turn: number;
  start: number;
  end: number;
}

/** Every word the parts show or say, so a product can translate them. */
export interface InterviewWords {
  /** A moment as it is shown, from its milliseconds ("12:04"). */
  clock: (ms: number) => string;
  /** How long, as it is shown ("45 min"). */
  length: (ms: number) => string;
  /** A turn's number when the transcript has no times ("3"). */
  passage: (n: number) => string;
  /** A turn with no time, as a citation names it, from the same number ("passage 3"). */
  atPassage: (n: number) => string;
  /** A time button's name, from its time and who speaks ("Go to 12:04, Operations lead"). */
  seek: (time: string, who: string) => string;
  /** A turn's name, from who speaks and its time or number ("Operations lead, 12:04"). */
  turn: (who: string, at: string) => string;
  /** The transcript's name. */
  transcript: string;
  /** The timeline's name. */
  timeline: string;
  /** The timeline's list of speakers, by name. */
  speakers: string;
  /** The timeline's list of chapters, by name. */
  chapters: string;
  /** A highlight's label when it has no kind. */
  highlight: string;
  /** The list of the kinds of highlight above a transcript marked in its margin. */
  kinds: string;
  /** A kind and how many highlights of it there are, in that list ("Blocker 2"). */
  kindCount: (kind: string, count: number) => string;
  /** The timeline's list of who spoke when, for a screen reader. */
  runs: string;
  /** A speaker's stretch on the timeline, for a screen reader and the caption ("Operations lead, 0:02 to 0:05"). */
  run: (who: string, from: string, to: string) => string;
  /** What is under the pointer on the timeline, in its caption ("Operations lead · 0:12"). */
  at: (what: string, time: string) => string;
  /** A mark's name on the timeline ("Blocker at 12:04"). */
  mark: (kind: string, time: string) => string;
  /** A theme's count ("7 of 12 interviews"). */
  count: (count: number, total: number) => string;
  /** The citation of a quote with a moment ("Month end interview, 12:04"). */
  cite: (interview: string, time: string) => string;
  /**
   * The name of one control of a moment's player, from the control's own name and the player's
   * ("Play, Operations lead at 12:04"), so two players on one page never share a name.
   */
  control: (name: string, player: string) => string;
  /** The sound player's name for a moment ("Operations lead at 12:04"). */
  player: (who: string, time: string) => string;
  /** The sound player's name for the whole interview. */
  sound: string;
  /** Where an interview lives, as a source says it ("Interview · 45 min"). */
  origin: (how: string | undefined, length: string | undefined) => string;
  /** The search field's name ("Search the transcript"). */
  search: string;
  /** The button that goes to the match before. */
  previousMatch: string;
  /** The button that goes to the match after. */
  nextMatch: string;
  /** Where the search is, said and shown: the match it is on, of how many ("2 of 7"). */
  matchOf: (n: number, count: number) => string;
  /** Said and shown when the words searched for are in no turn. */
  noMatches: string;
}

/** One place the words searched for stand in a turn. */
export interface InterviewMatch {
  /** The turn, by its place. */
  turn: number;
  /** Where the words start in the turn's text, in characters. */
  start: number;
  /** The character after the last. */
  end: number;
  /** Its place among all the matches, from 0. */
  index: number;
}

/** The interview's own data, shared by Interview and by a part used without one. */
export interface InterviewDataProps {
  /** The turns, in the order they were said. */
  turns?: readonly InterviewTurn[];
  /**
   * Who speaks: a record by the key the turns use, or a list (each with its `id`, or its name as
   * the key). Without it, a turn's `speaker` is shown as it is.
   */
  speakers?:
    | Readonly<Record<string, InterviewSpeaker>>
    | readonly InterviewSpeaker[];
  /** The chapters, each a title over a run of turns. */
  chapters?: readonly InterviewChapter[];
  /** The marked moments, placed by turn and characters, or found by their words. */
  highlights?: readonly InterviewHighlight[];
  /** The kinds of highlight, by key: each a label and a tint. */
  kinds?: Readonly<Record<string, InterviewKind>>;
  /** The active turn, by its place from 0, or null for none. Pass it with `onTurnChange` to control it. */
  turn?: number | null;
  /** The turn active at first, when you do not control it. */
  defaultTurn?: number | null;
  /** Runs with a turn's place when it becomes active: chosen, or reached by the sound. */
  onTurnChange?: (turn: number) => void;
  /** Runs with the milliseconds to go to, for a page that plays the sound itself. */
  onSeek?: (ms: number) => void;
  /** The sound of the interview: its file and its length. */
  media?: InterviewMedia;
  /** A speaker's tint from their place among the speakers, when they have none of their own. */
  toneOf?: (index: number) => InterviewTone;
  /** Every word the parts show or say, in the product's language; any left out are English. */
  words?: Partial<InterviewWords>;
  /**
   * Whether a long transcript draws only the turns near the view. By default it does past 200
   * turns; a number sets how many; `true` always; `false` never, so every turn is in the page.
   * It windows only with `height`, inside its own scroller: without it every turn is drawn.
   * @default 200
   */
  window?: boolean | number;
  /**
   * A search field above the transcript: the words typed are marked in every turn, and Enter and
   * Shift+Enter, or its two buttons, go from match to match.
   * @default false
   */
  search?: boolean;
  /** The words searched for. Pass it with `onQueryChange` to control it. */
  query?: string;
  /**
   * The words searched for at first, when you do not control them.
   * @default ""
   */
  defaultQuery?: string;
  /** Runs with the words searched for as they change; with "" when Escape clears them. */
  onQueryChange?: (query: string) => void;
  /**
   * The language of the interview's words, as a tag ("nl"): set as each part's `lang`, so its words
   * hyphenate by that language's rules. Without it nothing hyphenates by itself, and a long word
   * breaks only where it would run out of its box.
   */
  lang?: string;
}

/** Every prop an Interview takes. */
export interface InterviewProps extends InterviewDataProps {
  /**
   * How its transcripts mark a highlight: `margin`, a thin rule beside the lines in the turn's
   * end margin, the kind's word at it, and the kinds counted once above the transcript (drawn as
   * `underline` where the rule cannot be placed exactly); `underline`, a hairline under the words
   * and the kind's word after them. A transcript's own `highlightLook` wins.
   * @default "margin"
   */
  highlightLook?: InterviewHighlightLook;
  /**
   * What a kind's pill shows before its label: `auto`, the kind's icon when it has one, else a dot
   * in its tone; `icon`, an icon only (give every kind one); `dot`, always the dot; `none`, the
   * label alone.
   * @default "auto"
   */
  kindMark?: InterviewKindMark;
  /** The parts that show it: a head, the transcript, quotes, a timeline, a moment. */
  children: ReactNode;
}

/** A quote from one interview, as a theme or a wall holds it. */
export interface InterviewQuoteItem {
  /** A steady id. */
  id: string;
  /** What was said. */
  text: string;
  /** Who said it: a name or a role. */
  who: string;
  /** Their portrait's address. */
  src?: string;
  /** Which interview it is from ("Month end close, finance"). */
  interview?: string;
  /** The moment, in milliseconds from the interview's start. */
  atMs?: number;
  /** Where the moment opens: the interview at that time. */
  href?: string;
  /** Its kind's label ("Blocker"). */
  kind?: string;
  /** Its kind's tint. */
  tone?: InterviewTone;
}

/** A theme across interviews: a title, how many interviews raised it, and the quotes behind it. */
export interface InterviewTheme {
  /** A steady id, used in `value`. */
  id: string;
  /** What the theme is ("Handovers by email"). */
  title: string;
  /** How many interviews raised it. */
  count: number;
  /** The quotes behind it. */
  quotes: readonly InterviewQuoteItem[];
  /** Its tint, for its share bar. */
  tone?: InterviewTone;
}

/** One interview as data, for `interviewSource`. */
export interface InterviewRecord {
  /** Its title ("Month end close, finance"). */
  title: string;
  /** How it was held ("Live", "Video call"). */
  how?: string;
  /** When ("12 November"). */
  when?: string;
  /** How long, in milliseconds; the last turn's end stands in without it. */
  durationMs?: number;
  /** Where the interview opens. */
  href?: string;
  /** Where it lives, in place of the words `origin` makes from `how` and its length. */
  origin?: string;
  /** Its turns. */
  turns: readonly InterviewTurn[];
  /** Who speaks, as Interview takes them. */
  speakers?: InterviewDataProps["speakers"];
}

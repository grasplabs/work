// One interview, shared by its parts (interview.tsx): its turns and speakers, where each highlight
// lies, the active turn, and the way to go to a turn or a moment. The sound's time has a context of
// its own, so a playing sound redraws only the parts that show it (the timeline's playhead), not
// every turn of a long transcript.
import { createContext, useContext } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

import type { AudioPlayerHandle } from "../audio-player";
import type { IconData } from "../icons";
import type {
  InterviewChapter,
  InterviewHighlightLook,
  InterviewKindMark,
  InterviewMatch,
  InterviewMedia,
  InterviewPerson,
  InterviewTone,
  InterviewTurn,
  InterviewWords,
  PlacedHighlight,
} from "./types";

/** A sound player inside an Interview: the ref its Audio player fills with `seek`, `play` and `pause`. */
export type InterviewPlayer = RefObject<AudioPlayerHandle | null>;

/** What the parts of one Interview share. */
export interface InterviewValue {
  /** The turns, in the order they were said. */
  turns: readonly InterviewTurn[];
  /** Every speaker by the key the turns use, each with a tint. */
  people: ReadonlyMap<string, InterviewPerson>;
  /** The chapters. */
  chapters: readonly InterviewChapter[];
  /** Every highlight placed, by the turn it is in. */
  marks: ReadonlyMap<number, readonly PlacedHighlight[]>;
  /** A kind's label and tint, by its key; the plain highlight's for a highlight with no kind. */
  kindOf: (kind: string | undefined) => {
    label: string;
    tone: InterviewTone;
    icon?: IconData;
  };
  /** What a kind's pill shows before its label. */
  kindMark: InterviewKindMark;
  /** Every word the parts show or say. */
  words: InterviewWords;
  /** How the transcripts mark a highlight, unless a transcript says otherwise. */
  highlightLook: InterviewHighlightLook;
  /** The active turn, or null for none. */
  active: number | null;
  /** Makes a turn active and sends the sound to its start. */
  go: (turn: number) => void;
  /** Sends the sound to a moment, in milliseconds. */
  seek: (ms: number) => void;
  /** Whether a seek reaches anything: a sound, a player or the page's own `onSeek`. */
  seeks: boolean;
  /** How many times a turn was asked for, so a transcript shows it again even when it is the same turn. */
  asked: number;
  /** The turns past which a transcript with a height draws only those near the view; null for never. */
  windowFrom: number | null;
  /** A search field is shown above the transcript. */
  search: boolean;
  /** The words searched for, "" for none. */
  query: string;
  /** Changes the words searched for. */
  setQuery: (query: string) => void;
  /** Every match of the words searched for, from the turns themselves, drawn or not. */
  matches: readonly InterviewMatch[];
  /** The matches by the turn they are in. */
  matchesIn: ReadonlyMap<number, readonly InterviewMatch[]>;
  /** The language of its words ("nl"), or nothing when it is not known. */
  lang: string | undefined;
  /** The sound, when the interview has one. */
  media: InterviewMedia | undefined;
  /** Sets the sound players a seek reaches. A setter, so it stays the same from render to render. */
  setPlayers: Dispatch<SetStateAction<readonly InterviewPlayer[]>>;
}

/** One interview's turns, speakers and active turn, for its parts. */
export const InterviewContext = createContext<InterviewValue | null>(null);

/** The interview, or null outside an Interview. */
export const useInterview = () => useContext(InterviewContext);

/** The sound's time, in milliseconds, or null before it has played. */
export const InterviewClockContext = createContext<number | null>(null);

/** The sound's time, in milliseconds, or null before it has played or outside an Interview. */
export const useInterviewTime = () => useContext(InterviewClockContext);

/** Tells the interview where a player's sound is, in seconds, as its `onTimeChange` says it. */
export type InterviewHear = (player: InterviewPlayer, seconds: number) => void;

/** How a player inside an Interview tells it where its sound is; null outside an Interview. */
export const InterviewHearContext = createContext<InterviewHear | null>(null);

/** How a player tells its interview where its sound is, or null outside an Interview. */
export const useInterviewHear = () => useContext(InterviewHearContext);

/** Adds a player to the ones a seek reaches; returns what takes it away again. */
export const attachPlayer = (
  setPlayers: InterviewValue["setPlayers"],
  player: InterviewPlayer
) => {
  setPlayers((players) =>
    players.includes(player) ? players : [...players, player]
  );
  return () => {
    setPlayers((players) =>
      players.includes(player)
        ? players.filter((each) => each !== player)
        : players
    );
  };
};

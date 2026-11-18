// InterviewMoment: a moment you can hear: the quote, and our Audio player under it, set to start
// where the moment starts and stop where it ends (Audio player's `startAt` and `endAt`). Inside an
// Interview with sound, the player is heard through its `onTimeChange`: as it plays, the
// transcript's active turn and the timeline's playhead move with it; and a time pressed in the
// transcript sends this player there through its `handle`.
//
//   <Interview turns={turns} media={{ src: "/media/month-end.mp3", duration: 2700 }}>
//     <InterviewMoment turn={14} />
//   </Interview>
//   <InterviewMoment src="/media/clip.mp3" startMs={4000} endMs={9000} who="Operations lead">…</InterviewMoment>
//
// With no turn, no start and no words, it is the whole interview's player, for a page that shows
// the transcript or the timeline beside the sound.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { AudioPlayer, audioPlayerWords } from "../audio-player";
import type { AudioPlayerHandle, AudioPlayerWords } from "../audio-player";
import { grasp } from "../tokens/tokens.stylex";
import { attachPlayer, useInterview, useInterviewHear } from "./context";
import type { InterviewPlayer, InterviewValue } from "./context";
import { langOf } from "./lang";
import type { InterviewLayoutStyle } from "./layout";
import { InterviewQuote } from "./quote";
import type { InterviewQuoteSize } from "./quote";
import { endOf, hasWords } from "./read";
import type { InterviewTone, InterviewWords } from "./types";
import { useInterviewWords } from "./words";

/** Every prop an InterviewMoment takes. */
export interface InterviewMomentProps {
  /** Inside an Interview: the turn, by its place. Its words, speaker and times stand in for the rest. */
  turn?: number;
  /** Where the moment starts, in milliseconds. Inside an Interview, the turn's start stands in without it. */
  startMs?: number;
  /** Where it ends, in milliseconds; the sound plays on to the end without it. */
  endMs?: number;
  /** What was said; inside an Interview, the turn's words stand in without it. */
  children?: ReactNode;
  /** Who said it; inside an Interview, the turn's speaker stands in without it. */
  who?: string;
  /** Which interview it is from. */
  interview?: string;
  /** The sound file's address; inside an Interview, its `media` stands in without it. */
  src?: string;
  /** The sound's length in seconds, when known: nothing is fetched until it plays. */
  duration?: number;
  /** The player's name, for a screen reader and an agent; the words say who and when without it. */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * The quote's size.
   * @default "md"
   */
  size?: InterviewQuoteSize;
  /** The quote's kind or theme, in a word or two. */
  kind?: string;
  /**
   * The quote's tint.
   * @default "pine"
   */
  tone?: InterviewTone;
  /** The words it writes itself, any of them replaced; inside an Interview, the interview's words. */
  words?: Partial<InterviewWords>;
  /** The language of its words ("nl"), so they hyphenate by its rules; inside an Interview, the interview's. */
  lang?: string;
  /**
   * The player without its own box and without its own times, for a page that frames it and writes
   * where the sound is itself.
   * @default false
   */
  bare?: boolean;
  /**
   * The player's own words, in the page's language ("Play", "Back 10 seconds"). Each control is
   * then named for this player through `words.control`.
   * @default the player's English words
   */
  playerWords?: Partial<AudioPlayerWords>;
  /** What stands where the player's own timeline would, and moves the sound: a conversation timeline's strip. */
  track?: ReactNode;
  /** @deprecated Use `layout`. */
  style?: InterviewLayoutStyle;
  /** Layout only: where it sits and how wide it is. */
  layout?: InterviewLayoutStyle;
}

const styles = stylex.create({
  // One column as wide as the moment, so the player's own width never widens it.
  moment: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: grasp.space4,
    minWidth: 0,
  },
});

/** Milliseconds as seconds, or nothing. */
const secondsOf = (ms: number | undefined) =>
  ms === undefined ? undefined : ms / 1000;

/** Where the moment stops, in seconds: nothing for an end at or before its start. */
const endOfMoment = (startMs: number | undefined, endMs: number | undefined) =>
  endMs === undefined || (startMs !== undefined && endMs <= startMs)
    ? undefined
    : endMs / 1000;

/** The player's handle, reached by the interview's seeks while the moment is there. */
const useAttached = (
  player: InterviewPlayer,
  setPlayers: InterviewValue["setPlayers"] | undefined
) => {
  useEffect(
    () =>
      setPlayers === undefined ? undefined : attachPlayer(setPlayers, player),
    [player, setPlayers]
  );
};

/** The player's handle and what tells the interview where its sound is, inside an Interview. */
const useHeardPlayer = (shared: InterviewValue | null) => {
  const hear = useInterviewHear();
  const player = useRef<AudioPlayerHandle | null>(null);
  useAttached(player, shared?.setPlayers);
  const onTimeChange =
    hear === null
      ? undefined
      : (seconds: number) => {
          hear(player, seconds);
        };
  return { player, onTimeChange };
};

/** The player's name: the one given, else who and when, else the whole interview's sound. */
/**
 * The player's words with every control named for this player ("Play, Operations lead at 12:04"):
 * on a page with a moment's player and a timeline's, an agent and a screen reader tell them apart.
 */
const controlsOf = (
  words: InterviewWords,
  player: string,
  base: AudioPlayerWords
): AudioPlayerWords => ({
  ...base,
  play: words.control(base.play, player),
  pause: words.control(base.pause, player),
  back: words.control(base.back, player),
  forward: words.control(base.forward, player),
  position: words.control(base.position, player),
  speed: words.control(base.speed, player),
  soundOn: words.control(base.soundOn, player),
  soundOff: words.control(base.soundOff, player),
});

const nameOf = (
  words: InterviewWords,
  label: string | undefined,
  start: number | undefined,
  name: string | undefined
) => {
  if (label !== undefined) {
    return label;
  }
  return start === undefined
    ? words.sound
    : words.player(name ?? "", words.clock(start));
};

/** What the turn gives a moment inside an Interview: its start and end, who said it and the words. */
const fromTurn = (shared: InterviewValue | null, turn: number | undefined) => {
  const said = turn === undefined ? undefined : shared?.turns[turn];
  if (shared === null || turn === undefined || said === undefined) {
    return {
      start: undefined,
      end: undefined,
      who: undefined,
      text: undefined,
    };
  }
  return {
    start: said.startMs,
    end: endOf(shared.turns, turn),
    who: shared.people.get(said.speaker)?.name ?? said.speaker,
    text: said.text,
  };
};

/** A moment you can hear: the quote and the player, starting at the moment. */
export const InterviewMoment = ({
  turn,
  startMs,
  endMs,
  children,
  who,
  interview,
  src,
  duration,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated,
  size = "md",
  kind,
  tone = "pine",
  words: given,
  lang: own,
  bare = false,
  playerWords,
  track,
  style: styleProp,
  layout,
}: InterviewMomentProps) => {
  const shared = useInterview();
  const { lang, words: wording } = langOf(own, shared?.lang);
  const { player, onTimeChange } = useHeardPlayer(shared);
  const catalogued = useInterviewWords(given);
  const words = shared === null ? catalogued : { ...shared.words, ...given };
  const found = fromTurn(shared, turn);
  const start = startMs ?? found.start;
  const file = src ?? shared?.media?.src;
  const name = who ?? found.who;
  const quote = children ?? found.text;
  const named = nameOf(words, label, start, name);
  return (
    <div
      data-slot="interview-moment"
      lang={lang}
      {...stylex.props(styles.moment, wording, layout ?? styleProp)}
    >
      {quote === undefined ? null : (
        <InterviewQuote
          turn={turn}
          who={name}
          interview={interview}
          atMs={start}
          size={size}
          kind={kind}
          tone={tone}
          words={given}
          lang={lang}
        >
          {quote}
        </InterviewQuote>
      )}
      {hasWords(file) ? (
        <AudioPlayer
          src={file}
          startAt={secondsOf(start)}
          endAt={endOfMoment(start, endMs ?? found.end)}
          handle={player}
          onTimeChange={onTimeChange}
          duration={duration ?? shared?.media?.duration}
          aria-label={named}
          words={controlsOf(words, named, {
            ...audioPlayerWords,
            ...playerWords,
          })}
          bare={bare}
          // Bare, the page round it writes where the sound is and how long it is.
          times={!bare}
          track={track}
        />
      ) : null}
    </div>
  );
};

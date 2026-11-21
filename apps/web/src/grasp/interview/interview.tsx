"use client";

import { useState } from "react";
import type { ReactNode } from "react";

import {
  InterviewClockContext,
  InterviewContext,
  InterviewHearContext,
} from "./context";
import type { InterviewHear, InterviewPlayer, InterviewValue } from "./context";
import {
  matchesByTurn,
  matchesOf,
  peopleOf,
  placeHighlights,
  turnAt,
} from "./read";
import { windowFrom } from "./rows";
import type {
  InterviewChapter,
  InterviewKind,
  InterviewProps,
  InterviewTurn,
} from "./types";
import { useInterviewWords } from "./words";

export type { InterviewProps } from "./types";

const noTurns: readonly InterviewTurn[] = [];
const noChapters: readonly InterviewChapter[] = [];
const noKinds: Readonly<Record<string, InterviewKind>> = {};
const noPlayers: readonly InterviewPlayer[] = [];

interface ClockProps {
  /** Runs with the player and the milliseconds whenever a player's sound moves. */
  onHeard: (player: InterviewPlayer, ms: number) => void;
  children: ReactNode;
}

/**
 * The sound's time, told by the players through their `onTimeChange`, in a context of its own:
 * while it plays only what shows the time is drawn again, never the turns, which come in as the
 * same children.
 */
const Clock = ({ onHeard, children }: ClockProps) => {
  const [time, setTime] = useState<number | null>(null);
  const hear: InterviewHear = (player, seconds) => {
    const ms = seconds * 1000;
    setTime(ms);
    onHeard(player, ms);
  };
  return (
    <InterviewHearContext value={hear}>
      <InterviewClockContext value={time}>{children}</InterviewClockContext>
    </InterviewHearContext>
  );
};

/** Holds one interview for its parts. Renders nothing of its own. */
export const Interview = ({
  children,
  turns = noTurns,
  speakers,
  chapters = noChapters,
  highlights,
  kinds = noKinds,
  turn,
  defaultTurn = null,
  onTurnChange,
  onSeek,
  media,
  toneOf,
  words: given,
  window: windowing,
  search = false,
  query: askedQuery,
  defaultQuery = "",
  onQueryChange,
  lang,
  highlightLook = "margin",
  kindMark = "auto",
}: InterviewProps) => {
  const [ownQuery, setOwnQuery] = useState(defaultQuery);
  const query = askedQuery ?? ownQuery;
  const matches = matchesOf(turns, query);
  const [own, setOwn] = useState<number | null>(defaultTurn);
  // The players inside it, and the one heard last, in state so reading them while drawing is allowed.
  const [players, setPlayers] = useState(noPlayers);
  const [current, setCurrent] = useState<InterviewPlayer | null>(null);
  const [asked, setAsked] = useState(0);
  const active = turn === undefined ? own : turn;
  const words = useInterviewWords(given);

  const change = (next: number) => {
    setOwn(next);
    if (onTurnChange !== undefined) {
      onTurnChange(next);
    }
  };
  const seek = (ms: number) => {
    // The player heard last, else the first: through its handle, never its audio element.
    const player = current ?? players[0];
    player?.current?.seek(Math.max(0, ms / 1000));
    if (onSeek !== undefined) {
      onSeek(ms);
    }
  };
  // A sound that moves moves the active turn to the one being said.
  const onHeard = (player: InterviewPlayer, ms: number) => {
    setCurrent(player);
    const at = turnAt(turns, ms);
    if (at !== null && at !== active) {
      change(at);
    }
  };

  const value: InterviewValue = {
    turns,
    people: peopleOf(speakers, turns, toneOf),
    chapters,
    marks: placeHighlights(turns, highlights),
    kindOf: (kind) => {
      const found = kind === undefined ? undefined : kinds[kind];
      return {
        label: found?.label ?? words.highlight,
        tone: found?.tone ?? "neutral",
        icon: found?.icon,
      };
    },
    words,
    highlightLook,
    kindMark,
    active,
    go: (index) => {
      change(index);
      setAsked((now) => now + 1);
      const start = turns[index]?.startMs;
      if (start !== undefined) {
        seek(start);
      }
    },
    seek,
    seeks: media !== undefined || onSeek !== undefined || players.length > 0,
    asked,
    windowFrom: windowFrom(windowing),
    search,
    query,
    setQuery: (next) => {
      setOwnQuery(next);
      if (onQueryChange !== undefined) {
        onQueryChange(next);
      }
    },
    matches,
    matchesIn: matchesByTurn(matches),
    lang,
    media,
    setPlayers,
  };
  return (
    <InterviewContext value={value}>
      <Clock onHeard={onHeard}>{children}</Clock>
    </InterviewContext>
  );
};

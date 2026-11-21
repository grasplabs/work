// The transcript's search (transcript.tsx, with `search`): a field above the turns, on our Input
// group with the Search icon. The words typed are found in every turn, from the turns themselves,
// without regard to case; every match is marked, and the one it is on more strongly. Its place
// ("2 of 7", or "No matches") is shown and said, politely. Enter goes to the next match,
// Shift+Enter to the one before, as its two buttons do; Escape clears the words.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { KeyboardEvent } from "react";

import { Button } from "../button";
import { ChevronDown, ChevronUp, Search } from "../icons";
import { InputGroup, InputGroupInput, InputGroupText } from "../input-group";
import { grasp } from "../tokens/tokens.stylex";
import type { InterviewValue } from "./context";

const styles = stylex.create({
  bar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: grasp.space2,
    rowGap: grasp.space2,
    minWidth: 0,
  },
  field: {
    flexGrow: 1,
    flexBasis: "14rem",
    minWidth: 0,
  },
  steps: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    marginInlineStart: "auto",
  },
  // The place and, under it unseen, the widest words it can say, in one cell: the count is as
  // wide as "No matches" whatever it says, so the field beside it never narrows as words are typed
  // (eyes-b, B3-interview).
  room: {
    display: "inline-grid",
  },
  layer: {
    gridArea: "1 / 1",
  },
  unseen: {
    visibility: "hidden",
  },
  count: {
    margin: 0,
    minInlineSize: grasp.space16,
    paddingInlineEnd: grasp.space1,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
    textAlign: "end",
    whiteSpace: "nowrap",
  },
});

interface TranscriptSearchProps {
  shared: InterviewValue;
  /** The match it is on, by its place among all, or null with none. */
  place: number | null;
  /** Goes to the next match (1) or the one before (-1). */
  onStep: (by: 1 | -1) => void;
}

/** Where the search is, in words: "2 of 7", "No matches", or nothing with no words typed. */
const said = (shared: InterviewValue, place: number | null) => {
  if (shared.query.trim() === "") {
    return "";
  }
  return place === null
    ? shared.words.noMatches
    : shared.words.matchOf(place + 1, shared.matches.length);
};

/** The search field, where it is, and the two buttons that step from match to match. */
export const TranscriptSearch = ({
  shared,
  place,
  onStep,
}: TranscriptSearchProps) => {
  const { words } = shared;
  const none = shared.matches.length === 0;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onStep(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape" && shared.query !== "") {
      event.preventDefault();
      shared.setQuery("");
    }
  };
  return (
    <search data-slot="interview-search" {...stylex.props(styles.bar)}>
      <div {...stylex.props(styles.field)}>
        <InputGroup>
          <InputGroupText icon={Search} />
          <InputGroupInput
            type="search"
            aria-label={words.search}
            // Seen too, so the row says what it is before anything is typed (eyes-b, B3-interview-07).
            placeholder={words.search}
            value={shared.query}
            onValueChange={(next: string) => {
              shared.setQuery(next);
            }}
            onKeyDown={onKeyDown}
          />
        </InputGroup>
      </div>
      <div {...stylex.props(styles.steps)}>
        {/* Shown, and said politely as it changes. */}
        <span {...stylex.props(styles.room)}>
          <span
            aria-hidden="true"
            {...stylex.props(styles.count, styles.layer, styles.unseen)}
          >
            {words.noMatches}
          </span>
          <span
            aria-hidden="true"
            {...stylex.props(styles.count, styles.layer, styles.unseen)}
          >
            {words.matchOf(88, 88)}
          </span>
          <output
            aria-live="polite"
            data-slot="interview-search-count"
            {...stylex.props(styles.count, styles.layer)}
          >
            {said(shared, place)}
          </output>
        </span>
        <Button
          variant="ghost"
          size="sm"
          icon={ChevronUp}
          aria-label={words.previousMatch}
          disabled={none}
          onClick={() => {
            onStep(-1);
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          icon={ChevronDown}
          aria-label={words.nextMatch}
          disabled={none}
          onClick={() => {
            onStep(1);
          }}
        />
      </div>
    </search>
  );
};

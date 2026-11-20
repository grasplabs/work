// The rows a transcript draws (transcript.tsx): a heading row where a chapter starts, then its
// turns, each knowing whether it starts a run of one speaker. Worked out from the data, so a
// windowed transcript draws the right chapter and the right speaker chips wherever it is scrolled.
// A long transcript draws only the rows near the view, through UI SDK's virtualiser, as Thread
// does: measured row heights, a guess before that, and keys by turn id.
import { createVirtualizer } from "@ui-sdk/core";

import { chapterAt, keyOf } from "./read";
import type { InterviewChapter, InterviewTurn } from "./types";

/** One row of the transcript's table: a chapter's heading, or a turn. */
export type TranscriptRow =
  | { kind: "chapter"; key: string; chapter: InterviewChapter; first: boolean }
  | { kind: "turn"; key: string; index: number; runStart: boolean };

/** A run of turns under one chapter, or before the first. */
export interface Group {
  chapter?: InterviewChapter;
  from: number;
  to: number;
}

/** The turns cut into groups at each chapter's first turn. */
export const groupsOf = (
  count: number,
  chapters: readonly InterviewChapter[]
): Group[] => {
  const starts = chapters
    .map((chapter) => chapter.firstTurn)
    .filter((first) => first > 0 && first < count);
  const edges = [...new Set([0, ...starts])].toSorted((a, b) => a - b);
  return edges.map((from, index) => ({
    chapter: chapterAt(chapters, from),
    from,
    to: (edges[index + 1] ?? count) - 1,
  }));
};

/** Every row in order, and the row of each turn by its place. */
export const rowsOf = (
  turns: readonly InterviewTurn[],
  chapters: readonly InterviewChapter[]
) => {
  const rows: TranscriptRow[] = [];
  const turnRow: number[] = [];
  for (const [at, group] of groupsOf(turns.length, chapters).entries()) {
    if (group.chapter !== undefined) {
      rows.push({
        kind: "chapter",
        key: `chapter-${group.from}`,
        chapter: group.chapter,
        first: at === 0,
      });
    }
    for (let index = group.from; index <= group.to; index += 1) {
      const turn = turns[index];
      if (turn !== undefined) {
        turnRow[index] = rows.length;
        rows.push({
          kind: "turn",
          key: keyOf(turn, index),
          index,
          runStart:
            index === group.from || turns[index - 1]?.speaker !== turn.speaker,
        });
      }
    }
  }
  return { rows, turnRow };
};

/** How many turns a transcript holds before it draws only those near the view. */
export const WINDOW_FROM = 200;

/** The turns past which it windows, from the `window` prop, or null for never. */
export const windowFrom = (
  asked: boolean | number | undefined
): number | null => {
  if (asked === false) {
    return null;
  }
  if (asked === true) {
    return 0;
  }
  return asked ?? WINDOW_FROM;
};

/** How many rows are drawn before the virtualiser takes over: on the server, and at first. */
export const FIRST_ROWS = 40;

/** A row's height before it is measured, in pixels: close guesses keep the scrollbar steady. */
const estimateOf = (row: TranscriptRow | undefined) => {
  if (row?.kind === "chapter") {
    return 52;
  }
  return row?.runStart === true ? 104 : 64;
};

/**
 * The rows the virtualiser places, and the one holding the stop, which stays drawn wherever the
 * transcript is scrolled, so focus is never lost. Held here, not in refs, as the virtualiser reads
 * them during render.
 */
export const createRowSource = (first: TranscriptRow[]) => {
  let rows = first;
  let kept: number | null = null;
  const virtual = createVirtualizer({
    count: () => rows.length,
    key: (index) => rows[index]?.key ?? String(index),
    estimate: (index) => estimateOf(rows[index]),
    overscan: 8,
    keep: () => (kept === null ? [] : [kept]),
  });
  return {
    virtual,
    // The virtualiser's store, bound, as useSyncExternalStore takes it.
    subscribe: (listener: () => void) => virtual.subscribe(listener),
    placed: () => virtual.items(),
    size: () => virtual.size(),
    show: (next: TranscriptRow[]) => {
      rows = next;
    },
    keep: (row: number | null) => {
      kept = row;
    },
  };
};

/** What `createRowSource` returns. */
export type RowSource = ReturnType<typeof createRowSource>;

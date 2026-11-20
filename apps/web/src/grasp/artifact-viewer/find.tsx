// Search, shared by every renderer: the Worker finds every match in the whole text (the rows not
// rendered too), and each rendered row marks its own matches, the current one stronger.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useEffectEvent, useState } from "react";
import type { ReactNode } from "react";

import { grasp, media } from "../tokens/tokens.stylex";
import { runTask } from "./worker/client";

const styles = stylex.create({
  // A soft tint, never a border; in forced colours, the system's highlight.
  match: {
    borderRadius: 2,
    color: { default: "inherit", [media.forced]: "HighlightText" },
    backgroundColor: {
      default: grasp.viewerMatch,
      [media.forced]: "Highlight",
    },
  },
  current: {
    backgroundColor: {
      default: grasp.viewerMatchCurrent,
      [media.forced]: "Highlight",
    },
    outline: { default: "none", [media.forced]: "2px solid CanvasText" },
  },
  over: {
    backgroundColor: {
      default: `color-mix(in srgb, ${grasp.viewerMatch} 60%, transparent)`,
      [media.forced]: "Highlight",
    },
  },
  overCurrent: {
    backgroundColor: {
      default: `color-mix(in srgb, ${grasp.viewerMatchCurrent} 60%, transparent)`,
      [media.forced]: "Highlight",
    },
  },
});

/**
 * The class of a mark made outside React (a PDF's text layer, which PDF.js draws): the same tint.
 * Over a drawn page the tint is see-through, so the drawn words show through it.
 */
export const markClass = (current: boolean) =>
  stylex.props(
    styles.match,
    current && styles.current,
    styles.over,
    current && styles.overCurrent
  ).className ?? "";

/** A match: its row, and where it starts in that row's text. */
export interface Match {
  row: number;
  at: number;
}

/** Each match found in the joined text, turned back into its row and its place in that row. */
const inRows = (starts: readonly number[], found: readonly number[]) => {
  const next: Match[] = [];
  let row = 0;
  for (const at of found) {
    let following = starts[row + 1];
    while (following !== undefined && following <= at) {
      row += 1;
      following = starts[row + 1];
    }
    next.push({ row, at: at - (starts[row] ?? 0) });
  }
  return next;
};

/** Searches the rows in the Worker. Nothing to search finds nothing. Rows are joined by a line break. */
const searchRows = async (
  rowTexts: readonly string[] | null,
  find: string
): Promise<{ matches: Match[]; more?: boolean }> => {
  if (!rowTexts || !find.trim()) {
    return { matches: [] };
  }
  const text = rowTexts.join("\n");
  // Where each row starts in the joined text, to turn an offset back into a row.
  const starts: number[] = [];
  let offset = 0;
  for (const row of rowTexts) {
    starts.push(offset);
    offset += row.length + 1;
  }
  const { at: found, more } = await runTask({
    kind: "search",
    text,
    query: find,
  });
  return { matches: inRows(starts, found), more };
};

/** Every match of `find` in the rows' texts, found in the Worker. Rows are joined by a line break. */
export const useMatches = (
  rowTexts: readonly string[] | null,
  find: string,
  onMatches: (count: number, more?: boolean) => void
) => {
  const [matches, setMatches] = useState<Match[]>([]);
  // The shell's setter, read as it is now: a new one is no reason to search again.
  const report = useEffectEvent((count: number, more?: boolean) => {
    onMatches(count, more);
  });
  useEffect(() => {
    let live = true;
    const search = async () => {
      const result = await searchRows(rowTexts, find);
      if (!live) {
        return;
      }
      setMatches(result.matches);
      report(result.matches.length, result.more);
    };
    void search();
    return () => {
      live = false;
    };
  }, [rowTexts, find]);
  return matches;
};

/** Splits a piece of text at the matches that fall in it, as marks. `from` is where it starts in its row. */
export const markPiece = (
  text: string,
  from: number,
  length: number,
  inRow: readonly number[],
  current: number | undefined
): ReactNode => {
  if (inRow.length === 0 || length === 0) {
    return text;
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const at of inRow) {
    const start = Math.max(at - from, 0);
    const end = Math.min(at + length - from, text.length);
    if (end <= 0 || start >= text.length || start < cursor) {
      continue;
    }
    if (start > cursor) {
      parts.push(text.slice(cursor, start));
    }
    parts.push(
      <mark
        key={start}
        data-match={at === current ? "current" : ""}
        {...stylex.props(styles.match, at === current && styles.current)}
      >
        {text.slice(start, end)}
      </mark>
    );
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
};

/** The matches in one row, and which of them is current. */
export const rowMatches = (
  matches: readonly Match[],
  row: number,
  current: number
) => {
  const inRow: number[] = [];
  for (const match of matches) {
    if (match.row === row) {
      inRow.push(match.at);
    }
  }
  const active = matches[current];
  return { inRow, current: active?.row === row ? active.at : undefined };
};

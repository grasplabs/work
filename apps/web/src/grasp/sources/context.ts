// The sources of one answer and which one is lit, shared by its markers and its list.
import { createContext, useContext } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { Source, SourcesLabels } from "./types";

/** Every marker on the page, by the number of its source. */
export type Marks = ReadonlyMap<number, readonly HTMLElement[]>;

/** The list's state, shared so a marker can open the list and reach its own row. */
export interface ListState {
  /** Open as a list, folded as the pile, or not yet touched (the list's `defaultOpen` then decides). */
  opened: boolean | null;
  /** Every row shows, past the fold. */
  all: boolean;
  /** The order the person chose: by relevance, or grouped by kind. Kept while the list is folded. */
  order: "relevance" | "kind";
  /** The row a marker was pressed for, and which press it was, so pressing it again goes there again. */
  target: { n: number; turn: number } | null;
}

/** The list as it starts: untouched, folded after its first rows, no row asked for. */
export const startList: ListState = {
  opened: null,
  all: false,
  order: "relevance",
  target: null,
};

/** What the parts of one Sources share. */
export interface SourcesValue {
  /** The sources, numbered from 1 in this order. */
  sources: Source[];
  /** The number of the source lit now: the one under the pointer, else the one with focus. */
  active: number | null;
  /** Light a source by the pointer (`"hover"`) or by focus (`"focus"`); null for neither. */
  setActive: (number: number | null, by: "hover" | "focus") => void;
  /** The id of a source's row, so a marker can point to it. */
  rowId: (number: number) => string;
  /**
   * Sets the markers on the page, kept so markers of one source can be told apart. A setter, so it
   * stays the same from render to render; a marker registers itself with `registerMark`.
   */
  setMarks: Dispatch<SetStateAction<Marks>>;
  /** Where a marker stands among its source's markers, in reading order: 1 of 2, and so on. */
  place: (
    number: number,
    element: HTMLElement | null
  ) => { index: number; count: number };
  /** The list's state: open or folded, every row or the first few, and the row a marker asked for. */
  list: ListState;
  /** Changes the list's state. A setter, so it stays the same from render to render. */
  setList: Dispatch<SetStateAction<ListState>>;
  /** Every word the parts show or say. */
  labels: SourcesLabels;
  /** Runs when the person opens a source: its row, or its card's link to a run. */
  onOpen: ((source: Source, index: number) => void) | undefined;
}

/** One answer's sources, for its markers and its list. */
export const SourcesContext = createContext<SourcesValue | null>(null);

/** The answer's sources, or null outside a Sources (a part then draws as if it had none). */
export const useSources = () => useContext(SourcesContext);

/** Adds a marker to its source's markers; returns what takes it away again. */
export const registerMark = (
  setMarks: SourcesValue["setMarks"],
  number: number,
  element: HTMLElement
) => {
  setMarks((marks) => {
    const own = marks.get(number) ?? [];
    if (own.includes(element)) {
      return marks;
    }
    return new Map(marks).set(number, [...own, element]);
  });
  return () => {
    setMarks((marks) => {
      const own = marks.get(number) ?? [];
      if (!own.includes(element)) {
        return marks;
      }
      return new Map(marks).set(
        number,
        own.filter((each) => each !== element)
      );
    });
  };
};

/** A marker's place among its source's markers, in reading order. */
export const placeOf = (
  marks: Marks,
  number: number,
  element: HTMLElement | null
) => {
  const all = (marks.get(number) ?? []).toSorted((a, b) =>
    // Two markers never hold one another, so b either follows a or comes before it.
    a.compareDocumentPosition(b) === Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1
  );
  return {
    index: element === null ? 0 : all.indexOf(element) + 1,
    count: all.length,
  };
};

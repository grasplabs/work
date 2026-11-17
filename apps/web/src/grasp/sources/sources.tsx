"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";

import { useWords, withGiven } from "../words/words";
import { placeOf, SourcesContext, startList } from "./context";
import type { Marks, SourcesValue } from "./context";
import type { Source, SourcesLabels } from "./types";
import { sourcesWords } from "./words";

/** Every prop a Sources takes. */
export interface SourcesProps {
  /** The sources, in the order they are numbered: the first is 1. */
  items: Source[];
  /** The answer with its markers, and the list. */
  children: ReactNode;
  /** Every word the parts show or say, in the product's language; any left out are English. */
  labels?: Partial<SourcesLabels>;
  /**
   * Runs with the source and its place in `items` (from 0) when the person opens it: presses its
   * row, or its card's link to an agent's or a workflow's run. A source with an `href` still goes
   * there; one without becomes a button that only runs this.
   */
  onOpen?: (source: Source, index: number) => void;
}

const noMarks: Marks = new Map();

/** Holds one answer's sources for its markers and its list. Renders nothing of its own. */
export const Sources = ({ items, children, labels, onOpen }: SourcesProps) => {
  // The pointer and focus each light a source; the pointer wins while it rests on one, and
  // leaving gives the light back to whatever has focus.
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const id = useId();
  // Every marker by its source, so two markers of one source get names an agent can tell apart.
  // In state, not a ref, so reading it while drawing is allowed (the React Compiler's rule).
  const [marks, setMarks] = useState<Marks>(noMarks);
  const [list, setList] = useState(startList);
  // Its words: the product's, by its catalogue, else English; the caller's `labels` still win.
  const catalogue = withGiven(useWords("sources", sourcesWords), labels ?? {});
  const value: SourcesValue = {
    sources: items,
    active: hovered ?? focused,
    setActive: (number, by) => {
      if (by === "hover") {
        setHovered(number);
      } else {
        setFocused(number);
      }
    },
    rowId: (number: number) => `${id}-source-${number}`,
    setMarks,
    place: (number, element) => placeOf(marks, number, element),
    list,
    setList,
    labels: catalogue,
    onOpen,
  };
  return <SourcesContext value={value}>{children}</SourcesContext>;
};

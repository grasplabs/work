// Scroll edges: which edges of a scroller have more beyond them, for the fade a part draws there.
// Read on scroll and whenever the scroller or what it holds changes size, and written straight onto
// the element, so a scroll never renders.
//
//   const edges = useScrollEdges();             <div ref={edges} …>  data-under-start, data-under-end
//   const edges = useScrollEdges({ axis: "block", onChange: (found, element) => … });
"use client";

import type { RefCallback } from "react";

import { nothing } from "../lib/utils";

/** Which edges have more beyond them, and whether there is anything to scroll at all. */
export interface ScrollEdges {
  /** More before it: above, or towards the line's start. */
  start: boolean;
  /** More after it: below, or towards the line's end. */
  end: boolean;
  /** What it holds is larger than it, along the axis. */
  overflows: boolean;
}

/** The way it scrolls: along the line (`inline`) or down the page (`block`). */
export type ScrollAxis = "inline" | "block";

/**
 * Which edges of `element` have more than `threshold` pixels beyond them, along `axis`. Right to
 * left, scrollLeft runs from 0 to minus the room, so only its size is read.
 */
export const scrollEdgesOf = (
  element: HTMLElement,
  axis: ScrollAxis = "inline",
  threshold = 1
): ScrollEdges => {
  const inline = axis === "inline";
  const room = inline
    ? element.scrollWidth - element.clientWidth
    : element.scrollHeight - element.clientHeight;
  const along = Math.abs(inline ? element.scrollLeft : element.scrollTop);
  const overflows = room > threshold;
  return {
    start: overflows && along > threshold,
    end: overflows && along < room - threshold,
    overflows,
  };
};

/** Marks the edges with more beyond them as `data-under-start` and `data-under-end`. */
export const markScrollEdges = (
  { start, end }: ScrollEdges,
  element: HTMLElement
) => {
  element.toggleAttribute("data-under-start", start);
  element.toggleAttribute("data-under-end", end);
};

/** What useScrollEdges takes. */
export interface ScrollEdgesOptions {
  /**
   * The way it scrolls.
   * @default "inline"
   */
  axis?: ScrollAxis;
  /**
   * How many pixels beyond an edge count as more.
   * @default 1
   */
  threshold?: number;
  /**
   * Runs with the edges each time they are read; by default they are marked on the element
   * (`markScrollEdges`).
   */
  onChange?: (edges: ScrollEdges, element: HTMLElement) => void;
}

/**
 * A ref for a scroller: from the moment it is on the page, which of its edges have more beyond
 * them is read on scroll and whenever it, or the first element inside it, changes size (a
 * ResizeObserver reports each box once as it starts, after layout, so mounting forces none), and
 * handed to `onChange`.
 */
export const useScrollEdges = ({
  axis = "inline",
  threshold = 1,
  onChange = markScrollEdges,
}: ScrollEdgesOptions = {}): RefCallback<HTMLElement> => {
  const watch = (element: HTMLElement | null) => {
    if (element === null) {
      return nothing;
    }
    const measure = () => {
      onChange(scrollEdgesOf(element, axis, threshold), element);
    };
    element.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild !== null) {
      observer.observe(element.firstElementChild);
    }
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure);
    };
  };
  return watch;
};

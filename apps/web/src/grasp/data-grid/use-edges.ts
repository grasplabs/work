// Whether the grid runs on under each side of its frame, and which way its text runs, kept up to
// date as it scrolls and as its box changes size: the fades at the frame's edges show by it.
"use client";

import { useEffect, useRef, useState } from "react";

const edgesOf = (element: HTMLElement) => {
  const along = Math.abs(element.scrollLeft);
  const travel = element.scrollWidth - element.clientWidth;
  return {
    start: along > 1,
    end: travel - along > 1,
    rtl: getComputedStyle(element).direction === "rtl",
  };
};

/** The scroller's ref, what runs on under its sides, and the handler that reads it on scroll. */
export const useEdges = () => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false, rtl: false });
  const read = () => {
    if (scrollerRef.current !== null) {
      setEdges(edgesOf(scrollerRef.current));
    }
  };
  useEffect(() => {
    const element = scrollerRef.current;
    const watch = new ResizeObserver(() => {
      if (element !== null) {
        setEdges(edgesOf(element));
      }
    });
    if (element !== null) {
      watch.observe(element);
      // The grid inside it changes width too, as columns are resized.
      if (element.firstElementChild !== null) {
        watch.observe(element.firstElementChild);
      }
    }
    return () => {
      watch.disconnect();
    };
  }, []);
  return { scrollerRef, edges, read };
};

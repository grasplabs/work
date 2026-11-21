// Endless loading: the mark under the last row coming into view asks for more.
"use client";

import { useEffect, useEffectEvent, useRef } from "react";

interface EndOptions {
  onEndReached: (() => void) | undefined;
  /** More can come, and none are on their way: the row is watched only then. */
  watching: boolean;
  /** The rows scroll in their own box (the table has a height), not in the page. */
  inBox: boolean;
  /** Changes as rows arrive, so the row is watched again where it now stands. */
  count: number;
}

const observe = (element: HTMLElement, inBox: boolean, reach: () => void) => {
  const root = inBox ? element.closest("[data-slot=table-container]") : null;
  const watch = new IntersectionObserver(
    ([entry]) => {
      if (entry?.isIntersecting ?? false) {
        reach();
      }
    },
    { root, rootMargin: "0px 0px 160px 0px" }
  );
  watch.observe(element);
  return () => {
    watch.disconnect();
  };
};

export const useEnd = ({
  onEndReached,
  watching,
  inBox,
  count,
}: EndOptions) => {
  const endRef = useRef<HTMLDivElement>(null);
  const reach = useEffectEvent(() => {
    onEndReached?.();
  });
  useEffect(() => {
    const element = endRef.current;
    const stop =
      element === null || !watching || count === 0
        ? undefined
        : observe(element, inBox, reach);
    return () => {
      stop?.();
    };
  }, [watching, inBox, count]);
  return endRef;
};

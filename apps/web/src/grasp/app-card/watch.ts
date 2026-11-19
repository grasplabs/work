// App card's watchers: whether a card is in view, through one IntersectionObserver for every card
// on the page (a grid of forty keeps one, not forty), and whether the reader asked for less motion.
"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/** How long a card may be out of view before its running app stops: a quick scroll past keeps it. */
export const GRACE = 300;

type Seen = (inView: boolean) => void;

let shared: IntersectionObserver | undefined;
const watched = new Map<Element, Seen>();

/** The page's one observer, made on first use. */
const observer = () => {
  shared ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      watched.get(entry.target)?.(entry.isIntersecting);
    }
  });
  return shared;
};

/** Calls `seen` whenever `box` comes into view or leaves it; the returned function stops. */
const watch = (box: Element, seen: Seen) => {
  watched.set(box, seen);
  observer().observe(box);
  return () => {
    watched.delete(box);
    shared?.unobserve(box);
  };
};

/** The cleanup of an effect that started nothing. */
const keep = () => {
  // Nothing was started, so nothing stops.
};

/**
 * Whether `box` is in view: at once when it comes in, `GRACE` after it leaves. False until it is
 * measured (on the server, and before the first frame), so nothing runs that nobody sees.
 */
export const useInView = (box: Element | null) => {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (box === null) {
      return keep;
    }
    let leaving: ReturnType<typeof setTimeout> | undefined;
    const stop = watch(box, (seen) => {
      clearTimeout(leaving);
      if (seen) {
        setInView(true);
        return;
      }
      leaving = setTimeout(() => {
        setInView(false);
      }, GRACE);
    });
    return () => {
      clearTimeout(leaving);
      stop();
    };
  }, [box]);
  return inView;
};

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
const subscribe = (change: () => void) => {
  const list = window.matchMedia(REDUCED_QUERY);
  list.addEventListener("change", change);
  return () => {
    list.removeEventListener("change", change);
  };
};
const reducedNow = () => window.matchMedia(REDUCED_QUERY).matches;
const reducedOnServer = () => false;

/** Whether the reader asked for less motion. On the server it is not known. */
export const useReducedMotion = () =>
  useSyncExternalStore(subscribe, reducedNow, reducedOnServer);

/**
 * Whether `box` (a card) is hovered or holds the focus: with reduced motion, the only time its
 * app runs. Read from the card's own events, so the card takes no handlers of its own.
 */
export const useAttention = (box: HTMLElement | null) => {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (box === null) {
      return keep;
    }
    const enter = () => {
      setHovered(true);
    };
    const leave = () => {
      setHovered(false);
    };
    const focusIn = () => {
      setFocused(true);
    };
    const focusOut = (event: FocusEvent) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !box.contains(event.relatedTarget)
      ) {
        setFocused(false);
      }
    };
    box.addEventListener("pointerenter", enter);
    box.addEventListener("pointerleave", leave);
    box.addEventListener("focusin", focusIn);
    box.addEventListener("focusout", focusOut);
    return () => {
      box.removeEventListener("pointerenter", enter);
      box.removeEventListener("pointerleave", leave);
      box.removeEventListener("focusin", focusIn);
      box.removeEventListener("focusout", focusOut);
    };
  }, [box]);
  return hovered || focused;
};

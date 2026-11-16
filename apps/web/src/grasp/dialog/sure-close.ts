// A close that always ends. UI SDK takes a panel away once every animation in it has finished; one
// that cannot finish (Firefox runs the body's scroll-driven hairlines as an animation that never
// ends) would leave the panel and its shade over the page, catching every press. So once the panel
// starts to leave, it gets its leave time and a margin, and then whatever still runs in it is
// cancelled, which lets the close complete.
"use client";

const MARGIN = 250;

/** Milliseconds from a computed list of times ("0.2s, 150ms"); one that cannot be read is 0. */
const times = (value: string) =>
  value.split(",").map((part) => {
    // A computed time is in seconds ("0.2s"), or in milliseconds ("200ms").
    const text = part.trim();
    const time = text.endsWith("ms")
      ? Number(text.slice(0, -2))
      : Number(text.slice(0, -1)) * 1000;
    return Number.isNaN(time) ? 0 : time;
  });

const leaveTime = (element: Element) => {
  const style = getComputedStyle(element);
  const durations = times(style.transitionDuration);
  const delays = times(style.transitionDelay);
  return Math.max(
    0,
    ...durations.map(
      (duration, index) => duration + (delays[index % delays.length] ?? 0)
    )
  );
};

const leaving = (element: HTMLElement) =>
  element.dataset.endingStyle !== undefined;

/** Watches a panel: once it starts to leave, whatever still runs in it after its leave time and a
 * margin is cancelled. Returns the clean-up. */
const watchClose = (element: HTMLElement) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watch = () => {
    clearTimeout(timer);
    if (!leaving(element)) {
      return;
    }
    timer = setTimeout(
      () => {
        if (!leaving(element)) {
          return;
        }
        for (const animation of element.getAnimations({ subtree: true })) {
          animation.cancel();
        }
      },
      leaveTime(element) + MARGIN
    );
  };
  const observer = new MutationObserver(watch);
  observer.observe(element, {
    attributes: true,
    attributeFilter: ["data-ending-style"],
  });
  // Attached again while it already leaves: the wait starts now.
  watch();
  return () => {
    observer.disconnect();
    clearTimeout(timer);
  };
};

/** A ref for a panel: its close finishes at the latest a little after its leave time. One function
 * for every panel, so React attaches it once per element. */
export const sureClose = (element: HTMLElement | null) =>
  element === null ? undefined : watchClose(element);

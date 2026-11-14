// The light that crosses a dot-field Skeleton (skeleton.tsx, `look` other than `grey`). One clock
// for the whole page: every placeholder's band runs on the document timeline from its origin, offset
// by where the placeholder stands, so a wave passes across a table or a grid of cards as one field
// behind many windows rather than each cell blinking alone. Transform only. It stops while the
// placeholder is off screen, never runs with reduced motion, and runs the other way right to left.
// Module-level, so the component itself only starts and stops it from an effect.

/** How fast the light travels, in pixels a second: slow enough to read as light, not a flash. */
const SPEED = 520;
/** The share of a pass the light rests before the next one. */
const REST = 0.2;
/** How far the wave is from upright: a placeholder lower on the page is reached this much later. */
const SLOPE = 0.6;
/** For the lines look: a line lower down waits for the one above, as if being written. */
const LINES_SLOPE = 3;

export type FieldLook = "field" | "resolve" | "lines";

/** Nothing to stop: the light never started. */
export const noop = (): void => {
  // Nothing was started, so there is nothing to stop.
};

/** Starts the light in one placeholder; returns what stops it. */
export const lightUp = (
  field: HTMLElement,
  band: HTMLElement,
  look: FieldLook
): (() => void) => {
  if (typeof window === "undefined" || typeof band.animate !== "function") {
    return noop;
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return noop;
  }
  const rect = field.getBoundingClientRect();
  // The band's width is its style's (skeleton.tsx, `band`).
  const BAND = band.offsetWidth;
  const page = document.documentElement.clientWidth;
  const rtl = getComputedStyle(field).direction === "rtl";
  // Where the placeholder stands on the page, from the edge the wave starts at.
  const fromStart = rtl
    ? page - rect.right - window.scrollX
    : rect.left + window.scrollX;
  const top = rect.top + window.scrollY;
  const slope = look === "lines" ? LINES_SLOPE : SLOPE;
  const offset = fromStart + top * slope;
  // The wave's path: across the page and down its first screens, the same for every placeholder.
  const sweep = page + window.innerHeight * slope + BAND;
  // The band's start edge, from the placeholder's start edge, at the start and end of a pass.
  const from = -BAND - offset;
  const to = sweep - BAND - offset;
  const at = (start: number) => (rtl ? rect.width - BAND - start : start);
  const motion = band.animate(
    [
      { transform: `translateX(${at(from)}px)` },
      { transform: `translateX(${at(to)}px)`, offset: 1 - REST },
      { transform: `translateX(${at(to)}px)` },
    ],
    {
      duration: (sweep / SPEED / (1 - REST)) * 1000,
      iterations: Number.POSITIVE_INFINITY,
      easing: "linear",
    }
  );
  // On the page's clock, so every placeholder is in step.
  motion.startTime = 0;
  const watch = new IntersectionObserver(([entry]) => {
    if (entry?.isIntersecting === true) {
      motion.play();
      motion.startTime = 0;
    } else {
      motion.pause();
    }
  });
  watch.observe(field);
  return () => {
    watch.disconnect();
    motion.cancel();
  };
};

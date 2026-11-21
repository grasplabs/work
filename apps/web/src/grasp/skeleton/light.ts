// The light that crosses a dot-field Skeleton (skeleton.tsx, the `field` look). One clock
// for the whole page: every placeholder's band runs on the document timeline from its origin, offset
// by where the placeholder stands, so a wave passes across a table or a grid of cards as one field
// behind many windows rather than each cell blinking alone. The wave repeats every screen's height
// down the page, so a placeholder far down a long list is lit as well. Transform only.
//
// It is measured when the placeholder comes into view and again when the window or the page changes
// size, so it
// stays in step when content above it loads, after a hidden panel opens, or after a resize. It
// pauses while the placeholder is off screen, never runs with reduced motion or in forced colours
// (and follows either if it changes while the page is open), and runs the other way right to left.
// Module-level, so the component itself only starts and stops it from an effect.

/** How fast the light travels, in pixels a second: slow enough to read as light, not a flash. */
const SPEED = 520;
/** The share of a pass the light rests before the next one. */
const REST = 0.2;
/** How far the wave is from upright: a placeholder lower on the page is reached this much later. */
const SLOPE = 0.6;
/** What a light that never started stops. */
export const stopNothing = () => {
  // No light was started: nothing to stop.
};

/** The keyframes and length of one pass, for a placeholder where it stands now; null if unseen. */
const passFor = (field: HTMLElement, band: HTMLElement) => {
  const rect = field.getBoundingClientRect();
  const width = band.offsetWidth;
  if (rect.width === 0 || rect.height === 0 || width === 0) {
    return null;
  }
  const page = document.documentElement.clientWidth;
  const screen = window.innerHeight;
  const rtl = getComputedStyle(field).direction === "rtl";
  // Where the placeholder stands, from the edge the wave starts at; down the page the wave repeats
  // every screen's height, so it reaches everything.
  const fromStart = rtl
    ? page - rect.right - window.scrollX
    : rect.left + window.scrollX;
  const down = ((rect.top + window.scrollY) % screen) * SLOPE;
  const offset = fromStart + down;
  // The wave's path: across the page and down one screen, the same for every placeholder.
  const sweep = page + screen * SLOPE + width;
  const from = -width - offset;
  const to = sweep - width - offset;
  const at = (start: number) => (rtl ? rect.width - width - start : start);
  return {
    frames: [
      { transform: `translateX(${at(from)}px)` },
      { transform: `translateX(${at(to)}px)`, offset: 1 - REST },
      { transform: `translateX(${at(to)}px)` },
    ],
    duration: (sweep / SPEED / (1 - REST)) * 1000,
  };
};

/** Starts the light in one placeholder; returns what stops it. */
export const lightUp = (
  field: HTMLElement,
  band: HTMLElement
): (() => void) => {
  if (typeof window === "undefined" || typeof band.animate !== "function") {
    return stopNothing;
  }
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  const forced = window.matchMedia("(forced-colors: active)");
  let motion: Animation | null = null;
  let seen = false;

  const stop = () => {
    motion?.cancel();
    motion = null;
  };
  // Measures afresh and starts on the page's clock, so every placeholder is in step.
  const start = () => {
    stop();
    if (!seen || still.matches || forced.matches) {
      return;
    }
    const pass = passFor(field, band);
    if (pass === null) {
      return;
    }
    motion = band.animate(pass.frames, {
      duration: pass.duration,
      iterations: Number.POSITIVE_INFINITY,
      easing: "linear",
    });
    motion.startTime = 0;
  };

  const watch = new IntersectionObserver((entries) => {
    // The last word on whether it is in view: a quick exit and return come in one batch.
    const last = entries.at(-1);
    if (last === undefined) {
      return;
    }
    seen = last.isIntersecting;
    if (seen) {
      start();
    } else {
      motion?.pause();
    }
  });
  watch.observe(field);
  // Content arriving above moves it down the page: measure again when the page changes size.
  const page =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(start);
  page?.observe(document.body);
  window.addEventListener("resize", start);
  still.addEventListener("change", start);
  forced.addEventListener("change", start);
  return () => {
    watch.disconnect();
    page?.disconnect();
    window.removeEventListener("resize", start);
    still.removeEventListener("change", start);
    forced.removeEventListener("change", start);
    stop();
  };
};

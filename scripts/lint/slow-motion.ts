/**
 * Grasp answers within 300 ms (AGENTS.md, Design): a hover or a check in
 * 100 to 150, a menu or a tooltip in 150 to 250, a dialog, a drawer or a
 * panel in 200 to 300. This finds a duration over that in a class list
 * (Tailwind's `duration-*`), unless the same classes loop: work still
 * going on runs as long as it goes on, and one round of it is not a wait.
 * A duration worked out with `calc()` counts as its longest time in it,
 * which is what it comes to at most.
 */
export const LIMIT_MS = 300;

const tailwindDuration = /(?:^|[\s:])duration-(?<ms>\d+)(?=\s|$)/gu;
const tailwindArbitrary = /(?:^|[\s:])duration-\[(?<value>[^\]\s]+)\]/gu;
const time = /(?<value>\d*\.?\d+)(?<unit>ms|s)\b/gu;
const loops = /\banimate-(?:spin|pulse|ping|bounce|caret-blink)\b/u;

/** A time written with its unit, in ms. */
const inMs = (value: string, unit: string): number =>
  unit === "s" ? Number(value) * 1000 : Number(value);

/** The longest time an arbitrary value (`0.35s`, `calc(… * 400ms)`) comes to, in ms. */
const longestIn = (value: string): number =>
  Math.max(
    0,
    ...[...value.matchAll(time)].map((match) =>
      inMs(match.groups?.value ?? "0", match.groups?.unit ?? "ms")
    )
  );

/** The first duration over the limit a class list sets, in ms, if any. */
export const findSlowClass = (classes: string): number | undefined => {
  if (loops.test(classes)) {
    return undefined;
  }
  const found = [
    ...[...classes.matchAll(tailwindDuration)].map((match) =>
      Number(match.groups?.ms)
    ),
    ...[...classes.matchAll(tailwindArbitrary)].map((match) =>
      longestIn(match.groups?.value ?? "")
    ),
  ];
  return found.find((ms) => ms > LIMIT_MS);
};

/** The unit a number of a motion option is in: Motion's are seconds, the Web Animations API's milliseconds. */
export type MotionUnit = "s" | "ms";

/** A motion option's duration, in ms. */
export const durationMs = (value: number, unit: MotionUnit): number =>
  unit === "s" ? value * 1000 : value;

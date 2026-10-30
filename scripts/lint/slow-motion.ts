/**
 * Grasp answers within 300 ms (AGENTS.md, Design): a hover or a check in
 * 100 to 150, a menu or a tooltip in 150 to 250, a dialog, a drawer or a
 * panel in 200 to 300. These find a duration over that in a class list
 * (Tailwind's `duration-*`) or in a Motion option (`duration`), unless the
 * same classes loop: work still going on runs as long as it goes on, and
 * one round of it is not a wait.
 */
export const LIMIT_MS = 300;

const tailwindDuration = /(?:^|[\s:])duration-(?<ms>\d+)(?=\s|$)/gu;
const tailwindArbitrary =
  /(?:^|[\s:])duration-\[(?<value>\d*\.?\d+)(?<unit>m?s)\]/gu;
const loops = /\banimate-(?:spin|pulse|ping|bounce|caret-blink)\b/u;

const inMs = (value: string, unit: string | undefined): number =>
  unit === "s" ? Number(value) * 1000 : Number(value);

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
      inMs(match.groups?.value ?? "0", match.groups?.unit)
    ),
  ];
  return found.find((ms) => ms > LIMIT_MS);
};

/**
 * A Motion `duration` in ms: Motion's is in seconds, the Web Animations
 * API's in milliseconds, and no answer is 20 seconds long.
 */
export const motionMs = (value: number): number =>
  value < 20 ? value * 1000 : value;

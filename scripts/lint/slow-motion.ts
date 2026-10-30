import { transform } from "lightningcss";

/**
 * Grasp answers within 300 ms (AGENTS.md, Design): a hover or a check in
 * 100 to 150, a menu or a tooltip in 150 to 250, a dialog, a drawer or a
 * panel in 200 to 300. This finds a duration over that in a class list
 * (Tailwind's `duration-*`), unless the same classes loop: work still
 * going on runs as long as it goes on, and one round of it is not a wait.
 *
 * An arbitrary duration (`duration-[…]`) is worked out as CSS works it
 * out, by Lightning CSS, the parser Vite and Tailwind build with: `0.35s`,
 * `calc(2*200ms)` and `calc(1s - 700ms)` come to one time. One that comes
 * to no time of its own, such as `calc(var(--strength)*400ms)`, can't be
 * read, and says so.
 */
export const LIMIT_MS = 300;

const tailwindDuration = /(?:^|[\s:])duration-(?<ms>\d+)(?=\s|$)/gu;
const tailwindArbitrary = /(?:^|[\s:])duration-\[(?<value>[^\]\s]+)\]/gu;
const loops = /\banimate-(?:spin|pulse|ping|bounce|caret-blink)\b/u;
/** One time, as Lightning CSS writes a duration it has worked out. */
const oneTime = /transition-duration:(?<value>\d*\.?\d+)(?<unit>ms|s)\}/u;

/** What a class list's duration comes to: a time in ms, or a value that comes to no time. */
export type Duration = { ms: number } | { unread: string };

/**
 * An arbitrary value as a duration: Tailwind writes a space as `_`, and
 * Lightning CSS works the value out as a browser would.
 */
const resolved = (value: string): Duration => {
  const css = value.replaceAll("_", " ");
  try {
    const { code } = transform({
      filename: "duration.css",
      code: Buffer.from(`a{transition-duration:${css}}`),
      minify: true,
    });
    const groups = oneTime.exec(code.toString())?.groups;
    if (groups?.value !== undefined && groups.unit !== undefined) {
      const ms = Number(groups.value) * (groups.unit === "s" ? 1000 : 1);
      return { ms: Math.round(ms) };
    }
  } catch {
    // Not CSS at all: no time either.
  }
  return { unread: value };
};

/**
 * The first duration a class list sets that is over the limit, or that
 * comes to no time it can read, if any.
 */
export const findSlowClass = (classes: string): Duration | undefined => {
  if (loops.test(classes)) {
    return undefined;
  }
  const found: Duration[] = [
    ...[...classes.matchAll(tailwindDuration)].map((match) => ({
      ms: Number(match.groups?.ms),
    })),
    ...[...classes.matchAll(tailwindArbitrary)].map((match) =>
      resolved(match.groups?.value ?? "")
    ),
  ];
  return found.find((each) => !("ms" in each) || each.ms > LIMIT_MS);
};

/** The unit a number of a motion option is in: Motion's are seconds, the Web Animations API's milliseconds. */
export type MotionUnit = "s" | "ms";

/** A motion option's duration, in ms. */
export const durationMs = (value: number, unit: MotionUnit): number =>
  unit === "s" ? value * 1000 : value;

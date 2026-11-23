// What PromptInput's length limit (prompt-input.tsx) does to the text, pure, so it is tested without
// a page (scripts/prompt-input-limit.test.ts): how near the limit a length is, and, for a change
// that would run past it, the range it replaced and what of it fits there. The editor counts a
// character as one UTF-16 unit and a token as one place; the limit counts a token as its label.
import type { Token, TokenInputValue } from "@ui-sdk/react/token-input";

/** How near the limit a length is: under 90% of it, near it, or at it. */
export type LimitStage = "under" | "near" | "at";

/** How near `max` the length is: from 90% near, from `max` at. */
export const stageOf = (length: number, max: number): LimitStage => {
  if (length >= max) {
    return "at";
  }
  return length >= Math.ceil(max * 0.9) ? "near" : "under";
};

/** One place in the value, as the editor counts them: a character (a UTF-16 unit) or a token. */
type Unit = string | Token;

const unitsOf = (value: TokenInputValue): Unit[] => {
  const units: Unit[] = [];
  for (const segment of value) {
    if (typeof segment === "string") {
      // By UTF-16 unit, as the editor counts: not by code point.
      for (let at = 0; at < segment.length; at += 1) {
        units.push(segment.charAt(at));
      }
    } else {
      units.push(segment);
    }
  }
  return units;
};

const sameUnit = (a: Unit | undefined, b: Unit | undefined) =>
  typeof a === "object" && typeof b === "object" ? a.id === b.id : a === b;

/** How much of the limit units take: a character one, a token its label. */
const widthOf = (units: readonly Unit[]) => {
  let width = 0;
  for (const unit of units) {
    width += typeof unit === "string" ? 1 : unit.label.length;
  }
  return width;
};

/** Units back into a value, the characters joined. */
const valueOf = (units: readonly Unit[]): TokenInputValue => {
  const value: TokenInputValue = [];
  for (const unit of units) {
    const last = value.at(-1);
    if (typeof unit === "string" && typeof last === "string") {
      value[value.length - 1] = last + unit;
    } else {
      value.push(unit);
    }
  }
  return value;
};

/**
 * What a change did, from the units before and after it: the range it replaced (between what the
 * two share at the start and at the end), what was there, and what it put in.
 */
const changeOf = (old: readonly Unit[], next: readonly Unit[]) => {
  let start = 0;
  while (
    start < old.length &&
    start < next.length &&
    sameUnit(old[start], next[start])
  ) {
    start += 1;
  }
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    sameUnit(old.at(-1 - end), next.at(-1 - end))
  ) {
    end += 1;
  }
  return {
    range: { start, end: old.length - end },
    removed: old.slice(start, old.length - end),
    added: next.slice(start, next.length - end),
  };
};

/** As much of `units` as `room` holds, from the start: a token whole or not at all. */
const fitting = (units: readonly Unit[], room: number): Unit[] => {
  const kept: Unit[] = [];
  let used = 0;
  for (const unit of units) {
    used += widthOf([unit]);
    if (used > room) {
      break;
    }
    kept.push(unit);
  }
  // Half a character (an emoji's first unit) is no character.
  const last = kept.at(-1);
  if (typeof last === "string" && /[\uD800-\uDBFF]/u.test(last)) {
    kept.pop();
  }
  return kept;
};

/** What fits of a change too long, and where it goes. */
export interface Refit {
  /** The range the change replaced, in the value before it, in the editor's places. */
  at: { start: number; end: number };
  /** What of the change fits there; empty when nothing does. */
  fits: TokenInputValue;
  /** More than one character was added at once (a paste, a drop, a mention), and that was cut. */
  cut: boolean;
}

/**
 * For a change from `before` to `after` that runs past `max`: the range it replaced, what of what it
 * put in fits in the room left once what it replaced is gone, and whether that is a cut to say.
 */
export const refitOf = (
  before: TokenInputValue,
  after: TokenInputValue,
  max: number
): Refit => {
  const old = unitsOf(before);
  const { range, removed, added } = changeOf(old, unitsOf(after));
  const room = max - (widthOf(old) - widthOf(removed));
  return {
    at: range,
    fits: valueOf(fitting(added, room)),
    cut: widthOf(added) > 1,
  };
};

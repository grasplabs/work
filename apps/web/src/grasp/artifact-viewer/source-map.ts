// Rendered words back to their source. A Markdown text node's words are not always a plain slice
// of the source: a quote's second line drops its "> ", a list item's next line its indent, an
// entity (`&amp;`) is one character, an escape (`\*`) loses its backslash. Each rendered character
// is matched to its source character, walking both together, and the result is kept short: where
// the gap between them changes ("shifts"). A character that cannot be matched keeps the last good
// place: clamped, never shifted.

/** From rendered index `index` on, a character's source offset is `start + index + extra`. */
export type Shifts = [index: number, extra: number][];

const ENTITY = /^&(?:#\d{1,7}|#x[\da-f]{1,6}|[a-z][a-z\d]{1,31});/iu;
/** How far ahead markup can sit between two rendered characters: "\n> " or a list's indent. */
const MARKUP = 8;

/**
 * Where the rendered `value` lies in `source` between `start` and `end`. Null when it is a plain
 * slice there (most text); otherwise the shifts.
 */
export const shiftsOf = (
  value: string,
  source: string,
  start: number,
  end: number
): { start: number; shifts: Shifts | null } => {
  if (source.slice(start, start + value.length) === value) {
    return { start, shifts: null };
  }
  // A code block's or inline code's words, after their fence or backticks: plain from there.
  const at = source.indexOf(value, start);
  if (at !== -1 && at + value.length <= end) {
    return { start: at, shifts: null };
  }
  const shifts: Shifts = [];
  let extra = 0;
  let p = start;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    let place = p;
    if (source[p] === character) {
      p += 1;
    } else {
      const entity =
        source[p] === "&" ? ENTITY.exec(source.slice(p, p + 40)) : null;
      const ahead = source.indexOf(character, p);
      if (entity) {
        p += entity[0].length;
      } else if (ahead !== -1 && ahead - p <= MARKUP && ahead < end) {
        place = ahead;
        p = ahead + 1;
      }
      // Otherwise: no match nearby, so it stays where the last character left off.
    }
    const now = place - start - index;
    if (now !== extra || (!shifts.length && now !== 0)) {
      shifts.push([index, now]);
      extra = now;
    }
  }
  return { start, shifts };
};

/** The shifts as an attribute: "3:2;10:4". */
export const writeShifts = (shifts: Shifts) =>
  shifts.map(([index, extra]) => `${index}:${extra}`).join(";");
// One "index:extra" pair; a missing half reads as NaN, as `Number` reads anything not a number.
const readShift = (pair: string): [number, number] => {
  const [index, extra] = pair.split(":");
  return [Number(index), Number(extra)];
};
export const readShifts = (text: string | undefined): Shifts =>
  text !== undefined && text !== "" ? text.split(";").map(readShift) : [];

const extraAt = (shifts: Shifts, index: number) => {
  let extra = 0;
  for (const [from, value] of shifts) {
    if (from > index) {
      break;
    }
    extra = value;
  }
  return extra;
};

/** The source offset of rendered index `index`. */
export const toSource = (start: number, shifts: Shifts, index: number) =>
  start + index + extraAt(shifts, index);

/** The rendered index of source offset `offset`: the last character at or before it. */
export const toRendered = (
  start: number,
  shifts: Shifts,
  offset: number,
  length: number
) => {
  for (let k = shifts.length - 1; k >= -1; k -= 1) {
    // Before the first shift (k is -1), nothing is shifted.
    const shift = shifts[k];
    const from = shift?.[0] ?? 0;
    const extra = shift?.[1] ?? 0;
    const index = offset - start - extra;
    if (index >= from) {
      return Math.min(length, index);
    }
  }
  return 0;
};

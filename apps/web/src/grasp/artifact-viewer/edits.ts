// Edits, as plain data: a patch on the source (where, what was there, what goes there), and the
// small pieces of reading a table's source a cell's edit needs. Pure functions: the viewer and its
// checks use the same code.
import { quoteOf, resolveText } from "./anchor";
import type { Anchor, Quote } from "./anchor";

/** One change to the source: what `onEdit` hands the caller, to apply and pass the new source back. */
export interface EditPatch {
  /** The proposal it comes from; an undo or a redo keeps the proposal's id. */
  proposalId: string;
  /** The comment thread it answers, if any. */
  threadId?: string;
  /** What it holds on to: words of the text, or a table's cell. */
  anchor: Anchor;
  /** Where, in the source as it is now: offsets, end excluded. */
  range: { start: number; end: number };
  /** The source's words there now, and what replaces them. */
  before: string;
  after: string;
  /** Why it happens: a person's accept, an agent allowed to apply, an undo or a redo. */
  reason: "accept" | "apply" | "undo" | "redo";
}

/**
 * Where the words an edit put in stand, so an undo can find them again: their quote in the source
 * as the edit leaves it. Words taken out and nothing put in leave an empty quote, found by the words
 * around it.
 */
export const leftBy = (
  source: string,
  patch: { range: { start: number; end: number }; after: string }
): { quote: Quote; position: { start: number; end: number } } => {
  const next =
    source.slice(0, patch.range.start) +
    patch.after +
    source.slice(patch.range.end);
  const end = patch.range.start + patch.after.length;
  return {
    quote: quoteOf(next, patch.range.start, end),
    position: { start: patch.range.start, end },
  };
};

/** Finds the words an edit left, in the source as it is now: by their quote, or, for nothing, by the words around them. */
export const findLeft = (
  left: { quote: Quote; position: { start: number; end: number } },
  source: string
) => {
  if (left.quote.exact) {
    const found = resolveText(left, source);
    return found && source.slice(found.start, found.end) === left.quote.exact
      ? { start: found.start, end: found.end }
      : null;
  }
  const meeting = left.quote.prefix + left.quote.suffix;
  if (
    source.slice(
      left.position.start - left.quote.prefix.length,
      left.position.start + left.quote.suffix.length
    ) === meeting
  ) {
    return { start: left.position.start, end: left.position.start };
  }
  const at = meeting ? source.indexOf(meeting) : -1;
  if (at < 0 || source.includes(meeting, at + 1)) {
    return null;
  }
  const point = at + left.quote.prefix.length;
  return { start: point, end: point };
};

/** A cell's value as the source writes it: quoted when it holds the delimiter, a quote or a line break. */
export const writeCell = (value: string, delimiter: string) =>
  value.includes(delimiter) || /["\r\n]/u.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;

/** A cell's value from its source text: unquoted, its doubled quotes made single, as Papa Parse reads it. */
export const readCell = (raw: string) =>
  raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
    ? raw.slice(1, -1).replaceAll('""', '"')
    : raw;

/**
 * Where one cell stands in a row of a CSV or TSV source, given where the row starts and ends (from
 * the same parse the table is drawn from, so the two agree): the row's fields split at the
 * delimiter, a quoted field read whole. Null when the row has no such column.
 */
export const cellRangeIn = (
  source: string,
  delimiter: string,
  rowStart: number,
  rowEnd: number,
  column: number
): { start: number; end: number } | null => {
  let cell = 0;
  let fieldStart = rowStart;
  let quoted = false;
  for (let at = rowStart; at <= rowEnd; at += 1) {
    const character = source[at];
    if (quoted) {
      if (at === rowEnd) {
        break;
      }
      if (character === '"') {
        if (source[at + 1] === '"') {
          at += 1;
        } else {
          quoted = false;
        }
      }
      continue;
    }
    if (at < rowEnd && character === '"' && at === fieldStart) {
      quoted = true;
      continue;
    }
    if (at === rowEnd || character === delimiter) {
      if (cell === column) {
        return { start: fieldStart, end: at };
      }
      cell += 1;
      fieldStart = at + 1;
    }
  }
  return null;
};

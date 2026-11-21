// Anchors: what a comment holds on to, so it still finds its place after the file changes. Modelled
// on the W3C Web Annotation selectors: a text quote (the words, with a little before and after) and
// a text position (where they start and end). Pure functions, no DOM: the viewer and its checks use
// the same code.
//
//   text   a range of the source text (Markdown, code, plain text, a web page's source)
//   pdf    a range of one page's text, as PDF.js reads it
//   cell   one cell of a table: its row's key and its column
//   rect   a box on an image, in fractions of the image's size

/** The words, and enough of the words around them to tell one place from another. */
export interface Quote {
  exact: string;
  prefix: string;
  suffix: string;
}

/** Where the words were, as offsets into the text, end excluded. */
export interface TextPosition {
  start: number;
  end: number;
}

export interface TextAnchor {
  kind: "text";
  quote: Quote;
  position: TextPosition;
}

export interface PdfAnchor {
  kind: "pdf";
  /** The page, counted from 0. */
  page: number;
  quote: Quote;
  position: TextPosition;
}

export interface CellAnchor {
  kind: "cell";
  /** The row's key: its number among the data rows (from 1), unless the viewer is given `rowKey`. */
  row: string;
  /** The column, counted from 0, and its name in the head, which is tried first. */
  column: number;
  header?: string;
  /** The cell's text when the comment was made. */
  quote?: string;
}

export interface RectAnchor {
  kind: "rect";
  /** The box, each a fraction (0 to 1) of the image's natural width or height. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Anchor = TextAnchor | PdfAnchor | CellAnchor | RectAnchor;

/** How many characters of context a quote keeps on each side. */
export const CONTEXT = 32;
/** The longest quote a fuzzy match is tried for; longer quotes match exactly or not at all. */
const FUZZY_LONGEST = 400;
/** The shortest quote a fuzzy match is tried for: a short word close to another is a guess. */
const FUZZY_SHORTEST = 12;
/** How far from its old place a fuzzy match is looked for, in characters. */
const FUZZY_REACH = 6000;
/** The share of a quote that may have changed for a fuzzy match to count. */
const FUZZY_SHARE = 0.25;
/** How much of the words before or after must still match for words found elsewhere to count. */
const CONTEXT_AGREES = 0.5;
/** A quote at least this long, found once, counts wherever it is, whatever is around it. */
const LONG_QUOTE = 24;
/** The score a fuzzy match must beat: its share of edits, plus its distance, less its context. */
const FUZZY_ACCEPTS = 0.5;

/** A quote of `text` from `start` to `end`, with its context. */
export const quoteOf = (text: string, start: number, end: number): Quote => ({
  exact: text.slice(start, end),
  prefix: text.slice(Math.max(0, start - CONTEXT), start),
  suffix: text.slice(end, end + CONTEXT),
});

/** A place in `text` moved off the middle of a character written as two halves (an emoji): to its start. */
export const wholeAt = (text: string, at: number) =>
  // A code point past 0xffff starts just before: `at` falls between its two halves.
  at > 0 && (text.codePointAt(at - 1) ?? 0) > 0xff_ff ? at - 1 : at;

// The UTF-16 unit at `index`, as `charCodeAt` reads it: the first half of a character written as
// two, else the code point (NaN past the end).
const unitAt = (text: string, index: number) => {
  const point = text.codePointAt(index) ?? Number.NaN;
  return point > 0xff_ff
    ? 0xd8_00 + Math.floor((point - 0x1_00_00) / 0x4_00)
    : point;
};

/** A range of `text` widened, if it must be, to whole characters. */
export const wholeRange = (text: string, start: number, end: number) => {
  const from = wholeAt(text, start);
  const to = wholeAt(text, end);
  // An end in the middle of a character takes the whole character.
  return { start: from, end: to < end ? to + 2 : to };
};

/** A text anchor for `text` from `start` to `end`, never splitting a character. */
export const textAnchor = (
  text: string,
  start: number,
  end: number
): TextAnchor => {
  const whole = wholeRange(text, start, end);
  return {
    kind: "text",
    quote: quoteOf(text, whole.start, whole.end),
    position: whole,
  };
};

/** A PDF anchor for a page's text from `start` to `end`, never splitting a character. */
export const pdfAnchor = (
  page: number,
  text: string,
  start: number,
  end: number
): PdfAnchor => {
  const whole = wholeRange(text, start, end);
  return {
    kind: "pdf",
    page,
    quote: quoteOf(text, whole.start, whole.end),
    position: whole,
  };
};

/** How the anchor was found again: where it was, by its words, close to its words, or not at all. */
export interface Found {
  start: number;
  end: number;
  how: "position" | "quote" | "fuzzy";
}

// How many characters two strings share at their ends (a = prefix, compared from its end).
const sharedEnd = (a: string, b: string) => {
  let count = 0;
  while (
    count < a.length &&
    count < b.length &&
    a[a.length - 1 - count] === b[b.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
};
const sharedStart = (a: string, b: string) => {
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) {
    count += 1;
  }
  return count;
};

/** The edit distance between two strings (insertions, deletions and changes), up to `most`. */
const distance = (a: string, b: string, most: number) => {
  if (Math.abs(a.length - b.length) > most) {
    return most + 1;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let least = i;
    for (let j = 1; j <= b.length; j += 1) {
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      row.push(value);
      if (value < least) {
        least = value;
      }
    }
    if (least > most) {
      return most + 1;
    }
    previous = row;
  }
  return previous[b.length] ?? 0;
};

/** How many fits are checked for where they start: each check costs the quote's length squared. */
const FITS_TRIED = 10;
/** A long quote's two ends, each this long, are what a loose search looks for first. */
const CORE = 32;
/** The most a loose search may take for one comment, in milliseconds: past it, it is orphaned. */
const BUDGET = 20;

/**
 * The places a long `pattern` fits in `text`: where its first or last CORE characters stand, each
 * place checked whole within `most` edits. Null when the search ran past its budget.
 */
const cores = (
  text: string,
  pattern: string,
  most: number,
  began: number
): { start: number; end: number; cost: number }[] | null => {
  const head = pattern.slice(0, CORE);
  const tail = pattern.slice(-CORE);
  const places = new Set<number>();
  for (
    let at = text.indexOf(head);
    at !== -1 && places.size < FITS_TRIED * 2;
    at = text.indexOf(head, at + 1)
  ) {
    places.add(at);
  }
  for (
    let at = text.indexOf(tail);
    at !== -1 && places.size < FITS_TRIED * 4;
    at = text.indexOf(tail, at + 1)
  ) {
    places.add(Math.max(0, at + CORE - pattern.length));
  }
  const found: { start: number; end: number; cost: number }[] = [];
  for (const start of places) {
    if (performance.now() - began > BUDGET) {
      return null;
    }
    // The region a fit starting here would cover, give or take the edits allowed at its end.
    let best: { end: number; cost: number } | null = null;
    for (const end of [
      start + pattern.length,
      start + pattern.length - Math.floor(most / 2),
      start + pattern.length + Math.floor(most / 2),
    ]) {
      if (end <= start || end > text.length) {
        continue;
      }
      const cost = distance(text.slice(start, end), pattern, most);
      if (cost <= most && (!best || cost < best.cost)) {
        best = { end, cost };
      }
    }
    if (best) {
      found.push({ start, end: best.end, cost: best.cost });
    }
  }
  return found;
};

/**
 * Every place `pattern` fits in `text` within `most` edits: the end of each fit, by Sellers'
 * algorithm (edit distance where the fit may start anywhere), keeping each run's cheapest end; then
 * its start, by trying the starts near it.
 */
const fits = (
  text: string,
  pattern: string,
  most: number,
  began: number
): { start: number; end: number; cost: number }[] | null => {
  const m = pattern.length;
  // Two columns of the table, reused: no array is made per character of the text.
  let column = Int32Array.from({ length: m + 1 }, (_, index) => index);
  let next = new Int32Array(m + 1);
  const codes = Int32Array.from({ length: m }, (_, index) =>
    unitAt(pattern, index)
  );
  const ends: { end: number; cost: number }[] = [];
  let previous = most + 1;
  for (let j = 1; j <= text.length; j += 1) {
    // Past its budget, the search gives up: the comment is set aside, not left waiting.
    if (j % 1024 === 0 && performance.now() - began > BUDGET) {
      return null;
    }
    const code = unitAt(text, j - 1);
    next[0] = 0;
    for (let i = 1; i <= m; i += 1) {
      const change = (column[i - 1] ?? 0) + (codes[i - 1] === code ? 0 : 1);
      const add = (column[i] ?? 0) + 1;
      const drop = (next[i - 1] ?? 0) + 1;
      next[i] = Math.min(change, add, drop);
    }
    const cost = next[m] ?? 0;
    // A fit: the cheapest end of a run of ends within `most`.
    if (cost <= most) {
      const last = ends.at(-1);
      if (last && last.end === j - 1 && previous <= most) {
        if (cost < last.cost) {
          ends[ends.length - 1] = { end: j, cost };
        }
      } else {
        ends.push({ end: j, cost });
      }
    }
    previous = cost;
    [column, next] = [next, column];
  }
  // The cheapest few: in a text of near-repeats there can be thousands, and each costs a search.
  ends.sort((a, b) => a.cost - b.cost);
  return ends
    .slice(0, FITS_TRIED)
    .map(({ end }) => {
      let start = end - m;
      let cost = most + 1;
      for (
        let from = Math.max(0, end - m - most);
        from <= Math.min(end, end - m + most);
        from += 1
      ) {
        const here = distance(text.slice(from, end), pattern, most);
        if (here < cost) {
          cost = here;
          start = from;
        }
      }
      return { start, end, cost };
    })
    .filter((fit) => fit.cost <= most);
};

/** How much of the quote's context still stands around a place: the better of before and after, 0 to 1. */
const contextAt = (quote: Quote, text: string, start: number, end: number) => {
  const before = quote.prefix.length
    ? sharedEnd(
        quote.prefix,
        text.slice(Math.max(0, start - quote.prefix.length), start)
      ) / quote.prefix.length
    : 0;
  const after = quote.suffix.length
    ? sharedStart(quote.suffix, text.slice(end, end + quote.suffix.length)) /
      quote.suffix.length
    : 0;
  // At the very start or end of the text there is nothing to compare: that side agrees.
  if (!quote.prefix.length && !quote.suffix.length) {
    return 1;
  }
  return Math.max(
    quote.prefix.length ? before : 0,
    quote.suffix.length ? after : 0,
    !quote.prefix.length && start === 0 ? 1 : 0,
    !quote.suffix.length && end === text.length ? 1 : 0
  );
};

/** How much of the quote's context stands on both sides together, 0 to 1. */
const contextBoth = (
  quote: Quote,
  text: string,
  start: number,
  end: number
) => {
  const total = quote.prefix.length + quote.suffix.length;
  if (!total) {
    return 1;
  }
  const before = sharedEnd(
    quote.prefix,
    text.slice(Math.max(0, start - quote.prefix.length), start)
  );
  const after = sharedStart(
    quote.suffix,
    text.slice(end, end + quote.suffix.length)
  );
  return (before + after) / total;
};

// Step 2 of `resolveText`: the quote's exact words elsewhere, where their context still stands.
const byQuote = (
  quote: Quote,
  position: TextPosition,
  text: string
): Found | null => {
  const { exact } = quote;
  const places: number[] = [];
  for (
    let at = text.indexOf(exact);
    at !== -1 && places.length < 1000;
    at = text.indexOf(exact, at + 1)
  ) {
    places.push(at);
  }
  let best: { at: number; score: number } | null = null;
  for (const at of places) {
    const context = contextAt(quote, text, at, at + exact.length);
    const unique = places.length === 1 && exact.length >= LONG_QUOTE;
    if (context < CONTEXT_AGREES && !unique) {
      continue;
    }
    // Context weighs most; nearness breaks a tie.
    const score = context - Math.abs(at - position.start) / (text.length + 1);
    if (!best || score > best.score) {
      best = { at, score };
    }
  }
  return best
    ? { start: best.at, end: best.at + exact.length, how: "quote" }
    : null;
};

// Step 3 of `resolveText`: words close to the quote's words, near where they were.
const byLikeness = (
  quote: Quote,
  position: TextPosition,
  text: string
): Found | null => {
  const { exact } = quote;
  if (exact.length > FUZZY_LONGEST || exact.length < FUZZY_SHORTEST) {
    return null;
  }
  const most = Math.max(1, Math.floor(exact.length * FUZZY_SHARE));
  const from = Math.max(0, position.start - FUZZY_REACH);
  const to = Math.min(text.length, position.end + FUZZY_REACH);
  const began = performance.now();
  // A long quote is looked for by its two ends (each a core of CORE characters, found exactly), and
  // each place one of them points to is then checked whole: the search costs the window, not the
  // window times the quote. A short quote is looked for whole, by Sellers' algorithm.
  const candidates =
    exact.length > CORE * 2
      ? cores(text.slice(from, to), exact, most, began)
      : fits(text.slice(from, to), exact, most, began);
  if (!candidates) {
    return null;
  }
  let chosen: { start: number; end: number; score: number } | null = null;
  for (const fit of candidates) {
    const start = from + fit.start;
    const end = from + fit.end;
    const context = contextBoth(quote, text, start, end);
    // Cheaper, nearer and with more of its context: lower is better.
    const score =
      fit.cost / most +
      Math.abs(start - position.start) / FUZZY_REACH -
      context;
    if (!chosen || score < chosen.score) {
      chosen = { start, end, score };
    }
  }
  // Changed words that kept little of their context are a guess, and a guess is not a place.
  return chosen && chosen.score < FUZZY_ACCEPTS
    ? { start: chosen.start, end: chosen.end, how: "fuzzy" }
    : null;
};

/**
 * Finds a text or PDF anchor in the text as it is now. In order:
 *
 * 1. Its old position, if the words there are still its words.
 * 2. Its exact words elsewhere, where the words just before or after them still match (at least
 *    half of one side), the best match and then the nearest. A long quote (24 characters or more)
 *    found only once counts wherever it is.
 * 3. Words close to its words (no more than a quarter changed, for quotes of 12 characters or
 *    more), within 6,000 characters of where it was, scored by how close, how near and how much of
 *    their context still matches.
 *
 * Otherwise it is orphaned: null. A comment listed apart is better than one in the wrong place.
 */
export const resolveText = (
  anchor: { quote: Quote; position: TextPosition },
  text: string
): Found | null => {
  const { quote, position } = anchor;
  const { exact } = quote;
  if (!exact) {
    return null;
  }
  if (text.slice(position.start, position.end) === exact) {
    return { start: position.start, end: position.end, how: "position" };
  }
  return byQuote(quote, position, text) ?? byLikeness(quote, position, text);
};

/** A table as an anchor sees it: each row's key, the head's names, and a cell's text. */
export interface TableShape {
  keys: readonly string[];
  head: readonly string[];
  cell?: (row: number, column: number) => string;
  /** Whether the file's first row is the head, and the delimiter: to find a cell in the source. */
  headed?: boolean;
  delimiter?: string;
  /** Where a row of the file (counted with the head) starts and ends in the source. */
  rowRange?: (row: number) => { start: number; end: number } | undefined;
}

/**
 * Finds a cell anchor in a table as it is now: the row by its key (so a comment follows its row
 * when rows are sorted, if the keys come from the rows, `rowKey`), and the column by its name in
 * the head. Where the name has gone (renamed, or a column put before it) the cell's own text decides,
 * then the column's place. Rows with the same key: the one whose cell still reads the same. Returns
 * the row's and the column's index, or null when the row has gone.
 */
export const resolveCell = (
  anchor: CellAnchor,
  table: TableShape
): { row: number; column: number } | null => {
  const rows: number[] = [];
  for (
    let row = table.keys.indexOf(anchor.row);
    row !== -1;
    row = table.keys.indexOf(anchor.row, row + 1)
  ) {
    rows.push(row);
  }
  const [firstRow] = rows;
  if (firstRow === undefined) {
    return null;
  }
  const named =
    anchor.header === undefined ? -1 : table.head.indexOf(anchor.header);
  const reads = (row: number, column: number) =>
    anchor.quote !== undefined && table.cell?.(row, column) === anchor.quote;
  // The column: by name; else the one whose cell still reads the same in the first matching row;
  // else by its place.
  let column = named;
  if (column < 0) {
    for (const row of rows) {
      const found = table.head.findIndex((_, index) => reads(row, index));
      if (found !== -1) {
        column = found;
        break;
      }
    }
  }
  if (column < 0) {
    column = anchor.column < table.head.length ? anchor.column : -1;
  }
  if (column < 0) {
    return null;
  }
  const row = rows.find((candidate) => reads(candidate, column)) ?? firstRow;
  return { row, column };
};

/**
 * Finds any anchor again. `text` is the text the anchor is on (the source, or the PDF page's text);
 * `table` is the table's shape, for a cell. A box on an image always holds.
 */
export const resolveAnchor = (
  anchor: Anchor,
  { text, table }: { text?: string; table?: TableShape }
): Found | { row: number; column: number } | true | null => {
  switch (anchor.kind) {
    case "text":
    case "pdf": {
      return text === undefined ? null : resolveText(anchor, text);
    }
    case "cell": {
      return table ? resolveCell(anchor, table) : null;
    }
    case "rect": {
      return true;
    }
    default: {
      return null;
    }
  }
};

// A link holds an anchor in a few characters: the place, not the words, which the file still has.
//   t.120.164        text from 120 to 164
//   p.3.10.42        page 4, from 10 to 42
//   c.17.2           the cell in the row keyed 17, column 2; a key is escaped as a URI component,
//                    and its dots as %2E, so "A.1" is "c.A%2E1.2"
//   r.10.20.300.150  a box, in thousandths of the image

const escapeKey = (key: string) =>
  encodeURIComponent(key).replaceAll(".", "%2E");
const unescapeKey = (key: string) => {
  try {
    return decodeURIComponent(key);
  } catch {
    return null;
  }
};

/** An anchor, short enough for a link. */
export const encodeAnchor = (anchor: Anchor): string => {
  switch (anchor.kind) {
    case "text": {
      return `t.${anchor.position.start}.${anchor.position.end}`;
    }
    case "pdf": {
      return `p.${anchor.page}.${anchor.position.start}.${anchor.position.end}`;
    }
    case "cell": {
      return `c.${escapeKey(anchor.row)}.${anchor.column}`;
    }
    case "rect": {
      return `r.${[anchor.x, anchor.y, anchor.w, anchor.h].map((value) => Math.round(value * 1000)).join(".")}`;
    }
    default: {
      return "";
    }
  }
};

// Each kind of link, from its numbers, once they are known to be whole and as many as it has.
const decodeText = (
  [start = 0, end = 0]: readonly number[],
  text: string | undefined
) =>
  text !== undefined && end > start && end <= text.length
    ? textAnchor(text, start, end)
    : null;

const decodePdf = (
  [page = 0, start = 0, end = 0]: readonly number[],
  pageText: ((page: number) => string | undefined) | undefined
) => {
  const words = pageText?.(page);
  return words !== undefined && end > start && end <= words.length
    ? pdfAnchor(page, words, start, end)
    : null;
};

const decodeRect = (numbers: readonly number[]): RectAnchor | null => {
  const [x = 0, y = 0, w = 0, h = 0] = numbers.map((value) =>
    Math.min(1, value / 1000)
  );
  return w > 0 && h > 0 ? { kind: "rect", x, y, w, h } : null;
};

const decodeCell = (
  [key = ""]: readonly string[],
  column: number,
  head: readonly string[] | undefined
): CellAnchor | null => {
  const row = unescapeKey(key);
  return row === null
    ? null
    : { kind: "cell", row, column, header: head?.[column] };
};

/**
 * An anchor from a link, given the text it is on now (the words are taken from there) and the
 * table's head for a cell. Null when the link does not read as one: a link is never trusted.
 */
export const decodeAnchor = (
  code: string,
  {
    text,
    pageText,
    head,
  }: {
    text?: string;
    pageText?: (page: number) => string | undefined;
    head?: readonly string[];
  } = {}
): Anchor | null => {
  const [kind, ...parts] = code.split(".");
  // Whole numbers written plainly: no "1e3", no "0x10".
  const numbers = parts.map((part) =>
    /^\d{1,9}$/u.test(part) ? Number(part) : Number.NaN
  );
  const whole = (count: number) =>
    parts.length === count && numbers.every((value) => Number.isInteger(value));
  if (kind === "t" && whole(2)) {
    return decodeText(numbers, text);
  }
  if (kind === "p" && whole(3)) {
    return decodePdf(numbers, pageText);
  }
  const [, column = Number.NaN] = numbers;
  if (kind === "c" && parts.length === 2 && Number.isInteger(column)) {
    return decodeCell(parts, column, head);
  }
  if (kind === "r" && whole(4)) {
    return decodeRect(numbers);
  }
  return null;
};

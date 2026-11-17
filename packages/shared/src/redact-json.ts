import { redact, redactedSpans } from "./redact.ts";

// Redaction of text that holds JSON, by its values (GRA-1880), not by its
// escaped form alone: inside a JSON string a line break is the two
// characters `\n`, so `redact` over the text takes `x\nCookie:` as one
// password and leaves the next line's session ID in place.
//
// It works on the original text once, by marking what to remove, and
// never re-reads anything it wrote:
//
// - The floor, an invariant: everything `redact` removes from the whole
//   text is removed (`redactedSpans`, `redact`'s own passes), so nothing
//   here keeps what `redact` alone would have caught, however the text is
//   cut or quoted.
// - On top of it, every JSON string literal, where JSON allows one (the
//   start of the text, or after `{`, `[`, `,` or `:` and whitespace) and
//   valid by JSON's own grammar (RFC 8259 §7: no raw control character),
//   is decoded and redacted as text of its own, the same way, so gone into
//   when it holds JSON in turn; what that removes is marked back where its
//   characters stand. A quote anywhere else (an inch mark, a quoted
//   phrase over a line break) is prose, and the scan goes on past it.
// - A literal followed by `:` names a member: when `redact` takes that
//   name for a credential's (`password`, `set-cookie`, `access_token` and
//   the rest), the value after it is removed whole, whatever it is (a
//   string's text, a number, a list, an object), but `null`; a value cut
//   off before its end is removed to the end of the text.
//
// Each removed stretch becomes `[redacted]`, widened to whole escape
// sequences inside a literal, so no escape is cut in half. A text with
// nothing to remove comes back byte for byte, numbers included: nothing is
// parsed whole or written back.
//
// Not caught, as by `redact`: a credential under a name that says nothing
// (`{"type":"bearer","value":"…"}`), which needs a rule of its own
// (GRA-1881).

/** A JSON string literal at one place, by RFC 8259's grammar. */
const stringLiteralAt =
  // oxlint-disable-next-line no-control-regex -- RFC 8259 §7: a string holds none raw
  /"(?:[^"\\\u0000-\u001F]|\\(?:["\\/bfnrt]|u[\dA-Fa-f]{4}))*"/uy;

/** Whitespace, then the `:` that makes a literal a member's name. */
const memberColon = /[\t\n\r ]*:/uy;

/** JSON's whitespace. */
const jsonSpace = /[\t\n\r ]*/uy;

/** A value that is neither a string, a list nor an object, up to its end. */
const plainValue = /[^\s,\]}]+/uy;

/** What a removed stretch becomes. */
const marker = "[redacted]";

/** Where `pattern` (sticky) ends when it matches at `at`, or -1. */
const endOf = (pattern: RegExp, text: string, at: number): number => {
  pattern.lastIndex = at;
  return pattern.test(text) ? pattern.lastIndex : -1;
};

/**
 * Whether `redact` takes `name` for a credential's name: whether its own
 * named-value rule takes a probe written after it.
 */
const namesCredential = (name: string): boolean =>
  !redact(`${name}: probe`).endsWith(": probe");

/** Whether JSON allows a string literal to start at `at` of `text`. */
const literalMayStart = (text: string, at: number): boolean => {
  let before = at - 1;
  while (before >= 0 && " \t\n\r".includes(text.charAt(before))) {
    before -= 1;
  }
  return before < 0 || "{[,:".includes(text.charAt(before));
};

/**
 * Where a list or an object starting at `at` ends: after its matching
 * close, strings read by JSON's grammar on the way, or at the end of the
 * text when it is cut off.
 */
const containerEndOf = (text: string, at: number): number => {
  let depth = 0;
  for (let index = at; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === '"') {
      const end = endOf(stringLiteralAt, text, index);
      index = end === -1 ? index : end - 1;
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return text.length;
};

/**
 * A text and what it is to the whole: for each of its characters, the
 * stretch of the original text it stands for (`[starts[i], ends[i])`), as
 * a decoded string's character stands for its escape.
 */
interface Placed {
  text: string;
  starts: Int32Array;
  ends: Int32Array;
}

/** `text` as the whole: each character standing for itself. */
const placedWhole = (text: string): Placed => ({
  text,
  starts: Int32Array.from({ length: text.length }, (_, index) => index),
  ends: Int32Array.from({ length: text.length }, (_, index) => index + 1),
});

/** Marks in `removed` what characters `[from, to)` of `placed` stand for. */
const mark = (
  { starts, ends }: Placed,
  removed: Uint8Array,
  from: number,
  to: number
): void => {
  for (let index = from; index < to; index += 1) {
    removed.fill(1, starts[index] ?? 0, ends[index] ?? 0);
  }
};

/**
 * The string the literal `[start, end)` of `placed` holds, placed in the
 * whole: each decoded character at what its escape, or itself, stood for.
 * Its escapes go to `escapes` when given (a literal of the whole itself).
 */
const decodedOf = (
  placed: Placed,
  start: number,
  end: number,
  escapes?: [number, number][]
): Placed => {
  const { text } = placed;
  // SAFETY: the literal is a JSON string by the grammar that found it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const decoded = JSON.parse(text.slice(start, end)) as string;
  const starts = new Int32Array(decoded.length);
  const ends = new Int32Array(decoded.length);
  let unit = 0;
  let index = start + 1;
  while (index < end - 1) {
    let width = 1;
    if (text.charAt(index) === "\\") {
      width = text.charAt(index + 1) === "u" ? 6 : 2;
    }
    starts[unit] = placed.starts[index] ?? 0;
    ends[unit] = placed.ends[index + width - 1] ?? 0;
    if (width > 1) {
      escapes?.push([index, index + width]);
    }
    index += width;
    unit += 1;
  }
  return { text: decoded, starts, ends };
};

/**
 * Where to go on after the value following the credential's name that
 * ends at `colon`, having marked that value in `removed`.
 */
const markCredentialValue = (
  placed: Placed,
  removed: Uint8Array,
  colon: number
): number => {
  const { text } = placed;
  const valueAt = endOf(jsonSpace, text, colon);
  const first = text.charAt(valueAt);
  if (first === '"') {
    const valueEnd = endOf(stringLiteralAt, text, valueAt);
    // A string's text, its quotes kept; one cut off, to the end.
    mark(
      placed,
      removed,
      valueAt + 1,
      valueEnd === -1 ? text.length : valueEnd - 1
    );
    return valueEnd === -1 ? text.length : valueEnd;
  }
  if (first === "[" || first === "{") {
    const valueEnd = containerEndOf(text, valueAt);
    mark(placed, removed, valueAt, valueEnd);
    return valueEnd;
  }
  const valueEnd = endOf(plainValue, text, valueAt);
  if (valueEnd === -1 || text.slice(valueAt, valueEnd) === "null") {
    return colon;
  }
  mark(placed, removed, valueAt, valueEnd);
  return valueEnd;
};

/**
 * Marks in `removed` everything to remove from `placed` (above): what
 * `redact` removes from it, then, by its JSON string literals, what is to
 * remove inside each and after each credential's name.
 */
const markRemovals = (
  placed: Placed,
  removed: Uint8Array,
  escapes?: [number, number][]
): void => {
  const { text } = placed;
  for (const [from, to] of redactedSpans(text)) {
    mark(placed, removed, from, to);
  }
  let at = text.indexOf('"');
  while (at !== -1) {
    const end = literalMayStart(text, at)
      ? endOf(stringLiteralAt, text, at)
      : -1;
    let next = at + 1;
    if (end !== -1) {
      const decoded = decodedOf(placed, at, end, escapes);
      markRemovals(decoded, removed);
      const colon = endOf(memberColon, text, end);
      next =
        colon !== -1 && namesCredential(decoded.text)
          ? markCredentialValue(placed, removed, colon)
          : end;
    }
    at = text.indexOf('"', next);
  }
};

/**
 * `text` with its credentials redacted: never keeping anything `redact`
 * would remove from it, and inside every JSON string it holds as well
 * (above); byte for byte when there is nothing to remove.
 */
export const redactJsonText = (text: string): string => {
  const removed = new Uint8Array(text.length);
  const escapes: [number, number][] = [];
  markRemovals(placedWhole(text), removed, escapes);
  // No escape cut in half: its whole sequence goes with any part of it.
  for (const [from, to] of escapes) {
    if (removed.subarray(from, to).includes(1)) {
      removed.fill(1, from, to);
    }
  }
  if (!removed.includes(1)) {
    return text;
  }
  const out: string[] = [];
  let kept = 0;
  let index = 0;
  while (index < text.length) {
    if (removed[index] === 1) {
      out.push(text.slice(kept, index), marker);
      while (index < text.length && removed[index] === 1) {
        index += 1;
      }
      kept = index;
    } else {
      index += 1;
    }
  }
  out.push(text.slice(kept));
  return out.join("");
};

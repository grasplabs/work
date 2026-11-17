import { redact } from "./redact.ts";

// Redaction of text that holds JSON, by its values (GRA-1880), not by its
// escaped form: inside a JSON string a line break is the two characters
// `\n`, so `redact` over the text takes `x\nCookie:` as one password and
// leaves the next line's session ID in place.
//
// Every JSON string literal in the text, wherever it stands (a whole
// document, one of several, JSON after prose or in a code fence, JSON cut
// off), is found by JSON's own string grammar (RFC 8259 §7) and decoded
// by `JSON.parse`. A string is redacted as text of its own, and so gone
// into when it holds JSON in turn. A literal followed by `:` names a
// member: when `redact` itself takes that name for a credential's
// (`password`, `set-cookie`, `access_token` and the rest), the value after
// it is replaced whole, whatever it is (a string, a number, a list, an
// object), but `null`. A literal right after a credential's name in prose
// (`password: "…"`) is replaced as `redact` would. What lies between
// literals is redacted as `redact` does. Only what changes is rewritten:
// a text with nothing to redact comes back byte for byte, numbers
// included, and nothing is ever parsed whole or written back as JSON.
//
// Not caught, as by `redact`: a credential under a name that says nothing
// (`{"type":"bearer","value":"…"}`), which needs a rule of its own
// (GRA-1881).

/** A JSON string literal, by RFC 8259's grammar: no raw control character. */
const stringLiteral =
  // oxlint-disable-next-line no-control-regex -- RFC 8259 §7: a string holds none raw
  /"(?:[^"\\\u0000-\u001F]|\\(?:["\\/bfnrt]|u[\dA-Fa-f]{4}))*"/gu;

/** The same, at one place. */
const stringLiteralAt = new RegExp(stringLiteral.source, "uy");

/** Whitespace, then the `:` that makes a literal a member's name. */
const memberColon = /[\t\n\r ]*:/uy;

/** JSON's whitespace. */
const jsonSpace = /[\t\n\r ]*/uy;

/** A value that is neither a string, a list nor an object, up to its end. */
const plainValue = /[^\s,\]}]+/uy;

/** What a value under a credential's name becomes. */
const redactedLiteral = '"[redacted]"';

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

/**
 * Whether `redact` takes a string literal right after `before` for a
 * credential's value (`password: "…"`, `token="…"`).
 */
const assignsCredential = (before: string): boolean =>
  redact(`${before}"probe"`).endsWith(`"[redacted]"`);

/**
 * Where the JSON value starting at `at` ends, by JSON's grammar: a string
 * literal, a list or an object to its matching end (the end of the text
 * when it is cut off), or a plain value (a number, `true`, `false`).
 * `undefined` for `null` and for no value at all.
 */
const valueEndOf = (text: string, at: number): number | undefined => {
  const first = text.charAt(at);
  if (first === '"') {
    const end = endOf(stringLiteralAt, text, at);
    return end === -1 ? undefined : end;
  }
  if (first === "[" || first === "{") {
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
  }
  const end = endOf(plainValue, text, at);
  return end === -1 || text.slice(at, end) === "null" ? undefined : end;
};

/**
 * `text` with its credentials redacted, inside every JSON string it holds
 * as well as over the rest of it (above); byte for byte when it holds
 * none.
 */
export const redactJsonText = (text: string): string => {
  const out: string[] = [];
  let at = 0;
  for (const found of text.matchAll(stringLiteral)) {
    const start = found.index;
    // Inside a value already replaced whole.
    if (start < at) {
      continue;
    }
    const [literal] = found;
    const gap = text.slice(at, start);
    out.push(redact(gap));
    const end = start + literal.length;
    // SAFETY: `literal` is a JSON string by the grammar that found it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const decoded = JSON.parse(literal) as string;
    const colon = endOf(memberColon, text, end);
    if (colon !== -1) {
      const name = redact(decoded);
      out.push(
        name === decoded ? literal : JSON.stringify(name),
        text.slice(end, colon)
      );
      at = colon;
      const valueAt = endOf(jsonSpace, text, colon);
      const valueEnd = namesCredential(decoded)
        ? valueEndOf(text, valueAt)
        : undefined;
      if (valueEnd !== undefined) {
        out.push(text.slice(colon, valueAt), redactedLiteral);
        at = valueEnd;
      }
      continue;
    }
    if (assignsCredential(gap)) {
      out.push(redactedLiteral);
    } else {
      const redacted = redactJsonText(decoded);
      out.push(redacted === decoded ? literal : JSON.stringify(redacted));
    }
    at = end;
  }
  out.push(redact(text.slice(at)));
  return out.join("");
};

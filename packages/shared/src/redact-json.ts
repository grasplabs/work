import { redact } from "./redact.ts";

// Redaction of JSON text by its values (GRA-1880), not by its escaped
// form: in JSON a line break is the two characters `\n`, so `redact` over
// the text takes `x\nCookie:` as one password and leaves the next line's
// session ID in place. Here the text is parsed with the platform's JSON
// parser, `redact` runs over each decoded string value, and a member whose
// name `redact` itself treats as a credential's (`password`,
// `access_token`, `cookie` and the rest) has its value replaced, a number
// or a boolean too. Text that is not JSON is redacted as `redact` does.
//
// Not caught, as by `redact`: a credential under a name that says nothing
// (`{"type":"bearer","value":"…"}`), which needs a rule of its own.

/** What a member's value under a credential's name becomes. */
const redacted = "[redacted]";

/**
 * Whether `redact` treats `name` as a credential's name: whether its own
 * named-value rule takes a probe value written under it.
 */
const namesCredential = (name: string): boolean => {
  const written = `${JSON.stringify(name)}: probe`;
  return redact(written) !== written;
};

/** `value` with each string redacted, and each credential member's value. */
const redactedValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactedValue(item));
  }
  if (typeof value === "object" && value !== null) {
    // `Object.fromEntries` defines each member as data, a `__proto__` too.
    return Object.fromEntries(
      Object.entries(value).map(([name, member]) => [
        redact(name),
        namesCredential(name) &&
        (typeof member === "string" ||
          typeof member === "number" ||
          typeof member === "boolean")
          ? redacted
          : redactedValue(member),
      ])
    );
  }
  return value;
};

/**
 * `text` with its credentials redacted: when it is JSON, inside each of
 * its values, written back as JSON of the same shape; otherwise as
 * `redact` does. Throws when JSON nests too deep to walk.
 */
export const redactJsonText = (text: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return redact(text);
  }
  return JSON.stringify(redactedValue(parsed));
};

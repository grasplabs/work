// Credentials in text an outside system or code wrote, redacted before it
// reaches a chat, a model or a log.

/**
 * Credentials as text that could only leak through output, each with what
 * it becomes. Covered: bearer and basic authorization values; Stripe keys
 * (`sk_`, `pk_`, `rk_` live and test); `sk-`, `pk-` and `rk-` style
 * provider keys; GitHub tokens (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`,
 * `github_pat_`); Slack tokens (`xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`);
 * Google API keys (`AIza`); JSON Web Tokens; PEM private keys, an
 * unfinished block to the end of the text; AWS access key IDs; and the
 * whole value of an `api_key`, `apikey`, `token`, `secret`, `password`,
 * `passwd` or `authorization`, or of a name ending in one
 * (`access_token`, `client_secret`), written as `name=value` or
 * `name: value`: quoted, to its closing quote (or the end of the line),
 * spaces included; unquoted, to the next space or separator, with a
 * `Bearer` or `Basic` scheme of any length taken with it. JSON quoted
 * once more, as a string inside JSON (`{\"password\":\"…\"}`), is
 * caught the same way, to the escaped closing quote. Anything else
 * shaped like a secret is not caught: this is a net for what an outside
 * system's data may carry, not a guarantee (a run holds no secret of its
 * own). Applied to what streams to the chat, to what the model reads and
 * to a tool's error connect logs, over the whole text, so a credential
 * split across lines is caught.
 */
/**
 * An assignment's value as {@link credentials} redacts it: the name and
 * separator kept, the value replaced, and its quotes kept where it had
 * them.
 */
const redactedAssignment = (...args: unknown[]): string => {
  const groups: unknown = args.at(-1);
  const part = (name: string): string => {
    const value: unknown =
      typeof groups === "object" && groups !== null
        ? Reflect.get(groups, name)
        : undefined;
    return typeof value === "string" ? value : "";
  };
  const quote = part("quote") || part("escapedQuote");
  const close = part("close") || part("escapedClose");
  return `${part("name")}${part("between")}${quote}[redacted]${close}`;
};

/**
 * Known credential formats, each recognisable by its shape alone: the
 * entries of {@link credentials} that don't depend on a name before them.
 */
const credentialFormats: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
  /\b(?:bearer|basic)\s+[\w\-.~+/]{16,}=*/giu,
  /\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{10,}/gu,
  /\b(?:sk|pk|rk)-[\w-]{16,}/gu,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[0-9A-Za-z]{20,}/gu,
  /\bgithub_pat_[0-9A-Za-z_]{20,}/gu,
  /\bxox[abpr]-[0-9A-Za-z-]{10,}/gu,
  /\bAIza[0-9A-Za-z_-]{35}/gu,
  // Not a word boundary: between "-" and "e" one holds at every step of a
  // flood like "eyJ-eyJ-…", which made the match quadratic.
  /(?<![\w-])eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
];

const credentials: readonly (readonly [
  RegExp,
  string | ((...args: unknown[]) => string),
])[] = [
  ...credentialFormats.map((pattern) => [pattern, "[redacted]"] as const),
  // Each character of a quoted value is taken by one alternative only
  // (an escape, or anything but the quote, a backslash or a newline), and
  // an escaped quote's value ends at the next escaped quote: it stays
  // linear. A name's prefix (`access_`) is word characters only, so a
  // match starts once per word, not at every "-" of a flood.
  [
    /\b(?<name>\w*?(?:api[_-]?key|apikey|token|secret|passwd|password|authorization))(?<between>\\?["']?\s*[:=]\s*)(?:(?<escapedQuote>\\["'])(?:(?!\k<escapedQuote>)[^\n])*(?<escapedClose>\k<escapedQuote>)?|(?<quote>["'])(?:\\.|(?!\k<quote>)[^\\\n])*(?<close>\k<quote>)?|(?:(?:bearer|basic)\s+)?[^\s"'&,;]+)/giu,
    redactedAssignment,
  ],
];

/** `text` with every credential in it ({@link credentials}) redacted. */
export const redact = (text: string): string => {
  let redacted = text;
  for (const [pattern, replacement] of credentials) {
    redacted =
      typeof replacement === "string"
        ? redacted.replace(pattern, replacement)
        : redacted.replace(pattern, replacement);
  }
  return redacted;
};

/**
 * Whether `text` holds a credential in one of the known formats
 * ({@link credentialFormats}), whatever names it: a scan for secrets
 * written into source, never a guarantee that there are none.
 */
export const holdsKnownCredential = (text: string): boolean =>
  credentialFormats.some((pattern) => text.search(pattern) !== -1);

import { decodeHTMLAttribute } from "entities/decode";

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
 * `passwd`, `authorization`, `session` (`sessionId`, `JSESSIONID`) or
 * `cookie`, or of a name ending in one (`access_token`, `client_secret`), written as `name=value` or
 * `name: value`: quoted, to its closing quote (or the end of the line),
 * spaces included; unquoted, to the next space or separator, with a
 * `Bearer` or `Basic` scheme of any length taken with it. JSON quoted
 * once more, as a string inside JSON (`{\"password\":\"…\"}`), is
 * caught the same way, to the escaped closing quote. And in every link,
 * its parameters that sign or grant it (`redactLinks`, below). Anything else
 * shaped like a secret is not caught: this is a net for what an outside
 * system's data may carry, not a guarantee (a run holds no secret of its
 * own). Applied to what streams to the chat, to what the model reads, to
 * what the Brain keeps of a connection's reads and to a tool's error
 * connect logs, over the whole text, so a credential
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
    /\b(?<name>\w*?(?:api[_-]?key|apikey|token|secret|passwd|password|authorization|session(?:[_-]?id)?|sessid|cookie))(?<between>\\?["']?\s*[:=]\s*)(?:(?<escapedQuote>\\["'])(?:(?!\k<escapedQuote>)[^\n])*(?<escapedClose>\k<escapedQuote>)?|(?<quote>["'])(?:\\.|(?!\k<quote>)[^\\\n])*(?<close>\k<quote>)?|(?:(?:bearer|basic)\s+)?[^\s"'&,;]+)/giu,
    redactedAssignment,
  ],
];

// Signed and granting links. A link's query parameter that signs or grants
// it is redacted by its name: any name ending in `signature` (S3's
// `X-Amz-Signature`, Google Cloud Storage's `X-Goog-Signature` and V2
// `Signature`, CloudFront's), an Azure SAS's `sig`, SharePoint's
// `tempauth`, a meeting link's `pwd`, and an OAuth redirect's `code`. Each
// link is parsed, never matched by pattern: its HTML character references
// are decoded as a browser reads an `href` (`entities`, so `&amp;`,
// `&#38;`, `&#x26;`, `&#038;` and `&AMP;` all separate parameters), it is
// checked as a URL, and its query is read pair by pair; a parameter whose
// value is itself a URL (a redirect's target) is read the same way, once.
// Only the values of those parameters change, found by their offsets in
// one pass (never searched for, which a link of many pairs would make
// quadratic): a link with none comes back byte for byte as it was, one
// with some comes back as the URL standard serializes it (percent-encoded,
// so no character a reference stood for breaks out of what held the
// link), and a word outside a link (`R&D`, `code=42`) is never one. JSON escapes are not decoded: what is redacted (a tool's
// output as JSON text, a chat's text) holds `&` as itself.
// Not caught: a credential in a URL's path, and an opaque download URL
// that grants by its whole self. What is left is bounded: such text
// reaches only the person who read it (the Brain keeps a connection's
// reads for their reader alone), and connectors select the fields they
// return.

/**
 * A link: a scheme, `://`, and what may follow in a URL, up to a space or
 * a character no URL holds. A scheme is short (`https`, `ms-excel`): held
 * to 32 characters, so a flood of word characters and dashes (`sk-sk-…`),
 * tried from every word in it, never scans to its end each time, which
 * would be quadratic.
 */
const linkPattern = /\b[a-z][a-z\d+.-]{0,31}:\/\/[^\s"'<>\\^`{|}]+/giu;

/** The query parameters that sign or grant a link, by name. */
const grantingName = /^(?:[\w-]*signature|sig|code|tempauth|pwd)$/iu;

/** `component` decoded as a URL's query writes it, or itself if it isn't. */
const decoded = (component: string): string => {
  try {
    return decodeURIComponent(component.replaceAll("+", " "));
  } catch {
    return component;
  }
};

/**
 * `link` (a URL as text, its character references already decoded) with
 * the values of its granting parameters replaced with `[redacted]`, and,
 * with `nested`, a parameter whose value is itself a URL read the same way
 * once; `undefined` when it isn't a URL or nothing in it changes. Its
 * query is walked once, pair by pair, by offset: each pair ends at `&` or
 * the query's end, its name at its first `=`; only a replaced value's
 * span is written anew, every other character as it was. Linear in the
 * link, whatever its pairs hold.
 */
const redactedQuery = (link: string, nested: boolean): string | undefined => {
  // The query is what lies between the first `?` and the first `#`: a `?`
  // after the `#` is the fragment's.
  const hash = link.indexOf("#");
  const end = hash === -1 ? link.length : hash;
  const query = link.indexOf("?");
  if (query === -1 || query > end || !URL.canParse(link)) {
    return undefined;
  }
  let out = "";
  // Written up to here; the pair being read starts at `start`, its `=` at `equals`.
  let written = 0;
  let start = query + 1;
  let equals = -1;
  for (let at = start; at <= end; at += 1) {
    const char = at < end ? link[at] : "&";
    if (char === "=" && equals === -1) {
      equals = at;
    } else if (char === "&") {
      if (equals !== -1) {
        const value = link.slice(equals + 1, at);
        let to: string | undefined;
        if (grantingName.test(decoded(link.slice(start, equals)))) {
          to = "[redacted]";
        } else if (nested) {
          const inner = redactedQuery(decoded(value), false);
          to = inner === undefined ? undefined : encodeURIComponent(inner);
        }
        if (to !== undefined) {
          out += link.slice(written, equals + 1) + to;
          written = at;
        }
      }
      start = at + 1;
      equals = -1;
    }
  }
  return written === 0 ? undefined : out + link.slice(written);
};

/** A character no link holds as written: what ends one (`linkPattern`). */
const outsideLink = /[\s"'<>\\^`{|}]/gu;

/**
 * `link` (decoded, its granting values replaced) as the URL standard
 * writes it: its query by the `application/x-www-form-urlencoded`
 * serializer (every character but letters, digits and `*-._`
 * percent-encoded, so `[redacted]` reads `%5Bredacted%5D`), the whole by
 * `URL`'s `href` (its host lower-cased, an IDN as punycode, a path
 * normalised: fine for a link whose secret was just removed). What the
 * path's and the fragment's rules leave raw that no link holds (a `\` or
 * a `'`) is percent-encoded too. So a character a reference stood for
 * (`&quot;`, `&lt;`, `&#32;`, `&#92;`) never comes back raw: nothing
 * outside the link (an HTML attribute, a JSON string, a Markdown link) is
 * broken out of.
 */
const serialized = (link: string): string => {
  const url = new URL(link);
  url.search = url.searchParams.toString();
  // `encodeURIComponent` leaves `'` as it is, one of its unreserved marks.
  return url.href.replace(outsideLink, (char) =>
    char === "'" ? "%27" : encodeURIComponent(char)
  );
};

/**
 * `text` with the granting parameters of every link in it redacted: each
 * link's character references decoded as a browser reads an `href`, the
 * result parsed and only those values replaced, and written back as the
 * URL standard serializes it (`serialized`). A link with nothing to redact
 * is left exactly as it was written.
 */
const redactLinks = (text: string): string =>
  text.replace(linkPattern, (link) => {
    const redacted = redactedQuery(decodeHTMLAttribute(link), true);
    return redacted === undefined ? link : serialized(redacted);
  });

/** `text` with every credential in it ({@link credentials}) redacted. */
export const redact = (text: string): string => {
  let redacted = redactLinks(text);
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

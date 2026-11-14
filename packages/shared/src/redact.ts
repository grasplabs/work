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
 * `cookie`, or of a name ending in one (`access_token`, `client_secret`),
 * written as `name=value` or
 * `name: value`: quoted, to its closing quote (or the end of the line),
 * spaces included; unquoted, to the next space or separator, with a
 * `Bearer` or `Basic` scheme of any length taken with it; after `session`
 * or `cookie` themselves, everyday words too, only a value that looks like
 * a credential ({@link credentialLike}). JSON quoted
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

/** A character of a token: what a `Bearer` value is written in (RFC 6750). */
const tokenChar = String.raw`[\w\-.~+/]`;

/**
 * A token: 16 or more token characters, then any `=` padding. Sixteen and
 * then any more, not `{16,}`: V8 keeps each step of a counted repeat on
 * its backtrack stack, which a run of megabytes overflowed.
 */
const token = String.raw`${tokenChar}{16}${tokenChar}*=*`;

/**
 * A character of a session's value as servers write it: a token's, `%`, as
 * frameworks URL-encode their cookies (Laravel's `eyJ…%3D`, Rails'
 * `…%3D%3D--…`, express's `s%3A…`), and `*`, as an iron seal's
 * (`Fe26.2**…`, hapi's and Nuxt's) separates its parts.
 */
const sessionChar = String.raw`[\w\-.~+/%*]`;

/**
 * A name that is also an everyday word: `session` or `cookie`, alone or
 * ending a longer name (`laravel_session`, `authCookie`, "Possession"),
 * not a session id's (`sessionId`, `JSESSIONID`, `PHPSESSID`).
 */
const everydayName = /(?:session|cookie)$/iu;

/**
 * Whether a value after an {@link everydayName} looks like a credential,
 * not a word ("Session: 45 minutes"): an earlier rule already redacted
 * part of it; or, after an opening quote or backtick, it starts with
 * `name=` (a cookie string, a cookie's name being a token's characters,
 * RFC 6265) or with 16 session characters (16 hex characters are 64 bits,
 * the least a session id carries, OWASP).
 */
const credentialLike = new RegExp(
  String.raw`\[redacted\]|^(?:\\?["'\x60])?(?:${tokenChar}+=|${sessionChar}{16})`,
  "u"
);

/**
 * A named value as {@link redactedAssignment} redacts it, but a value
 * after an {@link everydayName} only when it is {@link credentialLike}:
 * otherwise the match comes back as it was. The pattern matches and takes
 * exactly what it always did; only this decides, after it.
 */
const redactedUnlessWord = (...args: unknown[]): string => {
  const [match] = args;
  const groups: unknown = args.at(-1);
  const part = (name: string): string => {
    const value: unknown =
      typeof groups === "object" && groups !== null
        ? Reflect.get(groups, name)
        : undefined;
    return typeof value === "string" ? value : "";
  };
  const name = part("name");
  const text = typeof match === "string" ? match : "";
  const value = text.slice(name.length + part("between").length);
  return everydayName.test(name) && !credentialLike.test(value)
    ? text
    : redactedAssignment(...args);
};

/**
 * Known credential formats, each recognisable by its shape alone: the
 * entries of {@link credentials} that don't depend on a name before them.
 */
const credentialFormats: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
  new RegExp(String.raw`\b(?:bearer|basic)\s+${token}`, "giu"),
  /\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{10,}/gu,
  /\b(?:sk|pk|rk)-[\w-]{16,}/gu,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[0-9A-Za-z]{20,}/gu,
  /\bgithub_pat_[0-9A-Za-z_]{20,}/gu,
  /\bxox[abpr]-[0-9A-Za-z-]{10,}/gu,
  /\bAIza[0-9A-Za-z_-]{35}/gu,
  // Not a word boundary: between "-" and "e" one holds at every step of a
  // flood like "eyJ-eyJ-…", which made the match quadratic. Any segments
  // after the third are taken too, so a JSON Web Encryption's five go
  // whole (and a sentence's closing period with them); one run, not a
  // repeated group, and eight then any more, not `{8,}`: both overflowed
  // on a run of megabytes.
  /(?<![\w-])eyJ[\w-]{8}[\w-]*\.[\w-]{8}[\w-]*\.[\w-]{8}[\w-]*[\w.-]*/gu,
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
    redactedUnlessWord,
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
// parsed by `URL`, and its query read by `URL`'s own `searchParams`; a
// parameter whose value is itself a URL (a redirect's target) is read the
// same way, once. Where a link ends is GitHub Flavored Markdown's rule as
// written (`linkEndOf`). Only the values of those parameters change: a
// link with none comes back byte for byte as it was, one with some comes
// back as the URL standard serializes it (percent-encoded, so no character
// a reference stood for breaks out of what held the link), and a word
// outside a link (`R&D`, `code=42`) is never one. JSON escapes are not
// decoded: what is redacted (a tool's output as JSON text, a chat's text)
// holds `&` as itself.
// Its user name and password (`https://u:p@h`) are redacted too.
// Not caught: a credential in a URL's path; an opaque download URL that
// grants by its whole self; a grant in a fragment other than what the
// named-value rule above catches (`#access_token=…` is; `#sig=…` and
// `#code=…` are not); a link `URL` can't parse; a link with no scheme
// (`www.…`, `//host/…`); and an AWS secret key written as
// `aws_secret_access_key = …` or bare (only its key ID, `AKIA…`, has a
// shape of its own). After `session` or `cookie`, a value the named
// rule takes is kept, as it was written, when it doesn't look like a
// credential ({@link credentialLike}), and those values are the ones left
// that were redacted before: a value under 16 characters
// (`session=9f8e7d`), and one whose first 16 characters hold one that is
// not a session character (`:`, `|`, a space, an opening curly quote or
// parenthesis among them: express's decoded `s:<id>.<sig>`, `user:42:…`,
// Bottle's `!<sig>?<data>`, `session: (…)`), as `:` would let a link
// (`Session: https://…`) count, unless a format above redacted part of it
// or it is a `name=value`. As for every name, a value ends at a separator,
// so a `Cookie:` header keeps its pairs after the first
// (`Cookie: theme=dark; sid=…`). The other way: a word of 16 or more
// session characters after them reads as a credential ("Session:
// internationalisation", "Session: kwartaalplanning": after the loanwords,
// a Dutch or German compound often is).
// Prose after the other names loses its first word ("The secret: practice
// daily", "Authorization: approved"): what follows them is a credential by
// name, a short or word-like one too. What is left is bounded: such text
// reaches only the person who read it (the Brain keeps a connection's
// reads for their reader alone), and connectors select the fields they
// return.

/**
 * A link: a scheme, `://`, and what may follow in a URL, up to a space or
 * a character no URL holds. `[` and `]` hold only an IP-literal host
 * (RFC 3986 §3.2.2: `https://[2001:db8::1]:8443/`, after any user name and
 * password), and end a link anywhere else: a Markdown link's text,
 * `[https://…](target)`, ends at its `]`. Neither `URL` nor GFM decides
 * this end: `URL` parses a path holding `](target)`, and GFM's autolink
 * ends only at a space or `<`, leaving `]` to the link text around it. A
 * scheme is short (`https`, `ms-excel`): held to 32 characters, so a flood
 * of word characters and dashes (`sk-sk-…`), tried from every word in it,
 * never scans to its end each time, which would be quadratic; a user name
 * and password stop at the first `/`, `?` or `#`, as an authority does.
 */
const linkPattern =
  /\b[a-z][a-z\d+.-]{0,31}:\/\/(?:[^\s"'<>\\^`{|}[\]/?#]*@)?(?:\[[\da-z.:%~-]{2,64}\])?[^\s"'<>\\^`{|}[\]]*/giu;

/** The query parameters that sign or grant a link, by name. */
const grantingName = /^(?:[\w-]*signature|sig|code|tempauth|pwd)$/iu;

/** Characters that end no link when they end what was found (GFM §6.9). */
const trailingPunctuation = new Set(["?", "!", ".", ",", ":", "*", "_", "~"]);

/** A letter or a digit: an entity reference's name (GFM §6.9). */
const entityNameChar = /^[a-z\d]$/iu;

/**
 * Where `found` (a link as `linkPattern` found it) ends, by GitHub
 * Flavored Markdown's extended autolink path validation (GFM spec §6.9),
 * from its end, until none applies: a trailing `?`, `!`, `.`, `,`, `:`,
 * `*`, `_` or `~` is not part of the link; a trailing `)` is not when the
 * link holds more `)` than `(`; and a trailing `;` is not, nor, when it
 * ends an entity reference (`&amp;`), is that whole reference. So the `)`
 * of `[t](https://…)` and the `.` ending a sentence stay outside the
 * link, while an `&amp;` inside its query is part of it. Quotes and `<`
 * `>` already end a link (`linkPattern`). Linear: the parentheses are
 * counted once, and each step moves the end back.
 */
const linkEndOf = (found: string): number => {
  let open = 0;
  let close = 0;
  for (const char of found) {
    if (char === "(") {
      open += 1;
    } else if (char === ")") {
      close += 1;
    }
  }
  let end = found.length;
  while (end > 0) {
    const last = found[end - 1] ?? "";
    if (trailingPunctuation.has(last)) {
      end -= 1;
    } else if (last === ")" && close > open) {
      end -= 1;
      close -= 1;
    } else if (last === ";") {
      let name = end - 1;
      while (name > 0 && entityNameChar.test(found[name - 1] ?? "")) {
        name -= 1;
      }
      end =
        name > 0 && name < end - 1 && found[name - 1] === "&"
          ? name - 1
          : end - 1;
    } else {
      break;
    }
  }
  return end;
};

/** A character no link holds as written: what ends one (`linkPattern`). */
const outsideLink = /[\s"'<>\\^`{|}]/gu;

/**
 * `url` (its granting values replaced) as the URL standard writes it: its
 * query by the `application/x-www-form-urlencoded`
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
const serialized = (url: URL): string =>
  // `encodeURIComponent` leaves `'` as it is, one of its unreserved marks.
  url.href.replace(outsideLink, (char) =>
    char === "'" ? "%27" : encodeURIComponent(char)
  );

/**
 * Sets `url`'s granting parameters to `[redacted]`, and, with `nested`, a
 * parameter whose value is itself a URL read the same way once: the
 * query as `URL`'s `searchParams` reads it (each name and value decoded,
 * every pair in order, a name given twice twice), written back by its
 * serializer only when something changed. Whether anything did.
 */
const redactParams = (url: URL, nested: boolean): boolean => {
  let changed = false;
  // A user name and password in the link itself (`https://u:p@h`).
  if (url.username !== "" || url.password !== "") {
    url.username = url.username === "" ? "" : "[redacted]";
    url.password = url.password === "" ? "" : "[redacted]";
    changed = true;
  }
  const pairs = [...url.searchParams].map(([name, value]): [string, string] => {
    if (grantingName.test(name)) {
      changed = true;
      return [name, "[redacted]"];
    }
    if (nested && URL.canParse(value)) {
      const inner = new URL(value);
      if (redactParams(inner, false)) {
        changed = true;
        return [name, inner.href];
      }
    }
    return [name, value];
  });
  if (changed) {
    url.search = new URLSearchParams(pairs).toString();
  }
  return changed;
};

/**
 * `text` with the granting parameters of every link in it redacted: each
 * link's character references decoded as a browser reads an `href`, the
 * result parsed and only those values replaced, and written back as the
 * URL standard serializes it (`serialized`). A link with nothing to redact
 * is left exactly as it was written.
 */
const redactLinks = (text: string): string =>
  text.replace(linkPattern, (found) => {
    // What ends no link stays outside it, byte for byte (`linkEndOf`).
    const end = linkEndOf(found);
    const link = decodeHTMLAttribute(found.slice(0, end));
    if (!URL.canParse(link)) {
      return found;
    }
    const url = new URL(link);
    return redactParams(url, true) ? serialized(url) + found.slice(end) : found;
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

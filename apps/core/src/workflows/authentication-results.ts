// What the receiving server found of a message's SPF, DKIM and DMARC, as
// its ARC set records it (`ARC-Authentication-Results`, RFC 8617, whose
// payload is RFC 8601's): what a reply to a run's mail carries for the
// workflow to check who sent it (`emailReplyData`, release-contracts.ts).
// Core checks none of it itself, and refuses no mail on it: it only
// reports what Email Routing found.
//
// Anyone can write these headers into a message they send, so only Email
// Routing's own ARC set is read. Email Routing seals every message it
// hands over with a set of its own, numbered past every set the message
// carries, on top of it, its results under its authserv-id
// (`trustedAuthservId`). So only the topmost ARC results header is read,
// and only when it is the message's one set at the highest instance (one
// results header, one message signature and one seal there, none
// higher: RFC 8617 4.1's complete set), its seal doesn't say
// the chain failed, its instance isn't the last there may be (50), and
// its authserv-id is Email Routing's. A sealer adds no set to a chain
// that failed or is full (RFC 8617 5.1.1), so those are what a sender
// would forge to keep Email Routing's set off the top: they report
// nothing. A plain `Authentication-Results` header is never read: Email
// Routing records its results in its ARC set, so one claiming its
// authserv-id is a sender's. Anything else (no such set, a header that
// doesn't parse) reports nothing, each method `null`: a verdict is never
// guessed. What this rests on is Email Routing sealing every message it
// hands over: one it didn't seal would show a sender's own complete set
// on top, under its authserv-id, as its own.
//
// The parser follows the RFC's grammar strictly where it decides what is
// reported (RFC 8601 2.2, RFC 8617 4.1.1, with RFC 5322's CFWS and quoted
// strings and RFC 2045's tokens): the authserv-id, each method, result
// and property name, the `;` between results. A property's value is
// taken as the grammar's quoted string, or else as any visible text up to
// the next whitespace, comment or `;`: receiving servers write values the
// grammar doesn't allow unquoted (a signature's start with `/` or `=`,
// `smtp.remote-ip=2a00:1440::32e`, `smtp.mailfrom=<>`), and a value only
// ever becomes a domain reported once it is one (`domainOf`).
//
// The trust above holds only for mail Email Routing received: an ingress
// without it in front (mail-ingress.ts) must seal mail with an ARC set of
// its own, or remove every ARC set under Email Routing's authserv-id.

/** The authserv-id Email Routing writes its results under. */
export const trustedAuthservId = "mx.cloudflare.net";

/** A result RFC 8601 2.7 names for SPF, DKIM or DMARC. */
export type MethodVerdict =
  | "pass"
  | "fail"
  | "softfail"
  | "neutral"
  | "none"
  | "temperror"
  | "permerror"
  | "policy";

const verdicts: readonly MethodVerdict[] = [
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
  "policy",
];

const isVerdict = (result: string): result is MethodVerdict =>
  verdicts.some((verdict) => verdict === result);

/** What one method said, and of which domain; null when nothing was said. */
export type MethodResult = {
  readonly result: MethodVerdict;
  readonly domain: string | null;
} | null;

/** What SPF, DKIM and DMARC said of a message. */
export interface Authentication {
  readonly spf: MethodResult;
  readonly dkim: MethodResult;
  readonly dmarc: MethodResult;
}

/** Nothing said: no header core reads, or one that doesn't parse. */
export const unauthenticated: Authentication = {
  spf: null,
  dkim: null,
  dmarc: null,
};

/** One result of a header (RFC 8601 `resinfo`), its names lower case. */
export interface ResultInfo {
  readonly method: string;
  readonly result: string;
  readonly reason: string | undefined;
  /** Each property by `ptype.property` (`smtp.mailfrom`), its value as given. */
  readonly properties: ReadonlyMap<string, string>;
}

/** A header's payload (RFC 8601 `authres-payload`). */
export interface ResultsHeader {
  /** The authserv-id, lower case. */
  readonly authservId: string;
  readonly results: readonly ResultInfo[];
}

/** The longest header read: longer is no header Email Routing writes. */
const maxHeaderLength = 16 * 1024;

/** The deepest comments nest. */
const maxCommentDepth = 16;

/** A character of an RFC 2045 token: visible US-ASCII but its `tspecials`. */
const tokenCharPattern = /^[!#$%&'*+\-.0-9A-Z^_`a-z{|}~]$/u;

/** A character of a property's value as written unquoted (see above). */
const valueCharPattern = /^[!#-'*-:<-[\]-~]$/u;

const isWhitespace = (char: string): boolean =>
  char === " " || char === "\t" || char === "\r" || char === "\n";

const isTokenChar = (char: string): boolean => tokenCharPattern.test(char);

const isLetDig = (char: string): boolean => /^[A-Za-z0-9]$/u.test(char);

/** RFC 5321 `Keyword`: a letter or digit, then letters, digits and inner hyphens. */
const keywordPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;

/** RFC 6376 3.5's `domain-name`: sub-domains, each a Keyword, by dots. */
const domainNamePattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/u;

/** What marks an error as a header that isn't the grammar's (`unparsable`). */
const notTheGrammar = Symbol("not the grammar");

/** An error saying a header isn't the grammar's, and why. */
const unparsable = (why: string): Error =>
  new Error(why, { cause: notTheGrammar });

/** A cursor over a header's text, with the grammar's productions. */
class Cursor {
  #at = 0;
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  /** Where it is, to come back to (`rewind`). */
  get position(): number {
    return this.#at;
  }

  rewind(position: number): void {
    this.#at = position;
  }

  get done(): boolean {
    return this.#at >= this.#text.length;
  }

  peek(): string {
    return this.#text.charAt(this.#at);
  }

  /** `char`, taken, or nothing taken. */
  take(char: string): boolean {
    if (this.peek() !== char) {
      return false;
    }
    this.#at += 1;
    return true;
  }

  expect(char: string): void {
    if (!this.take(char)) {
      throw unparsable(`Expected ${char}`);
    }
  }

  /** RFC 5322 `CFWS`, or nothing: whether any was taken. */
  cfws(): boolean {
    const start = this.#at;
    for (;;) {
      if (isWhitespace(this.peek())) {
        this.#at += 1;
      } else if (this.peek() === "(") {
        this.#comment(0);
      } else {
        return this.#at > start;
      }
    }
  }

  /** An RFC 5322 `comment`, nested at most `maxCommentDepth` deep. */
  #comment(depth: number): void {
    if (depth >= maxCommentDepth) {
      throw unparsable("Comments nest too deep");
    }
    this.expect("(");
    for (;;) {
      if (this.done) {
        throw unparsable("A comment never ends");
      }
      const char = this.peek();
      if (char === ")") {
        this.#at += 1;
        return;
      }
      if (char === "(") {
        this.#comment(depth + 1);
      } else if (char === "\\") {
        this.#at += 2;
      } else {
        this.#at += 1;
      }
    }
  }

  /** An RFC 5322 `quoted-string`'s content, its quoted pairs undone. */
  quotedString(): string {
    this.expect('"');
    let content = "";
    for (;;) {
      if (this.done) {
        throw unparsable("A quoted string never ends");
      }
      const char = this.peek();
      this.#at += 1;
      if (char === '"') {
        return content;
      }
      if (char === "\\") {
        if (this.done) {
          throw unparsable("A quoted pair never ends");
        }
        content += this.peek();
        this.#at += 1;
      } else {
        content += char;
      }
    }
  }

  /** The longest run of characters `allowed` takes from here. */
  run(allowed: (char: string) => boolean): string {
    const start = this.#at;
    while (!this.done && allowed(this.peek())) {
      this.#at += 1;
    }
    return this.#text.slice(start, this.#at);
  }

  /** An RFC 5321 `Keyword`, lower case. */
  keyword(): string {
    const word = this.run((char) => isLetDig(char) || char === "-");
    if (!keywordPattern.test(word)) {
      throw unparsable("Expected a keyword");
    }
    return word.toLowerCase();
  }

  /** RFC 2045's `value`: a token or a quoted string. */
  value(): string {
    if (this.peek() === '"') {
      return this.quotedString();
    }
    const token = this.run(isTokenChar);
    if (token === "") {
      throw unparsable("Expected a value");
    }
    return token;
  }

  /**
   * RFC 8601's `pvalue`, without its CFWS: a quoted string (a quoted
   * local part and its domain), or visible text up to the next
   * whitespace, comment, quote or `;` (see above).
   */
  pvalue(): string {
    if (this.peek() === '"') {
      const quoted = this.quotedString();
      if (!this.take("@")) {
        return quoted;
      }
      return `${quoted}@${this.#domainName()}`;
    }
    const word = this.run((char) => valueCharPattern.test(char));
    if (word === "") {
      throw unparsable("Expected a property's value");
    }
    return word;
  }

  #domainName(): string {
    const domain = this.run((char) => isLetDig(char) || "-.".includes(char));
    if (!domainNamePattern.test(domain)) {
      throw unparsable("Expected a domain");
    }
    return domain;
  }
}

/**
 * One `resinfo` (RFC 8601 2.2), its leading `;` taken already:
 * `methodspec [CFWS reasonspec] [CFWS 1*propspec]`.
 */
const resultInfo = (cursor: Cursor): ResultInfo => {
  cursor.cfws();
  const method = cursor.keyword();
  cursor.cfws();
  if (cursor.take("/")) {
    cursor.cfws();
    if (cursor.run((char) => /\d/u.test(char)) === "") {
      throw unparsable("Expected a method version");
    }
    cursor.cfws();
  }
  cursor.expect("=");
  cursor.cfws();
  const result = cursor.keyword();
  let reason: string | undefined;
  const properties = new Map<string, string>();
  for (;;) {
    const spaced = cursor.cfws();
    if (cursor.done || cursor.peek() === ";") {
      return { method, result, reason, properties };
    }
    if (!spaced) {
      throw unparsable("Expected whitespace before a property");
    }
    const name = cursor.keyword();
    cursor.cfws();
    if (name === "reason" && reason === undefined && properties.size === 0) {
      cursor.expect("=");
      cursor.cfws();
      reason = cursor.value();
      continue;
    }
    cursor.expect(".");
    cursor.cfws();
    const property = cursor.keyword();
    cursor.cfws();
    cursor.expect("=");
    cursor.cfws();
    const key = `${name}.${property}`;
    const value = cursor.pvalue();
    if (!properties.has(key)) {
      properties.set(key, value);
    }
  }
};

/**
 * RFC 8601 2.2's `no-result`, `; none` and nothing after, taken; nothing
 * taken otherwise.
 */
const noResult = (cursor: Cursor): boolean => {
  const start = cursor.position;
  if (cursor.take(";")) {
    cursor.cfws();
    if (cursor.run(isLetDig).toLowerCase() === "none") {
      cursor.cfws();
      if (cursor.done) {
        return true;
      }
    }
  }
  cursor.rewind(start);
  return false;
};

/**
 * An `authres-payload` (RFC 8601 2.2): the authserv-id, an optional
 * version (only 1 exists), then `; none` or its results.
 */
const payload = (cursor: Cursor): ResultsHeader => {
  cursor.cfws();
  const authservId = cursor.value().toLowerCase();
  const spaced = cursor.cfws();
  if (spaced && /\d/u.test(cursor.peek())) {
    if (cursor.run((char) => /\d/u.test(char)) !== "1") {
      throw unparsable("An unknown version");
    }
    cursor.cfws();
  }
  if (noResult(cursor)) {
    return { authservId, results: [] };
  }
  const results: ResultInfo[] = [];
  while (cursor.take(";")) {
    results.push(resultInfo(cursor));
  }
  cursor.cfws();
  if (!cursor.done || results.length === 0) {
    throw unparsable("Expected results");
  }
  return { authservId, results };
};

/** Parses `text` with `production`; none when it isn't the grammar's. */
const parsed = <T>(
  text: string,
  production: (cursor: Cursor) => T
): T | undefined => {
  if (text.length > maxHeaderLength) {
    return undefined;
  }
  try {
    return production(new Cursor(text));
  } catch (error) {
    if (error instanceof Error && error.cause === notTheGrammar) {
      return undefined;
    }
    throw error;
  }
};

/** An `Authentication-Results` header's value, parsed; none if it isn't one. */
export const parseAuthenticationResults = (
  value: string
): ResultsHeader | undefined => parsed(value, payload);

/** An ARC header's instance (RFC 8617 4.2.1's `i=`), its `;` taken. */
const instanceOf = (cursor: Cursor): number => {
  cursor.cfws();
  cursor.expect("i");
  cursor.cfws();
  cursor.expect("=");
  cursor.cfws();
  const digits = cursor.run((char) => /\d/u.test(char));
  const instance = Number(digits);
  // RFC 8617 4.2.1: 1 to 50.
  if (digits === "" || digits.length > 2 || instance < 1 || instance > 50) {
    throw unparsable("Expected an instance from 1 to 50");
  }
  cursor.cfws();
  cursor.expect(";");
  return instance;
};

/** An `ARC-Authentication-Results` header's value, parsed; none if it isn't one. */
export const parseArcAuthenticationResults = (
  value: string
): (ResultsHeader & { instance: number }) | undefined =>
  parsed(value, (cursor) => {
    const instance = instanceOf(cursor);
    return { instance, ...payload(cursor) };
  });

/** A message's header, as postal-mime gives it: its name lower case. */
interface Header {
  readonly key: string;
  readonly value: string;
}

const arcResultsKey = "arc-authentication-results";
const arcSealKey = "arc-seal";
const arcSignatureKey = "arc-message-signature";

/** The highest instance an ARC set may have (RFC 8617 4.2.1). */
const maxInstance = 50;

/**
 * An ARC-Seal's or ARC-Message-Signature's tags (RFC 8617 4.1.2, 4.1.3,
 * RFC 6376 3.2's tag-list), by name.
 */
const arcTags = (value: string): Map<string, string> | undefined => {
  const tags = new Map<string, string>();
  for (const spec of value.split(";")) {
    const trimmed = spec.trim();
    if (trimmed === "") {
      continue;
    }
    const equals = trimmed.indexOf("=");
    const name = trimmed.slice(0, Math.max(equals, 0)).trim();
    if (!/^[A-Za-z]\w*$/u.test(name) || tags.has(name)) {
      return undefined;
    }
    tags.set(name, trimmed.slice(equals + 1).trim());
  }
  return tags;
};

/** The instance tags `tags` give (`i=`, 1 to 50); none if they give none. */
const instanceTagged = (
  tags: Map<string, string> | undefined
): number | undefined => {
  const tag = tags?.get("i") ?? "";
  const instance = Number(tag);
  return /^\d{1,2}$/u.test(tag) && instance >= 1 && instance <= maxInstance
    ? instance
    : undefined;
};

/** An ARC-Seal's instance and chain validation status; none if it isn't one. */
const parseArcSeal = (
  value: string
): { instance: number; cv: string } | undefined => {
  const tags = arcTags(value);
  const instance = instanceTagged(tags);
  const cv = tags?.get("cv")?.toLowerCase();
  return instance !== undefined &&
    (cv === "none" || cv === "pass" || cv === "fail")
    ? { instance, cv }
    : undefined;
};

/** An ARC-Message-Signature's instance; none if it isn't one. */
const parseArcSignature = (value: string): { instance: number } | undefined => {
  const instance = instanceTagged(arcTags(value));
  return instance === undefined ? undefined : { instance };
};

/**
 * The results Email Routing recorded of a message with `headers`, as the
 * header says: its own ARC set's, on top, at the highest instance.
 */
const trustedResults = (
  headers: readonly Header[]
): ResultsHeader | undefined => {
  const results = headers
    .filter(({ key }) => key === arcResultsKey)
    .map(({ value }) => parseArcAuthenticationResults(value));
  const seals = headers
    .filter(({ key }) => key === arcSealKey)
    .map(({ value }) => parseArcSeal(value));
  const signatures = headers
    .filter(({ key }) => key === arcSignatureKey)
    .map(({ value }) => parseArcSignature(value));
  const [top] = results;
  if (
    top === undefined ||
    results.includes(undefined) ||
    seals.includes(undefined) ||
    signatures.includes(undefined)
  ) {
    return undefined;
  }
  const instances = [...results, ...seals, ...signatures].map(
    (each) => each?.instance ?? 0
  );
  const highest = Math.max(...instances);
  const atTop = (each: { instance: number } | undefined) =>
    each?.instance === highest;
  const seal = seals.find(atTop);
  return top.instance === highest &&
    highest < maxInstance &&
    results.filter(atTop).length === 1 &&
    seals.filter(atTop).length === 1 &&
    signatures.filter(atTop).length === 1 &&
    seal?.cv !== "fail" &&
    top.authservId === trustedAuthservId
    ? top
    : undefined;
};

/** The domain of `address` (a domain, or `local@domain`), lower case. */
const domainOf = (address: string | undefined): string | null => {
  if (address === undefined) {
    return null;
  }
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return domainNamePattern.test(domain) ? domain : null;
};

/**
 * Whether `domain` and `from` are aligned, as DMARC's relaxed mode would
 * take them without the public suffix list: the same, or one under the
 * other.
 */
const aligned = (domain: string | null, from: string | null): boolean =>
  domain !== null &&
  from !== null &&
  (domain === from ||
    from.endsWith(`.${domain}`) ||
    domain.endsWith(`.${from}`));

/** `info` as a method's result, of `domain`; null for a result not one of RFC 8601's. */
const methodResultOf = (
  info: ResultInfo | undefined,
  domain: string | null
): MethodResult =>
  info === undefined || !isVerdict(info.result)
    ? null
    : { result: info.result, domain };

/** The domain a DKIM result vouches for: its `header.d`, else its `header.i`'s. */
const dkimDomain = (info: ResultInfo): string | null =>
  domainOf(info.properties.get("header.d") ?? info.properties.get("header.i"));

/**
 * What SPF, DKIM and DMARC said of a message with `headers`, from
 * `fromAddress` (its From header's), as Email Routing recorded it (see
 * above); each `null` when nothing core reads says. SPF's is its check of
 * the envelope sender (`smtp.mailfrom`) when there is one, else its
 * first; DKIM's, of several signatures, the one aligned with the From
 * domain (a pass first), else its first; DMARC's, its first.
 */
export const authenticationOf = (
  headers: readonly Header[],
  fromAddress: string | undefined
): Authentication => {
  const results = trustedResults(headers)?.results;
  if (results === undefined) {
    return unauthenticated;
  }
  const of = (method: string) =>
    results.filter((info) => info.method === method);
  const spfs = of("spf");
  const spf =
    spfs.find((info) => info.properties.has("smtp.mailfrom")) ?? spfs[0];
  const from = domainOf(fromAddress);
  const dkims = of("dkim");
  const alignedDkims = dkims.filter((info) => aligned(dkimDomain(info), from));
  const dkim =
    alignedDkims.find((info) => info.result === "pass") ??
    alignedDkims[0] ??
    dkims[0];
  const [dmarc] = of("dmarc");
  return {
    spf: methodResultOf(
      spf,
      domainOf(
        spf?.properties.get("smtp.mailfrom") ?? spf?.properties.get("smtp.helo")
      )
    ),
    dkim: methodResultOf(dkim, dkim === undefined ? null : dkimDomain(dkim)),
    dmarc: methodResultOf(
      dmarc,
      domainOf(dmarc?.properties.get("header.from"))
    ),
  };
};

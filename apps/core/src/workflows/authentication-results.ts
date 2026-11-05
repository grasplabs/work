// What the receiving server found of a message's SPF, DKIM and DMARC, as
// its `Authentication-Results` header records it (RFC 8601), or its ARC
// set's `ARC-Authentication-Results` (RFC 8617): what a reply to a run's
// mail carries for the workflow to check who sent it (`emailReplyData`,
// release-contracts.ts). Core checks none of it itself, and refuses no
// mail on it: it only reports what Email Routing found.
//
// Anyone can write these headers into a message they send, so only one
// is read: the topmost of either kind, which is the last server's own,
// and only when its authserv-id is Email Routing's (`trustedAuthservId`).
// Email Routing puts its results on top of every message it hands over,
// its ARC set at the highest instance, so a sender's header claiming its
// authserv-id sits below it and is never read. A topmost ARC header whose
// instance isn't the message's highest is a forged one, and nothing is
// read. A message with no such header on top reports nothing (each method
// `null`), as does one whose header doesn't parse: a verdict is never
// guessed from a header read loosely.
//
// The parser follows the RFC's grammar strictly (RFC 8601 2.2, RFC 8617
// 4.1.1, with RFC 5322's CFWS and quoted strings and RFC 2045's tokens),
// with one narrow addition: a property's value may be an IPv6 address as
// is (`smtp.remote-ip=2a00:1440::32e`), which Email Routing writes
// unquoted though `:` can't be in a token.

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

/** RFC 5322 `atext` beyond letters and digits, which a local part may hold. */
const atextSpecialPattern = /^[!#$%&'*+\-/=?^_`{|}~]$/u;

const isWhitespace = (char: string): boolean =>
  char === " " || char === "\t" || char === "\r" || char === "\n";

const isTokenChar = (char: string): boolean => tokenCharPattern.test(char);

const isLetDig = (char: string): boolean => /^[A-Za-z0-9]$/u.test(char);

/** RFC 5321 `Keyword`: a letter or digit, then letters, digits and inner hyphens. */
const keywordPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;

/** RFC 6376 3.5's `domain-name`: sub-domains, each a Keyword, by dots. */
const domainNamePattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/u;

/** RFC 5322 `dot-atom-text`. */
const dotAtomPattern =
  /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/u;

/** An RFC 2045 token. */
const tokenPattern = /^[!#$%&'*+\-.0-9A-Z^_`a-z{|}~]+$/u;

/** An IPv6 address as written, its last part maybe IPv4 (RFC 4291 2.2). */
const ipv6Pattern =
  /^[0-9A-Fa-f:]*:[0-9A-Fa-f:]*(?:\d{1,3}(?:\.\d{1,3}){3})?$/u;

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
   * RFC 8601's `pvalue`, without its CFWS: a value, or an address or
   * domain (`[[local-part] "@"] domain-name`), or an IPv6 address as is.
   */
  pvalue(): string {
    if (this.peek() === '"') {
      const quoted = this.quotedString();
      if (!this.take("@")) {
        return quoted;
      }
      return `${quoted}@${this.#domainName()}`;
    }
    const word = this.run(
      (char) =>
        isTokenChar(char) ||
        atextSpecialPattern.test(char) ||
        char === "@" ||
        char === ":"
    );
    const at = word.indexOf("@");
    if (at === -1) {
      if (tokenPattern.test(word) || ipv6Pattern.test(word)) {
        return word;
      }
      throw unparsable("Expected a property's value");
    }
    const local = word.slice(0, at);
    const domain = word.slice(at + 1);
    if (
      (local !== "" && !dotAtomPattern.test(local)) ||
      !domainNamePattern.test(domain)
    ) {
      throw unparsable("Expected an address or a domain");
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

const resultsKey = "authentication-results";
const arcResultsKey = "arc-authentication-results";

/**
 * The results Email Routing recorded of a message with `headers`, as the
 * header says: the topmost results header, if it's Email Routing's and,
 * for an ARC one, of the message's highest instance.
 */
const trustedResults = (
  headers: readonly Header[]
): ResultsHeader | undefined => {
  const top = headers.find(
    ({ key }) => key === resultsKey || key === arcResultsKey
  );
  if (top === undefined) {
    return undefined;
  }
  let results: ResultsHeader | undefined;
  if (top.key === resultsKey) {
    results = parseAuthenticationResults(top.value);
  } else {
    const arc = parseArcAuthenticationResults(top.value);
    const instances = headers
      .filter(({ key }) => key === arcResultsKey)
      .map(({ value }) => parseArcAuthenticationResults(value)?.instance ?? 0);
    const highest = instances.filter(
      (instance) => instance === arc?.instance
    ).length;
    results =
      arc !== undefined &&
      highest === 1 &&
      instances.every((instance) => instance <= arc.instance)
        ? arc
        : undefined;
  }
  return results?.authservId === trustedAuthservId ? results : undefined;
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

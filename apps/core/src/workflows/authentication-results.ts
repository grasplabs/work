// What the receiving server found of a message's SPF, DKIM and DMARC: what
// a reply to a run's mail carries for the workflow to check who sent it
// (`emailReplyData`, release-contracts.ts). Core refuses no mail on it; it
// only reports what Email Routing found, and never guesses a verdict.
//
// Trust rule. Anyone can write results headers into a message they send,
// so only Email Routing's own are read: the ARC-Authentication-Results
// header (RFC 8617 4.1.1) of the ARC set it seals every message with,
// prepended above every header the message came with and numbered past
// every set the message carries. So the topmost such header counts, and
// only when it is under Email Routing's authserv-id (`trustedAuthservId`)
// and its set is the message's one complete set at the highest instance.
// A sealer adds no set to a chain whose last seal says `cv=fail` or that
// is full at instance 50 (RFC 8617 5.1, 4.2.1), so those are what a sender
// would forge to keep Email Routing's set off the top, and they report
// nothing; so does any seal not saying exactly what a chain that holds
// has (`cv=none` at 1, `cv=pass` above), and any ARC header whose instance
// doesn't read or whose name is written with a space before its colon.
// A plain Authentication-Results header is never read: Email Routing records its
// results only in its ARC set, so one under its authserv-id is a sender's.
// This holds only for mail Email Routing received: an ingress without it in
// front (mail-ingress.ts) must seal mail with an ARC set of its own, or
// remove every ARC set under Email Routing's authserv-id.
//
// The results follow RFC 8601 2.2's grammar, with RFC 5322 3.2's CFWS and
// quoted strings and RFC 6532's UTF-8: a header that doesn't parse reports
// nothing. One deliberate widening: a property's value is any run of text
// up to CFWS or `;`, since receiving servers write values the grammar
// doesn't allow unquoted (`header.b=/Gj4+R==`, `smtp.remote-ip=2a00::1`,
// `smtp.mailfrom=<>`); a value is only reported as a domain once it is one
// (`domainOf`). And one deliberate narrowing: no `;` inside a comment or
// quoted string (`delimited`).

/** The authserv-id Email Routing writes its results under. */
export const trustedAuthservId = "mx.cloudflare.net";

const verdicts = [
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
  "policy",
] as const;

/** A result RFC 8601 2.7 names for SPF, DKIM or DMARC. */
export type MethodVerdict = (typeof verdicts)[number];

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

/** The grammar's punctuation, each a token of its own. */
const punctuation = [";", "=", ".", "/"] as const;

type Punctuation = (typeof punctuation)[number];

/** One token of a header: a run of text, a quoted string or punctuation. */
interface Token {
  readonly kind: "word" | "quoted" | Punctuation;
  /** Its text; a quoted string's content, its quoted pairs undone. */
  readonly text: string;
  /** Whether CFWS comes before it. */
  readonly spaced: boolean;
}

/** The cause of an error thrown where a header isn't the grammar's. */
const notTheGrammar = Symbol("not the grammar");

const unparsable = (why: string): Error =>
  new Error(why, { cause: notTheGrammar });

const isPunctuation = (char: string): char is Punctuation =>
  punctuation.some((each) => each === char);

const isWhitespace = (char: string): boolean =>
  char === " " || char === "\t" || char === "\r" || char === "\n";

/** A character of a word: visible or UTF-8, not CFWS, a quote or punctuation. */
const isWordChar = (char: string): boolean =>
  char > " " &&
  char !== "\u007F" &&
  !'"()\\'.includes(char) &&
  !isPunctuation(char);

/**
 * Where the RFC 5322 comment or quoted string opening at `start` ends (past
 * its closing character), and its content, quoted pairs undone. Comments
 * nest; quoted strings don't.
 */
const delimited = (
  text: string,
  start: number
): { end: number; content: string } => {
  const nests = text.charAt(start) === "(";
  const close = nests ? ")" : '"';
  let depth = 1;
  let content = "";
  for (let at = start + 1; at < text.length; at += 1) {
    const quotedPair = text.charAt(at) === "\\";
    if (quotedPair) {
      at += 1;
    }
    const char = text.charAt(at);
    // Refused, though the grammar allows it: a quote or parenthesis a
    // sender gets into a value Email Routing writes unescaped could
    // otherwise hide its real results behind the sender's, up to a quote or
    // parenthesis the sender gets into a later value. Values written before
    // DMARC's result (DKIM's) can't hold a `;`, so its first result holds.
    if (char === ";") {
      throw unparsable("A ; inside a comment or quoted string");
    }
    if (!quotedPair && char === close) {
      depth -= 1;
      if (depth === 0) {
        return { end: at + 1, content };
      }
    } else if (!quotedPair && nests && char === "(") {
      depth += 1;
    }
    content += char;
  }
  throw unparsable("A comment or quoted string never ends");
};

/** `text` as tokens, CFWS dropped (RFC 8601 2.2's lexical level). */
const tokensOf = (text: string): Token[] => {
  const tokens: Token[] = [];
  let spaced = false;
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    if (isWhitespace(char) || char === "(") {
      at = char === "(" ? delimited(text, at).end : at + 1;
      spaced = true;
      continue;
    }
    if (char === '"') {
      const { end, content } = delimited(text, at);
      tokens.push({ kind: "quoted", text: content, spaced });
      at = end;
    } else if (isPunctuation(char)) {
      tokens.push({ kind: char, text: char, spaced });
      at += 1;
    } else {
      const start = at;
      while (at < text.length && isWordChar(text.charAt(at))) {
        at += 1;
      }
      if (at === start) {
        throw unparsable(`Unexpected ${char}`);
      }
      tokens.push({ kind: "word", text: text.slice(start, at), spaced });
    }
    spaced = false;
  }
  return tokens;
};

/** RFC 5321 `Keyword`: a letter or digit, then letters, digits and inner hyphens. */
const keywordPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;

const digitsPattern = /^\d+$/u;

/** A reader over a header's tokens, with the grammar's productions. */
class Reader {
  #at = 0;
  readonly #tokens: readonly Token[];

  constructor(text: string) {
    this.#tokens = tokensOf(text);
  }

  get done(): boolean {
    return this.#at === this.#tokens.length;
  }

  peek(ahead = 0): Token | undefined {
    return this.#tokens[this.#at + ahead];
  }

  take(kind: Token["kind"]): boolean {
    if (this.peek()?.kind !== kind) {
      return false;
    }
    this.#at += 1;
    return true;
  }

  expect(kind: Token["kind"]): void {
    if (!this.take(kind)) {
      throw unparsable(`Expected ${kind}`);
    }
  }

  /** A word matching `pattern`. */
  word(pattern: RegExp): string {
    const token = this.peek();
    if (token?.kind !== "word" || !pattern.test(token.text)) {
      throw unparsable(`Expected ${String(pattern)}`);
    }
    this.#at += 1;
    return token.text;
  }

  /** A Keyword, lower case: a method, result, ptype or property. */
  keyword(): string {
    return this.word(keywordPattern).toLowerCase();
  }

  /**
   * A value: its first token, then every token up to CFWS or `;` (RFC
   * 2045's value, widened for property values: see above).
   */
  value(): string {
    const start = this.#at;
    let text = "";
    for (let token = this.peek(); token !== undefined; token = this.peek()) {
      if (token.kind === ";" || (this.#at > start && token.spaced)) {
        break;
      }
      text += token.text;
      this.#at += 1;
    }
    if (this.#at === start) {
      throw unparsable("Expected a value");
    }
    return text;
  }
}

/** Whether `token` is the word `word`, in any case. */
const isWord = (token: Token | undefined, word: string): boolean =>
  token?.kind === "word" && token.text.toLowerCase() === word;

/** One result (RFC 8601 `resinfo`), its names lower case. */
interface ResultInfo {
  /** Its method, with its version when that isn't 1 (`dkim/2`). */
  readonly method: string;
  readonly result: string;
  /** Each property by `ptype.property` (`smtp.mailfrom`). */
  readonly properties: ReadonlyMap<string, string>;
}

/**
 * One `resinfo`, its `;` taken: `method[/version] = result [reason = value]
 * *(ptype.property = value)`. A method version other than 1 makes it
 * another method, so it is never read as SPF, DKIM or DMARC (RFC 8601 2.6).
 */
const resultInfo = (reader: Reader): ResultInfo => {
  const name = reader.keyword();
  const version = reader.take("/") ? reader.word(digitsPattern) : "1";
  reader.expect("=");
  const result = reader.keyword();
  if (isWord(reader.peek(), "reason") && reader.peek(1)?.kind === "=") {
    reader.keyword();
    reader.expect("=");
    reader.value();
  }
  const properties = new Map<string, string>();
  while (!reader.done && reader.peek()?.kind !== ";") {
    const ptype = reader.keyword();
    reader.expect(".");
    const property = `${ptype}.${reader.keyword()}`;
    reader.expect("=");
    // Refused, though the grammar allows it: a sender's envelope address
    // that closes and reopens Email Routing's comment could put a property
    // of its choice ahead of the real one.
    if (properties.has(property)) {
      throw unparsable(`${property} twice`);
    }
    properties.set(property, reader.value());
  }
  const method = version === "1" ? name : `${name}/${version}`;
  return { method, result, properties };
};

/** The instance an ARC header gives: 1 to 50 (RFC 8617 4.2.1). */
const instanceOf = (digits: string | undefined): number => {
  const instance = Number(digits);
  if (!/^\d{1,2}$/u.test(digits ?? "") || instance < 1 || instance > 50) {
    throw unparsable("Expected an instance from 1 to 50");
  }
  return instance;
};

/** An ARC-Authentication-Results header's instance (`i=N;`, RFC 8617 4.1.1). */
const arcInstance = (reader: Reader): number => {
  reader.word(/^i$/u);
  reader.expect("=");
  const instance = instanceOf(reader.word(digitsPattern));
  reader.expect(";");
  return instance;
};

/**
 * An ARC-Authentication-Results header's authserv-id, lower case, and
 * results (RFC 8601 2.2's `authres-payload`): none for `; none`.
 */
const arcResults = (
  value: string
): { authservId: string; results: ResultInfo[] } => {
  const reader = new Reader(value);
  arcInstance(reader);
  const authservId = reader.value().toLowerCase();
  // A version not known stops the parse (RFC 8601 2.6): only 1 exists.
  if (reader.peek()?.kind === "word") {
    reader.word(/^1$/u);
  }
  const results: ResultInfo[] = [];
  const noResult =
    reader.peek()?.kind === ";" &&
    isWord(reader.peek(1), "none") &&
    reader.peek(2) === undefined;
  if (noResult) {
    return { authservId, results };
  }
  while (reader.take(";")) {
    results.push(resultInfo(reader));
  }
  if (!reader.done || results.length === 0) {
    throw unparsable("Expected results");
  }
  return { authservId, results };
};

/** `text` without the FWS around it (RFC 6376 3.2), and nothing else. */
const trimmed = (text: string): string => {
  let start = 0;
  let end = text.length;
  while (start < end && isWhitespace(text.charAt(start))) {
    start += 1;
  }
  while (end > start && isWhitespace(text.charAt(end - 1))) {
    end -= 1;
  }
  return text.slice(start, end);
};

/**
 * An ARC-Seal's or ARC-Message-Signature's instance and `cv` tag (RFC 6376
 * 3.2's tag-list: `name=value` by `;`, each name once in any case).
 */
const arcTagsOf = (
  value: string
): { instance: number; cv: string | undefined } => {
  const specs = value.split(";");
  if (trimmed(specs.at(-1) ?? "") === "") {
    specs.pop();
  }
  const tags = new Map<string, string>();
  // Names are case-sensitive, but one twice in another case is refused: a
  // sealer reading them otherwise could see another `cv` or `i` than ours.
  const names = new Set<string>();
  for (const spec of specs) {
    const [name = "", ...rest] = spec.split("=").map(trimmed);
    const folded = name.toLowerCase();
    if (
      rest.length === 0 ||
      !/^[A-Za-z]\w*$/u.test(name) ||
      names.has(folded)
    ) {
      throw unparsable("Expected a tag-list");
    }
    names.add(folded);
    tags.set(name, rest.join("="));
  }
  return { instance: instanceOf(tags.get("i")), cv: tags.get("cv") };
};

/** A message's header, as postal-mime gives it: its name lower case. */
interface Header {
  readonly key: string;
  readonly value: string;
}

/**
 * The results Email Routing recorded of a message with `headers` (see
 * above); none when it recorded none core trusts. Throws `unparsable`
 * when an ARC header doesn't read.
 */
const trustedResults = (headers: readonly Header[]): ResultInfo[] => {
  const values = (name: string) =>
    headers
      .filter(({ key }) => {
        // postal-mime keeps the space of RFC 5322 4.5's obsolete
        // `ARC-Seal :`, which a sealer may or may not read as an ARC-Seal:
        // either reading could hide a set from one of us, so nothing counts.
        if (key !== name && key.trim() === name) {
          throw unparsable(`A spaced ${name}`);
        }
        return key === name;
      })
      .map(({ value }) => value);
  const resultsHeaders = values("arc-authentication-results");
  // Of the others' results only their instance is read: they needn't be
  // the grammar's past it (Microsoft 365 writes `action=none`).
  const resultsInstances = resultsHeaders.map((value) =>
    arcInstance(new Reader(value.slice(0, value.indexOf(";") + 1)))
  );
  const seals = values("arc-seal").map(arcTagsOf);
  const sealInstances = seals.map(({ instance }) => instance);
  const signatureInstances = values("arc-message-signature").map(
    (value) => arcTagsOf(value).instance
  );
  const highest = Math.max(
    ...resultsInstances,
    ...sealInstances,
    ...signatureInstances
  );
  const onceAtHighest = (instances: readonly number[]) =>
    instances.filter((instance) => instance === highest).length === 1;
  const [top] = resultsHeaders;
  const topSetTrusted =
    top !== undefined &&
    resultsInstances[0] === highest &&
    highest < 50 &&
    onceAtHighest(resultsInstances) &&
    onceAtHighest(sealInstances) &&
    onceAtHighest(signatureInstances) &&
    // Each seal as a chain that holds has it (RFC 8617 5.2): one that
    // doesn't makes Email Routing's own say `cv=fail`, or stops it sealing.
    seals.every(
      ({ instance, cv }) => cv === (instance === 1 ? "none" : "pass")
    );
  if (!topSetTrusted) {
    return [];
  }
  const { authservId, results } = arcResults(top);
  return authservId === trustedAuthservId ? results : [];
};

/**
 * The domain of `address` (a domain, or `local@domain`), lower case, when
 * it is RFC 6376 3.5's `domain-name`: two or more Keywords by dots.
 */
const domainOf = (address: string | undefined): string | null => {
  // Checked before it is lower-cased: some non-ASCII letters lower-case
  // to ASCII ones (U+212A KELVIN SIGN to `k`).
  const domain = address?.slice(address.lastIndexOf("@") + 1);
  const labels = domain?.split(".") ?? [];
  return domain !== undefined &&
    labels.length > 1 &&
    labels.every((label) => keywordPattern.test(label))
    ? domain.toLowerCase()
    : null;
};

/**
 * Whether `domain` and `from` are aligned, as DMARC's relaxed mode would
 * take them without the public suffix list: the same, or one under the
 * other. It only picks which DKIM result is reported; the domain reported
 * is the signature's own.
 */
const aligned = (domain: string | null, from: string | null): boolean =>
  domain !== null &&
  from !== null &&
  (domain === from ||
    from.endsWith(`.${domain}`) ||
    domain.endsWith(`.${from}`));

/** `info` as a method's result, of `domain`; null for a result not RFC 8601's. */
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
  let results: ResultInfo[] = [];
  try {
    results = trustedResults(headers);
  } catch (error) {
    if (!(error instanceof Error && error.cause === notTheGrammar)) {
      throw error;
    }
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

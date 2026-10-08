/**
 * What a stylesheet would fetch, read the way a browser reads it: the
 * tokenizer of CSS Syntax Level 3 (§4), with its escapes, comments and
 * `url()` rules, then only the positions that fetch. Text that merely
 * looks like a URL (`content: "https://…"`, a font family, a comment) is
 * never one; a URL hidden by escapes (`\75 rl(…)`) is.
 */

/** A token of CSS Syntax Level 3, as far as what fetches needs it. */
export interface CssToken {
  type:
    | "ident"
    | "function"
    | "at-keyword"
    | "hash"
    | "string"
    | "bad-string"
    | "url"
    | "bad-url"
    | "delim"
    | "numeric"
    | "whitespace"
    | "cdo"
    | "cdc"
    | ":"
    | ";"
    | ","
    | "["
    | "]"
    | "("
    | ")"
    | "{"
    | "}";
  /** The name, the string's or URL's value, or the delimiter. */
  value: string;
}

const replacement = 0xff_fd;
const newline = 0x0a;
const backslash = 0x5c;

const isDigit = (code: number | undefined): boolean =>
  code !== undefined && code >= 0x30 && code <= 0x39;

const isHex = (code: number | undefined): boolean =>
  isDigit(code) ||
  (code !== undefined &&
    ((code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66)));

const isWhitespace = (code: number | undefined): boolean =>
  code === newline || code === 0x09 || code === 0x20;

const isNameStart = (code: number | undefined): boolean =>
  code !== undefined &&
  ((code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code >= 0x80);

const isName = (code: number | undefined): boolean =>
  isNameStart(code) || isDigit(code) || code === 0x2d;

const isNonPrintable = (code: number): boolean =>
  code <= 0x08 ||
  code === 0x0b ||
  (code >= 0x0e && code <= 0x1f) ||
  code === 0x7f;

/** §4.3.8: whether two code points start a valid escape. */
const isValidEscape = (
  first: number | undefined,
  second: number | undefined
): boolean => first === backslash && second !== newline;

/** §4.3.9: whether three code points would start an ident sequence. */
const startsIdent = (
  first: number | undefined,
  second: number | undefined,
  third: number | undefined
): boolean => {
  if (first === 0x2d) {
    return (
      isNameStart(second) || second === 0x2d || isValidEscape(second, third)
    );
  }
  return isNameStart(first) || isValidEscape(first, second);
};

/** §4.3.10: whether three code points would start a number. */
const startsNumber = (
  first: number | undefined,
  second: number | undefined,
  third: number | undefined
): boolean => {
  if (first === 0x2b || first === 0x2d) {
    return isDigit(second) || (second === 0x2e && isDigit(third));
  }
  return first === 0x2e ? isDigit(second) : isDigit(first);
};

/** §3.3: CSS's input, its newlines and NULs (and lone surrogates) normalized. */
const preprocess = (css: string): number[] => {
  const codes: number[] = [];
  const text = css.replaceAll(/\r\n?|\f/gu, "\n");
  for (const char of text) {
    const code = char.codePointAt(0) ?? replacement;
    codes.push(
      code === 0 || (code >= 0xd8_00 && code <= 0xdf_ff) ? replacement : code
    );
  }
  return codes;
};

/** Tokens of one code point each. */
const punctuationTokens: Readonly<Record<string, CssToken["type"]>> = {
  "(": "(",
  ")": ")",
  ":": ":",
  ";": ";",
  ",": ",",
  "[": "[",
  "]": "]",
  "{": "{",
  "}": "}",
};

/** The tokenizer's state over one stylesheet. */
class Tokenizer {
  readonly #codes: number[];
  #at = 0;

  constructor(css: string) {
    this.#codes = preprocess(css);
  }

  #peek(ahead = 0): number | undefined {
    return this.#codes[this.#at + ahead];
  }

  #next(): number | undefined {
    const code = this.#codes[this.#at];
    this.#at += 1;
    return code;
  }

  /** §4.3.7, after the backslash. */
  #escape(): string {
    const code = this.#next();
    if (code === undefined) {
      return String.fromCodePoint(replacement);
    }
    if (!isHex(code)) {
      return String.fromCodePoint(code);
    }
    let hex = String.fromCodePoint(code);
    while (hex.length < 6 && isHex(this.#peek())) {
      hex += String.fromCodePoint(this.#next() ?? 0);
    }
    if (isWhitespace(this.#peek())) {
      this.#at += 1;
    }
    const value = Number.parseInt(hex, 16);
    const invalid =
      value === 0 ||
      (value >= 0xd8_00 && value <= 0xdf_ff) ||
      value > 0x10_ff_ff;
    return String.fromCodePoint(invalid ? replacement : value);
  }

  /** §4.3.11. */
  #name(): string {
    let name = "";
    for (;;) {
      const code = this.#peek();
      if (isName(code)) {
        name += String.fromCodePoint(this.#next() ?? 0);
      } else if (isValidEscape(code, this.#peek(1))) {
        this.#at += 1;
        name += this.#escape();
      } else {
        return name;
      }
    }
  }

  /** §4.3.12 and §4.3.3: a number, percentage or dimension. */
  #numeric(): CssToken {
    if (this.#peek() === 0x2b || this.#peek() === 0x2d) {
      this.#at += 1;
    }
    while (isDigit(this.#peek())) {
      this.#at += 1;
    }
    if (this.#peek() === 0x2e && isDigit(this.#peek(1))) {
      this.#at += 2;
      while (isDigit(this.#peek())) {
        this.#at += 1;
      }
    }
    const exponent = this.#peek() === 0x45 || this.#peek() === 0x65;
    const signed = this.#peek(1) === 0x2b || this.#peek(1) === 0x2d;
    if (exponent && isDigit(this.#peek(signed ? 2 : 1))) {
      this.#at += signed ? 3 : 2;
      while (isDigit(this.#peek())) {
        this.#at += 1;
      }
    }
    if (startsIdent(this.#peek(), this.#peek(1), this.#peek(2))) {
      this.#name();
    } else if (this.#peek() === 0x25) {
      this.#at += 1;
    }
    return { type: "numeric", value: "" };
  }

  /** §4.3.14: what is left of a bad URL. */
  #badUrlRemnants(): void {
    for (;;) {
      const code = this.#next();
      if (code === undefined || code === 0x29) {
        return;
      }
      if (isValidEscape(code, this.#peek())) {
        this.#escape();
      }
    }
  }

  /** §4.3.6, after `url(` and its whitespace. */
  #url(): CssToken {
    while (isWhitespace(this.#peek())) {
      this.#at += 1;
    }
    let value = "";
    for (;;) {
      const code = this.#next();
      if (code === undefined || code === 0x29) {
        return { type: "url", value };
      }
      if (isWhitespace(code)) {
        while (isWhitespace(this.#peek())) {
          this.#at += 1;
        }
        const end = this.#peek();
        if (end === undefined || end === 0x29) {
          this.#at += 1;
          return { type: "url", value };
        }
        this.#badUrlRemnants();
        return { type: "bad-url", value: "" };
      }
      if (
        code === 0x22 ||
        code === 0x27 ||
        code === 0x28 ||
        isNonPrintable(code)
      ) {
        this.#badUrlRemnants();
        return { type: "bad-url", value: "" };
      }
      if (code === backslash) {
        if (!isValidEscape(code, this.#peek())) {
          this.#badUrlRemnants();
          return { type: "bad-url", value: "" };
        }
        value += this.#escape();
      } else {
        value += String.fromCodePoint(code);
      }
    }
  }

  /** §4.3.4. `url(` with a quoted argument is a function, as the spec has it. */
  #identLike(): CssToken {
    const name = this.#name();
    if (name.toLowerCase() === "url" && this.#peek() === 0x28) {
      this.#at += 1;
      while (isWhitespace(this.#peek()) && isWhitespace(this.#peek(1))) {
        this.#at += 1;
      }
      const next = isWhitespace(this.#peek()) ? this.#peek(1) : this.#peek();
      return next === 0x22 || next === 0x27
        ? { type: "function", value: name }
        : this.#url();
    }
    if (this.#peek() === 0x28) {
      this.#at += 1;
      return { type: "function", value: name };
    }
    return { type: "ident", value: name };
  }

  /** §4.3.5, after the opening quote. */
  #string(ending: number): CssToken {
    let value = "";
    for (;;) {
      const code = this.#peek();
      if (code === undefined) {
        return { type: "string", value };
      }
      if (code === newline) {
        return { type: "bad-string", value: "" };
      }
      this.#at += 1;
      if (code === ending) {
        return { type: "string", value };
      }
      if (code === backslash) {
        const following = this.#peek();
        if (following === newline) {
          this.#at += 1;
        } else if (following !== undefined) {
          value += this.#escape();
        }
      } else {
        value += String.fromCodePoint(code);
      }
    }
  }

  /** §4.3.2: comments go, so what one splits stays split. */
  #comments(): void {
    while (this.#peek() === 0x2f && this.#peek(1) === 0x2a) {
      this.#at += 2;
      while (
        this.#peek() !== undefined &&
        !(this.#peek() === 0x2a && this.#peek(1) === 0x2f)
      ) {
        this.#at += 1;
      }
      this.#at = Math.min(this.#at + 2, this.#codes.length);
    }
  }

  #delimOrNumeric(code: number): CssToken {
    if (startsNumber(code, this.#peek(1), this.#peek(2))) {
      return this.#numeric();
    }
    this.#at += 1;
    return { type: "delim", value: String.fromCodePoint(code) };
  }

  /** §4.3.1: the next token, or undefined at the end. */
  // oxlint-disable-next-line complexity -- one branch per kind of token, as §4.3.1 lists them
  next(): CssToken | undefined {
    this.#comments();
    const code = this.#peek();
    if (code === undefined) {
      return undefined;
    }
    if (isWhitespace(code)) {
      while (isWhitespace(this.#peek())) {
        this.#at += 1;
      }
      return { type: "whitespace", value: " " };
    }
    if (code === 0x22 || code === 0x27) {
      this.#at += 1;
      return this.#string(code);
    }
    const single = String.fromCodePoint(code);
    const punctuation = punctuationTokens[single];
    if (punctuation !== undefined) {
      this.#at += 1;
      return { type: punctuation, value: single };
    }
    if (code === 0x23) {
      this.#at += 1;
      if (isName(this.#peek()) || isValidEscape(this.#peek(), this.#peek(1))) {
        return { type: "hash", value: this.#name() };
      }
      return { type: "delim", value: "#" };
    }
    if (code === 0x2d) {
      if (startsNumber(code, this.#peek(1), this.#peek(2))) {
        return this.#numeric();
      }
      if (this.#peek(1) === 0x2d && this.#peek(2) === 0x3e) {
        this.#at += 3;
        return { type: "cdc", value: "-->" };
      }
      if (startsIdent(code, this.#peek(1), this.#peek(2))) {
        return this.#identLike();
      }
    }
    if (code === 0x2b || code === 0x2e) {
      return this.#delimOrNumeric(code);
    }
    if (
      code === 0x3c &&
      this.#peek(1) === 0x21 &&
      this.#peek(2) === 0x2d &&
      this.#peek(3) === 0x2d
    ) {
      this.#at += 4;
      return { type: "cdo", value: "<!--" };
    }
    if (code === 0x40) {
      this.#at += 1;
      if (startsIdent(this.#peek(), this.#peek(1), this.#peek(2))) {
        return { type: "at-keyword", value: this.#name() };
      }
      return { type: "delim", value: "@" };
    }
    if (isDigit(code)) {
      return this.#numeric();
    }
    if (isNameStart(code) || isValidEscape(code, this.#peek(1))) {
      return this.#identLike();
    }
    this.#at += 1;
    return { type: "delim", value: single };
  }
}

/** A URL a stylesheet fetches, and whether esbuild resolves its position. */
export interface CssFetch {
  url: string;
  /**
   * Whether esbuild resolves URLs in this position (`url()` and
   * `@import`), so a local one names a file of the artifact. It never
   * resolves strings in image functions or `src()`.
   */
  bundled: boolean;
  /**
   * Whether the URL comes from `var()` or `env()`, whose value the build
   * can't know: `url` is then only the function's name.
   */
  computed: boolean;
}

/** Functions whose value is only known where the stylesheet is used. */
const computedFunctions = new Set(["var", "env"]);

/** `cross-fade()`: each argument an image or colour, and a percentage. */
const crossFades = new Set(["cross-fade", "-webkit-cross-fade"]);

/** Whether `closer` ends the innermost open block, `inside`. */
const closes = (closer: string, inside: string | undefined): boolean => {
  if (inside === undefined) {
    return false;
  }
  if (closer === "]") {
    return inside === "[";
  }
  if (closer === "}") {
    return inside === "{";
  }
  return inside !== "[" && inside !== "{";
};

/**
 * A URL as the URL parser takes it from CSS: leading and trailing C0
 * controls and spaces stripped, tabs and newlines anywhere removed.
 */
const asUrl = (value: string): string =>
  value.replaceAll(/[\t\n\r]/gu, "").replaceAll(/^[\0- ]+|[\0- ]+$/gu, "");

/**
 * An open block, a function (by its lowercase name) or a bracket, and
 * where in it the reader is.
 */
interface Block {
  name: string;
  /** Which comma-separated argument, from 0. */
  argument: number;
  /** Which component of that argument, from 0, whitespace aside. */
  component: number;
  /** In `cross-fade()`: the argument's `var()` or `env()`, if any. */
  computed: string | undefined;
  /** In `cross-fade()`: whether something else fills the argument's image. */
  filled: boolean;
}

/** The reader's state over one stylesheet. */
interface Reading {
  found: CssFetch[];
  open: Block[];
  /** In an `@import` prelude, which component of it; else undefined. */
  prelude: number | undefined;
}

/**
 * Whether a token in `block`, where the reader is, is in image position,
 * and if it is, whether esbuild resolves a URL there; undefined where it
 * isn't one:
 * - `url()`: its argument.
 * - `src()`: the first component of its first argument (the rest are
 *   modifiers).
 * - `image-set()`: each option's first component (its resolution and
 *   `type()` follow).
 * - `image()`: its first argument (after it, the fallback colour).
 * - An `@import` prelude: its first component.
 */
const imagePosition = (
  block: Block | undefined,
  prelude: number | undefined
): boolean | undefined => {
  if (block === undefined) {
    return prelude === 0 ? true : undefined;
  }
  const { name, argument, component } = block;
  if (name === "url") {
    return true;
  }
  if (name === "src") {
    return argument === 0 && component === 0 ? false : undefined;
  }
  if (name === "image-set" || name === "-webkit-image-set") {
    return component === 0 ? false : undefined;
  }
  return name === "image" && argument === 0 ? false : undefined;
};

/**
 * Ends an argument of `block`: in `cross-fade()`, a `var()` is its image
 * unless something else (an image or a colour) is; a percentage isn't.
 */
const settle = (reading: Reading, block: Block | undefined): void => {
  if (
    block !== undefined &&
    crossFades.has(block.name) &&
    block.computed !== undefined &&
    !block.filled
  ) {
    reading.found.push({ url: block.computed, bundled: false, computed: true });
  }
  if (block !== undefined) {
    block.computed = undefined;
    block.filled = false;
  }
};

/** What a component token in `block` fetches, if anything. */
const fetchOf = (
  reading: Reading,
  token: CssToken,
  block: Block | undefined
): void => {
  if (token.type === "url") {
    reading.found.push({
      url: asUrl(token.value),
      bundled: true,
      computed: false,
    });
    if (block !== undefined && crossFades.has(block.name)) {
      block.filled = true;
    }
    return;
  }
  const name = token.value.toLowerCase();
  const computed = token.type === "function" && computedFunctions.has(name);
  if (block !== undefined && crossFades.has(block.name)) {
    if (token.type === "string") {
      reading.found.push({
        url: asUrl(token.value),
        bundled: false,
        computed: false,
      });
    }
    if (computed) {
      block.computed ??= `${name}()`;
    } else if (token.type !== "numeric") {
      block.filled = true;
    }
    return;
  }
  if (token.type !== "string" && !computed) {
    return;
  }
  const bundled = imagePosition(block, reading.prelude);
  if (bundled === undefined) {
    return;
  }
  reading.found.push(
    computed
      ? { url: `${name}()`, bundled: false, computed: true }
      : { url: asUrl(token.value), bundled, computed: false }
  );
};

/**
 * Reads a token that separates rather than is a component: whitespace,
 * a closing bracket, a comma, an at-rule's start or end. Whether it was.
 */
const separates = (
  reading: Reading,
  token: CssToken,
  block: Block | undefined
): boolean => {
  const { type } = token;
  if (type === "whitespace") {
    return true;
  }
  if (type === ")" || type === "]" || type === "}") {
    // Only the matching bracket closes a block; any other is a token
    // inside it, as the parser reads it.
    if (closes(type, block?.name)) {
      settle(reading, block);
      reading.open.pop();
    }
    return true;
  }
  if (type === "," && block !== undefined) {
    settle(reading, block);
    block.argument += 1;
    block.component = 0;
    return true;
  }
  // An `@import`'s prelude runs to its `;` or a block.
  if (block === undefined && (type === "at-keyword" || type === ";")) {
    reading.prelude =
      type === "at-keyword" && token.value.toLowerCase() === "import"
        ? 0
        : undefined;
    return true;
  }
  return false;
};

/** Reads one token: what it fetches, and the blocks and positions. */
const read = (reading: Reading, token: CssToken): void => {
  const { type } = token;
  const block = reading.open.at(-1);
  if (separates(reading, token, block)) {
    return;
  }
  fetchOf(reading, token, block);
  if (block !== undefined) {
    block.component += 1;
  } else if (reading.prelude !== undefined) {
    reading.prelude += 1;
  }
  if (type === "{") {
    reading.prelude = undefined;
  }
  if (type === "function" || type === "(" || type === "[" || type === "{") {
    reading.open.push({
      name: type === "function" ? token.value.toLowerCase() : type,
      argument: 0,
      component: 0,
      computed: undefined,
      filled: false,
    });
  }
};

/**
 * Every URL a stylesheet would fetch, from the positions that fetch only
 * (`imagePosition`): `url()` (unquoted or quoted) anywhere, a custom
 * property's value included; `src()`; an `@import` prelude; the image of
 * `image()`, `image-set()` and `-webkit-image-set()`; and the image of
 * each argument of `cross-fade()`. A `var()` or `env()` in one of those
 * positions is a URL the build can't know, `computed`; anywhere else
 * (a resolution, a `type()`, a fallback colour, a percentage) it is
 * nothing fetched.
 */
export const cssFetches = (css: string): CssFetch[] => {
  const reading: Reading = { found: [], open: [], prelude: undefined };
  const tokenizer = new Tokenizer(css);
  for (
    let token = tokenizer.next();
    token !== undefined;
    token = tokenizer.next()
  ) {
    read(reading, token);
  }
  return reading.found;
};

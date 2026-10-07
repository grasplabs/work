/**
 * The source side of workflow expressions: which strings are expressions,
 * the `evaluate` settings, and the profile check every expression passes
 * before jq sees it.
 *
 * The check doesn't evaluate anything and isn't a second jq: jq itself
 * parses and compiles the expression. It tokenizes the source the way jq's
 * lexer does and refuses, by token, everything the profile leaves out:
 * definitions, modules, `try`/`label`/`foreach`, `?`, `..`, assignment
 * operators, formats, comments, string interpolation, `$ENV`, `$__loc__`
 * and every builtin outside the allowlist (jq's CLI build has `input`,
 * `env`, `now`, `debug` and more). It also bounds size and nesting, and
 * checks brackets balance, so the source is exactly one jq expression.
 */

/** The `evaluate` the profile has, and which a definition without one gets. */
export const profileEvaluate = { language: "jq", mode: "strict" } as const;

/**
 * The definition's `evaluate`, with the profile's defaults when it has
 * none; `undefined` when it asks for anything else (another language,
 * loose mode, unknown keys).
 */
export const resolveEvaluate = (
  evaluate?: unknown
): typeof profileEvaluate | undefined => {
  if (evaluate === undefined) {
    return profileEvaluate;
  }
  if (typeof evaluate !== "object" || evaluate === null) {
    return undefined;
  }
  try {
    // Parsed JSON: a plain object, read by its own keys only.
    const prototype: unknown = Object.getPrototypeOf(evaluate);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }
    const settings = new Map<string, unknown>(Object.entries(evaluate));
    const allowedKeys = new Set(["language", "mode"]);
    if ([...settings.keys()].some((key) => !allowedKeys.has(key))) {
      return undefined;
    }
    const language = settings.get("language") ?? "jq";
    const mode = settings.get("mode") ?? "strict";
    return language === "jq" && mode === "strict" ? profileEvaluate : undefined;
  } catch {
    // An object that throws while read (a getter, a proxy) isn't JSON.
    return undefined;
  }
};

// Strict mode: the whole string is `${ ... }`, or it is a literal.
const expressionSlot = /^\$\{(?<source>[\s\S]*)\}$/u;

/**
 * What a string in a definition is: an expression (strict mode: nothing
 * but `${ ... }`) or a literal. Never applied to values at run time:
 * input, model output and connector data are data, whatever they contain.
 */
export const parseSlot = (
  value: string
):
  | { kind: "expression"; source: string }
  | { kind: "literal"; value: string } => {
  const source = expressionSlot.exec(value)?.groups?.source;
  return source === undefined
    ? { kind: "literal", value }
    : { kind: "expression", source: source.trim() };
};

/** Limits of one expression's source. */
export const sourceLimits = {
  maxBytes: 4096,
  /** Brackets, braces, parentheses and `if … end` together. */
  maxNesting: 32,
  /** Of a strptime/strftime format, which must be a literal. */
  maxDateFormatBytes: 64,
} as const;

/**
 * The builtins the profile allows, with the arities each may be called
 * with. `split/2` is left out: it takes a regular expression.
 */
export const builtinAllowlist: Readonly<Record<string, readonly number[]>> = {
  map: [1],
  map_values: [1],
  select: [1],
  length: [0],
  keys: [0],
  has: [1],
  sort: [0],
  sort_by: [1],
  unique: [0],
  unique_by: [1],
  group_by: [1],
  add: [0, 1],
  range: [1, 2, 3],
  tostring: [0],
  tonumber: [0],
  type: [0],
  contains: [1],
  startswith: [1],
  endswith: [1],
  split: [1],
  join: [1],
  ascii_downcase: [0],
  ascii_upcase: [0],
  reverse: [0],
  flatten: [0, 1],
  min: [0],
  max: [0],
  min_by: [1],
  // Boolean negation: jq has it as a builtin, not an operator.
  not: [0],
  max_by: [1],
  getpath: [1],
  setpath: [2],
  del: [1],
  fromdateiso8601: [0],
  todateiso8601: [0],
  strptime: [1],
  strftime: [1],
};

// Keywords the grammar of the profile uses, and jq's literal names.
const allowedKeywords = new Set([
  "if",
  "then",
  "elif",
  "else",
  "end",
  "as",
  "reduce",
  "and",
  "or",
]);
const literalNames = new Set(["true", "false", "null"]);
// jq keywords outside the profile: definitions, modules, error handling,
// labels, foreach and the source location.
const refusedKeywords = new Set([
  "def",
  "import",
  "include",
  "module",
  "try",
  "catch",
  "label",
  "foreach",
  "__loc__",
]);
// Variables jq's CLI binds itself: its environment and arguments.
const refusedVariables = new Set(["ENV", "ARGS"]);

/**
 * strptime runs as JavaScript in jq's Emscripten runtime, outside the
 * fuel meter, and builds a regular expression from its format; a format
 * from data, or one that repeats whitespace directives, could make that
 * backtrack. So both date formats must be short literals of these
 * directives: no %n, %t, %c, %r or locale forms.
 */
const dateDirectives = new Set("YmdHMSjeyCbBaAhpIUWwzZTFDR%");

type TokenKind = "ident" | "field" | "variable" | "number" | "string" | "punct";
interface Token {
  kind: TokenKind;
  text: string;
}

/** Why the source was refused; `code` names the expression error. */
export interface SourceProblem {
  code: "too_large" | "too_deep" | "invalid" | "unsupported";
  reason: string;
}

export interface CheckedSource {
  /** Variables the source reads that it doesn't bind itself with `as`. */
  freeVariables: string[];
}

const identStart = /[A-Za-z_]/u;
const identPart = /[A-Za-z0-9_]/u;
const digit = /[0-9]/u;
const whitespace = new Set([" ", "\t", "\n", "\r"]);
const numberLiteral = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/u;
const stringEscapes = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const hexDigits = /^[0-9A-Fa-f]{4}$/u;
// Longest first, so `//` wins over `/` and `==` over `=`.
const operators = [
  "|=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "//=",
  "?//",
  "==",
  "!=",
  "<=",
  ">=",
  "//",
  "|",
  ",",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "=",
  ";",
  ":",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "?",
  "..",
].toSorted((a, b) => b.length - a.length);
const refusedOperators = new Set([
  "|=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "//=",
  "?//",
  "=",
  "?",
  "..",
]);

class SourceError extends Error {
  readonly problem: SourceProblem;

  constructor(code: SourceProblem["code"], reason: string) {
    super(reason);
    this.name = "SourceError";
    this.problem = { code, reason };
  }
}

const readString = (source: string, start: number): number => {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      return index + 1;
    }
    if (char !== undefined && char < " ") {
      throw new SourceError(
        "invalid",
        "a raw control character in a string; escape it"
      );
    }
    if (char === "\\") {
      const escape = source[index + 1];
      if (escape === "(") {
        throw new SourceError("unsupported", "string interpolation");
      }
      if (escape === "u") {
        if (!hexDigits.test(source.slice(index + 2, index + 6))) {
          throw new SourceError(
            "invalid",
            "a \\u escape needs four hex digits"
          );
        }
        index += 6;
        continue;
      }
      if (escape === undefined || !stringEscapes.has(escape)) {
        throw new SourceError("invalid", "an unknown string escape");
      }
      index += 2;
      continue;
    }
    index += 1;
  }
  throw new SourceError("invalid", "an unterminated string");
};

const readIdent = (source: string, start: number): number => {
  let index = start + 1;
  while (index < source.length && identPart.test(source[index] ?? "")) {
    index += 1;
  }
  if (source.startsWith("::", index)) {
    throw new SourceError("unsupported", "module-qualified names");
  }
  return index;
};

const operatorAt = (source: string, index: number): string | undefined =>
  operators.find((candidate) => source.startsWith(candidate, index));

/** A number, field, variable or identifier at `index`, if one starts there. */
const readWord = (
  source: string,
  index: number
): { token: Token; end: number } | undefined => {
  const char = source[index] ?? "";
  const next = source[index + 1] ?? "";
  if (digit.test(char) || (char === "." && digit.test(next))) {
    const text = numberLiteral.exec(source.slice(index))?.[0] ?? char;
    if (!Number.isFinite(Number(text))) {
      throw new SourceError("unsupported", "a number literal out of range");
    }
    return { token: { kind: "number", text }, end: index + text.length };
  }
  if (char === "." && identStart.test(next)) {
    const end = readIdent(source, index + 1);
    return { token: { kind: "field", text: source.slice(index, end) }, end };
  }
  if (char === "$") {
    if (!identStart.test(next)) {
      throw new SourceError("invalid", "a $ without a variable name");
    }
    const end = readIdent(source, index + 1);
    const name = source.slice(index + 1, end);
    if (name.startsWith("__") || refusedVariables.has(name)) {
      throw new SourceError("unsupported", `the variable $${name}`);
    }
    return { token: { kind: "variable", text: name }, end };
  }
  if (identStart.test(char)) {
    const end = readIdent(source, index);
    return { token: { kind: "ident", text: source.slice(index, end) }, end };
  }
  return undefined;
};

/** The token at `index` and where it ends; no token for whitespace. */
const readToken = (
  source: string,
  index: number
): { token?: Token; end: number } => {
  const char = source[index] ?? "";
  if (whitespace.has(char)) {
    return { end: index + 1 };
  }
  if (char === "#") {
    throw new SourceError("unsupported", "comments");
  }
  if (char === "@") {
    throw new SourceError("unsupported", "formats such as @base64");
  }
  if (char === '"') {
    const end = readString(source, index);
    return { token: { kind: "string", text: source.slice(index, end) }, end };
  }
  const word = readWord(source, index);
  if (word !== undefined) {
    return word;
  }
  const operator = operatorAt(source, index);
  if (operator !== undefined) {
    if (refusedOperators.has(operator)) {
      throw new SourceError("unsupported", `the ${operator} operator`);
    }
    return {
      token: { kind: "punct", text: operator },
      end: index + operator.length,
    };
  }
  if (char === ".") {
    return { token: { kind: "punct", text: "." }, end: index + 1 };
  }
  throw new SourceError("invalid", "a character jq doesn't accept here");
};

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const { token, end } = readToken(source, index);
    if (token !== undefined) {
      tokens.push(token);
    }
    index = end;
  }
  return tokens;
};

/** The argument count of a call whose name is at `index`. */
const arityAt = (tokens: readonly Token[], index: number): number => {
  if (tokens[index + 1]?.text !== "(") {
    return 0;
  }
  let depth = 0;
  let arguments_ = 1;
  for (const token of tokens.slice(index + 1)) {
    if (token.kind !== "punct") {
      continue;
    }
    if (["(", "[", "{"].includes(token.text)) {
      depth += 1;
    } else if ([")", "]", "}"].includes(token.text)) {
      depth -= 1;
      if (depth === 0) {
        return arguments_;
      }
    } else if (token.text === ";" && depth === 1) {
      arguments_ += 1;
    }
  }
  return arguments_;
};

const checkDateFormat = (tokens: readonly Token[], index: number): void => {
  const name = tokens[index]?.text;
  const format = tokens[index + 2];
  if (format?.kind !== "string" || tokens[index + 3]?.text !== ")") {
    throw new SourceError(
      "unsupported",
      `${name} with a format that isn't a string literal`
    );
  }
  let text: unknown;
  try {
    text = JSON.parse(format.text);
  } catch {
    throw new SourceError(
      "invalid",
      `${name} with a format that isn't JSON text`
    );
  }
  if (typeof text !== "string") {
    throw new SourceError(
      "invalid",
      `${name} with a format that isn't a string`
    );
  }
  if (new TextEncoder().encode(text).length > sourceLimits.maxDateFormatBytes) {
    throw new SourceError("unsupported", `${name} with a format over 64 bytes`);
  }
  for (let position = 0; position < text.length; position += 1) {
    if (text[position] !== "%") {
      continue;
    }
    const directive = text[position + 1];
    if (directive === undefined || !dateDirectives.has(directive)) {
      throw new SourceError(
        "unsupported",
        `the date directive %${directive ?? ""}`
      );
    }
    position += 1;
  }
};

/**
 * The variables bound by `as` patterns anywhere in the source. `words`
 * holds the positions of identifiers that aren't object keys (from
 * checkStructure), so a key named `as`, as in `{as: $x}`, binds nothing.
 * A pattern runs to the `|` of `… as $x | …`, or the `(` of reduce; inside
 * it, a computed key `(…)` reads variables rather than binding them.
 */
const boundVariables = (
  tokens: readonly Token[],
  words: ReadonlySet<number>
): Set<string> => {
  const bound = new Set<string>();
  for (const [index, token] of tokens.entries()) {
    if (token.text !== "as" || !words.has(index)) {
      continue;
    }
    let brackets = 0;
    let parentheses = 0;
    for (const patternToken of tokens.slice(index + 1)) {
      if (patternToken.kind === "variable") {
        if (parentheses === 0) {
          bound.add(patternToken.text);
        }
        continue;
      }
      if (patternToken.kind !== "punct") {
        continue;
      }
      const atTop = brackets === 0 && parentheses === 0;
      if (atTop && (patternToken.text === "|" || patternToken.text === "(")) {
        break;
      }
      if (patternToken.text === "[" || patternToken.text === "{") {
        brackets += 1;
      } else if (patternToken.text === "]" || patternToken.text === "}") {
        brackets -= 1;
      } else if (patternToken.text === "(") {
        parentheses += 1;
      } else if (patternToken.text === ")") {
        parentheses -= 1;
      }
    }
  }
  return bound;
};

const checkIdentifier = (tokens: readonly Token[], index: number): void => {
  const name = tokens[index]?.text ?? "";
  if (refusedKeywords.has(name)) {
    throw new SourceError("unsupported", `the ${name} keyword`);
  }
  if (allowedKeywords.has(name) || literalNames.has(name)) {
    return;
  }
  const arity = arityAt(tokens, index);
  if (builtinAllowlist[name]?.includes(arity) !== true) {
    throw new SourceError("unsupported", `the builtin ${name}/${arity}`);
  }
  if (name === "strptime" || name === "strftime") {
    checkDateFormat(tokens, index);
  }
};

/**
 * Whether the identifier at `index` is an object key (`{a: …}`, `{a}`,
 * keywords included), not a keyword or a call. `scopes` holds what
 * encloses it: brackets and `if … end`. A key starts a member of the
 * innermost enclosing object: right after its `{`, or after a `,` with
 * the object itself innermost. Inside `if … end`, `(…)` or `[…]` within
 * the object, a `,` separates outputs, not members, so what follows it is
 * never a key. A member's value is a term or pipe of terms (jq's grammar
 * has no bare `,` there), so a `,` directly in an object separates members.
 */
const isObjectKey = (
  tokens: readonly Token[],
  index: number,
  scopes: readonly string[]
): boolean => {
  const before = tokens[index - 1];
  const after = tokens[index + 1];
  const startsMember =
    scopes.at(-1) === "{" &&
    before?.kind === "punct" &&
    (before.text === "{" || before.text === ",");
  return (
    startsMember &&
    after?.kind === "punct" &&
    (after.text === ":" || after.text === "," || after.text === "}")
  );
};

const opening = new Set(["(", "[", "{"]);
const closing: Readonly<Record<string, string>> = {
  ")": "(",
  "]": "[",
  "}": "{",
  end: "if",
};

/**
 * One pass over the tokens with what encloses each: brackets and
 * `if … end` must balance within the nesting limit, and every identifier
 * that isn't an object key must be an allowed keyword or builtin. Both
 * checks share the one view of the structure, so no construct can make an
 * identifier look like a key to one and a call to jq. Returns the positions
 * of the identifiers that aren't keys, for the other checks to share too.
 */
const checkStructure = (tokens: readonly Token[]): Set<number> => {
  const scopes: string[] = [];
  const words = new Set<number>();
  for (const [index, token] of tokens.entries()) {
    const isWord =
      token.kind === "ident" && !isObjectKey(tokens, index, scopes);
    if (isWord) {
      words.add(index);
      checkIdentifier(tokens, index);
    }
    const opens =
      (token.kind === "punct" && opening.has(token.text)) ||
      (isWord && token.text === "if");
    const closes =
      (token.kind === "punct" && Object.hasOwn(closing, token.text)) ||
      (isWord && token.text === "end");
    if (opens) {
      scopes.push(token.text);
      if (scopes.length > sourceLimits.maxNesting) {
        throw new SourceError("too_deep", "nesting deeper than 32 levels");
      }
    } else if (closes && scopes.pop() !== closing[token.text]) {
      throw new SourceError("invalid", "unbalanced brackets or if … end");
    }
  }
  if (scopes.length > 0) {
    throw new SourceError("invalid", "unbalanced brackets or if … end");
  }
  return words;
};

/**
 * Checks `source` against the profile; the free variables it reads, or the
 * problem. Pure, and bounded by the source's size.
 */
export const checkSource = (
  source: string
):
  | { ok: true; source: CheckedSource }
  | { ok: false; problem: SourceProblem } => {
  try {
    if (new TextEncoder().encode(source).length > sourceLimits.maxBytes) {
      throw new SourceError("too_large", "source over 4096 bytes");
    }
    const tokens = tokenize(source);
    if (tokens.length === 0) {
      throw new SourceError("invalid", "an empty expression");
    }
    const words = checkStructure(tokens);
    const bound = boundVariables(tokens, words);
    const free = new Set<string>();
    for (const token of tokens) {
      if (token.kind === "variable" && !bound.has(token.text)) {
        free.add(token.text);
      }
    }
    return { ok: true, source: { freeVariables: [...free] } };
  } catch (error) {
    if (error instanceof SourceError) {
      return { ok: false, problem: error.problem };
    }
    throw error;
  }
};

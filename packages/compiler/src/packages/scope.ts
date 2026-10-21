/**
 * Whether a package's stylesheet reaches past the package's own elements
 * (spec 20: approved packages follow scoped CSS rules, and only the kit
 * styles the screen). A screen runs in a frame of its own, so no package
 * reaches the host's chrome; but a rule whose selector names no class or
 * id of its own (`*`, `html`, `body`, `:root`, `button`, `[data-slot]`,
 * `.dark a`) restyles every element of the screen it is loaded in, the
 * kit's controls and theme included. A package's own rules name its own
 * classes, as specialist libraries do (`.react-flow__node`, `.rdp-day`).
 *
 * Read with CSS's own tokenizer (css.ts): rules at the top level and in
 * the at-rules that hold rules (`@media`, `@supports`, `@layer`,
 * `@container`, `@scope`, `@document`); never inside `@keyframes`,
 * `@font-face`, `@page`, `@property` or a declaration block.
 */
import { cssTokens } from "./css.ts";
import type { CssToken } from "./css.ts";

/** At-rules whose block holds style rules, read as the stylesheet is. */
const holdingRules = new Set([
  "media",
  "supports",
  "layer",
  "container",
  "scope",
  "document",
  "-moz-document",
  "starting-style",
]);

/** The kit's theme classes, on the screen's root: no package's own. */
const themeClasses = new Set(["dark", "light"]);

/** Functional pseudo-classes whose classes still pick the package's own. */
const keepingScope = new Set(["is", "where", "matches", "-webkit-any"]);

/**
 * The token that closes a function, parenthesis, bracket or brace opened
 * by `type`, if it opens one. A block closes only on its own closer (CSS
 * Syntax §5.4.8): any other closer inside it is a token of it, so `]`
 * never closes `(`, nor `}` a function.
 */
const closerOf = (type: CssToken["type"]): CssToken["type"] | undefined => {
  if (type === "function" || type === "(") {
    return ")";
  }
  if (type === "[") {
    return "]";
  }
  return type === "{" ? "}" : undefined;
};

/**
 * Reads `type` into `expected`, the closers of the blocks open, innermost
 * last: opens a block, or closes the innermost on its own closer.
 */
const track = (expected: CssToken["type"][], type: CssToken["type"]): void => {
  const closer = closerOf(type);
  if (closer !== undefined) {
    expected.push(closer);
  } else if (type === expected.at(-1)) {
    expected.pop();
  }
};

/** A rule's prelude split at its top-level commas: one selector each. */
const selectorsOf = (prelude: readonly CssToken[]): CssToken[][] => {
  const selectors: CssToken[][] = [[]];
  const expected: CssToken["type"][] = [];
  for (const token of prelude) {
    if (token.type === "," && expected.length === 0) {
      selectors.push([]);
      continue;
    }
    track(expected, token.type);
    selectors.at(-1)?.push(token);
  }
  return selectors.filter((selector) =>
    selector.some((token) => token.type !== "whitespace")
  );
};

/** Where the function or bracket opened at `at` closes (or the end). */
const closeOf = (selector: readonly CssToken[], at: number): number => {
  const expected: CssToken["type"][] = [];
  for (let index = at; index < selector.length; index += 1) {
    const type = selector[index]?.type;
    if (type !== undefined) {
      track(expected, type);
    }
    if (expected.length === 0) {
      return index;
    }
  }
  return selector.length;
};

/**
 * Whether one selector, of a selector list, names a class or id of its
 * own. Inside `:is()` and its kin, only when every alternative does
 * (`:is(.x, body)` still picks `body`); inside any other function or an
 * attribute selector, never (`:not(.x)`, `[class=x]`).
 */
const scoped = (selector: readonly CssToken[]): boolean => {
  let at = 0;
  while (at < selector.length) {
    const token = selector[at];
    if (token === undefined) {
      break;
    }
    if (closerOf(token.type) !== undefined) {
      const end = closeOf(selector, at);
      if (
        token.type === "function" &&
        keepingScope.has(token.value.toLowerCase())
      ) {
        const alternatives = selectorsOf(selector.slice(at + 1, end));
        if (alternatives.length > 0 && alternatives.every(scoped)) {
          return true;
        }
      }
      at = end + 1;
      continue;
    }
    if (token.type === "hash") {
      return true;
    }
    const next = selector[at + 1];
    if (
      token.type === "delim" &&
      token.value === "." &&
      next?.type === "ident" &&
      !themeClasses.has(next.value.toLowerCase())
    ) {
      return true;
    }
    at += 1;
  }
  return false;
};

/** How a token is written back, where it isn't its value alone. */
const written: Partial<Record<CssToken["type"], (value: string) => string>> = {
  whitespace: () => " ",
  function: (value) => `${value}(`,
  hash: (value) => `#${value}`,
  "at-keyword": (value) => `@${value}`,
  string: (value) => JSON.stringify(value),
};

/** A prelude's tokens as text, for a refusal to quote. */
const textOf = (tokens: readonly CssToken[]): string =>
  tokens
    .map(({ type, value }) => {
      const write = written[type];
      if (write !== undefined) {
        return write(value);
      }
      return value === "" ? type : value;
    })
    .join("")
    .replaceAll(/\s+/gu, " ")
    .trim();

/** What the reader is in: a list of rules, or a block it skips whole. */
type Level = "rules" | "skip";

/** Where the reader is in a stylesheet. */
interface Reading {
  /** Unscoped selectors found, as written. */
  found: Set<string>;
  /** Open blocks, innermost last; the stylesheet itself holds rules. */
  levels: Level[];
  /** The prelude being read at a level of rules. */
  prelude: CssToken[];
  /** The at-rule the prelude is of, if any. */
  atRule: string | undefined;
  /** The closers of the blocks open within the prelude, innermost last. */
  expected: CssToken["type"][];
  /** The closers of the blocks open within a block skipped whole. */
  skipping: CssToken["type"][];
}

const blank = new Set<CssToken["type"]>(["whitespace", "cdo", "cdc"]);

/** Inside a block skipped whole, which ends on its own `}` alone. */
const skip = (reading: Reading, { type }: CssToken): void => {
  track(reading.skipping, type);
  if (reading.skipping.length === 0) {
    reading.levels.pop();
  }
};

/** A rule's end or a block's: the prelude starts again. */
const restart = (reading: Reading): void => {
  reading.prelude = [];
  reading.atRule = undefined;
};

/** A block opens after the prelude read: an at-rule's, or a style rule's. */
const open = (reading: Reading): void => {
  const { atRule, prelude } = reading;
  if (atRule === undefined) {
    for (const selector of selectorsOf(prelude)) {
      if (!scoped(selector)) {
        reading.found.add(textOf(selector).slice(0, 120));
      }
    }
  }
  // A style rule's block holds declarations, and nested rules the
  // selector around them already scopes or doesn't: skipped whole, as an
  // at-rule's block is unless it holds rules.
  const holds = atRule !== undefined && holdingRules.has(atRule);
  reading.levels.push(holds ? "rules" : "skip");
  reading.skipping = holds ? [] : ["}"];
  restart(reading);
};

/** Whether `token` starts a rule, as an at-rule's name or blank before one. */
const starts = (reading: Reading, token: CssToken): boolean => {
  if (reading.prelude.length > 0 || reading.atRule !== undefined) {
    return false;
  }
  if (token.type === "at-keyword") {
    reading.atRule = token.value.toLowerCase();
    return true;
  }
  return blank.has(token.type);
};

/** One token at a level of rules. */
const inRules = (reading: Reading, token: CssToken): void => {
  const { expected } = reading;
  if (token.type === "}" && expected.length === 0) {
    reading.levels.pop();
    restart(reading);
    return;
  }
  if (starts(reading, token)) {
    return;
  }
  if (expected.length === 0 && token.type === "{") {
    open(reading);
  } else if (expected.length === 0 && token.type === ";") {
    // An at-rule with no block (`@import`, `@layer a;`): nothing selected.
    restart(reading);
  } else {
    track(expected, token.type);
    reading.prelude.push(token);
  }
};

/**
 * Every selector of a stylesheet's style rules that names no class or id
 * of its own, as written (trimmed to 120 characters), at most `limit`.
 */
export const unscopedInCss = (css: string, limit = 50): string[] => {
  const reading: Reading = {
    found: new Set(),
    levels: [],
    prelude: [],
    atRule: undefined,
    expected: [],
    skipping: [],
  };
  for (const token of cssTokens(css)) {
    if (reading.found.size >= limit) {
      break;
    }
    if (reading.levels.at(-1) === "skip") {
      skip(reading, token);
    } else {
      inRules(reading, token);
    }
  }
  return [...reading.found].slice(0, limit);
};

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

/** Tokens that open a function, a parenthesis or a bracket. */
const opening = new Set<CssToken["type"]>(["function", "(", "["]);

/** Tokens that close one. */
const closing = new Set<CssToken["type"]>([")", "]"]);

/** A rule's prelude split at its top-level commas: one selector each. */
const selectorsOf = (prelude: readonly CssToken[]): CssToken[][] => {
  const selectors: CssToken[][] = [[]];
  let depth = 0;
  for (const token of prelude) {
    if (token.type === "function" || token.type === "(" || token.type === "[") {
      depth += 1;
    } else if (token.type === ")" || token.type === "]") {
      depth -= 1;
    } else if (token.type === "," && depth === 0) {
      selectors.push([]);
      continue;
    }
    selectors.at(-1)?.push(token);
  }
  return selectors.filter((selector) =>
    selector.some((token) => token.type !== "whitespace")
  );
};

/** Where the function or bracket opened at `at` closes (or the end). */
const closeOf = (selector: readonly CssToken[], at: number): number => {
  let depth = 0;
  for (let index = at; index < selector.length; index += 1) {
    const type = selector[index]?.type;
    if (type !== undefined && opening.has(type)) {
      depth += 1;
    } else if (type !== undefined && closing.has(type)) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
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
    if (opening.has(token.type)) {
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
  /** Brackets and functions open within the prelude. */
  nested: number;
}

const blank = new Set<CssToken["type"]>(["whitespace", "cdo", "cdc"]);

/** Inside a block skipped whole: only its own blocks count. */
const skip = (reading: Reading, { type }: CssToken): void => {
  if (type === "{") {
    reading.levels.push("skip");
  } else if (type === "}") {
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
  reading.levels.push(
    atRule !== undefined && holdingRules.has(atRule) ? "rules" : "skip"
  );
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
  if (token.type === "}" && reading.nested === 0) {
    reading.levels.pop();
    restart(reading);
    return;
  }
  if (starts(reading, token)) {
    return;
  }
  if (opening.has(token.type)) {
    reading.nested += 1;
  } else if (closing.has(token.type) && reading.nested > 0) {
    reading.nested -= 1;
  }
  if (reading.nested > 0 || (token.type !== "{" && token.type !== ";")) {
    reading.prelude.push(token);
  } else if (token.type === ";") {
    // An at-rule with no block (`@import`, `@layer a;`): nothing selected.
    restart(reading);
  } else {
    open(reading);
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
    nested: 0,
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

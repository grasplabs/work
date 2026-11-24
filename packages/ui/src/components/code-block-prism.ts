// Prism for CodeBlock (code-block.tsx), in the browser only: its core and each language are loaded
// the first time a block asks for them, never up front. The code is tokenized into runs that are
// drawn as React elements, so nothing reaches the page as HTML.
//
// Prism 1.30.0, pinned. Its language files read a global `Prism`, so the core is put on globalThis
// before any of them loads.
// oxlint-disable-next-line typescript/triple-slash-reference -- Prism's language files have no types and nothing to import: it brings their declaration to every program this file is in
/// <reference path="./code-block-grammars.d.ts" />
import type * as PrismTypes from "prismjs";

import { ownValue } from "../lib/utils";

type PrismModule = typeof PrismTypes;
type Grammar = PrismTypes.Grammar;
type PrismToken = PrismTypes.Token;

/** Prism and one language's grammar, once both have loaded. */
export interface Highlight {
  Prism: PrismModule;
  grammar: Grammar;
}

/** A run of code and what Prism says it is ("keyword", "string"), outermost first. */
export interface Segment {
  text: string;
  types: string[];
}

/** One line of code: its runs, in order. */
export type Line = Segment[];

// The languages a block can name, by the names people write, each with the Prism files it needs
// in order. The core already holds markup, css, clike and javascript.
const files: Record<string, () => Promise<void>> = {
  typescript: async () => {
    await import("prismjs/components/prism-typescript.js");
  },
  jsx: async () => {
    await import("prismjs/components/prism-jsx.js");
  },
  tsx: async () => {
    await import("prismjs/components/prism-tsx.js");
  },
  json: async () => {
    await import("prismjs/components/prism-json.js");
  },
  bash: async () => {
    await import("prismjs/components/prism-bash.js");
  },
  python: async () => {
    await import("prismjs/components/prism-python.js");
  },
  markdown: async () => {
    await import("prismjs/components/prism-markdown.js");
  },
  yaml: async () => {
    await import("prismjs/components/prism-yaml.js");
  },
  sql: async () => {
    await import("prismjs/components/prism-sql.js");
  },
  diff: async () => {
    await import("prismjs/components/prism-diff.js");
  },
  go: async () => {
    await import("prismjs/components/prism-go.js");
  },
  rust: async () => {
    await import("prismjs/components/prism-rust.js");
  },
};

const needs: Record<string, string[]> = {
  ts: ["typescript"],
  typescript: ["typescript"],
  tsx: ["jsx", "typescript", "tsx"],
  jsx: ["jsx"],
  js: [],
  javascript: [],
  html: [],
  markup: [],
  xml: [],
  svg: [],
  css: [],
  json: ["json"],
  bash: ["bash"],
  sh: ["bash"],
  shell: ["bash"],
  python: ["python"],
  py: ["python"],
  markdown: ["markdown"],
  md: ["markdown"],
  yaml: ["yaml"],
  yml: ["yaml"],
  sql: ["sql"],
  diff: ["diff"],
  go: ["go"],
  rust: ["rust"],
};

// The Prism grammar's own name, where people write another.
const grammarName: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  html: "markup",
  xml: "markup",
  svg: "markup",
  sh: "bash",
  shell: "bash",
  py: "python",
  md: "markdown",
  yml: "yaml",
};

/** The language's name as a person reads it, for the block's header; plain text's is a word (i18n). */
export const languageNames: Record<string, string> = {
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  jsx: "JSX",
  js: "JavaScript",
  javascript: "JavaScript",
  html: "HTML",
  markup: "HTML",
  xml: "XML",
  svg: "SVG",
  css: "CSS",
  json: "JSON",
  bash: "Bash",
  sh: "Shell",
  shell: "Shell",
  python: "Python",
  py: "Python",
  markdown: "Markdown",
  md: "Markdown",
  yaml: "YAML",
  yml: "YAML",
  sql: "SQL",
  diff: "Diff",
  go: "Go",
  rust: "Rust",
};

let core: Promise<PrismModule> | undefined;
const loaded = new Map<string, Promise<void>>();

/** Whether `value` is Prism itself: the module's default where a bundler wraps it. */
const isPrism = (value: unknown): value is PrismModule =>
  typeof value === "object" &&
  value !== null &&
  "tokenize" in value &&
  "languages" in value;

// One Prism on the page. Each language file runs once, into whichever Prism is the global then: with
// two (another part of the page that loaded its own), a file the other loaded first never reaches
// this one, and its blocks stay plain. So a Prism already on the page is taken as it is, before
// loading this one and after.
const startCore = async (): Promise<PrismModule> => {
  const before: unknown = Reflect.get(globalThis, "Prism");
  if (isPrism(before)) {
    return before;
  }
  // Prism highlights nothing by itself: it waits to be asked.
  Reflect.set(globalThis, "Prism", {
    ...(typeof before === "object" ? before : null),
    manual: true,
  });
  const module = await import("prismjs");
  const now: unknown = Reflect.get(globalThis, "Prism");
  if (isPrism(now)) {
    return now;
  }
  const inner: unknown = "default" in module ? module.default : null;
  const Prism = isPrism(inner) ? inner : module;
  Reflect.set(globalThis, "Prism", Prism);
  return Prism;
};

const loadCore = async (): Promise<PrismModule> => {
  core ??= startCore();
  const attempt = core;
  try {
    return await attempt;
  } catch (error) {
    // A load that failed (a network error, a chunk gone after a deploy) is forgotten, so the next
    // block tries again.
    if (core === attempt) {
      core = undefined;
    }
    throw error;
  }
};

const loadFile = async (file: string): Promise<void> => {
  const load = ownValue(files, file);
  if (!load) {
    return;
  }
  const attempt = loaded.get(file) ?? load();
  loaded.set(file, attempt);
  try {
    await attempt;
  } catch (error) {
    if (loaded.get(file) === attempt) {
      loaded.delete(file);
    }
    throw error;
  }
};

/** One after another: a language's file reads the grammars of those before it. */
const loadInOrder = async (list: string[]): Promise<void> => {
  const [first, ...rest] = list;
  if (first === undefined) {
    return;
  }
  await loadFile(first);
  await loadInOrder(rest);
};

/**
 * Prism and the grammar for `language`, or null when Prism does not know it or it could not be
 * loaded: the code then stays plain.
 */
export const grammarOrNull = async (
  language: string
): Promise<Highlight | null> => {
  const key = language.toLowerCase();
  // The language is a fence's tag, written by whoever wrote the answer: only the tables' own names.
  const list = ownValue(needs, key);
  if (!list) {
    return null;
  }
  try {
    const Prism = await loadCore();
    await loadInOrder(list);
    // `key` is one of the names above, so this never reaches the methods Prism keeps beside them.
    const grammar = Prism.languages[ownValue(grammarName, key) ?? key];
    return grammar ? { Prism, grammar } : null;
  } catch {
    return null;
  }
};

const aliasesOf = (alias: string | string[]): string[] => {
  if (Array.isArray(alias)) {
    return alias;
  }
  return alias ? [alias] : [];
};

// How much of a block is highlighted. Past this many lines or characters the rest is plain: a run
// is a node to draw, and a long file pasted whole would be hundreds of thousands of them.
const HIGHLIGHT_LINES = 1000;
const HIGHLIGHT_CHARS = 50_000;

/** How much of `code` is highlighted: up to a line's end within both bounds. */
const highlightedLength = (code: string): number => {
  let end = -1;
  for (let line = 0; line < HIGHLIGHT_LINES; line += 1) {
    end = code.indexOf("\n", end + 1);
    if (end === -1 || end > HIGHLIGHT_CHARS) {
      break;
    }
  }
  if (end === -1 && code.length <= HIGHLIGHT_CHARS) {
    return code.length;
  }
  if (end === -1 || end > HIGHLIGHT_CHARS) {
    return Math.max(code.lastIndexOf("\n", HIGHLIGHT_CHARS), 0);
  }
  return end;
};

/**
 * The code as lines of runs. Without a grammar, each line is one plain run, and so is each line
 * past what is highlighted.
 */
export const linesOf = (code: string, highlight: Highlight | null): Line[] => {
  const segments: Segment[] = [];
  const walk = (token: string | PrismToken, types: string[]) => {
    if (typeof token === "string") {
      segments.push({ text: token, types });
      return;
    }
    const inner = [...types, token.type, ...aliasesOf(token.alias)];
    const { content } = token;
    if (Array.isArray(content)) {
      for (const part of content) {
        walk(part, inner);
      }
    } else {
      walk(content, inner);
    }
  };
  const highlighted = highlight ? highlightedLength(code) : 0;
  if (highlight) {
    for (const token of highlight.Prism.tokenize(
      code.slice(0, highlighted),
      highlight.grammar
    )) {
      walk(token, []);
    }
  }
  segments.push({ text: code.slice(highlighted), types: [] });
  const lines: Line[] = [[]];
  for (const segment of segments) {
    const parts = segment.text.split("\n");
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        lines.push([]);
      }
      if (part) {
        lines.at(-1)?.push({ text: part, types: segment.types });
      }
    }
  }
  // A last empty line from a trailing newline is not a line of code.
  if (lines.length > 1 && lines.at(-1)?.length === 0) {
    lines.pop();
  }
  return lines;
};

// Prism for a code block (code-block.tsx), in the browser only: its core and each language are
// loaded the first time a block asks for them, never up front. The code is tokenized into a tree
// that is drawn as React elements, so nothing reaches the page as HTML.
//
// Prism 1.30.0 (pinned, as the Artifact viewer's). Its language files read a global `Prism`, so
// the core is put on globalThis before any of them loads.

import type * as PrismTypes from "prismjs";

type PrismModule = typeof PrismTypes;
type Grammar = PrismTypes.Grammar;
type PrismToken = PrismTypes.Token;

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

/** The language's name as a person reads it, for the block's head. */
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
  text: "Text",
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
// two (the Artifact viewer's, when it runs on the page because a Worker cannot start), a file the
// other loaded first never reaches this one, and its blocks stay plain (audit B16). So a Prism
// already on the page is taken as it is, before loading this one and after.
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
  const load = files[file];
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

/** Prism and the grammar for `language`, or null when Prism does not know it. */
export const grammarFor = async (
  language: string
): Promise<{ Prism: PrismModule; grammar: Grammar } | null> => {
  const key = language.toLowerCase();
  const list = needs[key];
  if (!list) {
    return null;
  }
  const Prism = await loadCore();
  await loadInOrder(list);
  const grammar = Prism.languages[grammarName[key] ?? key];
  return grammar ? { Prism, grammar } : null;
};

/** The same, and null where it could not be loaded: the code then stays plain. */
export const grammarOrNull = async (
  language: string
): Promise<{ Prism: PrismModule; grammar: Grammar } | null> => {
  try {
    return await grammarFor(language);
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

/** The code as lines of runs. Without a grammar, each line is one plain run. */
export const linesOf = (
  code: string,
  highlight?: { Prism: PrismModule; grammar: Grammar } | null
): Line[] => {
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
  if (highlight) {
    for (const token of highlight.Prism.tokenize(code, highlight.grammar)) {
      walk(token, []);
    }
  } else {
    segments.push({ text: code, types: [] });
  }
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

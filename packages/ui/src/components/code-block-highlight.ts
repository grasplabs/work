// CodeBlock's highlighting (code-block.tsx), by @pierre/highlights: hand-written lexers compiled to
// WebAssembly, with no regular expressions, so a lexer reads a line in time that grows with the
// line and nothing else (3,000 lines of TypeScript in about a millisecond; a string of 50,000
// characters with no end, which held Prism for seconds, in less than one). It reads on the page.
// Its module loads the first time a block is drawn, never with the page; where WebAssembly is
// refused (a Content Security Policy without 'wasm-unsafe-eval', a browser without it) or the
// module does not load, every block stays plain, and nothing is said.
//
// It gives each run of code the name of what it is (`keyword-import`, `string`), as a CSS variable
// of a theme that has no colours of its own (`cssVariables: true`); those names are turned here
// into Damsko's syntax colours, and the page draws them as text in spans, never as HTML.
//
// 0.5.2 is one module with every language, 161 KB compressed. From 0.6.0 (allowed by the 3-day rule
// from 2026-11-29), load `@pierre/highlights/core` and each language from `langs/*` on demand: a
// change in this file alone.
import type * as Highlights from "@pierre/highlights";

import { ownValue } from "../lib/utils";

type Engine = typeof Highlights;

/**
 * The languages a block names, by the names people write: the name shown over the code, the
 * lexer's name for it, and the extension its file is saved with. Any other language the lexers know
 * is coloured too, named as it is written and saved as `.txt`.
 */
export const languages: Record<
  string,
  { name: string; lang: string; extension: string }
> = {
  ts: { name: "TypeScript", lang: "typescript", extension: "ts" },
  typescript: { name: "TypeScript", lang: "typescript", extension: "ts" },
  tsx: { name: "TSX", lang: "tsx", extension: "tsx" },
  jsx: { name: "JSX", lang: "jsx", extension: "jsx" },
  js: { name: "JavaScript", lang: "javascript", extension: "js" },
  javascript: { name: "JavaScript", lang: "javascript", extension: "js" },
  html: { name: "HTML", lang: "html", extension: "html" },
  markup: { name: "HTML", lang: "html", extension: "html" },
  xml: { name: "XML", lang: "xml", extension: "xml" },
  svg: { name: "SVG", lang: "xml", extension: "svg" },
  css: { name: "CSS", lang: "css", extension: "css" },
  json: { name: "JSON", lang: "json", extension: "json" },
  bash: { name: "Bash", lang: "bash", extension: "sh" },
  sh: { name: "Shell", lang: "bash", extension: "sh" },
  shell: { name: "Shell", lang: "bash", extension: "sh" },
  python: { name: "Python", lang: "python", extension: "py" },
  py: { name: "Python", lang: "python", extension: "py" },
  markdown: { name: "Markdown", lang: "markdown", extension: "md" },
  md: { name: "Markdown", lang: "markdown", extension: "md" },
  yaml: { name: "YAML", lang: "yaml", extension: "yaml" },
  yml: { name: "YAML", lang: "yaml", extension: "yml" },
  sql: { name: "SQL", lang: "sql", extension: "sql" },
  diff: { name: "Diff", lang: "diff", extension: "diff" },
  go: { name: "Go", lang: "go", extension: "go" },
  rust: { name: "Rust", lang: "rust", extension: "rs" },
  rs: { name: "Rust", lang: "rust", extension: "rs" },
  java: { name: "Java", lang: "java", extension: "java" },
  c: { name: "C", lang: "c", extension: "c" },
  cpp: { name: "C++", lang: "cpp", extension: "cpp" },
  "c++": { name: "C++", lang: "cpp", extension: "cpp" },
  csharp: { name: "C#", lang: "csharp", extension: "cs" },
  cs: { name: "C#", lang: "csharp", extension: "cs" },
  "c#": { name: "C#", lang: "csharp", extension: "cs" },
  php: { name: "PHP", lang: "php", extension: "php" },
  ruby: { name: "Ruby", lang: "ruby", extension: "rb" },
  rb: { name: "Ruby", lang: "ruby", extension: "rb" },
  kotlin: { name: "Kotlin", lang: "kotlin", extension: "kt" },
  kt: { name: "Kotlin", lang: "kotlin", extension: "kt" },
  swift: { name: "Swift", lang: "swift", extension: "swift" },
  toml: { name: "TOML", lang: "toml", extension: "toml" },
  docker: { name: "Dockerfile", lang: "dockerfile", extension: "dockerfile" },
  dockerfile: {
    name: "Dockerfile",
    lang: "dockerfile",
    extension: "dockerfile",
  },
};

/** Damsko's syntax colours, one for each kind of run (code-block.tsx draws each in its token). */
export type Tone =
  | "keyword"
  | "string"
  | "constant"
  | "comment"
  | "function"
  | "punctuation"
  | "attribute"
  | "inserted"
  | "deleted";

/**
 * Which colour a run takes, by the lexer's name for it: the longest name here that the run's name
 * starts with, part by part (`keyword-import` is a keyword, `punctuation-bracket-jsx` punctuation).
 * A run with none, such as a variable's name, is in the code's own colour.
 */
const toneOfName = new Map<string, Tone>([
  ["keyword", "keyword"],
  ["preproc", "keyword"],
  ["variable-special", "keyword"],
  ["string", "string"],
  ["text-literal", "string"],
  ["link_uri", "string"],
  ["string-special-symbol", "constant"],
  ["number", "constant"],
  ["boolean", "constant"],
  ["constant", "constant"],
  ["enum", "constant"],
  ["comment", "comment"],
  ["tag-doctype", "comment"],
  ["keyword-jsdoc", "comment"],
  ["type-jsdoc", "comment"],
  ["variable-jsdoc", "comment"],
  ["function", "function"],
  ["constructor", "function"],
  ["type-builtin", "keyword"],
  ["type", "function"],
  ["tag", "function"],
  ["selector", "function"],
  ["title", "function"],
  ["punctuation", "punctuation"],
  ["operator", "punctuation"],
  ["attribute", "attribute"],
  ["property", "attribute"],
  ["diff-plus", "inserted"],
  ["diff-minus", "deleted"],
]);

const PREFIX = "var(--hls-";

const tones = new Map<string, Tone | null>();

/** The colour of a run the lexer gave `color` (`var(--hls-keyword-import)`). */
const toneOf = (color: string | undefined): Tone | null => {
  if (color === undefined) {
    return null;
  }
  const known = tones.get(color);
  if (known !== undefined) {
    return known;
  }
  let name = color.startsWith(PREFIX) ? color.slice(PREFIX.length, -1) : "";
  let found: Tone | null = null;
  while (name !== "" && found === null) {
    found = toneOfName.get(name) ?? null;
    name = name.slice(0, Math.max(name.lastIndexOf("-"), 0));
  }
  tones.set(color, found);
  return found;
};

/** A run of code and its colour; null for the code's own. */
export interface Run {
  text: string;
  tone: Tone | null;
}

/** One line of code: its runs, in order, two side by side never of one colour. */
export type Line = Run[];

/**
 * The most coloured runs the lines a block draws may have: past it, they are all plain. Each
 * coloured run is an element, and drawing them is what takes time now, not reading them (3,000
 * lines are read in about a millisecond): all in one frame when the block opens or its code is
 * given. Measured in Chromium against the same lines drawn as text, each run adds some 3.5 µs, and
 * 10 µs at a 3x slower processor: 5,000, some 1,500 lines of ordinary TypeScript, adds 20 ms to
 * that frame, and 50 ms slowed down; 11,000 (3,000 lines) added 40 ms and 120 ms.
 */
export const MOST_RUNS = 5000;

/**
 * The longest line the lexers colour: a line this long or longer is drawn as its text, one run.
 * Ordinary code has few so long; minified code and generated data have many, and a line of them
 * can be a coloured run at every character (`1,1,1,…`). At this length the 18 lines a block shows
 * folded are at most 4,500 runs, under MOST_RUNS, so a folded block is always coloured: 4,500 such
 * runs add 25 ms to drawing the same lines as text, 75 ms slowed down. Lines of 2,000 characters
 * could be 36,000 runs folded.
 */
export const MOST_LINE = 250;

// The theme: no colours, each run named by a CSS variable.
const theme: Highlights.Theme = {
  name: "damsko",
  appearance: "light",
  style: {},
  cssVariables: true,
};

// The lexers' names for plain text, and for a terminal's output, whose escapes they take out of
// the text: neither is coloured.
const uncoloured = new Set(["plain", "plaintext", "text", "txt", "ansi"]);

/** The lexer's name for a block's language; none for plain text and a language it does not know. */
const langOf = (engine: Engine, language: string) => {
  const key = language.toLowerCase();
  const lang = ownValue(languages, key)?.lang ?? key;
  return !uncoloured.has(lang) && engine.isSupportedLanguage(lang)
    ? lang
    : null;
};

/** The lexer's runs for some lines, as lines of runs in Damsko's colours. */
const linesOf = (lines: Highlights.ThemedToken[][]): Line[] =>
  lines.map((tokens) => {
    const line: Line = [];
    for (const { content, color } of tokens) {
      const tone = toneOf(color);
      const last = line.at(-1);
      if (last?.tone === tone) {
        last.text += content;
      } else if (content !== "") {
        line.push({ text: content, tone });
      }
    }
    return line;
  });

/** How many runs of the lines are drawn in a colour of their own: each is an element. */
export const colouredRuns = (lines: Line[]) => {
  let count = 0;
  for (const line of lines) {
    for (const run of line) {
      if (run.tone !== null) {
        count += 1;
      }
    }
  }
  return count;
};

/**
 * `code` up to its `count`th line's end, the newline that ends it kept (so a blank last line is a
 * line): all of it when it has no more lines than that.
 */
const firstLines = (code: string, count: number): string => {
  let at = -1;
  for (let line = 0; line < count; line += 1) {
    at = code.indexOf("\n", at + 1);
    if (at === -1) {
      return code;
    }
  }
  return code.slice(0, at + 1);
};

/** The first `most` lines of `code`, as text: a last newline ends a line, it does not start one. */
export const plainLines = (code: string, most: number): string[] => {
  const lines = firstLines(code, most).split("\n");
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines.slice(0, most);
};

/**
 * One block's reading of its code: while it is written, a stream that reads only what is new and
 * gives back each line a newline ends, with its own WebAssembly instance (none once it has given
 * up, past MOST_RUNS); once it is done, the lines of the code as read last, kept while the code is
 * the same, `whole` when they are all its lines.
 */
export interface Reading {
  stream: {
    language: string;
    fed: string;
    lines: Line[];
    runs: number;
    tokenizer: Highlights.StreamTokenizer | null;
  } | null;
  done: {
    code: string;
    language: string;
    lines: Line[];
    whole: boolean;
  } | null;
}

export const newReading = (): Reading => ({ stream: null, done: null });

/** Lets the stream and its WebAssembly instance go; the next reading starts a new one. */
export const stopReading = (reading: Reading) => {
  reading.stream?.tokenizer?.dispose();
  reading.stream = null;
};

/**
 * While `code` is written: its first `most` lines a newline has ended, coloured, read by the
 * stream from where it last stopped (a new stream when the code is not what it read and more, or
 * the language changed); null while they are past MOST_RUNS, or the language is not coloured. A
 * render that gives the same code again reads nothing.
 */
export const writtenLines = (
  reading: Reading,
  engine: Engine,
  code: string,
  language: string,
  most: number
): Line[] | null => {
  const lang = langOf(engine, language);
  if (lang === null) {
    stopReading(reading);
    return null;
  }
  let { stream } = reading;
  if (
    stream === null ||
    stream.language !== language ||
    !code.startsWith(stream.fed)
  ) {
    stopReading(reading);
    stream = {
      language,
      fed: "",
      lines: [],
      runs: 0,
      tokenizer: new engine.StreamTokenizer({
        lang,
        theme,
        tokenizeMaxLineLength: MOST_LINE,
      }),
    };
    reading.stream = stream;
  }
  if (stream.runs > MOST_RUNS) {
    return null;
  }
  if (stream.tokenizer !== null && stream.lines.length < most) {
    const more = linesOf(
      stream.tokenizer.pushCode(code.slice(stream.fed.length))
    );
    stream.fed = code;
    stream.runs += colouredRuns(more);
    stream.lines = [...stream.lines, ...more];
    if (stream.runs > MOST_RUNS) {
      // Given up: plain until it is done, and nothing more read.
      stream.tokenizer.dispose();
      stream.tokenizer = null;
      return null;
    }
  }
  return stream.lines.slice(0, most);
};

/**
 * `code` done: its first `most` lines, coloured; null when it is not coloured. Read whole, unless
 * it was written in this block and is what the stream read and more: then the stream reads the
 * rest and ends, and each line it gave stays the same object, so no line already drawn is drawn
 * again.
 */
export const doneLines = (
  reading: Reading,
  engine: Engine,
  code: string,
  language: string,
  most: number
): Line[] | null => {
  const { done, stream } = reading;
  if (
    done !== null &&
    done.code === code &&
    done.language === language &&
    (done.whole || most <= done.lines.length)
  ) {
    return most < done.lines.length ? done.lines.slice(0, most) : done.lines;
  }
  const lang = langOf(engine, language);
  if (lang === null) {
    stopReading(reading);
    return null;
  }
  let lines: Line[];
  let whole = true;
  if (
    stream !== null &&
    stream.tokenizer !== null &&
    stream.language === language &&
    code.startsWith(stream.fed)
  ) {
    const { tokenizer } = stream;
    lines = [
      ...stream.lines,
      ...linesOf(tokenizer.pushCode(code.slice(stream.fed.length))),
      ...linesOf(tokenizer.end()),
    ];
  } else {
    const read = firstLines(code, most);
    whole = read.length === code.length;
    lines = linesOf(
      engine.codeToTokens(read, {
        lang,
        theme,
        tokenizeMaxLineLength: MOST_LINE,
      }).tokens
    );
  }
  // A last empty line from a trailing newline is not a line of code.
  if (lines.length > 1 && lines.at(-1)?.length === 0) {
    lines.pop();
  }
  stopReading(reading);
  // Every line read is kept, so Show more and Show less give the same objects.
  reading.done = { code, language, lines, whole };
  return most < lines.length ? lines.slice(0, most) : lines;
};

// The lexers, once loaded: undefined until then, null where they cannot load.
let engine: Engine | null | undefined;
let loading: Promise<void> | undefined;
const waiting = new Set<() => void>();

/** Loads the lexers, then tells every block waiting. */
const load = async () => {
  try {
    engine = await import("@pierre/highlights");
  } catch {
    // Refused or not loaded: every block stays plain, and nothing is said.
    engine = null;
  }
  for (const each of waiting) {
    each();
  }
};

/**
 * Hears when the lexers are loaded, or cannot be; the first to listen loads them. For
 * `useSyncExternalStore`, by a block as it is first drawn.
 */
export const watchEngine = (heard: () => void) => {
  waiting.add(heard);
  loading ??= load();
  return () => {
    waiting.delete(heard);
  };
};

/** The lexers, once loaded; null until then and where they cannot load. */
export const currentEngine = (): Engine | null => engine ?? null;

/** Before the page is live there are no lexers: the code is drawn plain. */
export const noEngine = (): Engine | null => null;

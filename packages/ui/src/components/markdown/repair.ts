// An answer still being written, made whole, and one cut off, tidied; markdown.tsx draws what
// parse.ts reads of them.
//
// Half-written Markdown flips as its closing mark arrives: `**bol` is two stars and then bold. So
// while an answer streams, what is open at the end of the leaf being written (from its last blank
// line, list item, heading or fence) is closed: code in a sentence, a link, bold, emphasis, a
// strike. What is only the start of something waits for what follows: a last line that is so far
// only a mark, a task's box, a definition, a fence's start or a table's row; a table's head until
// its row of dashes; a bracket that may yet open a link (a reference's words with it), a tag, a
// lone `!`, a backslash, a character's name, marks at the very end; a section's opening until its
// summary is whole; inside a fence, a half-typed closing line. And where what may still change
// starts is said (`complete`), so no address there is handed on (markdown.tsx, handedOf).
//
// Only the end is touched: the result is the source up to `kept`, then the marks that close it. So a
// later prefix only adds to what an earlier one showed, but where a definition arrives: the
// references to it, shown as written, become its link. Every loop moves forward over the leaf being
// written, or over WINDOW characters at the very end, and no pattern here can backtrack beyond
// its length (scripts/check-markdown-patterns.ts), so a repair costs time in step with what it
// reads.
import { codeLines, containersEnd, fenceRun } from "./parse";

/**
 * The source made whole: `text` is `source.slice(0, kept)` and then the marks that close it. What
 * stands before `complete` is as the whole answer will read it; from there on, something is still
 * open (a link, a bracket, a tag, code) or was closed here, so no address there is proven whole.
 * `word` is where the word that ends there starts, after a space, a line's end or a `<`: a bare
 * address in it may still grow.
 */
export interface Repaired {
  text: string;
  kept: number;
  complete: number;
  word: number;
}

/** How far back from the end a bracket or a tag still being written is looked for. */
const WINDOW = 64;
/** The most marks a leaf leaves open: no answer leaves more than a few. */
const MAX_OPEN = 32;
/** The longest line that waits to be whole as a definition, and the longest section opening. */
const MAX_DEFINITION = 256;
const MAX_OPENING = 400;

/** A last line, past its quotes and list items and its spaces at the end, that is so far only a mark: `#`, `-`, `_ _`, `1.`, a fence. */
const ONLY_MARK = /^(?:#{1,6}|[-=*_+][-=*_+ \t]*|\d{1,9}[.)]?|`+|~+)?$/u;
/** A task's box before its words: `[`, `[x]`. */
const TASK = /^\[[ xX]?\]?[ \t]*$/u;
/** A definition still being written: its name, then its target to its line's end. */
const DEFINITION = /^ {0,3}\[[^\]\n]*(?:\]:.*)?$/u;
/** A citation cut before its address, which a stopped answer ends without: `[2`, `[12]`. */
const CUT_CITATION = /!?\[[^\s[\]()`]{0,12}\]?$/u;
/** A tag or a bare address not yet closed by its `>`: `<det`, `<https://exa`. */
const HALF_TAG = /^<[A-Za-z/!?][^\s<>]*(?:\s|$)/u;

const isRow = (line: string) => line.trimStart().startsWith("|");

/** Whether `source` ends inside a fence that has not been closed. */
export const openFence = (source: string): boolean =>
  codeLines(source.split("\n")).open !== "";

/** Whether the character at `at` is escaped: an odd run of backslashes stands before it. */
const isEscaped = (text: string, at: number): boolean => {
  let slashes = 0;
  while (text[at - 1 - slashes] === "\\") {
    slashes += 1;
  }
  return slashes % 2 === 1;
};

/** `body` without the marks at its very end (stars, underscores, tildes, backticks), unless escaped. */
const withoutEndMarks = (body: string): string => {
  let end = body.length;
  while (end > 0 && "*_~`".includes(body[end - 1] ?? "x")) {
    end -= 1;
  }
  return body.slice(0, isEscaped(body, end) ? end + 1 : end);
};

/**
 * Whether a last line still being typed waits: past its quotes and list items it is so far only a
 * mark, a fence's start or a task's box; or it is a table's row, or a definition.
 */
const lastLineWaits = (last: string): boolean => {
  const inner = containersEnd(last);
  const rest = withoutEndMarks(last.slice(inner)).trimEnd();
  return (
    last !== "" &&
    (ONLY_MARK.test(rest) ||
      fenceRun(rest) !== "" ||
      isRow(last) ||
      (inner > 0 && TASK.test(rest)) ||
      (inner === 0 && last.length <= MAX_DEFINITION && DEFINITION.test(last)))
  );
};

/**
 * Where the stream's own words that may show end: before a last line still being typed that is so
 * far only a mark, a task's box, a definition, a fence's start or a table's row; before a table's
 * head until its row of dashes is whole; before a section's opening until its summary is; and in a
 * fence, before a half-typed closing line.
 */
const keptOf = (source: string): number => {
  const start = source.lastIndexOf("\n") + 1;
  const last = source.slice(start);
  const lines = source.slice(0, start).split("\n");
  lines.pop();
  if (codeLines(lines).open !== "") {
    return /^[ \t>]*(?:`+|~+)[ \t]*$/u.test(last) ? start : source.length;
  }
  const blank = source.lastIndexOf("\n\n");
  const block = source.slice(blank === -1 ? 0 : blank + 2);
  if (
    block.startsWith("<details") &&
    block.length <= MAX_OPENING &&
    !block.includes("</summary>")
  ) {
    return source.length - block.length;
  }
  // A table's head: a row with no row above it, until the line after it is a whole row too.
  const head = lines.at(-1) ?? "";
  if (
    (last === "" || isRow(last)) &&
    isRow(head) &&
    !isRow(lines.at(-2) ?? "")
  ) {
    return start - head.length - 1;
  }
  return lastLineWaits(last) ? start : source.length;
};

/** Where the leaf being written starts: past its last blank line, list item's or quote's marks, heading or fence. */
const leafFrom = (text: string): number => {
  const blank = text.lastIndexOf("\n\n");
  let from = blank === -1 ? 0 : blank + 2;
  for (let at = from; at < text.length;) {
    const end = text.indexOf("\n", at);
    const next = end === -1 ? text.length : end + 1;
    const line = text.slice(at, next);
    const inner = containersEnd(line);
    if (fenceRun(line.slice(inner)) !== "") {
      from = next;
    } else if (line.startsWith("#")) {
      from = at;
    } else if (inner > 0) {
      from = at + inner;
    }
    at = next;
  }
  return from;
};

const isSpace = (char: string | undefined) =>
  char === undefined || char === " " || char === "\t" || char === "\n";
const isPunctuation = (char: string | undefined) =>
  char !== undefined && /[\p{P}\p{S}]/u.test(char);
const isAlphanumeric = (char: string | undefined) =>
  char !== undefined && /^[A-Za-z\d]$/u.test(char);

/** Whether a run of `mark` may open and close, by what stands on each side, as CommonMark reads it. */
const flanks = (
  mark: string,
  before: string | undefined,
  after: string | undefined
) => {
  const left =
    !isSpace(after) &&
    (!isPunctuation(after) || isSpace(before) || isPunctuation(before));
  const right =
    !isSpace(before) &&
    (!isPunctuation(before) || isSpace(after) || isPunctuation(after));
  return mark === "_"
    ? {
        opens: left && (!right || isPunctuation(before)),
        closes: right && (!left || isPunctuation(after)),
      }
    : { opens: left, closes: right };
};

/** Whether `char` ends a link's address, in angle brackets or not, `depth` deep in its parentheses. */
const endsAddress = (
  char: string | undefined,
  pointy: boolean,
  depth: number
): boolean =>
  pointy
    ? char === undefined || "<>\n".includes(char)
    : isSpace(char) || (char === ")" && depth === 0);

/** Whether `char` is one a backslash escapes: ASCII punctuation. */
const isEscapable = (char: string | undefined) =>
  char !== undefined && char <= "~" && isPunctuation(char);

/**
 * Where a link's address from `from` ends: in angle brackets, at the first `<`, `>` or line's end
 * that no backslash escapes; else at a space or the `)` that closes its parentheses, and how deep
 * in them it ends.
 */
const addressEnd = (body: string, from: number) => {
  const pointy = body[from] === "<";
  let depth = 0;
  let at = pointy ? from + 1 : from;
  while (!endsAddress(body[at], pointy, depth)) {
    depth += pointy ? 0 : Number(body[at] === "(") - Number(body[at] === ")");
    at += body[at] === "\\" && isEscapable(body[at + 1]) ? 2 : 1;
  }
  return { at, depth };
};

/** Past the spaces, tabs and line ends in `body` from `at`. */
const pastSpaces = (body: string, at: number): number => {
  let end = at;
  while (end < body.length && isSpace(body[end])) {
    end += 1;
  }
  return end;
};

/** What closes a title that opens with its mark. */
const TITLE_ENDS: Partial<Record<string, string>> = {
  '"': '"',
  "'": "'",
  "(": ")",
};

/**
 * A link's tail, read as CommonMark reads it from just after its `](`: its address (in angle
 * brackets, or with its parentheses balanced), a title in quotes or parentheses after a space, then
 * `)`. Where it ends, past its `)`; what closes it, when it runs to the end of `body`; or, when it
 * is no link's tail after all (`[a](b c)`), where its address ends, or its title: what was read is
 * not read again, so a run of `](` costs its length.
 */
const tailAt = (body: string, after: number): number | string => {
  // Spaces, and a line's end, may stand before the address.
  const from = pastSpaces(body, after);
  const found = addressEnd(body, from);
  const { depth } = found;
  let { at } = found;
  if (body[from] === "<") {
    if (at >= body.length) {
      return ">)";
    }
    // In angle brackets, an address runs to its `>`, spaces and all; a line's end or a `<` first,
    // and it is no address.
    if (body[at] !== ">") {
      return at;
    }
    at += 1;
  }
  const address = at;
  at = pastSpaces(body, at);
  if (at >= body.length) {
    return ")".repeat(Math.max(0, depth) + 1);
  }
  const ends = TITLE_ENDS[body[at] ?? ""];
  if (
    depth > 0 ||
    (body[at] !== ")" && (ends === undefined || at === address))
  ) {
    return address;
  }
  if (ends !== undefined) {
    let shut = body.indexOf(ends, at + 1);
    while (shut !== -1 && isEscaped(body, shut)) {
      shut = body.indexOf(ends, shut + 1);
    }
    if (shut === -1) {
      return `${ends})`;
    }
    at = pastSpaces(body, shut + 1);
    if (at >= body.length) {
      return ")";
    }
    return body[at] === ")" ? at + 1 : shut + 1;
  }
  return at + 1;
};

/** What is open at the end of a leaf, read in one pass: code in a sentence, a link, and marks. */
interface Open {
  /** The run of backticks code in a sentence is open with, by its length; 0 for none. */
  code: number;
  /**
   * Where the first of what is still open starts, or the leaf's length: code, the link, a bracket
   * nothing closed, a tag not closed on its line. What follows may still change how it reads.
   */
  first: number;
  /** Where the link whose tail runs to the end starts (its `[`), or -1; and what closes it. */
  link: number;
  linkClose: string;
  /** The marks left open, outermost first. */
  marks: string[];
}

/** The length of the run of one mark (a backtick, `*`, `_`, `~`) at `at`; 1 for any other character. */
const runAt = (body: string, at: number): number => {
  const char = body[at] ?? "";
  let run = 1;
  while ("`*_~".includes(char) && body[at + run] === char) {
    run += 1;
  }
  return run;
};

/** Past a tag on its line at `at` (`<a target="_blank">`), whose marks are its own; or past its `<`. */
const tagEnd = (body: string, at: number): number => {
  let end = at + 1;
  while (end < body.length && !"<>\n".includes(body[end] ?? "")) {
    end += 1;
  }
  return body[end] === ">" ? end + 1 : at + 1;
};

/** Whether the `<` at `at`, past which `tagEnd` found no tag, may yet open one, or an address: `<det`, `<https://exa`. */
const opensTag = (body: string, at: number, end: number) =>
  end === at + 1 && /[A-Za-z/!?]/u.test(body[end] ?? "");

/**
 * Reads the run of `*`, `_` or `~` at `at` against `marks`, those still open, and returns where it
 * ends: it closes the latest like it, or opens, by CommonMark's flanking rules. A run of three is
 * bold and emphasis; a longer one closes only with as long a run; one tilde is no mark.
 */
const markRun = (
  marks: string[],
  body: string,
  at: number,
  run: number
): number => {
  const char = body[at] ?? "";
  if (!"*_~".includes(char) || (char === "~" && run !== 2)) {
    return at + run;
  }
  const { opens, closes } = flanks(char, body[at - 1], body[at + run]);
  // One star between letters or digits (`5*3`) is most likely a character.
  const literal =
    char === "*" &&
    run === 1 &&
    isAlphanumeric(body[at - 1]) &&
    isAlphanumeric(body[at + run]);
  const whole = run === 1 || run > 3 ? char.repeat(run) : char + char;
  // What this run closed, and what was open inside that: a run of three that closes bold closes
  // the emphasis opened with it too (`***a***`), so it does not open that again.
  const closed: string[] = [];
  for (const mark of run === 3 ? [char + char, char] : [whole]) {
    const index = marks.lastIndexOf(mark);
    if (closes && index !== -1) {
      closed.push(...marks.splice(index));
    } else if (index !== -1 && opens) {
      // One like it is open and this did not close it (`**这句话。**接着`, `*a *b`): CommonMark
      // will close neither, so neither is closed.
      marks.splice(index, 1);
    } else if (
      opens &&
      !literal &&
      marks.length < MAX_OPEN &&
      !closed.includes(mark)
    ) {
      marks.push(mark);
    }
  }
  return at + run;
};

/**
 * What is open at the end of `body`, in one pass: code in a sentence by the length of its run of
 * backticks; a link's address (its parentheses balanced) and title, which are its own, so no mark
 * in them counts; and `*`, `_` and `~~` by CommonMark's flanking rules, each closing the latest
 * like it still open. One star between letters or digits (`5*3`) is most likely a character.
 */
const openIn = (body: string): Open => {
  const marks: string[] = [];
  // The brackets still open, innermost last: a `]` closes the innermost.
  const brackets: number[] = [];
  let code = 0;
  let codeAt = 0;
  let tag = body.length;
  const firstOf = (...starts: number[]) =>
    Math.min(tag, brackets[0] ?? tag, ...starts);
  let at = 0;
  while (at < body.length) {
    const char = body[at] ?? "";
    const run = runAt(body, at);
    if (char === "`") {
      codeAt = code === 0 ? at : codeAt;
      code = code === 0 || code === run ? run - code : code;
      at += run;
    } else if (char === "\\" || code !== 0) {
      at += char === "\\" ? 2 : 1;
    } else if (char === "[") {
      brackets.push(at);
      at += 1;
    } else if (char === "]") {
      const bracket = brackets.pop() ?? -1;
      const tail = body[at + 1] === "(" ? tailAt(body, at + 2) : at + 1;
      if (typeof tail === "string") {
        // A tail with no bracket before it is no link's: its address is words.
        const link = bracket !== -1;
        return {
          code,
          first: firstOf(link ? bracket : body.length),
          link: bracket,
          linkClose: link ? tail : "",
          marks,
        };
      }
      at = tail;
    } else if (char === "<") {
      const end = tagEnd(body, at);
      tag = Math.min(tag, opensTag(body, at, end) ? at : tag);
      at = end;
    } else {
      at = markRun(marks, body, at, run);
    }
  }
  return {
    code,
    first: firstOf(code === 0 ? body.length : codeAt),
    link: -1,
    linkClose: "",
    marks,
  };
};

/**
 * `body` as `closers`, what closes what `open` says is open, are put after it: a closing mark closes
 * only right after a word, so the spaces at its end go; and a backslash then at its very end
 * (outside code, where it is a character) waits for the character it escapes, as it would escape
 * the closing mark, or show and then go.
 */
const closable = (body: string, open: Open, closers: string): string => {
  const words = closers === "" ? body : body.trimEnd();
  return open.code === 0 && isEscaped(words, words.length)
    ? words.slice(0, -1)
    : words;
};

/** What closes what `openIn` found open: code, the link, then the marks, innermost first. */
const closersOf = ({ code, linkClose, marks }: Open) =>
  "`".repeat(code) + linkClose + marks.toReversed().join("");

/**
 * The bracket still open at the very end of `body`, from `from` on, or -1: read back from the end,
 * past words in brackets that close (`[link [nested] te`), to a parenthesis, a backtick or a line's
 * end at most. A last `]` closes it, and it still waits: `[the report]` may yet be a link.
 */
const bracketAt = (body: string, from: number): number => {
  let depth = body.endsWith("]") ? -1 : 0;
  for (let at = body.length - 1; at >= from; at -= 1) {
    const char = body[at] ?? "";
    if ("()\n`".includes(char)) {
      return -1;
    }
    if (char === "]") {
      depth += 1;
    } else if (char === "[" && !isEscaped(body, at)) {
      if (depth <= 0) {
        return at;
      }
      depth -= 1;
    }
  }
  return -1;
};

/** The longest name of a character, as `&` and it stand for one (`&amp;`, `&#x1F600;`). */
const MAX_ENTITY = 32;

/** Where a character's name still being written at the very end of `body` starts (`&am`), or -1. */
const entityAt = (body: string): number => {
  let at = body.length;
  while (
    at > body.length - MAX_ENTITY &&
    /^[\dA-Za-z#]$/u.test(body[at - 1] ?? "")
  ) {
    at -= 1;
  }
  return body[at - 1] === "&" && !isEscaped(body, at - 1) ? at - 1 : -1;
};

/**
 * Where something still being written at the very end of `body` starts that waits, or -1: a bracket
 * that may yet open a link (bracketAt), its `!` with it, a tag or a bare address not yet closed by
 * its `>`, or a character's name (`&am`, which `;` makes `&`). Never inside code in a sentence, nor
 * further back than WINDOW.
 */
const waitingAt = (body: string): number => {
  const from = Math.max(0, body.length - WINDOW, body.lastIndexOf("`") + 1);
  const found: number[] = [];
  const entity = entityAt(body);
  if (entity >= from) {
    found.push(entity);
  }
  let bracket = bracketAt(body, from);
  // A reference's label waits with its words: `[the wiki][wi`.
  for (let label = bracket; label > from && body[label - 1] === "]";) {
    label = bracketAt(body.slice(0, label), from);
    bracket = label === -1 ? bracket : label;
  }
  if (bracket !== -1) {
    found.push(body[bracket - 1] === "!" ? bracket - 1 : bracket);
  }
  const tag = body.lastIndexOf("<");
  if (
    tag >= from &&
    !isEscaped(body, tag) &&
    !body.includes(">", tag) &&
    (tag === body.length - 1 || HALF_TAG.test(body.slice(tag)))
  ) {
    found.push(tag);
  }
  return found.length === 0 ? -1 : Math.min(...found);
};

/** `source`, as much as has arrived of an answer, made whole (see above). */
export const repair = (source: string): Repaired => {
  const kept = keptOf(source);
  const text = source.slice(0, kept);
  const lines = text.split("\n");
  if (codeLines(lines).open !== "" || isRow(lines.at(-1) ?? "")) {
    return { text, kept, complete: kept, word: kept };
  }
  const from = leafFrom(text);
  let body = withoutEndMarks(text.slice(from));
  let open = openIn(body);
  if (open.link === -1 && open.code === 0) {
    const wait = waitingAt(body);
    // What waits goes alone: the space before it stays, so nothing shown is taken back. A `!` at
    // the very end may yet start a picture's `![`.
    let rest = wait === -1 ? body : withoutEndMarks(body.slice(0, wait));
    if (rest.endsWith("!") && !isEscaped(rest, rest.length - 1)) {
      rest = rest.slice(0, -1);
    }
    open = rest === body ? open : openIn(rest);
    body = rest;
  }
  const closers = closersOf(open);
  const end = from + closable(body, open, closers).length;
  const own = Math.min(kept, end);
  const complete = Math.min(own, from + open.first);
  let word = complete;
  while (word > from && !isSpace(text[word - 1]) && text[word - 1] !== "<") {
    word -= 1;
  }
  return { text: text.slice(0, end) + closers, kept: own, complete, word };
};

/**
 * An answer cut off part way (stopped), tidied once it will not be written further: a link still
 * being written at its end goes, its words with it (`[2`, `[the report](https://ex`), and bold,
 * emphasis, strike-through or code left open are closed. Nothing else is touched, so an answer
 * that ended whole comes back as it was; inside an open fence the code simply ends, and a task's
 * box with no words yet is what it is.
 */
export const tidy = (source: string): string => {
  const line = source.slice(source.lastIndexOf("\n") + 1);
  const inner = containersEnd(line);
  if (
    (inner > 0 && TASK.test(line.slice(inner))) ||
    isRow(line) ||
    openFence(source)
  ) {
    return source;
  }
  const from = leafFrom(source);
  let body = source.slice(from);
  const open = openIn(body);
  if (open.code === 0) {
    const link = body[open.link - 1] === "!" ? open.link - 1 : open.link;
    const window = Math.max(0, body.length - WINDOW);
    const citation = CUT_CITATION.exec(body.slice(window))?.index ?? -1;
    const cut =
      open.link === -1 ? citation + (citation === -1 ? 0 : window) : link;
    body = cut === -1 ? body : body.slice(0, cut).trimEnd();
  }
  const bare = withoutEndMarks(body);
  const left = openIn(bare);
  const closers = closersOf(left);
  return closers === ""
    ? source.slice(0, from) + body
    : source.slice(0, from) + closable(bare, left, closers) + closers;
};

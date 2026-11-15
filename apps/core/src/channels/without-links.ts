import { parseMarkdown, stringifyMarkdown } from "chat";
import type { Nodes, Root, Text } from "chat";

// The agent's own words in a chat app hold no link or image (GRA-1914): a
// link the model writes could lead the person anywhere, and an image, or
// a link a platform previews, is fetched with no click at all, carrying
// what the model read out in its address. Text the model read can steer
// what it writes, so the rule it is given (stephen-rules.ts) holds nothing
// on its own: this holds it, whatever the model writes.
//
// It holds it by structure, not by recognising addresses: what Markdown
// and HTML make into a link or an image is taken out, on the Chat SDK's
// own parser, the one its Teams and Slack adapters render with. A link
// keeps its words, an image its alt text; HTML, definitions and footnotes
// go. An address written out in words stays words: a platform may still
// make it clickable, and nothing fetches it (answer.ts posts with
// previews off), so it is a link the person sees whole before following.
// Each platform's own link and mention syntax is taken out where the
// answer is posted (`inTeams`, `inSlack`).
//
// A block nothing was taken from keeps the model's own bytes; one
// something was taken from is written again from its tree. The result is
// parsed again until a parse takes nothing more. Fails closed: an answer
// the parser throws on (nesting thousands deep), or one that doesn't
// settle in {@link rounds}, is cut whole.

/**
 * Rounds of parse and write before an answer counts as one that can't be
 * placed. A block written again holds no link or image and escapes what
 * its words keep of their syntax, so the second round takes nothing in
 * any answer we know of.
 */
const rounds = 4;

// The Chat SDK's parser takes time with the square of some paragraphs:
// for each `]`, `*`, `_` or `~` it reads, it looks back over the ones
// before (32 KB of `]` takes it 11 s), and it looks for an address from
// each character of an unbroken run (64 KB of `+`: seconds). The budget is
// 30 ms of parsing for any one paragraph; measured in workerd, these
// bounds keep its worst shape (labels nested 256 deep) at 25 ms. A
// paragraph past them is given to the parser escaped, as plain text, so
// it shows as written and nothing in it is a link, emphasis or code. Code
// isn't parsed for these, so it doesn't count.

/** The most `]`, `*`, `_` or `~` one paragraph may hold, unescaped. */
const mostClosers = 256;

/** The longest unbroken run of what an address is made of. */
const longestRun = 4096;

/** A character the parser looks back from, unescaped. */
const closer = /(?<!\\)[\]*_~]/gu;

/** A run longer than {@link longestRun}. */
const tooLongRun = new RegExp(`[\\w.+-]{${longestRun + 1}}`, "u");

/** ASCII punctuation, which a backslash escapes; and an escape already made. */
const punctuation = /\\[!-/:-@[-`{-~]|[!-/:-@[-`{-~]/gu;

/**
 * A line that opens a fenced code block: what stands before its fence (a
 * quote's markers, a list item's indent), the fence, and its info.
 */
const fenceOpening = /^(?<prefix>[\s>]*)(?<fence>`{3,}|~{3,})(?<info>[^\n]*)$/u;

/** A line that can close a fenced code block: its indent, and its fence. */
const fenceClosing = /^[>\s]*?(?<indent> *)(?<fence>`{3,}|~{3,})\s*$/u;

/** A bullet item with words in it, which breaks off any paragraph. */
const bulletItem = /^[\s>]*[-*+]\s+\S/u;

/** A heading, which breaks off any paragraph. */
const heading = /^[\s>]*#{1,6}(?:\s|$)/u;

/** An ordered item, which breaks off a paragraph only in a list or at 1. */
const orderedItem = /^[\s>]*(?<number>\d{1,9})[.)]\s+\S/u;

/** A table's delimiter row, as GFM reads one: cells of dashes. */
const delimiterRow = /^[\s>]*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/u;

/** How many cells a table row has, as GFM counts them. */
const cellsOf = (line: string): number =>
  line
    .trim()
    .replace(/^\|/u, "")
    .replace(/(?<!\\)\|$/u, "")
    .split(/(?<!\\)\|/u).length;

/** Whether the lines of one paragraph would take the parser too long. */
const tooCostly = (lines: readonly string[]): boolean => {
  const text = lines.join("\n");
  return (
    tooLongRun.test(text) || [...text.matchAll(closer)].length > mostClosers
  );
};

/** `line` with every unescaped ASCII punctuation character escaped. */
const escaped = (line: string): string =>
  line.replaceAll(punctuation, (found) =>
    found.length === 2 ? found : `\\${found}`
  );

/** A fenced code block being read: its fence and what stands before it. */
interface Fence {
  fence: string;
  prefix: string;
}

/**
 * The fence `line` opens, if it opens one: a backtick fence's info holds
 * no backtick.
 */
const opens = (line: string): Fence | undefined => {
  const { prefix, fence, info } = fenceOpening.exec(line)?.groups ?? {};
  if (prefix === undefined || fence === undefined) {
    return undefined;
  }
  return fence.startsWith("`") && (info ?? "").includes("`")
    ? undefined
    : { fence, prefix };
};

/**
 * Whether `line` closes `open`: its fence, at most three spaces further in
 * than the fence it closes, as the parser takes one.
 */
const closes = (line: string, open: Fence): boolean => {
  const { indent, fence } = fenceClosing.exec(line)?.groups ?? {};
  return (
    indent !== undefined &&
    fence !== undefined &&
    indent.length <= open.prefix.replaceAll(">", "").length + 3 &&
    fence.startsWith(open.fence.slice(0, 1)) &&
    fence.length >= open.fence.length
  );
};

/** Lines read as one: a paragraph outside code, or a code block. */
interface Group {
  code: boolean;
  lines: string[];
}

/** How far a read of an answer's lines has come (`paragraphsOf`). */
interface Reading {
  groups: Group[];
  fence: Fence | undefined;
  /**
   * A code block read as ended before the parser may end it: a line that
   * would close it opens nothing.
   */
  left: Fence | undefined;
  afterBlank: boolean;
  inList: boolean;
  inTable: boolean;
  previous: string;
}

/** Starts a new group in `reading`. */
const startGroup = (reading: Reading, code: boolean): void => {
  reading.groups.push({ code, lines: [] });
};

/** Adds `line` to the group being read. */
const addLine = (reading: Reading, line: string): void => {
  reading.groups.at(-1)?.lines.push(line);
};

/**
 * Reads `line` as code, if it is: inside a code block, which ends at its
 * closing fence or where its container (a quote, a list item) does, or a
 * line that opens one.
 */
const readCode = (reading: Reading, line: string): boolean => {
  const { fence } = reading;
  if (fence !== undefined) {
    if (line.trim() === "" || line.startsWith(fence.prefix)) {
      addLine(reading, line);
      if (closes(line, fence)) {
        reading.fence = undefined;
        startGroup(reading, false);
      }
      return true;
    }
    reading.left = fence;
    reading.fence = undefined;
    startGroup(reading, false);
  }
  if (reading.left !== undefined && closes(line, reading.left)) {
    reading.left = undefined;
    addLine(reading, line);
    return true;
  }
  const opened = opens(line);
  if (opened === undefined) {
    return false;
  }
  reading.left = undefined;
  reading.fence = opened;
  startGroup(reading, true);
  addLine(reading, line);
  return true;
};

/**
 * Reads `line` as prose: it starts a paragraph of its own where it breaks
 * off the one before however that one ends (a blank line before it, a
 * bullet item, a heading, a table's row), or an ordered item in a list.
 */
const readProse = (reading: Reading, line: string): void => {
  const blank = line.trim() === "";
  const ordered = orderedItem.exec(line)?.groups?.number;
  const bullet = bulletItem.test(line);
  const breaks =
    blank ||
    reading.afterBlank ||
    reading.inTable ||
    heading.test(line) ||
    bullet ||
    (ordered !== undefined && (reading.inList || Number(ordered) === 1));
  if (breaks) {
    startGroup(reading, false);
    if (!blank) {
      reading.inList =
        bullet ||
        ordered !== undefined ||
        (reading.inList && /^\s/u.test(line));
    }
  }
  addLine(reading, line);
  // Each row after a table's delimiter is read on its own.
  reading.inTable = blank
    ? false
    : reading.inTable ||
      (reading.previous.includes("|") &&
        delimiterRow.test(line) &&
        cellsOf(line) === cellsOf(reading.previous));
  reading.afterBlank = blank;
  reading.previous = line;
};

/** The lines of `text`, each paragraph outside code one group (`inTime`). */
const paragraphsOf = (text: string): Group[] => {
  const reading: Reading = {
    groups: [{ code: false, lines: [] }],
    fence: undefined,
    left: undefined,
    afterBlank: true,
    inList: false,
    inTable: false,
    previous: "",
  };
  for (const line of text.split("\n")) {
    if (!readCode(reading, line)) {
      readProse(reading, line);
    }
  }
  return reading.groups;
};

/**
 * `text` as the parser may take it in time: each paragraph outside code
 * that would take it too long, escaped. Lines are grouped as the parser's
 * paragraphs or coarser, never finer, so a paragraph is never counted in
 * parts; code it doesn't parse for these isn't counted.
 */
const inTime = (text: string): string =>
  paragraphsOf(text)
    .flatMap(({ code, lines }) =>
      !code && tooCostly(lines) ? lines.map(escaped) : lines
    )
    .join("\n");

/** Nodes that show nothing of their own and are taken out. */
const cutNodes: ReadonlySet<Nodes["type"]> = new Set([
  "html",
  "definition",
  "footnoteDefinition",
  "footnoteReference",
]);

type Parent = Extract<Nodes, { children: unknown }>;

const hasChildren = (node: Nodes): node is Parent => "children" in node;

/** `node`'s children, none for a leaf. */
const childrenOf = (node: Nodes): readonly Nodes[] =>
  hasChildren(node) ? node.children : [];

/** Pushes `nodes` on `pending` so the first of them is popped first. */
const pushAll = (pending: Nodes[], nodes: readonly Nodes[]): void => {
  for (const node of nodes.toReversed()) {
    pending.push(node);
  }
};

/** Gives `parent` the children `kept`, in place. */
const keepChildren = (parent: Parent, kept: readonly Nodes[]): void => {
  // Each node kept was a child of this parent, or text in its place.
  const children: Nodes[] = parent.children;
  children.length = 0;
  for (const node of kept) {
    children.push(node);
  }
};

/** Keeps `node`, as one text with any text kept right before it. */
const keep = (kept: Nodes[], node: Nodes): void => {
  const last = kept.at(-1);
  if (node.type === "text" && last?.type === "text") {
    kept[kept.length - 1] = { type: "text", value: last.value + node.value };
  } else {
    kept.push(node);
  }
};

/**
 * The words of link `node` when they are its address, written out
 * (`https://…`, `www.…`, `hr@acme.com`, `<https://…>`): words that stay
 * words, which a platform may show as a link the person sees whole.
 */
const writtenOut = (node: Nodes): string | undefined => {
  const [words, ...more] = childrenOf(node);
  return node.type === "link" &&
    words?.type === "text" &&
    more.length === 0 &&
    [words.value, `http://${words.value}`, `mailto:${words.value}`].includes(
      node.url
    )
    ? words.value
    : undefined;
};

/**
 * Cleans `parent`'s children in place: a link becomes its words, an image
 * its alt text, and what shows nothing of its own goes. Whether anything
 * was taken, and the children kept, to clean in turn.
 */
const cleanChildren = (parent: Parent): { changed: boolean; kept: Nodes[] } => {
  let changed = false;
  const kept: Nodes[] = [];
  const pending: Nodes[] = [];
  pushAll(pending, childrenOf(parent));
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const words = writtenOut(node);
    if (words !== undefined) {
      keep(kept, { type: "text", value: words });
    } else if (cutNodes.has(node.type)) {
      changed = true;
    } else if (node.type === "link" || node.type === "linkReference") {
      changed = true;
      pushAll(pending, childrenOf(node));
    } else if (node.type === "image" || node.type === "imageReference") {
      changed = true;
      keep(kept, { type: "text", value: node.alt ?? "" });
    } else {
      keep(kept, node);
    }
  }
  keepChildren(parent, kept);
  return { changed, kept };
};

/**
 * Cleans `block`, a top-level block, in place: whether it was taken
 * whole, changed, or kept as it is.
 */
const cleanBlock = (
  block: Root["children"][number]
): "cut" | "changed" | "kept" => {
  if (cutNodes.has(block.type)) {
    return "cut";
  }
  let changed = false;
  const parents: Nodes[] = [block];
  for (
    let parent = parents.pop();
    parent !== undefined;
    parent = parents.pop()
  ) {
    if (hasChildren(parent)) {
      const cleaned = cleanChildren(parent);
      changed ||= cleaned.changed;
      pushAll(parents, cleaned.kept);
    }
  }
  return changed ? "changed" : "kept";
};

/**
 * The parser's escapes of what could start an address written out (`@`,
 * `.`, `:`), which only keep it from being read as a link it may be
 * read as: written as they are, as Teams and Slack would show the
 * backslash.
 */
const addressEscape: ReadonlySet<string> = new Set(["@", ".", ":"]);

/** `block` written again, with `code` writing its code blocks. */
const written = (
  block: Root["children"][number],
  code?: (value: string) => string
): string =>
  stringifyMarkdown(
    { type: "root", children: [block] },
    {
      bullet: "-",
      emphasis: "_",
      handlers: {
        text: (node: Text, _parent, state, info) => {
          const { unsafe } = state;
          state.unsafe = unsafe.filter(
            ({ character }) => !addressEscape.has(character)
          );
          try {
            return state.safe(node.value, info);
          } finally {
            state.unsafe = unsafe;
          }
        },
        ...(code === undefined
          ? {}
          : { code: (node: { value: string }) => code(node.value) }),
      },
    }
  ).trimEnd();

/**
 * `source` cleaned once: each block nothing was taken from as it is, each
 * other one written again, or gone; `undefined` when nothing was taken.
 */
const cleanOnce = (source: string): string | undefined => {
  const { children } = parseMarkdown(source);
  let cleaned = "";
  let from = 0;
  let cut = false;
  for (const block of children) {
    const start = block.position?.start.offset;
    const end = block.position?.end.offset;
    if (start === undefined || end === undefined) {
      throw new Error("A block without a place in the answer");
    }
    const outcome = cleanBlock(block);
    if (outcome === "kept") {
      continue;
    }
    cut = true;
    cleaned += source.slice(from, start);
    if (outcome === "changed") {
      cleaned += written(block);
    }
    from = end;
  }
  return cut ? `${cleaned}${source.slice(from)}`.trimEnd() : undefined;
};

/** `text` cleaned until a parse takes nothing more; empty if it can't be. */
const settled = (text: string): string => {
  let current = inTime(text);
  try {
    for (let round = 0; round < rounds; round += 1) {
      const next = cleanOnce(current);
      if (next === undefined) {
        return current;
      }
      current = inTime(next);
    }
  } catch {
    // The parser can't take it (its own recursion, on nesting thousands
    // deep): cut whole.
  }
  return "";
};

/**
 * The agent's own words in a chat app, as they are stored, shown in Grasp
 * and posted: no link or image. Empty when they can't be placed.
 */
export const withoutLinks = (text: string): string => settled(text).trim();

/**
 * `shown` words as Teams gets them, in an Adaptive Card's `TextBlock`,
 * which reads one link form only, `[words](address)`, and shows code as
 * text: wherever its `](` still stands (in code, or escaped), it is
 * broken, so none can be read as a link.
 */
export const inTeams = (shown: string): string => shown.replaceAll("](", "] (");

/** A code block as Slack shows one: a closed fence of three backticks. */
const slackCode = (value: string): string => `\`\`\`\n${value}\n\`\`\``;

/** Whether `block` holds a code block Slack wouldn't show as code. */
const unfencedCode = (block: Nodes, source: string): boolean => {
  const pending: Nodes[] = [block];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === "code") {
      const fenced = source.slice(
        node.position?.start.offset,
        node.position?.end.offset
      );
      if (!/^```\n[\s\S]*\n```$/u.test(fenced)) {
        return true;
      }
    }
    pushAll(pending, childrenOf(node));
  }
  return false;
};

/**
 * `shown` words as Slack gets them, as `mrkdwn` text: each code block a
 * closed fence of three backticks, the only one Slack shows as code, and
 * `&`, `<` and `>` escaped, Slack's control characters, so nothing the
 * model wrote is a Slack link, mention or channel (`<…>`).
 */
export const inSlack = (shown: string): string => {
  let fenced = shown;
  try {
    const { children } = parseMarkdown(shown);
    let out = "";
    let from = 0;
    for (const block of children) {
      if (unfencedCode(block, shown)) {
        out += shown.slice(from, block.position?.start.offset);
        out += written(block, slackCode);
        from = block.position?.end.offset ?? shown.length;
      }
    }
    fenced = `${out}${shown.slice(from)}`;
  } catch {
    // Shown words parsed once already; if not now, they go as they are,
    // escaped below all the same.
  }
  return fenced
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
};

/** The start of the paragraph being written: after the last blank line. */
const lastBlankLine = /\n[ \t]*\n(?![\s\S]*\n[ \t]*\n)/u;

/**
 * Whether the construct `tail` opens with (a `[` or `<`) is still open: a
 * link's label, destination or tag the next chunk may yet close.
 */
const stillOpen = (tail: string): boolean => {
  if (tail.startsWith("<")) {
    return !tail.includes(">");
  }
  const close = tail.indexOf("]");
  if (close === -1 || close === tail.length - 1) {
    return true;
  }
  const after = tail[close + 1];
  if (after === "(") {
    return !tail.includes(")", close);
  }
  return after === "[" && !tail.includes("]", close + 2);
};

/**
 * Of an answer being written (`partial`), what a chat app shows of it so
 * far: the whole partial cleaned as the answer is (`withoutLinks`),
 * every time, so each update is as inert as the answer. Only to keep it
 * from flickering, a link, image or tag still open in the paragraph being
 * written is held back until it closes or the paragraph ends: the person
 * sees its words appear once, never its markup first. Empty where nothing
 * is worth showing yet, or the parser can't take it.
 */
export const streamedWithoutLinks = (partial: string): string => {
  const paragraph = partial.search(lastBlankLine) + 1;
  let held = partial.length;
  for (let at = paragraph; at < partial.length; at += 1) {
    const character = partial[at];
    if (
      (character === "[" || character === "<") &&
      stillOpen(partial.slice(at))
    ) {
      held = partial[at - 1] === "!" ? at - 1 : at;
      break;
    }
  }
  return withoutLinks(partial.slice(0, held));
};

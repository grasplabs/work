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
// 30 ms of parsing for any one chunk of an answer between blank lines,
// which a paragraph never crosses, so a chunk holds whole paragraphs and
// is never counted in parts. Measured in workerd, with 256 of those
// characters in one chunk, its worst shape (images nested 256 deep) takes
// 23 ms, and 512 take 83 ms; flat `a]` or `a\\]`, emphasis and lines of
// `a]` indented under one paragraph take 2 to 6 ms at 256. A chunk past
// the bounds is given to the parser escaped, as plain text: it shows the
// same words, and nothing in it is a link, emphasis or code. Every one of
// those characters counts, escaped or not: counting more only escapes a
// chunk that didn't need it. Only fenced code the parser certainly reads
// as code isn't counted (`chunksOf`).

/** The most `]`, `*`, `_` or `~` one chunk may hold. */
const mostClosers = 256;

/** The longest unbroken run of what an address is made of. */
const longestRun = 4096;

/** A character the parser looks back from. */
const closer = /[\]*_~]/gu;

/** A run longer than {@link longestRun}. */
const tooLongRun = new RegExp(`[\\w.+-]{${longestRun + 1}}`, "u");

/** ASCII punctuation, which a backslash escapes; and an escape already made. */
const punctuation = /\\[!-/:-@[-`{-~]|[!-/:-@[-`{-~]/gu;

/** A line that opens a fenced code block at the margin: its fence, and its info. */
const fenceAtMargin = /^(?<fence>`{3,}|~{3,})(?<info>[^\n]*)$/u;

/** A line that closes a fenced code block: its fence alone, at most three spaces in. */
const fenceClosing = /^ {0,3}(?<fence>`{3,}|~{3,})[ \t]*$/u;

/** A line that may open HTML, inside which a fence is no fence. */
const htmlLine = /^ {0,3}</mu;

/** Whether one chunk of lines would take the parser too long. */
const tooCostly = (lines: readonly string[]): boolean => {
  const text = lines.join("\n");
  return (
    tooLongRun.test(text) || [...text.matchAll(closer)].length > mostClosers
  );
};

/** `line` with every ASCII punctuation character escaped, once. */
const escaped = (line: string): string =>
  line.replaceAll(punctuation, (found) =>
    found.length === 2 ? found : `\\${found}`
  );

/** Lines read as one: a chunk between blank lines, or a fenced code block. */
interface Chunk {
  code: boolean;
  lines: string[];
}

/**
 * The lines of `text` in chunks: what stands between blank lines, and
 * fenced code the parser certainly reads as code, which is all it skips.
 * A fence counts as code only at the margin, where nothing it stands in
 * (a list item, a quote) can end it, and only in an answer with no line
 * that may open HTML, inside which a fence is no fence: anything less
 * certain counts as prose, which only counts more.
 */
const chunksOf = (text: string): Chunk[] => {
  const lines = text.split("\n");
  const fences = !htmlLine.test(text);
  const chunks: Chunk[] = [{ code: false, lines: [] }];
  let fence: string | undefined;
  for (const line of lines) {
    const chunk = chunks.at(-1);
    if (chunk === undefined) {
      break;
    }
    if (fence !== undefined) {
      chunk.lines.push(line);
      const closing = fenceClosing.exec(line)?.groups?.fence;
      if (
        closing !== undefined &&
        closing.startsWith(fence.slice(0, 1)) &&
        closing.length >= fence.length
      ) {
        fence = undefined;
        chunks.push({ code: false, lines: [] });
      }
      continue;
    }
    const { fence: opening, info = "" } =
      (fences ? fenceAtMargin.exec(line)?.groups : undefined) ?? {};
    if (
      opening !== undefined &&
      !(opening.startsWith("`") && info.includes("`"))
    ) {
      fence = opening;
      chunks.push({ code: true, lines: [line] });
      continue;
    }
    if (line.trim() === "") {
      chunks.push({ code: false, lines: [line] }, { code: false, lines: [] });
      continue;
    }
    chunk.lines.push(line);
  }
  return chunks;
};

/**
 * `text` as the parser may take it in time: each chunk outside code that
 * would take it too long, escaped (`mostClosers`).
 */
const inTime = (text: string): string =>
  chunksOf(text)
    .filter(({ lines }) => lines.length > 0)
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

/** Nodes whose children are the words a block shows. */
const blockText: ReadonlySet<Nodes["type"]> = new Set([
  "paragraph",
  "heading",
  "tableCell",
]);

/**
 * The words of link `node` when they are its address (`https://…`,
 * `www.…`, `hr@acme.com`): words that stay words, which a platform may
 * show as a link the person sees whole. `rewrite` when the answer wrote
 * them as more than the address (`<https://…>`, `[https://…](https://…)`):
 * its block is written again with the address alone, shown once.
 */
const writtenOut = (
  node: Nodes,
  source: string
): { words: string; rewrite: boolean } | undefined => {
  const [words, ...more] = childrenOf(node);
  if (
    node.type !== "link" ||
    words?.type !== "text" ||
    more.length > 0 ||
    ![words.value, `http://${words.value}`, `mailto:${words.value}`].includes(
      node.url
    )
  ) {
    return undefined;
  }
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return {
    words: words.value,
    // An address the parser found in text has no place of its own.
    rewrite: start !== undefined && source.slice(start, end) !== words.value,
  };
};

/** `kept` with the spaces at its ends trimmed, where something was taken. */
const trimEnds = (kept: Nodes[]): void => {
  const first = kept.at(0);
  if (first?.type === "text") {
    kept[0] = { type: "text", value: first.value.trimStart() };
  }
  const last = kept.at(-1);
  if (last?.type === "text") {
    kept[kept.length - 1] = { type: "text", value: last.value.trimEnd() };
  }
};

/**
 * Cleans `parent`'s children in place: a link becomes its words, an image
 * its alt text, and what shows nothing of its own goes. Whether anything
 * was taken, and the children kept, to clean in turn.
 */
const cleanChildren = (
  parent: Parent,
  source: string
): { changed: boolean; kept: Nodes[] } => {
  let changed = false;
  const kept: Nodes[] = [];
  const pending: Nodes[] = [];
  pushAll(pending, childrenOf(parent));
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const address = writtenOut(node, source);
    if (address !== undefined) {
      changed ||= address.rewrite;
      keep(kept, { type: "text", value: address.words });
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
  // What was taken leaves no space at a block's ends.
  if (changed && blockText.has(parent.type)) {
    trimEnds(kept);
  }
  keepChildren(parent, kept);
  return { changed, kept };
};

/**
 * Cleans `block`, a top-level block, in place: whether it was taken
 * whole, changed, or kept as it is.
 */
const cleanBlock = (
  block: Root["children"][number],
  source: string
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
      const cleaned = cleanChildren(parent, source);
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
    const outcome = cleanBlock(block, source);
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
  // Trimmed before each parse, never after the last: an indented line at
  // the start is code to the parser, and trimmed after, a link.
  let current = inTime(text.trim());
  try {
    for (let round = 0; round < rounds; round += 1) {
      const next = cleanOnce(current);
      if (next === undefined) {
        return current;
      }
      current = inTime(next.trim());
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
export const withoutLinks = (text: string): string => settled(text);

/**
 * `shown` words as Teams gets them, in an Adaptive Card's `TextBlock`,
 * which reads one link form only, `[words](address)`, and shows code as
 * text: wherever its `](` still stands (in code, or escaped), it is
 * broken, so none can be read as a link.
 */
export const inTeams = (shown: string): string => shown.replaceAll("](", "] (");

/** `text` with Slack's control characters escaped, as Slack decodes them. */
const slackEscaped = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

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
  return slackEscaped(fenced);
};

/**
 * A value the model wrote, as a card on `platform` shows it (a held write's
 * title, fields and values, an offered start's): exactly what will be
 * sent, nothing cut, with the platform's own link and mention syntax made
 * inert: on Teams no `](` a card reads as a link, on Slack its control
 * characters escaped.
 */
export const inertOn =
  (platform: string) =>
  (text: string): string =>
    platform === "slack" ? slackEscaped(text) : inTeams(text);

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

/**
 * A name a line embeds (a workflow's, which the agent may have written),
 * as a plain message on `platform` shows it: on Slack its control
 * characters escaped; on Teams, whose message text renders HTML and
 * `[words](address)`, no `<` that opens a tag and no `](`.
 */
export const inertInMessage =
  (platform: string) =>
  (text: string): string =>
    platform === "slack"
      ? slackEscaped(text)
      : inTeams(text).replaceAll("<", "&lt;");

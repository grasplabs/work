import { parseMarkdown, stringifyMarkdown } from "chat";
import type { InlineCode, Nodes, Root, Text } from "chat";
import { LinkifyIt } from "linkify-it";
import type { Match } from "linkify-it";
import tlds from "tlds";

// The agent's own words in a chat app hold no address (GRA-1914): a link
// the model writes could lead the person anywhere, and carry what it read
// out in the address, when the person clicks it or when Teams or Slack
// fetches it for a preview. Text the model read can steer what it writes,
// so the rule it is given (stephen-rules.ts) holds nothing on its own:
// this holds it, whatever the model writes.
//
// Teams and Slack each read the text again with their own renderer, and
// link more than any one parser's tree shows (a bare domain, an address
// hidden behind an escape), so what is checked is the text a person sees:
// no address anywhere in it, whatever syntax is around it. Without an
// address, no link, image or HTML can lead anywhere. Parsed with the Chat
// SDK's own parser, the one its Teams and Slack adapters render with:
// - a link keeps its words, an image its alt text, a reference keeps its
//   words; raw HTML, definitions and footnotes are cut;
// - an address in what a block shows (linkify-it, with every top-level
//   domain) is cut; across formatting, the block becomes plain text;
// - a bare email address stays: it leads nowhere a click doesn't show;
// - code shows as it is written, so it stays as it is written;
// - a citation of what the chat read stays: code turns it into the
//   answer's sources (`citedIn` in chat-messages.ts).
// A block nothing was cut from keeps the model's own bytes; one something
// was cut from is written again from its tree. The result is parsed
// again, until a parse finds nothing to cut. Fails closed: an answer the
// parser can't take (it throws on nesting thousands deep), or one that
// doesn't settle in {@link rounds}, is cut whole.

/**
 * Rounds of parse, cut and write before an answer counts as one that
 * can't be placed. A block written again holds no link, image or HTML, and
 * escapes the brackets it kept, so the second round finds nothing in any
 * answer we know of.
 */
const rounds = 4;

// The Chat SDK's parser takes time with the square of some inputs, so an
// answer that would take it that long is cut whole before it is parsed,
// as markdown-it guards its own parser (`maxNesting`). Measured on it,
// within these bounds the worst answer of 64 KB we know cleans in about a
// second; no answer a person reads in a chat app comes near them.

/**
 * The most `]`, `*`, `_` or `~` an answer may hold: for each it reads, the
 * parser looks back over all it read before (64 KB of `]` takes it a
 * minute).
 */
const mostClosers = 512;

/** What the parser looks back from (`mostClosers`). */
const closer = /[\]*_~]/gu;

/**
 * The longest run of what an address is made of, with no break, an answer
 * may hold: the parser looks for an address from each of its characters
 * (64 KB of `+` takes it seconds).
 */
const longestRun = 4096;

/** A run longer than {@link longestRun}. */
const tooLongRun = new RegExp(`[\\w.+-]{${longestRun + 1}}`, "u");

/** Whether the parser's time on `text` would grow with its square. */
const tooCostly = (text: string): boolean => {
  if (tooLongRun.test(text)) {
    return true;
  }
  let count = 0;
  for (const _ of text.matchAll(closer)) {
    count += 1;
    if (count > mostClosers) {
      return true;
    }
  }
  return false;
};

/** What a client would link, as markdown-it links it, with every top-level domain. */
const linkify = new LinkifyIt({
  fuzzyLink: true,
  fuzzyEmail: true,
  fuzzyIP: true,
}).tlds(tlds);

/** A bare email address, which stays: a click opens a draft, nothing more. */
const isBareEmail = (match: Match): boolean =>
  match.schema === "mailto:" && !/^mailto:/iu.test(match.raw);

/** The addresses in `text` that are cut. */
const addressesIn = (text: string): Match[] =>
  linkify.match(text)?.filter((match) => !isBareEmail(match)) ?? [];

/** A citation of what the chat read (`citedIn`): it stays. */
const citation = /^grasp:note\/[\w-]{1,128}$/u;

/** A code block's opening fence. */
const fence = /^(?:`{3}|~{3})/u;

/** Nodes that show nothing of their own and are cut. */
const cutNodes: ReadonlySet<Nodes["type"]> = new Set([
  "html",
  "definition",
  "footnoteDefinition",
  "footnoteReference",
]);

/** Nodes whose children are the words a block shows. */
const blockText: ReadonlySet<Nodes["type"]> = new Set([
  "paragraph",
  "heading",
  "tableCell",
]);

type Parent = Extract<Nodes, { children: unknown }>;

const hasChildren = (node: Nodes): node is Parent => "children" in node;

/** `node`'s children, none for a leaf. */
const childrenOf = (node: Nodes): readonly Nodes[] =>
  hasChildren(node) ? node.children : [];

/** Gives `parent` the children `kept`, in place. */
const keepChildren = (parent: Parent, kept: readonly Nodes[]): void => {
  // Each node kept was a child of this parent, or text in its place.
  const children: Nodes[] = parent.children;
  children.length = 0;
  for (const node of kept) {
    children.push(node);
  }
};

/** Pushes `nodes` on `pending` so the first of them is popped first. */
const pushAll = (pending: Nodes[], nodes: readonly Nodes[]): void => {
  for (const node of nodes.toReversed()) {
    pending.push(node);
  }
};

/** One stretch of what a block shows, and the node it comes from. */
interface Shown {
  node: Text | InlineCode | undefined;
  from: number;
  to: number;
}

/** What a block's words show, in order, and where each node's part is. */
const shownIn = (block: Parent): { text: string; parts: Shown[] } => {
  let text = "";
  const parts: Shown[] = [];
  const pending: Nodes[] = [];
  pushAll(pending, childrenOf(block));
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === "text" || node.type === "inlineCode") {
      parts.push({
        node,
        from: text.length,
        to: text.length + node.value.length,
      });
      text += node.value;
    } else if (node.type === "break") {
      text += "\n";
    } else {
      pushAll(pending, childrenOf(node));
    }
  }
  return { text, parts };
};

/** Where an address stands in a text. */
interface Span {
  index: number;
  lastIndex: number;
}

/**
 * `text` without `matches`, each with the spaces before it, or after it
 * where nothing is before it.
 */
const without = (text: string, matches: readonly Span[]): string => {
  let left = text;
  for (const { index, lastIndex } of matches.toReversed()) {
    const before = left.slice(0, index).trimEnd();
    const after = left.slice(lastIndex);
    left = `${before}${before === "" ? after.trimStart() : after}`;
  }
  return left;
};

/**
 * Cuts every address from what `block` shows: from the text it stands in,
 * or, for one that runs across nodes, by making the block plain text. One
 * inside a code span stays. Whether anything was cut.
 */
const cutAddresses = (block: Parent): boolean => {
  const { text, parts } = shownIn(block);
  const matches = addressesIn(text);
  if (matches.length === 0) {
    return false;
  }
  const cuts = new Map<Text, Span[]>();
  for (const match of matches) {
    const part = parts.find(
      ({ from, to }) => from <= match.index && match.lastIndex <= to
    );
    if (part?.node?.type === "inlineCode") {
      continue;
    }
    if (part?.node === undefined) {
      // Across nodes: nothing to cut it from, so the block shows its words
      // as plain text, every address cut.
      keepChildren(block, [{ type: "text", value: without(text, matches) }]);
      return true;
    }
    const span = {
      index: match.index - part.from,
      lastIndex: match.lastIndex - part.from,
    };
    cuts.set(part.node, [...(cuts.get(part.node) ?? []), span]);
  }
  for (const [node, inNode] of cuts) {
    node.value = without(node.value, inNode);
  }
  return cuts.size > 0;
};

/**
 * The address of a bare email address the parser made a link of
 * (`<hr@acme.com>` or `hr@acme.com`), which stays, as its text.
 */
const bareEmailOf = (node: Nodes): string | undefined => {
  if (node.type !== "link") {
    return undefined;
  }
  const [words, ...more] = node.children;
  if (
    words?.type !== "text" ||
    more.length > 0 ||
    node.url !== `mailto:${words.value}`
  ) {
    return undefined;
  }
  const [match, ...others] = linkify.match(words.value) ?? [];
  const whole =
    match !== undefined &&
    others.length === 0 &&
    isBareEmail(match) &&
    match.index === 0 &&
    match.lastIndex === words.value.length;
  return whole ? words.value : undefined;
};

/**
 * Whether link `node`'s words are its address (`<https://…>`, or one the
 * parser found written out, `www.…`), which goes with it.
 */
const wordsAreAddress = (node: Nodes): boolean => {
  if (node.type !== "link") {
    return false;
  }
  const [words, ...more] = node.children;
  return (
    words?.type === "text" &&
    more.length === 0 &&
    [words.value, `http://${words.value}`, `mailto:${words.value}`].includes(
      node.url
    )
  );
};

/**
 * Keeps `node`, as one text with the text kept right before it. After an
 * address cut whole (`closing`), the spaces before it go, as they do for
 * one cut from a text (`without`), or the spaces after it at the start.
 */
const keep = (kept: Nodes[], node: Nodes, closing = false): void => {
  const last = kept.at(-1);
  if (node.type !== "text") {
    kept.push(node);
  } else if (last?.type === "text") {
    const before = closing ? last.value.trimEnd() : last.value;
    const value = before === "" ? node.value.trimStart() : node.value;
    kept[kept.length - 1] = { type: "text", value: before + value };
  } else {
    const value =
      closing && last === undefined ? node.value.trimStart() : node.value;
    kept.push({ type: "text", value });
  }
};

/** Whether `node` is a link that leads somewhere: all but a citation. */
const leads = (node: Nodes): boolean =>
  (node.type === "link" && !citation.test(node.url)) ||
  node.type === "linkReference";

/**
 * Cleans `parent`'s children in place: a link becomes its words, an image
 * its alt text, and what shows nothing of its own goes. Whether anything
 * changed, and the children kept, to clean in turn.
 */
const cleanChildren = (parent: Parent): { changed: boolean; kept: Nodes[] } => {
  let changed = false;
  let closing = false;
  const kept: Nodes[] = [];
  const pending: Nodes[] = [];
  pushAll(pending, childrenOf(parent));
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const email = bareEmailOf(node);
    if (wordsAreAddress(node) && email === undefined) {
      changed = true;
      closing = true;
      continue;
    }
    if (email !== undefined) {
      keep(kept, { type: "text", value: email }, closing);
    } else if (cutNodes.has(node.type)) {
      changed = true;
      continue;
    } else if (leads(node)) {
      changed = true;
      pushAll(pending, childrenOf(node));
    } else if (node.type === "image" || node.type === "imageReference") {
      changed = true;
      keep(kept, { type: "text", value: node.alt ?? "" }, closing);
    } else {
      keep(kept, node, closing);
    }
    closing = false;
  }
  const last = kept.at(-1);
  if (closing && last?.type === "text") {
    kept[kept.length - 1] = { type: "text", value: last.value.trimEnd() };
  }
  keepChildren(parent, kept);
  return { changed, kept };
};

/**
 * Whether code block `code` of `source` has to be written again: code
 * shows as it is written, unless it was indented, which a platform that
 * doesn't take indented code shows as text; so an indented one holding
 * an address is written again, fenced.
 */
const unfenced = (code: Nodes, source: string): boolean => {
  if (code.type !== "code") {
    return false;
  }
  const at = code.position?.start.offset;
  const fenced = at !== undefined && fence.test(source.slice(at));
  return !fenced && addressesIn(code.value).length > 0;
};

/**
 * Cleans `block`, a top-level block of `source`, in place: whether it was
 * cut whole, changed, or kept as it is.
 */
const cleanBlock = (
  block: Root["children"][number],
  source: string
): "cut" | "changed" | "kept" => {
  if (cutNodes.has(block.type)) {
    return "cut";
  }
  let changed = false;
  const blocks: Parent[] = [];
  const parents: Nodes[] = [block];
  for (
    let parent = parents.pop();
    parent !== undefined;
    parent = parents.pop()
  ) {
    changed ||= unfenced(parent, source);
    if (!hasChildren(parent)) {
      continue;
    }
    if (blockText.has(parent.type)) {
      blocks.push(parent);
    }
    const cleaned = cleanChildren(parent);
    changed ||= cleaned.changed;
    pushAll(parents, cleaned.kept);
  }
  for (const words of blocks) {
    changed = cutAddresses(words) || changed;
  }
  return changed ? "changed" : "kept";
};

/**
 * How a block cleaned of something is written again. An `@` in its text
 * is written as it is, not escaped: the escape would only keep a bare
 * email address from showing as one, which it may, and Teams and Slack
 * would show the backslash.
 */
const written = (block: Root["children"][number]): string =>
  stringifyMarkdown(
    { type: "root", children: [block] },
    {
      bullet: "-",
      emphasis: "_",
      handlers: {
        text: (node: Text, _parent, state, info) => {
          const { unsafe } = state;
          state.unsafe = unsafe.filter(({ character }) => character !== "@");
          try {
            return state.safe(node.value, info);
          } finally {
            state.unsafe = unsafe;
          }
        },
      },
    }
  ).trimEnd();

/**
 * `source` cleaned once: each block nothing was cut from as it is, each
 * other one written again, or gone; `undefined` when nothing was cut.
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

/**
 * The agent's own words in a chat app, without links or addresses: what
 * is streamed, posted and stored. Empty when they can't be placed.
 */
export const withoutLinks = (text: string): string => {
  if (tooCostly(text)) {
    return "";
  }
  let current = text;
  try {
    for (let round = 0; round < rounds; round += 1) {
      const next = cleanOnce(current);
      if (next === undefined) {
        return current;
      }
      current = next;
    }
  } catch {
    // The parser can't take it (its own recursion, on nesting thousands
    // deep): cut whole.
  }
  return "";
};

/**
 * Syntax that may open a link, an image, HTML, a code span, an escape or
 * a character reference, which a later chunk may still close.
 */
const openSyntax = /[\\`[<!&]/u;

/**
 * Of an answer being written (`partial`), the part of its cleaned words
 * that is final, as far as can be told: its complete blocks, and of the
 * last one, the words before any syntax that may open a link a later
 * chunk closes (`openSyntax`), and before its last word, which may still
 * grow into an address. So the first half of a link split over two
 * chunks never shows; the words shown are cleaned on their own too, and
 * are none if they don't hold.
 */
export const settledWithoutLinks = (partial: string): string => {
  const cleaned = withoutLinks(partial);
  let last: number | undefined;
  try {
    last = parseMarkdown(cleaned).children.at(-1)?.position?.start.offset;
  } catch {
    return "";
  }
  if (last === undefined) {
    return "";
  }
  const tail = cleaned.slice(last);
  const open = tail.search(openSyntax);
  const closed = open === -1 ? tail : tail.slice(0, open);
  const settled =
    `${cleaned.slice(0, last)}${closed.slice(0, closed.search(/\S*$/u))}`.trimEnd();
  return withoutLinks(settled) === settled ? settled : "";
};

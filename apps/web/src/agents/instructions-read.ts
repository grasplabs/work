import { parseMarkdown } from "@grasp-os/ui/components/markdown";

// An agent's instructions as its page reads them (agent-overview.tsx):
// Markdown, folded on whole blocks, and each app or person it names by
// name drawn as a chip. Core keeps the instructions as plain words
// (instruction-files.ts), not with references, so a name is found in the
// words' text nodes, never in code or a link, and only where it stands as
// a whole word. A found name becomes a Markdown link with its own scheme,
// which the page's renderLink draws as a chip: the parser stays the one
// that reads the rest.

/** The scheme a named thing's link carries, and what it names after it. */
export const mentionScheme = "grasp-mention";
export type MentionKind = "app" | "person";

/** A thing the instructions may name: an app the agent has, a person of the company. */
export interface Named {
  name: string;
  kind: MentionKind;
}

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Nodes whose words aren't searched: code, and what already leads somewhere. */
const closed = new Set([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "definition",
  "html",
]);

const bracket = /[\\[\]]/gu;
const letter = /[\p{L}\p{M}\p{N}]/u;

const escaped = (words: string): string => words.replaceAll(bracket, "\\$&");

/**
 * Each place in text where name stands as written, as a whole word: a
 * name is a proper noun, so "Files" the app never takes "files" the word.
 * Never right after "!", which would make its link a picture, or "\",
 * which would leave its opening bracket as text.
 */
const placesOf = (text: string, name: string): number[] => {
  const places: number[] = [];
  let from = text.indexOf(name);
  while (from !== -1) {
    const before = text.slice(0, from).at(-1) ?? "";
    const after = text.at(from + name.length) ?? "";
    if (
      !letter.test(before) &&
      !letter.test(after) &&
      before !== "!" &&
      before !== "\\"
    ) {
      places.push(from);
    }
    from = text.indexOf(name, from + name.length);
  }
  return places;
};

interface Found {
  from: number;
  to: number;
  kind: MentionKind;
}

/** Every name found in the text nodes under node; the longest names come first, so one never splits another. */
const foundIn = (node: Node, named: readonly Named[]): Found[] => {
  if (closed.has(node.type)) {
    return [];
  }
  if (node.type !== "text") {
    return (node.children ?? []).flatMap((child) => foundIn(child, named));
  }
  const start = node.position?.start.offset;
  const text = node.value ?? "";
  // A text node whose words aren't the source's own (an escape, an
  // entity) is left as it is: its offsets don't match its words.
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || end - start !== text.length) {
    return [];
  }
  const taken: Found[] = [];
  for (const { name, kind } of named) {
    for (const place of placesOf(text, name)) {
      const from = start + place;
      const to = from + name.length;
      if (taken.every((each) => to <= each.from || from >= each.to)) {
        taken.push({ from, to, kind });
      }
    }
  }
  return taken;
};

/**
 * source with each of named it names as a link of {@link mentionScheme}
 * ("[Exact Online](grasp-mention:app)"), its words as the source has them.
 */
export const withMentions = (
  source: string,
  named: readonly Named[]
): string => {
  const usable = named
    .filter(({ name }) => name.trim() !== "")
    .toSorted((a, b) => b.name.length - a.name.length);
  if (usable.length === 0) {
    return source;
  }
  const tree: Node = parseMarkdown(source);
  let text = source;
  // From the end, so each place found still stands where it was.
  for (const { from, to, kind } of foundIn(tree, usable).toSorted(
    (a, b) => b.from - a.from
  )) {
    text = `${text.slice(0, from)}[${escaped(text.slice(from, to))}](${mentionScheme}:${kind})${text.slice(to)}`;
  }
  return text;
};

/** The kind a mention's address names; undefined for any other address. */
export const mentionOf = (href: string): MentionKind | undefined => {
  const [scheme, kind] = href.split(":");
  return scheme === mentionScheme && (kind === "app" || kind === "person")
    ? kind
    : undefined;
};

/**
 * How many blocks (paragraphs, lists, headings) the instructions have,
 * and the source of their first kept, for a fold on whole blocks.
 */
export const foldOf = (
  source: string,
  kept: number
): { blocks: number; folded: string } => {
  const blocks = parseMarkdown(source).children.filter(
    ({ type }) => type !== "definition"
  );
  const end = blocks.at(kept - 1)?.position?.end.offset;
  return {
    blocks: blocks.length,
    folded:
      blocks.length <= kept || end === undefined
        ? source
        : source.slice(0, end),
  };
};

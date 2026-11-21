import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { defaultUrlTransform } from "react-markdown";

import { Link } from "./grasp/link/index.ts";
import { Markdown } from "./grasp/markdown/index.ts";
import type { MarkdownDrawn, MarkdownLink } from "./grasp/markdown/index.ts";

// Markdown that someone or something else wrote, such as an export's
// text, rendered by Grasp UI's Markdown so that nothing in it runs or
// loads: raw HTML is dropped before it is drawn, a link keeps its address
// only for a safe protocol (http, https, mailto and a few more;
// react-markdown's `defaultUrlTransform` empties any other, such as
// `javascript:`), and opens in a tab of its own without this page as its
// opener. Images show their alt text: loading one would tell its host who
// read the text, and when (Markdown never loads one).

/** The part of a Markdown syntax tree read here. */
interface Node {
  type: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** A span of the source and what replaces it. */
interface Edit {
  from: number;
  to: number;
}

/** The raw HTML in `node`, to drop: read from the syntax tree, so code keeps its words. */
const htmlOf = (node: Node): Edit[] => {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if (from === undefined || to === undefined) {
    return [];
  }
  if (node.type === "html") {
    return [{ from, to }];
  }
  return (node.children ?? []).flatMap((child) => htmlOf(child));
};

/** `source` as it is drawn: its raw HTML dropped. */
const prepared = (source: string): string => {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return htmlOf(tree)
    .toSorted((a, b) => b.from - a.from)
    .reduce(
      (text, edit) => text.slice(0, edit.from) + text.slice(edit.to),
      source
    );
};

/**
 * A link: in a tab of its own, without this page as its opener. An
 * address the transform empties is unsafe: the words stay, as words. A
 * picture is its alt words, never loaded.
 */
const leaving = ({ href, kind, children }: MarkdownLink): MarkdownDrawn => {
  const safe = defaultUrlTransform(href);
  if (kind === "image" || safe === "") {
    return <span>{children}</span>;
  }
  return (
    <Link external href={safe}>
      {children}
    </Link>
  );
};

/**
 * Markdown such as an export's text, safely: no raw HTML, safe links
 * only, no images.
 */
export const PlainMarkdown = ({ text }: { text: string }) => (
  <Markdown renderLink={leaving} source={prepared(text)} />
);

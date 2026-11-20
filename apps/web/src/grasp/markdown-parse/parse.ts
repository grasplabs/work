// Markdown to a syntax tree (mdast), with GitHub's additions: tables, task lists, strikethrough,
// autolinks and footnotes. One parse for Markdown (src/components/markdown) and the Artifact viewer's
// Markdown item (src/components/artifact-viewer-markdown, which runs it in its Worker). Never HTML:
// raw HTML in the source stays a text node. Each node keeps its offsets in the source. Pinned as the
// product resolves them: mdast-util-from-markdown 2.0.3, micromark-extension-gfm 3.0.0,
// mdast-util-gfm 3.1.0.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** A Markdown syntax tree (mdast). */
export type MarkdownRoot = ReturnType<typeof fromMarkdown>;

/** The tree of `source`. */
export const parseMarkdown = (source: string): MarkdownRoot =>
  fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

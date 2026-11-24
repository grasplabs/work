// Markdown is a folder, not one file, because its pure half earns its own: parse.ts reads the
// answer (the tree, the safe links, the repair of a half-written answer) with no React, so it is
// tested as plain functions, and markdown.tsx draws what it reads.
export { Markdown, MarkdownLinkProvider } from "./markdown";
export type {
  MarkdownLink,
  MarkdownLinkRenderer,
  MarkdownProps,
  MarkdownSoftBreaks,
} from "./markdown";
export { parseMarkdown } from "./parse";
export type { MarkdownRoot } from "./parse";

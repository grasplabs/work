// Markdown is a folder because its pure half earns its own file: parse.ts cuts and reads the answer
// with no React, so it is tested as plain functions; markdown.tsx draws what it reads.
export { Markdown, MarkdownLinkProvider } from "./markdown";
export type {
  MarkdownComponents,
  MarkdownLink,
  MarkdownLinkRenderer,
  MarkdownNode,
  MarkdownProps,
} from "./markdown";
export { parseMarkdown } from "./parse";
export type { MarkdownRoot } from "./parse";

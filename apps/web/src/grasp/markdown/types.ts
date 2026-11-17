// The syntax tree's node types, read from the parser's own return type (parse.ts), so the
// component needs no package beyond the parser itself.
import type { fromMarkdown } from "mdast-util-from-markdown";

export type Root = ReturnType<typeof fromMarkdown>;
export type RootContent = Root["children"][number];
type Of<Type extends RootContent["type"]> = Extract<
  RootContent,
  { type: Type }
>;
export type Definition = Of<"definition">;
export type FootnoteDefinition = Of<"footnoteDefinition">;
export type List = Of<"list">;
export type ListItem = List["children"][number];
export type Table = Of<"table">;
export type PhrasingContent = Of<"paragraph">["children"][number];

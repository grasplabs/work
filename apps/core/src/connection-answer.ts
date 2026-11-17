import { ContentBlockSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";

// The text the Brain keeps of a tool's answer (connection-capture.ts), as
// MCP shapes a tool's result: connect answers every MCP server's result
// (a native connector's, a toolkit's) as its structured content, or else
// the text of its blocks, or else its content blocks as they are, as JSON
// text (connect's mcp.ts `resultOf`). Each block is read by the MCP SDK's
// own schema, never by rules of ours.
//
// Kept: structured content as its JSON, a text block's text, a resource
// link's name, title, description and URI, an embedded resource's text.
// Left out, and counted: an image or audio block, an embedded binary
// resource (bytes are no text to find), and a block the SDK can't read.
// Nothing is read deeper than the list of blocks, however deep an answer
// nests: structured content stays the JSON text connect gave.

/** What an answer is kept as: its text, and how many blocks were left out. */
export interface AnswerText {
  /** Empty when nothing in it is text. */
  text: string;
  leftOut: number;
}

/** The text of `block`, or undefined for one that holds none. */
const textOf = (block: ContentBlock): string | undefined => {
  switch (block.type) {
    case "text": {
      return block.text;
    }
    case "resource_link": {
      return [block.title ?? block.name, block.description, block.uri]
        .filter((part) => part !== undefined && part !== "")
        .join("\n");
    }
    case "resource": {
      return "text" in block.resource ? block.resource.text : undefined;
    }
    case "image":
    case "audio": {
      return undefined;
    }
    default: {
      return undefined;
    }
  }
};

/** The text `output` (a tool's answer, as connect gives it) is kept as. */
export const answerText = (output: string): AnswerText => {
  const answer: unknown = JSON.parse(output);
  if (typeof answer === "string") {
    return { text: answer, leftOut: 0 };
  }
  if (!Array.isArray(answer)) {
    return { text: output, leftOut: 0 };
  }
  const texts: string[] = [];
  for (const each of answer) {
    const block = ContentBlockSchema.safeParse(each);
    const text = block.success ? textOf(block.data) : undefined;
    if (text !== undefined) {
      texts.push(text);
    }
  }
  return { text: texts.join("\n\n"), leftOut: answer.length - texts.length };
};

// The viewer as an agent sees it, through the page's one agent bridge (UI SDK's createAgent): a
// component named after the file, whose actions read it and propose edits to it. The actions are
// the viewer's own functions, handed in as an option, so they always read the file as it is now.
//
//   await agent.act({ steps: [{ ref: "launch-plan.md", action: "read" }] })
//   await agent.act({ steps: [{ ref: "launch-plan.md", action: "proposeEdit", args: [{ threadId: "t1", replacement: "mid-July", note: "As agreed" }] }] })
//
// An agent can propose; it can never accept. Accept is the person's button, marked
// `data-agent-confirm`, so the bridge asks the person before an agent's press could run.
import { definePrimitive } from "@ui-sdk/core";

/** What an agent may ask of the viewer. Each answers with plain data, or `{ error }`. */
export interface ViewerTools {
  /** The file's text from `offset`, at most 20,000 characters, with where to go on. */
  read: (input?: { offset?: number; page?: number }) => unknown;
  /** Its headings or pages. */
  outline: () => unknown;
  /** Its comment threads, where each is now, and the proposed edits. */
  comments: () => unknown;
  /** Where words stand in it, 50 places at most. */
  find: (input: { query: string } | string) => unknown;
  /** A proposed edit: a replacement for a thread's words, or for a range of the text. */
  proposeEdit: (input: ProposeInput) => unknown;
}

export interface ProposeInput {
  /** A comment thread, whose words are replaced. */
  threadId?: string;
  /** Or a range of the source text, in offsets, end excluded. */
  range?: { start: number; end: number };
  /** Or the first place these exact words stand. */
  find?: string;
  /** The words to put in their place. */
  replacement: string;
  /** Why: shown with the proposal. */
  note?: string;
}

interface Options {
  tools?: ViewerTools;
}

const call = (options: () => Options, ask: (tools: ViewerTools) => unknown) => {
  const { tools } = options();
  if (!tools) {
    return { error: "The file is not open yet." };
  }
  try {
    return ask(tools);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

export const artifactViewerAgent = definePrimitive({
  name: "artifact-viewer",
  options: { tools: "value" },
  state: (_options: Options) => ({}),
  api: (context) => ({
    read: (input?: Parameters<ViewerTools["read"]>[0]) =>
      call(context.options, (tools) => tools.read(input)),
    outline: () => call(context.options, (tools) => tools.outline()),
    comments: () => call(context.options, (tools) => tools.comments()),
    find: (input: Parameters<ViewerTools["find"]>[0]) =>
      call(context.options, (tools) => tools.find(input)),
    proposeEdit: (input: ProposeInput) =>
      call(context.options, (tools) => tools.proposeEdit(input)),
  }),
  slots: (slot) => ({
    root: slot({}),
  }),
  agent: { actions: ["read", "outline", "comments", "find", "proposeEdit"] },
});

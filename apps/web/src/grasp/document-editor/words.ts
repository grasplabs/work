// DocumentEditor's own words, in English. The product gives them in its languages through
// GraspWords (src/words); an instance's `words` wins key by key.
export const documentEditorWords = {
  /** The document's name, said to a screen reader when nothing else names it. */
  label: "Document",
  /** What the empty document says until the first word. */
  placeholder:
    "Write here. Use # for a heading, 1. for steps and - for a list.",
  /** What an empty heading says. */
  headingPlaceholder: "Heading",
  /** What a collapsible section's empty summary says. */
  summaryPlaceholder: "Section title",
  /** The format bar's name, said to a screen reader. */
  formatBar: "Format",
  bold: "Bold",
  italic: "Italic",
  code: "Code",
  link: "Link",
  /** What the link's field asks for. */
  linkAddress: "Link address",
  heading: "Heading",
  numberedList: "Numbered list",
  bulletList: "Bulleted list",
  quote: "Quote",
  collapsible: "Collapsible section",
  /** The button that opens a collapsible section. */
  expand: "Show section",
  /** The button that closes it. */
  collapse: "Hide section",
  /** Said while the agent rewrites the text, and shown beside the header. */
  rewriting: "Grasp is rewriting",
  /** Said once the rewrite is in. */
  rewritten: "Rewritten by Grasp",
  /** The button that brings the old text back after a rewrite. */
  undoRewrite: "Undo rewrite",
  /** What an embed card says of what it opens, by its kind. */
  embedKinds: {
    Interview: "Interview",
    Document: "Document",
    Note: "Note",
    App: "App",
  },
  /** The quiet line on an Ask block written from a chat. */
  askedFromChat: "Asked from chat",
  /** The quiet line on an Ask block written in the page. */
  askedHere: "Asked in this page",
  /** The control that asks Grasp again for one part. */
  askAgain: "Ask again",
  /** Said and shown while Grasp writes that part again. */
  askingAgain: "Grasp is asking again",
  /** Said once the new part is in. */
  askedAgain: "Asked again. Undo brings the last answer back.",
  /** What a failed ask again says. */
  askFailed: "Grasp couldn't answer again. The last answer stays.",
  /** The heading of an Ask block's sources. */
  sources: "Sources",
  /** The handle beside a block: its menu. */
  blockMenu: "Block menu",
  /** The `+` beside a block: a new block under it. */
  addBlock: "Add a block below",
  /** The block menu's group of kinds. */
  turnInto: "Turn into",
  /** The `+` menu's group of kinds. */
  insert: "Insert",
  /** Each kind, as the menus name it. */
  kinds: {
    paragraph: "Text",
    heading: "Heading",
    bulletList: "Bulleted list",
    orderedList: "Numbered list",
    blockquote: "Quote",
    callout: "Callout",
    details: "Collapsible section",
    table: "Table",
  },
  /** The slash menu, when no kind's name holds the letters typed after `/`. */
  noBlock: (query: string) => `No block called “${query}”`,
  /** Said as the slash menu's list changes. */
  blocksFound: (count: number) =>
    count === 1 ? "1 block" : `${String(count)} blocks`,
  duplicate: "Duplicate",
  moveUp: "Move up",
  moveDown: "Move down",
  deleteBlock: "Delete",
};

export type DocumentEditorWords = typeof documentEditorWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    documentEditor: DocumentEditorWords;
  }
}

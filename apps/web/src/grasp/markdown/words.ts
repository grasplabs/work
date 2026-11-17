// Markdown's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's text props still win until the breaking release's step 5. A fenced
// code block's words are Code block's own entry (`codeBlock`).
export const markdownWords = {
  /** What a link that leaves the product says to a screen reader, after its words (`externalLabel`). */
  external: "opens in a new tab",
  /** The link from a footnote back to where it is used, from its number (`backLabel`). */
  back: (number: number) => `Back to reference ${number}`,
  /** A footnote's mark, said to a screen reader, from its number (`footnoteLabel`). */
  footnote: (number: number) => `Footnote ${number}`,
  /** What a ticked task says to a screen reader (`doneLabel`). */
  done: "Done",
  /** What a task not yet ticked says (`notDoneLabel`). */
  notDone: "Not done",
  /** A table's name when no heading stands above it (`tableLabel`). */
  table: "Table",
};

export type MarkdownWords = typeof markdownWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    markdown: MarkdownWords;
  }
}

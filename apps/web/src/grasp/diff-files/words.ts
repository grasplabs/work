// DiffFiles' own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `words` and `aria-label` still win.
import type { DiffFilesWords } from "./diff-files";

const ownWords: DiffFilesWords = {
  added: "Added",
  deleted: "Deleted",
  modified: "Modified",
  filesChanged: (files) => {
    if (files === 0) {
      return "No files changed";
    }
    return `${files} ${files === 1 ? "file" : "files"} changed`;
  },
  counts: (added, removed) =>
    `${added === 0 ? "No" : added} ${added === 1 ? "line" : "lines"} added, ${removed === 0 ? "none" : removed} removed`,
  nothing: "No files changed.",
};

/** Its words in the catalogue: its own, and its name when the caller gives none. */
export const diffFilesWords = { ...ownWords, name: "What changes" };

export type DiffFilesCatalogueWords = typeof diffFilesWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    diffFiles: DiffFilesCatalogueWords;
  }
}

// Small readings of a source, shared by the parts of Sources.
import type { Source, SourceAccess, SourceKind } from "./types";

/** A source's kind; a source without one is a web page, as Sources drew every source before kinds. */
export const kindOf = (source: Source): SourceKind => source.kind ?? "web";

/** Whether the person can open it; `unavailable` is the older way of saying gone. */
export const accessOf = (source: Source): SourceAccess =>
  source.unavailable === true ? "gone" : (source.access ?? "open");

/** Whether a source was found by an agent or a workflow: those wear our mint. */
export const isRun = (kind: SourceKind) =>
  kind === "agent" || kind === "workflow";

/** Words that are there: not left out and not empty. */
export const hasWords = (words: string | undefined): words is string =>
  words !== undefined && words !== "";

/** Whether its row and card may open it: open, with somewhere to go or a page's `onOpen` to run. */
export const opens = (source: Source, onOpen?: unknown) =>
  accessOf(source) === "open" &&
  (hasWords(source.href) || onOpen !== undefined);

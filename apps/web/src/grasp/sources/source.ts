// Small readings of a source, shared by the parts of Sources.
import type { Source, SourceAccess, SourceKind, SourceMention } from "./types";

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

/**
 * The source as one mention of it cites it: the mention's own quote, its context and place, and a
 * code source's own lines, each in place of the source's where given. A meeting marks the line of
 * its transcript that holds the mention's quote. What the mention leaves out is the source's.
 */
export const asMentioned = (source: Source, mention: SourceMention): Source => {
  const { quote, context, place, lines } = mention;
  if (
    quote === undefined &&
    context === undefined &&
    place === undefined &&
    lines === undefined
  ) {
    return source;
  }
  const own = hasWords(quote) ? quote : undefined;
  return {
    ...source,
    ...(own === undefined ? {} : { quote: own, context }),
    ...(own === undefined && context !== undefined ? { context } : {}),
    ...(place === undefined ? {} : { place }),
    ...(lines === undefined || source.code === undefined
      ? {}
      : { code: { ...source.code, marked: lines } }),
    ...(own === undefined || source.transcript === undefined
      ? {}
      : {
          transcript: source.transcript.map((line) => ({
            ...line,
            quoted: line.line.includes(own),
          })),
        }),
  };
};

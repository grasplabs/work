// Thread's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `words` and `jumpLabel` still win until the breaking release's step 5.
// The days are written in the catalogue's locale unless a catalogue or a caller gives `day`.
import { dayWritten } from "./rows";

export const threadWords = {
  /** The button that brings the person back down (`jumpLabel`). */
  jump: "Jump to latest",
  /** The line before the first unread message, as it is seen. */
  unread: "Unread",
  /** The same line, as it is said. */
  unreadFrom: "Unread messages from here",
  /** While older messages load at the top. */
  loadingOlder: "Loading older messages",
  /** The way back down when a message has come in since the reader left, from the jump's words. */
  jumpToNew: (jumpLabel: string) => `${jumpLabel}, new messages`,
  /** What a screen reader hears for the messages that came in, from their count. */
  arrived: (count: number) =>
    count === 1 ? "1 new message" : `${count} new messages`,
  /** The date line for today. */
  today: "Today",
  /** The date line for yesterday. */
  yesterday: "Yesterday",
  /** A day further back, as it is written; `sameYear` is false for a day in another year. */
  day: (day: Date, sameYear: boolean) => dayWritten(day, sameYear),
};

export type ThreadCatalogueWords = typeof threadWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    thread: ThreadCatalogueWords;
  }
}

import { eraseSource } from "./brain-next.ts";
import type { SourceRef } from "./brain-next.ts";

// What core hands the Brain comes from an origin core keeps (an upload's
// document, a chat, a workflow run), and each origin's sources are named
// here alone, one function per kind: producers add under these keys
// (GRA-1727), and whatever deletes an origin erases them, so both always
// name the same sources. Every id is the server's own (a Knowledge
// document's, a chat's UUID with one of its messages' row ids, a run's),
// never anything a person typed, and none is ever used for another
// origin: chat ids are random, message ids AUTOINCREMENT.
//
// Erasing what an origin had in the Brain comes before core lets go of
// what names its keys, and a failure leaves the origin as it was, so the
// erasure stays owed by the origin's own state until a retry returns
// (the Brain's rule: only a call that returned is in its ledger): a
// chat's deletion fails and the chat stays, a purge fails before it
// forgets an upload, a run's retention marks nothing. Erasing a key that
// was never added closes it all the same, so a hand-over still under way
// for a deleted origin is refused rather than landing after.

/** The source an upload's text is under: its Knowledge document. */
export const uploadSource = (documentId: string): SourceRef => ({
  producer: "upload",
  id: documentId,
});

/**
 * The source of one turn of chat `chatId`, named by the row id of one of
 * the turn's messages (`chat_messages.id`, by convention its first).
 * Deleting the chat erases the key of every message it holds.
 */
export const chatTurnSource = (
  chatId: string,
  messageId: number
): SourceRef => ({
  producer: "chat",
  id: `${chatId}/${messageId}`,
});

/** The source of what a workflow run did: the run's own. */
export const runSource = (runId: string): SourceRef => ({
  producer: "run",
  id: runId,
});

/** Why sources are erased, as the Brain's ledger records it. */
type ErasureReason = Parameters<typeof eraseSource>[1]["reason"];

/** How many erasures one caller has under way at once. */
const erasingAtOnce = 8;

/**
 * Erases every one of `sources` for `reason`, a few at a time; throws
 * once one failed, after those under way with it settled. Safe to repeat:
 * a source erased before is erased again alike, so whoever retries
 * passes them all again.
 */
export const eraseSources = async (
  env: Pick<Env, "BRAIN_STORE" | "DURABLE_OBJECT_JURISDICTION">,
  sources: readonly SourceRef[],
  reason: ErasureReason
): Promise<void> => {
  for (let at = 0; at < sources.length; at += erasingAtOnce) {
    // oxlint-disable-next-line no-await-in-loop -- a few at a time
    const settled = await Promise.allSettled(
      sources.slice(at, at + erasingAtOnce).map(async (source) => {
        await eraseSource(env, { source, reason });
      })
    );
    const failed = settled.find((each) => each.status === "rejected");
    if (failed !== undefined) {
      throw failed.reason;
    }
  }
};

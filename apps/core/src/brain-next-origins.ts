import { eraseOwnGroup, eraseSource } from "./brain-next.ts";
import type { SourceReaders, SourceRef } from "./brain-next.ts";

// What core hands the Brain comes from an origin core keeps (an upload, a
// workflow run), and each origin's sources are named here alone, one
// function per kind: producers add under these keys (GRA-1727, GRA-1824),
// and whatever erases an origin erases them, so both always name the same
// sources. Every id is the server's own (an upload's, a run's), never
// anything a person typed. A chat's turns go only into its person's own
// store (GRA-1762, GRA-1805): a source per turn, each in its chat's group,
// so deleting the chat erases them all in one call (`eraseChat`). So do a
// connection's captures (GRA-1730, GRA-1827), in the group of their
// connection, erased when it is disconnected (`eraseCaptures`).
//
// Erasing what an origin had in the Brain comes before core lets go of
// what names its keys, and a failure leaves the origin as it was, so the
// erasure stays owed by the origin's own state until a retry returns
// (the Brain's rule: only a call that returned is in its ledger): a run's
// retention marks nothing, a person's erasure keeps its area pending.
// Erasing a key that was never added closes it all the same, so a
// hand-over still under way for an erased origin is refused rather than
// landing after.

/** The source of an upload handed to the Brain: the upload's own id. */
export const uploadSource = (uploadId: string): SourceRef => ({
  producer: "upload",
  id: uploadId,
});

/** The source of what a workflow run did: the run's own. */
export const runSource = (runId: string): SourceRef => ({
  producer: "run",
  id: runId,
});

/** Whether `id` can stand in a chat's key: never holding "/", which parts it. */
const isKeyPart = (id: string): boolean => id !== "" && !id.includes("/");

/**
 * The group of `personId`'s chat `chatId`: what each of its turns is added
 * in, and what erasing the chat erases. Throws for an id holding "/",
 * which could make one chat's group another's turn: core's ids never do.
 */
export const chatSource = (personId: string, chatId: string): SourceRef => {
  if (!(isKeyPart(personId) && isKeyPart(chatId))) {
    throw new Error("A chat's key is made of ids without /");
  }
  return { producer: "chat", id: `${personId}/${chatId}` };
};

/**
 * What the id of every source of `personId`'s chats starts with: each
 * chat's group and each of its turns. Throws for an id holding "/", as
 * `chatSource` does.
 */
export const chatsOf = (personId: string): string => {
  if (!isKeyPart(personId)) {
    throw new Error("A chat's key is made of ids without /");
  }
  return `${personId}/`;
};

/**
 * The source of a turn of `personId`'s chat `chatId`: the turn its
 * answer, the chat's message `answerId`, ends.
 */
export const chatTurnSource = (
  personId: string,
  chatId: string,
  answerId: number
): SourceRef => ({
  producer: "chat",
  id: `${chatSource(personId, chatId).id}/${answerId}`,
});

/** A chat turn's source, read back into its parts: undefined for any other id. */
export const chatTurnOf = (
  id: string
): { personId: string; chatId: string; answerId: number } | undefined => {
  const [personId, chatId, answer, ...rest] = id.split("/");
  const answerId = Number(answer);
  if (
    personId === undefined ||
    chatId === undefined ||
    rest.length > 0 ||
    !isKeyPart(personId) ||
    !isKeyPart(chatId) ||
    !Number.isSafeInteger(answerId) ||
    answerId < 1 ||
    String(answerId) !== answer
  ) {
    return undefined;
  }
  return { personId, chatId, answerId };
};

/**
 * Erases every turn of `personId`'s chat `chatId` from their own store,
 * and closes the chat there, so a turn handed over after is refused: one
 * call, however many turns it had: the store writes one ledger entry and
 * hides every turn in one transaction, a turn at a time (linear: about
 * 370 ms per 1,000 turns, measured in workerd), and its tick deletes them
 * a bounded batch at a time. Throws when it
 * failed, and the chat must stay until a repeat returns. Safe to repeat.
 */
export const eraseChat = async (
  env: Pick<Env, "BRAIN_STORE" | "DURABLE_OBJECT_JURISDICTION">,
  personId: string,
  chatId: string
): Promise<void> => {
  await eraseSource(env, {
    source: chatSource(personId, chatId),
    readers: { kind: "owner", personId },
    reason: "deleted",
    // Erased as a group though no turn of it was kept yet, so none can be
    // added under it after, whatever names it.
    asGroup: true,
  });
};

/**
 * The group every capture through the connection `connectionId` is added
 * in, in its person's own store (connection-capture.ts), and what
 * disconnecting the connection erases (`eraseCaptures`). Throws for an id
 * holding "/", which could make one connection's group another's capture:
 * connect's ids never do.
 */
export const captureGroupOf = (connectionId: string): SourceRef => {
  if (!isKeyPart(connectionId)) {
    throw new Error("A connection's captures are keyed by an id without /");
  }
  return { producer: "capture", id: connectionId };
};

/**
 * Erases every capture through `personId`'s own connection `connectionId`
 * from their own store, the only store that holds any, and closes the
 * connection's group there, so a capture landing after is refused: one
 * call, however many captures it had, as `eraseChat`. Answers how many
 * it erased, the same each time it is repeated. Throws when it failed:
 * the connect event that asked for it stays to be drained again
 * (audit-outbox.ts). Safe to repeat.
 */
export const eraseCaptures = async (
  env: Pick<Env, "BRAIN_STORE" | "DURABLE_OBJECT_JURISDICTION">,
  personId: string,
  connectionId: string
): Promise<number> =>
  await eraseOwnGroup(env, {
    personId,
    group: captureGroupOf(connectionId),
    reason: "deleted",
  });

/** Why sources are erased, as the Brain's ledger records it. */
type ErasureReason = Parameters<typeof eraseSource>[1]["reason"];

/** How many erasures one caller has under way at once. */
const erasingAtOnce = 8;

/**
 * Erases `sources` for `reason`, each with the readers its producer adds
 * it with (which say whose own store it may be in), a few at a time, until
 * one fails: then throws its error once those under way with it settled,
 * and starts none after them. Safe to repeat: a source erased before is
 * erased again alike, so whoever retries passes them all again.
 */
export const eraseSources = async (
  env: Pick<Env, "BRAIN_STORE" | "DURABLE_OBJECT_JURISDICTION">,
  sources: readonly { source: SourceRef; readers: SourceReaders }[],
  reason: ErasureReason
): Promise<void> => {
  for (let at = 0; at < sources.length; at += erasingAtOnce) {
    // oxlint-disable-next-line no-await-in-loop -- a few at a time
    const settled = await Promise.allSettled(
      sources.slice(at, at + erasingAtOnce).map(async ({ source, readers }) => {
        await eraseSource(env, { source, readers, reason });
      })
    );
    const failed = settled.find((each) => each.status === "rejected");
    if (failed !== undefined) {
      throw failed.reason;
    }
  }
};

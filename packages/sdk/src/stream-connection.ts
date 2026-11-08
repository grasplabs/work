import { readAnswer, refusedBeforeCallCodes } from "./client-error.ts";
import type { Settled } from "./client-error.ts";
import type { StreamLink } from "./client-transport.ts";
import { isPlainObject } from "./value-descriptor.ts";

/** How a streaming action's connection ended. */
export type Followed =
  | {
      readonly kind: "settled";
      readonly settled: Settled;
      /** Whether the invocation answered, rather than its connection being refused. */
      readonly answered: boolean;
    }
  | { readonly kind: "lost" }
  | { readonly kind: "aborted" };

/** How often a client starts a stream refused before it reached the invocation. */
const streamStartAttempts = 3;

/**
 * Whether a start refused as `followed` (the `refused`th refusal) is
 * worth sending again: only one refused before it reached the invocation
 * (`refusedBeforeCallCodes`). One the invocation answered settled its
 * receipt, which the same key only answers again.
 */
export const startAgain = (
  followed: Followed,
  what: "stream" | "attach",
  refused: number
): boolean =>
  what === "stream" &&
  followed.kind === "settled" &&
  !followed.answered &&
  followed.settled.kind === "failed" &&
  refusedBeforeCallCodes.has(followed.settled.error.code) &&
  refused < streamStartAttempts;

/** How often a client attaches again to a stream whose connection was lost. */
const streamAttachAttempts = 8;

/**
 * How long a stream whose connection was lost is recovered for, however
 * the attempts go: past it, its outcome is unknown, with its key.
 */
const streamRecoverMs = 2 * 60_000;

/** Whether recovering a stream stops, after `tries` since `since`. */
export const recoveryOver = (tries: number, since: number): boolean =>
  tries > streamAttachAttempts || Date.now() - since >= streamRecoverMs;

/** Whether `signal` was aborted, read afresh. */
export const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

/** A stream's frame, as the client reads it; anything else is undefined. */
export const readFrame = (
  frame: unknown
):
  | { readonly type: "progress"; readonly seq: number; readonly value: unknown }
  | { readonly type: "result"; readonly settled: Settled }
  | { readonly type: "closed" }
  | undefined => {
  if (!isPlainObject(frame)) {
    return undefined;
  }
  if (
    frame.type === "progress" &&
    typeof frame.seq === "number" &&
    Number.isSafeInteger(frame.seq) &&
    "value" in frame
  ) {
    return { type: "progress", seq: frame.seq, value: frame.value };
  }
  if (frame.type === "result") {
    return { type: "result", settled: readAnswer({ result: frame.result }) };
  }
  if (frame.type === "refused") {
    const settled = readAnswer({
      result: { ok: false, error: frame.error },
    });
    return { type: "result", settled };
  }
  return frame.type === "closed" ? { type: "closed" } : undefined;
};

/**
 * The connection `opening` resolves with, or undefined once `signal`
 * aborts first: a caller who left stops waiting for an open that stalls,
 * and a connection that arrives after it left is let go of at once.
 */
export const openedUnlessAborted = async (
  opening: Promise<StreamLink>,
  signal: AbortSignal | undefined
): Promise<StreamLink | undefined> => {
  if (signal === undefined) {
    return await opening;
  }
  const left = Promise.withResolvers<"left">();
  const onAbort = (): void => {
    left.resolve("left");
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  try {
    const first = await Promise.race([opening, left.promise]);
    if (first !== "left") {
      return first;
    }
    const letGo = async (): Promise<void> => {
      try {
        const late = await opening;
        await late.release();
      } catch {
        // Never opened, or gone already.
      }
    };
    // Nobody waits for it: the caller left already.
    void letGo();
    return undefined;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

import {
  functionRequestMaxBytes,
  streamIdleCancelMs,
} from "@grasp-os/shared/function-limits";

import type { AccessFence } from "./access-fence.ts";
import { readRejection } from "./call-answers.ts";
import type { Settled } from "./call-answers.ts";
import { clientError } from "./client-error.ts";
import {
  inputOf,
  readOptions,
  readReference,
  streamOptionKeys,
} from "./client-request.ts";
import { retryCapMs, waitAfter } from "./client-retry.ts";
import { freshKey, retryDelay, sleep } from "./client-shared.ts";
import type { ClientTransport, StreamLink } from "./client-transport.ts";
import { deepFreeze } from "./declaration.ts";
import { fences, refusedBeforeCallCodes } from "./refusals.ts";
import {
  isAborted,
  openedUnlessAborted,
  readFrame,
  recoveryOver,
  startAgain,
} from "./stream-connection.ts";
import type { Followed } from "./stream-connection.ts";
import { withKey } from "./submission-verdict.ts";
import { isPlainObject } from "./value-descriptor.ts";

// A streaming action (`stream`) is followed rather than
// answered: its progress snapshots, then its result, over the transport's
// `stream`. More ways it can fail:
// - A reference of the wrong mode runs anyway: `action` takes only a
//   single-answer reference and `stream` only a streaming one, refused
//   before anything is sent (`contract.mode_mismatch`); the host refuses
//   them too.
// - A lost connection runs it again: the client attaches to the same
//   invocation under the same key (`attach`), which never starts one, and
//   gets its latest progress and its result; while it does, the caller is
//   told it is recovering. If it can't, it rejects
//   `stream.outcome_unknown` with the key, never a made-up outcome.
// - Progress is applied unchecked, or out of order: each snapshot is
//   validated against the reference's own `stream` descriptor and handed
//   on only if newer than the last (a gap is snapshots the host replaced
//   with a newer one), frozen, so no caller changes another's.
// - A callback's failure turns into the action's: a throwing `onProgress`
//   is only no longer called; the result is still the action's.
// - Stopping following cancels another follower's run: aborting lets go
//   of this caller's connection only; the host cancels the run once no
//   one follows it. Cancelling it for everyone is a command of its own.

/**
 * How long a reconnect (`attach`) may take to open before it counts as one
 * that failed: as long as the host keeps a run no one follows, so one that
 * opens later finds nothing to follow anyway. A connection that arrives
 * after it is let go of at once, its frames never delivered.
 */
const streamAttachOpenMs = streamIdleCancelMs;

/** How a streaming action's call goes, beyond its progress and result. */
export interface StreamEvents {
  /** It was admitted: `cancel` cancels it for everyone following it. */
  readonly onStarted: (cancel: () => Promise<void>) => void;
  /** Its connection was lost, and the client is attaching again. */
  readonly onRecovering: () => void;
  /** It is followed again after a lost connection. */
  readonly onAttached: () => void;
  /** A newer progress snapshot, frozen. */
  readonly onProgress: (progress: unknown) => void;
}

/** The client's streaming actions: each followed until it settles. */
export class Streams {
  readonly #transport: ClientTransport;
  readonly #fence: AccessFence;
  /** Marks every query old after a change the host may have made. */
  readonly #changed: () => void;

  constructor(
    transport: ClientTransport,
    fence: AccessFence,
    changed: () => void
  ) {
    this.#transport = transport;
    this.#fence = fence;
    this.#changed = changed;
  }

  /** See `GraspClient.stream`; `events` are a hook's (`ClientInternals.stream`). */
  async stream(
    reference: unknown,
    args: unknown,
    options: unknown,
    events?: StreamEvents
  ): Promise<unknown> {
    const read = readReference(reference, "action");
    const { signal, idempotencyKey, onProgress } = readOptions(
      options,
      streamOptionKeys
    );
    const input = inputOf(args);
    const key = idempotencyKey ?? freshKey();
    const request = JSON.stringify({
      reference: read,
      input,
      idempotencyKey: key,
    });
    if (
      new TextEncoder().encode(request).byteLength > functionRequestMaxBytes
    ) {
      throw clientError("contract.input_too_large", {
        maxBytes: functionRequestMaxBytes,
      });
    }
    const transport = this.#transport;
    if (
      transport === undefined ||
      transport.stream === undefined ||
      transport.cancelStream === undefined
    ) {
      throw clientError("stream.unavailable");
    }
    const open = transport.stream.bind(transport);
    const cancel = transport.cancelStream.bind(transport);
    if (signal?.aborted === true) {
      throw clientError("submission.cancelled", { sent: false });
    }
    let seen = 0;
    let listening = onProgress !== undefined;
    const progressed = (value: unknown): void => {
      events?.onProgress(value);
      if (!listening) {
        return;
      }
      try {
        onProgress?.(value);
      } catch {
        // Its failure is its own: it isn't called again, and the action
        // goes on.
        listening = false;
      }
    };
    /** A snapshot, if newer than the last: core checked it against the stream's schema. */
    const onProgressFrame = (frameSeq: number, value: unknown): void => {
      if (frameSeq <= seen) {
        return;
      }
      seen = frameSeq;
      progressed(deepFreeze(value));
    };
    /** Resolves once the invocation first answered (true), or never will. */
    const opened = Promise.withResolvers<boolean>();
    /** Follows the invocation over one connection, until it ends. */
    const follow = async (what: "stream" | "attach"): Promise<Followed> => {
      const ended = Promise.withResolvers<Followed>();
      // Whether this connection still speaks for the caller: once it left,
      // or the connection ended, a frame it delivers late is dropped, so it
      // never reaches `onProgress` after the run settled for the caller.
      let live = true;
      const onFrame = (raw: unknown): void => {
        if (!live) {
          return;
        }
        const frame = readFrame(raw);
        if (frame?.type === "closed") {
          ended.resolve({ kind: "lost" });
        } else if (frame?.type === "result") {
          ended.resolve({
            kind: "settled",
            settled: frame.settled,
            answered: true,
          });
        } else if (frame?.type === "progress") {
          onProgressFrame(frame.seq, frame.value);
        }
      };
      let link: StreamLink;
      // A reconnect that doesn't open in time is given up on: it counts as
      // a failed attempt, never a wait without end.
      const stalled = new AbortController();
      const stall =
        what === "attach"
          ? setTimeout(() => {
              stalled.abort();
            }, streamAttachOpenMs)
          : undefined;
      try {
        const opening = open(what, request, onFrame);
        const arrived = await openedUnlessAborted(
          opening,
          signal === undefined
            ? stalled.signal
            : AbortSignal.any([signal, stalled.signal])
        );
        if (arrived === undefined) {
          live = false;
          return isAborted(signal) ? { kind: "aborted" } : { kind: "lost" };
        }
        link = arrived;
        opened.resolve(true);
      } catch (error) {
        live = false;
        return {
          kind: "settled",
          settled: readRejection(error),
          answered: false,
        };
      } finally {
        clearTimeout(stall);
      }
      if (what === "attach") {
        events?.onAttached();
      }
      const onAbort = (): void => {
        ended.resolve({ kind: "aborted" });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
      }
      try {
        return await ended.promise;
      } finally {
        live = false;
        signal?.removeEventListener("abort", onAbort);
        try {
          await link.release();
        } catch {
          // Gone already.
        }
      }
    };
    // A cancel asked for before the invocation answered waits for it: sent
    // before, it could reach the host ahead of the start and find nothing
    // to cancel, while the run then went ahead. One that never opened has
    // nothing to cancel.
    events?.onStarted(async () => {
      if (await opened.promise) {
        await this.#cancelStream(request, cancel);
      }
    });
    try {
      return await this.#settleStream(follow, {
        key,
        events,
        signal,
      });
    } finally {
      opened.resolve(false);
    }
  }

  /**
   * Follows a streaming action's invocation until it settles (see the
   * header): its value, or its failure thrown. Starts it once, then, once
   * a start may have reached the host, only ever attaches; a reconnect
   * refused before it reached the invocation goes on recovering; after
   * `streamAttachAttempts` it rejects `stream.outcome_unknown` with the key.
   */
  async #settleStream(
    follow: (what: "stream" | "attach") => Promise<Followed>,
    {
      key,
      events,
      signal,
    }: {
      readonly key: string;
      readonly events: StreamEvents | undefined;
      readonly signal: AbortSignal | undefined;
    }
  ): Promise<unknown> {
    let refused = 0;
    // Once a start may have reached the host, only ever attach.
    let what: "stream" | "attach" = "stream";
    let recoveringSince: number | undefined;
    for (let tries = 1; ; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one connection after another
      const followed = await follow(what);
      if (followed.kind === "aborted") {
        // Its start may have reached the host, and what it ran saved
        // something: the App's queries are read again, as on every other
        // exit that leaves its outcome unknown.
        this.#changed();
        throw clientError("stream.cancelled", { idempotencyKey: key });
      }
      const settled: Settled =
        followed.kind === "settled" ? followed.settled : { kind: "lost" };
      if (settled.kind === "value") {
        this.#changed();
        return settled.value;
      }
      // A refusal of a reconnect before it reached the invocation (the
      // request budget) says nothing of the run: recovery goes on.
      const attachRefused =
        what === "attach" &&
        settled.kind === "failed" &&
        followed.kind === "settled" &&
        !followed.answered &&
        refusedBeforeCallCodes.has(settled.error.code);
      if (settled.kind === "failed" && !attachRefused) {
        const { error } = settled;
        if (fences(error.code)) {
          this.#fence.fence(error);
        }
        refused += 1;
        if (!startAgain(followed, what, refused)) {
          this.#changed();
          // An outcome the host can't tell carries the key, so a caller that
          // let the client pick it can still recover the receipt by it.
          throw error.category === "uncertain" ? withKey(error, key) : error;
        }
      } else {
        what = "attach";
        recoveringSince ??= Date.now();
        if (recoveryOver(tries, recoveringSince)) {
          // What it ran may have committed: the App's queries are read again.
          this.#changed();
          throw clientError("stream.outcome_unknown", { idempotencyKey: key });
        }
        events?.onRecovering();
      }
      // A refused start waits as long as the refusal said; an attach comes
      // back before the host cancels a run no one follows.
      const wait =
        what === "stream" || attachRefused
          ? waitAfter(settled, tries)
          : Math.min(retryDelay(tries, retryCapMs), streamIdleCancelMs / 2);
      // oxlint-disable-next-line no-await-in-loop -- one connection after another
      await sleep(wait, signal);
      if (isAborted(signal)) {
        // As above: it may have run, and saved something.
        this.#changed();
        throw clientError("stream.cancelled", { idempotencyKey: key });
      }
    }
  }

  /**
   * Asks the host to cancel the invocation `request` names: resolves once
   * it acknowledged the request (`{ requested }`), whether or not the run
   * was still going; rejects a refusal with its error, and an answer that
   * isn't an acknowledgement, a lost one included, with
   * `function.unreachable`, so a caller never takes an unconfirmed cancel
   * for one.
   */
  async #cancelStream(
    request: string,
    send: (text: string) => Promise<unknown>
  ): Promise<void> {
    let answer: unknown;
    try {
      answer = await send(request);
    } catch (error) {
      const settled = readRejection(error);
      if (settled.kind === "failed") {
        if (fences(settled.error.code)) {
          this.#fence.fence(settled.error);
        }
        throw settled.error;
      }
      throw clientError("function.unreachable");
    }
    if (!isPlainObject(answer) || typeof answer.requested !== "boolean") {
      throw clientError("function.unreachable");
    }
  }
}

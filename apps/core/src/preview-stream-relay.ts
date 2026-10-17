import { errorFields, log } from "@grasp-os/shared/log";
import {
  jsonBytes,
  screenErrors,
  screenLimits,
} from "@grasp-os/shared/screens";

import { refusalOf } from "./app-functions.ts";

// The relay of a streaming action's invocation in a draft's preview
// (sealed-previews.ts) to the page that follows it, over the page's own
// connection (chats-rpc.ts), as a live screen's relay does over its
// request (app-function-route.ts). Threat model, and how each is closed:
//
// - Progress reaches someone who no longer gets the preview: the relay
//   checks (`stillOpen`) that the connection's session is still the
//   person's, that they still build the App and that the draft is still
//   at the stream's revision: every `streamRecheckMs` on a timer, frames
//   or not; before a progress frame when the last check is older than
//   that; and always before the result, as a live screen's relay does. A
//   refusal cancels the invocation at once, then ends the relay with a
//   `refused` frame carrying it, never waiting on the page to cancel.
// - The page is flooded, or holds core: frames go one at a time, the next
//   read only once the page took the last, and the invocation's reader
//   sends the newest progress it hasn't seen when asked (whole
//   snapshots), so nothing queues.
// - A result larger than a screen takes in one answer: refused here
//   (`screen.answer_too_large`), as a screen's call is.
// - The relay outlives who follows it: releasing it (or the page's
//   connection going) stops reading, which lets go of the invocation's
//   reader; one nobody follows is cancelled by the preview after its idle
//   time.

/** How often the relay checks again on a timer, frames or not. */
export const streamRecheckMs = 5000;

/** What the relay of one preview stream needs besides its frames. */
export interface PreviewRelay {
  /** Hands one frame to the page: the next waits for it. */
  readonly deliver: (frame: unknown) => Promise<unknown>;
  /** Throws the refusal once the person may no longer have the stream. */
  readonly stillOpen: () => Promise<void>;
  /** Cancels the invocation: they lost it. */
  readonly cancel: () => Promise<unknown>;
  readonly requestId: string;
}

/** A frame's line, parsed, or undefined for one that isn't JSON. */
const frameOf = (line: string): unknown => {
  try {
    const frame: unknown = JSON.parse(line);
    return frame;
  } catch {
    return undefined;
  }
};

/** Lets go of `reader`: what it reads from stops. Never throws. */
const letGo = async (
  reader: ReadableStreamDefaultReader<string>
): Promise<void> => {
  try {
    await reader.cancel();
  } catch {
    // Closed already.
  }
};

/** Hands `frame` to the page, not waiting on it. Never throws. */
const handedOver = async (
  deliver: (frame: unknown) => Promise<unknown>,
  frame: unknown
): Promise<void> => {
  try {
    await deliver(frame);
  } catch {
    // The page is gone.
  }
};

/** Whether `frame` is the invocation's result. */
const isResult = (
  frame: unknown
): frame is { type: "result"; result: unknown } =>
  typeof frame === "object" &&
  frame !== null &&
  "type" in frame &&
  frame.type === "result";

/**
 * Relays `frames` (JSON lines of an invocation's frames) to the page, as
 * the header says, until the result, a refusal, the end of the frames
 * (then `{ type: "closed" }`) or `stop`. Never throws.
 */
export const relayPreviewStream = (
  frames: ReadableStream<Uint8Array>,
  { deliver, stillOpen, cancel, requestId }: PreviewRelay
): { stop: () => void } => {
  const reader = frames.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** When `stillOpen` last held. */
  let checkedAt = Date.now();
  const checked = async (): Promise<void> => {
    await stillOpen();
    checkedAt = Date.now();
  };
  const stop = (): void => {
    if (done) {
      return;
    }
    done = true;
    clearTimeout(timer);
    void letGo(reader);
  };
  const refuse = async (error: unknown): Promise<void> => {
    if (done) {
      return;
    }
    stop();
    // Cancelled first: a page that never takes the refusal holds up
    // nothing.
    try {
      await cancel();
    } catch (cancelError) {
      log.warn("preview.stream_cancel_failed", {
        requestId,
        ...errorFields(cancelError),
      });
    }
    void handedOver(deliver, {
      type: "refused",
      error: refusalOf(error, requestId),
    });
  };
  // Runs on a timer nobody awaits: it never throws.
  const check = async (): Promise<void> => {
    try {
      await checked();
    } catch (error) {
      await refuse(error);
      return;
    }
    if (!done) {
      timer = setTimeout(() => {
        void check();
      }, streamRecheckMs);
    }
  };
  timer = setTimeout(() => {
    void check();
  }, streamRecheckMs);
  const nextLine = async (): Promise<string | undefined> => {
    for (;;) {
      const end = buffered.indexOf("\n");
      if (end !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        return line;
      }
      // oxlint-disable-next-line no-await-in-loop -- one chunk after another
      const { done: ended, value } = await reader.read();
      if (ended) {
        return undefined;
      }
      buffered += value;
    }
  };
  const pump = async (): Promise<void> => {
    for (;;) {
      if (done) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- one frame after another
      const line = await nextLine();
      if (done) {
        return;
      }
      if (line === undefined) {
        stop();
        // oxlint-disable-next-line no-await-in-loop -- the last
        await deliver({ type: "closed" });
        return;
      }
      const frame = frameOf(line);
      try {
        // Checked before the result, and before progress once the last
        // check is older than `streamRecheckMs`.
        if (isResult(frame) || Date.now() - checkedAt >= streamRecheckMs) {
          // oxlint-disable-next-line no-await-in-loop -- one frame after another
          await checked();
        }
      } catch (error) {
        // oxlint-disable-next-line no-await-in-loop -- the last
        await refuse(error);
        return;
      }
      if (!isResult(frame)) {
        // oxlint-disable-next-line no-await-in-loop -- the next only once the page took this one
        await deliver(frame);
        continue;
      }
      stop();
      const fits =
        jsonBytes(frame.result, screenLimits.answerBytes) <=
        screenLimits.answerBytes;
      // oxlint-disable-next-line no-await-in-loop -- the last
      await deliver(
        fits
          ? frame
          : {
              type: "result",
              seq: 1,
              result: {
                ok: false,
                error: refusalOf(
                  screenErrors.create("screen.answer_too_large"),
                  requestId
                ),
              },
            }
      );
      return;
    }
  };
  const pumped = async (): Promise<void> => {
    try {
      await pump();
    } catch {
      // The page is gone, or the frames broke off: nothing more to hand on.
      stop();
    }
  };
  void pumped();
  return { stop };
};

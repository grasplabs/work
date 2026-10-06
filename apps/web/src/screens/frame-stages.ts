import {
  screenLimits,
  screenMountedSchema,
  screenReadySchema,
} from "@grasp-os/shared/screens";
import type { ScreenMounted } from "@grasp-os/shared/screens";

// The two stages a screen's frame starts in, as the page waits for them
// (@grasp-os/shared/screens): `ready` from the frame's own document, then
// `mounted` from the runtime once the screen has rendered. Each must come
// from this frame's window, whose origin is opaque, in the exact shape,
// with the values the page made up for this start; anything else is not
// an answer and is passed over, so the stage runs out of time instead.
//
// What ways there are to get this wrong, each of which must fail:
//
// - a message from another frame or window, or from the page itself;
// - one from a document the frame went to, with an origin of its own;
// - one in another shape, or with more in it than the stage has;
// - one for an earlier load of this frame, or another start of it;
// - one that names other code than the page handed over;
// - none at all: the frame never loads, or the screen never renders.

/**
 * Which stage of a screen's start: `opened` (core handed over the build,
 * `screenLimits.openMs`), then the frame's two (`screenLimits.stageMs`
 * each).
 */
export type Stage = "opened" | "ready" | "mounted";

/** A stage that didn't happen in its time. */
export class StageTimeoutError extends Error {
  readonly stage: Stage;

  constructor(stage: Stage) {
    super(`The screen's frame wasn't ${stage} in time.`);
    this.name = "StageTimeoutError";
    this.stage = stage;
  }
}

/** What the page reads of a message: what it says, and where it is from. */
export interface FrameMessage {
  data: unknown;
  origin: string;
  source: unknown;
}

/** The frame's window as it is now: a frame taken off the page has none. */
export type FrameWindow = () => unknown;

/** The origin of a sandboxed frame without `allow-same-origin`. */
const opaqueOrigin = "null";

/** Whether `message` came from the frame's own window, still sandboxed. */
const isFromFrame = (message: FrameMessage, frame: FrameWindow): boolean => {
  const source = frame();
  return (
    source !== null &&
    source !== undefined &&
    message.source === source &&
    message.origin === opaqueOrigin
  );
};

/** Whether `message` is the frame saying this `load` of it listens. */
export const isReady = (
  message: FrameMessage,
  frame: FrameWindow,
  load: string
): boolean => {
  if (!isFromFrame(message, frame)) {
    return false;
  }
  const ready = screenReadySchema.safeParse(message.data);
  return ready.success && ready.data.load === load;
};

/** Which start of the frame the page expects `mounted` for. */
export type ExpectedStart = Omit<ScreenMounted, "type">;

/**
 * Whether `message` is the runtime saying the screen has mounted, for
 * exactly the start the page `expected`: this load, this code, this
 * start of the frame.
 */
export const isMounted = (
  message: FrameMessage,
  frame: FrameWindow,
  expected: ExpectedStart
): boolean => {
  if (!isFromFrame(message, frame)) {
    return false;
  }
  const mounted = screenMountedSchema.safeParse(message.data);
  return (
    mounted.success &&
    mounted.data.load === expected.load &&
    mounted.data.artifact === expected.artifact &&
    mounted.data.generation === expected.generation
  );
};

const isFrameMessage = (event: Event): event is Event & FrameMessage =>
  "data" in event &&
  "origin" in event &&
  typeof event.origin === "string" &&
  "source" in event;

/**
 * Waits for the message `accepts` takes, among those `messages` hears,
 * for at most `screenLimits.stageMs`: then `StageTimeoutError`. However
 * it ends (the message, the time, or `signal` stopping it), it no longer
 * listens and its timer is gone.
 */
/**
 * What `work` answers, or `StageTimeoutError` for `name` once `ms` have
 * passed: so a start never waits on core longer than that, whether a
 * build stalls or the connection does.
 */
export const inTime = async <T>(
  name: Stage,
  work: Promise<T>,
  ms: number
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      // oxlint-disable-next-line promise/avoid-new -- a timer has no promise form here
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new StageTimeoutError(name));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export const stage = async (
  name: Stage,
  accepts: (message: FrameMessage) => boolean,
  messages: Pick<EventTarget, "addEventListener">,
  signal: AbortSignal
): Promise<void> => {
  // Aborted when the stage ends, which takes every listener below along.
  const ended = new AbortController();
  try {
    // oxlint-disable-next-line promise/avoid-new -- a message event has no promise form
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new StageTimeoutError(name));
      }, screenLimits.stageMs);
      ended.signal.addEventListener("abort", () => {
        clearTimeout(timer);
      });
      messages.addEventListener(
        "message",
        (event) => {
          if (isFrameMessage(event) && accepts(event)) {
            resolve();
          }
        },
        { signal: ended.signal }
      );
      const stop = (): void => {
        reject(new Error("The screen was stopped."));
      };
      signal.addEventListener("abort", stop, { signal: ended.signal });
      if (signal.aborted) {
        stop();
      }
    });
  } finally {
    ended.abort();
  }
};

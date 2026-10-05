// The limits and the frame's start, as the page, core and the frame's own
// runtime all name them. Apart from the rest of what screens share
// (screens.ts), with nothing imported: the runtime is loaded into every
// frame, and carries only what it uses.

/** Where the frontend frames screens from: a document core serves. */
export const screenFramePath = "/screen-frame";

/**
 * The limits of a screen's start and traffic, in one place. They are the
 * product's defaults: nothing an App declares or a frame sends raises
 * them. Each is in the unit it names; a count of characters is never
 * applied as a count of bytes.
 */
export const screenLimits = {
  /** How long each stage of a screen's start may take: ready, then mounted. */
  stageMs: 10_000,
  /**
   * Cap'n Web's limits on what a frame sends over its port. A message's
   * size is its text's, in UTF-16 code units. A browser's connection to
   * core takes the depth and the digits too (core's rpc.ts).
   */
  rpc: { maxDepth: 32, maxMessageSize: 262_144, maxBigIntDigits: 32 },
  /** A server call's arguments, as UTF-8 JSON, in bytes. */
  inputBytes: 128 * 1024,
  /** A server call's answer, as UTF-8 JSON, in bytes: more is paged. */
  answerBytes: 256 * 1024,
  /** A person's requests of one App's screens (subscriptions apart). */
  requests: { burst: 20, perMinute: 120 },
  /** The problems kept of what one person's screens of an App report. */
  callerReports: { burst: 20, perMinute: 20 },
  /** The problems kept of what all of an App's screens report. */
  appReports: { burst: 200, perMinute: 200 },
  /** How many different problems an App's error log keeps. */
  keptReports: 100,
  /** The most one problem report may carry, in characters. */
  report: { message: 2000, stack: 8000 },
} as const;

// A screen starts in two stages, each bound to this load of the frame and
// each within `screenLimits.stageMs`:
//
// 1. The frame's own document (core's screen-frame.ts) says it listens
//    (`screenFrameReady`), with the `load` its address carried.
// 2. The page hands it the screen (`screenFrameMessage`); once that has
//    loaded and rendered for the first time, the runtime says so
//    (`screenFrameMounted`), with the same `load`, the hash of the code it
//    was handed and the page's name for this start of the frame.
//
// The page reads either only from its own frame's window, whose origin is
// opaque, and only with the values it made up for this start. That tells
// a screen that started from one that didn't, or from another frame's or
// an earlier load's; it says nothing about the screen's code, which could
// send `mounted` itself. Nothing is trusted because a frame said so.

/**
 * What the frame posts to the page once it listens for its screen:
 * `{ type, load }`, with the `load` its address carried, so the page can
 * tell this load of the frame from an earlier one.
 */
export const screenFrameReady = "grasp:screen-ready";

/**
 * What the page posts the frame, with a `MessagePort`, to start the
 * screen: `{ type, load, artifact, generation, imports, css, runtime,
 * entry }`.
 */
export const screenFrameMessage = "grasp:screen";

/**
 * What the runtime posts to the page once the screen has rendered for the
 * first time: `{ type, load, artifact, generation }`, as it was handed
 * them.
 */
export const screenFrameMounted = "grasp:screen-mounted";

/**
 * How many bytes `value` takes as UTF-8 JSON, measured on the text itself.
 * Bytes count as the base64 they travel as, a big integer as its digits;
 * a value with no JSON form (one that holds itself) is past any limit.
 */
export const jsonBytes = (value: unknown): number => {
  try {
    const text = JSON.stringify(value, (_key, held: unknown) => {
      if (typeof held === "bigint") {
        return held.toString();
      }
      if (held instanceof Uint8Array) {
        return "=".repeat(Math.ceil(held.byteLength / 3) * 4);
      }
      return held;
    });
    return new TextEncoder().encode(text).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

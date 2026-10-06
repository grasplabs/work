// The limits and the frame's start, as the page, core and the frame's own
// runtime all name them. Apart from the rest of what screens share
// (screens.ts), with nothing imported: the runtime is loaded into every
// frame, and carries only what it uses.

/** Where the frontend frames screens from: a document core serves. */
export const screenFramePath = "/screen-frame";

/** Where core serves a screen's modules to its frame, each by its hash. */
export const screenModulePath = "/screen-modules";

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
   * How long the page waits for core to hand over a screen's build before
   * the frame starts: past core's own wait for a build (15 s), so core
   * says why first when it can.
   */
  openMs: 20_000,
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
  /**
   * What a port holds of messages nobody has read yet, in number and in
   * characters together (four of the longest): they are read as they
   * come, so more than this is a side sending faster than it is heard.
   */
  portQueue: { messages: 256, characters: 4 * 262_144 },
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
 * screen: `{ type, load, artifact, generation }`. The frame's document
 * holds the screen's code already (core's screen-frame.ts), for the build
 * its address named; it starts only if `artifact` is that build.
 */
export const screenFrameMessage = "grasp:screen";

/**
 * What the runtime posts to the page once the screen has rendered for the
 * first time: `{ type, load, artifact, generation }`, as it was handed
 * them.
 */
export const screenFrameMounted = "grasp:screen-mounted";

/** Past any limit: what a value that can't be measured counts as. */
const unmeasured = Number.POSITIVE_INFINITY;

/** Measures a value held inside the one being measured. */
type Measure = (held: unknown) => number;

/** The bytes of `text` as a JSON string, in UTF-8. */
const textBytes = (text: string): number =>
  new TextEncoder().encode(JSON.stringify(text)).byteLength;

/** The bytes of `members`, each already measured, with the commas between. */
const listBytes = (members: number[]): number =>
  members.reduce((sum, member) => sum + member, 2) +
  Math.max(0, members.length - 1);

/** The bytes of an object's members: each key, a colon, and its value. */
const membersBytes = (members: [string, unknown][], measure: Measure): number =>
  listBytes(
    members
      // As JSON, a member with no value isn't written.
      .filter(([, held]) => held !== undefined)
      .map(([key, held]) => textBytes(key) + 1 + measure(held))
  );

/** Whether `value` is an object written with braces, and nothing more. */
const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * The bytes of an array, an error or a plain object, by what it holds;
 * of anything else, past any limit.
 */
const holderBytes = (value: object, measure: Measure): number => {
  if (Array.isArray(value)) {
    return listBytes(value.map((held: unknown) => measure(held)));
  }
  if (value instanceof Error) {
    // An error travels with its name, message and stack, which JSON
    // itself would leave out, and with whatever else was put on it.
    return membersBytes(
      [
        ["name", value.name],
        ["message", value.message],
        ["stack", value.stack],
        ...Object.entries(value),
      ],
      measure
    );
  }
  return isPlainObject(value)
    ? membersBytes(Object.entries(value), measure)
    : unmeasured;
};

/** The bytes of an object; `holders` are the ones it is inside of. */
const objectBytes = (
  value: object,
  holders: Set<object>,
  measure: Measure
): number => {
  if (value instanceof Date) {
    return textBytes(new Date(0).toISOString());
  }
  if (value instanceof Uint8Array) {
    // As the base64 it travels as.
    return Math.ceil(value.byteLength / 3) * 4 + 2;
  }
  // A value that holds itself has no end.
  if (holders.has(value)) {
    return unmeasured;
  }
  holders.add(value);
  const bytes = holderBytes(value, measure);
  holders.delete(value);
  return bytes;
};

const measured = (value: unknown, holders: Set<object>): number => {
  if (typeof value === "string") {
    return textBytes(value);
  }
  if (typeof value === "bigint") {
    // As its digits, in a string.
    return value.toString().length + 2;
  }
  if (typeof value === "boolean") {
    return String(value).length;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value).length : "null".length;
  }
  if (value === null || value === undefined) {
    return "null".length;
  }
  // A function or a symbol has no measure.
  return typeof value === "object"
    ? objectBytes(value, holders, (held) => measured(held, holders))
    : unmeasured;
};

/**
 * How many bytes `value` takes as UTF-8 JSON: the limit a call's
 * arguments and answer are held to, so it must never come out smaller
 * than what travels. It reads the value itself, calling nothing on it.
 * Bytes count as their base64, a big integer as its digits, an error as
 * its name, message and stack. Anything it has no measure for is past any
 * limit: a map, a set, a buffer, an instance of a class, a function, or a
 * value that holds itself.
 */
export const jsonBytes = (value: unknown): number =>
  measured(value, new Set<object>());

import { platformLimits } from "./platform-limits.ts";
import { valueDepth } from "./value-depth.ts";

// The limits and the frame's start, as the page, core and the frame's own
// runtime all name them. Apart from the rest of what screens share
// (screens.ts), importing only constants (the depth a value may nest, the
// platform's limits): the runtime is loaded into every frame, and carries
// only what it uses.

/** Where the frontend frames screens from: a document core serves. */
export const screenFramePath = "/screen-frame";

/**
 * Where a running App's screen calls one of its App's functions (core's
 * app-function-route.ts): `POST <path>/<app ID>`, the request as the body.
 */
export const appFunctionPath = "/api/app-functions";

/** The header that carries the frame's lease on a function call. */
export const screenLeaseHeader = "x-grasp-screen-lease";

/** Where core serves a screen's modules to its frame, each by its hash. */
export const screenModulePath = "/screen-modules";

/**
 * The levels Cap'n Web counts around a value in the deepest shape an
 * untrusted side sends one: a screen's call, `call(method, [value])`,
 * through the page's bridge or over a browser's connection to core.
 * Measured with capnweb 0.12.0, which refuses a message once a level's
 * depth reaches `maxDepth`, counting from 0 at the message's expression:
 *
 * - the call's list of arguments is one level;
 * - a screen's list of arguments for its App is another, so a value
 *   `valueDepth` levels deep ends at depth `valueDepth + 1`.
 *
 * A value passed straight as an argument (a run's input, a decision's
 * answer) has one level around it, and an answer, the message's own
 * expression, none: this shape is the deepest. Arrays and objects count
 * alike. So a value passed straight as an argument may be 33 levels deep
 * on the wire, on purpose: one more than values may nest, refused where
 * it is checked (no schema nests deeper than `valueDepth`), as bounding
 * each shape apart would take a limit of each call's own.
 */
const rpcWrapperLevels = 2;

/**
 * How deep a call's argument may be once it arrives, the value it refers
 * to in place (@grasp-os/shared/rpc-target): as deep as one message lets
 * a direct argument be, the call's list of arguments apart, so a call
 * sent whole in one message is never refused for its depth. A screen's
 * list of arguments for its App is one of these levels, so a value in it
 * may be `valueDepth` deep.
 */
export const rpcArgumentDepth = valueDepth + rpcWrapperLevels - 1;

/**
 * Room in one of Cap'n Web's messages for what wraps a value: the message
 * kind, its IDs and the call's path, a few hundred code units at most.
 */
const rpcEnvelopeSize = 4 * 1024;

/**
 * The longest message a frame may send over its port, in UTF-16 code
 * units: a public operation's output (the larger of its input and output)
 * and the envelope around it. The largest input fits even as Cap'n Web
 * writes it, each array bracketed twice, which at most doubles its text.
 */
const rpcMessageMaxSize = platformLimits.operationOutputBytes + rpcEnvelopeSize;

/**
 * The limits of a screen's start and traffic, in one place. They are the
 * product's defaults: nothing an App declares or a frame sends raises
 * them. Each is in the unit it names; a count of characters is never
 * applied as a count of bytes.
 */
export const screenLimits = {
  /** How long each stage of a screen's start may take: ready, then mounted. */
  stageMs: platformLimits.screenStageMs,
  /**
   * How long the page waits for core to hand over a screen's build before
   * the frame starts: past core's own wait for a build (15 s), so core
   * says why first when it can.
   */
  openMs: 20_000,
  /**
   * The limits on what a frame sends over its port. A message's size is
   * its text's, in UTF-16 code units, held by the accountant on the port
   * (the page's screen-bridge.ts); its depth and digits by Cap'n Web. A
   * browser's connection to core takes the depth and the digits too (core's
   * rpc.ts).
   *
   * The depth bounds how far Cap'n Web recurses into each message from
   * an untrusted side, so it is no deeper than a value may nest plus the
   * levels a screen's call wraps it in: a value as deep as values may be
   * arrives, one level deeper ends the session. Each level more lets
   * every message recurse once more; what a message holds in all stays
   * bounded by its size.
   *
   * It bounds one message, not the value a call ends up with: a message
   * can refer to what earlier ones sent (Cap'n Web's pipelining), so a
   * value built over several messages can be deeper and bigger. Each
   * target a side calls holds what its methods get to the same depth and
   * size (`rpcArgumentDepth`, @grasp-os/shared/rpc-target).
   */
  rpc: {
    maxDepth: valueDepth + rpcWrapperLevels,
    maxMessageSize: rpcMessageMaxSize,
    maxBigIntDigits: 32,
  },
  /** A server call's arguments, as UTF-8 JSON, in bytes. */
  inputBytes: platformLimits.operationInputBytes,
  /** A server call's answer, as UTF-8 JSON, in bytes: more is paged. */
  answerBytes: platformLimits.operationOutputBytes,
  /** A person's requests of one App's screens (subscriptions apart). */
  requests: {
    burst: platformLimits.browserRequestBurst,
    perMinute: platformLimits.browserRequestsPerMinute,
  },
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
  portQueue: { messages: 256, characters: 4 * rpcMessageMaxSize },
  /**
   * What a frame's unreleased pushes and unanswered calls may hold at once,
   * in bytes of heap as the page's accountant estimates them
   * (@grasp-os/shared/rpc-accounting): room for a call with the largest
   * input a screen may send (`inputBytes`, at most about 4 MB once parsed
   * into tiny values) and as much again, and no more.
   */
  rpcHeldBytes: 8 * 1024 * 1024,
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

/** The bytes of `text` as a JSON string, in UTF-8. */
const textBytes = (text: string): number =>
  new TextEncoder().encode(JSON.stringify(text)).byteLength;

/** Whether `value` is an object written with braces, and nothing more. */
const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Whether `value` may hold others: an object, but a date or bytes. */
const isHolder = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  !(value instanceof Date) &&
  !(value instanceof Uint8Array);

/** The bytes of a value that holds no other. */
const leafBytes = (value: unknown): number => {
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
  if (value instanceof Date) {
    return textBytes(new Date(0).toISOString());
  }
  if (value instanceof Uint8Array) {
    // As the base64 it travels as.
    return Math.ceil(value.byteLength / 3) * 4 + 2;
  }
  // A function or a symbol has no measure.
  return unmeasured;
};

/**
 * An error's or a plain object's keys and values, as they travel; for
 * anything else, `undefined`.
 */
const entriesOf = (value: object): [string, unknown][] | undefined => {
  if (value instanceof Error) {
    // An error travels with its name, message and stack, which JSON
    // itself would leave out, and with whatever else was put on it.
    return [
      ["name", value.name],
      ["message", value.message],
      ["stack", value.stack],
      ...Object.entries(value),
    ];
  }
  return isPlainObject(value) ? Object.entries(value) : undefined;
};

/**
 * What an array, an error or a plain object holds, as its members are
 * written: an array's elements, or an object's keys and values; for
 * anything else, `undefined`.
 */
const membersOf = (
  value: object
): { keys: string[] | undefined; held: unknown[] } | undefined => {
  if (Array.isArray(value)) {
    return { keys: undefined, held: value };
  }
  const entries = entriesOf(value);
  if (entries === undefined) {
    return undefined;
  }
  // As JSON, a member with no value isn't written.
  const written = entries.filter(([, held]) => held !== undefined);
  return {
    keys: written.map(([key]) => key),
    held: written.map(([, held]) => held),
  };
};

/**
 * The bytes a holder adds around its members: brackets, commas, and an
 * object's keys with their colons.
 */
const holderBytes = (members: {
  keys: string[] | undefined;
  held: unknown[];
}): number => {
  const commas = Math.max(0, members.held.length - 1);
  const keys =
    members.keys?.reduce((sum, key) => sum + textBytes(key) + 1, 0) ?? 0;
  return 2 + commas + keys;
};

/** A step of the walk: measure a value, or leave a holder. */
type Step = { value: unknown } | { left: object };

/**
 * How many bytes `value` takes as UTF-8 JSON, or past any limit once that
 * is more than `limit`: the limit a call's arguments and answer are held
 * to, so it must never come out smaller than what travels. It reads the
 * value itself, calling nothing on it but the getters of a plain object.
 * Bytes count as their base64, a big integer as its digits, an error as
 * its name, message and stack. Anything it has no measure for is past any
 * limit: a map, a set, a buffer, an instance of a class, a function, or a
 * value that holds itself.
 *
 * It walks with a stack of its own, so a value nested however deep can't
 * exhaust the call stack, and stops once past `limit`, so a value held
 * many times over (as each is written out) costs no more than the limit.
 */
export const jsonBytes = (value: unknown, limit: number): number => {
  const steps: Step[] = [{ value }];
  // The holders the walk is inside of: one it meets again has no end.
  const holders = new Set<object>();
  let bytes = 0;
  while (steps.length > 0) {
    const step = steps.pop();
    if (step === undefined) {
      break;
    }
    if ("left" in step) {
      holders.delete(step.left);
      continue;
    }
    const { value: next } = step;
    if (isHolder(next)) {
      const members = membersOf(next);
      if (members === undefined || holders.has(next)) {
        return unmeasured;
      }
      bytes += holderBytes(members);
      // Before its members are queued: it counts a byte at least for each.
      if (bytes > limit) {
        return unmeasured;
      }
      holders.add(next);
      steps.push({ left: next });
      // One at a time, not spread: a long array would pass too many
      // arguments at once.
      for (const inner of members.held) {
        steps.push({ value: inner });
      }
    } else {
      bytes += leafBytes(next);
    }
    if (bytes > limit) {
      return unmeasured;
    }
  }
  return bytes;
};

import { setTimeout as wait } from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import { requestErrors } from "../src/errors.ts";
import { readAtMost } from "../src/http.ts";

// Reading a request's body (`readAtMost`), shared by core's function
// route, its file channel and inbound email. The ways it can fail: a body
// larger than it may be is read whole; a client that stops sending, or
// sends a byte at a time within the size, holds the request until the
// platform's own timeout; a deadline that passes reads as an empty body,
// or leaves the stream open.

/** How long the tests give a body: short, so they don't wait. */
const deadlineMs = 50;

/** A stream of `chunks`, then closed, and whether it was cancelled. */
const streamOf = (chunks: number[][]) => {
  const seen = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const chunk of chunks) {
        controller.enqueue(Uint8Array.from(chunk));
      }
      controller.close();
    },
    cancel: () => {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
};

/** A stream that sends one byte, then nothing more, ever. */
const stalled = () => {
  const seen = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(Uint8Array.from([1]));
    },
    cancel: () => {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
};

/** A stream that sends a byte every few milliseconds, forever. */
const dripping = () => {
  const seen = { cancelled: false, sent: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      await wait(5);
      seen.sent += 1;
      controller.enqueue(Uint8Array.from([seen.sent % 256]));
    },
    cancel: () => {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
};

/** What `read` settled with: the bytes, or the refusal's code. */
const outcomeOf = async (
  read: Promise<Uint8Array | undefined>
): Promise<number[] | string> => {
  try {
    const bytes = await read;
    return bytes === undefined ? "too_large" : [...bytes];
  } catch (error) {
    return requestErrors.codeOf(error) ?? String(error);
  }
};

describe("reading a body", () => {
  it("reads a body that arrives in time and within its size, and refuses one larger", async () => {
    const whole = streamOf([[1, 2], [3]]);
    const larger = streamOf([
      [1, 2],
      [3, 4],
    ]);
    expect({
      whole: await outcomeOf(readAtMost(whole.stream, 3, deadlineMs)),
      larger: await outcomeOf(readAtMost(larger.stream, 3, deadlineMs)),
    }).toStrictEqual({
      whole: [1, 2, 3],
      larger: "too_large",
    });
  });

  it("refuses a body that stops arriving once its deadline passes, and cancels it", async () => {
    const { stream, seen } = stalled();
    expect({
      outcome: await outcomeOf(readAtMost(stream, 1024, deadlineMs)),
      cancelled: seen.cancelled,
    }).toStrictEqual({ outcome: "request.timeout", cancelled: true });
  });

  it("refuses a body sent a byte at a time once its deadline passes, however small", async () => {
    const { stream, seen } = dripping();
    const outcome = await outcomeOf(
      readAtMost(stream, 1024 * 1024, deadlineMs)
    );
    expect({
      outcome,
      cancelled: seen.cancelled,
      // Bytes kept coming, never enough to reach the size.
      kept: seen.sent > 0 && seen.sent < 1024 * 1024,
    }).toStrictEqual({
      outcome: "request.timeout",
      cancelled: true,
      kept: true,
    });
  });
});

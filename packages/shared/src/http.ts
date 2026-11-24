import { requestErrors } from "./errors.ts";

// Response headers every Grasp-made HTTP response carries, whether core or
// the router in front of it makes it.

/** Carries the request ID back to the caller, on every response. */
export const requestIdHeader = "x-request-id";

/** Browsers keep to https for this long after a visit: one year. */
const hstsMaxAgeSeconds = 365 * 24 * 60 * 60;

/** `strict-transport-security`, sent on https only: browsers ignore it over http. */
export const strictTransportSecurity = `max-age=${hstsMaxAgeSeconds}; includeSubDomains`;

/**
 * How long a body may take to arrive, all of it, unless the caller says
 * otherwise: a client that sends it slowly, or stops, holds the request
 * no longer than this.
 */
export const readDeadlineMs = 30_000;

/** Cancels `reader`'s stream: should that fail, nobody waits to hear it. */
const cancelQuietly = async (
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> => {
  try {
    await reader.cancel();
  } catch {
    // The body is given up on either way.
  }
};

/**
 * `stream`'s bytes, read up to `max` of them: undefined for a stream
 * longer than that, counted on what it holds, whatever it says its size is.
 * Refuses with `request.timeout`, the stream cancelled, once it has taken
 * longer than `deadlineMs` in all: a body sent a byte at a time, within
 * `max`, is held no longer than one that stalls.
 */
export const readAtMost = async (
  stream: ReadableStream<Uint8Array>,
  max: number,
  deadlineMs = readDeadlineMs
): Promise<Uint8Array<ArrayBuffer> | undefined> => {
  const reader = stream.getReader();
  const { promise: expired, resolve: expire } =
    Promise.withResolvers<"expired">();
  const timer = setTimeout(() => {
    expire("expired");
  }, deadlineMs);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream reads in order
      const next = await Promise.race([reader.read(), expired]);
      if (next === "expired") {
        // Cancelled without waiting for it: a source whose cancellation
        // never settles, or fails, neither holds nor replaces the refusal.
        // The read still pending settles as done once cancelled.
        void cancelQuietly(reader);
        throw requestErrors.create("request.timeout");
      }
      const { done, value } = next;
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > max) {
        // oxlint-disable-next-line no-await-in-loop -- once, then out
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

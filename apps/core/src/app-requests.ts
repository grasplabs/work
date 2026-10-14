import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import { operationErrors } from "@grasp-os/shared/operations";

// The request a chat's code sends with an App call (env.apps.call), read
// as AppsApi.call reads it (agent-apps.ts): a stream, read no further than
// a request may be.

/** How long a chat's code may take to send a call's request in full. */
export const requestReadMs = 5000;

/** Reads `reader` to its end, or refuses once a refusal is due. */
const readBounded = async (
  reader: ReadableStreamDefaultReader<unknown>
): Promise<string> => {
  const decoder = new TextDecoder();
  let text = "";
  let length = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream reads in order
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    // Bytes only: a chunk of anything else has no length to count.
    if (!(value instanceof Uint8Array)) {
      throw operationErrors.create("contract.invalid_request");
    }
    length += value.byteLength;
    if (length > functionRequestMaxBytes) {
      throw operationErrors.create("contract.input_too_large", {
        maxBytes: functionRequestMaxBytes,
      });
    }
    text += decoder.decode(value, { stream: true });
  }
};

/**
 * The request a chat's code sent, as text: a stream, read no further than
 * a request may be (`functionRequestMaxBytes`) before anything parses it,
 * so the bound holds before deserialization, and within `requestReadMs`,
 * so a stream that never ends holds nothing. Anything else is refused, and
 * the stream cancelled.
 */
export const requestText = async (request: unknown): Promise<string> => {
  if (!(request instanceof ReadableStream)) {
    throw operationErrors.create("contract.invalid_request");
  }
  const reader: ReadableStreamDefaultReader<unknown> = request.getReader();
  const limit = deadline(requestReadMs);
  try {
    return await Promise.race([
      readBounded(reader),
      whenAborted(limit.signal).catch(() => {
        throw operationErrors.create("operation.deadline_exceeded");
      }),
    ]);
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Cancelled already, or the sender gone: nothing more to read.
    }
    throw error;
  } finally {
    limit.clear();
  }
};

/**
 * Cancels a request a chat's code sent that is refused before it is read
 * (`requestText`): nothing reads it, and nothing of it is held.
 */
export const cancelRequest = async (request: unknown): Promise<void> => {
  if (!(request instanceof ReadableStream) || request.locked) {
    return;
  }
  try {
    await request.cancel();
  } catch {
    // The sender gone already: nothing to cancel.
  }
};

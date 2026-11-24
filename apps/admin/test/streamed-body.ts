/** A streamed body's pieces, and how long it would be in all: 4 MiB. */
const chunkBytes = 16 * 1024;
const streamedBytes = 4 * 1024 * 1024;

/**
 * A request body far longer than any route's limit, streamed with no
 * `Content-Length`, and whether whoever read it pulled it all: a route
 * that holds a body whole before measuring it does.
 */
export const longStream = (): {
  body: ReadableStream<Uint8Array>;
  heldWhole: () => boolean;
} => {
  const chunk = new TextEncoder().encode(" ".repeat(chunkBytes));
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (pulled >= streamedBytes) {
        controller.close();
        return;
      }
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { body, heldWhole: () => pulled >= streamedBytes };
};

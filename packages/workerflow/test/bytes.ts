// Bytes the test definitions stream, and how the tests check them.

/** `length` bytes of a pattern that differs at every offset nearby. */
export const patterned = (length: number, seed = 0): Uint8Array<ArrayBuffer> =>
  Uint8Array.from({ length }, (_, index) => (index * 31 + seed) % 256);

export const sha256 = async (bytes: Uint8Array): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");

/** A stream that hands over `chunks` as they are, then ends. */
export const chunkStream = (chunks: unknown[]): ReadableStream<unknown> =>
  new ReadableStream<unknown>({
    start: (controller) => {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

/**
 * `content` split at `sizes`, each piece in another form a stream may hand
 * over: a Uint8Array, an ArrayBuffer, and a view into a larger buffer.
 */
export const pieces = (content: Uint8Array, sizes: number[]): unknown[] => {
  let offset = 0;
  return sizes.map((size, index) => {
    const piece = content.slice(offset, offset + size);
    offset += size;
    if (index % 3 === 1) {
      return piece.buffer;
    }
    if (index % 3 === 2) {
      const padded = new Uint8Array(size + 4);
      padded.set(piece, 2);
      return padded.subarray(2, 2 + size);
    }
    return piece;
  });
};

// Bytes too large for one message of a session with the on-prem sandbox
// host (a platform module, a graph's tarballs, an upload, an artifact),
// handed over a chunk at a time: the reader on one side gives each part's
// chunks in order and once (core's `inOrderReader`), and the other side
// takes exactly as many bytes as the part's size, and fails a chunk that
// doesn't fit rather than fill or skip anything.

/**
 * How much of a part goes in one chunk: well within a session's message
 * once Cap'n Web has encoded it.
 */
export const chunkBytes = 1024 * 1024;

/** Reads part `name` from `offset`: its next chunk. */
export type ChunkRead = (name: string, offset: number) => Promise<unknown>;

/**
 * Part `name`, `size` bytes, read whole through `read` a chunk at a time,
 * each from where the last one ended. A chunk that isn't bytes, is empty
 * or runs past `size` fails it, with a `TypeError`.
 */
export const readWhole = async (
  read: ChunkRead,
  name: string,
  size: number
): Promise<Uint8Array<ArrayBuffer>> => {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TypeError(`${name} has no size.`);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    // In order: each chunk starts where the last one ended.
    // oxlint-disable-next-line no-await-in-loop
    const chunk = await read(name, offset);
    if (
      !(chunk instanceof Uint8Array) ||
      chunk.byteLength === 0 ||
      offset + chunk.byteLength > size
    ) {
      throw new TypeError(`${name} didn't arrive as it was sent.`);
    }
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

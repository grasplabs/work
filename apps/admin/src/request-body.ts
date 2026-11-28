/**
 * A request's body, read no further than `maxBytes`: `undefined` when it
 * is longer, by its declared `Content-Length` before anything is read, or
 * else as it streams in, the stream cancelled there. A body that declares
 * no length is never held whole before it is measured.
 */
import "@tanstack/react-start/server-only";

/** The body's bytes, exactly as sent. */
export const boundedBytes = async (
  request: Request,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer> | undefined> => {
  if (Number(request.headers.get("content-length") ?? "0") > maxBytes) {
    await request.body?.cancel();
    return undefined;
  }
  if (request.body === null) {
    return new Uint8Array();
  }
  const reader: ReadableStreamDefaultReader<unknown> = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream reads in order
    const { done, value } = await reader.read();
    if (done) {
      const body = new Uint8Array(bytes);
      let at = 0;
      for (const chunk of chunks) {
        body.set(chunk, at);
        at += chunk.byteLength;
      }
      return body;
    }
    // A request's body is bytes; anything else has no length to count.
    bytes += value instanceof Uint8Array ? value.byteLength : 0;
    if (!(value instanceof Uint8Array) || bytes > maxBytes) {
      // oxlint-disable-next-line no-await-in-loop -- the last step
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
};

/** The body as text. */
export const boundedText = async (
  request: Request,
  maxBytes: number
): Promise<string | undefined> => {
  const bytes = await boundedBytes(request, maxBytes);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
};

/**
 * A request's body as text, read no further than `maxBytes`: `undefined`
 * when it is longer, by its declared `Content-Length` before anything is
 * read, or else as it streams in, the stream cancelled there. A body that
 * declares no length is never held whole before it is measured.
 */
export const boundedText = async (
  request: Request,
  maxBytes: number
): Promise<string | undefined> => {
  if (Number(request.headers.get("content-length") ?? "0") > maxBytes) {
    await request.body?.cancel();
    return undefined;
  }
  if (request.body === null) {
    return "";
  }
  const reader: ReadableStreamDefaultReader<unknown> = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream reads in order
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    // A request's body is bytes; anything else has no length to count.
    bytes += value instanceof Uint8Array ? value.byteLength : 0;
    if (!(value instanceof Uint8Array) || bytes > maxBytes) {
      // oxlint-disable-next-line no-await-in-loop -- the last step
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
};

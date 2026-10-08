// Reading an unauthenticated request's body without trusting its size.

/**
 * A request's body as text, read no further than `max` bytes: undefined
 * past them, whatever its `content-length` said, or didn't.
 */
export const boundedText = async (
  body: ReadableStream<Uint8Array> | null,
  max: number
): Promise<string | undefined> => {
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- chunk by chunk, in order
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > max) {
      // oxlint-disable-next-line no-await-in-loop -- once, as it stops reading
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(whole);
};

/** `text` as JSON, or undefined when it isn't. */
export const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

import { readAtMost, readDeadlineMs } from "@grasp-os/shared/http";

// Reading an unauthenticated request's body without trusting its size.

/**
 * A request's body as text, read no further than `max` bytes: undefined
 * past them, whatever its `content-length` said, or didn't. Refuses with
 * `request.timeout` once it has taken longer than `deadlineMs` to arrive
 * (`readAtMost`): an unauthenticated client can't hold the request open.
 */
export const boundedText = async (
  body: ReadableStream<Uint8Array> | null,
  max: number,
  deadlineMs = readDeadlineMs
): Promise<string | undefined> => {
  if (body === null) {
    return "";
  }
  const bytes = await readAtMost(body, max, deadlineMs);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
};

/** `text` as JSON, or undefined when it isn't. */
export const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

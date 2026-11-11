/**
 * Values a stored record or an outside answer could put where an API path
 * takes one segment, as the threat model on GRA-1779 lists them: each
 * would move a call made with the deployer's token, or Attio's key, if
 * pasted into the path as it is.
 */
import { ApiPathError } from "@grasp-os/shared/api-path";

export const hostileSegments = [
  "..",
  "../../other",
  "%2e%2e",
  "%2e%2e/x",
  "a%2fb",
  "a/b",
  "//evil.example/x",
  "https://evil.example/x",
  "x?y=1",
  "x#y",
] as const;

/**
 * The one segment `path` (as a request went out, still encoded) holds
 * between `before` and `after`, decoded; undefined when what is there is
 * not exactly one segment under `before`.
 */
export const segmentBetween = (
  path: string,
  before: string,
  after = ""
): string | undefined => {
  if (
    !path.startsWith(`${before}/`) ||
    !path.endsWith(after) ||
    path.length <= before.length + 1 + after.length
  ) {
    return undefined;
  }
  const segment = path.slice(before.length + 1, path.length - after.length);
  return segment.includes("/") ? undefined : decodeURIComponent(segment);
};

/** Whether `send` was refused for its path (`ApiPathError`); any other failure counts as sent. */
export const refusedForItsPath = async (
  send: () => Promise<unknown>
): Promise<boolean> => {
  try {
    await send();
  } catch (error) {
    return error instanceof ApiPathError;
  }
  return false;
};

/**
 * The values above no segment can be: dot pieces, plain or
 * percent-encoded, empty pieces (`//`), and `?` or `#`.
 */
const refusedSegments: ReadonlySet<string> = new Set([
  "..",
  "../../other",
  "%2e%2e",
  "%2e%2e/x",
  "//evil.example/x",
  "https://evil.example/x",
  "x?y=1",
  "x#y",
]);

/**
 * What a call with `value` in its path must come to: refused unsent when
 * no segment can be it (`..`, `%2e%2e`, an empty piece, `?` or `#`, or
 * what an API decoding `%2F` or the path once would read as such), or
 * else sent with `value` as its one segment, decoding back to itself.
 */
export const keptOrRefused = (
  value: string
): { refused: boolean; segments: string[] } =>
  refusedSegments.has(value)
    ? { refused: true, segments: [] }
    : { refused: false, segments: [value] };

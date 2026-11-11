/**
 * A path below an outside API's base, made of segments. A value put
 * unencoded into a path is read again by the URL parser: `/` adds
 * segments, `?` and `#` end the path, `\` reads as `/`, and `.` and `..`
 * (also as `%2e%2e`) move up. `encodeURIComponent` closes all of these
 * but `.` and `..`, which it leaves as they are, so a path a URL parser
 * would change is refused, as is an empty segment, which would turn an
 * item's path into its collection's. What comes out is the path a request
 * will have, one segment per argument. An API that decodes a path twice
 * is not covered. The threat model is on GRA-1779.
 */

declare const brand: unique symbol;

/** A path below an API's base that `apiPath` made: the only way to make one. */
export type ApiPath = string & { readonly [brand]: true };

/** A path refused: it would not reach the resource its segments name. */
export class ApiPathError extends Error {
  override name = "ApiPathError";
}

/** Any fixed origin: only the path it parses back to is compared. */
const origin = "https://api.invalid";

const encoded = (segment: string, index: number): string => {
  try {
    if (segment !== "") {
      return encodeURIComponent(segment);
    }
  } catch {
    // A lone surrogate: the same refusal as an empty segment.
  }
  throw new ApiPathError(`Segment ${index} of an API path is refused.`);
};

/** Whether a URL parser reads `path` back as exactly that path. */
const isApiPath = (path: string): path is ApiPath => {
  const url = new URL(`${origin}${path}`);
  return url.pathname === path && url.search === "" && url.hash === "";
};

/**
 * `/a/b/c` from segments, each percent-encoded, fixed words and values
 * alike. A value that holds several segments on purpose is passed split.
 */
export const apiPath = (...segments: readonly string[]): ApiPath => {
  if (segments.length === 0) {
    throw new ApiPathError("An API path needs at least one segment.");
  }
  const path = `/${segments.map(encoded).join("/")}`;
  if (!isApiPath(path)) {
    throw new ApiPathError("An API path a URL would change is refused.");
  }
  return path;
};

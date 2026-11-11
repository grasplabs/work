/**
 * A path below an outside API's base, made of segments. A value put
 * unencoded into a path is read again by the URL parser: `/` adds
 * segments, `?` and `#` end the path, `\` reads as `/`, and `.` and `..`
 * (also as `%2e%2e`) move up. `encodeURIComponent` closes all of these
 * but `.` and `..`, so an empty segment, which would turn an item's path
 * into its collection's, is refused, as is a segment with a dot piece:
 * a piece between its `/`, `\`, `?` or `#` (or the whole segment) that is
 * `.` or `..`, plain or percent-encoded (`%2e`, `.%2E`), with or without
 * spaces at its ends (`.. `). Once decoded, `/` and `\` split a segment
 * and `?` and `#` end the path, so `..?x` reads as `..`. A segment with
 * an ASCII control character (U+0000 to U+001F, U+007F) is refused too:
 * a URL parser drops tabs and line breaks (`.\t.` reads as `..`) and
 * trims controls and spaces at a URL's ends, and no id, name, key or
 * version holds one. So neither a URL parser nor an API or proxy that
 * decodes a path once before routing (`%252e` to `%2e`, `%2F` to `/`,
 * `%3F` to `?`, `%09` to a tab) moves up; the tests hold every value of
 * up to four dots, separators, spaces and tabs to it. What comes
 * out is the path a request will have, one segment per argument. Not
 * covered: an API that decodes a path twice (a value's `%252e` would
 * reach its router as `.`), a server that reads `;` parameters inside a
 * segment (`..;x`), and one that folds Unicode lookalike dots (U+2025)
 * into `..`. The threat model is on GRA-1779.
 */

declare const brand: unique symbol;

/** A path below an API's base that `apiPath` made: the only way to make one. */
export type ApiPath = string & { readonly [brand]: true };

/** A path refused: it would not reach the resource its segments name. */
export class ApiPathError extends Error {
  override name = "ApiPathError";
}

/**
 * Where a piece of a segment ends once `%2F`, `%5C`, `%3F` or `%23` in it
 * is decoded: a new segment, or the end of the path.
 */
const separator = /[/\\?#]/u;

/**
 * A dot piece: `.` or `..`, each dot plain or percent-encoded, with any
 * spaces at its ends, which a URL parser trims at a URL's end.
 */
const dotPiece = /^ *(?:\.|%2e){1,2} *$/iu;

/** An ASCII control character, which a URL parser drops or trims. */
// oxlint-disable-next-line no-control-regex -- the controls are what it finds
const control = /[\u0000-\u001F\u007F]/u;

/** Whether a piece of `segment` would move up once it is decoded once. */
const hasDotPiece = (segment: string): boolean =>
  segment.split(separator).some((piece) => dotPiece.test(piece));

/** Any fixed origin: only the path it parses back to is compared. */
const origin = "https://api.invalid";

const encoded = (segment: string, index: number): string => {
  try {
    if (segment !== "" && !control.test(segment) && !hasDotPiece(segment)) {
      return encodeURIComponent(segment);
    }
  } catch {
    // A lone surrogate: the same refusal as an empty segment.
  }
  throw new ApiPathError(`Segment ${index} of an API path is refused.`);
};

/**
 * Whether a URL parser reads `path` back as exactly that path: a backstop
 * for the encoding and the dot-piece rule above, after which no parser
 * should change it.
 */
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

/** Whether `value` can be one segment of a path `apiPath` makes. */
export const isApiPathSegment = (value: string): boolean => {
  try {
    apiPath(value);
    return true;
  } catch {
    // `apiPath` throws only its refusal.
    return false;
  }
};

import { describe, expect, it } from "vite-plus/test";

import { ApiPathError, apiPath, isApiPathSegment } from "../src/api-path.ts";

const base = "https://api.example/client/v4";
const { host, pathname: basePath } = new URL(base);

/** Where a request to `base` + `apiPath(...segments)` would go. */
const requestTo = (segments: readonly string[]) => {
  const path = apiPath(...segments);
  const url = new URL(`${base}${path}`);
  const under = url.pathname.startsWith(`${basePath}/`);
  return {
    host: url.host,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    segments: under
      ? url.pathname
          .slice(basePath.length + 1)
          .split("/")
          .map((segment) => decodeURIComponent(segment))
      : [],
  };
};

/**
 * What it must do: stay on the API's host, at the path made, under its
 * base, one segment per argument, each decoding back to the value passed,
 * with no query or fragment.
 */
const keeping = (segments: readonly string[]) => ({
  host,
  pathname: `${basePath}${apiPath(...segments)}`,
  search: "",
  hash: "",
  segments,
});

/** The message of the refusal `apiPath(...segments)` throws. */
const refusalOf = (segments: readonly string[]): string => {
  try {
    apiPath(...segments);
  } catch (error) {
    if (error instanceof ApiPathError) {
      return error.message;
    }
    throw error;
  }
  throw new Error("Not refused.");
};

/** Values that stay one literal segment under their parent. */
const keptValues = [
  "a%2fb",
  "a/b",
  "@scope/name",
  "a\\b",
  "a b",
  "a%00b",
  "@evil.example",
  "user:pass@evil.example",
  ":8443",
  "ü",
  "日本",
  ";param",
  "a&b=c",
] as const;

/** Segments refused, each with what it is. */
const refusals = [
  ["dot-dot", [".."]],
  ["dot", ["."]],
  ["dot-dot after fixed words", ["accounts", "..", "users"]],
  ["dot at the end", ["accounts", "0123abcd", "."]],
  ["dot-dot pieces split by slashes", ["scripts", "../../other"]],
  ["a dot-dot piece in the middle", ["scripts", "a/../b"]],
  ["a dot-dot piece at the end", ["scripts", "x/.."]],
  ["a dot piece in the middle", ["scripts", "a/./b"]],
  ["dot-dot pieces split by backslashes", ["scripts", "..\\.."]],
  ["a dot piece before a backslash", ["scripts", ".\\x"]],
  ["encoded dot-dot", ["scripts", "%2e%2e"]],
  ["encoded dot-dot in capitals", ["scripts", "%2E%2E"]],
  ["a dot and an encoded dot", ["scripts", ".%2e"]],
  ["an encoded dot and a dot", ["scripts", "%2e."]],
  ["an encoded dot", ["scripts", "%2e"]],
  ["an encoded dot-dot piece before a slash", ["scripts", "%2e%2e/x"]],
  ["a half-encoded dot-dot piece before a backslash", ["scripts", ".%2E\\x"]],
  ["a half-encoded dot-dot piece in the middle", ["scripts", "a/.%2e/b"]],
  ["dots around a tab", ["scripts", ".\t."]],
  ["dots around a line feed", ["scripts", ".\n."]],
  ["dots around a carriage return", ["scripts", ".\r."]],
  ["an encoded dot-dot split by a tab", ["scripts", "%2\te%2e"]],
  ["dots around a line feed in the middle", ["scripts", "a/.\n./b"]],
  ["dot-dot and a trailing space", ["scripts", ".. "]],
  ["a space and dot-dot", ["scripts", " .."]],
  ["a tab", ["scripts", "a\tb"]],
  ["a line feed", ["scripts", "a\nb"]],
  ["a NUL", ["scripts", "a\u0000b"]],
  ["a DEL", ["scripts", "a\u007Fb"]],
  ["a query mark", ["scripts", "x?y=1"]],
  ["a fragment mark", ["scripts", "x#frag"]],
  ["an empty piece before a slash", ["scripts", "/abs"]],
  ["empty pieces before a host", ["scripts", "//evil.example/x"]],
  ["an empty piece in a URL", ["scripts", "https://evil.example/x"]],
  ["an empty piece at the end", ["scripts", "x/"]],
  ["an empty piece before a backslash", ["scripts", "\\x"]],
  ["a piece of spaces at the end", ["scripts", "x/ "]],
  ["a slash", ["scripts", "/"]],
  ["a lone query mark", ["accounts", "?", "workers"]],
  ["a lone fragment mark", ["connected_accounts", "#"]],
  ["empty", [""]],
  ["empty at the end", ["accounts", "0123abcd", "scripts", ""]],
  ["empty in the middle", ["accounts", "", "scripts"]],
  ["lone high surrogate", ["\uD800"]],
  ["lone low surrogate", ["a\uDC00b"]],
  ["no segments", []],
] as const;

/**
 * Values aimed at a gateway that decodes a path once: a dot piece ended by
 * `?` or `#`, and dots beside an escape that decodes to a separator.
 */
const movingUp = [
  "..?x",
  "..#x",
  "%2e%2e?x",
  "%2E%2e#x",
  "x/..?y",
  "x\\..#y",
  ".?x",
  "..?",
  "..#",
  "?..",
  "#..",
  "x?../..",
  ".. ?x",
  "..%3Fx",
  "..%23x",
  "..%2fx",
  "%2e%2e%2f",
  "%2e%2e%5c",
  "..%09",
  "..%00",
  "..%20",
  "%252e%252e",
  "?",
  "#",
  "x?",
  "x#",
  "?x",
  "a?b",
];

/** What a value is built from, for every value of up to four of them. */
const pieces = [".", "%2e", "%2E", "/", "\\", "?", "#", " ", "\t", "x"];

const combined = (length: number): string[] =>
  length === 0
    ? [""]
    : combined(length - 1).flatMap((head) =>
        pieces.map((piece) => `${head}${piece}`)
      );

const longest = 4;

/**
 * How many of `everyCombination` (11,110 values) `apiPath` must accept for
 * the property test not to pass by refusing everything: 730 are accepted,
 * those of `.`, `%2e`, `%2E`, `/`, `\`, space and `x` with no `?`, `#` or
 * tab and no piece empty or of one or two dots; a little below, so a
 * narrower rule shows here first.
 */
const acceptedFloor = 700;

/** Every value up to `longest` pieces long. */
const everyCombination = Array.from({ length: longest }, (_, index) =>
  combined(index + 1)
).flat();

/**
 * What reads a path before routing: a URL parser alone, or a gateway that
 * decodes the path once first (all of it, as a URI, or only what splits
 * or ends a segment).
 */
const readings = {
  parser: (path: string) => path,
  decodeURIComponent,
  decodeURI,
  separators: (path: string) =>
    path.replaceAll(/%(?:2F|5C|3F|23|2E|09)/giu, (escape) =>
      decodeURIComponent(escape)
    ),
} as const;

const parent = `${basePath}/parent/`;

/**
 * Whether `pathname`, read from `apiPath("parent", value, "child")`, keeps
 * the value at its place: below `parent`, at least one non-empty segment,
 * then `child` last.
 */
const keepsChild = (pathname: string): boolean =>
  pathname.startsWith(parent) &&
  pathname.endsWith("/child") &&
  pathname
    .slice(parent.length, -"/child".length)
    .split("/")
    .some((segment) => segment !== "");

/**
 * Whether `pathname`, read from `apiPath("parent", value)`, keeps the value
 * at its place: below `parent`, with a non-empty last segment.
 */
const keepsLast = (pathname: string): boolean =>
  pathname.startsWith(parent) &&
  pathname.length > parent.length &&
  !pathname.endsWith("/");

/**
 * How `value` between a parent and a child, or after a parent, reaches a
 * router somewhere else than its place (above it, as the parent itself, or
 * without the child), if it does: `[]` when it stays, or is refused.
 */
const escapesOf = (value: string): string[] => {
  let paths: [string, (pathname: string) => boolean][];
  try {
    paths = [
      [apiPath("parent", value, "child"), keepsChild],
      [apiPath("parent", value), keepsLast],
    ];
  } catch (error) {
    if (error instanceof ApiPathError) {
      return [];
    }
    throw error;
  }
  return paths.flatMap(([path, keeps]) =>
    Object.entries(readings).flatMap(([reading, read]) => {
      const { pathname } = new URL(`${base}${read(path)}`);
      return keeps(pathname) ? [] : [`${reading}: ${path} -> ${pathname}`];
    })
  );
};

describe(apiPath, () => {
  it.each([
    "0123456789abcdef0123456789abcdef",
    "3f2b6c1e-9a4d-4e8b-a1c2-5d6e7f8a9b0c",
    "grasp-abc-core",
    "acme.grasp.example",
    "a.b",
    "...",
  ])("keeps the plain id %j as it is", (id) => {
    expect(apiPath("accounts", id)).toBe(`/accounts/${id}`);
    expect(requestTo(["accounts", id])).toStrictEqual(
      keeping(["accounts", id])
    );
  });

  it("joins fixed words and values, one segment each", () => {
    const account = ["accounts", "0123abcd"] as const;
    expect(apiPath(...account, "r2", "buckets", "models")).toBe(
      "/accounts/0123abcd/r2/buckets/models"
    );
    expect(requestTo([...account, "r2", "buckets", "models"])).toStrictEqual(
      keeping([...account, "r2", "buckets", "models"])
    );
  });

  it.each(keptValues)(
    "keeps %j one literal segment under its parent",
    (value) => {
      expect(requestTo(["scripts", value])).toStrictEqual(
        keeping(["scripts", value])
      );
      expect(requestTo(["scripts", value, "settings"])).toStrictEqual(
        keeping(["scripts", value, "settings"])
      );
    }
  );

  it.each(refusals)("refuses %s", (_, segments) => {
    expect(() => apiPath(...segments)).toThrow(ApiPathError);
  });

  it("keeps a value passed split as its segments, and refuses a dot-dot among them", () => {
    const key = "embed-models/sha256/abc";
    expect(apiPath("objects", ...key.split("/"))).toBe(
      "/objects/embed-models/sha256/abc"
    );
    expect(requestTo(["objects", ...key.split("/")])).toStrictEqual(
      keeping(["objects", ...key.split("/")])
    );
    expect(() => apiPath("objects", ..."embed-models/../x".split("/"))).toThrow(
      ApiPathError
    );
    expect(() => apiPath("objects", ..."embed-models//x".split("/"))).toThrow(
      ApiPathError
    );
  });

  it.each(["..", "secret/../x", "%2e%2e/secret", "\uD800secret"])(
    "names no refused value in its message (%j)",
    (value) => {
      expect(refusalOf(["accounts", value])).not.toContain(value);
    }
  );

  it("keeps every value it doesn't refuse under its parent, read by a URL parser or decoded once first", () => {
    const values = [
      ...keptValues,
      ...refusals.flatMap(([, segments]) => segments),
      ...movingUp,
      ...everyCombination,
    ];
    expect(values.flatMap(escapesOf)).toStrictEqual([]);
  });

  it("accepts enough of the generated values for the property above to hold anything", () => {
    expect(
      everyCombination.filter(isApiPathSegment).length
    ).toBeGreaterThanOrEqual(acceptedFloor);
    expect(["x", "...", "a b", "x/y"].map(isApiPathSegment)).toStrictEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("says whether a value can be one segment", () => {
    expect(
      ["0123abcd", "a/b", "..", ".\t.", "", "x?"].map(isApiPathSegment)
    ).toStrictEqual([true, true, false, false, false, false]);
  });
});

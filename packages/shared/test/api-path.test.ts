import { describe, expect, it } from "vite-plus/test";

import { ApiPathError, apiPath } from "../src/api-path.ts";

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

  it.each([
    "%2e%2e",
    "%2E%2E",
    ".%2e",
    "%2e",
    "a%2fb",
    "a/b",
    "@scope/name",
    "/abs",
    "//evil.example/x",
    "https://evil.example/x",
    "x?y=1",
    "x#frag",
    "a\\b",
    "a b",
    "a%00b",
    "a\u0000b",
    "a\tb",
    "a\nb",
    "@evil.example",
    "user:pass@evil.example",
    ":8443",
    "ü",
    "日本",
    ";param",
    "a&b=c",
  ])("keeps %j one literal segment under its parent", (value) => {
    expect(requestTo(["scripts", value])).toStrictEqual(
      keeping(["scripts", value])
    );
    expect(requestTo(["scripts", value, "settings"])).toStrictEqual(
      keeping(["scripts", value, "settings"])
    );
  });

  it.each([
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
    ["empty", [""]],
    ["empty at the end", ["accounts", "0123abcd", "scripts", ""]],
    ["empty in the middle", ["accounts", "", "scripts"]],
    ["lone high surrogate", ["\uD800"]],
    ["lone low surrogate", ["a\uDC00b"]],
    ["no segments", []],
  ] as const)("refuses %s", (_, segments) => {
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

  it.each(["..", "secret/../x", "\uD800secret"])(
    "names no refused value in its message (%j)",
    (value) => {
      expect(refusalOf(["accounts", value])).not.toContain(value);
    }
  );
});

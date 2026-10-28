import { describe, expect, it } from "vite-plus/test";

import { canonicalJson, valueAtPointer } from "../src/json.ts";

describe("canonical JSON", () => {
  it("gives the same text whatever order the keys were written in", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [2, { f: 3, e: 4 }], c: null } })
    ).toBe(canonicalJson({ a: { c: null, d: [2, { e: 4, f: 3 }] }, b: 1 }));
  });

  it("sorts keys, drops undefined members and adds no whitespace", () => {
    expect(
      canonicalJson({ b: "x", a: [true, "é\n"], skipped: undefined, "": 0 })
    ).toBe('{"":0,"a":[true,"é\\n"],"b":"x"}');
  });

  it("orders keys by UTF-16 code unit, not by locale", () => {
    expect(canonicalJson({ é: 1, z: 2, a: 3, B: 4 })).toBe(
      '{"B":4,"a":3,"z":2,"é":1}'
    );
  });

  it("keeps array order, which carries meaning", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("refuses numbers JSON can't represent", () => {
    expect(() => canonicalJson({ amount: Number.NaN })).toThrow(TypeError);
  });
});

describe("JSON Pointers", () => {
  // RFC 6901, section 5's document and pointers.
  const document = {
    foo: ["bar", "baz"],
    "": 0,
    "a/b": 1,
    "c%d": 2,
    "e^f": 3,
    "g|h": 4,
    "i\\j": 5,
    'k"l': 6,
    " ": 7,
    "m~n": 8,
  };

  it("resolves the RFC's examples", () => {
    expect(
      [
        "",
        "/foo",
        "/foo/0",
        "/",
        "/a~1b",
        "/c%d",
        "/e^f",
        "/g|h",
        "/i\\j",
        '/k"l',
        "/ ",
        "/m~0n",
      ].map((pointer) => valueAtPointer(document, pointer))
    ).toStrictEqual([
      document,
      ["bar", "baz"],
      "bar",
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
    ]);
  });

  it("finds nothing where the document has nothing, nor for what isn't a pointer", () => {
    const pointers = [
      "/foo/2",
      "/foo/01",
      "/foo/-",
      "/missing/deeper",
      "/foo/0/x",
      "foo",
      "/~2",
      "/a~",
      "{{ secrets }}",
      "/constructor",
      "/__proto__",
    ];
    expect(
      pointers.filter(
        (pointer) => valueAtPointer(document, pointer) !== undefined
      )
    ).toStrictEqual([]);
  });
});

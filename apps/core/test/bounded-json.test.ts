import { describe, expect, it } from "vite-plus/test";

import { writeJson } from "../src/workflows/bounded-json.ts";

// The writer core holds what a workflow's isolate hands it to. How it can
// fail: a value that costs more to walk than to hold (shared references,
// hidden keys), a getter or proxy that answers one thing to the check and
// another to the write, and anything that isn't plain JSON passing as it.

const bounds = { maxBytes: 1024, maxDepth: 4, maxNodes: 1024 };

const textOrRefusal = (value: unknown) => {
  const written = writeJson(value, bounds);
  return written.ok ? written.text : written.refusal;
};

describe("writing bounded JSON", () => {
  it("writes plain JSON as JSON.stringify does, leaving undefined members out", () => {
    expect(
      textOrRefusal({ a: [1, "é", null, true], b: undefined, c: { d: -0.5 } })
    ).toBe('{"a":[1,"é",null,true],"c":{"d":-0.5}}');
  });

  it("refuses what isn't plain JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const values: Record<string, unknown> = {
      function: () => 1,
      undefinedInAnArray: [undefined],
      notANumber: Number.NaN,
      bigint: 1n,
      date: new Date(0),
      map: new Map(),
      inherited: Object.create({ inherited: true }),
      cyclic,
      // oxlint-disable-next-line no-sparse-arrays -- a sparse array is the attack
      sparse: [1, , 3],
      protoKey: JSON.parse('{"__proto__": 1}'),
      hidden: Object.defineProperty({}, "x", { value: 1, enumerable: false }),
      symbol: { [Symbol("x")]: 1 },
      loneSurrogate: "\uD800",
    };
    expect(
      Object.fromEntries(
        Object.entries(values).map(([name, value]) => [
          name,
          textOrRefusal(value),
        ])
      )
    ).toStrictEqual(
      Object.fromEntries(Object.keys(values).map((name) => [name, "invalid"]))
    );
  });

  it("holds arrays and objects nested, UTF-8 bytes and values visited to their bounds", () => {
    expect({
      deepest: textOrRefusal([[[[1]]]]),
      tooDeep: textOrRefusal([[[[[1]]]]]),
      bytes: textOrRefusal("é".repeat(511)),
      tooManyBytes: textOrRefusal("é".repeat(512)),
      tooManyKeys: textOrRefusal(
        Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`k${i}`, 0]))
      ),
    }).toStrictEqual({
      deepest: "[[[[1]]]]",
      tooDeep: "invalid",
      bytes: `"${"é".repeat(511)}"`,
      tooManyBytes: "too_large",
      tooManyKeys: "too_large",
    });
  });

  it("refuses shared references that would blow up, before walking them", () => {
    // 31 arrays in memory, 2^31 leaves to write.
    let doubling: unknown = 0;
    for (let level = 0; level < 31; level += 1) {
      doubling = [doubling, doubling];
    }
    const written = writeJson(doubling, {
      maxBytes: 1024 * 1024,
      maxDepth: 32,
      maxNodes: 1024 * 1024,
    });
    expect(written).toStrictEqual({ ok: false, refusal: "too_large" });
  });

  it("reads each getter once, so what it checks is what it writes", () => {
    let reads = 0;
    const shifting = {
      get value() {
        reads += 1;
        return reads === 1 ? 1 : { deeper: [[[["past the bound"]]]] };
      },
    };
    expect({ text: textOrRefusal(shifting), reads }).toStrictEqual({
      text: '{"value":1}',
      reads: 1,
    });
  });
});

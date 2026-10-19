import { describe, expect, it } from "vite-plus/test";

import { paramKindOf, paramText, paramValueOf } from "./param-values.ts";

describe("a workflow parameter's field", () => {
  it("takes a value by the kind its schema says", () => {
    expect({
      kinds: [
        { type: "boolean" },
        { type: "integer", minimum: 1 },
        { type: "number" },
        { type: "string", maxLength: 64 },
        { type: "object" },
        { type: ["string", "null"] },
        null,
      ].map(paramKindOf),
      values: [
        paramValueOf("string", "  spaced  "),
        paramValueOf("string", ""),
        paramValueOf("number", " 4 "),
        paramValueOf("number", "four"),
        paramValueOf("number", " "),
        paramValueOf("json", '{"to":["a"]}'),
        paramValueOf("json", "null"),
        paramValueOf("json", "{"),
      ],
      shown: [paramText("plain"), paramText(4), paramText({ a: [1] })],
    }).toStrictEqual({
      kinds: ["boolean", "number", "number", "string", "json", "json", "json"],
      values: [
        // A string as typed, spaces and all, empty too.
        { value: "  spaced  " },
        { value: "" },
        { value: 4 },
        undefined,
        undefined,
        { value: { to: ["a"] } },
        // Null is a value, not nothing typed.
        { value: null },
        undefined,
      ],
      shown: ["plain", "4", '{"a":[1]}'],
    });
  });
});

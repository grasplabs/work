import { describe, expect, it } from "vite-plus/test";

import {
  fieldValueOf,
  paramKindOf,
  paramText,
  paramValueOf,
} from "./param-values.ts";
import type { ParamKind } from "./param-values.ts";

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
      shown: [
        paramText("string", "plain"),
        paramText("number", 4),
        paramText("json", { a: [1] }),
        // A string in a JSON field (a nullable string's) keeps its quotes.
        paramText("json", "hello"),
        paramText("json", "null"),
      ],
      // A sensitive field as it started is nothing typed, a switch too.
      sensitive: [
        fieldValueOf("boolean", {
          text: "",
          checked: false,
          toggled: false,
          sensitive: true,
        }),
        fieldValueOf("boolean", {
          text: "",
          checked: false,
          toggled: true,
          sensitive: true,
        }),
        fieldValueOf("boolean", {
          text: "",
          checked: false,
          toggled: false,
          sensitive: false,
        }),
        fieldValueOf("string", {
          text: "",
          checked: false,
          toggled: false,
          sensitive: true,
        }),
        fieldValueOf("string", {
          text: "",
          checked: false,
          toggled: false,
          sensitive: false,
        }),
      ],
      // What each field shows reads back as the same value.
      roundTrips: (
        [
          ["string", "plain"],
          ["number", 4],
          ["json", "hello"],
          ["json", "null"],
          ["json", null],
          ["json", { a: [1] }],
        ] as const
      ).map(
        ([kind, value]: readonly [Exclude<ParamKind, "boolean">, unknown]) =>
          paramValueOf(kind, paramText(kind, value))
      ),
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
      shown: ["plain", "4", '{"a":[1]}', '"hello"', '"null"'],
      sensitive: [
        undefined,
        { value: false },
        { value: false },
        undefined,
        { value: "" },
      ],
      roundTrips: [
        { value: "plain" },
        { value: 4 },
        { value: "hello" },
        { value: "null" },
        { value: null },
        { value: { a: [1] } },
      ],
    });
  });
});

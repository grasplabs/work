import { describe, expect, it } from "vite-plus/test";

import {
  compactDescriptor,
  CompactDescriptorError,
  descriptorFromCompact,
} from "../src/value-compact.ts";
import { v } from "../src/values.ts";

// A descriptor's compact form (pure logic, from its threat model): it is
// written by hand and read from stored text, so the reader takes nothing
// a `v` declaration couldn't make (unknown kinds and keys, a flag that
// isn't `true`, a default its schema refuses, a prototype key, a
// descriptor past the limits), says where it is wrong, and every full
// descriptor survives being written and read back.

/** The code and path a compact descriptor was refused with. */
const refusal = (compact: unknown): unknown => {
  try {
    descriptorFromCompact(compact);
    return "read";
  } catch (error) {
    return error instanceof CompactDescriptorError
      ? { code: error.code, path: error.path }
      : "threw";
  }
};

const schemas = {
  text: v.string().trim().min(1).max(200),
  email: v.string().email().nullable().optional(),
  count: v.number().integer().min(0).default(0),
  flag: v.boolean(),
  nothing: v.null(),
  exactly: v.literal("yes"),
  choice: v.enum(["low", "high"]).default("low"),
  row: v.id("tasks", { onDelete: "cascade" }),
  list: v.array(v.string()).min(1).max(3),
  either: v.union(v.object({ a: v.string() }), v.number()),
  map: v.record(v.number()),
  amount: v.money().default({ minorUnits: 500, currency: "EUR" }),
  when: v.timestamp().optional(),
  who: v.person(),
};

/** A refusal's code and path. */
const at = (
  path: (string | number)[],
  code = "definition.invalid_descriptor"
) => ({ code, path });

/** Arrays of strings, `depth` deep. */
const deep = (depth: number): unknown =>
  depth === 0 ? { kind: "string" } : { kind: "array", item: deep(depth - 1) };

describe("a descriptor's compact form", () => {
  it("leaves out everything a descriptor holds by default", () => {
    expect({
      text: compactDescriptor(schemas.text.descriptor),
      email: compactDescriptor(schemas.email.descriptor),
      count: compactDescriptor(schemas.count.descriptor),
      object: compactDescriptor(
        v.object({ name: v.string(), tags: v.array(v.string()).optional() })
          .descriptor
      ),
    }).toStrictEqual({
      text: { kind: "string", trim: true, min: 1, max: 200 },
      email: { kind: "string", email: true, nullable: true, optional: true },
      count: { kind: "number", integer: true, min: 0, default: 0 },
      object: {
        kind: "object",
        fields: {
          name: { kind: "string" },
          tags: { kind: "array", item: { kind: "string" }, optional: true },
        },
      },
    });
  });

  it("reads back the descriptor it was written from, for every kind", () => {
    const whole = v.object(schemas).descriptor;

    expect(
      descriptorFromCompact(structuredClone(compactDescriptor(whole)))
    ).toStrictEqual(whole);
  });

  it("refuses what no `v` declaration makes, saying where", () => {
    expect({
      notAnObject: refusal("string"),
      unknownKind: refusal({ kind: "any" }),
      unknownKey: refusal({
        kind: "object",
        fields: { a: { kind: "string", pattern: "x" } },
      }),
      falseFlag: refusal({ kind: "string", nullable: false }),
      longhand: refusal({ kind: "string", presence: "required" }),
      both: refusal({ kind: "string", optional: true, default: "" }),
      badDefault: refusal({
        kind: "object",
        fields: { n: { kind: "number", max: 3, default: 4 } },
      }),
      badBound: refusal({
        kind: "array",
        item: { kind: "string", min: 3, max: 1 },
      }),
      prototypeKey: refusal(
        JSON.parse(
          '{ "kind": "object", "fields": { "__proto__": { "kind": "string" } } }'
        )
      ),
      tooDeep: refusal(deep(64)),
    }).toStrictEqual({
      notAnObject: at([]),
      unknownKind: at([]),
      unknownKey: at(["fields", "a"]),
      falseFlag: at([]),
      longhand: at([]),
      both: at([]),
      badDefault: at(["fields", "n"], "definition.invalid_default"),
      badBound: at(["item"], "definition.contradictory_bounds"),
      prototypeKey: at([], "definition.invalid_key"),
      tooDeep: at(
        Array.from({ length: 64 }, () => "item"),
        "definition.too_large"
      ),
    });
  });
});

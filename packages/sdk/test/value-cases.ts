// The conformance cases of the SDK's values: what `v` accepts, refuses and
// normalizes to. They are data and plain functions, with no test runner in
// them, because the same cases run in two places: in workerd
// (values.test.ts) and in a real browser (e2e/sdk-values.e2e.ts). A case
// that passes in one and fails in the other is a value the browser and the
// host would disagree about.
import { schemaFromDescriptor } from "../src/host.ts";
import { ValueDefinitionError, v } from "../src/values.ts";
import type { ValueSchema } from "../src/values.ts";

type AnySchema = ValueSchema<unknown, unknown>;

/** What a check answered, as JSON: the value, or each issue's code and path. */
const check = (schema: AnySchema, value?: unknown): unknown => {
  const result = schema["~standard"].validate(value);
  return result.issues === undefined
    ? { value: result.value }
    : { issues: result.issues.map((issue) => [issue.code, ...issue.path]) };
};

/** `declared`, or the code a declaration was refused with. */
const declare = (make: () => unknown): string => {
  try {
    make();
    return "declared";
  } catch (error) {
    return error instanceof ValueDefinitionError ? error.code : "threw";
  }
};

/** A descriptor as it is stored and sent: through JSON and back. */
const stored = (schema: AnySchema): unknown => {
  const text = JSON.stringify(schema.descriptor);
  return JSON.parse(text);
};

const base = { descriptorVersion: 1, nullable: false, presence: "required" };

/**
 * Cron expressions `v.schedule()` accepts. Each must also be one the parser
 * schedules run on accepts (values.test.ts checks that), so a schedule that
 * validates is one that can be run.
 */
export const acceptedCrons = [
  "0 8 * * 1",
  "*/15 9-17 1,15 1-12/3 0-7",
  "0-30/10 4 * * *",
  "*/59 */23 */31 */12 */7",
  "* * * * 7",
  "0 0 29 2 *",
  "0 0 31 2,3 *",
  "0 0 31 */2 *",
  // A day of the week makes it come, whatever the day of the month says.
  "0 0 31 2 1",
];

/** Expressions that parser refuses too: a step with nothing to step over, a
 * step past the field, and a date that never comes. */
export const cronsNoParserAccepts = [
  "5/2 * * * *",
  "*/99 * * * *",
  "0 0 1-31/99 * *",
  "0 0 31 2 *",
];

const refusedCrons = [
  ...cronsNoParserAccepts,
  "0 0 30 2 *",
  "0 0 31 4,6,9,11 *",
  "0 0 31 2-2 *",
  "*/60 * * * *",
  "* * * * 1/2",
  "0 8 * *",
  "0 8 * * 1 2026",
  "60 8 * * 1",
  "0 24 * * 1",
  "0 8 0 * 1",
  "0 8 * 13 1",
  "0 8 * * 8",
  "0 8 * * MON",
  "5-1 8 * * 1",
  "*/0 8 * * 1",
  "0  8 * * 1",
  "@daily",
];

/** JSON as it arrives: a `__proto__` key in it is a key like any other. */
const fromJson = (text: string): unknown => JSON.parse(text);

/** Looks like a schema, but `v` never made it. */
const lookalike = { descriptor: { ...base, kind: "boolean" } };

const deeplyFrozen = (value: unknown): boolean =>
  typeof value !== "object" ||
  value === null ||
  (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));

const wideSchema = (fields: number): unknown =>
  v.object(
    Object.fromEntries(
      Array.from({ length: fields }, (_, index) => [`f${index}`, v.boolean()])
    )
  );

const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
};
const note = v.object(noteFields);

const recordId = "0192f0c1-7c3e-7abc-8def-0123456789ab";

/** An object whose keys can't be listed without running code. */
const unreadable = (): unknown =>
  new Proxy(
    {},
    {
      ownKeys: () => {
        throw new Error("no");
      },
    }
  );

/** A descriptor that contains itself. */
const cyclicDescriptor = (): unknown => {
  const descriptor: Record<string, unknown> = { ...base, kind: "array" };
  descriptor.item = descriptor;
  return descriptor;
};

/** Arrays nested `depth` deep around a string. */
const nestedDescriptor = (depth: number): unknown => {
  let descriptor: unknown = {
    ...base,
    kind: "string",
    trim: false,
    email: false,
  };
  for (let level = 1; level < depth; level += 1) {
    descriptor = { ...base, kind: "array", item: descriptor };
  }
  return descriptor;
};

const nestedSchema = (depth: number): AnySchema => {
  let schema: AnySchema = v.string();
  for (let level = 1; level < depth; level += 1) {
    schema = v.array(schema);
  }
  return schema;
};

const wideDescriptor = (fields: number): unknown => ({
  ...base,
  kind: "object",
  fields: Object.fromEntries(
    Array.from({ length: fields }, (_, index) => [
      `field${index}`,
      { ...base, kind: "boolean" },
    ])
  ),
});

export interface ValueCase {
  readonly actual: () => unknown;
  readonly expected: unknown;
  readonly name: string;
}

const cases: ValueCase[] = [];

const add = (name: string, actual: () => unknown, expected: unknown): void => {
  cases.push({ actual, expected, name });
};

// Standard Schema

add(
  "a schema is Standard Schema v1 from the vendor grasp",
  () => {
    const { version, vendor } = v.string()["~standard"];
    return { vendor, version };
  },
  { vendor: "grasp", version: 1 }
);

add(
  "there is one way to check a value: no parse, safeParse or validate beside it",
  () =>
    [v.string(), v.number(), note, v.array(v.string()), v.money()].flatMap(
      (schema) =>
        ["parse", "safeParse", "validate", "refine", "transform"].filter(
          (name) => name in schema
        )
    ),
  []
);

add(
  "v has no any, bytes, vector, bigint or int, and no coercion",
  () =>
    ["any", "bytes", "vector", "bigint", "int", "coerce", "optional"].filter(
      (name) => name in v
    ),
  []
);

add(
  "the note example normalizes: the title is trimmed, the body filled in",
  () => check(note, { title: "  Launch  " }),
  { value: { title: "Launch", body: "" } }
);

add(
  "an issue has a stable code, a message and a path",
  () => note["~standard"].validate({ title: "", body: 5 }).issues,
  [
    {
      code: "value.too_short",
      message: "The value is too short.",
      path: ["title"],
    },
    {
      code: "value.invalid_type",
      message: "The value has the wrong type.",
      path: ["body"],
    },
  ]
);

add(
  "a message never repeats what was submitted",
  () => {
    const secret = "hunter2-secret";
    const schema = v.object({
      email: v.string().email(),
      kind: v.enum(["a", "b"]),
      only: v.literal("x"),
    });
    const { issues = [] } = schema["~standard"].validate({
      email: secret,
      kind: secret,
      only: secret,
      [secret]: secret,
    });
    return {
      count: issues.length,
      leaked: issues.some((issue) => issue.message.includes(secret)),
    };
  },
  { count: 4, leaked: false }
);

// Primitives

add("a string", () => check(v.string(), "a"), { value: "a" });
add(
  "an empty string is a value, not a missing one",
  () => check(v.string(), ""),
  {
    value: "",
  }
);
add("a number is not a string", () => check(v.string(), 1), {
  issues: [["value.invalid_type"]],
});
add("a number", () => check(v.number(), 1.5), { value: 1.5 });
add("a string is not turned into a number", () => check(v.number(), "1"), {
  issues: [["value.invalid_type"]],
});
add(
  "a number that isn't finite is refused",
  () =>
    [Number.NaN, Infinity, -Infinity].map((value) => check(v.number(), value)),
  [
    { issues: [["value.not_finite"]] },
    { issues: [["value.not_finite"]] },
    { issues: [["value.not_finite"]] },
  ]
);
add("a bigint is not a number", () => check(v.number(), 1n), {
  issues: [["value.invalid_type"]],
});
add(
  "an integer is a safe whole number",
  () =>
    [1, -3, 1.5, 2 ** 53].map((value) => check(v.number().integer(), value)),
  [
    { value: 1 },
    { value: -3 },
    { issues: [["value.not_integer"]] },
    { issues: [["value.not_integer"]] },
  ]
);
add(
  "a number within its bounds",
  () => [0, 1, 10, 11].map((value) => check(v.number().min(1).max(10), value)),
  [
    { issues: [["value.too_small"]] },
    { value: 1 },
    { value: 10 },
    { issues: [["value.too_large"]] },
  ]
);
add(
  "a boolean",
  () => [true, false, 0, "true"].map((value) => check(v.boolean(), value)),
  [
    { value: true },
    { value: false },
    { issues: [["value.invalid_type"]] },
    { issues: [["value.invalid_type"]] },
  ]
);
add("null", () => [null, undefined, 0].map((value) => check(v.null(), value)), [
  { value: null },
  { issues: [["value.required"]] },
  { issues: [["value.invalid_type"]] },
]);
add(
  "a literal of each kind",
  () => [
    check(v.literal("on"), "on"),
    check(v.literal("on"), "off"),
    check(v.literal(3), 3),
    check(v.literal(3), "3"),
    check(v.literal(true), true),
    check(v.literal(null), null),
    check(v.literal(null)),
  ],
  [
    { value: "on" },
    { issues: [["value.invalid_literal"]] },
    { value: 3 },
    { issues: [["value.invalid_literal"]] },
    { value: true },
    { value: null },
    { issues: [["value.required"]] },
  ]
);
add(
  "a literal must be JSON",
  () => [
    declare(() => v.literal(Number.NaN)),
    // @ts-expect-error -- a literal is a primitive
    declare(() => v.literal({})),
  ],
  ["definition.invalid_value", "definition.invalid_value"]
);
add(
  "an enum",
  () =>
    ["draft", "sent", "DRAFT", 1].map((value) =>
      check(v.enum(["draft", "sent"]), value)
    ),
  [
    { value: "draft" },
    { value: "sent" },
    { issues: [["value.invalid_enum"]] },
    { issues: [["value.invalid_enum"]] },
  ]
);
add(
  "an enum needs values, each once",
  () => [
    // @ts-expect-error -- an enum has at least one value
    declare(() => v.enum([])),
    declare(() => v.enum(["a", "a"])),
    // @ts-expect-error -- an enum's values are strings
    declare(() => v.enum(["a", 1])),
  ],
  [
    "definition.invalid_value",
    "definition.invalid_value",
    "definition.invalid_value",
  ]
);

// Strings

add(
  "trim runs before the length is checked",
  () =>
    ["  a  ", "   ", " abcd "].map((value) =>
      check(v.string().trim().min(1).max(3), value)
    ),
  [
    { value: "a" },
    { issues: [["value.too_short"]] },
    { issues: [["value.too_long"]] },
  ]
);
add(
  "without trim, whitespace counts and stays",
  () => check(v.string().min(1), "   "),
  { value: "   " }
);
add(
  "a string's length is counted in UTF-16 code units",
  () => [check(v.string().max(1), "😀"), check(v.string().max(2), "😀")],
  [{ issues: [["value.too_long"]] }, { value: "😀" }]
);
add(
  "an email address",
  () =>
    [
      "ada@example.com",
      "  ada@example.com ",
      "ada@example",
      "ada example@x.y",
      "@x.y",
      `${"a".repeat(250)}@x.yz`,
    ].map((value) => check(v.string().trim().email(), value)),
  [
    { value: "ada@example.com" },
    { value: "ada@example.com" },
    { issues: [["value.invalid_email"]] },
    { issues: [["value.invalid_email"]] },
    { issues: [["value.invalid_email"]] },
    { issues: [["value.invalid_email"]] },
  ]
);
add(
  "an email address is not trimmed unless asked",
  () => check(v.string().email(), " ada@example.com"),
  { issues: [["value.invalid_email"]] }
);

// Presence: left out, null, default

add("a required value can't be left out", () => check(v.string()), {
  issues: [["value.required"]],
});
add(
  "an optional value may be left out but not null",
  () =>
    [undefined, "a", null].map((value) => check(v.string().optional(), value)),
  [{}, { value: "a" }, { issues: [["value.invalid_type"]] }]
);
add(
  "a nullable value may be null but not left out",
  () =>
    [null, "a", undefined].map((value) => check(v.string().nullable(), value)),
  [{ value: null }, { value: "a" }, { issues: [["value.required"]] }]
);
add(
  "a required nullable field still needs its key",
  () => {
    const schema = v.object({ note: v.string().nullable() });
    return [check(schema, { note: null }), check(schema, {})];
  },
  [{ value: { note: null } }, { issues: [["value.required", "note"]] }]
);
add(
  "an optional field left out stays out of the result",
  () => {
    const schema = v.object({ note: v.string().optional() });
    return [
      check(schema, {}),
      check(schema, { note: undefined }),
      check(schema, { note: "a" }),
    ];
  },
  [{ value: {} }, { value: {} }, { value: { note: "a" } }]
);
add(
  "null skips the constraints of a nullable value",
  () => [
    check(v.string().min(5).nullable(), null),
    check(v.number().min(5).nullable(), null),
    check(v.array(v.string()).min(1).nullable(), null),
    check(v.string().min(5).nullable(), "a"),
  ],
  [
    { value: null },
    { value: null },
    { value: null },
    { issues: [["value.too_short"]] },
  ]
);
add(
  "a default stands in only for a value left out",
  () => {
    const schema = v.object({
      text: v.string().default("x"),
      count: v.number().default(7),
      done: v.boolean().default(true),
    });
    return [
      check(schema, {}),
      check(schema, { text: undefined, count: undefined, done: undefined }),
      check(schema, { text: "", count: 0, done: false }),
      check(schema, { text: null }),
    ];
  },
  [
    { value: { text: "x", count: 7, done: true } },
    { value: { text: "x", count: 7, done: true } },
    { value: { text: "", count: 0, done: false } },
    { issues: [["value.invalid_type", "text"]] },
  ]
);
add(
  "a nullable default keeps null as null",
  () => {
    const schema = v.string().nullable().default("x");
    return [check(schema, null), check(schema)];
  },
  [{ value: null }, { value: "x" }]
);
add(
  "a default at the top level",
  () => check(v.array(v.string()).default([])),
  { value: [] }
);
add(
  "a value is optional or has a default, never both, in either order",
  () => [
    declare(() => v.string().optional().default("x")),
    declare(() => v.string().default("x").optional()),
    declare(() => v.string().min(1).optional().trim().default("x")),
  ],
  [
    "definition.default_with_optional",
    "definition.default_with_optional",
    "definition.default_with_optional",
  ]
);
add(
  "a default its schema refuses is refused, whichever came first",
  () => [
    declare(() => v.string().min(3).default("ab")),
    declare(() => v.string().default("ab").min(3)),
    declare(() => v.number().default(1.5).integer()),
    declare(() => v.number().integer().default(1.5)),
    declare(() => v.string().default("x").email()),
    declare(() => v.array(v.string()).default([]).min(1)),
    // @ts-expect-error -- null is not a string
    declare(() => v.string().default(null)),
    // @ts-expect-error -- a default needs a value
    declare(() => v.string().default()),
    declare(() => v.object({ a: v.string() }).default({ a: "x" })),
  ],
  [
    "definition.invalid_default",
    "definition.invalid_default",
    "definition.invalid_default",
    "definition.invalid_default",
    "definition.invalid_default",
    "definition.invalid_default",
    "definition.invalid_default",
    "definition.invalid_default",
    "declared",
  ]
);
add(
  "a default that isn't JSON is refused",
  () => [
    declare(() => v.number().default(Number.NaN)),
    declare(() => v.number().default(Infinity)),
    // @ts-expect-error -- a date is not JSON
    declare(() => v.record(v.string()).default(new Date(0))),
    // @ts-expect-error -- a function is not JSON
    declare(() => v.record(v.string()).default(() => "x")),
    // @ts-expect-error -- a map is not JSON
    declare(() => v.record(v.string()).default(new Map())),
  ],
  [
    "definition.invalid_default",
    "definition.invalid_default",
    "definition.invalid_default",
    "definition.invalid_default",
    "definition.invalid_default",
  ]
);
add(
  "a default is normalized like any value, whenever the trim was added",
  () => [
    v.string().trim().default("  a  ").descriptor.defaultValue,
    v.string().default("  a  ").trim().descriptor.defaultValue,
    v.object({ n: v.number().default(1) }).default({}).descriptor.defaultValue,
  ],
  ["a", "a", { n: 1 }]
);
add(
  "a default is copied in: changing what was passed changes nothing",
  () => {
    const tags = ["a"];
    const schema = v.array(v.string()).default(tags);
    tags.push("b");
    return [check(schema), Object.isFrozen(schema.descriptor.defaultValue)];
  },
  [{ value: ["a"] }, true]
);
add(
  "each result gets its own copy of a default",
  () => {
    const schema = v.object({
      tags: v.array(v.string()).default(["a"]),
      meta: v.record(v.array(v.number())).default({ n: [1] }),
    });
    const first = schema["~standard"].validate({});
    const second = schema["~standard"].validate({});
    if (first.issues !== undefined || second.issues !== undefined) {
      return "invalid";
    }
    first.value.tags.push("changed");
    first.value.meta.n?.push(2);
    return {
      second: second.value,
      shared:
        first.value.tags === second.value.tags ||
        first.value.meta === second.value.meta,
      third: check(schema, {}),
    };
  },
  {
    second: { tags: ["a"], meta: { n: [1] } },
    shared: false,
    third: { value: { tags: ["a"], meta: { n: [1] } } },
  }
);
add(
  "a result never shares an array or an object with what was checked",
  () => {
    const input = { list: [{ n: 1 }], map: { a: [1] } };
    const schema = v.object({
      list: v.array(v.object({ n: v.number() })),
      map: v.record(v.array(v.number())),
    });
    const result = schema["~standard"].validate(input);
    if (result.issues !== undefined) {
      return "invalid";
    }
    return (
      Object.is(result.value, input) ||
      result.value.list === input.list ||
      result.value.list[0] === input.list[0] ||
      result.value.map === input.map ||
      result.value.map.a === input.map.a
    );
  },
  false
);

// Bounds

add(
  "of bounds set twice, the strongest holds",
  () => {
    const text = v
      .string()
      .min(2)
      .min(5)
      .min(3)
      .max(10)
      .max(7)
      .max(9).descriptor;
    const list = v.array(v.string()).max(3).max(5).min(1).min(0).descriptor;
    const amount = v.number().min(-1).min(-5).max(4.5).max(8).descriptor;
    return [text, list, amount].map((descriptor) =>
      "min" in descriptor ? [descriptor.min, descriptor.max] : []
    );
  },
  [
    [5, 7],
    [1, 3],
    [-1, 4.5],
  ]
);
add(
  "bounds no value could pass are refused, in either order",
  () => [
    declare(() => v.string().min(5).max(4)),
    declare(() => v.string().max(4).min(5)),
    declare(() => v.number().max(0).min(1)),
    declare(() => v.array(v.string()).min(3).max(2)),
    declare(() => v.string().min(4).max(4)),
  ],
  [
    "definition.contradictory_bounds",
    "definition.contradictory_bounds",
    "definition.contradictory_bounds",
    "definition.contradictory_bounds",
    "declared",
  ]
);
add(
  "a bound that isn't one is refused",
  () => [
    declare(() => v.string().min(-1)),
    declare(() => v.string().max(1.5)),
    declare(() => v.string().max(Number.NaN)),
    declare(() => v.array(v.string()).max(-1)),
    declare(() => v.array(v.string()).min(2 ** 53)),
    declare(() => v.number().min(Number.NaN)),
    declare(() => v.number().max(Infinity)),
    // @ts-expect-error -- a bound is a number
    declare(() => v.number().min("1")),
    declare(() => v.number().min(-1.5).max(1.5)),
  ],
  [
    "definition.invalid_bound",
    "definition.invalid_bound",
    "definition.invalid_bound",
    "definition.invalid_bound",
    "definition.invalid_bound",
    "definition.invalid_bound",
    "definition.invalid_bound",
    "definition.invalid_bound",
    "declared",
  ]
);
add(
  "a bound that isn't a number is refused, whatever was set before",
  () => [
    // @ts-expect-error -- a bound needs a limit
    declare(() => v.string().max()),
    // @ts-expect-error -- a bound needs a limit
    declare(() => v.number().min()),
    // @ts-expect-error -- a bound needs a limit
    declare(() => v.array(v.string()).min()),
    // @ts-expect-error -- null is not a number
    declare(() => v.string().max(null)),
    // @ts-expect-error -- null is not a number
    declare(() => v.string().max(5).max(null)),
    // @ts-expect-error -- a bound is a number
    declare(() => v.string().max("3")),
    // @ts-expect-error -- a bound is a number
    declare(() => v.string().max(5).max("3")),
    // @ts-expect-error -- a bound is a number
    declare(() => v.number().min(1).min("3")),
    // @ts-expect-error -- a bound is a number
    declare(() => v.array(v.string()).min(1).min([2])),
  ],
  Array.from({ length: 9 }, () => "definition.invalid_bound")
);
add(
  "a literal normalizes to the value that was declared",
  () => {
    const result = v.literal(0)["~standard"].validate(-0);
    return result.issues === undefined && Object.is(result.value, 0);
  },
  true
);
add(
  "a kind without a constraint has no modifier for it",
  () =>
    [
      v.boolean(),
      v.timestamp(),
      v.money(),
      v.id("notes"),
      note,
      v.record(v.string()),
    ].flatMap((schema) =>
      ["min", "max", "trim", "email", "integer"].filter(
        (name) => name in schema
      )
    ),
  []
);

// The same meaning is the same descriptor

add(
  "modifier order doesn't change a descriptor",
  () => {
    const texts = [
      v.string().trim().min(1).max(9).email().nullable().default("a@b.co"),
      v.string().default("a@b.co").nullable().email().max(9).min(1).trim(),
      v.string().max(9).nullable().trim().default("a@b.co").min(1).email(),
      v
        .string()
        .min(0)
        .max(20)
        .min(1)
        .max(9)
        .email()
        .trim()
        .trim()
        .nullable()
        .default("x@y.zz")
        .default("a@b.co"),
    ].map((schema) => JSON.stringify(schema.descriptor));
    const numbers = [
      v.number().integer().min(1).max(5).optional(),
      v.number().optional().max(5).min(1).integer(),
    ].map((schema) => JSON.stringify(schema.descriptor));
    return [new Set(texts).size, new Set(numbers).size];
  },
  [1, 1]
);
add(
  "equivalent descriptors give the same outcomes",
  () => {
    const one = v.string().trim().min(2).nullable().default("ab");
    const other = v.string().default("ab").nullable().min(2).trim();
    const values = [undefined, null, "  ab ", " a ", 4];
    return (
      JSON.stringify(values.map((value) => check(one, value))) ===
      JSON.stringify(values.map((value) => check(other, value)))
    );
  },
  true
);
add(
  "a descriptor states everything, and is frozen all the way down",
  () => {
    const { descriptor } = v.object({
      title: v.string().trim().min(1).max(200),
      tags: v
        .array(v.enum(["a", "b"]))
        .max(3)
        .default(["a"]),
      owner: v.id("people").nullable().optional(),
    });
    return { descriptor, frozen: deeplyFrozen(descriptor) };
  },
  {
    descriptor: {
      ...base,
      kind: "object",
      fields: {
        title: {
          ...base,
          kind: "string",
          trim: true,
          email: false,
          min: 1,
          max: 200,
        },
        tags: {
          descriptorVersion: 1,
          nullable: false,
          presence: "default",
          defaultValue: ["a"],
          kind: "array",
          item: { ...base, kind: "enum", values: ["a", "b"] },
          max: 3,
        },
        owner: {
          descriptorVersion: 1,
          nullable: true,
          presence: "optional",
          kind: "id",
          tableName: "people",
        },
      },
    },
    frozen: true,
  }
);
add(
  "a modifier returns a new schema and leaves the one it came from alone",
  () => {
    const text = v.string();
    const bounded = text.min(1);
    return [text === bounded, check(text, ""), check(bounded, "")];
  },
  [false, { value: "" }, { issues: [["value.too_short"]] }]
);

// Objects

add(
  "an object refuses a key that isn't declared",
  () => check(note, { title: "a", extra: 1, other: 2 }),
  {
    issues: [
      ["value.unknown_key", "extra"],
      ["value.unknown_key", "other"],
    ],
  }
);
add(
  "a nested object refuses one too, with the path to it",
  () =>
    check(v.object({ notes: v.array(note) }), {
      notes: [{ title: "a" }, { title: "b", extra: 1 }],
    }),
  { issues: [["value.unknown_key", "notes", 1, "extra"]] }
);
add(
  "a key too long to repeat is reported without its name",
  () => check(note, { title: "a", ["k".repeat(300)]: 1 }),
  { issues: [["value.unknown_key"]] }
);
add(
  "a prototype key in what is checked is refused, not followed",
  () => [
    check(note, JSON.parse('{"title":"a","__proto__":{"body":"x"}}')),
    check(note, JSON.parse('{"title":"a","constructor":1}')),
    // Nothing reached the prototype every object shares.
    "body" in {},
  ],
  [
    { issues: [["value.unknown_key", "__proto__"]] },
    { issues: [["value.unknown_key", "constructor"]] },
    false,
  ]
);
add(
  "an object is a plain JSON object",
  () =>
    [
      [],
      new Date(0),
      new Map(),
      () => 1,
      "a",
      Object.create({ title: "a" }),
    ].map((value) => check(v.object({ title: v.string().optional() }), value)),
  [
    { issues: [["value.invalid_type"]] },
    { issues: [["value.invalid_type"]] },
    { issues: [["value.invalid_type"]] },
    { issues: [["value.invalid_type"]] },
    { issues: [["value.invalid_type"]] },
    { issues: [["value.invalid_type"]] },
  ]
);
add(
  "a field named like an inherited method is absent when it is left out",
  () => {
    const schema = v.object({
      toString: v.string().optional(),
      valueOf: v.number().default(1),
      hasOwnProperty: v.boolean(),
    });
    return [
      check(schema, { hasOwnProperty: true }),
      check(schema, {}),
      check(v.record(v.string()), { toString: "a" }),
    ];
  },
  [
    { value: { valueOf: 1, hasOwnProperty: true } },
    { issues: [["value.required", "hasOwnProperty"]] },
    { value: { toString: "a" } },
  ]
);
add(
  "an object without a prototype is one too",
  () =>
    check(
      v.object({ title: v.string() }),
      Object.assign(Object.create(null), { title: "a" })
    ),
  { value: { title: "a" } }
);
add(
  "a field's name can't be a prototype key",
  () => [
    declare(() => v.object({ ["__proto__"]: v.string() })),
    declare(() => v.object({ constructor: v.string() })),
    declare(() => v.object({ prototype: v.string() })),
    declare(() => v.object({ "": v.string() })),
    declare(() => v.object({ ["k".repeat(257)]: v.string() })),
    declare(() => note.extend({ ["__proto__"]: v.string() })),
  ],
  [
    "definition.invalid_key",
    "definition.invalid_key",
    "definition.invalid_key",
    "definition.invalid_key",
    "definition.invalid_key",
    "definition.invalid_key",
  ]
);
add(
  "an object is built from v schemas only",
  () => [
    // @ts-expect-error -- a field is a schema
    declare(() => v.object({ title: "string" })),
    // @ts-expect-error -- a field is a schema
    declare(() => v.object({ title: lookalike })),
    // @ts-expect-error -- a shape is an object
    declare(() => v.object(null)),
    // @ts-expect-error -- an item is a schema
    declare(() => v.array()),
  ],
  [
    "definition.invalid_schema",
    "definition.invalid_schema",
    "definition.invalid_schema",
    "definition.invalid_schema",
  ]
);
add(
  "shape is the fields as declared, frozen",
  () => [
    Object.keys(note.shape),
    note.shape.title === noteFields.title,
    Object.isFrozen(note.shape),
    check(note.shape.title, "  a "),
  ],
  [["title", "body"], true, true, { value: "a" }]
);
add(
  "a shape is shared by spreading it",
  () =>
    check(v.object({ ...noteFields, pinned: v.boolean() }), {
      title: "a",
      pinned: true,
    }),
  { value: { title: "a", body: "", pinned: true } }
);
add(
  "pick keeps the named fields, strictly",
  () => {
    const picked = note.pick(["title"]);
    return [
      Object.keys(picked.shape),
      check(picked, { title: " a " }),
      check(picked, { title: "a", body: "b" }),
    ];
  },
  [
    ["title"],
    { value: { title: "a" } },
    { issues: [["value.unknown_key", "body"]] },
  ]
);
add(
  "omit drops the named fields, strictly",
  () => {
    const omitted = note.omit(["title"]);
    return [
      Object.keys(omitted.shape),
      check(omitted, {}),
      check(omitted, { title: "a" }),
    ];
  },
  [
    ["body"],
    { value: { body: "" } },
    { issues: [["value.unknown_key", "title"]] },
  ]
);
add(
  "pick and omit take only keys the object has, each once",
  () => [
    // @ts-expect-error -- not a field
    declare(() => note.pick(["missing"])),
    // @ts-expect-error -- not a field
    declare(() => note.omit(["missing"])),
    declare(() => note.pick(["title", "title"])),
    declare(() => note.omit(["body", "body"])),
    // @ts-expect-error -- not a field
    declare(() => note.pick(["toString"])),
    // @ts-expect-error -- the keys are a list
    declare(() => note.pick("title")),
  ],
  [
    "definition.invalid_key",
    "definition.invalid_key",
    "definition.invalid_key",
    "definition.invalid_key",
    "definition.invalid_key",
    "definition.invalid_key",
  ]
);
add(
  "pick gives the same object whatever order the keys came in",
  () =>
    JSON.stringify(note.pick(["title", "body"]).descriptor) ===
    JSON.stringify(note.pick(["body", "title"]).descriptor),
  true
);
add(
  "extend adds fields",
  () => {
    const extended = note.extend({ pinned: v.boolean().default(false) });
    return [
      Object.keys(extended.shape),
      check(extended, { title: "a" }),
      Object.keys(note.shape),
    ];
  },
  [
    ["title", "body", "pinned"],
    { value: { title: "a", body: "", pinned: false } },
    ["title", "body"],
  ]
);
add(
  "extend can't replace a field",
  // @ts-expect-error -- title is already a field
  () => declare(() => note.extend({ title: v.number() })),
  "definition.invalid_key"
);
add(
  "partial makes every field optional and never fills a default",
  () => {
    const patch = note.partial();
    return [
      check(patch, {}),
      check(patch, { body: undefined }),
      check(patch, { title: "  b " }),
      check(patch, { title: "" }),
      check(patch, { body: null }),
      check(patch, { extra: 1 }),
      patch.descriptor.kind === "object" && patch.descriptor.fields.body,
    ];
  },
  [
    { value: {} },
    { value: {} },
    { value: { title: "b" } },
    { issues: [["value.too_short", "title"]] },
    { issues: [["value.invalid_type", "body"]] },
    { issues: [["value.unknown_key", "extra"]] },
    {
      descriptorVersion: 1,
      nullable: false,
      presence: "optional",
      kind: "string",
      trim: false,
      email: false,
      max: 100_000,
    },
  ]
);
add(
  "partial is shallow, and keeps null where it was allowed",
  () => {
    const patch = v
      .object({
        owner: v.string().nullable(),
        address: v.object({
          city: v.string(),
          zip: v.string().default("0000"),
        }),
      })
      .partial();
    return [
      check(patch, { owner: null }),
      check(patch, { address: {} }),
      check(patch, { address: { city: "Delft" } }),
    ];
  },
  [
    { value: { owner: null } },
    { issues: [["value.required", "address", "city"]] },
    { value: { address: { city: "Delft", zip: "0000" } } },
  ]
);
add(
  "an object made from another is a plain required one",
  () => {
    const loose = note.nullable().optional();
    return [
      loose.pick(["title"]),
      loose.omit(["title"]),
      loose.partial(),
      loose.extend({}),
    ].map((schema) => [schema.descriptor.presence, schema.descriptor.nullable]);
  },
  [
    ["required", false],
    ["required", false],
    ["required", false],
    ["required", false],
  ]
);

// Arrays, records, unions

add(
  "an array normalizes each item",
  () => check(v.array(v.string().trim()), [" a ", "b "]),
  { value: ["a", "b"] }
);
add(
  "an array reports each item that is wrong, by index",
  () => check(v.array(v.number()), [1, "2", 3, null]),
  {
    issues: [
      ["value.invalid_type", 1],
      ["value.invalid_type", 3],
    ],
  }
);
add(
  "an array has no holes and no undefined items",
  () => [
    // oxlint-disable-next-line no-sparse-arrays -- a hole is the case
    check(v.array(v.number()), [1, , 3]),
    check(v.array(v.number()), [undefined]),
  ],
  [{ issues: [["value.required", 1]] }, { issues: [["value.required", 0]] }]
);
add(
  "an array within its bounds",
  () =>
    [[], ["a"], ["a", "b", "c"]].map((value) =>
      check(v.array(v.string()).min(1).max(2), value)
    ),
  [
    { issues: [["value.too_short"]] },
    { value: ["a"] },
    { issues: [["value.too_long"]] },
  ]
);
add(
  "an array is an array",
  () =>
    [{ 0: "a", length: 1 }, "ab", new Set(["a"])].map((value) =>
      check(v.array(v.string()), value)
    ),
  [
    { issues: [["value.invalid_type"]] },
    { issues: [["value.invalid_type"]] },
    { issues: [["value.invalid_type"]] },
  ]
);
add(
  "an item, a record value and a union member stand for one value each",
  () => [
    declare(() => v.array(v.string().optional())),
    declare(() => v.array(v.string().default("x"))),
    declare(() => v.record(v.string().optional())),
    declare(() => v.union(v.string(), v.number().optional())),
    declare(() => v.array(v.string().nullable())),
  ],
  [
    "definition.invalid_schema",
    "definition.invalid_schema",
    "definition.invalid_schema",
    "definition.invalid_schema",
    "declared",
  ]
);
add(
  "a record has string keys and one schema for every value",
  () => [
    check(v.record(v.number()), { a: 1, b: 2 }),
    check(v.record(v.number()), {}),
    check(v.record(v.number()), { a: 1, b: "2" }),
    check(v.record(v.string().trim()), { a: " x " }),
    check(v.record(v.number()), [1]),
  ],
  [
    { value: { a: 1, b: 2 } },
    { value: {} },
    { issues: [["value.invalid_type", "b"]] },
    { value: { a: "x" } },
    { issues: [["value.invalid_type"]] },
  ]
);
add(
  "a record refuses a prototype key and a key too long",
  () => [
    check(v.record(v.number()), JSON.parse('{"a":1,"__proto__":2}')),
    check(v.record(v.number()), { constructor: 1 }),
    check(v.record(v.number()), { prototype: 1 }),
    check(v.record(v.number()), { ["k".repeat(257)]: 1 }),
    check(v.record(v.number()), { ["k".repeat(256)]: 1 }),
  ],
  [
    { issues: [["value.unsafe_key", "__proto__"]] },
    { issues: [["value.unsafe_key", "constructor"]] },
    { issues: [["value.unsafe_key", "prototype"]] },
    // At the record: a path never repeats a key of any length.
    { issues: [["value.key_too_long"]] },
    { value: { ["k".repeat(256)]: 1 } },
  ]
);
add(
  "a union takes the first member the value fits",
  () => {
    const schema = v.union(
      v.string().trim().min(1),
      v.number(),
      v.object({ kind: v.literal("a"), n: v.number().default(1) }),
      v.object({ kind: v.literal("b") })
    );
    return [" a ", 2, { kind: "a" }, { kind: "b" }].map((value) =>
      check(schema, value)
    );
  },
  [
    { value: "a" },
    { value: 2 },
    { value: { kind: "a", n: 1 } },
    { value: { kind: "b" } },
  ]
);
add(
  "a value that fits no member is one issue, at the union",
  () => {
    const schema = v.object({
      choice: v.union(
        v.string().min(3),
        v.number(),
        v.object({ a: v.string() })
      ),
    });
    return [
      check(schema, { choice: "ab" }),
      check(schema, { choice: { a: 1, b: 2, c: 3 } }),
      check(schema, { choice: null }),
      check(schema, {}),
    ];
  },
  [
    { issues: [["value.no_union_match", "choice"]] },
    { issues: [["value.no_union_match", "choice"]] },
    { issues: [["value.no_union_match", "choice"]] },
    { issues: [["value.required", "choice"]] },
  ]
);
add(
  "a union can be nullable, optional or have a default",
  () => {
    const schema = v.union(v.string(), v.number());
    return [
      check(schema.nullable(), null),
      check(schema.optional()),
      check(schema.default(3)),
      // @ts-expect-error -- a boolean is in neither member
      declare(() => schema.default(true)),
    ];
  },
  [{ value: null }, {}, { value: 3 }, "definition.invalid_default"]
);
add(
  "a union is bounded",
  () => {
    const members = Array.from({ length: 65 }, (_, index) => v.literal(index));
    const [first = v.literal(0), ...rest] = members;
    return [
      declare(() => v.union(first, ...rest.slice(0, 63))),
      declare(() => v.union(first, ...rest)),
      // @ts-expect-error -- a union has a member
      declare(() => v.union()),
    ];
  },
  ["declared", "definition.invalid_schema", "definition.invalid_schema"]
);
add(
  "issues after a union that didn't fit are still reported",
  () =>
    check(v.object({ a: v.union(v.string(), v.number()), b: v.string() }), {
      a: true,
      b: 1,
    }),
  {
    issues: [
      ["value.no_union_match", "a"],
      ["value.invalid_type", "b"],
    ],
  }
);

// IDs and the values with one fixed form

add(
  "a record ID is a UUIDv7 in lower case, kept as it was",
  () =>
    [
      recordId,
      recordId.toUpperCase(),
      "0192f0c1-7c3e-4abc-8def-0123456789ab",
      "0192f0c1-7c3e-7abc-cdef-0123456789ab",
      `${recordId} `,
      `${recordId}\n`,
      "../notes/1",
      "notes; drop table",
      "",
      17,
    ].map((value) => check(v.id("notes"), value)),
  [
    { value: recordId },
    { issues: [["value.invalid_id"]] },
    { issues: [["value.invalid_id"]] },
    { issues: [["value.invalid_id"]] },
    { issues: [["value.invalid_id"]] },
    { issues: [["value.invalid_id"]] },
    { issues: [["value.invalid_id"]] },
    { issues: [["value.invalid_id"]] },
    { issues: [["value.invalid_id"]] },
    { issues: [["value.invalid_id"]] },
  ]
);
add(
  "an ID names a table by a safe name",
  () =>
    [
      "notes",
      "note_items2",
      "",
      "1notes",
      "notes; drop",
      "../notes",
      "__proto__",
      "n".repeat(65),
    ].map((name) => declare(() => v.id(name))),
  [
    "declared",
    "declared",
    "definition.invalid_name",
    "definition.invalid_name",
    "definition.invalid_name",
    "definition.invalid_name",
    "definition.invalid_name",
    "definition.invalid_name",
  ]
);
add(
  "a timestamp is whole milliseconds",
  () =>
    [1_760_000_000_000, 0, -1, 1.5, 2 ** 53, "2026-10-06", Number.NaN].map(
      (value) => check(v.timestamp(), value)
    ),
  [
    { value: 1_760_000_000_000 },
    { value: 0 },
    { value: -1 },
    { issues: [["value.invalid_timestamp"]] },
    { issues: [["value.invalid_timestamp"]] },
    { issues: [["value.invalid_type"]] },
    { issues: [["value.invalid_timestamp"]] },
  ]
);
add(
  "a duration is whole milliseconds above zero",
  () =>
    [1, 60_000, 0, -5, 1.5, 2 ** 53, "1m"].map((value) =>
      check(v.duration(), value)
    ),
  [
    { value: 1 },
    { value: 60_000 },
    { issues: [["value.invalid_duration"]] },
    { issues: [["value.invalid_duration"]] },
    { issues: [["value.invalid_duration"]] },
    { issues: [["value.invalid_duration"]] },
    { issues: [["value.invalid_type"]] },
  ]
);
add(
  "a file is a reference and nothing more",
  () =>
    [
      { id: "file_01" },
      { id: "file_01", name: "a.pdf" },
      { id: "" },
      { id: "a b" },
      { id: "a\u0000b" },
      { id: "f".repeat(257) },
      {},
      "file_01",
    ].map((value) => check(v.file(), value)),
  [
    { value: { id: "file_01" } },
    { issues: [["value.unknown_key", "name"]] },
    { issues: [["value.invalid_reference", "id"]] },
    { issues: [["value.invalid_reference", "id"]] },
    { issues: [["value.invalid_reference", "id"]] },
    { issues: [["value.invalid_reference", "id"]] },
    { issues: [["value.required", "id"]] },
    { issues: [["value.invalid_type"]] },
  ]
);
add(
  "money is whole minor units of an ISO 4217 currency",
  () =>
    [
      { minorUnits: 1250, currency: "EUR" },
      { minorUnits: -1250, currency: "USD" },
      { minorUnits: 12.5, currency: "EUR" },
      { minorUnits: 2 ** 53, currency: "EUR" },
      { minorUnits: 1, currency: "eur" },
      { minorUnits: 1, currency: "EURO" },
      { minorUnits: 1, currency: "XYZ" },
      { minorUnits: "1", currency: "EUR" },
      { minorUnits: 1 },
      { minorUnits: 1, currency: "EUR", amount: 1 },
      1250,
    ].map((value) => check(v.money(), value)),
  [
    { value: { minorUnits: 1250, currency: "EUR" } },
    { value: { minorUnits: -1250, currency: "USD" } },
    { issues: [["value.not_integer", "minorUnits"]] },
    { issues: [["value.not_integer", "minorUnits"]] },
    { issues: [["value.invalid_currency", "currency"]] },
    { issues: [["value.invalid_currency", "currency"]] },
    { issues: [["value.invalid_currency", "currency"]] },
    { issues: [["value.invalid_type", "minorUnits"]] },
    { issues: [["value.required", "currency"]] },
    { issues: [["value.unknown_key", "amount"]] },
    { issues: [["value.invalid_type"]] },
  ]
);
add(
  "a person, a model and a template are opaque references",
  () =>
    [v.person(), v.model(), v.template()].map((schema) =>
      ["team:finance", "workers-ai/@cf/meta/llama-3.3", "", "a b", "é", 5].map(
        (value) => check(schema, value)
      )
    ),
  Array.from({ length: 3 }, () => [
    { value: "team:finance" },
    { value: "workers-ai/@cf/meta/llama-3.3" },
    { issues: [["value.invalid_reference"]] },
    { issues: [["value.invalid_reference"]] },
    { issues: [["value.invalid_reference"]] },
    { issues: [["value.invalid_type"]] },
  ])
);
add(
  "a schedule is five cron fields in an IANA time zone",
  () =>
    [
      { cron: "0 8 * * 1", timeZone: "Europe/Amsterdam" },
      { cron: "0 8 * * 1", timeZone: "Asia/Kolkata" },
      { cron: "0 8 * * 1", timeZone: "Asia/Calcutta" },
      ...acceptedCrons.map((cron) => ({ cron, timeZone: "UTC" })),
      ...refusedCrons.map((cron) => ({ cron, timeZone: "UTC" })),
      { cron: "0 8 * * 1", timeZone: "Europe/Delft" },
      { cron: "0 8 * * 1", timeZone: "europe/amsterdam" },
      { cron: "0 8 * * 1", timeZone: "+02:00" },
      { cron: "0 8 * * 1" },
      "0 8 * * 1",
    ].map((value) => check(v.schedule(), value)),
  [
    { value: { cron: "0 8 * * 1", timeZone: "Europe/Amsterdam" } },
    { value: { cron: "0 8 * * 1", timeZone: "Asia/Kolkata" } },
    { value: { cron: "0 8 * * 1", timeZone: "Asia/Calcutta" } },
    ...acceptedCrons.map((cron) => ({ value: { cron, timeZone: "UTC" } })),
    ...refusedCrons.map(() => ({ issues: [["value.invalid_cron", "cron"]] })),
    { issues: [["value.invalid_time_zone", "timeZone"]] },
    { issues: [["value.invalid_time_zone", "timeZone"]] },
    { issues: [["value.invalid_time_zone", "timeZone"]] },
    { issues: [["value.required", "timeZone"]] },
    { issues: [["value.invalid_type"]] },
  ]
);
add(
  "the fixed forms take the same modifiers as any value",
  () => [
    check(v.money().nullable(), null),
    check(v.timestamp().optional()),
    check(v.duration().default(1000)),
    check(v.file().default({ id: "f1" })),
    declare(() => v.money().default({ minorUnits: 1, currency: "XYZ" })),
  ],
  [
    { value: null },
    {},
    { value: 1000 },
    { value: { id: "f1" } },
    "definition.invalid_default",
  ]
);

// Limits

add(
  "at most 50 issues are reported",
  () => {
    const schema = v.array(v.number());
    const wrong = Array.from({ length: 80 }, () => "x");
    return schema["~standard"].validate(wrong).issues?.length;
  },
  50
);
add(
  "the issue limit holds across unknown keys too",
  () => {
    const value = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`k${index}`, 1])
    );
    return v.object({})["~standard"].validate(value).issues?.length;
  },
  50
);
add(
  "a value with more to read than a check allows is refused whole",
  () =>
    check(
      v.array(v.number()),
      Array.from({ length: 1_000_001 }, () => 0)
    ),
  { issues: [["value.too_complex"]] }
);
add(
  "a union can't multiply the work past the limit",
  () => {
    const row = v.array(v.string());
    const schema = v.union(
      v.array(row.max(1)),
      v.array(row.max(2)),
      v.array(row.max(3)),
      v.array(row)
    );
    const value = Array.from({ length: 300_000 }, () => ["a", "b", "c", "d"]);
    return check(schema, value);
  },
  { issues: [["value.too_complex"]] }
);
add(
  "an array longer than its maximum is refused before it is read",
  () => {
    let read = 0;
    const value = new Proxy(
      Array.from({ length: 100 }, () => "a"),
      {
        get: (target, key, receiver) => {
          if (typeof key === "string" && /^\d+$/u.test(key)) {
            read += 1;
          }
          const entry: unknown = Reflect.get(target, key, receiver);
          return entry;
        },
      }
    );
    return [check(v.array(v.string()).max(10), value), read];
  },
  [{ issues: [["value.too_long"]] }, 0]
);
add(
  "an array that reports another length later can't get past its maximum",
  () => {
    let asked = 0;
    const value = new Proxy(
      Array.from({ length: 100 }, () => "a"),
      {
        get: (target, key, receiver) => {
          if (key === "length") {
            asked += 1;
            return asked === 1 ? 2 : 100;
          }
          const entry: unknown = Reflect.get(target, key, receiver);
          return entry;
        },
      }
    );
    return check(v.array(v.string()).max(10), value);
  },
  { value: ["a", "a"] }
);
add(
  "a value that refers to itself is refused, not followed",
  () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const list: unknown[] = [];
    list.push(list);
    return [
      check(v.record(v.record(v.record(v.number()))), loop),
      check(v.array(v.array(v.string())), list),
    ];
  },
  [
    { issues: [["value.invalid_type", "self", "self", "self"]] },
    { issues: [["value.invalid_type", 0, 0]] },
  ]
);
add(
  "a value that runs code when read is refused, not thrown",
  () => [check(v.record(v.number()), unreadable()), check(note, unreadable())],
  [{ issues: [["value.unreadable"]] }, { issues: [["value.unreadable"]] }]
);
add(
  "a capability is not a value",
  () => {
    const stub = new Proxy(() => 1, {});
    return [
      check(v.record(v.string()), stub),
      check(v.object({}), stub),
      check(v.string(), Symbol("a")),
    ];
  },
  [
    { issues: [["value.invalid_type"]] },
    { issues: [["value.invalid_type"]] },
    { issues: [["value.invalid_type"]] },
  ]
);
add(
  "a schema nests at most 32 deep",
  () => [declare(() => nestedSchema(32)), declare(() => nestedSchema(33))],
  ["declared", "definition.too_large"]
);
add(
  "a schema declares at most 10 000 descriptors",
  () => [declare(() => wideSchema(9999)), declare(() => wideSchema(10_000))],
  ["declared", "definition.too_large"]
);

// Descriptors as data

add(
  "a descriptor survives JSON and gives the same schema back",
  () => {
    const schema = v.object({
      ...noteFields,
      tags: v
        .array(v.enum(["a", "b"]))
        .max(3)
        .default(["a"]),
      owner: v.id("people").nullable(),
      price: v.money().optional(),
      when: v.schedule().optional(),
      kind: v.union(v.literal("note"), v.literal(2), v.literal(null)),
      scores: v.record(v.number().integer().min(0)),
    });
    const rebuilt = schemaFromDescriptor(stored(schema));
    const values = [
      { title: " a ", owner: null, kind: "note", scores: { a: 1 } },
      { title: "a", owner: recordId, kind: null, scores: {}, tags: ["b"] },
      { title: "", owner: "x", kind: 3, scores: { a: -1 }, extra: 1 },
      {},
    ];
    return {
      sameDescriptor:
        JSON.stringify(rebuilt.descriptor) ===
        JSON.stringify(schema.descriptor),
      sameOutcomes:
        JSON.stringify(values.map((value) => check(rebuilt, value))) ===
        JSON.stringify(values.map((value) => check(schema, value))),
      first: check(rebuilt, values[0]),
      frozen: Object.isFrozen(rebuilt.descriptor),
    };
  },
  {
    sameDescriptor: true,
    sameOutcomes: true,
    first: {
      value: {
        title: "a",
        body: "",
        tags: ["a"],
        owner: null,
        kind: "note",
        scores: { a: 1 },
      },
    },
    frozen: true,
  }
);
add(
  "a schema read back is built from a copy, not from what was passed",
  () => {
    const descriptor = {
      ...base,
      kind: "string",
      trim: false,
      email: false,
      min: 1,
    };
    const schema = schemaFromDescriptor(descriptor);
    descriptor.min = 5;
    return [check(schema, "ab"), Object.is(schema.descriptor, descriptor)];
  },
  [{ value: "ab" }, false]
);
add(
  "a descriptor of an unknown version, kind or constraint is refused",
  () =>
    [
      { ...base, descriptorVersion: 2, kind: "boolean" },
      { nullable: false, presence: "required", kind: "boolean" },
      { ...base, kind: "any" },
      { ...base, kind: "bytes" },
      { ...base, kind: "vector", dimensions: 3 },
      { ...base, kind: "bigint" },
      { ...base, kind: "toString" },
      { ...base },
      { ...base, kind: "boolean", refine: "x" },
      { ...base, kind: "timestamp", min: 0 },
      { ...base, kind: "string", trim: false, email: false, pattern: "^a" },
      { ...base, kind: "object", fields: {}, passthrough: true },
      { ...base, kind: "boolean", presence: "sometimes" },
      { ...base, kind: "boolean", nullable: "yes" },
      { ...base, kind: "string", trim: "yes", email: false },
      { ...base, kind: "string", email: false },
      { ...base, kind: "number" },
    ].map((descriptor) => declare(() => schemaFromDescriptor(descriptor))),
  Array.from({ length: 17 }, () => "definition.invalid_descriptor")
);
add(
  "a descriptor that isn't a JSON object is refused",
  () =>
    [null, undefined, "string", 1, [], () => 1, new Map(), unreadable()].map(
      (descriptor) => declare(() => schemaFromDescriptor(descriptor))
    ),
  Array.from({ length: 8 }, () => "definition.invalid_descriptor")
);
add(
  "a descriptor is checked as strictly as a declaration",
  () =>
    [
      { ...base, kind: "string", trim: false, email: false, min: 5, max: 4 },
      { ...base, kind: "string", trim: false, email: false, min: -1 },
      { ...base, kind: "number", integer: false, max: "9" },
      { ...base, kind: "id", tableName: "../notes" },
      { ...base, kind: "enum", values: [] },
      { ...base, kind: "enum", values: ["a", "a"] },
      { ...base, kind: "literal", value: { a: 1 } },
      { ...base, kind: "literal" },
      {
        ...base,
        kind: "object",
        fields: fromJson(
          '{"__proto__":{"descriptorVersion":1,"nullable":false,"presence":"required","kind":"boolean"}}'
        ),
      },
      {
        ...base,
        kind: "object",
        fields: { constructor: { ...base, kind: "boolean" } },
      },
      {
        ...base,
        kind: "array",
        item: { ...base, presence: "optional", kind: "boolean" },
      },
      { ...base, kind: "union", members: [] },
      {
        ...base,
        presence: "default",
        kind: "number",
        integer: true,
        defaultValue: 1.5,
      },
      { ...base, presence: "default", kind: "number", integer: true },
      { ...base, kind: "number", integer: true, defaultValue: 1 },
    ].map((descriptor) => declare(() => schemaFromDescriptor(descriptor))),
  [
    "definition.contradictory_bounds",
    "definition.invalid_bound",
    "definition.invalid_bound",
    "definition.invalid_name",
    "definition.invalid_value",
    "definition.invalid_value",
    "definition.invalid_value",
    "definition.invalid_value",
    "definition.invalid_key",
    "definition.invalid_key",
    "definition.invalid_schema",
    "definition.invalid_schema",
    "definition.invalid_default",
    "definition.invalid_default",
    "definition.invalid_descriptor",
  ]
);
add(
  "a stored default is normalized again, and copied",
  () => {
    const defaultValue = ["  a  "];
    const schema = schemaFromDescriptor({
      ...base,
      presence: "default",
      kind: "array",
      item: { ...base, kind: "string", trim: true, email: false },
      defaultValue,
    });
    defaultValue.push("b");
    return [schema.descriptor.defaultValue, check(schema)];
  },
  [["a"], { value: ["a"] }]
);
add(
  "a descriptor that contains itself is refused, not followed",
  () => declare(() => schemaFromDescriptor(cyclicDescriptor())),
  "definition.too_large"
);
add(
  "a descriptor nested too deep is refused",
  () => [
    declare(() => schemaFromDescriptor(nestedDescriptor(32))),
    declare(() => schemaFromDescriptor(nestedDescriptor(33))),
    declare(() => schemaFromDescriptor(nestedDescriptor(5000))),
  ],
  ["declared", "definition.too_large", "definition.too_large"]
);
add(
  "a descriptor that declares too much is refused",
  () => [
    declare(() => schemaFromDescriptor(wideDescriptor(9999))),
    declare(() => schemaFromDescriptor(wideDescriptor(10_000))),
    declare(() =>
      schemaFromDescriptor({
        ...base,
        kind: "enum",
        values: Array.from({ length: 10_001 }, (_, index) => `v${index}`),
      })
    ),
    declare(() =>
      schemaFromDescriptor({
        ...base,
        kind: "union",
        members: Array.from({ length: 65 }, () => ({
          ...base,
          kind: "boolean",
        })),
      })
    ),
    declare(() =>
      schemaFromDescriptor({ ...base, kind: "literal", value: "x".repeat(257) })
    ),
  ],
  [
    "declared",
    "definition.too_large",
    "definition.invalid_value",
    "definition.invalid_descriptor",
    "definition.invalid_value",
  ]
);
add(
  "a descriptor that runs code when read is refused, and what it threw stays here",
  () => {
    const descriptor = {
      ...base,
      get kind(): string {
        throw new Error("secret");
      },
    };
    try {
      schemaFromDescriptor(descriptor);
      return "declared";
    } catch (error) {
      return error instanceof ValueDefinitionError
        ? [error.code, error.message.includes("secret")]
        : "threw";
    }
  },
  ["definition.invalid_descriptor", false]
);
add(
  "a definition error carries its code as its own property",
  () => {
    try {
      v.string().min(2).max(1);
      return "declared";
    } catch (error) {
      return error instanceof ValueDefinitionError && error instanceof Error
        ? {
            code: error.code,
            name: error.name,
            own: Object.hasOwn(error, "code"),
          }
        : "threw";
    }
  },
  {
    code: "definition.contradictory_bounds",
    name: "ValueDefinitionError",
    own: true,
  }
);

/** A case's outcome, as JSON text: the same text in every runtime. */
export interface ValueCaseOutcome {
  readonly actual: string;
  readonly expected: string;
  readonly name: string;
}

/**
 * Runs every case and returns what each gave beside what it should give,
 * both as JSON text so a browser can hand them to the test that drives it.
 */
export const runValueCases = (): ValueCaseOutcome[] =>
  cases.map(({ actual, expected, name }) => {
    let outcome: unknown = "threw";
    try {
      outcome = actual();
    } catch (error) {
      outcome = `threw: ${error instanceof Error ? error.message : "?"}`;
    }
    return {
      actual: JSON.stringify(outcome) ?? "undefined",
      expected: JSON.stringify(expected) ?? "undefined",
      name,
    };
  });

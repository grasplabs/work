// Compile-time guarantees of the SDK's values. This file is type-checked by
// `vp check` and never run: every `@ts-expect-error` below must stay an error.
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { expectTypeOf } from "vite-plus/test";

import { v } from "../src/values.ts";
import type {
  FileValue,
  Id,
  Infer,
  InferInput,
  MoneyValue,
  ScheduleValue,
  ValueIssue,
} from "../src/values.ts";

// A caller may leave out a field with a default; a handler always gets it.
const note = v.object({
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
});
expectTypeOf<InferInput<typeof note>>().toEqualTypeOf<{
  title: string;
  body?: string;
}>();
expectTypeOf<Infer<typeof note>>().toEqualTypeOf<{
  title: string;
  body: string;
}>();

const noteInput: InferInput<typeof note> = { title: "Launch" };
// @ts-expect-error -- the normalized value always has a body
const noteValue: Infer<typeof note> = { title: "Launch" };
// @ts-expect-error -- a caller can't leave out a required field
const noTitle: InferInput<typeof note> = { body: "" };
// @ts-expect-error -- a caller can't pass a key that isn't declared
const extraKey: InferInput<typeof note> = { title: "a", pinned: true };
// @ts-expect-error -- a default doesn't make null allowed
const nullBody: InferInput<typeof note> = { title: "a", body: null };
expectTypeOf(noteInput).not.toBeAny();
expectTypeOf([noteValue, noTitle, extraKey, nullBody]).not.toBeAny();

// Left out, null and filled in are three different things.
const presence = v.object({
  required: v.string(),
  optional: v.string().optional(),
  nullable: v.string().nullable(),
  nullableOptional: v.number().nullable().optional(),
  filled: v.number().default(0),
  nullableFilled: v.boolean().nullable().default(null),
});
expectTypeOf<InferInput<typeof presence>>().toEqualTypeOf<{
  required: string;
  nullable: string | null;
  optional?: string;
  nullableOptional?: number | null;
  filled?: number;
  nullableFilled?: boolean | null;
}>();
expectTypeOf<Infer<typeof presence>>().toEqualTypeOf<{
  required: string;
  nullable: string | null;
  filled: number;
  nullableFilled: boolean | null;
  optional?: string;
  nullableOptional?: number | null;
}>();
// @ts-expect-error -- a required nullable field still needs its key
const noNullable: InferInput<typeof presence> = { required: "a" };
expectTypeOf(noNullable).not.toBeAny();

// Every kind infers its own value, never `any`.
expectTypeOf<Infer<ReturnType<typeof v.string>>>().toEqualTypeOf<string>();
expectTypeOf<Infer<ReturnType<typeof v.number>>>().toEqualTypeOf<number>();
expectTypeOf<Infer<ReturnType<typeof v.boolean>>>().toEqualTypeOf<boolean>();
expectTypeOf<Infer<ReturnType<typeof v.null>>>().toEqualTypeOf<null>();
expectTypeOf<Infer<ReturnType<typeof v.timestamp>>>().toEqualTypeOf<number>();
expectTypeOf<Infer<ReturnType<typeof v.duration>>>().toEqualTypeOf<number>();
expectTypeOf<Infer<ReturnType<typeof v.file>>>().toEqualTypeOf<FileValue>();
expectTypeOf<Infer<ReturnType<typeof v.money>>>().toEqualTypeOf<MoneyValue>();
expectTypeOf<Infer<ReturnType<typeof v.person>>>().toEqualTypeOf<string>();
expectTypeOf<Infer<ReturnType<typeof v.model>>>().toEqualTypeOf<string>();
expectTypeOf<Infer<ReturnType<typeof v.template>>>().toEqualTypeOf<string>();
expectTypeOf<
  Infer<ReturnType<typeof v.schedule>>
>().toEqualTypeOf<ScheduleValue>();

const status = v.enum(["draft", "sent"]);
expectTypeOf<Infer<typeof status>>().toEqualTypeOf<"draft" | "sent">();
const on = v.literal("on");
expectTypeOf<Infer<typeof on>>().toEqualTypeOf<"on">();
const three = v.literal(3);
expectTypeOf<Infer<typeof three>>().toEqualTypeOf<3>();
const nothing = v.literal(null);
expectTypeOf<Infer<typeof nothing>>().toEqualTypeOf<null>();

// An ID carries its table: one table's ID isn't another's, or a plain string.
const noteId = v.id("notes");
expectTypeOf<Infer<typeof noteId>>().toEqualTypeOf<Id<"notes">>();
declare const someNoteId: Id<"notes">;
expectTypeOf(someNoteId).toExtend<string>();
// @ts-expect-error -- an ID of another table
const wrongTable: Id<"people"> = someNoteId;
// @ts-expect-error -- a plain string is not an ID
const plainId: Infer<typeof noteId> = "0192f0c1-7c3e-7abc-8def-0123456789ab";
expectTypeOf([wrongTable, plainId]).not.toBeAny();

// Nested values keep their types at every level, in and out.
const order = v.object({
  id: v.id("orders"),
  customer: v.object({
    name: v.string(),
    email: v.string().email().nullable(),
    tags: v.array(v.enum(["vip", "new"])).default([]),
  }),
  lines: v
    .array(
      v.object({
        sku: v.string(),
        quantity: v.number().integer().min(1).default(1),
        price: v.money(),
        note: v.string().optional(),
      })
    )
    .min(1),
  totals: v.record(v.number()),
  state: v.union(
    v.object({ kind: v.literal("open") }),
    v.object({ kind: v.literal("paid"), at: v.timestamp() })
  ),
  attachments: v.array(v.file()).max(20).default([]),
});
type OrderInput = InferInput<typeof order>;
type OrderValue = Infer<typeof order>;
expectTypeOf<OrderInput>().toEqualTypeOf<{
  id: Id<"orders">;
  customer: {
    name: string;
    email: string | null;
    tags?: ("vip" | "new")[];
  };
  lines: {
    sku: string;
    price: MoneyValue;
    quantity?: number;
    note?: string;
  }[];
  totals: Record<string, number>;
  state: { kind: "open" } | { kind: "paid"; at: number };
  attachments?: FileValue[];
}>();
expectTypeOf<OrderValue>().toEqualTypeOf<{
  id: Id<"orders">;
  customer: {
    name: string;
    email: string | null;
    tags: ("vip" | "new")[];
  };
  lines: {
    sku: string;
    quantity: number;
    price: MoneyValue;
    note?: string;
  }[];
  totals: Record<string, number>;
  state: { kind: "open" } | { kind: "paid"; at: number };
  attachments: FileValue[];
}>();
expectTypeOf<OrderValue>().not.toBeAny();
expectTypeOf<OrderValue["customer"]>().not.toBeAny();
expectTypeOf<OrderValue["customer"]["tags"][number]>().not.toBeAny();
expectTypeOf<OrderValue["lines"][number]>().not.toBeAny();
expectTypeOf<OrderValue["lines"][number]["quantity"]>().toEqualTypeOf<number>();
expectTypeOf<OrderValue["lines"][number]["price"]>().not.toBeAny();
expectTypeOf<OrderValue["totals"][string]>().toEqualTypeOf<number>();
expectTypeOf<OrderValue["state"]>().not.toBeAny();
expectTypeOf<OrderInput["lines"][number]["quantity"]>().toEqualTypeOf<
  number | undefined
>();
// A nested key that isn't declared isn't there.
expectTypeOf<OrderValue["lines"][number]>().not.toHaveProperty("colour");
// @ts-expect-error -- a nested number is not a string
const badQuantity: OrderValue["lines"][number]["quantity"] = "1";
// @ts-expect-error -- not a member of the union
const badState: OrderValue["state"] = { kind: "closed" };
// @ts-expect-error -- not a value of the nested enum
const badTag: OrderValue["customer"]["tags"][number] = "old";
expectTypeOf([badQuantity, badState, badTag]).not.toBeAny();

// Modifiers at the top level, and that a modifier keeps the schema's kind.
const maybeText = v.string().min(1).optional();
expectTypeOf<InferInput<typeof maybeText>>().toEqualTypeOf<
  string | undefined
>();
expectTypeOf<Infer<typeof maybeText>>().toEqualTypeOf<string | undefined>();
const filledList = v.array(v.string()).default([]).max(3);
expectTypeOf<InferInput<typeof filledList>>().toEqualTypeOf<
  string[] | undefined
>();
expectTypeOf<Infer<typeof filledList>>().toEqualTypeOf<string[]>();
const nullableCount = v.number().nullable().integer().min(0);
expectTypeOf<Infer<typeof nullableCount>>().toEqualTypeOf<number | null>();

// A default is a value of the schema.
// @ts-expect-error -- a number is not a string
v.string().default(1);
// @ts-expect-error -- not a value of the enum
status.default("deleted");
// @ts-expect-error -- the default object lacks a required field
note.default({});

// Only the kinds with a constraint have its modifier.
expectTypeOf(v.string()).toHaveProperty("min");
expectTypeOf(v.boolean()).not.toHaveProperty("min");
expectTypeOf(v.number()).not.toHaveProperty("trim");
expectTypeOf(v.string()).not.toHaveProperty("integer");
expectTypeOf(v.timestamp()).not.toHaveProperty("max");
expectTypeOf(v.money()).not.toHaveProperty("min");
expectTypeOf(note).not.toHaveProperty("max");

// There is no `any`, none of the values JSON can't hold, no second spelling
// of an integer, and no callback to refine or transform a value.
expectTypeOf(v).toHaveProperty("string");
expectTypeOf(v).not.toHaveProperty("any");
expectTypeOf(v).not.toHaveProperty("bytes");
expectTypeOf(v).not.toHaveProperty("vector");
expectTypeOf(v).not.toHaveProperty("bigint");
expectTypeOf(v).not.toHaveProperty("int");
expectTypeOf(v.string()).not.toHaveProperty("refine");
expectTypeOf(v.string()).not.toHaveProperty("transform");

// One way to check, and it isn't asynchronous.
expectTypeOf(note).not.toHaveProperty("parse");
expectTypeOf(note).not.toHaveProperty("safeParse");
expectTypeOf(note).not.toHaveProperty("validate");
const checked = note["~standard"].validate({});
expectTypeOf(checked).not.toBeAny();
if (checked.issues === undefined) {
  expectTypeOf(checked.value).toEqualTypeOf<{ title: string; body: string }>();
} else {
  expectTypeOf(checked.issues).toEqualTypeOf<readonly ValueIssue[]>();
}

// A schema is a Standard Schema, to anything that takes one.
expectTypeOf(note).toExtend<
  StandardSchemaV1<
    { title: string; body?: string },
    { title: string; body: string }
  >
>();
expectTypeOf<StandardSchemaV1.InferOutput<typeof note>>().toEqualTypeOf<
  Infer<typeof note>
>();

// pick, omit, extend and partial keep exact types.
expectTypeOf(note.shape.title).not.toBeAny();
const picked = note.pick(["title"]);
expectTypeOf<Infer<typeof picked>>().toEqualTypeOf<{ title: string }>();
const omitted = note.omit(["title"]);
expectTypeOf<InferInput<typeof omitted>>().toEqualTypeOf<{ body?: string }>();
expectTypeOf<Infer<typeof omitted>>().toEqualTypeOf<{ body: string }>();
const extended = note.extend({
  pinned: v.boolean().default(false),
  owner: v.id("people").nullable(),
});
expectTypeOf<InferInput<typeof extended>>().toEqualTypeOf<{
  title: string;
  owner: Id<"people"> | null;
  body?: string;
  pinned?: boolean;
}>();
expectTypeOf<Infer<typeof extended>>().toEqualTypeOf<{
  title: string;
  body: string;
  pinned: boolean;
  owner: Id<"people"> | null;
}>();
// @ts-expect-error -- not a field
note.pick(["missing"]);
// @ts-expect-error -- not a field
note.omit(["missing"]);
// @ts-expect-error -- extend can't replace a field
note.extend({ title: v.number() });

// A patch: every field may be left out, and a default no longer fills it in,
// so the normalized patch may lack the field too. Null stays where it was.
const patch = extended.partial();
expectTypeOf<InferInput<typeof patch>>().toEqualTypeOf<{
  title?: string;
  body?: string;
  pinned?: boolean;
  owner?: Id<"people"> | null;
}>();
expectTypeOf<Infer<typeof patch>>().toEqualTypeOf<{
  title?: string;
  body?: string;
  pinned?: boolean;
  owner?: Id<"people"> | null;
}>();
// A field of a patch is still the schema of its kind.
expectTypeOf(patch.shape.title.max(5)).not.toBeAny();
expectTypeOf<Infer<typeof patch.shape.pinned>>().toEqualTypeOf<
  boolean | undefined
>();
// Partial is shallow: a nested object keeps its required fields.
const nestedPatch = order.pick(["customer"]).partial();
expectTypeOf<Infer<typeof nestedPatch>>().toEqualTypeOf<{
  customer?: { name: string; email: string | null; tags: ("vip" | "new")[] };
}>();

// A shared shape is an ordinary object: spread it, reuse it.
const noteFields = { title: v.string(), body: v.string().default("") };
const withTags = v.object({ ...noteFields, tags: v.array(v.string()) });
expectTypeOf<Infer<typeof withTags>>().toEqualTypeOf<{
  title: string;
  body: string;
  tags: string[];
}>();

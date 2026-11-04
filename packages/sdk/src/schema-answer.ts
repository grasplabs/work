import { canonicalText } from "@grasp-os/shared/json";

import type { SchemaManifest } from "./schema-manifest.ts";
import type { ConversionTarget, SchemaAnswer } from "./schema-plan.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { FrozenJson } from "./value-descriptor.ts";

// What an App's answer (`SchemaAnswer`, schema-plan.ts) makes of one
// record's field that a narrowing doesn't fit: pure, so the store's host
// (apps/core/src/store-schema-changes.ts) and an exported App run the
// same rules. It never guesses: a value it can't turn into one of the
// kind asked for is unanswered, and the host reports the record, as it
// does a value the answer makes that still doesn't fit.

/** What an answer made of a field: a value, or none. */
export type AnsweredValue =
  | { readonly answered: true; readonly value: unknown }
  | { readonly answered: false };

const unanswered: AnsweredValue = { answered: false };

const answered = (value: unknown): AnsweredValue => ({ answered: true, value });

/**
 * A decimal number as text, whole or with a fraction or an exponent, with
 * nothing around it but spaces: never a hexadecimal, an empty text, or
 * `Infinity`, which `Number` would read too.
 */
const decimal = /^\s*-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/u;

/** `value` as text: text as it is, a finite number or a boolean written out. */
const asText = (value: unknown): AnsweredValue => {
  if (typeof value === "string") {
    return answered(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return answered(String(value));
  }
  if (typeof value === "boolean") {
    return answered(value ? "true" : "false");
  }
  return unanswered;
};

/** `value` as a number: a number as it is, a decimal's text read. */
const asNumber = (value: unknown): AnsweredValue => {
  if (typeof value === "number") {
    return answered(value);
  }
  if (typeof value === "string" && decimal.test(value)) {
    const read = Number(value);
    return Number.isFinite(read) ? answered(read) : unanswered;
  }
  return unanswered;
};

/** `value` as a boolean: a boolean as it is, `true` or `false` as text. */
const asBoolean = (value: unknown): AnsweredValue => {
  if (typeof value === "boolean") {
    return answered(value);
  }
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (word === "true" || word === "false") {
      return answered(word === "true");
    }
  }
  return unanswered;
};

/** The key a map answer looks a stored value up by: text, a number or a boolean. */
const mapKey = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
};

/**
 * What `answer` makes of a record's field that doesn't fit: `present`
 * says whether the record holds it, `value` what it holds, and `fields`
 * the record's other fields (a `field` answer reads one). A map or a
 * conversion has nothing to work on in a field the record lacks.
 */
export const answerValue = (
  answer: SchemaAnswer,
  present: boolean,
  value: unknown,
  fields: Readonly<Record<string, unknown>>
): AnsweredValue => {
  if (answer.kind === "value") {
    return answered(answer.value);
  }
  if (answer.kind === "field") {
    return Object.hasOwn(fields, answer.from)
      ? answered(fields[answer.from])
      : unanswered;
  }
  if (!present) {
    return unanswered;
  }
  if (answer.kind === "map") {
    const key = mapKey(value);
    return key !== undefined && Object.hasOwn(answer.values, key)
      ? answered(answer.values[key])
      : unanswered;
  }
  if (answer.to === "string") {
    return asText(value);
  }
  if (answer.to === "number") {
    return asNumber(value);
  }
  return asBoolean(value);
};

/** The most answers an App declares. */
export const appMaxSchemaAnswers = 64;

/** The most bytes an App's answers take, as canonical JSON. */
export const schemaAnswersMaxBytes = 64 * 1024;

const conversionTargets: ReadonlySet<unknown> = new Set<ConversionTarget>([
  "string",
  "number",
  "boolean",
]);

/** How deep an answer's value nests, at most. */
const answerValueDepth = 32;

/** Whether `value` is JSON, as a record's field holds it. */
const isJson = (value: unknown, depth = 0): value is FrozenJson => {
  if (depth > answerValueDepth) {
    return false;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((item: unknown) => isJson(item, depth + 1));
  }
  return (
    isPlainObject(value) &&
    Object.values(value).every((item) => isJson(item, depth + 1))
  );
};

/** An answer's keys and the check of what it holds, by kind, and what it is. */
const answerKinds: Readonly<
  Record<
    string,
    {
      readonly keys: string;
      readonly holds: (answer: Readonly<Record<string, unknown>>) => boolean;
      readonly shape: string;
    }
  >
> = {
  value: {
    keys: "field,kind,table,value",
    holds: (answer) => isJson(answer.value),
    shape:
      'A `value` answer is `{ table, field, kind: "value", value }`, its value JSON.',
  },
  field: {
    keys: "field,from,kind,table",
    holds: (answer) =>
      typeof answer.from === "string" && answer.from !== answer.field,
    shape:
      'A `field` answer is `{ table, field, kind: "field", from }`, from another field.',
  },
  map: {
    keys: "field,kind,table,values",
    holds: (answer) => isPlainObject(answer.values) && isJson(answer.values),
    shape:
      'A `map` answer is `{ table, field, kind: "map", values }`, its values an object of JSON.',
  },
  convert: {
    keys: "field,kind,table,to",
    holds: (answer) => conversionTargets.has(answer.to),
    shape:
      'A `convert` answer is `{ table, field, kind: "convert", to }`, to `"string"`, `"number"` or `"boolean"`.',
  },
};

/**
 * Why `answer` isn't one `schema` takes, or undefined when it is; with
 * the field it is for.
 */
const answerProblem = (
  answer: unknown,
  schema: SchemaManifest
): { problem: string } | { key: string } => {
  if (!isPlainObject(answer)) {
    return { problem: "An answer is `{ table, field, kind, ... }`." };
  }
  const { table, field, kind } = answer;
  const fields =
    typeof table === "string" && Object.hasOwn(schema.tables, table)
      ? schema.tables[table]?.fields
      : undefined;
  if (fields === undefined || typeof field !== "string") {
    return {
      problem: "An answer names a table of the schema and one of its fields.",
    };
  }
  if (!Object.hasOwn(fields, field)) {
    return {
      problem: `\`${String(table)}\` has no field \`${field}\` to answer for.`,
    };
  }
  const declared =
    typeof kind === "string" && Object.hasOwn(answerKinds, kind)
      ? answerKinds[kind]
      : undefined;
  if (declared === undefined) {
    return {
      problem: "An answer's `kind` is `value`, `field`, `map` or `convert`.",
    };
  }
  return Object.keys(answer).toSorted().join(",") === declared.keys &&
    declared.holds(answer)
    ? { key: `${String(table)}.${field}` }
    : { problem: declared.shape };
};

/**
 * An App's answers (`app({ answers })`), checked against its `schema`:
 * at most `appMaxSchemaAnswers`, within `schemaAnswersMaxBytes`, each
 * naming a field of the schema once, of a kind with exactly its keys.
 * Answers a frozen copy; throws `refuse`'s error at the first problem.
 */
export const readSchemaAnswers = (
  input: unknown,
  schema: SchemaManifest,
  refuse: (message: string) => never
): readonly SchemaAnswer[] => {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input) || input.length > appMaxSchemaAnswers) {
    return refuse(
      `An App's \`answers\` is a list of at most ${appMaxSchemaAnswers} answers.`
    );
  }
  const listed: readonly unknown[] = input;
  const seen = new Set<string>();
  for (const answer of listed) {
    const read = answerProblem(answer, schema);
    if ("problem" in read) {
      return refuse(read.problem);
    }
    if (seen.has(read.key)) {
      return refuse(`Two of the App's answers are for \`${read.key}\`.`);
    }
    seen.add(read.key);
  }
  const text = canonicalText(input);
  if (new TextEncoder().encode(text).byteLength > schemaAnswersMaxBytes) {
    return refuse(
      `An App's answers take at most ${schemaAnswersMaxBytes} bytes.`
    );
  }
  // SAFETY: each answer was checked above, key by key.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return Object.freeze(JSON.parse(text) as SchemaAnswer[]);
};

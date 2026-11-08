import { canonicalText } from "@grasp-os/shared/json";

import type { SchemaManifest } from "./schema-manifest.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { FrozenJson } from "./value-descriptor.ts";

// An App's answers (`app({ answers })`): a value for the records that lack
// one field its schema requires, filled in as the version is published,
// never written over a value they hold. Anything that reshapes what a
// record holds is an explicit migration in code. Checked here as the App
// declares them and as its manifest is read back.

/** An App's value for the records that lack `field` of `table`. */
export interface SchemaAnswer {
  readonly table: string;
  readonly field: string;
  readonly value: FrozenJson;
}

/** The most answers an App declares. */
const appMaxSchemaAnswers = 64;

/** The most bytes an App's answers take, as canonical JSON. */
const schemaAnswersMaxBytes = 64 * 1024;

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

/**
 * Why `answer` isn't one `schema` takes, or the field it is for: exactly
 * `{ table, field, value }`, naming a field of the schema, its value JSON.
 */
const answerProblem = (
  answer: unknown,
  schema: SchemaManifest
): { problem: string } | { key: string } => {
  if (
    !isPlainObject(answer) ||
    Object.keys(answer).toSorted().join(",") !== "field,table,value"
  ) {
    return { problem: "An answer is `{ table, field, value }`." };
  }
  const { table, field, value } = answer;
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
  return isJson(value)
    ? { key: `${String(table)}.${field}` }
    : { problem: "An answer's `value` is JSON." };
};

/**
 * An App's answers, checked against its `schema`: at most
 * `appMaxSchemaAnswers`, within `schemaAnswersMaxBytes`, each naming a
 * field of the schema once. Answers a frozen copy; throws `refuse`'s
 * error at the first problem.
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

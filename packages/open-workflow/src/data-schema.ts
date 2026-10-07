import type { ValueSchema } from "@grasp-os/sdk";
import { schemaFromDescriptor } from "@grasp-os/sdk/host";

import { pointerJoin } from "./diagnostics.ts";
import type { DiagnosticCode } from "./diagnostics.ts";
import { isObject } from "./json-text.ts";
import type { JsonObject, JsonValue } from "./json-text.ts";

/**
 * Inline data schemas (`{ format: "json", document }`) are not a second
 * validator: each document is translated once into the SDK's value
 * descriptor and read back through `schemaFromDescriptor`, so every check
 * of the value at run time is the one native interpreter behind
 * `~standard.validate`, with its exact normalization (defaults inserted
 * where a field has one, nothing coerced).
 *
 * The translation accepts only the finite algebra the profile names: type,
 * properties, required, additionalProperties (always false), items, enum,
 * const, anyOf, minimum, maximum, minLength, maxLength, minItems, maxItems,
 * default, title, description, format (email) and x-grasp-value. Anything
 * else (references, allOf, oneOf, patterns, tuples, open objects) is
 * refused with a pointer to it rather than approximated. The first problem
 * in a schema refuses it.
 */

/** The descriptor limits of @grasp-os/sdk, checked here to point at the node. */
const schemaLimits = {
  depth: 32,
  nodes: 10_000,
  anyOfMembers: 64,
  nameLength: 256,
  titleLength: 200,
  descriptionLength: 2000,
} as const;

export interface SchemaProblem {
  code: Extract<DiagnosticCode, `schema.${string}`>;
  pointer: string;
  expected?: string;
  remedy: string;
  reason?: string;
}

type Role = "root" | "property" | "item" | "member";

/** A descriptor as the SDK reads it back (@grasp-os/sdk/host). */
interface Draft {
  descriptorVersion: 1;
  kind: string;
  presence: "required" | "optional" | "default";
  nullable: boolean;
  defaultValue?: JsonValue;
  fields?: Record<string, Draft>;
  item?: Draft;
  members?: Draft[];
  values?: string[];
  value?: null | boolean | number | string;
  tableName?: string;
  trim?: boolean;
  email?: boolean;
  integer?: boolean;
  min?: number;
  max?: number;
}

interface Context {
  nodes: number;
  /** Drafts with a default, to point at the one the SDK refuses. */
  defaults: { pointer: string; draft: Draft }[];
}

class SchemaRefusedError extends Error {
  readonly problem: SchemaProblem;

  constructor(problem: SchemaProblem) {
    super(problem.code);
    this.name = "SchemaRefusedError";
    this.problem = problem;
  }
}

const refuse = (
  code: SchemaProblem["code"],
  pointer: string,
  remedy: string,
  more: { expected?: string; reason?: string } = {}
): never => {
  throw new SchemaRefusedError({ code, pointer, remedy, ...more });
};

const supportedKeywords = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "default",
  "title",
  "description",
  "format",
  "x-grasp-value",
]);
const referenceKeywords = new Set([
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
  "$defs",
  "definitions",
  "$id",
  "$anchor",
  "$schema",
]);
const annotationKeywords = new Set(["title", "description", "default"]);

/** The keywords each form may have besides the annotations. */
const formKeywords: Readonly<Record<string, readonly string[]>> = {
  semantic: ["type", "x-grasp-value"],
  anyOf: ["anyOf"],
  const: ["const"],
  enum: ["enum", "type"],
  string: ["type", "minLength", "maxLength", "format"],
  number: ["type", "minimum", "maximum"],
  integer: ["type", "minimum", "maximum"],
  boolean: ["type"],
  null: ["type"],
  object: ["type", "properties", "required", "additionalProperties"],
  array: ["type", "items", "minItems", "maxItems"],
};

/** The JSON type each semantic value has on the wire (@grasp-os/sdk). */
const semanticWireTypes: ReadonlyMap<string, string> = new Map([
  ["id", "string"],
  ["person", "string"],
  ["model", "string"],
  ["template", "string"],
  ["timestamp", "integer"],
  ["duration", "integer"],
  ["file", "object"],
  ["money", "object"],
  ["schedule", "object"],
]);

const tableNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

const draftOf = (kind: string, extra: Partial<Draft> = {}): Draft => ({
  descriptorVersion: 1,
  kind,
  presence: "required",
  nullable: false,
  ...extra,
});

const isLength = (value: JsonValue | undefined): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isFiniteNumber = (value: JsonValue | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isSafeInteger = (value: JsonValue | undefined): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

/** `min`/`max` from two keywords; `{}` when neither is set. */
const boundsOf = (
  node: JsonObject,
  pointer: string,
  keys: readonly [string, string],
  isValid: (value: JsonValue | undefined) => value is number,
  expected: string
): { min?: number; max?: number } => {
  const [minKey, maxKey] = keys;
  const bounds: { min?: number; max?: number } = {};
  for (const [key, name] of [
    [minKey, "min"],
    [maxKey, "max"],
  ] as const) {
    if (!Object.hasOwn(node, key)) {
      continue;
    }
    const value = node[key];
    if (!isValid(value)) {
      return refuse(
        "schema.invalid",
        pointerJoin(pointer, key),
        `Set ${key} to ${expected}.`,
        { expected }
      );
    }
    bounds[name] = value;
  }
  if (
    bounds.min !== undefined &&
    bounds.max !== undefined &&
    bounds.min > bounds.max
  ) {
    return refuse(
      "schema.invalid",
      pointerJoin(pointer, maxKey),
      `Make ${maxKey} at least ${minKey}: no value could pass.`
    );
  }
  return bounds;
};

const isScalar = (
  value: JsonValue
): value is null | boolean | number | string =>
  value === null || typeof value !== "object";

/** A scalar's identity: equal JSON values, equal keys (-0 is 0). */
const scalarKey = (value: null | boolean | number | string): string =>
  `${typeof value}:${JSON.stringify(value)}`;

const literalDraft = (value: JsonValue, pointer: string): Draft => {
  if (!isScalar(value)) {
    return refuse(
      "schema.unsupported_keyword",
      pointer,
      "Use a scalar constant; describe objects and arrays with properties and items."
    );
  }
  if (typeof value === "string" && value.length > schemaLimits.nameLength) {
    return refuse(
      "schema.invalid",
      pointer,
      "Keep a constant to 256 characters."
    );
  }
  return draftOf("literal", { value });
};

const matchesType = (
  value: JsonValue,
  type: JsonValue | undefined
): boolean => {
  if (type === "integer") {
    return Number.isSafeInteger(value);
  }
  return type === (value === null ? "null" : typeof value);
};

const isName = (value: JsonValue): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= schemaLimits.nameLength;

const enumDraft = (
  node: JsonObject,
  pointer: string,
  context: Context
): Draft => {
  const values = node.enum;
  const at = pointerJoin(pointer, "enum");
  if (!Array.isArray(values) || values.length === 0) {
    return refuse("schema.invalid", at, "List at least one constant in enum.");
  }
  if (values.length > schemaLimits.nodes) {
    return refuse("schema.too_large", at, "List fewer constants.");
  }
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (!isScalar(value)) {
      return refuse(
        "schema.invalid",
        pointerJoin(at, index),
        "List only scalar constants in enum."
      );
    }
    const key = scalarKey(value);
    if (seen.has(key)) {
      return refuse(
        "schema.invalid",
        pointerJoin(at, index),
        "List each constant in enum once."
      );
    }
    seen.add(key);
  }
  context.nodes += values.length;
  if (
    Object.hasOwn(node, "type") &&
    !values.every((value) => matchesType(value, node.type))
  ) {
    return refuse(
      "schema.invalid",
      pointerJoin(pointer, "type"),
      "Make every constant in enum have the declared type."
    );
  }
  if (values.every(isName)) {
    return draftOf("enum", { values: values.filter(isName) });
  }
  if (values.length > schemaLimits.anyOfMembers) {
    return refuse(
      "schema.too_large",
      at,
      `Keep an enum of other than short strings to ${schemaLimits.anyOfMembers} constants.`
    );
  }
  return draftOf("union", {
    members: values.map((value, index) =>
      literalDraft(value, pointerJoin(at, index))
    ),
  });
};

const semanticDraft = (node: JsonObject, pointer: string): Draft => {
  const at = pointerJoin(pointer, "x-grasp-value");
  const marker = node["x-grasp-value"];
  if (!isObject(marker)) {
    return refuse(
      "schema.invalid",
      at,
      "Set x-grasp-value to { kind } (and table for an id)."
    );
  }
  for (const key of Object.keys(marker)) {
    if (key !== "kind" && key !== "table") {
      return refuse(
        "schema.unsupported_keyword",
        pointerJoin(at, key),
        "x-grasp-value has only kind and table."
      );
    }
  }
  const { kind } = marker;
  const wireType =
    typeof kind === "string" ? semanticWireTypes.get(kind) : undefined;
  if (typeof kind !== "string" || wireType === undefined) {
    return refuse(
      "schema.invalid",
      pointerJoin(at, "kind"),
      "Use a kind of id, timestamp, file, money, person, model, template, duration or schedule.",
      { expected: [...semanticWireTypes.keys()].join(", ") }
    );
  }
  if (node.type !== wireType) {
    return refuse(
      "schema.invalid",
      pointerJoin(pointer, "type"),
      `Declare the ${kind} value's wire type.`,
      { expected: `type ${wireType}` }
    );
  }
  const hasTable = Object.hasOwn(marker, "table");
  if (kind !== "id") {
    if (hasTable) {
      return refuse(
        "schema.keyword_not_applicable",
        pointerJoin(at, "table"),
        "Only an id names a table."
      );
    }
    return draftOf(kind);
  }
  const { table } = marker;
  if (typeof table !== "string" || !tableNamePattern.test(table)) {
    return refuse(
      "schema.invalid",
      pointerJoin(at, "table"),
      "Name the id's table: a letter, then letters, digits and underscores.",
      { expected: "table name" }
    );
  }
  return draftOf("id", { tableName: table });
};

const stringDraft = (node: JsonObject, pointer: string): Draft => {
  const bounds = boundsOf(
    node,
    pointer,
    ["minLength", "maxLength"],
    isLength,
    "a whole number of at least 0"
  );
  if (Object.hasOwn(node, "format") && node.format !== "email") {
    return refuse(
      "schema.unsupported_keyword",
      pointerJoin(pointer, "format"),
      "The only format is email; a timestamp is a number with x-grasp-value.",
      { expected: "email" }
    );
  }
  return draftOf("string", {
    trim: false,
    email: Object.hasOwn(node, "format"),
    ...bounds,
  });
};

const numberDraft = (
  node: JsonObject,
  pointer: string,
  integer: boolean
): Draft => {
  const bounds = integer
    ? boundsOf(
        node,
        pointer,
        ["minimum", "maximum"],
        isSafeInteger,
        "a safe integer"
      )
    : boundsOf(
        node,
        pointer,
        ["minimum", "maximum"],
        isFiniteNumber,
        "a finite number"
      );
  return draftOf("number", { integer, ...bounds });
};

const requiredNames = (
  node: JsonObject,
  pointer: string,
  properties: JsonObject
): Set<string> => {
  const names = new Set<string>();
  if (!Object.hasOwn(node, "required")) {
    return names;
  }
  const at = pointerJoin(pointer, "required");
  const { required } = node;
  if (!Array.isArray(required)) {
    return refuse("schema.invalid", at, "List required properties.");
  }
  for (const [index, name] of required.entries()) {
    if (typeof name !== "string" || !Object.hasOwn(properties, name)) {
      return refuse(
        "schema.invalid",
        pointerJoin(at, index),
        "Require only properties the schema declares."
      );
    }
    if (names.has(name)) {
      return refuse(
        "schema.invalid",
        pointerJoin(at, index),
        "Require each property once."
      );
    }
    names.add(name);
  }
  return names;
};

type CompileNode = (
  node: JsonValue | undefined,
  pointer: string,
  depth: number,
  context: Context,
  role: Role
) => Draft;

const objectDraft = (
  node: JsonObject,
  pointer: string,
  depth: number,
  context: Context,
  compile: CompileNode
): Draft => {
  if (node.additionalProperties !== false) {
    return refuse(
      "schema.open_object",
      pointerJoin(pointer, "additionalProperties"),
      "Set additionalProperties to false and declare every property.",
      { expected: "additionalProperties: false" }
    );
  }
  const at = pointerJoin(pointer, "properties");
  const properties = Object.hasOwn(node, "properties") ? node.properties : {};
  if (!isObject(properties)) {
    return refuse(
      "schema.invalid",
      at,
      "Declare properties as a map of names to schemas."
    );
  }
  const required = requiredNames(node, pointer, properties);
  const fields: Record<string, Draft> = {};
  for (const [name, schema] of Object.entries(properties)) {
    const fieldPointer = pointerJoin(at, name);
    if (name.length === 0 || name.length > schemaLimits.nameLength) {
      return refuse(
        "schema.invalid",
        fieldPointer,
        "Name a property with 1 to 256 characters."
      );
    }
    const field = compile(schema, fieldPointer, depth + 1, context, "property");
    if (required.has(name) && field.presence === "default") {
      return refuse(
        "schema.default_not_allowed",
        pointerJoin(fieldPointer, "default"),
        "A required property has no default: drop it from required, or drop the default."
      );
    }
    if (!required.has(name) && field.presence !== "default") {
      field.presence = "optional";
    }
    fields[name] = field;
  }
  return draftOf("object", { fields });
};

const arrayDraft = (
  node: JsonObject,
  pointer: string,
  depth: number,
  context: Context,
  compile: CompileNode
): Draft => {
  const at = pointerJoin(pointer, "items");
  if (!Object.hasOwn(node, "items")) {
    return refuse("schema.invalid", at, "Give an array one items schema.");
  }
  if (Array.isArray(node.items)) {
    return refuse(
      "schema.unsupported_keyword",
      at,
      "Tuples aren't supported: give one items schema, or use an object."
    );
  }
  const bounds = boundsOf(
    node,
    pointer,
    ["minItems", "maxItems"],
    isLength,
    "a whole number of at least 0"
  );
  const item = compile(node.items, at, depth + 1, context, "item");
  return draftOf("array", { item, ...bounds });
};

const stringKinds = new Set([
  "string",
  "enum",
  "id",
  "person",
  "model",
  "template",
]);
const numberKinds = new Set(["number", "timestamp", "duration"]);
const objectKinds = new Set(["object", "file", "money", "schedule"]);

/** The JSON types a draft accepts. */
const jsonTypes = (draft: Draft): Set<string> => {
  const types = new Set<string>();
  if (draft.nullable) {
    types.add("null");
  }
  if (stringKinds.has(draft.kind)) {
    types.add("string");
  } else if (numberKinds.has(draft.kind)) {
    types.add("number");
  } else if (objectKinds.has(draft.kind)) {
    types.add("object");
  } else if (draft.kind === "literal") {
    types.add(draft.value === null ? "null" : typeof draft.value);
  } else if (draft.kind === "union") {
    for (const member of draft.members ?? []) {
      for (const type of jsonTypes(member)) {
        types.add(type);
      }
    }
  } else {
    types.add(draft.kind);
  }
  return types;
};

const sharedTypes = (first: Set<string>, second: Set<string>): string[] =>
  [...first].filter((type) => second.has(type));

/** Children of a draft, for the walk below. */
const childrenOf = (draft: Draft): Draft[] => {
  const children = [
    ...Object.values(draft.fields ?? {}),
    ...(draft.members ?? []),
  ];
  if (draft.item !== undefined) {
    children.push(draft.item);
  }
  return children;
};

/**
 * Whether the interpreter could return something other than the value it
 * was given: a default filled in somewhere, or a literal 0 turning -0 into
 * 0. Without either, every member that accepts a value returns it as is.
 */
const mayNormalize = (draft: Draft): boolean => {
  const pending = [draft];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (
      next.presence === "default" ||
      (next.kind === "literal" && next.value === 0)
    ) {
      return true;
    }
    pending.push(...childrenOf(next));
  }
  return false;
};

/** The constants a required field is limited to, if it is a literal or enum. */
const constantsOf = (draft: Draft): Set<string> | undefined => {
  if (draft.presence !== "required" || draft.nullable) {
    return undefined;
  }
  if (draft.kind === "literal" && draft.value !== undefined) {
    return new Set([scalarKey(draft.value)]);
  }
  if (draft.kind === "enum") {
    return new Set((draft.values ?? []).map((value) => scalarKey(value)));
  }
  return undefined;
};

/** Whether two object members are told apart by a required constant field. */
const discriminated = (first: Draft, second: Draft): boolean => {
  if (first.kind !== "object" || second.kind !== "object") {
    return false;
  }
  const secondFields = second.fields ?? {};
  for (const [name, field] of Object.entries(first.fields ?? {})) {
    const other = Object.hasOwn(secondFields, name)
      ? secondFields[name]
      : undefined;
    const mine = constantsOf(field);
    const theirs = other === undefined ? undefined : constantsOf(other);
    if (
      mine !== undefined &&
      theirs !== undefined &&
      ![...mine].some((constant) => theirs.has(constant))
    ) {
      return true;
    }
  }
  return false;
};

/**
 * The SDK's union takes the first member a value fits. That is only exact
 * when no value fits two members that would normalize it differently, so
 * such a pair is refused here: members of different JSON types, objects
 * told apart by a required constant, or members that return values as
 * they are, are all fine.
 */
const checkAmbiguity = (
  members: readonly { draft: Draft; pointer: string }[]
): void => {
  const facts = members.map(({ draft }) => ({
    draft,
    types: jsonTypes(draft),
    normalizes: mayNormalize(draft),
  }));
  for (const [second, b] of facts.entries()) {
    for (const a of facts.slice(0, second)) {
      if (!(a.normalizes || b.normalizes)) {
        continue;
      }
      const shared = sharedTypes(a.types, b.types);
      const onlyObjects = shared.length === 1 && shared[0] === "object";
      if (
        shared.length > 0 &&
        !(onlyObjects && discriminated(a.draft, b.draft))
      ) {
        refuse(
          "schema.ambiguous_any_of",
          members[second]?.pointer ?? "",
          "Tell the members apart by type or by a required constant field, or drop the default."
        );
      }
    }
  }
};

const anyOfDraft = (
  node: JsonObject,
  pointer: string,
  depth: number,
  context: Context,
  compile: CompileNode
): Draft => {
  const at = pointerJoin(pointer, "anyOf");
  const { anyOf } = node;
  if (
    !Array.isArray(anyOf) ||
    anyOf.length === 0 ||
    anyOf.length > schemaLimits.anyOfMembers
  ) {
    return refuse(
      "schema.invalid",
      at,
      `List 1 to ${schemaLimits.anyOfMembers} schemas in anyOf.`
    );
  }
  const members: { draft: Draft; pointer: string }[] = [];
  let nullable = false;
  for (const [index, schema] of anyOf.entries()) {
    const memberPointer = pointerJoin(at, index);
    // At the same depth: a member is one descriptor level down only inside
    // a union, which the SDK's own depth check bounds when it seals.
    const member = compile(schema, memberPointer, depth, context, "member");
    // A null member is the one nullable convention: it makes the rest
    // nullable rather than standing as a member of its own.
    if (member.nullable || member.kind === "null") {
      nullable = true;
    }
    member.nullable = false;
    if (member.kind !== "null") {
      members.push({ draft: member, pointer: memberPointer });
    }
  }
  checkAmbiguity(members);
  const [only] = members;
  if (only === undefined) {
    return draftOf("null");
  }
  if (members.length === 1) {
    return { ...only.draft, nullable };
  }
  return draftOf("union", {
    members: members.map(({ draft }) => draft),
    nullable,
  });
};

/** Which form a schema node has, from the keywords it uses. */
const formOf = (node: JsonObject): string | undefined => {
  if (Object.hasOwn(node, "x-grasp-value")) {
    return "semantic";
  }
  for (const form of ["anyOf", "const", "enum"]) {
    if (Object.hasOwn(node, form)) {
      return form;
    }
  }
  const { type } = node;
  return typeof type === "string" && Object.hasOwn(formKeywords, type)
    ? type
    : undefined;
};

const checkKeywords = (node: JsonObject, pointer: string): void => {
  for (const key of Object.keys(node)) {
    if (supportedKeywords.has(key)) {
      continue;
    }
    if (referenceKeywords.has(key)) {
      refuse(
        "schema.external",
        pointerJoin(pointer, key),
        "Write the schema inline: references aren't followed."
      );
    }
    refuse(
      "schema.unsupported_keyword",
      pointerJoin(pointer, key),
      "Use only the profile's keywords, or a shared contract or compute module for anything else.",
      { reason: `keyword ${key.slice(0, 64)}` }
    );
  }
  for (const [key, limit] of [
    ["title", schemaLimits.titleLength],
    ["description", schemaLimits.descriptionLength],
  ] as const) {
    const value = node[key];
    if (
      Object.hasOwn(node, key) &&
      (typeof value !== "string" || value.length > limit)
    ) {
      refuse(
        "schema.invalid",
        pointerJoin(pointer, key),
        `Keep ${key} to text of at most ${limit} characters.`
      );
    }
  }
};

const formDraft = (
  form: string,
  node: JsonObject,
  pointer: string,
  depth: number,
  context: Context,
  compile: CompileNode
): Draft => {
  switch (form) {
    case "semantic": {
      return semanticDraft(node, pointer);
    }
    case "anyOf": {
      return anyOfDraft(node, pointer, depth, context, compile);
    }
    case "const": {
      const { const: value } = node;
      return literalDraft(value ?? null, pointerJoin(pointer, "const"));
    }
    case "enum": {
      return enumDraft(node, pointer, context);
    }
    case "string": {
      return stringDraft(node, pointer);
    }
    case "number":
    case "integer": {
      return numberDraft(node, pointer, form === "integer");
    }
    case "object": {
      return objectDraft(node, pointer, depth, context, compile);
    }
    case "array": {
      return arrayDraft(node, pointer, depth, context, compile);
    }
    default: {
      return draftOf(form);
    }
  }
};

const compileNode: CompileNode = (node, pointer, depth, context, role) => {
  context.nodes += 1;
  if (depth > schemaLimits.depth || context.nodes > schemaLimits.nodes) {
    return refuse(
      "schema.too_large",
      pointer,
      "Nest the schema at most 32 deep, with at most 10,000 schemas in all."
    );
  }
  if (!isObject(node)) {
    return refuse("schema.invalid", pointer, "Write a schema as an object.");
  }
  checkKeywords(node, pointer);
  const form = formOf(node);
  if (form === undefined) {
    return refuse(
      "schema.invalid",
      pointerJoin(pointer, "type"),
      "Give the schema a type, or use const, enum, anyOf or x-grasp-value.",
      { expected: "string, number, integer, boolean, null, object or array" }
    );
  }
  const allowed = formKeywords[form] ?? [];
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key) && !annotationKeywords.has(key)) {
      return refuse(
        "schema.keyword_not_applicable",
        pointerJoin(pointer, key),
        `Drop ${key.slice(0, 64)}: it doesn't apply to this kind of schema.`
      );
    }
  }
  const hasDefault = Object.hasOwn(node, "default");
  if (hasDefault && role !== "property") {
    return refuse(
      "schema.default_not_allowed",
      pointerJoin(pointer, "default"),
      role === "root"
        ? "Defaults belong on object properties (or on the parameter)."
        : "An array item or anyOf member can't have a default."
    );
  }
  const draft = formDraft(form, node, pointer, depth, context, compileNode);
  // The parser never yields undefined for a key that is there: an explicit
  // null default is a default like any other value.
  const { default: defaultValue } = node;
  if (hasDefault && defaultValue !== undefined) {
    draft.presence = "default";
    draft.defaultValue = defaultValue;
    context.defaults.push({ pointer, draft });
  }
  return draft;
};

const sealed = (draft: Draft): ValueSchema<unknown, unknown> | undefined => {
  try {
    // The descriptor's text: only what the definition had, as JSON.
    return schemaFromDescriptor(JSON.stringify(draft));
  } catch {
    return undefined;
  }
};

export type SchemaCompilation =
  | { ok: true; schema: ValueSchema<unknown, unknown> }
  | { ok: false; problems: SchemaProblem[] };

const refused = (problem: SchemaProblem): SchemaCompilation => ({
  ok: false,
  problems: [problem],
});

/**
 * Compiles one inline schema document into the SDK's native schema. With
 * `rootDefault`, the value as a whole has that default (a parameter's), at
 * `rootDefault.pointer`; otherwise it is required.
 */
export const compileDataSchema = (
  document: JsonValue | undefined,
  pointer: string,
  rootDefault?: { value: JsonValue; pointer: string }
): SchemaCompilation => {
  const context: Context = { nodes: 0, defaults: [] };
  let draft: Draft;
  try {
    draft = compileNode(document, pointer, 1, context, "root");
  } catch (error) {
    if (error instanceof SchemaRefusedError) {
      return refused(error.problem);
    }
    throw error;
  }
  if (rootDefault !== undefined) {
    draft.presence = "default";
    draft.defaultValue = rootDefault.value;
  }
  const schema = sealed(draft);
  if (schema !== undefined) {
    return { ok: true, schema };
  }
  // The SDK refuses a declaration as a whole; find the default it refused.
  // Each check reads one subtree, so this stays within nodes × depth.
  for (const { pointer: at, draft: withDefault } of context.defaults) {
    if (sealed(withDefault) === undefined) {
      return refused({
        code: "schema.invalid_default",
        pointer: pointerJoin(at, "default"),
        remedy: "Give a default the schema itself accepts.",
      });
    }
  }
  return refused(
    rootDefault === undefined
      ? {
          code: "schema.invalid",
          pointer,
          remedy: "Check the schema's bounds and constants.",
        }
      : {
          code: "schema.invalid_default",
          pointer: rootDefault.pointer,
          remedy: "Give a default the parameter's schema accepts.",
        }
  );
};

/**
 * The `{ format: "json", document }` envelope of upstream input, output and
 * export schemas. Only inline JSON documents: `resource` is never loaded.
 */
export const compileSchemaEnvelope = (
  envelope: JsonValue | undefined,
  pointer: string
): SchemaCompilation => {
  if (!isObject(envelope)) {
    return refused({
      code: "schema.invalid",
      pointer,
      remedy: 'Write the schema as { "format": "json", "document": { … } }.',
    });
  }
  for (const key of Object.keys(envelope)) {
    if (key === "resource") {
      return refused({
        code: "schema.external",
        pointer: pointerJoin(pointer, key),
        remedy:
          "Write the schema inline as document: external schemas aren't loaded.",
      });
    }
    if (key !== "format" && key !== "document") {
      return refused({
        code: "schema.unsupported_keyword",
        pointer: pointerJoin(pointer, key),
        remedy: "A schema envelope has only format and document.",
      });
    }
  }
  if (Object.hasOwn(envelope, "format") && envelope.format !== "json") {
    return refused({
      code: "schema.invalid",
      pointer: pointerJoin(pointer, "format"),
      remedy: 'Set format to "json".',
      expected: "json",
    });
  }
  if (!Object.hasOwn(envelope, "document")) {
    return refused({
      code: "schema.invalid",
      pointer: pointerJoin(pointer, "document"),
      remedy: "Give the schema an inline document.",
    });
  }
  return compileDataSchema(envelope.document, pointerJoin(pointer, "document"));
};

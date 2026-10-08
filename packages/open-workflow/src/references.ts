import type { ValueDescriptor } from "@grasp-os/sdk";
import type { CompiledExpression } from "@grasp-os/workflow-expressions/evaluate";

import type { Checker, Expectation, ExpressionSlot } from "./checker.ts";

/**
 * What can be proven about an expression's references before a run: the
 * `$params`, `$workflow.input`, `$task`, `$runtime` and error fields it
 * reads directly exist, and an expression that is nothing but such a path
 * has a type its place can take. Everything past a direct path (pipes,
 * builtins, `$context`, which tasks build as they go) is not provable and
 * stays with the run's native validation; nothing here claims more.
 */

/** Fields of the variables whose shape the profile fixes. */
const fixedFields: Readonly<Record<string, readonly string[]>> = {
  workflow: ["id", "input", "startedAt"],
  task: ["name", "reference", "input", "output", "startedAt"],
  runtime: ["name", "version"],
};
/** Fields of a caught error (`catch.as`), as upstream errors have them. */
const errorFields = new Set(["type", "status", "title", "detail", "instance"]);

/** Fields of the semantic values that are objects on the wire. */
const semanticFields: Readonly<Record<string, readonly string[]>> = {
  file: ["id"],
  money: ["minorUnits", "currency"],
  schedule: ["cron", "timeZone"],
};

type Walk =
  | { kind: "known"; descriptor: ValueDescriptor }
  | { kind: "unknown" }
  | { kind: "missing"; depth: number }
  | { kind: "not_object"; depth: number };

/** Follows `.field` steps down a descriptor, as far as they are certain. */
const walk = (start: ValueDescriptor, fields: readonly string[]): Walk => {
  let descriptor = start;
  for (const [depth, field] of fields.entries()) {
    // jq reads a field of null as null: the path stays null to its end.
    const isNull =
      descriptor.kind === "null" ||
      (descriptor.kind === "literal" && descriptor.value === null);
    if (isNull) {
      return { kind: "known", descriptor };
    }
    if (descriptor.kind === "object") {
      const next = Object.hasOwn(descriptor.fields, field)
        ? descriptor.fields[field]
        : undefined;
      if (next === undefined) {
        return { kind: "missing", depth };
      }
      descriptor = next;
      continue;
    }
    const known = semanticFields[descriptor.kind];
    if (known !== undefined) {
      return known.includes(field)
        ? { kind: "unknown" }
        : { kind: "missing", depth };
    }
    if (descriptor.kind === "union" || descriptor.kind === "record") {
      return { kind: "unknown" };
    }
    // jq reads a field of null as null; of any other scalar, it fails.
    if (descriptor.nullable || descriptor.presence !== "required") {
      return { kind: "unknown" };
    }
    return { kind: "not_object", depth };
  }
  return { kind: "known", descriptor };
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
const objectKinds = new Set(["object", "record", "file", "money", "schedule"]);

/** The JSON types a descriptor's values can have, null aside. */
const typesOf = (descriptor: ValueDescriptor): Set<string> => {
  if (descriptor.kind === "union") {
    const types = new Set<string>();
    for (const member of descriptor.members) {
      for (const type of typesOf(member)) {
        types.add(type);
      }
    }
    return types;
  }
  if (descriptor.kind === "literal") {
    return new Set([
      descriptor.value === null ? "null" : typeof descriptor.value,
    ]);
  }
  if (stringKinds.has(descriptor.kind)) {
    return new Set(["string"]);
  }
  if (numberKinds.has(descriptor.kind)) {
    return new Set(["number"]);
  }
  return new Set([
    objectKinds.has(descriptor.kind) ? "object" : descriptor.kind,
  ]);
};

/** The JSON types each expectation takes. */
const expectedTypes: Readonly<Record<Expectation, readonly string[]>> = {
  boolean: ["boolean"],
  array: ["array"],
  string: ["string"],
  number: ["number"],
  // Milliseconds, or an ISO 8601 duration (workflow-expressions/duration).
  duration: ["number", "string"],
};

const fitsExpectation = (
  descriptor: ValueDescriptor,
  expects: Expectation
): boolean => {
  const types = typesOf(descriptor);
  return expectedTypes[expects].some((type) => types.has(type));
};

/**
 * Where a path's fields after the first are read from: a descriptor, when
 * the variable's shape is declared; nothing when the first field doesn't
 * exist (`unknown`) or nothing more can be proven.
 */
const startOf = (
  checker: Checker,
  slot: ExpressionSlot,
  variable: string,
  first: string
): { start?: ValueDescriptor; unknown?: true } => {
  if (variable === "params") {
    const schema = checker.params.get(first);
    return schema === undefined
      ? { unknown: true }
      : { start: schema.descriptor };
  }
  const fields = Object.hasOwn(fixedFields, variable)
    ? fixedFields[variable]
    : undefined;
  if (fields !== undefined) {
    if (!fields.includes(first)) {
      return { unknown: true };
    }
    const input = checker.workflowInput?.descriptor;
    return variable === "workflow" && first === "input" && input !== undefined
      ? { start: input }
      : {};
  }
  if (slot.errorVariables.includes(variable) && !errorFields.has(first)) {
    return { unknown: true };
  }
  return {};
};

/** Checks the direct references of one compiled expression. */
export const checkReferences = (
  checker: Checker,
  slot: ExpressionSlot,
  compiled: CompiledExpression
): void => {
  const where = { pointer: slot.pointer, taskId: slot.scope.at(-1) };
  for (const path of compiled.paths) {
    const [first, ...rest] = path.fields;
    if (first === undefined) {
      continue;
    }
    const unknown = (depth: number): void => {
      checker.report.error(
        "expression.unknown_reference",
        where,
        "Read only parameters and fields the definition declares.",
        { reason: `field ${depth + 1} of the path` }
      );
    };
    const { start, unknown: firstUnknown } = startOf(
      checker,
      slot,
      path.variable,
      first
    );
    if (firstUnknown === true) {
      unknown(0);
      continue;
    }
    if (start === undefined) {
      continue;
    }
    const walked = walk(start, rest);
    if (walked.kind === "missing" || walked.kind === "not_object") {
      // The walk starts after the first field.
      unknown(walked.depth + 1);
      continue;
    }
    const { expects } = slot;
    if (
      walked.kind === "known" &&
      path.whole &&
      expects !== undefined &&
      !fitsExpectation(walked.descriptor, expects)
    ) {
      checker.report.error(
        "expression.type_mismatch",
        where,
        `Use a value that is a ${expects} here.`,
        { expected: expects }
      );
    }
  }
};

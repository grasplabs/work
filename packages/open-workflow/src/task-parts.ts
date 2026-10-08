import type { ValueDescriptor, ValueIssue, ValueSchema } from "@grasp-os/sdk";
import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import type { Stage } from "@grasp-os/workflow-expressions/evaluate";
import { parseSlot } from "@grasp-os/workflow-expressions/source";

import type { BindingKind } from "./catalog.ts";
import type { Binding, Checker, Site } from "./checker.ts";
import { compileSchemaEnvelope } from "./data-schema.ts";
import { pointerJoin } from "./diagnostics.ts";
import { isObject } from "./json-text.ts";
import type { JsonValue } from "./json-text.ts";
import { at, dataValue, literalText, textAt } from "./values.ts";

/**
 * What several task kinds share: their binding, their arguments checked
 * against a contract, schemas and text that may be an expression.
 */

export const taskDefinition: Stage = "taskDefinition";

export const schemaAt = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): ValueSchema<unknown, unknown> | undefined => {
  const compiled = compileSchemaEnvelope(value, pointer);
  if (!compiled.ok) {
    for (const problem of compiled.problems) {
      checker.report.error(
        problem.code,
        at(site, problem.pointer),
        problem.remedy,
        {
          ...(problem.expected === undefined
            ? {}
            : { expected: problem.expected }),
          ...(problem.reason === undefined ? {} : { reason: problem.reason }),
        }
      );
    }
    return undefined;
  }
  checker.schemas.set(pointer, compiled.schema);
  return compiled.schema;
};

export const bindingFor = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  kind: BindingKind
): Binding | undefined => {
  const alias = literalText(checker, value, pointer, site, 64);
  if (alias === undefined) {
    return undefined;
  }
  const binding = checker.bindings.get(alias);
  if (binding === undefined) {
    checker.report.error(
      "binding.unknown",
      at(site, pointer),
      "Use an alias declared in document.metadata.grasp.bindings.",
      { expected: `a ${kind} binding` }
    );
    return undefined;
  }
  binding.referenced = true;
  if (binding.kind !== kind) {
    checker.report.error(
      "binding.wrong_kind",
      at(site, pointer),
      `Use a binding of kind ${kind} here.`,
      { expected: kind }
    );
    return undefined;
  }
  return binding;
};

const maxArgumentIssues = 5;

/** Whether a value has an expression anywhere in it. */
const hasExpression = (value: JsonValue | undefined): boolean => {
  if (typeof value === "string") {
    return parseSlot(value).kind === "expression";
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.values(value).some(hasExpression);
};

/** Native schemas of a contract's nested descriptors, each made once. */
const nestedSchemas = new WeakMap<object, ValueSchema<unknown, unknown>>();

const schemaOfDescriptor = (
  descriptor: ValueDescriptor
): ValueSchema<unknown, unknown> => {
  const known = nestedSchemas.get(descriptor);
  if (known !== undefined) {
    return known;
  }
  // The descriptor is the SDK's own, sealed: it reads back as itself.
  const schema = schemaFromDescriptor(JSON.stringify(descriptor));
  nestedSchemas.set(descriptor, schema);
  return schema;
};

const reportIssues = (
  checker: Checker,
  issues: readonly ValueIssue[],
  pointer: string,
  site: Site
): void => {
  for (const issue of issues.slice(0, maxArgumentIssues)) {
    let issuePointer = pointer;
    for (const step of issue.path) {
      issuePointer = pointerJoin(issuePointer, step);
    }
    checker.report.error(
      "call.invalid_arguments",
      at(site, issuePointer),
      "Pass what the binding's contract accepts.",
      { reason: issue.code }
    );
  }
};

/**
 * Checks a value against a contract's descriptor as far as it is literal:
 * a literal part in full, by the contract's own schema; an object or array
 * with expressions in it by its keys and, recursively, its literal parts.
 * What an expression returns is the run's to validate.
 */
const checkAgainst = (
  checker: Checker,
  value: JsonValue | undefined,
  descriptor: ValueDescriptor,
  pointer: string,
  site: Site
): void => {
  if (!hasExpression(value)) {
    const result = schemaOfDescriptor(descriptor)["~standard"].validate(value);
    reportIssues(checker, result.issues ?? [], pointer, site);
    return;
  }
  if (Array.isArray(value) && descriptor.kind === "array") {
    for (const [index, item] of value.entries()) {
      checkAgainst(
        checker,
        item,
        descriptor.item,
        pointerJoin(pointer, index),
        site
      );
    }
    return;
  }
  if (!isObject(value) || descriptor.kind !== "object") {
    return;
  }
  const { fields } = descriptor;
  for (const [key, item] of Object.entries(value)) {
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (field === undefined) {
      checker.report.error(
        "call.invalid_arguments",
        at(site, pointerJoin(pointer, key)),
        "Pass only the fields the binding's contract declares.",
        { reason: "value.unknown_key" }
      );
    } else {
      checkAgainst(checker, item, field, pointerJoin(pointer, key), site);
    }
  }
  for (const [key, field] of Object.entries(fields)) {
    if (field.presence === "required" && !Object.hasOwn(value, key)) {
      checker.report.error(
        "call.invalid_arguments",
        at(site, pointer),
        `Pass ${key}: the binding's contract requires it.`,
        { reason: "value.required" }
      );
    }
  }
};

/**
 * What can be proven about arguments before a run: the literal parts are
 * checked by the contract's own schema, the rest by its shape.
 */
export const checkArguments = (
  checker: Checker,
  value: JsonValue | undefined,
  schema: ValueSchema<unknown, unknown> | undefined,
  pointer: string,
  site: Site
): void => {
  if (schema !== undefined) {
    checkAgainst(checker, value, schema.descriptor, pointer, site);
  }
};

/**
 * Arguments left out: the contract decides whether nothing, or an empty
 * object, is acceptable. If neither is, what the empty object lacks is
 * reported at `pointer`, the object they would have been in.
 */
export const checkAbsentArguments = (
  checker: Checker,
  schema: ValueSchema<unknown, unknown> | undefined,
  pointer: string,
  site: Site
): void => {
  if (schema === undefined) {
    return;
  }
  // Optional, or with a default: the interpreter accepts it left out.
  if (schema.descriptor.presence !== "required") {
    return;
  }
  const empty = schema["~standard"].validate({});
  if (empty.issues !== undefined) {
    // At the object they would be in: the fields themselves aren't there.
    const issues = empty.issues.map((issue) => ({ ...issue, path: [] }));
    reportIssues(checker, issues, pointer, site);
  }
};

/** A string place that may also be `${ … }`. */
export const textOrExpression = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  limit: number
): void => {
  if (typeof value === "string" && parseSlot(value).kind === "expression") {
    dataValue(checker, value, pointer, taskDefinition, site);
    return;
  }
  textAt(checker, value, pointer, site, limit);
};

export interface TaskMetadata {
  binding?: { value: JsonValue | undefined; pointer: string };
}

export const requireBinding = (
  checker: Checker,
  metadata: TaskMetadata,
  pointer: string,
  site: Site,
  kind: BindingKind
): Binding | undefined => {
  if (metadata.binding === undefined) {
    checker.report.error(
      "profile.missing_property",
      at(
        site,
        pointerJoin(
          pointerJoin(pointerJoin(pointer, "metadata"), "grasp"),
          "binding"
        )
      ),
      `Name the ${kind} binding in metadata.grasp.binding.`,
      { expected: `a ${kind} binding` }
    );
    return undefined;
  }
  return bindingFor(
    checker,
    metadata.binding.value,
    metadata.binding.pointer,
    site,
    kind
  );
};

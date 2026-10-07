import type { ValueSchema } from "@grasp-os/sdk";
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

/**
 * What can be proven about arguments before a run: wholly literal ones are
 * checked by the contract's own schema; an object with expressions in it
 * still has to name the contract's fields and every required one.
 */
export const checkArguments = (
  checker: Checker,
  value: JsonValue | undefined,
  hasExpression: boolean,
  schema: ValueSchema<unknown, unknown> | undefined,
  pointer: string,
  site: Site
): void => {
  if (schema === undefined) {
    return;
  }
  if (!hasExpression) {
    const result = schema["~standard"].validate(value);
    for (const issue of result.issues?.slice(0, maxArgumentIssues) ?? []) {
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
    return;
  }
  const { descriptor } = schema;
  if (!isObject(value) || descriptor.kind !== "object") {
    return;
  }
  const { fields } = descriptor;
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) {
      checker.report.error(
        "call.invalid_arguments",
        at(site, pointerJoin(pointer, key)),
        "Pass only the fields the binding's contract declares.",
        { reason: "value.unknown_key" }
      );
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

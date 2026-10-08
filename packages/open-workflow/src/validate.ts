import type { ValueSchema } from "@grasp-os/sdk";
import { expressionErrors } from "@grasp-os/workflow-expressions/errors";
import type { ExpressionErrorCode } from "@grasp-os/workflow-expressions/errors";
import { compileExpression } from "@grasp-os/workflow-expressions/evaluate";
import type { CompiledExpression } from "@grasp-os/workflow-expressions/evaluate";

import { readOptions } from "./catalog.ts";
import type { BindingKind, ValidateOptions } from "./catalog.ts";
import { createChecker, ReportFullError } from "./checker.ts";
import type { Checker, ExpressionSlot } from "./checker.ts";
import { diagnosticMessages } from "./diagnostics.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { checkDocument } from "./document.ts";
import { checkFlow } from "./flow.ts";
import { parseDefinitionText } from "./json-text.ts";
import type { JsonValue } from "./json-text.ts";
import { profileLimits, profileName } from "./limits.ts";
import { checkReferences } from "./references.ts";

/**
 * Validation of a workflow.json against grasp-open-workflow/1, in the order
 * the profile sets: bounded JSON text (duplicate and prototype keys, size,
 * depth), the profile's structure, native data schemas, the host's
 * contracts, control flow, then every expression compiled by the pinned jq
 * at its stage, with its direct references checked. It never runs the
 * workflow, loads nothing from a network, and claims only what it proves:
 * what depends on run-time data stays with the run's native validation.
 */

/** A definition that passed: what later stages (code generation) build on. */
export interface CheckedWorkflow {
  readonly profile: typeof profileName;
  readonly identity: {
    readonly namespace: string;
    readonly name: string;
    readonly version: string;
  };
  /** The parsed definition, frozen. */
  readonly definition: JsonValue;
  /** Parameter schemas, by name: native SDK schemas. */
  readonly params: ReadonlyMap<string, ValueSchema<unknown, unknown>>;
  /** Bindings the definition uses; declared but unused ones are left out. */
  readonly bindings: ReadonlyMap<
    string,
    { readonly kind: BindingKind; readonly contract: string }
  >;
  /** Every inline data schema, by the pointer to its envelope. */
  readonly schemas: ReadonlyMap<string, ValueSchema<unknown, unknown>>;
  /** Every expression, compiled for its stage, by its pointer. */
  readonly expressions: ReadonlyMap<string, CompiledExpression>;
  /** Every task, with the scope (task IDs) it sits in. */
  readonly tasks: readonly {
    readonly id: string;
    readonly kind: string;
    readonly pointer: string;
    readonly scope: readonly string[];
  }[];
}

export type ValidationResult =
  | {
      readonly ok: true;
      readonly workflow: CheckedWorkflow;
      readonly warnings: readonly Diagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** The message of each expression error, as the family states it. */
const expressionMessages: Readonly<Record<ExpressionErrorCode, string>> = {
  "expression.unsupported_language":
    "Expressions are jq in strict mode; no other language or mode is available.",
  "expression.too_large": "The expression is longer than 4096 bytes.",
  "expression.too_deep": "The expression nests deeper than 32 levels.",
  "expression.scope_too_deep": "The task nests deeper than 16 scopes.",
  "expression.invalid": "The expression isn't valid jq.",
  "expression.unsupported":
    "The expression uses something outside the workflow expression profile.",
  "expression.unavailable_variable":
    "The expression uses a variable that isn't available where it runs.",
  "expression.context_invalid":
    "The expression's input or variables aren't plain JSON within the limits.",
  "expression.context_too_large":
    "The expression's input and variables are over 1 MiB together.",
  "expression.failed": "The expression failed.",
  "expression.resource_exhausted":
    "The expression ran out of its computation or memory budget.",
  "expression.result_count": "The expression must produce exactly one result.",
  "expression.result_too_large": "The expression's result is over 1 MiB.",
  "expression.result_invalid":
    "The expression's result nests deeper than 32 levels, or has a number or key that isn't allowed.",
  "expression.type_mismatch":
    "The expression's result doesn't have the type its place requires.",
};

/** Fixed remedies for the expression errors compiling can give. */
const expressionRemedies: Partial<Record<ExpressionErrorCode, string>> = {
  "expression.too_large": "Shorten the expression to 4096 bytes.",
  "expression.too_deep": "Nest the expression at most 32 levels deep.",
  "expression.scope_too_deep": "Move the task up, or split the workflow.",
  "expression.invalid": "Fix the expression's jq syntax.",
  "expression.unsupported": "Use only the profile's grammar and builtins.",
  "expression.unavailable_variable":
    "Use only the variables of this stage, and loop or catch variables only inside their loop or catch.",
};

/** Compiles one expression; a refusal becomes a diagnostic at its place. */
const compileSlot = async (
  checker: Checker,
  slot: ExpressionSlot
): Promise<CompiledExpression | undefined> => {
  try {
    return await compileExpression(slot.source, {
      stage: slot.stage,
      scope: slot.scope,
      pointer: slot.pointer,
      loopVariables: [...slot.loopVariables, ...slot.errorVariables],
    });
  } catch (error) {
    const code = expressionErrors.codeOf(error);
    if (code === undefined) {
      throw error;
    }
    // Only the code is taken from the expression package: its remedies and
    // reasons can name the source's own variables or quote jq's syntax
    // message. The message and remedy here are fixed text per code; the
    // pointer says where.
    checker.report.add(
      "error",
      code,
      expressionMessages[code],
      { pointer: slot.pointer, taskId: slot.scope.at(-1) },
      expressionRemedies[code] ?? "Fix the expression."
    );
    return undefined;
  }
};

const deepFreeze = (value: JsonValue): JsonValue => {
  // The parser built this tree: no shared references, at most
  // maxDefinitionDepth deep, so one pass is bounded by its size.
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

/**
 * Validates workflow.json, given as its text or its UTF-8 bytes. `options`
 * are the host's: its catalog of approved contracts, the module manifest of
 * the workflow's own code, and its ceilings.
 */
export const validateWorkflow = async (
  input: string | Uint8Array,
  options: ValidateOptions
): Promise<ValidationResult> => {
  let read: ReturnType<typeof readOptions>;
  try {
    read = readOptions(options);
  } catch {
    throw new TypeError(
      "Validation options must be plain data: a catalog, modules and ceilings."
    );
  }
  const parsed = parseDefinitionText(input, {
    maxBytes: profileLimits.maxDefinitionBytes,
    maxDepth: profileLimits.maxDefinitionDepth,
    maxValues: profileLimits.maxDefinitionValues,
  });
  if (!parsed.ok) {
    const { problem } = parsed;
    const diagnostic: Diagnostic = {
      severity: "error",
      code: problem.code,
      message: diagnosticMessages[problem.code],
      pointer: problem.pointer,
      remedy:
        "Send one JSON object within the profile's limits, each key once.",
      ...(problem.reason === undefined ? {} : { reason: problem.reason }),
    };
    return { ok: false, diagnostics: [diagnostic] };
  }
  const checker = createChecker(read);
  const expressions = new Map<string, CompiledExpression>();
  let stopped = false;
  try {
    checkDocument(checker, parsed.value);
    checkFlow(checker);
    // One at a time: each compile is a fresh jq instance, and the count is
    // bounded by maxExpressions.
    for (const slot of checker.slots) {
      // oxlint-disable-next-line no-await-in-loop -- sequential on purpose, see above
      const compiled = await compileSlot(checker, slot);
      if (compiled !== undefined) {
        expressions.set(slot.pointer, compiled);
        checkReferences(checker, slot);
      }
    }
    // Advice last, once every check has run.
    for (const binding of checker.bindings.values()) {
      if (!binding.referenced) {
        checker.report.warning(
          "binding.unreferenced",
          { pointer: binding.pointer },
          "Remove the binding, or use it: only referenced bindings are sealed."
        );
      }
    }
  } catch (error) {
    if (!(error instanceof ReportFullError)) {
      throw error;
    }
    // Validation that stopped early didn't check everything: it fails.
    stopped = true;
  }
  const { diagnostics } = checker.report;
  const { identity } = checker;
  if (stopped || checker.report.errors() > 0 || identity === undefined) {
    return { ok: false, diagnostics: Object.freeze([...diagnostics]) };
  }
  const bindings = new Map<string, { kind: BindingKind; contract: string }>();
  for (const binding of checker.bindings.values()) {
    if (binding.referenced) {
      bindings.set(
        binding.alias,
        Object.freeze({ kind: binding.kind, contract: binding.contractKey })
      );
    }
  }
  const workflow: CheckedWorkflow = Object.freeze({
    profile: profileName,
    identity: Object.freeze(identity),
    definition: deepFreeze(parsed.value),
    params: checker.params,
    bindings,
    schemas: checker.schemas,
    expressions,
    tasks: Object.freeze(
      checker.tasks.map((task) =>
        Object.freeze({
          id: task.id,
          kind: task.kind,
          pointer: task.pointer,
          scope: task.scope,
        })
      )
    ),
  });
  return { ok: true, workflow, warnings: Object.freeze([...diagnostics]) };
};

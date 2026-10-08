/**
 * What validation says about a definition. Every diagnostic names where it
 * is (a JSON Pointer into the definition and, inside a task, the task's
 * stable ID), a stable code to branch on, what was expected and a remedy.
 * None ever repeats a value from the definition: an agent's repair loop and
 * the editor show them as they are.
 */

/** The stable codes, each with the message every diagnostic of it carries. */
export const diagnosticMessages = {
  // Bounded JSON text.
  "json.too_large": "The definition is larger than the profile allows.",
  "json.too_deep": "The definition nests deeper than the profile allows.",
  "json.too_many_values":
    "The definition has more values than the profile allows.",
  "json.invalid": "The definition isn't valid JSON text.",
  "json.invalid_text": "The definition isn't well-formed UTF-8 text.",
  "json.duplicate_key": "An object has the same key twice.",
  "json.prototype_key":
    "An object has a key that reaches the object prototype.",
  "json.invalid_number": "A number is outside the range JSON values may have.",

  // The document and its Grasp metadata.
  "profile.unknown_profile":
    "The definition doesn't declare the grasp-open-workflow/1 profile.",
  "profile.unknown_property": "The property isn't part of the profile here.",
  "profile.missing_property": "A property the profile requires is missing.",
  "profile.invalid_value":
    "The value doesn't have the form the profile requires.",
  "profile.unsupported_dsl": "Only Open Workflow DSL 1.0.3 is supported.",
  "profile.unsupported_feature":
    "The definition uses an Open Workflow feature the profile leaves out.",
  "profile.unsupported_evaluate":
    "Expressions are jq in strict mode; no other language or mode is available.",
  "profile.too_many": "The definition declares more than the profile allows.",
  "profile.limit_above_ceiling": "A limit is above the host's ceiling.",

  // Inline data schemas.
  "schema.unsupported_keyword":
    "The data schema uses a keyword outside the profile's value algebra.",
  "schema.external": "Data schemas are inline; external schemas aren't loaded.",
  "schema.invalid": "The data schema isn't valid.",
  "schema.keyword_not_applicable":
    "The keyword doesn't apply to the schema's type.",
  "schema.open_object":
    "An object schema must set additionalProperties to false.",
  "schema.default_not_allowed": "A default isn't allowed here.",
  "schema.invalid_default": "The default isn't a value its schema accepts.",
  "schema.ambiguous_any_of":
    "Two members of anyOf can accept the same value and normalize it differently.",
  "schema.too_large": "The data schema nests too deep or declares too much.",

  // Tasks, scopes and control flow.
  "task.invalid_id": "A task ID is 1 to 64 characters of kebab-case.",
  "task.duplicate_id": "Task IDs must be unique throughout the definition.",
  "task.not_single_key": "A task list item is an object with exactly one task.",
  "task.unknown_kind": "The task isn't one of the profile's task kinds.",
  "task.ambiguous_kind": "The task has the properties of more than one kind.",
  "task.empty_list": "A task list needs at least one task.",
  "task.scope_too_deep": "Tasks nest deeper than 16 scopes.",
  "task.too_many": "The definition has more tasks than the profile allows.",
  "flow.unknown_target": "The transition names no task in the same scope.",
  "flow.backward_transition":
    "A transition must target a later task in the same scope.",
  "flow.not_allowed": "This transition isn't allowed here.",
  "flow.switch_default":
    "A switch needs exactly one default case, without when, and it must come last.",
  "flow.switch_fallthrough":
    "A switch branch falls through into another branch of the same switch.",
  "flow.cycle": "The definition refers to itself in a cycle.",

  // Expressions.
  "expression.expected": "This place needs a jq expression, not a literal.",
  "expression.unknown_reference":
    "The expression reads a parameter or field that isn't declared.",
  "expression.type_mismatch":
    "The expression's value can't have the type its place requires.",
  "expression.too_many":
    "The definition has more expressions than the profile allows.",

  // Calls, bindings and modules.
  "call.unsupported": "The call isn't one of the profile's named calls.",
  "call.unknown_function": "The call names no reusable function.",
  "call.invalid_arguments": "The call's arguments don't match its contract.",
  "binding.unknown": "The binding names no declared binding alias.",
  "binding.wrong_kind": "The binding's kind doesn't fit where it is used.",
  "binding.unknown_contract":
    "The binding's contract isn't one the host catalog or module manifest has.",
  "binding.contract_mismatch":
    "The binding's contract doesn't allow what the task asks of it.",
  "binding.unreferenced": "The binding is declared but nothing uses it.",
} as const;

export type DiagnosticCode = keyof typeof diagnosticMessages;

/** Expression errors keep the codes of @grasp-os/workflow-expressions. */
export type AnyDiagnosticCode = DiagnosticCode | `expression.${string}`;

export interface Diagnostic {
  /** Errors refuse the definition; warnings are authoring advice. */
  readonly severity: "error" | "warning";
  readonly code: AnyDiagnosticCode;
  readonly message: string;
  /** JSON Pointer (RFC 6901) into the definition. */
  readonly pointer: string;
  /** The stable ID of the task it is in, if any. */
  readonly taskId?: string;
  /** The contract the definition broke, in words. */
  readonly expected?: string;
  /** What to change. */
  readonly remedy: string;
  /** More about what was refused: never a value from the definition. */
  readonly reason?: string;
}

/** The most diagnostics one validation reports; it stops at this many. */
export const maxDiagnostics = 50;

const pointerEscape = /[~/]/gu;

/** A JSON Pointer with one more reference token (RFC 6901). */
export const pointerJoin = (pointer: string, token: string | number): string =>
  `${pointer}/${String(token).replaceAll(pointerEscape, (char) =>
    char === "~" ? "~0" : "~1"
  )}`;

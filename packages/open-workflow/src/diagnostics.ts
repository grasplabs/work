import { schemaProblemMessages } from "@grasp-os/workflow-schema/data-schema";

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

  // The stores a definition declares (stores.ts).
  "profile.unknown_property": "The property isn't part of the profile here.",
  "profile.missing_property": "A property the profile requires is missing.",
  "profile.invalid_value":
    "The value doesn't have the form the profile requires.",
  "profile.too_many": "The definition declares more than the profile allows.",

  // Inline data schemas.
  ...schemaProblemMessages,
} as const;

export type DiagnosticCode = keyof typeof diagnosticMessages;

export interface Diagnostic {
  readonly code: DiagnosticCode;
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

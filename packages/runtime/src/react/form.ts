import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { ActionReference, MutationReference } from "../client-core.ts";
import { useGraspForm } from "../form.ts";
import type {
  DecisionAnswer,
  DecisionFormOptions,
  FormOptionsInput,
  GraspForm,
  FunctionFormOptions,
  SchemaFormOptions,
} from "../form.ts";
import type { FunctionArgs, FunctionReturn } from "../function-references.ts";
import type {
  AnyWorkflowDecisionReference,
  DecisionValueOf,
} from "../workflow-decisions.ts";
import { useClient } from "./provider.ts";

/** `useForm`'s three ways in, each typed by what it binds. */
interface UseForm {
  // First: a decision's reference is no function's, but would pass for
  // one, whose kind is a type alone.
  <Decision extends AnyWorkflowDecisionReference, Result>(
    decision: Decision,
    options: DecisionFormOptions<Decision, Result>
  ): GraspForm<DecisionAnswer<DecisionValueOf<Decision>>, Result>;
  <Reference extends MutationReference | ActionReference>(
    reference: Reference,
    options: FunctionFormOptions<Reference>
  ): GraspForm<FunctionArgs<Reference>, FunctionReturn<Reference>>;
  // A form's values are named fields: an array or a single value has none
  // to render or edit, so a local form's schema takes an object.
  <Schema extends StandardSchemaV1<Readonly<Record<string, unknown>>>, Result>(
    schema: Schema,
    options: SchemaFormOptions<Schema, Result>
  ): GraspForm<StandardSchemaV1.InferInput<Schema>, Result>;
}

/**
 * A form, one hook with three ways in:
 *
 * - `useForm(ref, { defaultValues, onSuccess?, resetOnSuccess? })`: a
 *   public mutation or action, its input the fields, the argument
 *   descriptor its reference carries the validator (core checks again
 *   with its own). The form sends the fields its function requires, and
 *   of its optional fields only those the person changed. To edit a
 *   record, bind a mutation that takes its ID and its fields as optional
 *   (`.optional()`), start `defaultValues` from the record, and patch what
 *   the form sends: two people changing different fields both keep their
 *   changes.
 * - `useForm(schema, { defaultValues, onSubmit })`: a local form, checked
 *   by a native schema, `onSubmit` given its normalized output.
 * - `useForm(workflows.<wf>.decisions.<key>, { defaultValues, onSubmit })`:
 *   the form of an answer to that decision, `{ approved, value }`, its
 *   value checked by the decision's value schema; `onSubmit` passes it to
 *   the run's `respond`.
 *
 * Render it with `Form`, `TextField`, `TextareaField`, `FormError` and
 * `SubmitButton` from `@grasp-os/ui/form`, or custom controls through
 * `form.Field`.
 */
// SAFETY: one implementation serves the two typed ways in above; it
// reads which one it was given at run time (form.ts, `targetOf`).
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
export const useForm = ((target: unknown, options: FormOptionsInput) =>
  useGraspForm(useClient(), target, options)) as UseForm;

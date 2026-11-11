import type { StandardSchemaV1 } from "@standard-schema/spec";
import { useForm as useTanStackForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";

import type {
  ActionReference,
  GraspClient,
  MutationReference,
} from "../client-core.ts";
import { bindForm, graspFormOf } from "../form-binding.ts";
import type {
  DecisionAnswer,
  DecisionFormOptions,
  FormApiOf,
  FormOptionsInput,
  GraspForm,
  FunctionFormOptions,
  SchemaFormOptions,
} from "../form-types.ts";
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
 * The form hook, untyped: what `useForm` types by its three ways in.
 * `client` is the session client.
 */
const useGraspForm = (
  client: GraspClient,
  target: unknown,
  options: FormOptionsInput
): GraspForm<Record<string, unknown>, unknown> => {
  // One binding for the form's life, never replaced: no setter.
  // oxlint-disable-next-line react/hook-use-state -- see above
  const [binding] = useState(() => bindForm(client, target, options));
  const form: FormApiOf<Record<string, unknown>> = useTanStackForm({
    defaultValues: binding.initialValues,
    validators: {
      onChange: binding.validate,
      onBlur: binding.validate,
      onSubmit: binding.validate,
    },
    listeners: {
      onChange: ({ fieldApi }) => {
        binding.fieldChanged(fieldApi.name);
      },
    },
  });
  // The form App code holds, made once around its TanStack form.
  // oxlint-disable-next-line react/hook-use-state -- see above
  const [graspForm] = useState(() => graspFormOf(binding, form));
  useEffect(() => {
    binding.setOptions(options);
  });
  useEffect(() => {
    binding.setMounted(true);
    return () => {
      binding.setMounted(false);
    };
  }, [binding]);
  return graspForm;
};

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
// reads which one it was given at run time (form-target.ts, `targetOf`).
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
export const useForm = ((target: unknown, options: FormOptionsInput) =>
  useGraspForm(useClient(), target, options)) as UseForm;

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  DeepKeys,
  DeepValue,
  FormValidateFn,
  ReactFormExtendedApi,
} from "@tanstack/react-form";

import type { GraspError } from "./client-error.ts";
import type { FunctionArgs, FunctionReturn } from "./function-references.ts";
import type {
  DecisionOutputOf,
  DecisionValueOf,
} from "./workflow-decisions.ts";

// A form's types: what `useForm` takes and answers, and the status a form
// shows beside its fields (form-binding.ts holds it).

/** A form-level validator as TanStack Form runs it. */
export type Validate<Values> = FormValidateFn<Values>;

/** The TanStack Form under a Grasp form, typed by its values. */
export type FormApiOf<Values> = ReactFormExtendedApi<
  Values,
  undefined,
  Validate<Values>,
  undefined,
  Validate<Values>,
  undefined,
  Validate<Values>,
  undefined,
  undefined,
  undefined,
  undefined,
  never
>;

/** Where a submission is. */
export type SubmitPhase =
  /** Nothing in flight: the next submit is a new submission. */
  | "idle"
  /** A submission is in flight; fields are locked. */
  | "submitting"
  /**
   * Whether the submission ran is unknown: fields stay locked. The next
   * submit sends it again under the same key, which gets its outcome from
   * its receipt, a change's or an action's, and never runs it a second
   * time. `discard` gives it up instead.
   */
  | "uncertain";

/** A failure the form shows at its level: a safe code and message. */
export interface FormFailure {
  readonly code: string;
  readonly message: string;
  readonly category: GraspError["category"];
}

/** What a form shows of its submission, beside its fields' own state. */
export interface FormStatus {
  readonly phase: SubmitPhase;
  /** Whether its fields take no edits now: a submission is in flight or unknown. */
  readonly locked: boolean;
  /** Whether a submit was tried: field errors show from then on. */
  readonly attempted: boolean;
  /** Why the last submission failed, at the form's level. */
  readonly failure: FormFailure | undefined;
  /** Server issues of editable fields, by field name. */
  readonly fieldIssues: Readonly<Record<string, string>>;
  /** The save committed, but `onSuccess` failed: what it said. */
  readonly applicationError: string | undefined;
  /**
   * Whether a field's upload is under way: the form doesn't submit until
   * it ends (`form.uploading`), or it would save without the file.
   */
  readonly uploading: boolean;
}

/** A Grasp form: TanStack's typed fields and state, and its submission. */
export interface GraspForm<Values, Result> {
  /** TanStack Form's typed field, for custom controls. */
  readonly Field: FormApiOf<Values>["Field"];
  /** TanStack Form's state subscription. */
  readonly Subscribe: FormApiOf<Values>["Subscribe"];
  /**
   * Validates the whole input and submits it once: the declared result
   * once the outcome is confirmed, or a rejection with a structured
   * error. A submit while one is active joins it.
   */
  readonly submit: () => Promise<Result>;
  /** Discards unsaved edits: back to the initial values. */
  readonly reset: () => void;
  /**
   * Gives up a submission whose outcome is unknown, once the person
   * confirmed it: the fields unlock with what they hold, and the next
   * submit is a new submission. Whether the one given up ran stays
   * unknown; nothing is sent to find out.
   */
  readonly discard: () => void;
}

/** A function-bound form's options. */
export interface FunctionFormOptions<Reference> {
  /** The editable input, as the function takes it. */
  readonly defaultValues: FunctionArgs<Reference>;
  /** After a confirmed outcome, with the function's declared result. */
  readonly onSuccess?: (
    result: FunctionReturn<Reference>
  ) => void | Promise<void>;
  /** Back to `defaultValues` after a confirmed outcome. Off by default. */
  readonly resetOnSuccess?: boolean;
}

/** A local form's options. */
export interface SchemaFormOptions<Schema extends StandardSchemaV1, Result> {
  readonly defaultValues: StandardSchemaV1.InferInput<Schema>;
  /** Gets the schema's normalized output; owns what it does with it. */
  readonly onSubmit: (
    values: StandardSchemaV1.InferOutput<Schema>
  ) => Result | Promise<Result>;
}

/** An answer to a decision, as its form holds it before it is checked. */
export interface DecisionAnswer<Value> {
  readonly approved: boolean;
  readonly value: Value;
}

/** What the form of an answer to the decision `Decision` takes. */
export interface DecisionFormOptions<Decision, Result> {
  readonly defaultValues: DecisionAnswer<DecisionValueOf<Decision>>;
  /** Gets the answer, its value normalized; owns what it does with it. */
  readonly onSubmit: (
    values: DecisionAnswer<DecisionOutputOf<Decision>>
  ) => Result | Promise<Result>;
}

/** The names of a form's fields whose value is text. */
export type TextFieldName<Values> = {
  [Name in DeepKeys<Values>]: DeepValue<Values, Name> extends string | undefined
    ? Name
    : never;
}[DeepKeys<Values>];

/**
 * A callback of any of the typed ways in: a method's parameter is
 * bivariant, so a callback of a narrower argument passes.
 */
type AnyCallback<Result> = {
  // oxlint-disable-next-line typescript/method-signature-style -- bivariant on purpose, see above
  call(value: unknown): Result;
}["call"];

/** The options of either way in, as the hook reads them. */
export interface FormOptionsInput {
  readonly defaultValues?: unknown;
  readonly resetOnSuccess?: boolean;
  readonly onSuccess?: AnyCallback<void | Promise<void>>;
  readonly onSubmit?: AnyCallback<unknown>;
}

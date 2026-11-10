import { canonicalText } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { useForm as useTanStackForm } from "@tanstack/react-form";
import type {
  DeepKeys,
  DeepValue,
  FormValidateFn,
  ReactFormExtendedApi,
} from "@tanstack/react-form";
import { useEffect, useState } from "react";

import { clientInternals } from "./client-core.ts";
import type {
  ActionReference,
  GraspClient,
  MutationReference,
} from "./client-core.ts";
import {
  clientError,
  detailIssues,
  GraspError,
  issueDetails,
  receiptLinkOf,
} from "./client-error.ts";
import type { FunctionArgs, FunctionReturn } from "./function-references.ts";
import { settlesSubmission } from "./refusals.ts";
import { descriptorOf } from "./sealed-descriptors.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { validateValue } from "./value-interpreter.ts";

// Forms: one `useForm`, two ways in.
//
// - `useForm(ref, { defaultValues, onSuccess?, resetOnSuccess? })` binds a
//   public mutation or action: its fields are its input, checked by the
//   argument descriptor its reference carries, built with the App's server
//   code. Core checks the submission again with the function's own
//   validator, and what it refuses shows by the fields it names. It sends
//   the fields the function requires, and of its optional fields only
//   those the person changed since the form opened or last saved, so a
//   mutation that patches what it is sent keeps everyone else's changes
//   to the record's other fields.
// - `useForm(schema, { defaultValues, onSubmit })` is a local form: a
//   native schema validates, `onSubmit` gets its normalized output (a
//   decision's answer, which no App function takes).
//
// TanStack Form holds the values, field state and subscriptions; the
// native interpreter (value-interpreter.ts) is the only validator; the
// session client submits. This module adds what neither does: the
// submission identity and lock, and errors mapped back to fields. Failure
// modes, and how each is closed:
//
// - A double click saves twice: a submit while one is active joins it.
// - A save goes through with what the person kept typing: one snapshot of
//   the arguments is taken per submission; the field helpers lock while
//   it is active.
// - A lost answer turns into a second save: the session client recovers
//   a mutation under its key, which it alone picks. A submission whose
//   outcome is unknown keeps its arguments and the key the client says it
//   went under, and the fields stay locked: the next submit sends both
//   again, which gets its outcome from its receipt: a change's or an
//   action's, never a second run, while the receipt is kept. The person
//   can `discard` it instead, knowingly.
// - One person's submission is sent as another's: the session client
//   sends a key left unknown only for the person it was sent for, and
//   refuses it unsent as `auth.principal_changed` once someone else signed
//   in or access was lost; the form then drops what it kept. A resend
//   refused before it ran (a sign-out, the request budget) keeps it, key
//   and all: the next submit sends it again, never anew.
// - A callback's failure passes for a failed save: `onSuccess` runs once,
//   after the confirmed outcome, for a still-mounted form; what it throws
//   is reported apart, and never resubmits or unlocks.
// - Edits lost by leaving: while the values differ from what was last
//   saved, or a submission is in flight or unknown, the form tells the
//   session client (`GraspClient.guardLeave`), and the host asks before
//   leaving the page.

/** A form-level validator as TanStack Form runs it. */
type Validate<Values> = FormValidateFn<Values>;

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

/**
 * Whether a resend that failed with `error` may not have run (a sign-out,
 * the request budget, a busy sandbox), so its outcome is as unknown as it
 * was: kept, key and all, so the next submit sends it again rather than
 * anew, by the same rule the session client keeps the key's person by.
 * Not once someone else signed in: then it was the person's before. Nor
 * once a decision's answer sent again finds it closed (answered, or past
 * its deadline): a definite end, nothing more to send.
 */
const leavesResendUnknown = (error: GraspError): boolean =>
  error.code !== "auth.principal_changed" &&
  error.code !== "decision.closed" &&
  !settlesSubmission(error);

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

const initialStatus: FormStatus = Object.freeze({
  phase: "idle",
  locked: false,
  attempted: false,
  failure: undefined,
  fieldIssues: Object.freeze({}),
  applicationError: undefined,
  uploading: false,
});

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

/** The names of a form's fields whose value is text. */
export type TextFieldName<Values> = {
  [Name in DeepKeys<Values>]: DeepValue<Values, Name> extends string | undefined
    ? Name
    : never;
}[DeepKeys<Values>];

/** One submission of a form: what it sends, and, once its outcome is unknown, under what. */
interface Submission {
  /** The normalized arguments, or the schema's output, to send. */
  readonly input: unknown;
  /** The key the session client said it went under, its outcome unknown. */
  readonly key?: string;
  /**
   * A local form's call whose outcome is unknown, sent again exactly as
   * it went (`receiptLinkOf`): a decision's answer, never a fresh one,
   * and never by asking its callback again.
   */
  readonly again?: () => Promise<unknown>;
}

/** Whether two plain values are the same, as JSON reads them, whatever their keys' order. */
const same = (a: unknown, b: unknown): boolean => {
  // No value and `null` are two edits, which JSON's text would merge, at
  // any depth: so lists and objects are compared item by item.
  if (a === undefined || b === undefined) {
    return a === b;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item: unknown, index) => same(item, b[index]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => same(a[key], b[key]));
  }
  return canonicalText(a) === canonicalText(b);
};

/**
 * An issue's path as TanStack names the field: `items[0].name`, array
 * indexes in brackets, keys after dots.
 */
const fieldName = (path: StandardSchemaV1.Issue["path"]): string => {
  let name = "";
  for (const segment of path ?? []) {
    const key = typeof segment === "object" ? segment.key : segment;
    if (typeof key === "number") {
      name += `[${key}]`;
    } else {
      name += name === "" ? String(key) : `.${String(key)}`;
    }
  }
  return name;
};

/** The form's own field a TanStack field name lies in: `items` of `items[0].name`. */
const rootField = (name: string): string => name.split(/[.[]/u)[0] ?? "";

/** TanStack's form-level error for `issues`: field errors and the rest. */
const errorsOf = (
  issues: readonly StandardSchemaV1.Issue[],
  editable: (field: string) => boolean
): { form?: string; fields: Record<string, string> } | undefined => {
  if (issues.length === 0) {
    return undefined;
  }
  const fields: Record<string, string> = {};
  const rest: string[] = [];
  for (const issue of issues) {
    const name = fieldName(issue.path);
    if (name !== "" && editable(rootField(name))) {
      fields[name] ??= issue.message;
    } else {
      rest.push(issue.message);
    }
  }
  return rest.length === 0 ? { fields } : { form: rest.join(" "), fields };
};

/** Sends one submission's input through the session client, under its key once it has one. */
type Send = (
  input: unknown,
  options: { readonly idempotencyKey?: string }
) => Promise<unknown>;

/** How a binding validates and submits, by the way the form was made. */
type Target =
  | {
      readonly kind: "function";
      readonly send: Send;
      readonly args: ValueDescriptor;
    }
  | { readonly kind: "schema"; readonly schema: StandardSchemaV1 };

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

/** A structured error's code, message and category, as a form shows them. */
const failureOf = (error: GraspError): FormFailure => ({
  code: error.code,
  message: error.message,
  category: error.category,
});

/** What the form's one validator says of values: issues, or the normalized input. */
type Checked =
  | { readonly issues: readonly StandardSchemaV1.Issue[] }
  | { readonly value: unknown; readonly issues?: undefined };

/** What separates the steps of a field's path: `a.b`, `a[0]`. */
const fieldPathBreak = /[.[\]]/u;
/** A step of a path into an array. */
const arrayIndex = /^\d+$/u;

/** A native schema's descriptor (a `v` schema), or undefined for another vendor's. */
const nativeDescriptorOf = (
  schema: StandardSchemaV1
): ValueDescriptor | undefined => {
  try {
    return descriptorOf(schema);
  } catch {
    return undefined;
  }
};

/** A field's upload, as the form holds it while it runs. */
interface UploadHold {
  /** Whether the edits it was started for are still the form's. */
  readonly current: () => boolean;
  /** It ended: the form may submit once every one has. */
  readonly end: () => void;
}

/**
 * What a form holds beside TanStack's state: its status and the
 * submission in flight. One per mounted form.
 */
export class FormBinding {
  readonly #target: Target;
  readonly #listeners = new Set<() => void>();
  #status: FormStatus = initialStatus;
  #form: FormApiOf<Record<string, unknown>> | undefined;
  #options: FormOptionsInput;
  #pending: Promise<unknown> | undefined;
  /** How many submissions started: a callback speaks only for the latest. */
  #started = 0;
  /** A submission whose outcome is unknown, asked again as it was until discarded. */
  #uncertain: Submission | undefined;
  /** This form, as the session client's leave guard knows it. */
  readonly #owner = {};
  #mounted = true;
  /** The last values checked, and what the check said: one check a submit. */
  #checked:
    | { readonly values: Record<string, unknown>; readonly checked: Checked }
    | undefined;
  /** The values TanStack starts from: never changed after. */
  readonly initialValues: Record<string, unknown>;

  /**
   * Tells the session client whether this form holds unsaved edits or a
   * submission in flight or of unknown outcome (`GraspClient.guardLeave`),
   * for the host to confirm leaving the page while it does.
   */
  readonly #leaveGuard:
    | ((holder: object, guarded: boolean) => void)
    | undefined;
  /** What `#leaveGuard` was told last. */
  #guarded = false;
  /**
   * The values its last successful submission sent, kept in the fields
   * (no `resetOnSuccess`): saved, so not edits to guard.
   */
  #savedValues: Record<string, unknown> | undefined;
  /**
   * The values its last successful submission sent, whatever became of
   * the fields after (a `reset` to the defaults included): what the
   * record holds as far as this form knows, which an edit's optional
   * fields are compared with. None after a submission that reset the
   * form: the next one starts anew.
   */
  #lastSent: Record<string, unknown> | undefined;

  constructor(
    target: Target,
    initialValues: Record<string, unknown>,
    options: FormOptionsInput,
    leaveGuard?: (holder: object, guarded: boolean) => void
  ) {
    this.#leaveGuard = leaveGuard;
    this.#target = target;
    this.#options = options;
    this.initialValues = initialValues;
  }

  /** Connects the binding to its TanStack form, once. */
  attach(form: FormApiOf<Record<string, unknown>>): void {
    this.#form ??= form;
  }

  /**
   * What the form's validator declares of its field `name`, a path as
   * TanStack names fields (`address.city`, `lines[0].amount`): the
   * function's argument, or a native schema's field (a `v.object`). The
   * field helpers read it for what a control offers (an enum's values, a
   * number's bounds, whether it may be left empty); the validator still
   * checks every value. Undefined for a field it doesn't declare, or a
   * local form whose schema isn't Grasp's own.
   */
  fieldDescriptor(name: string): ValueDescriptor | undefined {
    const target = this.#target;
    let descriptor =
      target.kind === "schema"
        ? nativeDescriptorOf(target.schema)
        : target.args;
    for (const step of name.split(fieldPathBreak)) {
      if (step === "" || descriptor === undefined) {
        continue;
      }
      if (descriptor.kind === "object") {
        descriptor = Object.hasOwn(descriptor.fields, step)
          ? descriptor.fields[step]
          : undefined;
      } else if (descriptor.kind === "array" && arrayIndex.test(step)) {
        descriptor = descriptor.item;
      } else {
        descriptor = undefined;
      }
    }
    return descriptor;
  }

  /** The form's status now: what `subscribe` tells of. */
  status(): FormStatus {
    return this.#status;
  }

  /** Tells `onChange` of every change of status; answers how to stop. */
  subscribe(onChange: () => void): () => void {
    this.#listeners.add(onChange);
    return () => {
      this.#listeners.delete(onChange);
    };
  }

  /** Keeps the latest callbacks, as the form last rendered. */
  setOptions(options: FormOptionsInput): void {
    this.#options = options;
  }

  /** The form mounted (committed), or unmounted: callbacks run only while mounted. */
  setMounted(mounted: boolean): void {
    this.#mounted = mounted;
    this.#tellGuard();
  }

  #set(change: Partial<Omit<FormStatus, "locked">>): void {
    const next = { ...this.#status, ...change };
    this.#status = { ...next, locked: next.phase !== "idle" };
    this.#tellGuard();
    for (const listener of this.#listeners) {
      listener();
    }
  }

  /**
   * Whether leaving the page would lose something: while mounted, edits
   * not saved (values changed from where they started or were last
   * saved), or a submission in flight or of unknown outcome.
   * Told to the client only when it changes.
   */
  #tellGuard(): void {
    const guarded =
      this.#mounted &&
      this.#form !== undefined &&
      (this.#status.phase !== "idle" || this.#unsaved());
    if (guarded !== this.#guarded) {
      this.#guarded = guarded;
      this.#leaveGuard?.(this.#owner, guarded);
    }
  }

  /** Whether the values hold edits not saved. */
  #unsaved(): boolean {
    return !same(
      this.#formOf().state.values,
      this.#savedValues ?? this.initialValues
    );
  }

  /** Whether `field` is one the person edits. */
  #editable(field: string): boolean {
    const target = this.#target;
    if (target.kind === "function") {
      // Every argument the function declares is the person's to fill,
      // given a default or not: the form sends nothing else.
      return target.args.kind === "object"
        ? Object.hasOwn(target.args.fields, field)
        : Object.hasOwn(this.initialValues, field);
    }
    return true;
  }

  /** Checks `values` with the form's one validator: issues, or the normalized input. */
  #check(values: Record<string, unknown>): Checked {
    const target = this.#target;
    if (target.kind === "schema") {
      const checked = target.schema["~standard"].validate(values);
      if (checked instanceof Promise) {
        // Grasp's native schemas never answer asynchronously.
        return {
          issues: [{ message: "This form's schema checks asynchronously." }],
        };
      }
      return checked.issues === undefined
        ? { value: checked.value }
        : { issues: checked.issues };
    }
    const checked = validateValue(target.args, values);
    return checked.issues === undefined
      ? { value: checked.value }
      : { issues: checked.issues };
  }

  /** TanStack's form-level validator: the same check, as field errors. */
  readonly validate: Validate<Record<string, unknown>> = ({ value }) => {
    const checked = this.#check(value);
    this.#checked = { values: value, checked };
    return checked.issues === undefined
      ? undefined
      : errorsOf(checked.issues, (field) => this.#editable(field));
  };

  /** A field changed: its server issue is out of date. */
  readonly fieldChanged = (name: unknown): void => {
    if (
      typeof name === "string" &&
      Object.hasOwn(this.#status.fieldIssues, name)
    ) {
      const { [name]: _gone, ...rest } = this.#status.fieldIssues;
      this.#set({ fieldIssues: rest });
      return;
    }
    this.#tellGuard();
  };

  #formOf(): FormApiOf<Record<string, unknown>> {
    if (this.#form === undefined) {
      throw new Error("The form isn't mounted yet.");
    }
    return this.#form;
  }

  /** See `GraspForm.reset`. */
  reset(): void {
    // A submission in flight, or one whose outcome is unknown, keeps its
    // values: they are what it sent, and what asking again sends.
    if (
      this.#status.phase === "submitting" ||
      this.#status.phase === "uncertain"
    ) {
      return;
    }
    this.#savedValues = undefined;
    this.#cancelUploads();
    this.#formOf().reset(this.initialValues, { keepDefaultValues: true });
    this.#set({
      attempted: false,
      failure: undefined,
      fieldIssues: {},
      applicationError: undefined,
    });
  }

  /** See `GraspForm.discard`. */
  discard(): void {
    if (this.#status.phase !== "uncertain") {
      return;
    }
    this.#uncertain = undefined;
    this.#set({ phase: "idle", failure: undefined });
  }

  /** The uploads under way, each by how to cancel it. */
  readonly #uploads = new Map<object, () => void>();

  /**
   * A field's upload started, `cancel` stopping it: the form refuses to
   * submit until every one ended. Discarding the edits (`reset`) cancels
   * them: an upload that still finishes belongs to edits that are gone,
   * and `current` says so, so its file isn't written into the values that
   * replaced them.
   */
  startUpload(cancel: () => void): UploadHold {
    const hold = {};
    this.#uploads.set(hold, cancel);
    this.#set({ uploading: true });
    return {
      current: () => this.#uploads.has(hold),
      end: () => {
        if (this.#uploads.delete(hold)) {
          this.#set({ uploading: this.#uploads.size > 0 });
        }
      },
    };
  }

  /** Cancels every upload under way: what they upload goes with the edits. */
  #cancelUploads(): void {
    const cancels = [...this.#uploads.values()];
    this.#uploads.clear();
    for (const cancel of cancels) {
      cancel();
    }
    if (this.#status.uploading) {
      this.#set({ uploading: false });
    }
  }

  /** See `GraspForm.submit`. */
  async submit(): Promise<unknown> {
    if (this.#uploads.size > 0) {
      throw clientError("form.uploading");
    }
    this.#pending ??= this.#run();
    return await this.#pending;
  }

  async #run(): Promise<unknown> {
    try {
      return await this.#submitOnce();
    } finally {
      this.#pending = undefined;
    }
  }

  /**
   * The submission to send: the one whose outcome is unknown, or a new
   * one; or why the values don't pass, as the schema's issues.
   */
  async #prepare(): Promise<Submission | { readonly issues: Json[] }> {
    if (this.#uncertain !== undefined) {
      return this.#uncertain;
    }
    const form = this.#formOf();
    this.#set({ attempted: true });
    await form.validate("submit");
    // One snapshot of the values, validated and normalized as sent: by the
    // check TanStack's submit just ran, when it ran on these very values.
    const { values } = form.state;
    const checked =
      this.#checked?.values === values
        ? this.#checked.checked
        : this.#check(values);
    if (checked.issues !== undefined) {
      const errors = errorsOf(checked.issues, (field) => this.#editable(field));
      this.#set({
        failure:
          errors?.form === undefined
            ? undefined
            : {
                code: "contract.invalid_args",
                message: errors.form,
                category: "contract",
              },
      });
      return { issues: issueDetails(checked.issues) };
    }
    return { input: this.#changed(checked.value, values) };
  }

  /**
   * What a submission of a function sends of `input`, normalized from
   * `values`: every field its arguments require or fill in with a
   * default, and an optional field only when it differs from what the
   * last save sent (or, before one, the form's defaults), so an edit sends
   * a patch, and one after `reset` sends what the reset put back. A local form's callback gets its whole output.
   */
  #changed(input: unknown, values: Record<string, unknown>): unknown {
    const target = this.#target;
    if (
      target.kind !== "function" ||
      target.args.kind !== "object" ||
      !isPlainObject(input)
    ) {
      return input;
    }
    const { fields } = target.args;
    const before = this.#lastSent ?? this.initialValues;
    return Object.fromEntries(
      Object.entries(input).filter(
        ([name]) =>
          !Object.hasOwn(fields, name) ||
          fields[name]?.presence !== "optional" ||
          !same(values[name], before[name])
      )
    );
  }

  async #submitOnce(): Promise<unknown> {
    this.#started += 1;
    const submission = await this.#prepare();
    if ("issues" in submission) {
      throw clientError("contract.invalid_args", {
        issues: submission.issues,
      });
    }
    this.#set({
      phase: "submitting",
      failure: undefined,
      fieldIssues: {},
      applicationError: undefined,
    });
    const sentValues = this.#formOf().state.values;
    let result: unknown;
    try {
      result = await this.#send(submission);
    } catch (error) {
      throw this.#failed(error, submission);
    }
    this.#uncertain = undefined;
    this.#succeeded(result, sentValues);
    return result;
  }

  /** Sends `submission` through the session client, or the local callback. */
  async #send(submission: Submission): Promise<unknown> {
    const target = this.#target;
    if (target.kind === "schema") {
      return await (submission.again === undefined
        ? this.#options.onSubmit?.(submission.input)
        : submission.again());
    }
    return await target.send(
      submission.input,
      submission.key === undefined ? {} : { idempotencyKey: submission.key }
    );
  }

  /**
   * A submission failed: the values stay, its errors where they belong.
   * Answers the structured error `submit` rejects with: the local
   * callback's own failure as `form.failed`, with its message.
   */
  #failed(error: unknown, submission: Submission): GraspError {
    if (!(error instanceof GraspError)) {
      const failed = clientError(
        "form.failed",
        undefined,
        error instanceof Error && error.message !== ""
          ? error.message
          : undefined
      );
      this.#set({ phase: "idle", failure: failureOf(failed) });
      return failed;
    }
    // An outcome the host or the client can't tell (an action's lost
    // answer, an external effect's unknown result) keeps its identity, the
    // key the client says it went under: the next submit sends it again
    // under it (see `SubmitPhase`), or the person discards it. A local
    // form's callback has no identity to keep, so its failure is a plain
    // one, unless it failed with a call's own (`receiptLinkOf`: a
    // decision's answer): then that call is kept, the fields
    // locked, and the next submit sends it again, never the callback.
    const key = isPlainObject(error.details)
      ? error.details.idempotencyKey
      : undefined;
    if (
      error.category === "uncertain" &&
      this.#target.kind !== "schema" &&
      typeof key === "string"
    ) {
      this.#uncertain = { ...submission, key };
      this.#set({ phase: "uncertain", failure: failureOf(error) });
      return error;
    }
    const again =
      error.category === "uncertain" && this.#target.kind === "schema"
        ? receiptLinkOf(error)
        : undefined;
    if (again !== undefined) {
      this.#uncertain = { ...submission, again };
      this.#set({ phase: "uncertain", failure: failureOf(error) });
      return error;
    }
    if (
      (submission.key !== undefined || submission.again !== undefined) &&
      leavesResendUnknown(error)
    ) {
      this.#set({ phase: "uncertain", failure: failureOf(error) });
      return error;
    }
    // A definite answer settles the submission whose outcome was unknown.
    this.#uncertain = undefined;
    const fieldIssues: Record<string, string> = {};
    let failure: FormFailure | undefined = failureOf(error);
    if (error.code === "contract.invalid_args") {
      const issues = detailIssues(error.details);
      const errors = errorsOf(issues, (field) => this.#editable(field));
      Object.assign(fieldIssues, errors?.fields ?? {});
      // Shown beside its fields when every issue names one; otherwise the
      // rest, or the refusal itself when it names no issue at all, so a
      // refused submit always says why.
      if (errors === undefined) {
        failure = failureOf(error);
      } else if (errors.form === undefined) {
        failure = undefined;
      } else {
        failure = { ...failureOf(error), message: errors.form };
      }
    }
    this.#set({ phase: "idle", failure, fieldIssues });
    return error;
  }

  /** A submission committed: the values saved, the reset and the callback. */
  #succeeded(result: unknown, sentValues: Record<string, unknown>): void {
    // Set first: the guard `#set` tells reads it.
    this.#savedValues =
      this.#options.resetOnSuccess === true ? undefined : sentValues;
    this.#lastSent = this.#savedValues;
    this.#set({ phase: "idle", attempted: false });
    if (this.#options.resetOnSuccess === true) {
      this.#formOf().reset(this.initialValues, { keepDefaultValues: true });
      this.#tellGuard();
    }
    void this.#notify(result, this.#started);
  }

  /**
   * Runs `onSuccess` once, for a mounted form; its failure is its own,
   * shown only while no later submission (`started`) has begun.
   */
  async #notify(result: unknown, started: number): Promise<void> {
    if (this.#options.onSuccess === undefined || !this.#mounted) {
      return;
    }
    try {
      await this.#options.onSuccess(result);
    } catch (error) {
      if (started !== this.#started) {
        return;
      }
      this.#set({
        applicationError:
          error instanceof Error && error.message !== ""
            ? error.message
            : "Saved, but what should happen next failed.",
      });
    }
  }
}

/** Bindings by form, for the field helpers (`bindingOf`). */
const bindings = new WeakMap<object, FormBinding>();

/** The binding of `form`, which `@grasp-os/ui/form`'s helpers read. */
export const bindingOf = (form: object): FormBinding => {
  const binding = bindings.get(form);
  if (binding === undefined) {
    throw new TypeError("That isn't a form useForm made.");
  }
  return binding;
};

/** Whether `value` is a native Standard Schema rather than a reference. */
const isSchema = (value: unknown): value is StandardSchemaV1 =>
  typeof value === "object" &&
  value !== null &&
  "~standard" in value &&
  !("name" in value);

/** The way `target` and `options` make the form, read once. */
const targetOf = (client: GraspClient, target: unknown): Target => {
  if (isSchema(target)) {
    return { kind: "schema", schema: target };
  }
  // A form binds a mutation or an action by its reference's name: its
  // kind and the arguments the form checks with are the page's release's
  // (page-functions.ts), never anything the reference itself carries.
  // Core checks the submission again with the function's own validator,
  // and the form shows what it refuses by the fields it names.
  const internals = clientInternals(client);
  const fn = internals.functionOf(target);
  if (fn === undefined || fn.kind === "query") {
    throw clientError("contract.invalid_request");
  }
  const { kind, args } = fn;
  internals.readReference(target, kind);
  if (kind === "action") {
    const send: Send = async (input, submit) =>
      // SAFETY: read as an action reference just above.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      await client.action(target as ActionReference, input, submit);
    return { kind: "function", send, args };
  }
  const send: Send = async (input, submit) =>
    // SAFETY: read as a mutation reference just above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    await client.mutation(target as MutationReference, input, submit);
  return { kind: "function", send, args };
};

/**
 * The binding of a form of `target` with `options`, submitting through
 * `client`: what `useGraspForm` holds, before its TanStack form is
 * attached.
 */
export const bindForm = (
  client: GraspClient,
  target: unknown,
  options: FormOptionsInput
): FormBinding =>
  new FormBinding(
    targetOf(client, target),
    isPlainObject(options.defaultValues) ? options.defaultValues : {},
    options,
    (holder, guarded) => {
      client.guardLeave(holder, guarded);
    }
  );

/**
 * The form hook, untyped: what `useForm` in react/form.ts types by its two
 * ways in. `client` is the session client.
 */
export const useGraspForm = (
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
  const [graspForm] = useState(() => {
    binding.attach(form);
    const made: GraspForm<Record<string, unknown>, unknown> = {
      Field: form.Field,
      Subscribe: form.Subscribe,
      submit: async () => await binding.submit(),
      reset: () => {
        binding.reset();
      },
      discard: () => {
        binding.discard();
      },
    };
    bindings.set(made, binding);
    return made;
  });
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

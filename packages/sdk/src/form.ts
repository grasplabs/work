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

import type { GraspClient } from "./client-core.ts";
import { clientError, GraspError } from "./client-error.ts";
import type { ArgsOf, OperationReference, ReturnOf } from "./references.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { validateValue } from "./value-interpreter.ts";
import { readDescriptor } from "./value-read.ts";

// Forms (spec 10.2.1–10.3): one `useForm`, three ways in.
//
// - `useForm(ref, { defaultValues, onSuccess?, resetOnSuccess? })` binds a
//   public mutation or action: its fields are the operation's input, and
//   the operation's argument contract is the validator.
// - `useForm(ref, { record, fields, args, onSuccess? })` edits a live
//   document with explicit Save: the chosen fields are editable, `args`
//   maps the captured baseline to the rest, and the baseline stays frozen
//   while there is a draft.
// - `useForm(schema, { defaultValues, onSubmit })` is a local form: a
//   native schema validates, `onSubmit` gets its normalized output.
//
// TanStack Form holds the values, field state and subscriptions; the
// native interpreter (value-interpreter.ts) is the only validator; the
// session client submits. This module adds what neither does: the
// submission identity and lock, the record's baseline, and errors mapped
// back to fields. Failure modes, and how each is closed:
//
// - A double click saves twice: a submit while one is active joins it.
// - A save goes through with what the person kept typing: one snapshot of
//   the arguments is taken per submission; the field helpers lock while
//   it is active.
// - A lost answer turns into a second save: the session client recovers
//   a mutation under its key. A submission whose outcome is unknown keeps
//   its key and its arguments, and the fields stay locked: the next submit
//   sends both again, which gets a change's outcome. An action has no
//   receipt, so it runs again, its completed steps not repeated; the
//   person can `discard` it instead, knowingly.
// - A remote change overwrites a draft: while the editable values differ
//   from the baseline, newer records are only remembered; they replace
//   the draft only on a deliberate `reload()`.
// - An old snapshot regresses a newer one: a record of a lower revision
//   than the one held is ignored.
// - A stale save overwrites someone else's: the save carries the
//   baseline's revision through `args`; `data.conflict` keeps the draft
//   and the baseline until the person reloads.
// - A callback's failure passes for a failed save: `onSuccess` runs once,
//   after the confirmed outcome, for a still-mounted form; what it throws
//   is reported apart, and never resubmits or unlocks.

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
   * submit sends it again under the same key, which gets a change's
   * outcome; an action has no receipt, so it runs again (steps it already
   * completed aren't repeated). `discard` gives it up instead.
   */
  | "uncertain"
  /**
   * The save committed, and the form waits for the record of its
   * commit before another save against the old revision.
   */
  | "syncing";

/** A failure the form shows at its level: a safe code and message. */
export interface FormFailure {
  readonly code: string;
  readonly message: string;
  readonly category: GraspError["category"];
}

/** What a form shows of its submission, beside its fields' own state. */
export interface FormStatus {
  readonly phase: SubmitPhase;
  /** Whether a submit was tried: field errors show from then on. */
  readonly attempted: boolean;
  /** Why the last submission failed, at the form's level. */
  readonly failure: FormFailure | undefined;
  /** Server issues of editable fields, by field name. */
  readonly fieldIssues: Readonly<Record<string, string>>;
  /** Record forms: the save was refused as stale, the draft kept. */
  readonly conflict: boolean;
  /** Record forms: a newer record arrived than the baseline. */
  readonly newer: boolean;
  /** The save committed, but `onSuccess` failed: what it said. */
  readonly applicationError: string | undefined;
}

const initialStatus: FormStatus = Object.freeze({
  phase: "idle",
  attempted: false,
  failure: undefined,
  fieldIssues: Object.freeze({}),
  conflict: false,
  newer: false,
  applicationError: undefined,
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
  /** Discards unsaved edits: back to the initial values, or the record's baseline. */
  readonly reset: () => void;
  /**
   * Gives up a submission whose outcome is unknown, once the person
   * confirmed it: the fields unlock with what they hold, and the next
   * submit is a new submission. Whether the one given up ran stays
   * unknown; nothing is sent to find out.
   */
  readonly discard: () => void;
}

/** A record form: a Grasp form that can adopt the latest record. */
export interface RecordForm<Values, Result> extends GraspForm<Values, Result> {
  /**
   * Discards the draft and adopts the latest record supplied, clearing a
   * conflict: a deliberate step, after the person confirmed losing edits.
   */
  readonly reload: () => void;
}

/** An operation-bound form's options (spec 10.2.1). */
export interface OperationFormOptions<Reference> {
  /** The editable input, as the operation takes it. */
  readonly defaultValues: ArgsOf<Reference>;
  /** After a confirmed outcome, with the operation's declared result. */
  readonly onSuccess?: (result: ReturnOf<Reference>) => void | Promise<void>;
  /** Back to `defaultValues` after a confirmed outcome. Off by default. */
  readonly resetOnSuccess?: boolean;
}

/** The fields of `Doc` and the mutation's arguments alike. */
type SharedKey<Reference, Doc> = Extract<keyof Doc, keyof ArgsOf<Reference>> &
  string;

/**
 * The fields of `Doc` a record form can edit for the mutation: those the
 * mutation takes as arguments, of a type the argument takes.
 */
export type EditableKey<Reference, Doc> = {
  [Key in SharedKey<Reference, Doc>]: Doc[Key] extends ArgsOf<Reference>[Key]
    ? Key
    : never;
}[SharedKey<Reference, Doc>];

/** The arguments `args` maps from the baseline: the rest of the input. */
type RemainingArgs<Reference, Field extends PropertyKey> = Omit<
  ArgsOf<Reference>,
  Field
> &
  Readonly<Partial<Record<Field, never>>>;

/** A record form's options (spec 10.3). */
export interface RecordFormOptions<
  Reference,
  Doc,
  Field extends EditableKey<Reference, Doc>,
> {
  /** The live document, as the parent's query supplies it. */
  readonly record: Doc;
  /** The record's fields the person edits. */
  readonly fields: readonly Field[];
  /** The rest of the arguments, from the captured baseline only. */
  readonly args: (baseline: Doc) => RemainingArgs<Reference, Field>;
  /** After a confirmed save, with the mutation's declared result. */
  readonly onSuccess?: (result: ReturnOf<Reference>) => void | Promise<void>;
}

/** A local form's options (spec 10.2.4). */
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

/** What a submission resolves with: the operation's result, or the callback's. */
interface Submission {
  /** The normalized arguments, or the schema's output, to send. */
  readonly input: unknown;
  /** For an operation: its key, kept across an uncertain outcome. */
  readonly key: string;
}

/** A document's identity and revision, as the SDK binds records by them. */
const identityOf = (
  record: unknown
): { id: unknown; rev: number } | undefined =>
  isPlainObject(record) && typeof record._rev === "number"
    ? { id: record._id, rev: record._rev }
    : undefined;

/** `record`'s values of `fields`. */
const pick = (
  record: unknown,
  fields: readonly string[]
): Record<string, unknown> =>
  Object.fromEntries(
    fields.map((field) => [
      field,
      isPlainObject(record) ? record[field] : undefined,
    ])
  );

/** Whether two plain values are the same, as JSON reads them, whatever their keys' order. */
const same = (a: unknown, b: unknown): boolean =>
  canonicalText(a) === canonicalText(b);

/** A fresh logical submission key: 128 random bits, in hex. */
const freshKey = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

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
    const name = (issue.path ?? [])
      .map((segment) =>
        typeof segment === "object" ? String(segment.key) : String(segment)
      )
      .join(".");
    if (name !== "" && editable(name.split(".")[0] ?? "")) {
      fields[name] ??= issue.message;
    } else {
      rest.push(issue.message);
    }
  }
  return rest.length === 0 ? { fields } : { form: rest.join(" "), fields };
};

/** Sends one submission's input under its key, through the session client. */
type Send = (
  input: unknown,
  options: { readonly idempotencyKey: string }
) => Promise<unknown>;

/** How a binding validates and submits, by the way the form was made. */
type Target =
  | {
      readonly kind: "operation";
      readonly send: Send;
      readonly args: ValueDescriptor;
    }
  | {
      readonly kind: "record";
      readonly send: Send;
      readonly args: ValueDescriptor;
      readonly fields: readonly string[];
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

/** The options of any of the three ways in, as the hook reads them. */
export interface FormOptionsInput {
  readonly defaultValues?: unknown;
  readonly record?: unknown;
  readonly fields?: readonly string[];
  readonly resetOnSuccess?: boolean;
  readonly args?: AnyCallback<unknown>;
  readonly onSuccess?: AnyCallback<void | Promise<void>>;
  readonly onSubmit?: AnyCallback<unknown>;
}

/** A structured error's code, message and category, as a form shows them. */
const failureOf = (error: GraspError): FormFailure => ({
  code: error.code,
  message: error.message,
  category: error.category,
});

/** The issues in a `contract.invalid_args` error's details. */
const issuesIn = (details: Json | undefined): StandardSchemaV1.Issue[] => {
  const issues = isPlainObject(details) ? details.issues : undefined;
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.flatMap((issue) => {
    if (!isPlainObject(issue) || typeof issue.message !== "string") {
      return [];
    }
    const path = Array.isArray(issue.path)
      ? issue.path.filter(
          (segment): segment is string | number =>
            typeof segment === "string" || typeof segment === "number"
        )
      : [];
    return [{ message: issue.message, path }];
  });
};

/**
 * What a form holds beside TanStack's state: its status, the record's
 * baseline and the submission in flight. One per mounted form.
 */
export class FormBinding {
  readonly #target: Target;
  readonly #listeners = new Set<() => void>();
  #status: FormStatus = initialStatus;
  #form: FormApiOf<Record<string, unknown>> | undefined;
  #options: FormOptionsInput;
  #pending: Promise<unknown> | undefined;
  /** A submission whose outcome is unknown, asked again as it was until discarded. */
  #uncertain: Submission | undefined;
  /** The record the draft started from, and the latest supplied. */
  #baseline: unknown;
  #latest: unknown;
  #mounted = true;
  /** The values TanStack starts from: never changed after. */
  readonly initialValues: Record<string, unknown>;

  constructor(
    target: Target,
    initialValues: Record<string, unknown>,
    options: FormOptionsInput
  ) {
    this.#target = target;
    this.initialValues = initialValues;
    this.#options = options;
    this.#baseline = options.record;
    this.#latest = options.record;
  }

  /** Connects the binding to its TanStack form, once. */
  attach(form: FormApiOf<Record<string, unknown>>): void {
    this.#form ??= form;
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

  /** Keeps the latest callbacks and mapper, as the form last rendered. */
  setOptions(options: FormOptionsInput): void {
    this.#options = options;
  }

  /** The form mounted, or unmounted: callbacks run only while mounted. */
  setMounted(mounted: boolean): void {
    this.#mounted = mounted;
  }

  #set(change: Partial<FormStatus>): void {
    this.#status = { ...this.#status, ...change };
    for (const listener of this.#listeners) {
      listener();
    }
  }

  /** Whether `field` is one the person edits. */
  #editable(field: string): boolean {
    const target = this.#target;
    if (target.kind === "record") {
      return target.fields.includes(field);
    }
    if (target.kind === "operation") {
      return Object.hasOwn(this.initialValues, field);
    }
    return true;
  }

  /** The complete input of the values: a record form's with `args(baseline)`. */
  #assembled(values: Record<string, unknown>): unknown {
    if (this.#target.kind !== "record") {
      return values;
    }
    const rest = this.#options.args?.(this.#baseline);
    return { ...(isPlainObject(rest) ? rest : {}), ...values };
  }

  /** Checks `values` with the form's one validator: issues, or the normalized input. */
  #check(
    values: Record<string, unknown>
  ):
    | { readonly issues: readonly StandardSchemaV1.Issue[] }
    | { readonly value: unknown; readonly issues?: undefined } {
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
    const checked = validateValue(target.args, this.#assembled(values));
    return checked.issues === undefined
      ? { value: checked.value }
      : { issues: checked.issues };
  }

  /** TanStack's form-level validator: the same check, as field errors. */
  readonly validate: Validate<Record<string, unknown>> = ({ value }) => {
    const checked = this.#check(value);
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
    }
  };

  #formOf(): FormApiOf<Record<string, unknown>> {
    if (this.#form === undefined) {
      throw new Error("The form isn't mounted yet.");
    }
    return this.#form;
  }

  /** Whether the editable values differ from the record's baseline. */
  #dirty(): boolean {
    const target = this.#target;
    if (target.kind !== "record") {
      return false;
    }
    return !same(
      this.#formOf().state.values,
      pick(this.#baseline, target.fields)
    );
  }

  /** Makes `record` the baseline, and its fields the values. */
  #adopt(record: unknown): void {
    const target = this.#target;
    if (target.kind !== "record") {
      return;
    }
    this.#baseline = record;
    const latest = identityOf(this.#latest);
    const adopted = identityOf(record);
    if (
      latest === undefined ||
      (adopted !== undefined && adopted.rev >= latest.rev)
    ) {
      this.#latest = record;
    }
    this.#formOf().reset(pick(record, target.fields), {
      keepDefaultValues: true,
    });
    this.#set({
      conflict: false,
      newer: false,
      failure: undefined,
      fieldIssues: {},
      attempted: false,
    });
  }

  /**
   * A record the parent supplied (spec 10.3): adopted with its revision
   * while the form is pristine and idle; otherwise remembered for a
   * deliberate reload. A lower revision than the latest is ignored, and
   * another document's identity too: a different record is a remount.
   */
  supply(record: unknown): void {
    if (this.#target.kind !== "record") {
      return;
    }
    const next = identityOf(record);
    const latest = identityOf(this.#latest);
    if (
      next === undefined ||
      latest === undefined ||
      next.id !== latest.id ||
      next.rev < latest.rev ||
      (next.rev === latest.rev && same(record, this.#latest))
    ) {
      return;
    }
    this.#latest = record;
    const { phase, conflict } = this.#status;
    if (phase === "syncing") {
      this.#set({ phase: "idle" });
      this.#adopt(record);
      return;
    }
    if (phase === "idle" && !conflict && !this.#dirty()) {
      this.#adopt(record);
      return;
    }
    this.#set({ newer: true });
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
    const target = this.#target;
    const values =
      target.kind === "record"
        ? pick(this.#baseline, target.fields)
        : this.initialValues;
    this.#formOf().reset(values, { keepDefaultValues: true });
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

  /** See `RecordForm.reload`. */
  reload(): void {
    if (
      this.#status.phase === "submitting" ||
      this.#status.phase === "uncertain"
    ) {
      return;
    }
    this.#set({ phase: "idle" });
    this.#adopt(this.#latest);
  }

  /** See `GraspForm.submit`. */
  async submit(): Promise<unknown> {
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

  /** The submission to send: the one whose outcome is unknown, or a new one. */
  async #prepare(): Promise<Submission | undefined> {
    if (this.#uncertain !== undefined) {
      return this.#uncertain;
    }
    const form = this.#formOf();
    this.#set({ attempted: true });
    await form.validate("submit");
    // One snapshot of the values, validated and normalized as sent.
    const checked = this.#check(form.state.values);
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
      return undefined;
    }
    return { input: checked.value, key: freshKey() };
  }

  async #submitOnce(): Promise<unknown> {
    const { phase } = this.#status;
    if (phase === "syncing") {
      throw clientError("submission.syncing");
    }
    const submission = await this.#prepare();
    if (submission === undefined) {
      throw clientError("contract.invalid_args", {
        issues: [],
      });
    }
    this.#set({
      phase: "submitting",
      failure: undefined,
      applicationError: undefined,
    });
    let result: unknown;
    try {
      result = await this.#send(submission);
    } catch (error) {
      this.#failed(error, submission);
      throw error;
    }
    this.#uncertain = undefined;
    this.#succeeded(result);
    return result;
  }

  /** Sends `submission` through the session client, or the local callback. */
  async #send(submission: Submission): Promise<unknown> {
    const target = this.#target;
    if (target.kind === "schema") {
      return await this.#options.onSubmit?.(submission.input);
    }
    return await target.send(submission.input, {
      idempotencyKey: submission.key,
    });
  }

  /** A submission failed: the draft stays, its errors where they belong. */
  #failed(error: unknown, submission: Submission): void {
    if (!(error instanceof GraspError)) {
      // The local callback's own failure.
      this.#set({
        phase: "idle",
        failure: {
          code: "form.failed",
          message:
            error instanceof Error && error.message !== ""
              ? error.message
              : "This couldn't be submitted.",
          category: "operational",
        },
      });
      return;
    }
    // An outcome the host or the client can't tell (an action's lost
    // answer, an external effect's unknown result) keeps its identity: the
    // next submit sends it again under it (see `SubmitPhase`), or the
    // person discards it. A local form's callback has no identity to
    // keep, so its failure is a plain one.
    if (error.category === "uncertain" && this.#target.kind !== "schema") {
      this.#uncertain = submission;
      this.#set({ phase: "uncertain", failure: failureOf(error) });
      return;
    }
    // A definite answer settles the submission whose outcome was unknown.
    this.#uncertain = undefined;
    const fieldIssues: Record<string, string> = {};
    let failure: FormFailure | undefined = failureOf(error);
    if (error.code === "contract.invalid_args") {
      const issues = issuesIn(error.details);
      const errors = errorsOf(issues, (field) => this.#editable(field));
      Object.assign(fieldIssues, errors?.fields ?? {});
      failure =
        errors?.form === undefined
          ? undefined
          : { ...failureOf(error), message: errors.form };
    }
    this.#set({
      phase: "idle",
      failure,
      fieldIssues,
      conflict: error.code === "data.conflict",
    });
  }

  /** A submission committed: the new baseline, the reset and the callback. */
  #succeeded(result: unknown): void {
    const target = this.#target;
    if (target.kind === "record") {
      const committed = identityOf(result);
      const baseline = identityOf(this.#baseline);
      const latest = identityOf(this.#latest);
      if (
        committed !== undefined &&
        baseline !== undefined &&
        committed.id === baseline.id
      ) {
        this.#set({ phase: "idle" });
        // A newer record supplied while the save was in flight wins: the
        // form is pristine now, and never goes back a revision.
        this.#adopt(
          latest !== undefined && latest.rev > committed.rev
            ? this.#latest
            : result
        );
      } else if (
        latest !== undefined &&
        baseline !== undefined &&
        latest.rev > baseline.rev
      ) {
        // Another shape of result, and the commit's record already came.
        this.#set({ phase: "idle" });
        this.#adopt(this.#latest);
      } else {
        // Another shape of result: the commit's record comes from the query.
        this.#set({ phase: "syncing" });
      }
    } else {
      this.#set({ phase: "idle", attempted: false });
      if (this.#options.resetOnSuccess === true) {
        this.#formOf().reset(this.initialValues, { keepDefaultValues: true });
      }
    }
    void this.#notify(result);
  }

  /** Runs `onSuccess` once, for a mounted form; its failure is its own. */
  async #notify(result: unknown): Promise<void> {
    if (this.#options.onSuccess === undefined || !this.#mounted) {
      return;
    }
    try {
      await this.#options.onSuccess(result);
    } catch (error) {
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
  !("contractId" in value);

/** Whether `value` is a public, single-answer reference of `kind`. */
const isReferenceOf = <Kind extends "mutation" | "action">(
  value: unknown,
  kind: Kind
): value is OperationReference<unknown, unknown, Kind> =>
  isPlainObject(value) &&
  value.kind === kind &&
  value.visibility === "public" &&
  value.mode === "single" &&
  typeof value.contractId === "string";

/** `reference`'s argument descriptor, read as data, or `contract.invalid_request`. */
const argsOf = (reference: { readonly args: unknown }): ValueDescriptor => {
  try {
    return readDescriptor(reference.args, 1, { nodes: 0 });
  } catch {
    throw clientError("contract.invalid_request");
  }
};

/** The way `target` and `options` make the form, read once. */
const targetOf = (
  client: GraspClient,
  target: unknown,
  options: FormOptionsInput
): Target => {
  if (isSchema(target)) {
    return { kind: "schema", schema: target };
  }
  if (isReferenceOf(target, "mutation")) {
    const send: Send = async (input, submit) =>
      await client.mutation(target, input, submit);
    if (options.record !== undefined) {
      const fields = (options.fields ?? []).filter(
        (field) => typeof field === "string"
      );
      return { kind: "record", send, args: argsOf(target), fields };
    }
    return { kind: "operation", send, args: argsOf(target) };
  }
  // A record form binds a mutation only.
  if (isReferenceOf(target, "action") && options.record === undefined) {
    const send: Send = async (input, submit) =>
      await client.action(target, input, submit);
    return { kind: "operation", send, args: argsOf(target) };
  }
  throw clientError("contract.invalid_request");
};

/** The values a form starts from, by the way it is made. */
const initialValuesOf = (
  target: Target,
  options: FormOptionsInput
): Record<string, unknown> => {
  if (target.kind === "record") {
    return pick(options.record, target.fields);
  }
  return isPlainObject(options.defaultValues) ? options.defaultValues : {};
};

/**
 * The form hook, untyped: what `useForm` in react.ts types by its three
 * ways in. `client` is the session client.
 */
export const useGraspForm = (
  client: GraspClient,
  target: unknown,
  options: FormOptionsInput
): RecordForm<Record<string, unknown>, unknown> => {
  // One binding for the form's life, never replaced: no setter.
  // oxlint-disable-next-line react/hook-use-state -- see above
  const [binding] = useState(() => {
    const read = targetOf(client, target, options);
    return new FormBinding(read, initialValuesOf(read, options), options);
  });
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
    const made: RecordForm<Record<string, unknown>, unknown> = {
      Field: form.Field,
      Subscribe: form.Subscribe,
      submit: async () => await binding.submit(),
      reset: () => {
        binding.reset();
      },
      discard: () => {
        binding.discard();
      },
      reload: () => {
        binding.reload();
      },
    };
    bindings.set(made, binding);
    return made;
  });
  const { record } = options;
  useEffect(() => {
    binding.setOptions(options);
  });
  useEffect(() => {
    binding.supply(record);
  }, [binding, record]);
  useEffect(() => {
    binding.setMounted(true);
    return () => {
      binding.setMounted(false);
    };
  }, [binding]);
  return graspForm;
};

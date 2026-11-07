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
  settlesSubmission,
} from "./client-error.ts";
import type { ArgsOf, ReturnOf } from "./references.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { validateValue } from "./value-interpreter.ts";
import { readDescriptor } from "./value-read.ts";
import { descriptorOf } from "./value-schema.ts";

// Forms (spec 10.2.1–10.3): one `useForm`, three ways in.
//
// - `useForm(ref, { defaultValues, onSuccess?, resetOnSuccess? })` binds a
//   public mutation or action: its fields are its input, checked by the
//   argument descriptor its reference carries, built with the App's server
//   code. Core checks the submission again with the function's own
//   validator, and what it refuses shows by the fields it names.
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
//   a mutation under its key, which it alone picks. A submission whose
//   outcome is unknown keeps its arguments and the key the client says it
//   went under, and the fields stay locked: the next submit sends both
//   again, which gets its outcome from its receipt: a change's or an
//   action's, never a second run, while the receipt is kept. The person
//   can `discard` it instead, knowingly.
// - One person's draft is sent as another's: the session client sends a
//   key left unknown only for the person it was sent for, and refuses it
//   unsent as `auth.principal_changed` once someone else signed in or
//   access was lost; the form then drops what it kept. A resend refused
//   before it ran (a sign-out, the request budget) keeps it, key and all:
//   the next submit sends it again, never anew.
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
// - The person can't tell what changed, or must retype to keep their
//   edits: `changes()` compares the draft, its baseline and the latest
//   record field by field, and `reapply()`, a deliberate step, puts the
//   fields the person changed on top of the latest record as a new draft,
//   to review and save. Nothing is merged or saved on its own.

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
  /** Record forms: the save was refused as stale, the draft kept. */
  readonly conflict: boolean;
  /** Record forms: a newer record arrived than the baseline. */
  readonly newer: boolean;
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
  conflict: false,
  newer: false,
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
  /**
   * Puts the fields the person changed on top of the latest record
   * supplied, which becomes the baseline, clearing a conflict: a
   * deliberate step, once the person saw what changed. Nothing is saved;
   * the next save carries the latest record's revision. Does nothing
   * until a newer record than the baseline has arrived.
   */
  readonly reapply: () => void;
}

/** One editable field, as the draft, its baseline and the latest record hold it. */
export interface FieldChange {
  readonly field: string;
  /** As the draft started from. */
  readonly base: unknown;
  /** As the person has it now. */
  readonly draft: unknown;
  /** As the latest record supplied has it. */
  readonly latest: unknown;
  /** Whether the person changed it. */
  readonly mine: boolean;
  /** Whether the latest record changed it since the baseline. */
  readonly theirs: boolean;
}

/** What changed since a record form's draft started. */
export interface RecordChanges {
  /** Whether a newer record than the baseline has arrived. */
  readonly latestKnown: boolean;
  /** The fields the person or the latest record changed, in the form's order. */
  readonly fields: readonly FieldChange[];
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

/** What a record form's options say of a mutation that doesn't answer the record. */
interface AnswersOtherThanRecord {
  readonly "A record form binds a mutation that returns the record": never;
}

/**
 * Nothing, when `Reference` answers the record `Doc`: its document type,
 * or it or `null` for a delete-style save. A save answering anything else
 * says nothing of what the record is now, so it doesn't bind a record form.
 */
export type AnswersRecord<Reference, Doc> = [ReturnOf<Reference>] extends [
  Doc | null,
]
  ? [Doc] extends [ReturnOf<Reference>]
    ? unknown
    : AnswersOtherThanRecord
  : AnswersOtherThanRecord;

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

/** What the form's one validator says of values: issues, or the normalized input. */
type Checked =
  | { readonly issues: readonly StandardSchemaV1.Issue[] }
  | { readonly value: unknown; readonly issues?: undefined };

/**
 * What a form holds beside TanStack's state: its status, the record's
 * baseline and the submission in flight. One per mounted form.
 */
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
export interface UploadHold {
  /** Whether the draft it was started for is still the form's. */
  readonly current: () => boolean;
  /** It ended: the form may submit once every one has. */
  readonly end: () => void;
}

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
  /** The record the draft started from, and the latest supplied. */
  #baseline: unknown;
  #latest: unknown;
  /** This form, as the session client's leave guard knows its holders. */
  readonly #holder = {};
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
   * An operation form's values its last successful submission sent, kept
   * in the fields (no `resetOnSuccess`): saved, so not edits to guard.
   */
  #savedValues: Record<string, unknown> | undefined;

  constructor(
    target: Target,
    initialValues: Record<string, unknown>,
    options: FormOptionsInput,
    leaveGuard?: (holder: object, guarded: boolean) => void
  ) {
    this.#leaveGuard = leaveGuard;
    this.#target = target;
    this.#options = options;
    this.#baseline = options.record;
    this.#latest = options.record;
    this.initialValues = initialValues;
  }

  /** Connects the binding to its TanStack form, once. */
  attach(form: FormApiOf<Record<string, unknown>>): void {
    this.#form ??= form;
  }

  /**
   * What the form's validator declares of its field `name`, a path as
   * TanStack names fields (`address.city`, `lines[0].amount`): the
   * operation's argument, or a native schema's field (a `v.object`). The
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

  /** Keeps the latest callbacks and mapper, as the form last rendered. */
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
   * not saved (a record form's draft, another form's values changed from
   * where they started), or a submission in flight or of unknown outcome.
   * Told to the client only when it changes.
   */
  #tellGuard(): void {
    const guarded =
      this.#mounted &&
      this.#form !== undefined &&
      (this.#status.phase !== "idle" || this.#unsaved());
    if (guarded !== this.#guarded) {
      this.#guarded = guarded;
      this.#leaveGuard?.(this.#holder, guarded);
    }
  }

  /** Whether the values hold edits not saved. */
  #unsaved(): boolean {
    return this.#target.kind === "record"
      ? this.#dirty()
      : !same(
          this.#formOf().state.values,
          this.#savedValues ?? this.initialValues
        );
  }

  /** Whether `field` is one the person edits. */
  #editable(field: string): boolean {
    const target = this.#target;
    if (target.kind === "record") {
      return target.fields.includes(field);
    }
    if (target.kind === "operation") {
      // Every argument the operation declares is the person's to fill,
      // given a default or not: the form sends nothing else.
      return target.args.kind === "object"
        ? Object.hasOwn(target.args.fields, field)
        : Object.hasOwn(this.initialValues, field);
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
    const checked = validateValue(target.args, this.#assembled(values));
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

  /** A field changed: its server issue is out of date, and the leave guard too. */
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
    this.#remember(record);
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

  /** Keeps `record` as the latest supplied, unless one of a later revision is. */
  #remember(record: unknown): void {
    const latest = identityOf(this.#latest);
    const next = identityOf(record);
    if (
      latest === undefined ||
      (next !== undefined && next.rev >= latest.rev)
    ) {
      this.#latest = record;
    }
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
      next.rev < latest.rev
    ) {
      return;
    }
    if (next.rev === latest.rev && same(record, this.#latest)) {
      return;
    }
    this.#remember(record);
    // A record at the baseline's revision or below is one the form holds
    // already, or older: a read sent before a save that answered after it.
    const baseline = identityOf(this.#baseline);
    if (baseline !== undefined && next.rev <= baseline.rev) {
      return;
    }
    const { phase, conflict } = this.#status;
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
    this.#savedValues = undefined;
    this.#cancelUploads();
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
    this.#cancelUploads();
    this.#adopt(this.#latest);
  }

  /** Whether a newer record of the baseline's than the baseline was supplied. */
  #latestIsNewer(): boolean {
    const latest = identityOf(this.#latest);
    const baseline = identityOf(this.#baseline);
    return (
      latest !== undefined &&
      baseline !== undefined &&
      same(latest.id, baseline.id) &&
      latest.rev > baseline.rev
    );
  }

  /** See `RecordChanges`: empty for a form that edits no record. */
  changes(): RecordChanges {
    const target = this.#target;
    if (target.kind !== "record" || this.#form === undefined) {
      return { latestKnown: false, fields: [] };
    }
    const latestKnown = this.#latestIsNewer();
    const base = pick(this.#baseline, target.fields);
    const draft = pick(this.#form.state.values, target.fields);
    const latest = latestKnown ? pick(this.#latest, target.fields) : base;
    const fields = target.fields.flatMap((field) => {
      const mine = !same(draft[field], base[field]);
      const theirs = !same(latest[field], base[field]);
      return mine || theirs
        ? [
            {
              field,
              base: base[field],
              draft: draft[field],
              latest: latest[field],
              mine,
              theirs,
            },
          ]
        : [];
    });
    return { latestKnown, fields };
  }

  /** See `RecordForm.reapply`. */
  reapply(): void {
    const target = this.#target;
    if (
      target.kind !== "record" ||
      this.#status.phase !== "idle" ||
      !this.#latestIsNewer()
    ) {
      return;
    }
    const { fields } = this.changes();
    const latest = this.#latest;
    const values = pick(latest, target.fields);
    for (const change of fields) {
      if (change.mine) {
        values[change.field] = change.draft;
      }
    }
    this.#baseline = latest;
    this.#formOf().reset(values, { keepDefaultValues: true });
    this.#set({
      conflict: false,
      newer: false,
      failure: undefined,
      fieldIssues: {},
      attempted: false,
    });
  }

  /** The uploads under way, each by how to cancel it. */
  readonly #uploads = new Map<object, () => void>();

  /**
   * A field's upload started, `cancel` stopping it: the form refuses to
   * submit until every one ended. Discarding the draft (`reset`,
   * `reload`) cancels them: an upload that still finishes belongs to a
   * draft that is gone, and `current` says so, so its file isn't written
   * into the one that replaced it.
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

  /** Cancels every upload under way: what they upload goes with the draft. */
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
    return { input: checked.value };
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
    const refused = this.#succeeded(result, sentValues);
    if (refused !== undefined) {
      throw refused;
    }
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
   * A submission failed: the draft stays, its errors where they belong.
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
    // decision's answer, spec 10.7.2): then that call is kept, the fields
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
    this.#set({
      phase: "idle",
      failure,
      fieldIssues,
      conflict: error.code === "data.conflict",
    });
    return error;
  }

  /** A submission committed: the new baseline, the reset and the callback. */
  #succeeded(
    result: unknown,
    sentValues: Record<string, unknown>
  ): GraspError | undefined {
    const target = this.#target;
    if (target.kind === "record") {
      const committed = identityOf(result);
      const baseline = identityOf(this.#baseline);
      const latest = identityOf(this.#latest);
      if (result === null) {
        // A delete-style save (`Doc | null`): the record is gone, so
        // there is nothing to adopt, and no later revision of it.
        this.#set({ phase: "idle" });
      } else if (
        committed === undefined ||
        baseline === undefined ||
        committed.id !== baseline.id
      ) {
        // A record form binds a mutation that answers the record it saved
        // (`useForm`'s types say so); anything else says nothing of what
        // the record is now, so nothing is adopted and the values stay.
        const refused = clientError("contract.invalid_result");
        this.#set({ phase: "idle", failure: failureOf(refused) });
        return refused;
      } else {
        this.#set({ phase: "idle" });
        // A newer record supplied while the save was in flight wins: the
        // form is pristine now, and never goes back a revision.
        this.#adopt(
          latest !== undefined && latest.rev > committed.rev
            ? this.#latest
            : result
        );
      }
    } else {
      // Set first: the guard `#set` tells reads it.
      this.#savedValues =
        this.#options.resetOnSuccess === true ? undefined : sentValues;
      this.#set({ phase: "idle", attempted: false });
      if (this.#options.resetOnSuccess === true) {
        this.#formOf().reset(this.initialValues, { keepDefaultValues: true });
        this.#tellGuard();
      }
    }
    void this.#notify(result, this.#started);
    return undefined;
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

/** A reference's argument descriptor, read as data; undefined for anything else. */
const readArgs = (value: unknown): ValueDescriptor | undefined => {
  try {
    return readDescriptor(value, 1, { nodes: 0 });
  } catch {
    return undefined;
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
  // A form binds a mutation or an action: its reference carries its kind
  // and the argument descriptor the form checks with, built with the App's
  // server code. Core checks the submission again with the function's own
  // validator, and the form shows what it refuses by the fields it names.
  const kind = isPlainObject(target) ? target.kind : undefined;
  // A record form binds a mutation only.
  if (
    kind !== "mutation" &&
    (kind !== "action" || options.record !== undefined)
  ) {
    throw clientError("contract.invalid_request");
  }
  clientInternals(client).readReference(target, kind);
  const args = isPlainObject(target) ? readArgs(target.args) : undefined;
  if (args === undefined) {
    throw clientError("contract.invalid_request");
  }
  if (kind === "action") {
    const send: Send = async (input, submit) =>
      // SAFETY: read as an action reference just above.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      await client.action(target as ActionReference, input, submit);
    return { kind: "operation", send, args };
  }
  const send: Send = async (input, submit) =>
    // SAFETY: read as a mutation reference just above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    await client.mutation(target as MutationReference, input, submit);
  if (options.record !== undefined) {
    const fields = (options.fields ?? []).filter(
      (field) => typeof field === "string"
    );
    return { kind: "record", send, args, fields };
  }
  return { kind: "operation", send, args };
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
 * The binding of a form of `target` with `options`, submitting through
 * `client`: what `useGraspForm` holds, before its TanStack form is
 * attached.
 */
export const bindForm = (
  client: GraspClient,
  target: unknown,
  options: FormOptionsInput
): FormBinding => {
  const read = targetOf(client, target, options);
  return new FormBinding(
    read,
    initialValuesOf(read, options),
    options,
    (holder, guarded) => {
      client.guardLeave(holder, guarded);
    }
  );
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
      reapply: () => {
        binding.reapply();
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

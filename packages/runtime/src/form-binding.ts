import { canonicalText, isPlainObject } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { GraspClient } from "./client-core.ts";
import {
  clientError,
  detailIssues,
  GraspError,
  issueDetails,
  receiptLinkOf,
} from "./client-error.ts";
import { errorsOf } from "./form-issues.ts";
import { targetOf } from "./form-target.ts";
import type { Target } from "./form-target.ts";
import type {
  FormApiOf,
  FormFailure,
  FormOptionsInput,
  FormStatus,
  GraspForm,
  Validate,
} from "./form-types.ts";
import { settlesSubmission } from "./refusals.ts";
import { descriptorOf } from "./sealed-descriptors.ts";
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
//   native schema validates, `onSubmit` gets its normalized output.
// - `useForm(decision, { defaultValues, onSubmit })` is the local form of
//   an answer to a workflow's decision (`workflows.<wf>.decisions.<key>`,
//   which no App function takes): `{ approved, value }`, its value checked
//   by that decision's value schema in the page's build, found by the
//   reference's name alone, as a function's is. `respond` and the host
//   check the answer again.
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

const initialStatus: FormStatus = Object.freeze({
  phase: "idle",
  locked: false,
  attempted: false,
  failure: undefined,
  fieldIssues: Object.freeze({}),
  applicationError: undefined,
  uploading: false,
});

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

/**
 * The binding of a form of `target` with `options`, submitting through
 * `client`: what `useForm` (react/form.ts) holds, before its TanStack form is
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
 * The form App code holds, made once around `binding`'s TanStack `form`:
 * what `bindingOf` finds `binding` by.
 */
export const graspFormOf = (
  binding: FormBinding,
  form: FormApiOf<Record<string, unknown>>
): GraspForm<Record<string, unknown>, unknown> => {
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
};

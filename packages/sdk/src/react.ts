/**
 * The React SDK of an App's screens (spec 10.1, 10.7.1): the platform's
 * session client in a component, and the App's queries, mutations and
 * actions through the references the host generated for it (`#grasp`).
 *
 * ```tsx
 * import { useMutation, useQuery } from "@grasp-os/sdk/react";
 * import { api } from "#grasp";
 *
 * export default function Notes() {
 *   const notes = useQuery(api.notes.list, { pagination: { pageSize: 50 } });
 *   const create = useMutation(api.notes.create);
 *   if (notes === undefined) return <p role="status">Loading notes…</p>;
 *   …
 * }
 * ```
 *
 * The platform mounts one `GraspProvider` per App session; a screen never
 * makes a client or mounts a provider. Queries answer their declared
 * value directly, or `undefined` while loading or skipped (`"skip"`): a
 * `null` result is the App's data. A query's failure is thrown while
 * rendering, to the platform's error boundary; a mutation's or action's
 * rejects its promise.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createContext, createElement, use, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { clientInternals, loading } from "./client-core.ts";
import type {
  ActionReference,
  CallArguments,
  GraspClient,
  MutationReference,
  QueryReference,
  QuerySnapshot,
  SubmitOptions,
} from "./client-core.ts";
import { useGraspForm } from "./form.ts";
import type {
  AnswersRecord,
  EditableKey,
  FormOptionsInput,
  GraspForm,
  OperationFormOptions,
  RecordForm,
  RecordFormOptions,
  SchemaFormOptions,
} from "./form.ts";
import type { ArgsOf, ReturnOf } from "./references.ts";

export { GraspError } from "./client-error.ts";
export type { ErrorCategory } from "./client-error.ts";
export type { QueryOptions, SubmitOptions } from "./client-core.ts";
export type {
  FormFailure,
  FormStatus,
  GraspForm,
  OperationFormOptions,
  RecordForm,
  RecordFormOptions,
  SchemaFormOptions,
  SubmitPhase,
  TextFieldName,
} from "./form.ts";

const ClientContext = createContext<GraspClient | null>(null);

/**
 * Hands `client` to the screen below it. The platform mounts it once per
 * App session (screen-runtime.ts); App code never does.
 */
export const GraspProvider = ({
  client,
  children,
}: {
  client: GraspClient;
  children?: ReactNode;
}): ReactNode => createElement(ClientContext, { value: client }, children);

/**
 * The App session's client, for calls made from event handlers:
 * `client.query`, `client.mutation` and `client.action`.
 */
export const useClient = (): GraspClient => {
  const client = use(ClientContext);
  if (client === null) {
    throw new Error(
      "There is no Grasp client here: the platform mounts it around every screen."
    );
  }
  return client;
};

/** A mutation or action as a function: its arguments, then its options. */
export type OperationCallable<Reference> = (
  ...args: CallArguments<Reference, SubmitOptions>
) => Promise<ReturnOf<Reference>>;

const noSubscription = (): (() => void) => () => {
  // Nothing to stop: a skipped query reads nothing.
};

/**
 * The current result of the query `reference` names with `args`, kept up
 * to date: its declared value, or `undefined` while it loads or when
 * `args` is `"skip"`. Check for loading with `=== undefined`. A failure
 * is thrown to the screen's error boundary.
 */
export const useQuery = <Reference extends QueryReference>(
  reference: Reference,
  args: ArgsOf<Reference> | "skip"
): ReturnOf<Reference> | undefined => {
  const internals = clientInternals(useClient());
  const entry = args === "skip" ? undefined : internals.entry(reference, args);
  const snapshot: QuerySnapshot = useSyncExternalStore(
    (onChange) =>
      entry === undefined
        ? noSubscription()
        : internals.subscribe(entry, onChange),
    () => entry?.snapshot ?? loading
  );
  if (snapshot.error !== undefined) {
    throw snapshot.error;
  }
  // SAFETY: the host validated the value against the reference's declared
  // return, which `Reference` carries as its type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return snapshot.value as ReturnOf<Reference> | undefined;
};

/**
 * The mutation `reference` names, as a stable function: each call is one
 * logical submission, resolving with the declared result once the host
 * confirms its commit.
 */
export const useMutation = <Reference extends MutationReference>(
  reference: Reference
): OperationCallable<Reference> => {
  const client = useClient();
  return async (...args) => await client.mutation(reference, ...args);
};

/**
 * The action `reference` names, as a stable function, resolving with its
 * declared result. A lost response is never sent again on its own.
 */
export const useAction = <Reference extends ActionReference>(
  reference: Reference
): OperationCallable<Reference> => {
  const client = useClient();
  return async (...args) => await client.action(reference, ...args);
};

/** `useForm`'s three ways in, each typed by what it binds. */
interface UseForm {
  <
    Reference extends MutationReference,
    Doc,
    Field extends EditableKey<Reference, Doc>,
  >(
    reference: Reference,
    options: RecordFormOptions<Reference, Doc, Field> &
      AnswersRecord<Reference, Doc>
  ): RecordForm<Pick<Doc, Field>, ReturnOf<Reference>>;
  <Reference extends MutationReference | ActionReference>(
    reference: Reference,
    options: OperationFormOptions<Reference>
  ): GraspForm<ArgsOf<Reference>, ReturnOf<Reference>>;
  // A form's values are named fields: an array or a single value has none
  // to render or edit, so a local form's schema takes an object.
  <Schema extends StandardSchemaV1<Readonly<Record<string, unknown>>>, Result>(
    schema: Schema,
    options: SchemaFormOptions<Schema, Result>
  ): GraspForm<StandardSchemaV1.InferInput<Schema>, Result>;
}

/**
 * A form (spec 10.2.1–10.3), one hook with three ways in:
 *
 * - `useForm(ref, { defaultValues, onSuccess?, resetOnSuccess? })`: a
 *   public mutation or action, its input the fields, its argument
 *   contract the validator.
 * - `useForm(ref, { record, fields, args, onSuccess? })`: a live document
 *   edited with explicit Save, through a mutation that returns the record
 *   it saved (or `null`, delete-style); a save answering anything else
 *   fails as `contract.invalid_result`. `fields` are editable; `args` maps the
 *   captured baseline to the rest of the arguments (its ID and revision).
 * - `useForm(schema, { defaultValues, onSubmit })`: a local form, checked
 *   by a native schema, `onSubmit` given its normalized output.
 *
 * Render it with `Form`, `TextField`, `TextareaField`, `FormError` and
 * `SubmitButton` from `@grasp-os/ui/form`, or custom controls through
 * `form.Field`.
 */
// SAFETY: one implementation serves the three typed ways in above; it
// reads which one it was given at run time (form.ts, `targetOf`).
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
export const useForm = ((target: unknown, options: FormOptionsInput) =>
  useGraspForm(useClient(), target, options)) as UseForm;

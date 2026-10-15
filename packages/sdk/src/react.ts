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
import {
  createContext,
  createElement,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import { clientInternals, loading } from "./client-core.ts";
import type {
  ActionReference,
  CallArguments,
  GraspClient,
  MutationReference,
  QueryReference,
  QuerySnapshot,
  StreamReference,
  SubmitOptions,
} from "./client-core.ts";
import { clientError, GraspError } from "./client-error.ts";
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
import type { ArgsOf, ProgressOf, ReturnOf } from "./references.ts";

export { GraspError } from "./client-error.ts";
export type { ErrorCategory } from "./client-error.ts";
export type {
  QueryOptions,
  StreamOptions,
  SubmitOptions,
} from "./client-core.ts";
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
 * The action `reference` names, as a stable function: each call is one
 * logical submission, resolving with its declared result. A lost
 * response is recovered from the action's receipt, never run again.
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

/**
 * What a streaming action shows while `useStream` follows it (spec
 * 10.7.6): `idle` before its first run; `running` while it runs, and
 * `recovering` while its connection is restored, each with its latest
 * progress (null before the first); then `completed` with its output,
 * `failed` with its error, or `cancelled`, each with its last progress.
 */
export type StreamView<Progress, Output> =
  | { readonly status: "idle" }
  | {
      readonly status: "running" | "recovering";
      readonly progress: Progress | null;
    }
  | {
      readonly status: "completed";
      readonly output: Output;
      readonly progress: Progress | null;
    }
  | {
      readonly status: "failed";
      readonly error: GraspError;
      readonly progress: Progress | null;
    }
  | { readonly status: "cancelled"; readonly progress: Progress | null };

/** What `useStream` answers: the view, and how to run and cancel it. */
export type StreamHandle<Reference> = StreamView<
  ProgressOf<Reference>,
  ReturnOf<Reference>
> & {
  /**
   * Runs it, once at a time (`stream.active` while a run is under way):
   * resolves with its validated result, or rejects as `client.stream`.
   */
  readonly run: (
    ...args: CallArguments<Reference, SubmitOptions>
  ) => Promise<ReturnOf<Reference>>;
  /**
   * Cancels the run under way for everyone following it; its view then
   * shows `cancelled` (or `completed`, when it finished first).
   */
  readonly cancel: () => Promise<void>;
};

const idle: StreamView<never, never> = Object.freeze({ status: "idle" });

/** One `useStream`'s run and view: one run at a time, its view a snapshot. */
class StreamRun {
  #view: StreamView<unknown, unknown> = idle;
  readonly #listeners = new Set<() => void>();
  #active = false;
  #release: AbortController | undefined;
  #cancel: (() => Promise<void>) | undefined;
  /** Set once the component let go of the run under way (`release`). */
  #left = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly view = (): StreamView<unknown, unknown> => this.#view;

  #show(view: StreamView<unknown, unknown>): void {
    this.#view = view;
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #progress(): unknown {
    const view = this.#view;
    return view.status === "idle" ? null : view.progress;
  }

  async run(
    client: GraspClient,
    reference: unknown,
    args: unknown,
    options: unknown
  ): Promise<unknown> {
    if (this.#active) {
      throw clientError("stream.active");
    }
    const { signal } =
      typeof options === "object" && options !== null && "signal" in options
        ? options
        : { signal: undefined };
    // Aborted already: nothing starts, as `client.stream` refuses it.
    if (signal instanceof AbortSignal && signal.aborted) {
      throw clientError("submission.cancelled", { sent: false });
    }
    this.#active = true;
    this.#left = false;
    const release = new AbortController();
    this.#release = release;
    const before = this.#view;
    const onAbort = (): void => {
      release.abort();
    };
    if (signal instanceof AbortSignal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    // A new run starts clean: nothing of the last one's progress or output.
    this.#show({ status: "running", progress: null });
    try {
      const output = await clientInternals(client).stream(
        reference,
        args,
        {
          ...(typeof options === "object" && options !== null ? options : {}),
          signal: release.signal,
        },
        {
          onStarted: (cancel) => {
            this.#cancel = cancel;
          },
          onRecovering: () => {
            this.#show({ status: "recovering", progress: this.#progress() });
          },
          onAttached: () => {
            this.#show({ status: "running", progress: this.#progress() });
          },
          onProgress: (progress) => {
            const status =
              this.#view.status === "recovering" ? "recovering" : "running";
            this.#show({ status, progress });
          },
        }
      );
      this.#show({ status: "completed", output, progress: this.#progress() });
      return output;
    } catch (error) {
      if (!this.#left && error instanceof GraspError) {
        this.#show(
          error.code === "operation.cancelled"
            ? { status: "cancelled", progress: this.#progress() }
            : { status: "failed", error, progress: this.#progress() }
        );
      } else if (!this.#left) {
        // Not the action's failure (options it can't take, say): nothing
        // ran, so the view is what it was before.
        this.#show(before);
      }
      throw error;
    } finally {
      if (signal instanceof AbortSignal) {
        signal.removeEventListener("abort", onAbort);
      }
      this.#active = false;
      this.#release = undefined;
      this.#cancel = undefined;
    }
  }

  /** Cancels the run under way for everyone following it. */
  async cancel(): Promise<void> {
    await this.#cancel?.();
  }

  /**
   * Stops this component following its run (it unmounted): the run goes
   * on for anyone else following it, and the host cancels it once no one
   * does.
   */
  release(): void {
    if (this.#release !== undefined) {
      this.#left = true;
      this.#release.abort();
    }
  }
}

/**
 * The streaming action `reference` names (spec 10.7.6), for this
 * component: its view (`StreamView`), and a stable `run` and `cancel`.
 *
 * ```tsx
 * const draft = useStream(api.writer.draft);
 * // In a handler: await draft.run({ topic });
 * if (draft.status === "running" || draft.status === "recovering") {
 *   const text = draft.progress?.text ?? "";
 * }
 * ```
 *
 * Unmounting, or switching to another action or client, stops this
 * component following its run, and the view starts again from `idle`;
 * it never becomes background work: the host cancels a run no one
 * follows.
 */
export const useStream = <Reference extends StreamReference>(
  reference: Reference
): StreamHandle<Reference> => {
  const client = useClient();
  // One run per client and action: another of either starts afresh, and
  // the run of the last is let go of (the effect's cleanup below), so it
  // neither shows the last one's view nor blocks this one.
  const [bound, setBound] = useState(() => ({
    client,
    reference,
    stream: new StreamRun(),
  }));
  let current = bound;
  if (bound.client !== client || bound.reference !== reference) {
    current = { client, reference, stream: new StreamRun() };
    setBound(current);
  }
  const { stream } = current;
  const view = useSyncExternalStore(stream.subscribe, stream.view);
  useEffect(
    () => () => {
      stream.release();
    },
    [stream]
  );
  const run = async (
    ...[args, options]: CallArguments<Reference, SubmitOptions>
  ): Promise<ReturnOf<Reference>> => {
    const output = await stream.run(client, reference, args, options);
    // SAFETY: the host validated the output against the reference's
    // declared return, which `Reference` carries as its type.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return output as ReturnOf<Reference>;
  };
  const cancel = async (): Promise<void> => {
    await stream.cancel();
  };
  // SAFETY: the view holds what the host validated against the
  // reference's `stream` and `returns`, which `Reference` carries.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const typed = view as StreamView<ProgressOf<Reference>, ReturnOf<Reference>>;
  return { ...typed, run, cancel };
};

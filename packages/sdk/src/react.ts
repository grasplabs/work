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
 * rejects its promise. `useWorkflow` is the client side of starting,
 * following and controlling a workflow the App binds; generated workflow
 * references and the host's side of it are still to come (GRA-625,
 * GRA-626), so no App reaches it yet.
 *
 * A query that answers pages is shown as a live list with
 * `usePaginatedQuery`:
 *
 * ```tsx
 * const { items, hasMore, isLoading, loadMore } = usePaginatedQuery(
 *   api.notes.list,
 *   {},
 *   { initialPageSize: 50 },
 * );
 * ```
 */
import { isFileType, isPreviewable } from "@grasp-os/shared/app-file-limits";
import type { FileDescription } from "@grasp-os/shared/app-file-limits";
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

import { clientInternals, loading, skippedPage } from "./client-core.ts";
import type {
  ActionReference,
  CallArguments,
  GraspClient,
  MutationReference,
  PaginatedQueryView,
  PagerSnapshot,
  QueryReference,
  QuerySnapshot,
  StreamReference,
  SubmitOptions,
} from "./client-core.ts";
import { clientError, GraspError } from "./client-error.ts";
import { fileFailure, readFileRef } from "./client-files.ts";
import type {
  Declaring,
  FileRef,
  FileView,
  UploadOptions,
} from "./client-files.ts";
import { readWorkflowReference, workflowChannel } from "./client-workflow.ts";
import type { PaginationResult } from "./database.ts";
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
import type {
  AnyWorkflowReference,
  ArgsOf,
  FilesReference,
  ProgressOf,
  ReturnOf,
  WorkflowInputOf,
  WorkflowOutputOf,
  WorkflowWaitOf,
} from "./references.ts";
import { UploadTransfer } from "./upload-transfer.ts";
import type { UploadView } from "./upload-transfer.ts";
import { WorkflowStore } from "./workflow-store.ts";
import type { WorkflowView } from "./workflow-store.ts";

export { GraspError } from "./client-error.ts";
export type { ErrorCategory } from "./client-error.ts";
export type {
  PaginatedQueryView,
  QueryOptions,
  StreamOptions,
  SubmitOptions,
} from "./client-core.ts";
export type {
  ObservedRun,
  PendingControl,
  WorkflowCommands,
  WorkflowRunView,
  WorkflowView,
} from "./workflow-store.ts";
export type {
  AppErrorPayload,
  RunHandle,
  WorkflowEventReference,
  WorkflowReference,
  WorkflowWait,
} from "./references.ts";
export type {
  DeleteOptions,
  DownloadOptions,
  FileRef,
  FileView,
  UploadOptions,
} from "./client-files.ts";
export type { UploadView } from "./upload-transfer.ts";
export type {
  FieldChange,
  FormFailure,
  FormStatus,
  GraspForm,
  OperationFormOptions,
  RecordChanges,
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

/**
 * A local URL of `preview`, when the file it previews may be previewed
 * (a bounded raster image) and the preview is within that bound: typed
 * as the file was checked to be, whatever type the preview came with.
 */
const previewUrlOf = (
  description: FileDescription,
  preview: Blob | null
): string | null =>
  preview !== null &&
  isFileType(description.mimeType) &&
  isPreviewable(description.mimeType, preview.size)
    ? URL.createObjectURL(new Blob([preview], { type: description.mimeType }))
    : null;

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

/** The record a query of pages answers each of. */
export type PageItemOf<Reference> =
  ReturnOf<Reference> extends PaginationResult<infer Item> ? Item : never;

/**
 * What a paginated list of `Reference` takes besides its options: the
 * query's arguments without `pagination`, which the list supplies; never
 * for a query that doesn't take `pagination` and answer pages.
 */
export type PaginatedArgsOf<Reference> =
  "pagination" extends keyof ArgsOf<Reference>
    ? ReturnOf<Reference> extends PaginationResult<unknown>
      ? Omit<ArgsOf<Reference>, "pagination"> & { readonly pagination?: never }
      : never
    : never;

/** How a paginated list starts. */
export interface PaginatedQueryOptions {
  /**
   * How many records it shows first, and loads more by unless a Load More
   * says: a whole number from 1 to 100.
   */
  readonly initialPageSize: number;
}

/**
 * A live paginated list of the query `reference` names (spec 10.6): one
 * that takes the reserved `pagination` argument and answers pages, read
 * with `args` (its other arguments, or `"skip"`). It shows `items`, the
 * ordered records loaded so far, kept up to date as records are saved,
 * moved or deleted, never with one twice or one missing between pages;
 * `hasMore`; `isLoading`, while the first records or more load; and
 * `loadMore`, stable, which loads `initialPageSize` more (or as many as
 * it is given). Changing `args` or `initialPageSize` starts the list
 * again; equal arguments in a new object don't. A failure is thrown to
 * the screen's error boundary, as a query's is.
 */
export const usePaginatedQuery = <Reference extends QueryReference>(
  reference: Reference,
  args: PaginatedArgsOf<Reference> | "skip",
  options: PaginatedQueryOptions
): PaginatedQueryView<PageItemOf<Reference>> => {
  const internals = clientInternals(useClient());
  const pager =
    args === "skip"
      ? undefined
      : internals.pager(reference, args, options.initialPageSize);
  const snapshot: PagerSnapshot = useSyncExternalStore(
    (onChange) =>
      pager === undefined
        ? noSubscription()
        : internals.subscribePager(pager, onChange),
    () => pager?.snapshot ?? skippedPage
  );
  if (snapshot.error !== undefined) {
    throw snapshot.error;
  }
  // SAFETY: the host validated each page against the reference's declared
  // return, whose records `PageItemOf` names.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return snapshot.view as PaginatedQueryView<PageItemOf<Reference>>;
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

/** What `useUpload` answers: its transfer's view, flat, and its two commands. */
export type UploadHandle = UploadView & {
  /**
   * Uploads `file` through the resource, resolving with its reference once
   * core checked and published it. One at a time: another call while one
   * runs is refused (`file.upload_active`). Aborting `signal` cancels it.
   * Attach the reference to a record with a mutation of the App's; the
   * upload alone shows it to nobody else.
   */
  readonly upload: (file: File, options?: UploadOptions) => Promise<FileRef>;
  /**
   * Cancels the running upload, resolving once core acknowledged it: the
   * view is then cancelled, or completed when publication won.
   */
  readonly cancel: () => Promise<void>;
};

/**
 * An upload through `resource`, a files resource the App declares with
 * `upload` (spec 10.7.5): its view (idle, uploading, verifying, completed,
 * failed or cancelled; while uploading or verifying, `bytesUploaded` of
 * `bytesTotal`) and `upload` and `cancel`.
 *
 * ```tsx
 * const upload = useUpload(resources.attachments);
 * const attach = useMutation(api.notes.attachFile);
 * // In a handler:
 * const file = await upload.upload(picked);
 * await attach({ id: note._id, expectedRevision: note._rev, file });
 * ```
 */
export const useUpload = <Reference extends FilesReference>(
  resource: Declaring<Reference, "upload">
): UploadHandle => {
  const client = useClient();
  // One transfer per client and resource: another of either starts with
  // a transfer of its own, never showing the last one's file or progress,
  // and the last one's upload still running is cancelled.
  const [held, setHeld] = useState(() => ({
    client,
    alias: resource.alias,
    transfer: new UploadTransfer(clientInternals(client)),
  }));
  let current = held;
  if (held.client !== client || held.alias !== resource.alias) {
    current = {
      client,
      alias: resource.alias,
      transfer: new UploadTransfer(clientInternals(client)),
    };
    setHeld(current);
  }
  const { transfer } = current;
  useEffect(
    () => () => {
      // Its failure is the transfer's own state, shown no more.
      const cancelling = async (): Promise<void> => {
        try {
          await transfer.cancel();
        } catch {
          // Nothing waits on it.
        }
      };
      void cancelling();
    },
    [transfer]
  );
  const view = useSyncExternalStore(transfer.subscribe, transfer.view);
  return {
    ...view,
    upload: async (file, options) =>
      await transfer.upload(client.files, resource, file, options),
    cancel: async () => {
      await transfer.cancel();
    },
  };
};

/**
 * What `useFile` last settled: for which client, resource and file, the
 * view, the failure, or that this client deleted it.
 */
interface ShownFile {
  readonly client: GraspClient;
  readonly key: string;
  readonly view?: FileView;
  readonly error?: GraspError;
  readonly gone?: true;
}

/**
 * The file `file` (or nothing, with `"skip"`) through `resource`, a files
 * resource the App declares with `read` (spec 10.7.5): `undefined` while
 * it loads or is skipped, then `{ file, name, mimeType, size, previewUrl }`.
 * A failure is thrown to the screen's error boundary, as a query's is.
 *
 * `null` once the file was deleted through this client while shown, as a
 * query answers `null` for a document that is gone: its preview revoked,
 * nothing read again, and nothing thrown. A screen that removes a file
 * still shows it until its own data catches up (the row a live query
 * lists until the change reaches it), so its deletion is no failure.
 *
 * `previewUrl` is a local URL of a bounded raster image's preview, for an
 * `<img>`, or null; it is revoked when another file is shown, the screen
 * leaves or the person's access changes, and is never a URL to the file
 * elsewhere. When the person's access changes (a fence), the refusal is
 * shown, and nothing is read again until the screen tries again.
 */
export const useFile = <Reference extends FilesReference>(
  resource: Declaring<Reference, "read">,
  file: FileRef | "skip"
): FileView | null | undefined => {
  const client = useClient();
  const internals = clientInternals(client);
  // What the view is of: the resource and the file, read by this client.
  // The resource as first given under its alias: an equal one made anew
  // each render (\`{ ...resources.photos }\`) never reads the file again.
  const [reading, setReading] = useState(resource);
  if (reading.alias !== resource.alias) {
    setReading(resource);
  }
  // A reference core could have minted, checked as download and delete
  // check theirs: anything else is refused here, never read as "skip".
  const id = file === "skip" ? undefined : readFileRef(file).id;
  const key = id === undefined ? undefined : `${resource.alias}/${id}`;
  // The fences as the hook's first render saw them: one between it and
  // the effect is caught by the effect, which never reads past it. After
  // a fence the screen shows the refusal until it is mounted again.
  const [seen, setSeen] = useState(() => ({
    client,
    fences: internals.fences(),
  }));
  // Fences are each client's own: another client starts from its own.
  let fencesSeen = seen.fences;
  if (seen.client !== client) {
    fencesSeen = internals.fences();
    setSeen({ client, fences: fencesSeen });
  }
  const [shown, setShown] = useState<ShownFile>();
  useEffect(() => {
    if (id === undefined || key === undefined) {
      return noSubscription();
    }
    const stop = new AbortController();
    let previewUrl: string | null = null;
    const revoke = (): void => {
      if (previewUrl !== null) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = null;
      }
    };
    // Deleted through this client, once core recorded it, through this
    // resource or another that reads the same file: gone, never read again
    // (core's answer would be that it isn't there).
    const unwatch = internals.onFileDeleted((deleted) => {
      if (deleted === id) {
        stop.abort();
        revoke();
        setShown({ client, key, gone: true });
      }
    });
    const fenced = (): void => {
      stop.abort();
      revoke();
      setShown({
        client,
        key,
        error: internals.fencedBy() ?? clientError("operation.unreachable"),
      });
    };
    const unfence = internals.onFence(fenced);
    if (internals.fences() !== fencesSeen) {
      fenced();
      return () => {
        unwatch();
        unfence();
      };
    }
    const read = async (): Promise<void> => {
      try {
        const { description, preview } = await client.files.read(
          reading,
          { id },
          stop.signal
        );
        if (stop.signal.aborted) {
          return;
        }
        previewUrl = previewUrlOf(description, preview);
        setShown({
          client,
          key,
          view: {
            file: { id: description.id },
            name: description.name,
            mimeType: description.mimeType,
            size: description.size,
            previewUrl,
          },
        });
      } catch (error) {
        if (!stop.signal.aborted) {
          setShown({ client, key, error: fileFailure(error) });
        }
      }
    };
    void read();
    return () => {
      unwatch();
      unfence();
      stop.abort();
      revoke();
      // What this read settled goes with it: its preview is revoked, so a
      // later read of the same file (after a skip, say) starts loading.
      setShown(undefined);
    };
  }, [client, internals, reading, id, key, fencesSeen]);
  // Shown only for what is asked now: another resource, file or client is
  // loading until its own read settles.
  if (shown === undefined || shown.key !== key || shown.client !== client) {
    return undefined;
  }
  if (shown.error !== undefined) {
    throw shown.error;
  }
  if (shown.gone === true) {
    return null;
  }
  return shown.view;
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

/** The view `useWorkflow` answers for `Reference`. */
export type WorkflowViewOf<Reference> = WorkflowView<
  WorkflowInputOf<Reference>,
  WorkflowOutputOf<Reference>,
  WorkflowWaitOf<Reference>
>;

/** The longest run ID a selection takes, as the host's IDs are. */
const maxRunIdLength = 256;

/**
 * One workflow the App binds and one run of it (spec 10.4): the run's
 * view, narrowed by `status`, and stable `run`, `pause`, `resume` and
 * `cancel`, with what may be done now (`canRun`, `canPause`, `canResume`,
 * `canCancel`), whether a start is under way (`isStarting`) and a control
 * still settling (`pendingControl`).
 *
 * ```tsx
 * const summary = useWorkflow(workflows.summarizeNote);
 * // In a handler: await summary.run({ noteId });
 * if (summary.status === "completed") summary.output.summary;
 * if (summary.status === "failed") summary.error.message;
 *
 * const existing = useWorkflow(workflows.summarizeNote, { runId });
 * // In a handler: await existing.cancel();
 * ```
 *
 * Without `runId` it shows the run of its latest admitted start, idle
 * until the first; with one, exactly that run, whatever it starts.
 * Nothing runs or is controlled but by those calls: never on render,
 * remount or reconnect. Unmounting stops following; the run goes on. A
 * run the person may not see, or one of another contract, is thrown
 * while rendering, as a query's failure is; a command's failure rejects
 * its own promise and is never the run's `error`.
 */
export const useWorkflow = <Reference extends AnyWorkflowReference>(
  reference: Reference,
  options?: { readonly runId: string }
): WorkflowViewOf<Reference> => {
  const client = useClient();
  const read = readWorkflowReference(reference);
  if (
    options !== undefined &&
    (typeof options.runId !== "string" ||
      options.runId.length === 0 ||
      options.runId.length > maxRunIdLength)
  ) {
    throw new TypeError("useWorkflow takes { runId }, a run's ID.");
  }
  // One store per client and workflow contract: another of either starts
  // afresh, and the last one's selection, starts and controls show nothing
  // here (its admitted starts still answer their callers).
  const [bound, setBound] = useState(() => ({
    client,
    key: read.key,
    store: new WorkflowStore(workflowChannel(client), read),
  }));
  let current = bound;
  if (bound.client !== client || bound.key !== read.key) {
    current = {
      client,
      key: read.key,
      store: new WorkflowStore(workflowChannel(client), read),
    };
    setBound(current);
  }
  const { store } = current;
  const selection = options === undefined ? null : options.runId;
  const view = useSyncExternalStore(
    (onChange) => store.subscribe(selection, onChange),
    () => store.view(selection)
  );
  const error = store.error(selection);
  if (error !== undefined) {
    throw error;
  }
  // SAFETY: the view holds what the host sent, validated against the
  // reference's own input and output descriptors, which `Reference`
  // carries as its types.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return view as WorkflowViewOf<Reference>;
};

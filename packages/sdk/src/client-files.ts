import type {
  FileDescription,
  FileType,
} from "@grasp-os/shared/app-file-limits";

import { readRejection } from "./call-answers.ts";
import { clientError, GraspError } from "./client-error.ts";
import type { FilesReference } from "./file-link-references.ts";
import { readFileRef, readFilesReference } from "./file-references.ts";
import type { Declaring, FileRef } from "./file-references.ts";
import type { FileTransport, TransferProgress } from "./file-transport.ts";
import { isPlainObject } from "./value-descriptor.ts";

// The session client's files (spec 10.7.5): what `useUpload`, `useFile`
// and `client.files` do with a files resource the App declared, over the
// transport the platform gives the client (`FileTransport`). Bytes never
// travel in a JSON call: the transport hands the file itself to the
// trusted page, which moves its bytes over core's file channel, and
// hands back a file's preview as a `Blob`. Nothing here ever holds a URL
// to a file's bytes elsewhere, or anything that would let one be fetched.
// Failure modes, and how each is closed:
//
// - A page names a resource or operation its App didn't declare: the
//   generated reference is read as data, its operation checked here and
//   again by core against the sealed release (the reference only says
//   what the App declared; it grants nothing).
// - Two transfers overlap in one hook: an upload while one is running is
//   refused (`file.upload_active`), never queued or merged.
// - A cancellation passes for success, or a success for a cancellation:
//   cancelling asks core, which answers what won; an upload published
//   first resolves with its file and shows completed.
// - A preview outlives its file, its page or its reader's access: its
//   URL is a local `blob:` URL of the frame's own, revoked when the hook
//   lets go of it (another file, unmount) or the client is fenced.

const keyPattern = /^[ -~]{1,128}$/u;

/** A transport's rejection as a structured error. */
export const fileFailure = (error: unknown): GraspError => {
  // One the SDK refused itself keeps its own category and details.
  if (error instanceof GraspError) {
    return error;
  }
  const settled = readRejection(error);
  return settled.kind === "failed"
    ? settled.error
    : clientError("function.unreachable");
};

/** The refusal a caller hears once it stopped waiting for its call. */
const stoppedWaiting = (): Error =>
  Object.assign(new Error("Stopped waiting."), { code: "file.stopped" });

/** The platform's file transport, or a refusal when it gave none. */
const required = (transport: FileTransport | undefined): FileTransport => {
  if (transport === undefined) {
    throw clientError("file.channel_unavailable");
  }
  return transport;
};

/** Options of a download. */
export interface DownloadOptions {
  /** Stops waiting for the browser to accept the download. */
  readonly signal?: AbortSignal;
}

/** Options of a deletion. */
export interface DeleteOptions {
  /**
   * Stops waiting; a deletion already sent still goes through, and the
   * views of the file show it gone once core recorded it.
   */
  readonly signal?: AbortSignal;
  /**
   * The caller's key for this deletion: 1 to 128 printable ASCII
   * characters. The same key again answers the first deletion; with
   * another file it is refused (`submission.key_conflict`).
   */
  readonly idempotencyKey?: string;
}

/** Options of an upload. */
export interface UploadOptions {
  /** Cancels the upload, as `cancel()` does. */
  readonly signal?: AbortSignal;
}

export const readSignal = (
  options: unknown,
  allowed: ReadonlySet<string>
): { signal?: AbortSignal; idempotencyKey?: string } => {
  if (options === undefined) {
    return {};
  }
  if (!isPlainObject(options)) {
    throw new TypeError("Call options are an object.");
  }
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new TypeError(`"${key}" isn't an option of this call.`);
    }
  }
  const { signal, idempotencyKey } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("signal is an AbortSignal.");
  }
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== "string" || !keyPattern.test(idempotencyKey))
  ) {
    throw clientError("submission.key_invalid");
  }
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
};

export const signalOnly: ReadonlySet<string> = new Set(["signal"]);
const signalAndKey: ReadonlySet<string> = new Set(["signal", "idempotencyKey"]);

/**
 * `client.files` (spec 10.7.5): downloading and deleting the App's files
 * through a files resource it declares.
 */
export class ClientFiles {
  readonly #transport: FileTransport | undefined;
  readonly #refused: (error: GraspError, startedUnder: number) => void;
  readonly #generation: () => number;
  readonly #deleted: (id: string) => void;

  /**
   * For the session client only: `refused` hears each failure with the
   * client's fence count as its request started (`generation`), so a
   * refusal of one started before a fence never fences the client again;
   * `deleted` hears the id of each file deleted, once core recorded it,
   * so every view of it shows it gone.
   */
  constructor(
    transport: FileTransport | undefined,
    refused: (error: GraspError, startedUnder: number) => void,
    generation: () => number,
    deleted: (id: string) => void
  ) {
    this.#transport = transport;
    this.#refused = refused;
    this.#generation = generation;
    this.#deleted = deleted;
  }

  /** `error`, after the client heard of it (a refusal fences it). */
  #failure(error: unknown, startedUnder: number): GraspError {
    const failure = fileFailure(error);
    this.#refused(failure, startedUnder);
    return failure;
  }

  /**
   * Hands `file` to the browser's own download. Resolves once the browser
   * accepted it, which doesn't say it was saved. No idempotency key: a
   * download changes nothing.
   */
  async download<Reference extends FilesReference>(
    resource: Declaring<Reference, "read">,
    file: FileRef,
    options?: DownloadOptions
  ): Promise<void> {
    const { alias } = readFilesReference(resource, "read");
    const { id } = readFileRef(file);
    const { signal } = readSignal(options, signalOnly);
    const startedUnder = this.#generation();
    try {
      await required(this.#transport).download(alias, id, signal);
    } catch (error) {
      throw this.#failure(error, startedUnder);
    }
  }

  /**
   * Deletes `file`, which its uploader may while no record holds it
   * (`file.referenced` otherwise). Resolves on core's durable record of
   * the deletion; its bytes are removed after.
   */
  async delete<Reference extends FilesReference>(
    resource: Declaring<Reference, "delete">,
    file: FileRef,
    options?: DeleteOptions
  ): Promise<void> {
    const { alias } = readFilesReference(resource, "delete");
    const { id } = readFileRef(file);
    const { signal, idempotencyKey } = readSignal(options, signalAndKey);
    const startedUnder = this.#generation();
    const transport = required(this.#transport);
    // Stopped before it was sent: nothing is sent, so nothing is done.
    if (signal?.aborted === true) {
      throw this.#failure(stoppedWaiting(), startedUnder);
    }
    // Sent, the deletion runs to its own end whatever the caller's signal
    // (which only stops the caller waiting): its views read the file
    // again once core answered, never before core recorded it.
    const deleting = this.#deleting(transport, alias, id, idempotencyKey);
    const { promise: stopped, resolve: stop } =
      Promise.withResolvers<"stopped">();
    const onAbort = (): void => {
      stop("stopped");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let outcome: { readonly failed?: unknown } | "stopped";
    try {
      outcome = await Promise.race([deleting, stopped]);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (outcome === "stopped") {
      throw this.#failure(stoppedWaiting(), startedUnder);
    }
    if ("failed" in outcome) {
      throw this.#failure(outcome.failed, startedUnder);
    }
  }

  /**
   * Deletes file `id` through `alias` to its end, then has its views read
   * it again (`deleted`); settles with why it failed, never rejecting.
   */
  async #deleting(
    transport: FileTransport,
    alias: string,
    id: string,
    idempotencyKey: string | undefined
  ): Promise<{ readonly failed?: unknown }> {
    try {
      await transport.delete(alias, id, idempotencyKey);
    } catch (error) {
      return { failed: error };
    }
    // Gone: each view of it shows it so.
    this.#deleted(id);
    return {};
  }

  /** What `useFile` reads: the description and preview of `file`. */
  async read(
    resource: unknown,
    file: FileRef,
    signal: AbortSignal
  ): Promise<{ description: FileDescription; preview: Blob | null }> {
    const { alias } = readFilesReference(resource, "read");
    const { id } = readFileRef(file);
    const startedUnder = this.#generation();
    try {
      return await required(this.#transport).read(alias, id, signal);
    } catch (error) {
      throw this.#failure(error, startedUnder);
    }
  }

  /**
   * Starts an upload of `file` for `useUpload` (see `UploadTransfer`):
   * `done` settles with it. A resource that can't take one, or no
   * channel, is refused at once, thrown before anything starts, never as
   * a rejection after.
   */
  startUpload(
    resource: unknown,
    file: File,
    cancel: AbortSignal,
    onProgress: (progress: TransferProgress) => void
  ): { readonly done: Promise<FileRef> } {
    const { alias } = readFilesReference(resource, "upload");
    const transport = required(this.#transport);
    return {
      done: this.#uploaded(
        transport,
        alias,
        file,
        cancel,
        onProgress,
        this.#generation()
      ),
    };
  }

  async #uploaded(
    transport: FileTransport,
    alias: string,
    file: File,
    cancel: AbortSignal,
    onProgress: (progress: TransferProgress) => void,
    startedUnder: number
  ): Promise<FileRef> {
    try {
      return {
        id: await transport.upload(alias, file, file.name, {
          cancel,
          onProgress,
        }),
      };
    } catch (error) {
      throw this.#failure(error, startedUnder);
    }
  }
}

/** A file as `useFile` shows it (spec 10.7.5). */
export interface FileView {
  readonly file: FileRef;
  readonly name: string;
  readonly mimeType: FileType;
  readonly size: number;
  /**
   * A local URL of the file's preview, for an `<img>`: a bounded raster
   * image's only, null for any other file. It lives as long as the hook
   * shows this file, and is never a URL to the file elsewhere.
   */
  readonly previewUrl: string | null;
}

import { clientError } from "./client-error.ts";
import type { GraspError } from "./client-error.ts";
import { fileFailure, readSignal, signalOnly } from "./client-files.ts";
import type { ClientFiles, FileRef } from "./client-files.ts";

// One `useUpload` hook's transfer (spec 10.7.5): at most one upload at a
// time, its view kept as an external store the hook reads. The view says
// only what core confirmed: completed once core published the file,
// cancelled once core acknowledged the cancellation, and completed after
// a cancellation that publication won.

/** An upload's view, as `useUpload` shows it (spec 10.7.5). */
export type UploadView =
  | { readonly status: "idle" }
  | {
      readonly status: "uploading" | "verifying";
      readonly bytesUploaded: number;
      readonly bytesTotal: number;
    }
  | { readonly status: "completed"; readonly file: FileRef }
  | { readonly status: "failed"; readonly error: GraspError }
  | { readonly status: "cancelled" };

const idle: UploadView = Object.freeze({ status: "idle" });

/** The upload running, and how to cancel it. */
interface Running {
  readonly cancel: AbortController;
  done?: Promise<FileRef>;
}

/**
 * One hook's transfer: at most one upload at a time (`file.upload_active`
 * for another while one runs), its view as a store `useUpload` reads.
 */
export class UploadTransfer {
  #view: UploadView = idle;
  #running: Running | undefined;
  readonly #listeners = new Set<() => void>();

  /** The view now, as `useSyncExternalStore` reads it. */
  view = (): UploadView => this.#view;

  /** Calls `listener` at every new view, until it is let go. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #show(view: UploadView): void {
    this.#view = view;
    for (const listener of this.#listeners) {
      listener();
    }
  }

  /**
   * Uploads `file` with `files` through `resource`; refused while another
   * upload runs. Aborting `options.signal` cancels it.
   */
  async upload(
    files: ClientFiles,
    resource: unknown,
    file: unknown,
    options?: unknown
  ): Promise<FileRef> {
    const { signal } = readSignal(options, signalOnly);
    if (this.#running !== undefined) {
      throw clientError("file.upload_active");
    }
    if (!(file instanceof File)) {
      throw clientError("contract.invalid_args");
    }
    // Cancelled already: nothing reaches the page, not even a start.
    if (signal?.aborted === true) {
      throw clientError("file.cancelled");
    }
    const running: Running = { cancel: new AbortController() };
    // Forwarded from before the upload starts: an abort while it starts
    // reaches it too.
    const onAbort = (): void => {
      running.cancel.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let done: Promise<FileRef>;
    try {
      // Refused here, before the view changes, when the resource can't
      // take an upload. Its progress shows only while it is this hook's
      // upload, and never once it is being cancelled.
      ({ done } = files.startUpload(
        resource,
        file,
        running.cancel.signal,
        (progress) => {
          if (this.#running === running && !running.cancel.signal.aborted) {
            this.#show({
              status: progress.phase,
              bytesUploaded: progress.bytesUploaded,
              bytesTotal: progress.bytesTotal,
            });
          }
        }
      ));
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      throw error;
    }
    running.done = done;
    this.#running = running;
    this.#show({
      status: "uploading",
      bytesUploaded: 0,
      bytesTotal: file.size,
    });
    try {
      const uploaded = await done;
      this.#show({ status: "completed", file: uploaded });
      return uploaded;
    } catch (error) {
      const failure = fileFailure(error);
      this.#show(
        failure.code === "file.cancelled"
          ? { status: "cancelled" }
          : { status: "failed", error: failure }
      );
      throw failure;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.#running = undefined;
    }
  }

  /**
   * Cancels the running upload, resolving once core acknowledged it: the
   * view is then cancelled, or completed when publication won. Rejects
   * with why when it couldn't be acknowledged (the upload may still be
   * open then). Nothing to do when none runs.
   */
  async cancel(): Promise<void> {
    const running = this.#running;
    if (running?.done === undefined) {
      return;
    }
    running.cancel.abort();
    try {
      await running.done;
    } catch (error) {
      const failure = fileFailure(error);
      if (failure.code !== "file.cancelled") {
        throw failure;
      }
    }
  }
}

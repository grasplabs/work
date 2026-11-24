import type { FileDescription } from "@grasp-os/shared/app-file-limits";

import { readDescription } from "./file-answers.ts";
import { bodyOf, fileRequests } from "./file-requests.ts";
import type { FileRequestsOptions } from "./file-requests.ts";
import { upload } from "./file-upload.ts";
import type { UploadHooks } from "./file-upload.ts";

// The page's side of core's file channel (core's app-file-route.ts): what
// the trusted page around a page's frame does with the files the frame
// hands it, and what a host's own bootstrap would do. It speaks to core
// for one App's page, under that page's lease (file-requests.ts), and
// never hands the frame anything but the outcome: no URL, no lease, no
// request. An upload is file-upload.ts's.

/** A file's body, as core's response: its reader's to stream. */
const unread = async (response: Response): Promise<Response> =>
  await Promise.resolve(response);

/** The file channel of one App's page (see the header). */
export const fileChannel = (options: FileRequestsOptions) => {
  const requests = fileRequests(options);
  const { base, sendAgain } = requests;
  /** The path of file `file` of `resource`. */
  const fileAt = (resource: string, file: string): string =>
    `${base(resource)}/files/${encodeURIComponent(file)}`;

  return {
    /**
     * Uploads `blob` as `name` through `resource`, resuming what breaks
     * under the same upload; answers its ID once core published it.
     */
    upload: async (
      resource: string,
      blob: Blob,
      name: string,
      hooks: UploadHooks
    ): Promise<string> => await upload(requests, resource, blob, name, hooks),
    /** What file `file` is, if the person may read it. */
    describe: async (
      resource: string,
      file: string,
      signal?: AbortSignal
    ): Promise<FileDescription> =>
      await sendAgain(
        fileAt(resource, file),
        {},
        async (response) => readDescription(await bodyOf(response)),
        { cancel: signal, bounded: true }
      ),
    /**
     * File `file`'s bytes, as core's attachment response, its body unread:
     * a download streams it, given up on only once its bytes stop coming.
     */
    content: async (
      resource: string,
      file: string,
      signal?: AbortSignal
    ): Promise<Response> =>
      await sendAgain(`${fileAt(resource, file)}/content`, {}, unread, {
        cancel: signal,
        bounded: "progress",
      }),
    /**
     * The bytes of file `file`, a previewable image, for the page to show
     * in its frame: audited as a preview, never as a download.
     */
    preview: async (
      resource: string,
      file: string,
      signal?: AbortSignal
    ): Promise<Response> =>
      await sendAgain(`${fileAt(resource, file)}/preview`, {}, unread, {
        cancel: signal,
        bounded: "progress",
      }),
    /** Deletes file `file`, under the caller's key if any. */
    delete: async (
      resource: string,
      file: string,
      idempotencyKey?: string,
      signal?: AbortSignal
    ): Promise<void> => {
      await sendAgain(
        `${fileAt(resource, file)}/delete`,
        {
          method: "POST",
          json: idempotencyKey === undefined ? {} : { idempotencyKey },
        },
        async (response) => {
          await response.arrayBuffer();
        },
        { cancel: signal, bounded: true }
      );
    },
  };
};

/** One App's page's file channel. */
export type FileChannel = ReturnType<typeof fileChannel>;

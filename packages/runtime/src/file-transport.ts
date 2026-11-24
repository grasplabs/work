import type { FileDescription } from "@grasp-os/shared/app-file-limits";

/** Where an upload is, as its bytes say. */
export interface TransferProgress {
  readonly phase: "uploading" | "verifying";
  readonly bytesUploaded: number;
  readonly bytesTotal: number;
}

/**
 * What the client needs of the platform to move files: the page's file
 * channel, through the frame's file port (page-runtime.ts), or a host's
 * own. Each rejects with a coded refusal (`{ code, message }`), as the
 * function transport does; one without a code is a lost answer.
 */
export interface FileTransport {
  /**
   * Uploads `file` through `resource` as `name`, reporting its progress,
   * and answers its ID once core published it. Aborting `cancel` cancels
   * it: it then rejects with `file.cancelled`, unless core published it
   * first, when it resolves as usual.
   */
  upload: (
    resource: string,
    file: Blob,
    name: string,
    options: {
      readonly cancel: AbortSignal;
      readonly onProgress: (progress: TransferProgress) => void;
    }
  ) => Promise<string>;
  /** What file `file` is, and a preview of it when it has one. */
  read: (
    resource: string,
    file: string,
    signal?: AbortSignal
  ) => Promise<{ description: FileDescription; preview: Blob | null }>;
  /** Hands file `file` to the browser's own download, once it accepts it. */
  download: (
    resource: string,
    file: string,
    signal?: AbortSignal
  ) => Promise<void>;
  /** Deletes file `file`, resolving on core's durable record of it. */
  delete: (
    resource: string,
    file: string,
    idempotencyKey?: string,
    signal?: AbortSignal
  ) => Promise<void>;
}

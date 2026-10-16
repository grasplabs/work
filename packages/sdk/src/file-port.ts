import type {
  FileDescription,
  FrameFileMessage,
  PageFileMessage,
} from "@grasp-os/shared/app-file-limits";

import type { FileTransport, TransferProgress } from "./client-files.ts";

// The frame's side of its file port (spec 10.7.5): how the session client
// in a screen's frame moves files, through the page, which alone reaches
// core. The frame hands over the file a person picked as it is (a `Blob`,
// cloned by the browser without the frame reading it) and gets back only
// outcomes: a file's ID, its description and preview, or a coded refusal.
// The page answers each call by its number; what the page says is trusted
// as everything else it says to the frame is.

/** A call waiting for the page's answer. */
interface Pending {
  readonly settle: (message: PageFileMessage) => void;
  readonly onProgress?: (progress: TransferProgress) => void;
}

/** A refusal the page answered, with its code. */
const refused = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

/** The file transport of a frame whose page listens on `port`. */
export const portFileTransport = (port: MessagePort): FileTransport => {
  const pending = new Map<number, Pending>();
  let calls = 0;

  port.addEventListener("message", (event: MessageEvent<PageFileMessage>) => {
    const message = event.data;
    const waiting = pending.get(message.call);
    if (waiting === undefined) {
      return;
    }
    if (message.type === "progress") {
      waiting.onProgress?.({
        phase: message.phase,
        bytesUploaded: message.bytesUploaded,
        bytesTotal: message.bytesTotal,
      });
      return;
    }
    pending.delete(message.call);
    waiting.settle(message);
  });
  port.start();

  /**
   * Sends `message` (made for its call's number) and waits for the page's
   * answer; aborting `signal` tells the page to stop (`stop`), or, for an
   * upload, to cancel (`cancel`, whose answer still settles the call).
   */
  const call = async (
    make: (call: number) => FrameFileMessage,
    {
      signal,
      cancels = false,
      onProgress,
    }: {
      readonly signal?: AbortSignal;
      readonly cancels?: boolean;
      readonly onProgress?: (progress: TransferProgress) => void;
    } = {}
  ): Promise<PageFileMessage> => {
    // Stopped before it was sent: nothing is sent, so nothing is done. An
    // upload, cancelled, is acknowledged by the page as ever.
    if (signal?.aborted === true && !cancels) {
      throw refused("file.stopped", "Stopped waiting.");
    }
    calls += 1;
    const number = calls;
    const { promise, resolve, reject } =
      Promise.withResolvers<PageFileMessage>();
    pending.set(number, {
      settle: (message) => {
        if (message.type === "failed") {
          reject(refused(message.error.code, message.error.message));
        } else {
          resolve(message);
        }
      },
      ...(onProgress === undefined ? {} : { onProgress }),
    });
    const onAbort = (): void => {
      if (cancels) {
        port.postMessage({ type: "cancel", call: number });
        return;
      }
      pending.delete(number);
      port.postMessage({ type: "stop", call: number });
      reject(refused("file.stopped", "Stopped waiting."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // One the browser can't send (it can't clone it) is no call: nothing
      // waits for its answer, and its signal stops nothing later.
      try {
        port.postMessage(make(number));
      } catch (error) {
        pending.delete(number);
        throw error;
      }
      if (signal?.aborted === true) {
        onAbort();
      }
      return await promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };

  return {
    upload: async (resource, file, name, { cancel, onProgress }) => {
      const answer = await call(
        (number) => ({ type: "upload", call: number, resource, file, name }),
        { signal: cancel, cancels: true, onProgress }
      );
      if (answer.type !== "uploaded") {
        throw new Error("The page answered an upload with something else.");
      }
      return answer.file;
    },
    read: async (
      resource,
      file,
      signal
    ): Promise<{ description: FileDescription; preview: Blob | null }> => {
      const answer = await call(
        (number) => ({ type: "read", call: number, resource, file }),
        signal === undefined ? {} : { signal }
      );
      if (answer.type !== "read") {
        throw new Error("The page answered a read with something else.");
      }
      return { description: answer.description, preview: answer.preview };
    },
    download: async (resource, file, signal) => {
      await call(
        (number) => ({ type: "download", call: number, resource, file }),
        signal === undefined ? {} : { signal }
      );
    },
    delete: async (resource, file, idempotencyKey, signal) => {
      await call(
        (number) => ({
          type: "delete",
          call: number,
          resource,
          file,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        }),
        signal === undefined ? {} : { signal }
      );
    },
  };
};

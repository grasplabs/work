import { describe, expect, it } from "vite-plus/test";

import { GraspClient } from "../src/client-core.ts";
import { GraspError } from "../src/client-error.ts";
import type { FileTransport, TransferProgress } from "../src/client-files.ts";
import { UploadTransfer } from "../src/upload-transfer.ts";

// One `useUpload` hook's transfer (spec 10.7.5), against the page's side
// of the file port, which these tests play: the page is outside the
// frame, and what it answers (progress, a published file, a cancellation
// that won or lost) is what the transfer must show, no more. One upload
// at a time; a cancellation that publication beat resolves completed.

/** An upload the page has under way, which the test settles. */
interface PageUpload {
  readonly cancel: AbortSignal;
  readonly progress: (progress: TransferProgress) => void;
  readonly publish: (id: string) => void;
  readonly refuse: (code: string) => void;
}

/** The page, as the frame's file port reaches it: uploads only. */
const page = () => {
  const uploads: PageUpload[] = [];
  const files: FileTransport = {
    upload: async (_resource, _file, _name, { cancel, onProgress }) => {
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      uploads.push({
        cancel,
        progress: onProgress,
        publish: resolve,
        refuse: (code) => {
          reject(Object.assign(new Error(code), { code }));
        },
      });
      return await promise;
    },
    read: async () => await Promise.reject(new Error("Not read here")),
    download: async () => {
      await Promise.reject(new Error("Not read here"));
    },
    delete: async () => {
      await Promise.reject(new Error("Not read here"));
    },
  };
  const client = new GraspClient({
    call: async () => await Promise.reject(new Error("No calls here")),
    watch: async () => await Promise.reject(new Error("No follows here")),
    files,
  });
  return {
    client,
    /** The page's `index`-th upload, once the transfer sent it. */
    upload: (index: number): PageUpload => {
      const found = uploads[index];
      if (found === undefined) {
        throw new Error(`No upload ${index}`);
      }
      return found;
    },
  };
};

const resource = {
  kind: "files",
  alias: "attachments",
  operations: ["upload", "read"],
} as const;

const photo = new File([new Uint8Array(10)], "photo.png", {
  type: "image/png",
});

/** Why `promise` rejected: its structured error's code. */
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraspError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("It resolved");
};

describe("an upload's transfer", () => {
  it("shows the bytes the page reports, then the file core published", async () => {
    const { client, upload } = page();
    const transfer = new UploadTransfer();
    const done = transfer.upload(client.files, resource, photo);
    expect(transfer.view()).toStrictEqual({
      status: "uploading",
      bytesUploaded: 0,
      bytesTotal: 10,
    });
    upload(0).progress({
      phase: "verifying",
      bytesUploaded: 10,
      bytesTotal: 10,
    });
    expect(transfer.view()).toStrictEqual({
      status: "verifying",
      bytesUploaded: 10,
      bytesTotal: 10,
    });
    upload(0).publish("file-1");
    await expect(done).resolves.toStrictEqual({ id: "file-1" });
    expect(transfer.view()).toStrictEqual({
      status: "completed",
      file: { id: "file-1" },
    });
  });

  it("sends nothing to the page for an upload cancelled before it starts", async () => {
    const { client, upload } = page();
    const transfer = new UploadTransfer();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      codeOf(
        transfer.upload(client.files, resource, photo, {
          signal: cancelled.signal,
        })
      )
    ).resolves.toBe("file.cancelled");
    expect(() => upload(0)).toThrow("No upload 0");
  });

  it("refuses a second upload while one runs, without disturbing it", async () => {
    const { client, upload } = page();
    const transfer = new UploadTransfer();
    const first = transfer.upload(client.files, resource, photo);
    await expect(
      codeOf(transfer.upload(client.files, resource, photo))
    ).resolves.toBe("file.upload_active");
    upload(0).publish("file-1");
    await expect(first).resolves.toStrictEqual({ id: "file-1" });
    // Once it settled, another may start.
    const second = transfer.upload(client.files, resource, photo);
    upload(1).publish("file-2");
    await expect(second).resolves.toStrictEqual({ id: "file-2" });
  });

  it("shows a cancellation once the page acknowledged it, and completed when publication won", async () => {
    const { client, upload } = page();
    const transfer = new UploadTransfer();
    const cancelled = transfer.upload(client.files, resource, photo);
    const acknowledged = transfer.cancel();
    expect(upload(0).cancel.aborted).toBeTruthy();
    upload(0).refuse("file.cancelled");
    await acknowledged;
    await expect(codeOf(cancelled)).resolves.toBe("file.cancelled");
    expect(transfer.view()).toStrictEqual({ status: "cancelled" });

    // The caller's signal cancels too; core published first.
    const stop = new AbortController();
    const won = transfer.upload(client.files, resource, photo, {
      signal: stop.signal,
    });
    stop.abort();
    upload(1).publish("file-3");
    await expect(won).resolves.toStrictEqual({ id: "file-3" });
    expect(transfer.view()).toStrictEqual({
      status: "completed",
      file: { id: "file-3" },
    });
  });

  it("rejects a cancellation the page couldn't get acknowledged with why", async () => {
    const { client, upload } = page();
    const transfer = new UploadTransfer();
    const running = transfer.upload(client.files, resource, photo);
    const cancelling = transfer.cancel();
    upload(0).refuse("operation.unreachable");
    await expect(codeOf(cancelling)).resolves.toBe("operation.unreachable");
    await expect(codeOf(running)).resolves.toBe("operation.unreachable");
    expect(transfer.view()).toMatchObject({ status: "failed" });
  });

  it("refuses a file that isn't one core could have minted at once, sending nothing", async () => {
    const { client } = page();
    const files = { ...resource, operations: ["read", "delete"] } as const;
    await expect(
      Promise.all([
        codeOf(client.files.delete(files, { id: "missing" })),
        codeOf(client.files.download(files, { id: "../photo" })),
      ])
    ).resolves.toStrictEqual([
      "contract.invalid_args",
      "contract.invalid_args",
    ]);
  });

  it("fails with the page's refusal, and refuses a resource that doesn't declare uploads before anything", async () => {
    const { client, upload } = page();
    const transfer = new UploadTransfer();
    const failed = transfer.upload(client.files, resource, photo);
    upload(0).refuse("file.content_mismatch");
    await expect(codeOf(failed)).resolves.toBe("file.content_mismatch");
    expect(transfer.view()).toMatchObject({
      status: "failed",
      error: { code: "file.content_mismatch" },
    });
    const readOnly = { ...resource, operations: ["read"] };
    await expect(
      codeOf(transfer.upload(client.files, readOnly, photo))
    ).resolves.toBe("file.operation_undeclared");
    // Nothing reached the page, and the view is what it was.
    expect(() => upload(1)).toThrow("No upload 1");
    expect(transfer.view()).toMatchObject({
      status: "failed",
      error: { code: "file.content_mismatch" },
    });
  });
});

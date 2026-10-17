import { describe, expect, it, vi } from "vite-plus/test";

import { clientInternals, GraspClient } from "../src/client-core.ts";
import { clientError, GraspError } from "../src/client-error.ts";
import type { FileTransport, TransferProgress } from "../src/client-files.ts";
import { UploadTransfer } from "../src/upload-transfer.ts";

// One `useUpload` hook's transfer (spec 10.7.5), against the page's side
// of the file port, which these tests play: the page is outside the
// frame, and what it answers (progress, a published file, a cancellation
// that won or lost) is what the transfer must show, no more. One upload
// at a time; a cancellation that publication beat resolves completed. A
// fence (the person's access or the screen's build changed) cancels the
// running upload, and what settles after one is never shown completed.

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
    const transfer = new UploadTransfer(clientInternals(client));
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
    const transfer = new UploadTransfer(clientInternals(client));
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
    const transfer = new UploadTransfer(clientInternals(client));
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
    const transfer = new UploadTransfer(clientInternals(client));
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
    const transfer = new UploadTransfer(clientInternals(client));
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
    const transfer = new UploadTransfer(clientInternals(client));
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

  it("cancels its upload at a fence and shows the fence's refusal, never the file published after", async () => {
    const { client, upload } = page();
    const transfer = new UploadTransfer(clientInternals(client));
    const running = transfer.upload(client.files, resource, photo);
    clientInternals(client).workflowLink.fence(
      clientError("auth.principal_changed")
    );
    const cancelSent = upload(0).cancel.aborted;
    // Core published it before the cancellation reached it.
    upload(0).publish("file-1");
    await expect(codeOf(running)).resolves.toBe("auth.principal_changed");
    expect({ cancelSent, view: transfer.view() }).toMatchObject({
      cancelSent: true,
      view: { status: "failed", error: { code: "auth.principal_changed" } },
    });
  });

  it("shows the fence's refusal for an upload a fence cancelled, not a cancellation the screen asked for", async () => {
    const { client, upload } = page();
    const transfer = new UploadTransfer(clientInternals(client));
    const running = transfer.upload(client.files, resource, photo);
    clientInternals(client).workflowLink.fence(
      clientError("auth.principal_changed")
    );
    upload(0).refuse("file.cancelled");
    await expect(codeOf(running)).resolves.toBe("auth.principal_changed");
    expect(transfer.view()).toMatchObject({
      status: "failed",
      error: { code: "auth.principal_changed" },
    });
    // A fence before an upload started stops none after it.
    const next = transfer.upload(client.files, resource, photo);
    upload(1).publish("file-2");
    await expect(next).resolves.toStrictEqual({ id: "file-2" });
  });

  it("tells the views of a file once it is deleted, and only once core recorded it", async () => {
    const outcomes = ["refused", "deleted", "stopped"];
    const finished = Promise.withResolvers<null>();
    const sentSignal: unknown[] = [];
    const client = new GraspClient({
      call: async () => await Promise.reject(new Error("No calls here")),
      watch: async () => await Promise.reject(new Error("No follows here")),
      files: {
        upload: async () => await Promise.reject(new Error("Not here")),
        read: async () => await Promise.reject(new Error("Not here")),
        download: async () => {
          await Promise.reject(new Error("Not here"));
        },
        delete: async (_resource, _file, _key, signal) => {
          const outcome = outcomes.shift();
          if (outcome === "refused") {
            await Promise.reject(
              Object.assign(new Error("file.referenced"), {
                code: "file.referenced",
              })
            );
          }
          if (outcome === "stopped") {
            // Sent: it runs to its end, whoever stops waiting for it.
            sentSignal.push(signal);
            await finished.promise;
          }
        },
      },
    });
    const told: string[] = [];
    const stop = clientInternals(client).onFileDeleted((key) => {
      told.push(key);
    });
    const files = { ...resource, operations: ["delete"] } as const;
    const id = crypto.randomUUID();
    const refused = await codeOf(client.files.delete(files, { id }));
    const toldAfterRefusal = [...told];
    await client.files.delete(files, { id });
    // A deletion whose caller stopped waiting goes through all the same:
    // its views read it again once core recorded it, never before.
    const other = crypto.randomUUID();
    const stopping = new AbortController();
    const stopped = codeOf(
      client.files.delete(files, { id: other }, { signal: stopping.signal })
    );
    stopping.abort();
    const stoppedCode = await stopped;
    const toldWhileRunning = [...told];
    finished.resolve(null);
    await vi.waitFor(() => {
      expect(told).toHaveLength(2);
    });
    stop();
    expect({ stoppedCode, toldWhileRunning, sentSignal }).toStrictEqual({
      stoppedCode: "file.stopped",
      toldWhileRunning: [`attachments/${id}`],
      sentSignal: [undefined],
    });
    expect({ refused, toldAfterRefusal, told }).toStrictEqual({
      refused: "file.referenced",
      toldAfterRefusal: [],
      told: [`attachments/${id}`, `attachments/${other}`],
    });
  });
});

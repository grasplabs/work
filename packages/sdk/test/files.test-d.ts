// Compile-time guarantees of the file hooks and `client.files` (spec
// 10.7.5, 32.3), against the Notes fixture's generated references: its
// `attachments` resource declares `upload`, `read` and `attach`, and not
// `delete`; `help` is a links resource. A resource the App didn't
// declare, an operation its resource doesn't list, or anything but a
// generated files reference fails, and a file reference stays exactly
// `{ id }`. This file is type-checked by `vp check` and never run: every
// `@ts-expect-error` below must stay an error.
import { expectTypeOf } from "vite-plus/test";

import type { GraspClient } from "../src/client.ts";
import { useFile, useUpload } from "../src/react.ts";
import type {
  FileRef,
  FileView,
  GraspError,
  UploadView,
} from "../src/react.ts";
import { resources } from "./notes/.grasp/references.ts";

declare const client: GraspClient;
declare const picked: File;
declare const file: FileRef;

export const useChecks = (): void => {
  const upload = useUpload(resources.attachments);
  expectTypeOf(upload.upload(picked)).toEqualTypeOf<Promise<FileRef>>();
  expectTypeOf(upload.cancel()).toEqualTypeOf<Promise<void>>();
  // The view is flat and discriminated by its status.
  if (upload.status === "uploading" || upload.status === "verifying") {
    expectTypeOf(upload.bytesUploaded).toEqualTypeOf<number>();
    expectTypeOf(upload.bytesTotal).toEqualTypeOf<number>();
  }
  if (upload.status === "completed") {
    expectTypeOf(upload.file).toEqualTypeOf<FileRef>();
  }
  if (upload.status === "failed") {
    expectTypeOf(upload.error).toEqualTypeOf<GraspError>();
  }
  expectTypeOf<UploadView["status"]>().toEqualTypeOf<
    "idle" | "uploading" | "verifying" | "completed" | "failed" | "cancelled"
  >();
  // @ts-expect-error -- an upload takes a File, not its bytes
  void upload.upload(new Uint8Array(1));
  // @ts-expect-error -- no options but a signal
  void upload.upload(picked, { idempotencyKey: "x" });

  expectTypeOf(useFile(resources.attachments, file)).toEqualTypeOf<
    FileView | undefined
  >();
  expectTypeOf(useFile(resources.attachments, "skip")).toEqualTypeOf<
    FileView | undefined
  >();
  // @ts-expect-error -- null doesn't skip; only "skip" does
  void useFile(resources.attachments, null);

  // @ts-expect-error -- a links resource isn't a files resource
  void useUpload(resources.help);
  // @ts-expect-error -- a resource the App didn't declare
  void useUpload(resources.photos);
  // @ts-expect-error -- a hand-made reference isn't a generated one's type
  void useFile({ kind: "files", alias: "attachments" }, file);
};

export const clientChecks = async (): Promise<void> => {
  expectTypeOf(
    client.files.download(resources.attachments, file)
  ).toEqualTypeOf<Promise<void>>();
  // @ts-expect-error -- `attachments` doesn't declare `delete`
  await client.files.delete(resources.attachments, file);
  await client.files.download(resources.attachments, file, {
    // @ts-expect-error -- a download takes no idempotency key
    idempotencyKey: "x",
  });
  // @ts-expect-error -- a file reference is exactly `{ id }`
  await client.files.download(resources.attachments, "file-id");
  expectTypeOf<FileRef>().toEqualTypeOf<{ id: string }>();
};

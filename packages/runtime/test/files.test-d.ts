// Compile-time guarantees of the file hooks and `client.files` (spec
// 10.7.5, 32.3), against the Notes fixture's generated references: its
// `files` permission declares `upload`, `read` and `attach`, and not
// `delete`; `links` is a links permission. A permission the App didn't
// declare, an operation its permission doesn't list, or anything but a
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
import { permissions } from "./notes/server/_generated/api.ts";

declare const client: GraspClient;
declare const picked: File;
declare const file: FileRef;

export const useChecks = (): void => {
  const upload = useUpload(permissions.files);
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

  expectTypeOf(useFile(permissions.files, file)).toEqualTypeOf<
    FileView | null | undefined
  >();
  expectTypeOf(useFile(permissions.files, "skip")).toEqualTypeOf<
    FileView | null | undefined
  >();
  // @ts-expect-error -- null doesn't skip; only "skip" does
  void useFile(permissions.files, null);

  // @ts-expect-error -- a links permission isn't a files permission
  void useUpload(permissions.links);
  // @ts-expect-error -- a permission the App didn't declare
  void useUpload(permissions.photos);
  // @ts-expect-error -- a hand-made reference isn't a generated one's type
  void useFile({ kind: "files", alias: "attachments" }, file);
};

export const clientChecks = async (): Promise<void> => {
  expectTypeOf(client.files.download(permissions.files, file)).toEqualTypeOf<
    Promise<void>
  >();
  // @ts-expect-error -- `files` doesn't declare `delete`
  await client.files.delete(permissions.files, file);
  await client.files.download(permissions.files, file, {
    // @ts-expect-error -- a download takes no idempotency key
    idempotencyKey: "x",
  });
  // @ts-expect-error -- a file reference is exactly `{ id }`
  await client.files.download(permissions.files, "file-id");
  expectTypeOf<FileRef>().toEqualTypeOf<{ id: string }>();
};

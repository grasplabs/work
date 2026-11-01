/**
 * A built release under the id it's published as: CI builds it under a
 * local id (`dev-<time>`) and its publish gives it the next `YY.MM.N`
 * (upload-release.ts --assign-id); the one-off rename of the first
 * staging releases gives the old ones theirs. Only the manifest's id
 * changes: the blobs, and everything else in it, stay as they were built
 * and checked.
 */
import { releaseManifestSchema } from "@grasp-os/shared/release";
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { z } from "zod";

import { stableStringify } from "./hash-lib.ts";

const text = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

export interface StampedRelease {
  manifest: ReleaseManifest;
  manifestBytes: Buffer;
}

/** The manifest as release `id`'s, written as the build writes it. */
export const stampReleaseId = (
  manifestBytes: Uint8Array,
  id: string
): StampedRelease => {
  // Read loosely and checked once stamped: the id it had may be one this
  // code no longer takes (the rename of the first staging releases).
  const manifest = releaseManifestSchema.parse({
    ...z.looseObject({}).parse(JSON.parse(text(manifestBytes))),
    releaseId: id,
  });
  return { manifest, manifestBytes: Buffer.from(stableStringify(manifest)) };
};

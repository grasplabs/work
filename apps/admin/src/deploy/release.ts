/**
 * A release as a deploy reads it: the manifest the admin imported and
 * verified (src/releases/import.ts), and its blobs from R2, each checked
 * against the manifest again as it's read, so a deploy runs exactly the
 * bytes CI built even if the bucket changed since the import.
 */
import {
  assetKey,
  encodeAsset,
  releaseManifestSchema,
  sha256OfBytes,
} from "@grasp-os/shared/release";
import type { Bytes, ReleaseManifest } from "@grasp-os/shared/release";
import { eq } from "drizzle-orm";

import type { AdminDatabase } from "../db/act.ts";
import { releases } from "../db/schema.ts";
import type { ReleaseStore } from "../releases/import.ts";
import { DeployError } from "./errors.ts";

/** Release `id`'s manifest, as imported; null when it isn't imported. */
export const importedManifest = async (
  db: AdminDatabase,
  id: string
): Promise<ReleaseManifest | null> => {
  const [row] = await db
    .select({ manifest: releases.manifest })
    .from(releases)
    .where(eq(releases.id, id));
  return row === undefined
    ? null
    : releaseManifestSchema.parse(JSON.parse(row.manifest));
};

/** A blob the manifest names by its SHA-256: a module or a migration. */
export interface BlobRef {
  name: string;
  sha256: string;
  size: number;
  r2Key: string;
}

/** A blob in R2 whose bytes aren't what the manifest says. */
const mismatch = (file: Omit<BlobRef, "sha256">, what: string): DeployError =>
  new DeployError(
    "release_blob_mismatch",
    `${file.r2Key} (${file.name}) ${what}`
  );

/**
 * The bytes of the blob `file` names, read from `store`, its size checked
 * against the manifest before its body is read.
 */
const readSized = async (
  store: ReleaseStore,
  file: Omit<BlobRef, "sha256">
): Promise<Bytes> => {
  const object = await store.get(file.r2Key);
  if (object === null) {
    throw mismatch(file, "is missing from the release");
  }
  if (object.size !== file.size) {
    await object.body.cancel();
    throw mismatch(file, "doesn't match its size");
  }
  return new Uint8Array(await object.arrayBuffer());
};

/** A module's or a migration's bytes, checked by size and SHA-256. */
export const readBlob = async (
  store: ReleaseStore,
  file: BlobRef
): Promise<Bytes> => {
  const bytes = await readSized(store, file);
  if ((await sha256OfBytes(bytes)) !== file.sha256) {
    throw mismatch(file, "doesn't match its hash");
  }
  return bytes;
};

/**
 * A static file's contents as base64 (`encodeAsset`), the assets upload's
 * body, read from `store` and checked by size and by its content key
 * `key`: encoded once, for both.
 */
export const readAssetBase64 = async (
  store: ReleaseStore,
  file: { path: string; key: string; size: number }
): Promise<Bytes> => {
  const ref = { name: file.path, size: file.size, r2Key: assetKey(file.key) };
  const { key, base64 } = await encodeAsset(
    await readSized(store, ref),
    file.path
  );
  if (key !== file.key) {
    throw mismatch(ref, "doesn't match its hash");
  }
  return base64;
};

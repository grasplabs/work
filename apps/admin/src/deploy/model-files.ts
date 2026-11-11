/**
 * The model files a release names, put in a client's models bucket: the
 * bucket core binds as `modelFilesBinding`, in the client's own inventory,
 * where core's embedder reads each file by its hash and checks it again
 * (@grasp-os/embed). What can go wrong, and what stops it, is the threat
 * model on GRA-1772; in short:
 *
 * - Bytes that aren't the release's: each file is streamed from the
 *   releases bucket and hashed as it passes (`streamBlob`), its last
 *   chunk held back until the hash matches, into an upload of exactly its
 *   size. A mismatch or a short stream errors the upload, and R2 keeps
 *   nothing of it: a put is all or nothing.
 * - Writing anywhere else: keys are `deployedModelKey(<sha256>)` alone,
 *   from the manifest's hashes (64 hex, checked by its schema), in the
 *   one bucket the client's inventory names for that binding.
 * - Removing what's in use: a file goes only once neither the release
 *   being deployed nor the one running before it (what a failed probe
 *   rolls back to) names it, and only if this records copying it there
 *   (`client_model_files`). Any release deployed later, a rollback
 *   included, copies what it names again.
 *
 * A file is copied only when the bucket doesn't hold it at its size, so a
 * release that keeps its model copies nothing. Every call goes through
 * the deployer's token (src/cloudflare/api.ts), which already creates and
 * deletes the client's buckets: no other credential.
 */
import { deployedModelKey, modelFilesBinding } from "@grasp-os/shared/release";
import type { ModelFileRef, ReleaseManifest } from "@grasp-os/shared/release";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { isNotFound } from "../cloudflare/api.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import type { AdminDatabase } from "../db/act.ts";
import { clientModelFiles } from "../db/schema.ts";
import type { ReleaseStore } from "../releases/import.ts";
import { DeployError } from "./errors.ts";
import { streamBlob } from "./release.ts";

/** A client's models bucket, as its inventory records it. */
export interface ModelsBucket {
  accountId: string;
  /** Its physical name. */
  name: string;
  /** As R2 takes it: `eu`. */
  jurisdiction: string;
}

/**
 * The release name of the bucket `manifest`'s Workers bind as
 * `modelFilesBinding`, or undefined when none does; a release that names
 * model files and binds no bucket for them is refused.
 */
export const modelsBucketOf = (
  manifest: ReleaseManifest
): string | undefined => {
  const names = Object.values(manifest.workers).flatMap((worker) =>
    worker.bindings.flatMap((binding) =>
      binding.type === "r2_bucket" &&
      binding.name === modelFilesBinding &&
      typeof binding.bucket_name === "string"
        ? [binding.bucket_name]
        : []
    )
  );
  const [name] = names;
  if (
    manifest.modelFiles.length > 0 &&
    (name === undefined || names.length > 1)
  ) {
    throw new DeployError(
      "model_files_unbound",
      `The release names model files, but not one bucket bound as ${modelFilesBinding}`
    );
  }
  return name;
};

const objectPath = (bucket: ModelsBucket, key: string): string =>
  `/accounts/${bucket.accountId}/r2/buckets/${bucket.name}/objects/${key}`;

const headersOf = (bucket: ModelsBucket): Record<string, string> => ({
  "cf-r2-jurisdiction": bucket.jurisdiction,
});

/** Whether `bucket` holds `file` at its size; its body is never read. */
const holds = async (
  api: CloudflareApi,
  bucket: ModelsBucket,
  file: ModelFileRef,
  beforeSend: () => Promise<void>
): Promise<boolean> => {
  const response = await api.response({
    method: "GET",
    path: objectPath(bucket, deployedModelKey(file.sha256)),
    headers: headersOf(bucket),
    beforeSend,
  });
  await response.body?.cancel();
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new DeployError(
      "model_files_unreadable",
      `${bucket.name} answered ${response.status} for ${file.name}`
    );
  }
  // Without a length it can't be told whole: copied again.
  return response.headers.get("content-length") === String(file.size);
};

/**
 * Copies `file` from the releases bucket into `bucket`, checked by hash
 * as it passes and sent at exactly its size. Each attempt the API client
 * makes reads it from the releases bucket afresh. A file that can't be
 * read whole as the release names it (`release_blob_mismatch`) stops the
 * upload and the call, with no retry: trying again reads the same bytes.
 */
const copy = async (
  context: { api: CloudflareApi; store: ReleaseStore },
  bucket: ModelsBucket,
  file: ModelFileRef,
  beforeSend: () => Promise<void>
): Promise<void> => {
  const unreadable = new AbortController();
  const body = (): ReadableStream<Uint8Array> => {
    const sized = new FixedLengthStream(file.size);
    void (async () => {
      try {
        const stream = await streamBlob(context.store, file);
        await stream.pipeTo(sized.writable);
      } catch (error) {
        unreadable.abort(error);
      }
    })();
    return sized.readable;
  };
  await context.api.call(
    {
      method: "PUT",
      path: objectPath(bucket, deployedModelKey(file.sha256)),
      headers: {
        ...headersOf(bucket),
        "content-type": "application/octet-stream",
      },
      body,
      beforeSend,
      signal: unreadable.signal,
    },
    z.unknown()
  );
};

/** Removes the file named `sha256` from `bucket`; one already gone is removed. */
const remove = async (
  api: CloudflareApi,
  bucket: ModelsBucket,
  sha256: string,
  beforeSend: () => Promise<void>
): Promise<void> => {
  try {
    await api.call(
      {
        method: "DELETE",
        path: objectPath(bucket, deployedModelKey(sha256)),
        headers: headersOf(bucket),
        beforeSend,
      },
      z.unknown()
    );
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
};

/** What `syncModelFiles` did. */
export interface ModelFilesSynced {
  copied: number;
  removed: number;
}

/**
 * Puts every model file `manifest` names in client `clientId`'s models
 * `bucket`, copying only what it doesn't hold at its size, and removes the
 * files recorded there that neither `manifest` nor `previous` (the release
 * running before, if any) names. `beforeSend` runs before each call: the
 * runner's check that it still holds the client.
 */
export const syncModelFiles = async (
  context: { api: CloudflareApi; store: ReleaseStore; db: AdminDatabase },
  { clientId, bucket }: { clientId: string; bucket: ModelsBucket },
  {
    manifest,
    previous,
  }: { manifest: ReleaseManifest; previous: ReleaseManifest | null },
  beforeSend: () => Promise<void>
): Promise<ModelFilesSynced> => {
  const { api, db } = context;
  const keep = new Set(
    [...manifest.modelFiles, ...(previous?.modelFiles ?? [])].map(
      ({ sha256 }) => sha256
    )
  );
  const recorded = await db
    .select({ sha256: clientModelFiles.sha256 })
    .from(clientModelFiles)
    .where(eq(clientModelFiles.clientId, clientId));
  const old = recorded
    .map(({ sha256 }) => sha256)
    .filter((sha256) => !keep.has(sha256));
  for (const sha256 of old) {
    // oxlint-disable-next-line no-await-in-loop -- a few files, one at a time
    await remove(api, bucket, sha256, beforeSend);
  }
  if (old.length > 0) {
    await db
      .delete(clientModelFiles)
      .where(
        and(
          eq(clientModelFiles.clientId, clientId),
          inArray(clientModelFiles.sha256, old)
        )
      );
  }
  let copied = 0;
  for (const file of manifest.modelFiles) {
    // oxlint-disable-next-line no-await-in-loop -- one large file at a time
    if (!(await holds(api, bucket, file, beforeSend))) {
      // oxlint-disable-next-line no-await-in-loop -- one large file at a time
      await copy(context, bucket, file, beforeSend);
      copied += 1;
    }
    // Recorded once it's there, whoever put it there: so it's removed
    // when no release needs it.
    // oxlint-disable-next-line no-await-in-loop -- one large file at a time
    await db
      .insert(clientModelFiles)
      .values({ clientId, sha256: file.sha256, copiedAt: new Date() })
      .onConflictDoNothing();
  }
  return { copied, removed: old.length };
};

import { log } from "@grasp-os/shared/log";
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
 * - Removing what's in use: the bucket holds model files only, under one
 *   prefix, so the deploy lists that prefix and removes what neither the
 *   release being deployed nor the one running before it (what a failed
 *   probe rolls back to) names. Any release deployed later, a rollback
 *   included, copies what it names again; a file a crashed deploy left
 *   behind goes with the next.
 *
 * A file counts as there when the listing has it at its size. R2's REST
 * API reports no SHA-256 for an object, and an upload through it keeps
 * none, so the size is what's compared; a file is only ever put whole and
 * after its hash checked out, and the embedder checks every file's hash
 * as it loads it, the last line. A release that keeps its model copies
 * nothing. Every call goes through the deployer's token
 * (src/cloudflare/api.ts), which already creates and deletes the client's
 * buckets: no other credential.
 */
import {
  deployedModelKey,
  deployedModelKeyPattern,
  deployedModelPrefix,
  modelFilesBinding,
} from "@grasp-os/shared/release";
import type { ModelFileRef, ReleaseManifest } from "@grasp-os/shared/release";
import { z } from "zod";

import { cloudflareApiBase, isNotFound } from "../cloudflare/api.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
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
 * model files and binds no one bucket for them is refused.
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

const objectsPath = (bucket: ModelsBucket): string =>
  `/accounts/${encodeURIComponent(bucket.accountId)}/r2/buckets/${encodeURIComponent(bucket.name)}/objects`;

/**
 * The API path of the object at `key` in `bucket`: each segment of the key
 * percent-encoded (R2 takes a key's slashes as they are). Refused unless
 * the path a URL makes of it, once `.` and `..` are resolved, is still
 * that object's under the bucket's objects: a second guard, behind only
 * ever acting on keys `isModelKey` takes.
 */
const objectPath = (bucket: ModelsBucket, key: string): string => {
  const objects = objectsPath(bucket);
  const path = `${objects}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const resolved = new URL(`${cloudflareApiBase}${path}`);
  if (
    resolved.pathname !== `${new URL(cloudflareApiBase).pathname}${path}` ||
    resolved.search !== "" ||
    resolved.hash !== ""
  ) {
    throw new DeployError(
      "model_files_unreadable",
      `A model file key leaves ${bucket.name}'s objects`
    );
  }
  return path;
};

/**
 * Whether `key` is a model file's, exactly `deployedModelKey` of a SHA-256:
 * the only keys the deploy acts on. The listing is untrusted: core can
 * write to its models bucket, and a key it planted (`..`, an encoded
 * slash, a query) must never steer a call the deployer's token makes.
 */
const isModelKey = (key: string): boolean => deployedModelKeyPattern.test(key);

const headersOf = (bucket: ModelsBucket): Record<string, string> => ({
  "cf-r2-jurisdiction": bucket.jurisdiction,
});

/** R2's listing: every field is optional in its documentation. */
const listedSchema = z.array(
  z.object({ key: z.string().optional(), size: z.number().optional() })
);

/** Most keys a page of R2's listing answers with. */
const perPage = 1000;

/** Every model file in `bucket`: its size, by key. */
const listed = async (
  api: CloudflareApi,
  bucket: ModelsBucket,
  beforeSend: () => Promise<void>,
  cursor?: string
): Promise<Map<string, number>> => {
  const { result, resultInfo } = await api.page(
    {
      method: "GET",
      path: objectsPath(bucket),
      headers: headersOf(bucket),
      query: {
        prefix: deployedModelPrefix,
        per_page: String(perPage),
        ...(cursor === undefined ? {} : { cursor }),
      },
      beforeSend,
    },
    listedSchema
  );
  // An object listed without its size is copied again; one under any key
  // but a model file's is left alone, counted, its key never logged.
  const keys = result.flatMap(({ key }) => (key === undefined ? [] : [key]));
  const foreign = keys.filter((key) => !isModelKey(key)).length;
  if (foreign > 0) {
    log.warn("deploy.model_files_foreign_keys", {
      bucket: bucket.name,
      count: foreign,
    });
  }
  const here = new Map(
    result.flatMap(({ key, size }) =>
      key === undefined || !isModelKey(key) ? [] : [[key, size ?? -1] as const]
    )
  );
  const next =
    resultInfo?.is_truncated === true ? resultInfo.cursor : undefined;
  return next === undefined
    ? here
    : new Map([...here, ...(await listed(api, bucket, beforeSend, next))]);
};

/** Whether `error` is the release's bytes not being what it names: no retry reads others. */
const isMismatch = (error: unknown): boolean =>
  error instanceof DeployError && error.code === "release_blob_mismatch";

/**
 * Copies `file` from the releases bucket into `bucket`, checked by hash
 * as it passes and sent at exactly its size. Each attempt the API client
 * makes reads it from the releases bucket afresh, into a body of its own:
 * an attempt cut off (the connection lost, a server error, a read of the
 * releases bucket that broke) is retried as any call is. Only bytes that
 * aren't what the release names (`release_blob_mismatch`) stop the call
 * with no retry, since trying again reads the same bytes.
 */
const copy = async (
  context: { api: CloudflareApi; store: ReleaseStore },
  bucket: ModelsBucket,
  file: ModelFileRef,
  beforeSend: () => Promise<void>
): Promise<void> => {
  const mismatch = new AbortController();
  const body = (): ReadableStream<Uint8Array> => {
    const sized = new FixedLengthStream(file.size);
    void (async () => {
      let stream: ReadableStream<Uint8Array>;
      try {
        stream = await streamBlob(context.store, file);
      } catch (error) {
        if (isMismatch(error)) {
          mismatch.abort(error);
        }
        await sized.writable.abort(error);
        return;
      }
      try {
        // The body is ended here, not by the pipe, so a mismatch stops the
        // call before its body fails: no retry reads the file again.
        await stream.pipeTo(sized.writable, { preventAbort: true });
      } catch (error) {
        if (isMismatch(error)) {
          mismatch.abort(error);
        }
        // Anything else fails this attempt's body, which the call retries.
        await sized.writable.abort(error);
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
      signal: mismatch.signal,
    },
    z.unknown()
  );
};

/** Removes the object at `key` from `bucket`; one already gone is removed. */
const remove = async (
  api: CloudflareApi,
  bucket: ModelsBucket,
  key: string,
  beforeSend: () => Promise<void>
): Promise<void> => {
  try {
    await api.call(
      {
        method: "DELETE",
        path: objectPath(bucket, key),
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
 * Puts every model file `manifest` names in the client's models `bucket`,
 * copying only what it doesn't hold at its size, and removes every other
 * model file there that `previous` (the release running before, if any)
 * doesn't name either. `beforeSend` runs before each call: the runner's
 * check that it still holds the client.
 */
export const syncModelFiles = async (
  context: { api: CloudflareApi; store: ReleaseStore },
  bucket: ModelsBucket,
  {
    manifest,
    previous,
  }: { manifest: ReleaseManifest; previous: ReleaseManifest | null },
  beforeSend: () => Promise<void>
): Promise<ModelFilesSynced> => {
  const { api } = context;
  const there = await listed(api, bucket, beforeSend);
  const keep = new Set(
    [...manifest.modelFiles, ...(previous?.modelFiles ?? [])].map(
      ({ sha256 }) => deployedModelKey(sha256)
    )
  );
  const old = [...there.keys()].filter((key) => !keep.has(key));
  for (const key of old) {
    // oxlint-disable-next-line no-await-in-loop -- a few files, one at a time
    await remove(api, bucket, key, beforeSend);
  }
  let copied = 0;
  for (const file of manifest.modelFiles) {
    if (there.get(deployedModelKey(file.sha256)) !== file.size) {
      // oxlint-disable-next-line no-await-in-loop -- one large file at a time
      await copy(context, bucket, file, beforeSend);
      copied += 1;
    }
  }
  return { copied, removed: old.length };
};

import { questionEmbedder } from "@grasp-os/embed/embedder";
import type { Embedder } from "@grasp-os/embed/embedder";
import {
  modelFileKey,
  modelFilesOf,
  shippedModel,
} from "@grasp-os/embed/model-files";
import type { EmbedModel } from "@grasp-os/embed/model-files";
import { log } from "@grasp-os/shared/log";
import { deployedModelPrefix } from "@grasp-os/shared/release";

import { inJurisdiction } from "./durable-objects.ts";

// Core's embedder: the `Embedder` class of @grasp-os/embed, bound as
// EMBEDDER in the EU, running `shippedModel` from the MODEL_FILES bucket.
// The model's files reach that bucket with each release: the admin's
// deploy copies in the files the release names before core goes live
// (apps/admin/src/deploy/model-files.ts); on-prem, the clock copies them
// from the install's release directory (`ensureModelFilesFrom`). The
// embedder checks every file by its hash as it loads it, so neither copy
// is trusted.
//
// Warming: an object's first load copies the model into its own storage
// (about 115 MB and 256,000 rows for the real model, seconds); after an
// eviction it reloads from its own storage. The first question after a
// deploy would wait for that, so the clock asks the question embedder for
// one embedding once in each new isolate (`warmQuestionEmbedder`): within
// a minute of a deploy, never in a question's way.

export { Embedder } from "@grasp-os/embed/embedder";

/** The question embedder, in core's jurisdiction. */
export const questionEmbedderOf = (
  env: Pick<Env, "EMBEDDER" | "DURABLE_OBJECT_JURISDICTION">
): DurableObjectStub<Embedder> =>
  questionEmbedder(inJurisdiction(env, env.EMBEDDER));

/**
 * Whether `bucket` holds every file of `model`. A put is whole or absent,
 * and the embedder checks each file's hash as it loads it, so being there
 * is what this asks.
 */
export const holdsModelFiles = async (
  bucket: R2Bucket,
  model: EmbedModel = shippedModel
): Promise<boolean> => {
  const heads = await Promise.all(
    modelFilesOf(model).map(
      async (file) => await bucket.head(modelFileKey(file))
    )
  );
  return heads.every((head) => head !== null);
};

/**
 * On-prem only: copies each file of `model` (the one core runs) from the install's
 * release directory (`source`, workerd's disk service over its
 * `blobs/models`, by hash) into `bucket` when it isn't there at its size,
 * stored with its SHA-256, which the on-prem R2 service checks before it
 * keeps a byte of it. Then removes every other model file from `bucket`:
 * the release that runs is the only one that reads it, and an older one
 * put back copies its own files again.
 */
export const ensureModelFilesFrom = async (
  source: Fetcher,
  bucket: R2Bucket,
  model: EmbedModel = shippedModel
): Promise<void> => {
  const files = modelFilesOf(model);
  for (const file of files) {
    const key = modelFileKey(file);
    // oxlint-disable-next-line no-await-in-loop -- three files, one at a time
    const head = await bucket.head(key);
    if (head?.size === file.size) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- three files, one at a time
    const response = await source.fetch(`http://release/${file.sha256}`);
    if (!response.ok || response.body === null) {
      throw new Error(
        `The release directory has no ${model.name} ${file.which} file (${file.sha256})`
      );
    }
    const body = new FixedLengthStream(file.size);
    // oxlint-disable-next-line no-await-in-loop -- three files, one at a time
    await Promise.all([
      response.body.pipeTo(body.writable),
      bucket.put(key, body.readable, { sha256: file.sha256 }),
    ]);
  }
  const keep = new Set(files.map(modelFileKey));
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page names the next
    const page = await bucket.list({
      prefix: deployedModelPrefix,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const old = page.objects
      .map(({ key }) => key)
      .filter((key) => !keep.has(key));
    if (old.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- each page names the next
      await bucket.delete(old);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
};

/** Whether this isolate warmed the question embedder already. */
let warmed = false;
/** Whether this isolate said once that the model's files aren't there. */
let saidMissing = false;

/**
 * The clock's task: in a new isolate, after a deploy or a restart, has the
 * question embedder load its model, once. On-prem it first copies the
 * model's files from the release directory (`MODEL_SOURCE`). Without
 * the model's files (local dev, which has no real model) it does nothing
 * and says so once: a deployment without them fails its probe, never here.
 */
export const warmQuestionEmbedder = async (env: Env): Promise<void> => {
  if (warmed) {
    return;
  }
  if (env.MODEL_SOURCE !== undefined) {
    await ensureModelFilesFrom(env.MODEL_SOURCE, env.MODEL_FILES);
  }
  if (!(await holdsModelFiles(env.MODEL_FILES))) {
    if (!saidMissing) {
      saidMissing = true;
      log.warn("embed.model_files_missing", { model: shippedModel.name });
    }
    return;
  }
  await questionEmbedderOf(env).embed("Warm-up.");
  warmed = true;
};

import { questionEmbedder } from "@grasp-os/embed/embedder";
import type { Embedder } from "@grasp-os/embed/embedder";
import {
  modelFileKey,
  modelFilesOf,
  modelIdentity,
  shippedModel,
} from "@grasp-os/embed/model-files";
import type {
  EmbedModel,
  ModelFile,
  ModelIdentity,
} from "@grasp-os/embed/model-files";
import { embedWithPool } from "@grasp-os/embed/pool";
import type { PoolReply } from "@grasp-os/embed/pool";
import { embedQuestion } from "@grasp-os/embed/question";
import type { QuestionVector } from "@grasp-os/embed/question";
import { toHex } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import { deployedModelPrefix } from "@grasp-os/shared/release";

import { inJurisdiction } from "./durable-objects.ts";

// Core's embedder: the `Embedder` class of @grasp-os/embed, bound as
// EMBEDDER in the EU, running `shippedModel` from the MODEL_FILES bucket,
// or no model at all until one ships, when it refuses every text. The
// model's files reach that bucket with each release: the admin's deploy
// copies in the files the release names before core goes live
// (apps/admin/src/deploy/model-files.ts); on-prem, the clock copies them
// from the install's release directory (`ensureModelFilesFrom`). The
// embedder checks every file by its hash as it loads it, so neither copy
// is trusted: that check is the last line, whatever is checked before it.
//
// Two uses, never sharing an object: questions go to the question
// embedder; the Brain's background work embeds passages through the bulk
// embedders, a pool of objects of the same namespace (@grasp-os/embed/pool,
// `embedInBulk`), so a first load never slows a question. Every one is got
// in core's jurisdiction, the EU's.
//
// Warming: an object's first load copies the model into its own storage
// (about 115 MB and 256,000 rows for the real model, seconds); after an
// eviction it reloads from its own storage. The first question after a
// deploy would wait for that, so the clock has the question embedder load
// once in each new isolate (`warmQuestionEmbedder`): within a minute of a
// deploy, never in a question's way.

export { Embedder } from "@grasp-os/embed/embedder";

/** The question embedder, in core's jurisdiction. */
export const questionEmbedderOf = (
  env: Pick<Env, "EMBEDDER" | "DURABLE_OBJECT_JURISDICTION">
): DurableObjectStub<Embedder> =>
  questionEmbedder(inJurisdiction(env, env.EMBEDDER));

/**
 * How long a recall waits for its question's vector before it goes ahead
 * without. Measured locally (workerd on a laptop) with a 10-layer model
 * of width 384: one warm question of 17 to 152 characters through
 * `embedMany` took p50 5 ms, p95 7 ms, at most 13 ms. On Cloudflare a call
 * costs 10 to 36 ms of round trip and such a model about 0.61 ms a token,
 * so some 20 to 55 ms for a question of up to 30 tokens. 250 ms is about
 * four times that, and a quarter of recall's p95 target of 1 s: a busy
 * embedder still answers, a broken one costs a recall no more. An
 * embedder evicted since its last question reloads its model from its own
 * storage first (seconds): the first question after that goes without
 * vectors, and the load goes on, so the next one has them.
 */
export const questionVectorMs = 250;

/**
 * `question`'s vector by the question embedder, in core's jurisdiction,
 * within `questionVectorMs` (@grasp-os/embed/question); null while no
 * model ships, when nothing is embedded.
 */
export const questionVectorOf = async (
  env: Pick<Env, "EMBEDDER" | "DURABLE_OBJECT_JURISDICTION">,
  question: string
): Promise<QuestionVector | null> =>
  shippedModel === null
    ? null
    : await embedQuestion(questionEmbedderOf(env), question, {
        timeoutMs: questionVectorMs,
      });

/** The model core's embedders run, and its build: none while no model ships. */
export const embedderModel = async (): Promise<ModelIdentity | null> =>
  shippedModel === null ? null : await modelIdentity(shippedModel);

/**
 * `texts` embedded by the bulk embedders (@grasp-os/embed/pool), in core's
 * jurisdiction, within `timeoutMs`: for the Brain's background work, never
 * a question.
 */
export const embedInBulk = async (
  env: Pick<Env, "EMBEDDER" | "DURABLE_OBJECT_JURISDICTION">,
  texts: readonly string[],
  timeoutMs: number
): Promise<PoolReply> =>
  await embedWithPool(inJurisdiction(env, env.EMBEDDER), texts, {
    timeoutMs,
  });

/**
 * Whether `head` is `file`: there at its size, and with its SHA-256 where
 * the bucket kept one (R2 keeps the one a put was made with). One kept
 * without a SHA-256 passes on its size: the embedder's own hash check, as
 * it loads it, is the last line.
 */
const isFile = (head: R2Object | null, file: ModelFile): boolean => {
  const sha256 = head?.checksums.sha256;
  return (
    head?.size === file.size &&
    (sha256 === undefined || toHex(new Uint8Array(sha256)) === file.sha256)
  );
};

/**
 * Whether `bucket` holds every file of `model` (the one core runs), each
 * at its size and, where the bucket kept it, its SHA-256. With no model,
 * there is nothing to hold.
 */
export const holdsModelFiles = async (
  bucket: R2Bucket,
  model: EmbedModel | null = shippedModel
): Promise<boolean> => {
  if (model === null) {
    return true;
  }
  const held = await Promise.all(
    modelFilesOf(model).map(async (file) =>
      isFile(await bucket.head(modelFileKey(file)), file)
    )
  );
  return held.every(Boolean);
};

/**
 * On-prem only: copies each file of `model` (the one core runs) from the
 * install's release directory (`source`, workerd's disk service over its
 * `blobs/models`, by hash) into `bucket` unless it's there already
 * (`isFile`), stored with its SHA-256, which the on-prem R2 service checks
 * before it keeps a byte of it. Then removes every other model file from
 * `bucket`: the release that runs is the only one that reads it, and an
 * older one put back copies its own files again. `missing` when the
 * release directory lacks a file, copying nothing more.
 */
export const ensureModelFilesFrom = async (
  source: Fetcher,
  bucket: R2Bucket,
  model: EmbedModel | null = shippedModel
): Promise<"ensured" | "missing"> => {
  const files = model === null ? [] : modelFilesOf(model);
  for (const file of files) {
    const key = modelFileKey(file);
    // oxlint-disable-next-line no-await-in-loop -- three files, one at a time
    if (isFile(await bucket.head(key), file)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- three files, one at a time
    const response = await source.fetch(`http://release/${file.sha256}`);
    if (!response.ok || response.body === null) {
      // oxlint-disable-next-line no-await-in-loop -- once, before returning
      await response.body?.cancel();
      return "missing";
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
  return "ensured";
};

/** Whether this isolate tried to warm the question embedder already. */
let tried = false;

/**
 * The clock's task: in a new isolate, after a deploy or a restart, has the
 * question embedder load its model, once, whether that works or not: a
 * file that doesn't check out fails the load, and loading it again every
 * minute would copy and clear 256,000 rows for nothing. The next isolate
 * tries again. With no model (none ships yet) it does nothing. On-prem it
 * first copies the model's files from the release directory
 * (`MODEL_SOURCE`). Without the model's files (local dev has no real
 * model, an on-prem release directory may lack them) it says so and does
 * nothing more: a deployment without them fails its probe, never here.
 */
export const warmQuestionEmbedder = async (env: Env): Promise<void> => {
  if (tried || shippedModel === null) {
    return;
  }
  tried = true;
  const copied =
    env.MODEL_SOURCE === undefined
      ? "ensured"
      : await ensureModelFilesFrom(env.MODEL_SOURCE, env.MODEL_FILES);
  if (copied === "missing" || !(await holdsModelFiles(env.MODEL_FILES))) {
    log.warn("embed.model_files_missing", {
      model: shippedModel.name,
      from: copied === "missing" ? "release_directory" : "bucket",
    });
    return;
  }
  await questionEmbedderOf(env).embed("Warm-up.");
};

/**
 * Puts the files of the embedding model core ships (`shippedModel` of
 * `@grasp-os/embed`) in this machine's model files cache, once, for every
 * local stack to run it: `vp run dev` and the e2e stack put them in their
 * own model files bucket as they start (scripts/local-model-files.ts),
 * as a deploy puts a release's in a deployment's. About 126 MB, so never
 * in git: from where the release takes them, one of two:
 *
 * - `--dir <dir>`: the folder the model was exported to, the one
 *   `vp run release:model-files --dir` uploads from. Read only.
 * - Without `--dir`: the releases bucket the environment names, where
 *   every release that names the model finds its files (`modelBlobKey`),
 *   with that bucket's read keys, as `release:download` reads it. With
 *   `--all`, every model file the bucket holds, the next model's too once
 *   `release:model-files` put it there: what CI keeps
 *   (.github/workflows/model-files.yml), so a pull request that changes
 *   the model finds its files without a key.
 *
 * Each file is checked by its size and SHA-256 before it is kept, under
 * its SHA-256 (`cachedModelFile`): a file is never replaced by another,
 * and one already kept is left as it is.
 *
 * Env (without --dir): R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID,
 *      R2_SECRET_ACCESS_KEY
 * Usage: vp run model-files [--dir <dir> | --all]
 */
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

import { modelFilesOf, shippedModel } from "@grasp-os/embed/model-files";
import type { ModelFile } from "@grasp-os/embed/model-files";
import { modelBlobKey } from "@grasp-os/shared/release";

import type { ReleasesBucket } from "./release/bucket-lib.ts";

/**
 * This machine's cache of model files, each under its SHA-256, shared by
 * every checkout: `$XDG_CACHE_HOME/grasp-os/model-files`, or
 * `~/.cache/grasp-os/model-files`. CI keeps it between runs too
 * (.github/workflows/ci.yml).
 */
export const modelCacheDir = path.join(
  process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"),
  "grasp-os",
  "model-files"
);

/** Where `file` is kept in the cache. */
export const cachedModelFile = (file: ModelFile): string =>
  path.join(modelCacheDir, file.sha256);

/** The SHA-256 of the file at `at`, hex. */
const sha256Of = async (at: string): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(at), hash);
  return hash.digest("hex");
};

/**
 * Whether the cache holds `file`, byte for byte: one changed since it was
 * kept is fetched again, over it.
 */
export const isCached = async (file: ModelFile): Promise<boolean> =>
  existsSync(cachedModelFile(file)) &&
  statSync(cachedModelFile(file)).size === file.size &&
  (await sha256Of(cachedModelFile(file))) === file.sha256;

/**
 * A file of this fill's own to write `file` to before it is kept: two
 * fills at once, from any checkout, never write, move or remove each
 * other's.
 */
const partOf = (file: ModelFile): string =>
  `${cachedModelFile(file)}.${randomUUID()}.part`;

/**
 * Keeps the file written to `written` as `file` if it is `file`, byte for
 * byte; removes it either way. Whether it was.
 */
const keepIf = async (written: string, file: ModelFile): Promise<boolean> => {
  try {
    if (
      statSync(written).size !== file.size ||
      (await sha256Of(written)) !== file.sha256
    ) {
      return false;
    }
    renameSync(written, cachedModelFile(file));
    return true;
  } finally {
    rmSync(written, { force: true });
  }
};

/** A file of `file`'s size from `dir` that is `file`, kept; whether one was. */
export const keepFromDir = async (
  dir: string,
  file: ModelFile
): Promise<boolean> => {
  const candidates = readdirSync(dir, { withFileTypes: true }).filter(
    (entry) =>
      entry.isFile() && statSync(path.join(dir, entry.name)).size === file.size
  );
  for (const { name } of candidates) {
    const written = partOf(file);
    // A copy-on-write clone where the disk can make one: the folder's file
    // is only read, never moved or changed.
    copyFileSync(path.join(dir, name), written, constants.COPYFILE_FICLONE);
    // oxlint-disable-next-line no-await-in-loop -- one candidate at a time, most often the only one
    if (await keepIf(written, file)) {
      return true;
    }
  }
  return false;
};

/** The releases bucket the environment names: only the bucket's ways read its keys. */
const releasesBucket = async (): Promise<ReleasesBucket> => {
  const { releasesBucketFromEnv } = await import("./release/bucket-lib.ts");
  return releasesBucketFromEnv();
};

/** `file` from the releases bucket, kept; whether it was. */
const keepFromBucket = async (
  bucket: ReleasesBucket,
  file: ModelFile
): Promise<boolean> => {
  const key = modelBlobKey(file.sha256);
  const response = await bucket.fetch(bucket.url(key));
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new Error(`GET ${key}: ${response.status}`);
  }
  const written = partOf(file);
  await pipeline(response.body, createWriteStream(written));
  return await keepIf(written, file);
};

const contentsPattern = /<Contents>(?<entry>[\s\S]*?)<\/Contents>/gu;
const modelKeyPattern =
  /<Key>blobs\/models\/(?<sha256>[0-9a-f]{64})<\/Key>[\s\S]*<Size>(?<size>\d+)<\/Size>/u;
const truncatedPattern = /<IsTruncated>true<\/IsTruncated>/u;
const tokenPattern =
  /<NextContinuationToken>(?<token>[^<]+)<\/NextContinuationToken>/u;

/**
 * One page of an S3 ListObjectsV2 of the releases bucket's model files:
 * each file by its key's SHA-256 and its size, and the next page's token.
 */
export const parseModelListing = (
  xml: string
): { files: ModelFile[]; next: string | undefined } => ({
  files: [...xml.matchAll(contentsPattern)].flatMap(({ groups }) => {
    const found = modelKeyPattern.exec(groups?.entry ?? "")?.groups;
    return found?.sha256 === undefined || found.size === undefined
      ? []
      : [{ sha256: found.sha256, size: Number(found.size) }];
  }),
  next: truncatedPattern.test(xml)
    ? tokenPattern.exec(xml)?.groups?.token
    : undefined,
});

/** Every model file in the releases bucket. */
const modelFilesIn = async (bucket: ReleasesBucket): Promise<ModelFile[]> => {
  const prefix = path.posix.dirname(modelBlobKey("x"));
  const files: ModelFile[] = [];
  let token: string | undefined;
  do {
    const query = new URLSearchParams({
      "list-type": "2",
      prefix: `${prefix}/`,
      ...(token === undefined ? {} : { "continuation-token": token }),
    });
    // oxlint-disable-next-line no-await-in-loop -- each page names the next
    const response = await bucket.fetch(
      `${bucket.url("").replace(/\/$/u, "")}?${query.toString()}`
    );
    if (!response.ok) {
      throw new Error(`LIST ${prefix}: ${response.status}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- each page names the next
    const page = parseModelListing(await response.text());
    files.push(...page.files);
    token = page.next;
  } while (token !== undefined);
  return files;
};

if (import.meta.main) {
  const { values: args } = parseArgs({
    options: { dir: { type: "string" }, all: { type: "boolean" } },
  });
  const dir = args.dir === undefined ? undefined : path.resolve(args.dir);
  mkdirSync(modelCacheDir, { recursive: true });
  const bucket = dir === undefined ? await releasesBucket() : undefined;
  const listed =
    bucket !== undefined && args.all === true
      ? await modelFilesIn(bucket)
      : undefined;
  const wanted: (ModelFile & { which: string })[] =
    listed === undefined
      ? modelFilesOf(shippedModel).map((file) => ({
          ...file,
          which: `${shippedModel.name}'s ${file.which}`,
        }))
      : listed.map((file) => ({ ...file, which: file.sha256 }));
  const missing: string[] = [];
  for (const file of wanted) {
    // oxlint-disable-next-line no-await-in-loop -- one file at a time
    if (await isCached(file)) {
      console.info(`${file.which}: already cached`);
      continue;
    }
    const kept =
      bucket === undefined
        ? // oxlint-disable-next-line no-await-in-loop -- one file at a time
          await keepFromDir(dir ?? "", file)
        : // oxlint-disable-next-line no-await-in-loop -- one file at a time
          await keepFromBucket(bucket, file);
    if (kept) {
      console.info(`${file.which}: cached`);
    } else {
      missing.push(file.which);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${dir ?? "The releases bucket"} lacks ${missing.join(", ")} (no file of its size and SHA-256)`
    );
  }
  console.info(`The model files are in ${modelCacheDir}`);
}

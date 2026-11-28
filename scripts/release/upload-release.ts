/**
 * Publishes a release directory to an R2 bucket through its S3 API, under
 * the id it has: how Promote release copies a release staging ran into
 * production's bucket (download-release.ts fetches it). CI's publish of
 * each merge holds no bucket key and goes through the staging admin
 * instead (publish-release.ts).
 *
 * The release is verified against its manifest first, and the bytes that
 * were hashed are the bytes sent: nothing is read from disk twice. Blobs
 * are content-addressed and uploaded with their SHA-256
 * (`x-amz-checksum-sha256`), which R2 checks on write. A blob R2 already
 * holds, from an earlier release or another writer since the HEAD (the PUT
 * is conditional), is skipped only once its stored SHA-256 matches: the
 * checksum R2 reports, or, for an object stored without one, the hash of
 * its bytes. One that doesn't match fails the upload, before the manifest.
 *
 * The model files a release names aren't in a build (@grasp-os/shared/
 * release): each must be in the bucket already, put there once by
 * upload-model-files.ts, or nothing is published. A release directory
 * that holds them (Promote release's download) uploads them, and puts one
 * found without its SHA-256 again with it. Either way the manifest goes
 * up only once every model file is stored as the admin's import will take
 * it (`storedModelFileProblem`): at its size, with its SHA-256 kept by R2.
 *
 * The manifest goes up last, to `releases/<id>/manifest.json`: the admin
 * imports only releases whose manifest exists, so an upload that stops
 * halfway never leaves a manifest pointing at missing blobs. It's
 * written only if absent, so a published release never changes, and
 * once `releases/` is locked in the bucket (by hand, once), R2 refuses a
 * write to a published manifest with 409, which counts as there, as 412
 * does; there with other bytes, nothing is published and it fails. Right
 * before it goes its signature (@grasp-os/shared/release-signature), as
 * the download fetched and checked it: a release without one that
 * verifies is refused before anything is uploaded.
 *
 * With --dry-run it verifies the release and says what it would upload,
 * without credentials or network.
 *
 * Env: R2_ENDPOINT (https://<account id>.eu.r2.cloudflarestorage.com),
 *      R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * Usage: vp run release:upload --release <dir> [--dry-run]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  manifestKey,
  mapConcurrently,
  storedModelFileProblem,
} from "@grasp-os/shared/release";
import type { StoredModelFile } from "@grasp-os/shared/release";
import {
  RELEASE_SIGNATURE_FILE,
  releaseSignatureProblem,
  signatureKey,
} from "@grasp-os/shared/release-signature";
import { releaseSigningKeys } from "@grasp-os/shared/release-signing-keys";

import { REQUESTS_AT_ONCE, releasesBucketFromEnv } from "./bucket-lib.ts";
import type { ReleasesBucket } from "./bucket-lib.ts";
import { verifyRelease } from "./manifest-lib.ts";

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_PRECONDITION_FAILED = 412;

const { values: args } = parseArgs({
  options: {
    release: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (args.release === undefined) {
  throw new Error("--release <dir> is required");
}
const releaseDir = path.resolve(args.release);

const { manifest, manifestBytes, blobs } = await verifyRelease(releaseDir);

/** SHA-256, base64: the form of R2's `x-amz-checksum-sha256`. */
const sha256Base64 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("base64");

/** SHA-256, hex: how a manifest's signature is keyed (`signatureKey`). */
const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const assertStored = (key: string, stored: string, expected: string): void => {
  if (stored !== expected) {
    throw new Error(
      `${key} in R2 isn't the release's bytes (SHA-256 ${stored}, expected ${expected}); nothing published`
    );
  }
};

const checksumMode = { "x-amz-checksum-mode": "ENABLED" };

/** The SHA-256 of what R2 holds at `key`, or undefined when it holds nothing. */
const storedSha256 = async (
  bucket: ReleasesBucket,
  key: string
): Promise<string | undefined> => {
  const head = await bucket.fetch(bucket.url(key), {
    method: "HEAD",
    headers: checksumMode,
  });
  if (head.status === HTTP_NOT_FOUND) {
    return undefined;
  }
  if (!head.ok) {
    throw new Error(`HEAD ${key}: ${head.status}`);
  }
  const checksum = head.headers.get("x-amz-checksum-sha256");
  if (checksum !== null) {
    return checksum;
  }
  // Stored without a checksum: hash the bytes themselves.
  const get = await bucket.fetch(bucket.url(key));
  if (!get.ok) {
    throw new Error(`GET ${key}: ${get.status}`);
  }
  return sha256Base64(new Uint8Array(await get.arrayBuffer()));
};

/**
 * PUTs `bytes` at `key`, stored with their SHA-256, only if R2 holds
 * nothing there. Undefined when this put stored them; otherwise the
 * SHA-256 of what `key` holds (`storedSha256`). A try that took but whose
 * answer was lost, sent again by the bucket's retries, finds its own bytes
 * there: the SHA-256 it reports is then theirs, never a failure. Refused
 * with nothing there, it throws. R2
 * answers a key a bucket lock holds with 409 before it looks at
 * `If-None-Match` (developers.cloudflare.com/r2/buckets/bucket-locks/,
 * read 28 November 2026): held, as 412 says.
 */
const putIfAbsent = async (
  bucket: ReleasesBucket,
  key: string,
  bytes: Buffer,
  contentType?: string
): Promise<string | undefined> => {
  const put = await bucket.fetch(bucket.url(key), {
    method: "PUT",
    body: bytes,
    headers: {
      ...(contentType === undefined ? {} : { "Content-Type": contentType }),
      "If-None-Match": "*",
      "x-amz-checksum-sha256": sha256Base64(bytes),
    },
  });
  if (put.status === HTTP_PRECONDITION_FAILED || put.status === HTTP_CONFLICT) {
    const held = await storedSha256(bucket, key);
    if (held === undefined) {
      throw new Error(
        `PUT ${key}: ${put.status}, yet R2 holds nothing there; nothing published`
      );
    }
    return held;
  }
  if (!put.ok) {
    throw new Error(`PUT ${key}: ${put.status} ${await put.text()}`);
  }
  return undefined;
};

/**
 * Stores `signature`, the manifest's signature file, at its key, only if
 * absent: there already, it must be these bytes, which signing the same
 * manifest again gives.
 */
const putSignature = async (
  bucket: ReleasesBucket,
  signature: Buffer
): Promise<void> => {
  const key = signatureKey(sha256Hex(manifestBytes));
  const held = await putIfAbsent(bucket, key, signature, "application/json");
  if (held !== undefined) {
    assertStored(key, held, sha256Base64(signature));
  }
};

/** SHA-256 hex as R2's checksum header writes it, base64. */
const hexToBase64 = (hex: string): string =>
  Buffer.from(hex, "hex").toString("base64");

/**
 * What R2 reports of the model file at `key`, as the admin's import reads
 * it: its size and the SHA-256 it kept, never the bytes. Null when absent.
 */
const modelFileHead = async (
  bucket: ReleasesBucket,
  key: string
): Promise<StoredModelFile | null> => {
  const head = await bucket.fetch(bucket.url(key), {
    method: "HEAD",
    headers: checksumMode,
  });
  if (head.status === HTTP_NOT_FOUND) {
    return null;
  }
  if (!head.ok) {
    throw new Error(`HEAD ${key}: ${head.status}`);
  }
  const checksum = head.headers.get("x-amz-checksum-sha256");
  return {
    size: Number(head.headers.get("content-length") ?? "-1"),
    ...(checksum === null
      ? {}
      : { sha256: Buffer.from(checksum, "base64").toString("hex") }),
  };
};

/**
 * Throws unless the bucket holds each of `files` as the admin's import
 * will take it (`storedModelFileProblem`): a release that publishes
 * otherwise would never import, and nothing would say why.
 */
const assertModelFilesStored = async (
  bucket: ReleasesBucket,
  files: typeof manifest.modelFiles
): Promise<void> => {
  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop -- a few files
    const stored = await modelFileHead(bucket, file.r2Key);
    const problem = storedModelFileProblem(file, stored);
    if (problem !== undefined) {
      throw new Error(
        `Model file ${file.name} at ${file.r2Key} ${problem}: put it there with release:model-files; nothing published`
      );
    }
  }
};

/**
 * Puts a model file the release directory carries in the bucket, stored
 * with its SHA-256: absent, only if still absent; there without a SHA-256
 * (put some other way), again over itself, R2 checking the bytes against
 * the SHA-256 it then keeps. Once: the check after every upload says
 * whether it took.
 */
const uploadModelFile = async (
  bucket: ReleasesBucket,
  key: string,
  bytes: Buffer
): Promise<"uploaded" | "skipped"> => {
  const expected = sha256Base64(bytes);
  const stored = await modelFileHead(bucket, key);
  if (stored?.sha256 !== undefined) {
    assertStored(key, hexToBase64(stored.sha256), expected);
    return "skipped";
  }
  const put = await bucket.fetch(bucket.url(key), {
    method: "PUT",
    body: bytes,
    headers: {
      ...(stored === null ? { "If-None-Match": "*" } : {}),
      "x-amz-checksum-sha256": expected,
    },
  });
  if (!put.ok && put.status !== HTTP_PRECONDITION_FAILED) {
    throw new Error(`PUT ${key}: ${put.status} ${await put.text()}`);
  }
  return "uploaded";
};

/** The model files' keys: uploaded by `uploadModelFile`, never by the blobs' rule. */
const modelKeys = new Set(manifest.modelFiles.map(({ r2Key }) => r2Key));

/**
 * Uploads each blob R2 lacks, `REQUESTS_AT_ONCE` blobs at a time, each a
 * HEAD and, when absent, a PUT: a request in flight per blob.
 */
const uploadBlobs = async (bucket: ReleasesBucket): Promise<void> => {
  const uploadBlob = async ([key, bytes]: [string, Buffer]): Promise<
    "uploaded" | "skipped"
  > => {
    if (modelKeys.has(key)) {
      return await uploadModelFile(bucket, key, bytes);
    }
    // There already, from an earlier release, or put by another writer
    // since the HEAD: kept only if it's these bytes.
    const held =
      (await storedSha256(bucket, key)) ??
      (await putIfAbsent(bucket, key, bytes));
    if (held === undefined) {
      return "uploaded";
    }
    assertStored(key, held, sha256Base64(bytes));
    return "skipped";
  };
  const results = await mapConcurrently(
    [...blobs],
    REQUESTS_AT_ONCE,
    uploadBlob
  );
  const uploaded = results.filter((result) => result === "uploaded").length;
  console.info(
    `Blobs: ${uploaded} uploaded, ${results.length - uploaded} already there`
  );
};

/**
 * The release directory's signature of its manifest, as its download
 * fetched it, once it verifies. Throws for one without, or whose
 * signature doesn't verify: nothing is uploaded.
 */
const verifiedSignature = async (): Promise<Buffer> => {
  const file = path.join(releaseDir, RELEASE_SIGNATURE_FILE);
  const signature = existsSync(file) ? readFileSync(file) : undefined;
  const problem = await releaseSignatureProblem(
    manifestBytes,
    signature,
    releaseSigningKeys,
    manifest.releaseId
  );
  if (problem !== undefined || signature === undefined) {
    throw new Error(
      `Release ${manifest.releaseId} ${problem ?? "isn't signed"}; nothing published`
    );
  }
  return signature;
};

/**
 * Publishes the release under the id it has, its signature (`signature`,
 * checked) first. Published already with these bytes, by an earlier
 * attempt: it stands. With other bytes, another release has the id:
 * nothing is published.
 */
const publishAsBuilt = async (
  bucket: ReleasesBucket,
  signature: Buffer
): Promise<void> => {
  await putSignature(bucket, signature);
  const published = manifestKey(manifest.releaseId);
  const held = await putIfAbsent(
    bucket,
    published,
    manifestBytes,
    "application/json"
  );
  if (held !== undefined && held !== sha256Base64(manifestBytes)) {
    throw new Error(
      `${published} holds another manifest: release ${manifest.releaseId} is another's; nothing published`
    );
  }
  console.info(`Published ${published}`);
};

if (args["dry-run"]) {
  console.info(
    `Dry run: release ${manifest.releaseId} verified; would upload whichever of its ${blobs.size} blobs R2 lacks, then ${manifestKey(manifest.releaseId)}`
  );
} else {
  // Before anything is uploaded: a release that isn't signed stops here.
  const signature = await verifiedSignature();
  const bucket = releasesBucketFromEnv();
  // Before anything is uploaded, the files the directory doesn't carry;
  // after, every one, as the import will check them.
  await assertModelFilesStored(
    bucket,
    manifest.modelFiles.filter(({ r2Key }) => !blobs.has(r2Key))
  );
  await uploadBlobs(bucket);
  await assertModelFilesStored(bucket, manifest.modelFiles);
  await publishAsBuilt(bucket, signature);
}

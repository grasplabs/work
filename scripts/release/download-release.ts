/**
 * Fetches a published release from an R2 bucket into a release directory,
 * as build-release.ts lays one out, for upload-release.ts to publish to
 * another bucket: how Promote release (.github/workflows/promote-release.yml)
 * copies a release staging ran into production's bucket, byte for byte.
 *
 * The manifest is read first, with its signature
 * (@grasp-os/shared/release-signature): a release whose manifest isn't
 * signed by a key Grasp trusts, or was changed since, is refused before
 * anything else is read, so production never gets it. One published
 * before signing began too: production takes signed releases alone.
 * Then every blob it names is checked against it as it arrives
 * (`verifyReleaseBlobs`), its model files by their SHA-256 too, so the
 * release can be published to a bucket that lacks them; one that is
 * missing or doesn't match stops the download. The manifest is written
 * as it is stored, never re-encoded, so what's promoted is what staging
 * published, and its signature beside it (`RELEASE_SIGNATURE_FILE`),
 * which upload-release.ts checks again and publishes with it. Reads only.
 *
 * Env: R2_ENDPOINT, R2_BUCKET (the bucket to read), R2_ACCESS_KEY_ID,
 *      R2_SECRET_ACCESS_KEY
 * Usage: vp run release:download --release <id> --out <dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  manifestKey,
  releaseManifestSchema,
  sha256OfBytes,
  verifyReleaseBlobs,
} from "@grasp-os/shared/release";
import type { Bytes } from "@grasp-os/shared/release";
import { releaseIdSchema } from "@grasp-os/shared/release-id";
import {
  MAX_SIGNATURE_BYTES,
  RELEASE_SIGNATURE_FILE,
  releaseSignatureProblem,
  signatureKey,
} from "@grasp-os/shared/release-signature";
import { releaseSigningKeys } from "@grasp-os/shared/release-signing-keys";

import { REQUESTS_AT_ONCE, releasesBucketFromEnv } from "./bucket-lib.ts";
import { assertReleaseDir, clearReleaseDir } from "./manifest-lib.ts";

const HTTP_NOT_FOUND = 404;

const { values: args } = parseArgs({
  options: {
    release: { type: "string" },
    out: { type: "string" },
  },
});
if (args.release === undefined || args.out === undefined) {
  throw new Error("--release <id> and --out <dir> are required");
}
const releaseId = releaseIdSchema.parse(args.release);
const outDir = path.resolve(args.out);
// Before anything is read: a mistyped `--out` (the repo, a home directory)
// is refused here, never emptied once the manifest arrives.
assertReleaseDir(outDir);

const bucket = releasesBucketFromEnv();

/** The bytes at `key`, or undefined when the bucket holds nothing there. */
const read = async (key: string): Promise<Bytes | undefined> => {
  const response = await bucket.fetch(bucket.url(key));
  if (response.status === HTTP_NOT_FOUND) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`GET ${key}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
};

const write = (key: string, bytes: Uint8Array): void => {
  const file = path.join(outDir, key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
};

const manifestBytes = await read(manifestKey(releaseId));
if (manifestBytes === undefined) {
  throw new Error(`Release ${releaseId} isn't published in ${bucket.name}`);
}
const manifest = releaseManifestSchema.parse(
  JSON.parse(new TextDecoder().decode(manifestBytes))
);
if (manifest.releaseId !== releaseId) {
  throw new Error(
    `${manifestKey(releaseId)} is release ${manifest.releaseId}'s manifest`
  );
}
/**
 * The manifest's signature file, or undefined when there's none; one
 * larger than a signature file is refused before it's read.
 */
const readSignature = async (): Promise<Bytes | undefined> => {
  const key = signatureKey(await sha256OfBytes(manifestBytes));
  const head = await bucket.fetch(bucket.url(key), { method: "HEAD" });
  if (head.status === HTTP_NOT_FOUND) {
    return undefined;
  }
  if (!head.ok) {
    throw new Error(`HEAD ${key}: ${head.status}`);
  }
  if (Number(head.headers.get("content-length") ?? "0") > MAX_SIGNATURE_BYTES) {
    throw new Error(
      `Release ${releaseId} has a signature file that isn't one; nothing promoted`
    );
  }
  return await read(key);
};
const signature = await readSignature();
const problem = await releaseSignatureProblem(
  releaseId,
  manifestBytes,
  signature,
  releaseSigningKeys
);
if (problem !== undefined) {
  throw new Error(`Release ${releaseId} ${problem}; nothing promoted`);
}

// A release directory as build-release.ts writes one, its marker first, so
// a later download (or build) may replace it.
clearReleaseDir(outDir);
// Keys are content addresses under blobs/ by the time they're read:
// `verifyReleaseBlobs` refuses any other, so none names a path outside the
// release directory.
await verifyReleaseBlobs(
  manifest,
  async (key) => {
    const bytes = await read(key);
    if (bytes !== undefined) {
      write(key, bytes);
    }
    return bytes;
  },
  { concurrency: REQUESTS_AT_ONCE }
);
for (const file of manifest.modelFiles) {
  // oxlint-disable-next-line no-await-in-loop -- a few large files, one at a time
  const bytes = await read(file.r2Key);
  if (
    bytes?.byteLength !== file.size ||
    // oxlint-disable-next-line no-await-in-loop -- a few large files, one at a time
    (await sha256OfBytes(bytes)) !== file.sha256
  ) {
    throw new Error(
      `${file.r2Key} (${file.name}) is missing or doesn't match its hash`
    );
  }
  write(file.r2Key, bytes);
}
if (signature !== undefined) {
  write(RELEASE_SIGNATURE_FILE, signature);
}
write("manifest.json", manifestBytes);
console.info(`Release ${releaseId} fetched from ${bucket.name} and verified`);

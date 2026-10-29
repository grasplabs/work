/**
 * Fetches a published release from an R2 bucket into a release directory,
 * as build-release.ts lays one out, for upload-release.ts to publish to
 * another bucket: how Promote release (.github/workflows/promote-release.yml)
 * copies a release staging ran into production's bucket, byte for byte.
 *
 * The manifest is read first and every blob it names is checked against it
 * as it arrives (`verifyReleaseBlobs`); one that is missing or doesn't
 * match stops the download. The manifest and the limit evidence (when the
 * release has one) are written as they are stored, never re-encoded, so
 * what's promoted is what staging published. Reads only.
 *
 * Env: R2_ENDPOINT, R2_BUCKET (the bucket to read), R2_ACCESS_KEY_ID,
 *      R2_SECRET_ACCESS_KEY
 * Usage: vp run release:download --release <id> --out <dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  limitEvidenceFile,
  limitEvidenceKey,
  manifestKey,
  releaseIdSchema,
  releaseManifestSchema,
  verifyReleaseBlobs,
} from "@grasp-os/shared/release";
import type { Bytes } from "@grasp-os/shared/release";
import { AwsClient } from "aws4fetch";

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

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
};

const endpoint = requireEnv("R2_ENDPOINT").replace(/\/$/u, "");
const bucket = requireEnv("R2_BUCKET");
const client = new AwsClient({
  accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
  secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
  service: "s3",
  region: "auto",
});

/** The bytes at `key`, or undefined when the bucket holds nothing there. */
const read = async (key: string): Promise<Bytes | undefined> => {
  const response = await client.fetch(`${endpoint}/${bucket}/${key}`);
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
  throw new Error(`Release ${releaseId} isn't published in ${bucket}`);
}
const manifest = releaseManifestSchema.parse(
  JSON.parse(new TextDecoder().decode(manifestBytes))
);
if (manifest.releaseId !== releaseId) {
  throw new Error(
    `${manifestKey(releaseId)} is release ${manifest.releaseId}'s manifest`
  );
}

// A release directory as build-release.ts writes one, its marker first, so
// a later download (or build) may replace it.
clearReleaseDir(outDir);
// Keys are content addresses under blobs/ by the time they're read:
// `verifyReleaseBlobs` refuses any other, so none names a path outside the
// release directory.
await verifyReleaseBlobs(manifest, async (key) => {
  const bytes = await read(key);
  if (bytes !== undefined) {
    write(key, bytes);
  }
  return bytes;
});
const evidence = await read(limitEvidenceKey(releaseId));
if (evidence !== undefined) {
  write(limitEvidenceFile, evidence);
}
write("manifest.json", manifestBytes);
console.info(`Release ${releaseId} fetched from ${bucket} and verified`);

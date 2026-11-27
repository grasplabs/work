/**
 * Publishes a built release (build-release.ts) to R2 through its S3 API.
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
 * written only if absent, so a published release never changes.
 *
 * With --assign-id (CI's publish) the release gets its id here, from the
 * bucket (@grasp-os/shared/release-id): the next `YY.MM.N` after the ids
 * a listing of the month finds, claimed by writing its manifest only if
 * absent. When another publish claimed that id first, it takes the next
 * one, so two publishes never share an id. Before each claim it writes
 * the id to `commits/<sha>`, so a commit's manifest is only ever at the
 * id its marker names: a re-run of the commit's publish reads the marker
 * and that one manifest, and publishes nothing again when the manifest is
 * the commit's. No other manifest is read: past a listing page per 1,000
 * releases of the month, a publish asks the same of the bucket however
 * many releases it holds.
 * Without it (Promote release) the release keeps the id it has.
 *
 * With --dry-run it verifies the release and says what it would upload,
 * without credentials or network.
 *
 * Env: R2_ENDPOINT (https://<account id>.eu.r2.cloudflarestorage.com),
 *      R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * Usage: vp run release:upload --release <dir> [--assign-id] [--dry-run]
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  commitKey,
  manifestKey,
  mapConcurrently,
  storedModelFileProblem,
} from "@grasp-os/shared/release";
import type { StoredModelFile } from "@grasp-os/shared/release";
import {
  nextReleaseId,
  releaseIdSchema,
  releaseMonthPrefix,
} from "@grasp-os/shared/release-id";
import { z } from "zod";

import { stampReleaseId } from "./assign-lib.ts";
import { REQUESTS_AT_ONCE, releasesBucketFromEnv } from "./bucket-lib.ts";
import type { ReleasesBucket } from "./bucket-lib.ts";
import { verifyRelease } from "./manifest-lib.ts";

/** What a published manifest is read for when looking for a commit's release. */
const publishedCommitSchema = z.object({ commit: z.string() });

const HTTP_NOT_FOUND = 404;
const HTTP_PRECONDITION_FAILED = 412;
/**
 * Most ids one publish tries: each one another publish claimed first
 * costs one. Far more than publishes ever overlap.
 */
const MAX_ID_ATTEMPTS = 20;

const { values: args } = parseArgs({
  options: {
    release: { type: "string" },
    "assign-id": { type: "boolean", default: false },
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
 * there: the SHA-256 it reports is then theirs, never a failure.
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
  if (put.status === HTTP_PRECONDITION_FAILED) {
    return (await storedSha256(bucket, key)) ?? "none";
  }
  if (!put.ok) {
    throw new Error(`PUT ${key}: ${put.status} ${await put.text()}`);
  }
  return undefined;
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
 * Publishes the release under the id it has (Promote release). Published
 * already, by an earlier attempt: it stands.
 */
const publishAsBuilt = async (bucket: ReleasesBucket): Promise<void> => {
  const published = manifestKey(manifest.releaseId);
  const held = await putIfAbsent(
    bucket,
    published,
    manifestBytes,
    "application/json"
  );
  if (held !== undefined && held !== sha256Base64(manifestBytes)) {
    console.warn(`::warning::${published} is already published; left as it is`);
    return;
  }
  console.info(`Published ${published}`);
};

/** Whether release `id`'s manifest is published, and is `manifest.commit`'s. */
const isThisCommits = async (
  bucket: ReleasesBucket,
  id: string
): Promise<boolean> => {
  const published = await bucket.fetch(bucket.url(manifestKey(id)));
  if (published.status === HTTP_NOT_FOUND) {
    return false;
  }
  if (!published.ok) {
    throw new Error(`GET ${manifestKey(id)}: ${published.status}`);
  }
  const { commit } = publishedCommitSchema.parse(await published.json());
  return commit === manifest.commit;
};

/**
 * The release `manifest.commit` was published as already, if it was: the
 * id its marker (`commits/<sha>`) names, once that id's manifest is the
 * commit's. An attempt that stopped between its marker and its manifest,
 * or lost the id to another publish, left a marker whose id isn't.
 */
const publishedAs = async (
  bucket: ReleasesBucket
): Promise<string | undefined> => {
  const marker = commitKey(manifest.commit);
  const named = await bucket.fetch(bucket.url(marker));
  if (named.status === HTTP_NOT_FOUND) {
    return undefined;
  }
  if (!named.ok) {
    throw new Error(`GET ${marker}: ${named.status}`);
  }
  const text = await named.text();
  const id = releaseIdSchema.parse(text.trim());
  return (await isThisCommits(bucket, id)) ? id : undefined;
};

/**
 * Publishes the release under the next id of the month (CI's publish):
 * each attempt names its id in the commit's marker, then claims it by
 * writing the manifest only if absent, and moves on to the next id when
 * another publish has it.
 */
const publishWithNextId = async (bucket: ReleasesBucket): Promise<void> => {
  const marker = commitKey(manifest.commit);
  const now = new Date();
  const taken = new Set(await bucket.listIds(releaseMonthPrefix(now)));
  for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS; attempt += 1) {
    const id = nextReleaseId(taken, now);
    taken.add(id);
    const stamped = stampReleaseId(manifestBytes, id);
    const published = manifestKey(id);
    // The marker first, so the commit's manifest is only ever at the id
    // its marker names (`publishedAs`). Replaced, not written only if
    // absent: only this commit's publish writes it, and GitHub runs one
    // attempt of a run at a time, in the workflow's one-at-a-time group.
    const markerBytes = Buffer.from(`${id}\n`);
    // oxlint-disable-next-line no-await-in-loop -- one id at a time, until one is ours
    const named = await bucket.fetch(bucket.url(marker), {
      method: "PUT",
      body: markerBytes,
      headers: {
        "Content-Type": "text/plain",
        "x-amz-checksum-sha256": sha256Base64(markerBytes),
      },
    });
    if (!named.ok) {
      // oxlint-disable-next-line no-await-in-loop -- once, on the way out
      throw new Error(`PUT ${marker}: ${named.status} ${await named.text()}`);
    }
    // The manifest is the claim, only if absent. Found there already, it's
    // this commit's when an earlier try or attempt put it there: a lost
    // answer, or a build of the same commit, whose bytes may differ.
    const claimed =
      // oxlint-disable-next-line no-await-in-loop -- one id at a time, until one is ours
      (await putIfAbsent(
        bucket,
        published,
        stamped.manifestBytes,
        "application/json"
      )) === undefined ||
      // oxlint-disable-next-line no-await-in-loop -- only when the id was taken
      (await isThisCommits(bucket, id));
    if (claimed) {
      console.info(`Published ${published}: release ${id}`);
      return;
    }
    console.info(`Release ${id} is another publish's; trying the next id`);
  }
  throw new Error(
    `Found no free release id in ${MAX_ID_ATTEMPTS} tries; nothing published`
  );
};

if (args["dry-run"]) {
  console.info(
    args["assign-id"]
      ? `Dry run: release ${manifest.releaseId} verified; would upload whichever of its ${blobs.size} blobs R2 lacks, then publish it as the month's next release`
      : `Dry run: release ${manifest.releaseId} verified; would upload whichever of its ${blobs.size} blobs R2 lacks, then ${manifestKey(manifest.releaseId)}`
  );
} else {
  const bucket = releasesBucketFromEnv();
  const earlier = args["assign-id"] ? await publishedAs(bucket) : undefined;
  if (earlier === undefined) {
    // Before anything is uploaded, the files the directory doesn't carry;
    // after, every one, as the import will check them.
    await assertModelFilesStored(
      bucket,
      manifest.modelFiles.filter(({ r2Key }) => !blobs.has(r2Key))
    );
    await uploadBlobs(bucket);
    await assertModelFilesStored(bucket, manifest.modelFiles);
    await (args["assign-id"]
      ? publishWithNextId(bucket)
      : publishAsBuilt(bucket));
  } else {
    // A re-run of the commit's publish: the release it published stands.
    console.warn(
      `::warning::${manifest.commit} is already published, as release ${earlier}; nothing published again`
    );
  }
}

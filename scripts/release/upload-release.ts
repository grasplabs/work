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
 * The manifest goes up last, to `releases/<id>/manifest.json`: the admin
 * imports only releases whose manifest exists, so an upload that stops
 * halfway never leaves a manifest pointing at missing blobs. It's
 * written only if absent, so a published release never changes.
 *
 * With --assign-id (CI's publish) the release gets its id here, from the
 * bucket (@grasp-os/shared/release-id): the next `YY.MM.N` of the month,
 * claimed by writing its first key under `releases/<id>/` only if absent
 * (the limit evidence, or the manifest of a release without one). When
 * another publish claimed that id first, it takes the next one, so two
 * publishes never share an id. Once published, `commits/<sha>` records the
 * id, and a re-run of the same commit's publish publishes nothing again.
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
  limitEvidenceKey,
  manifestKey,
} from "@grasp-os/shared/release";
import { nextReleaseId, releaseMonthPrefix } from "@grasp-os/shared/release-id";

import { stampReleaseId } from "./assign-lib.ts";
import { releasesBucketFromEnv } from "./bucket-lib.ts";
import type { ReleasesBucket } from "./bucket-lib.ts";
import { readLimitEvidence } from "./evidence-lib.ts";
import { verifyRelease } from "./manifest-lib.ts";

const UPLOAD_CONCURRENCY = 8;
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
const evidenceBytes = readLimitEvidence(releaseDir, manifest);

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

const uploadBlobs = async (bucket: ReleasesBucket): Promise<void> => {
  const uploadBlob = async (
    key: string,
    bytes: Buffer
  ): Promise<"uploaded" | "skipped"> => {
    const expected = sha256Base64(bytes);
    const existing = await storedSha256(bucket, key);
    if (existing !== undefined) {
      assertStored(key, existing, expected);
      return "skipped";
    }
    const put = await bucket.fetch(bucket.url(key), {
      method: "PUT",
      body: bytes,
      headers: { "If-None-Match": "*", "x-amz-checksum-sha256": expected },
    });
    if (put.status === HTTP_PRECONDITION_FAILED) {
      // Another writer stored it since the HEAD: skipped only if it matches.
      assertStored(key, (await storedSha256(bucket, key)) ?? "none", expected);
      return "skipped";
    }
    if (!put.ok) {
      throw new Error(`PUT ${key}: ${put.status} ${await put.text()}`);
    }
    return "uploaded";
  };

  // A fixed number of workers, each taking the next blob off the queue.
  const queue = [...blobs];
  const results: ("uploaded" | "skipped")[] = [];
  const work = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      // oxlint-disable-next-line no-await-in-loop -- each worker uploads one blob at a time
      results.push(await uploadBlob(...next));
    }
  };
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, work));
  const uploaded = results.filter((result) => result === "uploaded").length;
  console.info(
    `Blobs: ${uploaded} uploaded, ${results.length - uploaded} already there`
  );
};

/** PUTs `bytes` at `key`; false when `onlyIfAbsent` and R2 holds something there. */
const putFile = async (
  bucket: ReleasesBucket,
  key: string,
  bytes: Buffer,
  {
    onlyIfAbsent,
    contentType = "application/json",
  }: { onlyIfAbsent: boolean; contentType?: string }
): Promise<boolean> => {
  const response = await bucket.fetch(bucket.url(key), {
    method: "PUT",
    body: bytes,
    headers: {
      "Content-Type": contentType,
      "x-amz-checksum-sha256": sha256Base64(bytes),
      // The same SHA-256, hex, as the admin's import reads it when R2
      // doesn't report the checksum to a Worker.
      "x-amz-meta-sha256": createHash("sha256").update(bytes).digest("hex"),
      ...(onlyIfAbsent ? { "If-None-Match": "*" } : {}),
    },
  });
  if (onlyIfAbsent && response.status === HTTP_PRECONDITION_FAILED) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`PUT ${key}: ${response.status} ${await response.text()}`);
  }
  return true;
};

/**
 * Publishes the release under the id it has (Promote release). Published
 * already, by an earlier attempt: it stands, its evidence with it.
 */
const publishAsBuilt = async (bucket: ReleasesBucket): Promise<void> => {
  const published = manifestKey(manifest.releaseId);
  if ((await storedSha256(bucket, published)) !== undefined) {
    console.warn(`::warning::${published} is already published; left as it is`);
    return;
  }
  // The limit evidence, just before the manifest: nothing reads it until
  // the manifest is there, so one an attempt that stopped left behind is
  // replaced. R2 checks its SHA-256 on write, and the admin checks it
  // again on import, before it stores anything.
  if (evidenceBytes !== undefined) {
    await putFile(bucket, limitEvidenceKey(manifest.releaseId), evidenceBytes, {
      onlyIfAbsent: false,
    });
  }
  if (
    !(await putFile(bucket, published, manifestBytes, { onlyIfAbsent: true }))
  ) {
    console.warn(`::warning::${published} is already published; left as it is`);
    return;
  }
  console.info(`Published ${published}`);
};

/** The release `manifest.commit` was published as already, if it was. */
const publishedAs = async (
  bucket: ReleasesBucket
): Promise<string | undefined> => {
  const marker = commitKey(manifest.commit);
  const response = await bucket.fetch(bucket.url(marker));
  if (response.status === HTTP_NOT_FOUND) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`GET ${marker}: ${response.status}`);
  }
  const id = await response.text();
  return id.trim();
};

/**
 * Publishes the release under the next id of the month (CI's publish):
 * each attempt claims an id with the first key it writes under it, only
 * if absent, and moves on to the next id when another publish has it.
 */
const publishWithNextId = async (bucket: ReleasesBucket): Promise<void> => {
  const marker = commitKey(manifest.commit);
  const taken = new Set(await bucket.listIds(releaseMonthPrefix(new Date())));
  for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS; attempt += 1) {
    const id = nextReleaseId(taken, new Date());
    taken.add(id);
    const stamped = stampReleaseId(manifestBytes, evidenceBytes, id);
    const published = manifestKey(id);
    // The evidence, when there is one, is the claim; then the manifest,
    // last, only if absent too.
    const evidenceClaimed =
      stamped.evidenceBytes === undefined ||
      // oxlint-disable-next-line no-await-in-loop -- one id at a time, until one is ours
      (await putFile(bucket, limitEvidenceKey(id), stamped.evidenceBytes, {
        onlyIfAbsent: true,
      }));
    const claimed =
      evidenceClaimed &&
      // oxlint-disable-next-line no-await-in-loop -- one id at a time, until one is ours
      (await putFile(bucket, published, stamped.manifestBytes, {
        onlyIfAbsent: true,
      }));
    if (claimed) {
      // oxlint-disable-next-line no-await-in-loop -- once, when published
      await putFile(bucket, marker, Buffer.from(`${id}\n`), {
        onlyIfAbsent: true,
        contentType: "text/plain",
      });
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
    await uploadBlobs(bucket);
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

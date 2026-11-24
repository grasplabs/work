/**
 * Puts the embedder's model files in a releases bucket, once per model:
 * the files of `shippedModel` (@grasp-os/embed), each at its content
 * address (`modelBlobKey`), where every release that names them finds
 * them. About 100 MB, so never in git or in a build: whoever exports a
 * model (packages/embed/scripts/export.py) runs this with the directory
 * it wrote, before the first release that names it is published. Promote
 * release then copies them to production's bucket with each release.
 *
 * Each file in `--dir` is hashed; one the model doesn't name is refused,
 * and nothing is uploaded until every file the model names is found with
 * its size and hash. Each is PUT with its SHA-256, which R2 checks on
 * write, only if absent; one already there is skipped only when its
 * stored SHA-256 matches.
 *
 * Env: R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * Usage: vp run release:model-files --dir <dir>
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { modelFilesOf, shippedModel } from "@grasp-os/embed/model-files";
import { modelBlobKey } from "@grasp-os/shared/release";

import { releasesBucketFromEnv } from "./bucket-lib.ts";

const HTTP_NOT_FOUND = 404;
const HTTP_PRECONDITION_FAILED = 412;

const { values: args } = parseArgs({ options: { dir: { type: "string" } } });
if (args.dir === undefined) {
  throw new Error("--dir <dir> is required");
}
const dir = path.resolve(args.dir);
const named = new Map(
  modelFilesOf(shippedModel).map((file) => [file.sha256, file])
);
const found = new Map<string, Buffer>();
for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (!entry.isFile()) {
    continue;
  }
  const bytes = readFileSync(path.join(dir, entry.name));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = named.get(sha256);
  if (file === undefined || file.size !== bytes.byteLength) {
    throw new Error(
      `${entry.name} isn't a file of ${shippedModel.name} (SHA-256 ${sha256}); nothing uploaded`
    );
  }
  found.set(sha256, bytes);
}
const missing = [...named.values()].filter(({ sha256 }) => !found.has(sha256));
if (missing.length > 0) {
  throw new Error(
    `${dir} lacks ${shippedModel.name}'s ${missing.map(({ which }) => which).join(", ")}; nothing uploaded`
  );
}

const bucket = releasesBucketFromEnv();
for (const [sha256, bytes] of found) {
  const key = modelBlobKey(sha256);
  const checksum = createHash("sha256").update(bytes).digest("base64");
  // oxlint-disable-next-line no-await-in-loop -- three files, one at a time
  const head = await bucket.fetch(bucket.url(key), {
    method: "HEAD",
    headers: { "x-amz-checksum-mode": "ENABLED" },
  });
  if (!head.ok && head.status !== HTTP_NOT_FOUND) {
    throw new Error(`HEAD ${key}: ${head.status}`);
  }
  const stored = head.ok ? head.headers.get("x-amz-checksum-sha256") : null;
  if (stored === checksum) {
    console.info(`${key}: already there`);
    continue;
  }
  if (stored !== null) {
    throw new Error(`${key} in R2 isn't this file's bytes`);
  }
  // oxlint-disable-next-line no-await-in-loop -- three files, one at a time
  const put = await bucket.fetch(bucket.url(key), {
    method: "PUT",
    body: bytes,
    // There without a SHA-256 (put some other way): put again over itself,
    // R2 checking the bytes against the SHA-256 it then keeps.
    headers: {
      ...(head.ok ? {} : { "If-None-Match": "*" }),
      "x-amz-checksum-sha256": checksum,
    },
  });
  if (!put.ok && put.status !== HTTP_PRECONDITION_FAILED) {
    // oxlint-disable-next-line no-await-in-loop -- three files, one at a time
    throw new Error(`PUT ${key}: ${put.status} ${await put.text()}`);
  }
  console.info(`${key}: uploaded`);
}

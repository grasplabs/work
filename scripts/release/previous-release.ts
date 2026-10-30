/**
 * Fetches the manifest of the release published before the one this CI run
 * publishes (previous-lib.ts), for evidence-release.ts's `--previous`:
 * what the new release's platform limits are raised over. Writes `null`
 * when there's none. Reads only.
 *
 * Env: R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * Usage: vp run release:previous --out <file>
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { manifestKey } from "@grasp-os/shared/release";

import { releasesBucketFromEnv } from "./bucket-lib.ts";
import { newestReleaseIds } from "./previous-lib.ts";

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
  },
});
if (args.out === undefined) {
  throw new Error("--out <file> is required");
}
const out = path.resolve(args.out);

const bucket = releasesBucketFromEnv();

const HTTP_NOT_FOUND = 404;

/** The newest release whose manifest exists, and its bytes. */
const previousManifest = async (): Promise<
  { id: string; bytes: Uint8Array } | undefined
> => {
  for (const id of newestReleaseIds(await bucket.listIds())) {
    const key = manifestKey(id);
    // oxlint-disable-next-line no-await-in-loop -- newest first, until one is published
    const response = await bucket.fetch(bucket.url(key));
    if (response.status === HTTP_NOT_FOUND) {
      continue;
    }
    if (!response.ok) {
      throw new Error(`GET ${key}: ${response.status}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- the one wanted
    return { id, bytes: new Uint8Array(await response.arrayBuffer()) };
  }
  return undefined;
};

const previous = await previousManifest();
if (previous === undefined) {
  writeFileSync(out, "null\n");
  console.info("No release published yet");
} else {
  writeFileSync(out, previous.bytes);
  console.info(`The release before this one is ${previous.id}`);
}

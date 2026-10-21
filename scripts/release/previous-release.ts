/**
 * Fetches the manifest of the release published before the one this CI run
 * builds (previous-lib.ts), for build-release.ts's `--previous`: what the
 * new release's platform limits are raised over. Writes `null` when there's
 * none. Reads only.
 *
 * Env: R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY;
 *      GITHUB_RUN_NUMBER, the run being built, unless --before-run is given
 * Usage: vp run release:previous --out <file> [--before-run <n>]
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { manifestKey } from "@grasp-os/shared/release";
import { AwsClient } from "aws4fetch";

import { parseReleaseListing, previousReleaseId } from "./previous-lib.ts";

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    "before-run": { type: "string" },
  },
});
if (args.out === undefined) {
  throw new Error("--out <file> is required");
}
const out = path.resolve(args.out);

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
};

const beforeRun = Number(args["before-run"] ?? requireEnv("GITHUB_RUN_NUMBER"));
if (!Number.isSafeInteger(beforeRun) || beforeRun < 1) {
  throw new Error(`${beforeRun} isn't a run number`);
}

const endpoint = requireEnv("R2_ENDPOINT").replace(/\/$/u, "");
const bucket = requireEnv("R2_BUCKET");
const client = new AwsClient({
  accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
  secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
  service: "s3",
  region: "auto",
});

const publishedIds = async (): Promise<string[]> => {
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const query = new URLSearchParams({
      "list-type": "2",
      prefix: "releases/",
      delimiter: "/",
      ...(token === undefined ? {} : { "continuation-token": token }),
    });
    // oxlint-disable-next-line no-await-in-loop -- each page names the next
    const response = await client.fetch(
      `${endpoint}/${bucket}?${query.toString()}`
    );
    if (!response.ok) {
      throw new Error(`LIST releases/: ${response.status}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- each page names the next
    const page = parseReleaseListing(await response.text());
    ids.push(...page.ids);
    token = page.next;
  } while (token !== undefined);
  return ids;
};

const previous = previousReleaseId(await publishedIds(), beforeRun);
if (previous === undefined) {
  writeFileSync(out, "null\n");
  console.info(`No release published before run ${beforeRun}`);
} else {
  const key = manifestKey(previous);
  const response = await client.fetch(`${endpoint}/${bucket}/${key}`);
  if (!response.ok) {
    throw new Error(`GET ${key}: ${response.status}`);
  }
  writeFileSync(out, new Uint8Array(await response.arrayBuffer()));
  console.info(`The release before run ${beforeRun} is ${previous}`);
}

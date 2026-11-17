/**
 * Puts the files of the embedding model core ships in a local stack's
 * model files bucket (core's `MODEL_FILES`, in the state wrangler dev runs
 * on), from this machine's model files cache (scripts/model-files.ts): as
 * a deploy puts a release's in a deployment's bucket, so the stack embeds
 * and recalls by meaning as a deployment does. Core's `dev:migrate` runs
 * it, so `vp run dev` and the e2e stack each start with the model; a
 * stack's state that holds them already is left as it is.
 *
 * Without them in the cache the stack still runs, recalling by words
 * alone, and this says so, once, with how to get them.
 *
 *   node scripts/local-model-files.ts --persist-to <dir> -c <core's wrangler.jsonc>
 */
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  modelFileKey,
  modelFilesOf,
  shippedModel,
} from "@grasp-os/embed/model-files";
import { getPlatformProxy } from "wrangler";
import { z } from "zod";

import { parseJsonc } from "./jsonc.ts";
import { cachedModelFile, isCached } from "./model-files.ts";

/** What this script asks of the bucket: R2's own calls, as the proxy gives them. */
interface ModelBucket {
  head: (key: string) => Promise<{ size: number } | null>;
  put: (
    key: string,
    value: Uint8Array,
    options: { sha256: string }
  ) => Promise<unknown>;
}

/** The part of a wrangler config that names core's model files bucket. */
const modelBucketOf = (config: string): string => {
  const { r2_buckets: buckets } = z
    .object({
      r2_buckets: z.array(
        z.object({ binding: z.string(), bucket_name: z.string() })
      ),
    })
    .parse(parseJsonc(readFileSync(config, "utf-8")));
  const bucket = buckets.find(({ binding }) => binding === "MODEL_FILES");
  if (bucket === undefined) {
    throw new Error(`${config} binds no MODEL_FILES bucket`);
  }
  return bucket.bucket_name;
};

const { values: args } = parseArgs({
  options: {
    "persist-to": { type: "string" },
    config: { type: "string", short: "c" },
  },
});
if (args["persist-to"] === undefined || args.config === undefined) {
  throw new Error(
    "Usage: local-model-files.ts --persist-to <dir> -c <wrangler.jsonc>"
  );
}

const files = modelFilesOf(shippedModel);
if (files.every(isCached)) {
  // Only the bucket, in the state wrangler dev keeps under `--persist-to`
  // (its `v3`): nothing else of core starts.
  const scratch = mkdtempSync(path.join(tmpdir(), "local-model-files-"));
  const config = path.join(scratch, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "local-model-files",
      compatibility_date: "2026-11-01",
      r2_buckets: [
        { binding: "MODEL_FILES", bucket_name: modelBucketOf(args.config) },
      ],
    })
  );
  const proxy = await getPlatformProxy<{ MODEL_FILES: ModelBucket }>({
    configPath: config,
    persist: { path: path.join(path.resolve(args["persist-to"]), "v3") },
  });
  try {
    const bucket = proxy.env.MODEL_FILES;
    for (const file of files) {
      const key = modelFileKey(file);
      // oxlint-disable-next-line no-await-in-loop -- three files, one at a time
      const there = await bucket.head(key);
      if (there?.size === file.size) {
        continue;
      }
      // The embedder checks it again, by its SHA-256, as it loads it.
      // oxlint-disable-next-line no-await-in-loop -- three files, one at a time
      await bucket.put(key, readFileSync(cachedModelFile(file)), {
        sha256: file.sha256,
      });
    }
    console.info(`${shippedModel.name}'s model files are in the stack`);
  } finally {
    await proxy.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
} else {
  console.warn(
    `${shippedModel.name}'s model files aren't on this machine, so the Brain recalls by words alone. Get them once with \`vp run model-files --dir <the folder the model was exported to>\`, or from the releases bucket with its read keys (\`vp run model-files\`), then start again.`
  );
}

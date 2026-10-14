/**
 * The on-prem profile's R2 in a workerd config: the R2 service
 * (apps/core/src/on-prem/r2.ts) as a Worker of its own, and each of core's
 * R2 bindings as workerd's own R2 client pointed at it. The workerd smoke
 * run serves core with it; its test serves a Worker of its own.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

import { z } from "zod";

import { parseJsonc } from "./wrangler-config-rules.ts";

/** The R2 service's name in the workerd config. */
export const r2ServiceName = "r2";

const r2Source = path.join(
  import.meta.dirname,
  "../apps/core/src/on-prem/r2.ts"
);

/** Every R2 bucket a Worker binds, by binding name, from its wrangler.jsonc. */
export const r2BucketsOf = (wranglerConfig: string): string[] =>
  z
    .object({ r2_buckets: z.array(z.object({ binding: z.string() })) })
    .parse(parseJsonc(readFileSync(wranglerConfig, "utf-8")))
    .r2_buckets.map(({ binding }) => binding);

/**
 * Writes the R2 service's module into `out`, next to the config. It
 * imports nothing but the runtime's own modules, so it needs no bundling:
 * its types are stripped and that is the module.
 */
export const writeR2Service = (out: string): void => {
  writeFileSync(
    path.join(out, "r2.js"),
    stripTypeScriptTypes(readFileSync(r2Source, "utf-8"))
  );
};

/**
 * The R2 service's capnp entry. Its buckets live in the disk service
 * `storage`: workerd keeps a Durable Object's SQLite database only on disk.
 */
export const r2Service = (
  storage: string
): string => `(name = "${r2ServiceName}", worker = (
    modules = [(name = "r2.js", esModule = embed "r2.js")],
    compatibilityDate = "2026-09-15",
    bindings = [
      (name = "BUCKETS", durableObjectNamespace = (className = "R2Store")),
    ],
    durableObjectNamespaces = [
      (className = "R2Store", uniqueKey = "R2Store", enableSql = true),
    ],
    durableObjectStorage = (localDisk = "${storage}"),
  ))`;

/**
 * Each bucket's binding: workerd's own R2 client, which sends its requests
 * to the R2 service with the binding's name, the way Miniflare binds R2
 * for Wrangler's local dev and the tests.
 */
export const r2Bindings = (buckets: readonly string[]): string[] =>
  buckets.map(
    (bucket) =>
      `(name = "${bucket}", r2Bucket = (name = "${r2ServiceName}", props = (json = ${JSON.stringify(JSON.stringify({ bucket }))})))`
  );

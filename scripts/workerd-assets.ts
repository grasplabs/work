/**
 * The on-prem profile's static assets in a workerd config: the assets
 * service (apps/core/src/on-prem/assets.ts) as a Worker of its own over a
 * read-only disk service of the assets' folder, and core's `ASSETS` bound
 * to it. The workerd smoke run serves core with it; its test serves a
 * folder of its own.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

import { z } from "zod";

import { parseJsonc } from "./wrangler-config-rules.ts";

/** The assets service's name in the workerd config. */
export const assetsServiceName = "assets";

/** The disk service the assets service reads the folder through. */
const assetFilesServiceName = "asset-files";

const assetsSource = path.join(
  import.meta.dirname,
  "../apps/core/src/on-prem/assets.ts"
);

/**
 * The folder a Worker's static assets are in, and the binding it reads
 * them through, from its wrangler.jsonc.
 */
export const assetsOf = (
  wranglerConfig: string
): { binding: string; directory: string } => {
  const { assets } = z
    .object({
      assets: z.object({ binding: z.string(), directory: z.string() }),
    })
    .parse(parseJsonc(readFileSync(wranglerConfig, "utf-8")));
  return {
    binding: assets.binding,
    directory: path.resolve(path.dirname(wranglerConfig), assets.directory),
  };
};

/**
 * Writes the assets service's module into `out`, next to the config. It
 * imports nothing, so it needs no bundling: its types are stripped and
 * that is the module.
 */
export const writeAssetsService = (out: string): void => {
  writeFileSync(
    path.join(out, "assets.js"),
    stripTypeScriptTypes(readFileSync(assetsSource, "utf-8"))
  );
};

/**
 * The assets service's capnp entries: the Worker, and the disk service
 * over `directory` it reads, which never writes and never serves a
 * dotfile.
 */
export const assetsServices = (directory: string): string[] => [
  `(name = "${assetsServiceName}", worker = (
    modules = [(name = "assets.js", esModule = embed "assets.js")],
    compatibilityDate = "2026-09-15",
    bindings = [(name = "FILES", service = "${assetFilesServiceName}")],
  ))`,
  `(name = "${assetFilesServiceName}", disk = (path = ${JSON.stringify(directory)}))`,
];

/** A Worker's binding to the assets service, named `binding`. */
export const assetsBinding = (binding: string): string =>
  `(name = "${binding}", service = "${assetsServiceName}")`;

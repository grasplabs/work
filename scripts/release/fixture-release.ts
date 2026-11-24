/**
 * A release built from the real wrangler.jsonc of core and connect, with
 * fixture bundles, assets and migrations in place of a build. Shared by the
 * release tests.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { parseJsonc } from "../wrangler-config-rules.ts";
import { collectAssets, collectModules, collectSqlFiles } from "./hash-lib.ts";
import { parseWranglerConfig } from "./manifest-lib.ts";
import type { ReleaseInfo, WorkerBuild } from "./manifest-lib.ts";

const ROOT = path.join(import.meta.dirname, "../..");
const TESTDATA = path.join(import.meta.dirname, "testdata");

export const rawConfig = (app: string): Record<string, unknown> =>
  z
    .record(z.string(), z.unknown())
    .parse(
      parseJsonc(
        readFileSync(path.join(ROOT, "apps", app, "wrangler.jsonc"), "utf-8")
      )
    );

export const fixtureBuild = async (app: string): Promise<WorkerBuild> => {
  const config = parseWranglerConfig(app, rawConfig(app));
  const migrations = await collectSqlFiles(path.join(TESTDATA, "migrations"));
  return {
    key: app,
    config,
    ...(await collectModules(path.join(TESTDATA, "bundles", app), {
      sourceMaps: config.upload_source_maps,
    })),
    d1Migrations: Object.fromEntries(
      config.d1_databases.map((database) => [database.binding, migrations])
    ),
    ...(config.assets
      ? { assets: await collectAssets(path.join(TESTDATA, "assets")) }
      : {}),
  };
};

/** The embedder's tiny test model (packages/embed/test/fixtures), as its files are stored. */
const modelFixtures = path.join(ROOT, "packages/embed/test/fixtures");

/** The files of the fixture model a release names, as named, and where each is. */
export const fixtureModelFiles = [
  "tokenizer.bin",
  "encoder-int8.bin",
  "tokens-int8.bin",
].map((name) => {
  const file = path.join(modelFixtures, name);
  const bytes = readFileSync(file);
  return {
    name: `fixture-int8/${name}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    file,
  };
});

export const info: ReleaseInfo = {
  releaseId: "26.01.1",
  commit: "0".repeat(40),
  createdAt: "2026-01-01T00:00:00.000Z",
  notes: "feat(core): a fixture",
  wranglerVersion: "0.0.0-fixture",
  packages: { zod: "0.0.0-fixture" },
  modelFiles: fixtureModelFiles.map(({ name, sha256, size }) => ({
    name,
    sha256,
    size,
  })),
};

export const builds = async (): Promise<WorkerBuild[]> =>
  await Promise.all(["connect", "core"].map(fixtureBuild));

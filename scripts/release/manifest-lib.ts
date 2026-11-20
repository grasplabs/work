/**
 * Generates the release manifest (@grasp-os/shared/release, the contract
 * with the admin) from each Worker's wrangler.jsonc and build, and writes
 * and verifies a release directory.
 *
 * Names (Workers, D1 databases, R2 buckets, the workflow) are the same in
 * every client account; what differs per account is a placeholder the
 * admin fills in for the Worker it deploys (see the manifest's header
 * comment).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import {
  assetKey,
  bindingNameSchema as bindingName,
  d1IdPlaceholder,
  MANIFEST_VERSION,
  migrationKey,
  modelBlobKey,
  modelFilesBinding,
  moduleKey,
  observabilitySchema,
  releaseManifestSchema,
  sha256OfBytes,
  verifyReleaseBlobs,
} from "@grasp-os/shared/release";
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
import { z } from "zod";

import { stableStringify } from "./hash-lib.ts";
import type {
  CollectedAssets,
  CollectedFile,
  CollectedModule,
} from "./hash-lib.ts";

const named = z.strictObject({ binding: bindingName });

// Every wrangler.jsonc key a released Worker may use, and the shape of each.
// Strict at every level: a key this generator doesn't handle fails the build,
// since a new config key needs a decision about how client accounts get it.
const wranglerConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  name: z.string(),
  main: z.string(),
  compatibility_date: z.iso.date(),
  compatibility_flags: z.array(z.string()).default([]),
  workers_dev: z.boolean(),
  preview_urls: z.boolean(),
  // Bundling only: the modules it produces are in the dry-run output.
  rules: z.array(z.unknown()).optional(),
  minify: z.boolean().optional(),
  keep_names: z.boolean().optional(),
  // Its source maps go up with its modules, as Wrangler uploads them by
  // default.
  upload_source_maps: z.boolean().default(true),
  // Passed to the Workers API as it is, so only keys that mean the same in
  // every account: one like `destinations` names account resources.
  observability: observabilitySchema.default({}),
  assets: z
    .strictObject({
      directory: z.string(),
      binding: bindingName.optional(),
      not_found_handling: z
        .enum(["none", "404-page", "single-page-application"])
        .optional(),
      run_worker_first: z.union([z.boolean(), z.array(z.string())]).optional(),
    })
    .optional(),
  keep_vars: z.boolean().default(false),
  secrets: z.strictObject({ required: z.array(bindingName) }).optional(),
  durable_objects: z
    .strictObject({
      bindings: z.array(
        z.strictObject({ name: bindingName, class_name: z.string() })
      ),
    })
    .optional(),
  // Replayed in order, never interpreted: carried through as written.
  migrations: z.array(z.looseObject({ tag: z.string() })).default([]),
  workflows: z
    .array(
      z.strictObject({
        name: z.string(),
        binding: bindingName,
        class_name: z.string(),
      })
    )
    .default([]),
  worker_loaders: z.array(named).default([]),
  d1_databases: z
    .array(
      z.strictObject({
        binding: bindingName,
        database_name: z.string(),
        migrations_dir: z.string().default("migrations"),
        // Local dev only.
        preview_database_id: z.string().optional(),
      })
    )
    .default([]),
  // EU only: a bucket's jurisdiction is set when it's created.
  r2_buckets: z
    .array(
      z.strictObject({
        binding: bindingName,
        bucket_name: z.string(),
        jurisdiction: z.literal("eu"),
      })
    )
    .default([]),
  triggers: z.strictObject({ crons: z.array(z.string()) }).optional(),
  send_email: z.array(z.strictObject({ name: bindingName })).default([]),
  version_metadata: z.strictObject({ binding: bindingName }).optional(),
  services: z
    .array(
      z.strictObject({
        binding: bindingName,
        service: z.string(),
        entrypoint: z.string().optional(),
      })
    )
    .default([]),
});

/** The part of a wrangler.jsonc a release reads. */
export type WranglerConfig = z.infer<typeof wranglerConfigSchema>;

/** Parses a released Worker's wrangler.jsonc, failing on anything unhandled. */
export const parseWranglerConfig = (
  file: string,
  config: unknown
): WranglerConfig => {
  const result = wranglerConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `${file} has config the release generator doesn't handle; decide how client accounts get it:\n${z.prettifyError(result.error)}`
    );
  }
  return result.data;
};

/** One Worker's build output, as {@link generateManifest} takes it. */
export interface WorkerBuild {
  /** The app, e.g. `core`. */
  key: string;
  config: WranglerConfig;
  mainModule: string;
  modules: CollectedModule[];
  /** Each D1 binding's migrations. */
  d1Migrations: Record<string, CollectedFile[]>;
  /** The assets directory's contents, for a Worker that serves assets. */
  assets?: CollectedAssets;
}

type Binding = WorkerEntry["bindings"][number];

const bindingsOf = (
  config: WranglerConfig,
  releaseNames: Set<string>
): Binding[] => [
  ...(config.durable_objects?.bindings ?? []).map((object) => ({
    type: "durable_object_namespace",
    name: object.name,
    class_name: object.class_name,
  })),
  ...config.workflows.map((workflow) => ({
    type: "workflow",
    name: workflow.binding,
    workflow_name: workflow.name,
    class_name: workflow.class_name,
  })),
  ...config.worker_loaders.map((loader) => ({
    type: "worker_loader",
    name: loader.binding,
  })),
  ...config.d1_databases.map((database) => ({
    type: "d1",
    name: database.binding,
    id: d1IdPlaceholder(database.binding),
  })),
  ...config.r2_buckets.map((bucket) => ({
    type: "r2_bucket",
    name: bucket.binding,
    bucket_name: bucket.bucket_name,
    jurisdiction: bucket.jurisdiction,
  })),
  ...config.send_email.map((email) => ({
    type: "send_email",
    name: email.name,
  })),
  ...(config.version_metadata
    ? [{ type: "version_metadata", name: config.version_metadata.binding }]
    : []),
  ...config.services.map((service) => {
    if (!releaseNames.has(service.service)) {
      throw new Error(
        `${config.name} binds ${service.service}, which isn't in the release`
      );
    }
    return {
      type: "service",
      name: service.binding,
      service: service.service,
      ...(service.entrypoint === undefined
        ? {}
        : { entrypoint: service.entrypoint }),
    };
  }),
  ...(config.assets
    ? [{ type: "assets", name: config.assets.binding ?? "ASSETS" }]
    : []),
];

const fileRefs = (
  files: CollectedFile[],
  key: (hash: string) => string
): WorkerEntry["d1Databases"][number]["migrations"] =>
  files.map((file) => ({
    name: file.name,
    sha256: file.sha256,
    size: file.size,
    r2Key: key(file.sha256),
  }));

const workerEntry = (
  { config, mainModule, modules, d1Migrations, assets }: WorkerBuild,
  releaseNames: Set<string>
): WorkerEntry => {
  if (Boolean(config.assets) !== Boolean(assets)) {
    throw new Error(
      `${config.name}: assets must be collected exactly when its config serves them`
    );
  }
  return {
    name: config.name,
    mainModule,
    modules: modules.map((module) => ({
      name: module.name,
      type: module.type,
      sha256: module.sha256,
      size: module.size,
      r2Key: moduleKey(module.sha256),
    })),
    compatibilityFlags: config.compatibility_flags,
    bindings: bindingsOf(config, releaseNames),
    d1Databases: config.d1_databases.map((database) => {
      const migrations = d1Migrations[database.binding];
      // Every database starts from a first migration: none collected means
      // the wrong directory, which would ship a release with no schema.
      if (migrations === undefined || migrations.length === 0) {
        throw new Error(
          `${config.name}: no migrations collected for ${database.binding}`
        );
      }
      return {
        binding: database.binding,
        databaseName: database.database_name,
        migrations: fileRefs(migrations, migrationKey),
      };
    }),
    durableObjectMigrations: config.migrations,
    crons: config.triggers?.crons ?? [],
    requiredSecrets: config.secrets?.required ?? [],
    keepVars: config.keep_vars,
    workersDev: config.workers_dev,
    previewUrls: config.preview_urls,
    observability: config.observability,
    ...(config.assets && assets
      ? {
          assets: {
            config: {
              not_found_handling: config.assets.not_found_handling,
              run_worker_first: config.assets.run_worker_first,
            },
            manifest: assets.manifest,
          },
        }
      : {}),
  };
};

/** A model file a release names: not in the build, but in the releases bucket. */
export interface ModelFileInfo {
  /** What it is, such as `engram-1/tokens`. */
  name: string;
  sha256: string;
  size: number;
}

/** Release metadata that isn't read from the Workers' builds. */
export interface ReleaseInfo {
  releaseId: string;
  commit: string;
  createdAt: string;
  notes: string;
  wranglerVersion: string;
  packages: Record<string, string>;
  /** The model files the Worker that binds `modelFilesBinding` runs. */
  modelFiles: ModelFileInfo[];
}

const mebibytes = (bytes: number): string =>
  `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/**
 * What one release may carry to a client, with headroom, so a build that
 * outgrows it fails in CI rather than on a client's deploy days later
 * (apps/admin/src/cloudflare/workers.ts):
 * - A Worker's modules, all together, raw: the deploy sends them in one
 *   upload, which Cloudflare takes up to 64 MiB uncompressed; 48 MiB
 *   leaves a quarter of that as headroom. The deploy streams them into the
 *   upload, so they don't bound its memory. The 1 s startup limit isn't
 *   a size: Cloudflare checks it on every upload.
 * - Its source maps, all together: Cloudflare counts them apart from the
 *   modules, up to 60 MiB raw and 15 MiB gzipped; 45 MiB and 11 MiB leave
 *   about a quarter of each as headroom.
 * - A static file: Cloudflare takes 25 MiB at most. The deploy sends one
 *   this large on its own, holding it read and as base64, so this bounds
 *   its memory too.
 * Static files in total aren't bounded here: the deploy reads each only
 * as its request goes out, three requests at a time.
 */
export const releaseBudget = {
  workerModules: 48 * 1024 * 1024,
  sourceMaps: 45 * 1024 * 1024,
  sourceMapsGzipped: 11 * 1024 * 1024,
  staticFile: 20 * 1024 * 1024,
} as const;

/** Throws when a Worker's build carries more than `releaseBudget` allows. */
const checkBudget = (build: WorkerBuild): void => {
  const over: string[] = [];
  let modules = 0;
  let sourceMaps = 0;
  let sourceMapsGzipped = 0;
  for (const { type, size, bytes } of build.modules) {
    if (type === "sourcemap") {
      sourceMaps += size;
      sourceMapsGzipped += gzipSync(bytes).byteLength;
    } else {
      modules += size;
    }
  }
  if (modules > releaseBudget.workerModules) {
    over.push(
      `its modules are ${mebibytes(modules)} (budget ${mebibytes(releaseBudget.workerModules)})`
    );
  }
  if (sourceMaps > releaseBudget.sourceMaps) {
    over.push(
      `its source maps are ${mebibytes(sourceMaps)} (budget ${mebibytes(releaseBudget.sourceMaps)})`
    );
  }
  if (sourceMapsGzipped > releaseBudget.sourceMapsGzipped) {
    over.push(
      `its source maps are ${mebibytes(sourceMapsGzipped)} gzipped (budget ${mebibytes(releaseBudget.sourceMapsGzipped)})`
    );
  }
  for (const [file, { size }] of Object.entries(build.assets?.manifest ?? {})) {
    if (size > releaseBudget.staticFile) {
      over.push(
        `static file ${file} is ${mebibytes(size)} (budget ${mebibytes(releaseBudget.staticFile)})`
      );
    }
  }
  if (over.length > 0) {
    throw new Error(
      `${build.key} is over the release budget: ${over.join("; ")}`
    );
  }
};

/**
 * Throws when the release names model files but no Worker binds the
 * bucket they're copied into: files nothing reads.
 */
const checkModelFiles = (
  modelFiles: readonly ModelFileInfo[],
  workers: WorkerBuild[]
): void => {
  const binds = workers.some((build) =>
    build.config.r2_buckets.some(
      (bucket) => bucket.binding === modelFilesBinding
    )
  );
  if (modelFiles.length > 0 && !binds) {
    throw new Error(
      `The release names model files, but no Worker binds ${modelFilesBinding}`
    );
  }
};

/** Assembles the manifest from each Worker's build. */
export const generateManifest = (
  { modelFiles, ...info }: ReleaseInfo,
  workers: WorkerBuild[]
): ReleaseManifest => {
  for (const build of workers) {
    checkBudget(build);
  }
  checkModelFiles(modelFiles, workers);
  const dates = new Set(workers.map((w) => w.config.compatibility_date));
  const [compatibilityDate] = dates;
  if (compatibilityDate === undefined || dates.size > 1) {
    throw new Error(
      `Released Workers must share one compatibility date, found: ${[...dates].join(", ") || "none"}`
    );
  }
  const releaseNames = new Set(workers.map((w) => w.config.name));
  const entries = Object.fromEntries(
    workers.map((w) => [w.key, workerEntry(w, releaseNames)])
  );
  const assets: ReleaseManifest["assets"] = {};
  for (const [hash, bytes] of workers.flatMap((w) => [
    ...(w.assets?.blobs ?? []),
  ])) {
    assets[hash] = { size: bytes.length, r2Key: assetKey(hash) };
  }
  return releaseManifestSchema.parse({
    manifestVersion: MANIFEST_VERSION,
    ...info,
    compatibilityDate,
    workers: entries,
    assets,
    modelFiles: modelFiles.map((file) => ({
      ...file,
      r2Key: modelBlobKey(file.sha256),
    })),
  });
};

const writeBlob = (outDir: string, key: string, bytes: Buffer): void => {
  const file = path.join(outDir, key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
};

/** The file that marks a directory as a release this build wrote. */
export const RELEASE_MARKER = ".grasp-release";

/**
 * Throws unless `outDir` is safe to replace with a release: absent, empty, or
 * holding {@link RELEASE_MARKER}. So a mistyped `--out` (the repo, a home
 * directory) is refused, not wiped. Only checks; changes nothing.
 */
export const assertReleaseDir = (outDir: string): void => {
  if (
    existsSync(outDir) &&
    readdirSync(outDir).length > 0 &&
    !existsSync(path.join(outDir, RELEASE_MARKER))
  ) {
    throw new Error(
      `${outDir} isn't empty and isn't a release directory (no ${RELEASE_MARKER}); refusing to delete it`
    );
  }
};

/** Empties `outDir` for a new release, once {@link assertReleaseDir} allows it. */
export const clearReleaseDir = (outDir: string): void => {
  assertReleaseDir(outDir);
  rmSync(outDir, { force: true, recursive: true });
  mkdirSync(outDir, { recursive: true });
  // First, so a write that stops halfway leaves a directory the next build
  // may replace.
  writeFileSync(path.join(outDir, RELEASE_MARKER), "");
};

/**
 * Writes a release directory laid out as it's stored in R2: every blob of
 * the build at its key (not the model files, which no build has), then
 * `manifest.json`, last. Replaces an earlier release in
 * `outDir`, and refuses any other non-empty directory.
 */
export const writeRelease = (
  outDir: string,
  manifest: ReleaseManifest,
  workers: WorkerBuild[]
): void => {
  clearReleaseDir(outDir);
  for (const worker of workers) {
    for (const module of worker.modules) {
      writeBlob(outDir, moduleKey(module.sha256), module.bytes);
    }
    for (const migration of Object.values(worker.d1Migrations).flat()) {
      writeBlob(outDir, migrationKey(migration.sha256), migration.bytes);
    }
    for (const [hash, bytes] of worker.assets?.blobs ?? []) {
      writeBlob(outDir, assetKey(hash), bytes);
    }
  }
  writeFileSync(path.join(outDir, "manifest.json"), stableStringify(manifest));
};

/** A release directory checked against its manifest (see {@link verifyRelease}). */
export interface VerifiedRelease {
  manifest: ReleaseManifest;
  /** The bytes of `manifest.json` that were parsed. */
  manifestBytes: Buffer;
  /**
   * Every blob, by its R2 key: the bytes that were hashed. The model files
   * are among them only where the directory holds them (a download of a
   * published release does; a build doesn't).
   */
  blobs: Map<string, Buffer>;
}

/**
 * Checks a release directory against its manifest, as the admin checks
 * a release in R2 (`verifyReleaseBlobs`), and each model file the
 * directory holds by its hash. Each file is read once, and those bytes are
 * returned, so what's published is what was checked.
 */
export const verifyRelease = async (
  outDir: string
): Promise<VerifiedRelease> => {
  const manifestBytes = readFileSync(path.join(outDir, "manifest.json"));
  const manifest = releaseManifestSchema.parse(
    JSON.parse(manifestBytes.toString("utf-8"))
  );
  const blobs = new Map<string, Buffer>();
  // Keys are content addresses under blobs/ by the time they're read:
  // `verifyReleaseBlobs` refuses any other, so none names a path outside
  // the release directory.
  await verifyReleaseBlobs(manifest, async (key) => {
    const file = path.join(outDir, key);
    const bytes = existsSync(file) ? await readFile(file) : undefined;
    if (bytes !== undefined) {
      blobs.set(key, bytes);
    }
    return bytes;
  });
  for (const file of manifest.modelFiles) {
    // The schema keeps r2Key a content address under blobs/.
    const at = path.join(outDir, file.r2Key);
    if (!existsSync(at)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a few files, read one at a time
    const bytes = await readFile(at);
    if (
      bytes.byteLength !== file.size ||
      // oxlint-disable-next-line no-await-in-loop -- a few files, read one at a time
      (await sha256OfBytes(new Uint8Array(bytes))) !== file.sha256
    ) {
      throw new Error(`${file.r2Key} (${file.name}) doesn't match its hash`);
    }
    blobs.set(file.r2Key, bytes);
  }
  return { manifest, manifestBytes, blobs };
};

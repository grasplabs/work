/**
 * One Worker of a built release (build-release.ts), laid out for Wrangler
 * to deploy as it is: its modules, static files and D1 migrations written
 * from the bytes `verifyRelease` checked against the manifest, and a
 * wrangler.json that says what the manifest says and nothing else. The
 * modules go up unbundled (`no_bundle`), each with the type the manifest
 * gives it, so the Worker staging runs is the release the admin rolls
 * out, byte for byte, not a second build of the same commit.
 *
 * The bindings are the manifest's, mapped back onto Wrangler's config
 * keys; Wrangler looks up the account's resources by name (D1 databases,
 * R2 buckets), as it does for a deploy from source. The mapping is closed:
 * a binding type it doesn't know refuses the deploy, so a new one is a
 * decision here as it is in manifest-lib.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { assetKey, d1IdPlaceholder } from "@grasp-os/shared/release";
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";

import type { CollectedModule } from "./hash-lib.ts";
import { verifyRelease } from "./manifest-lib.ts";

/** Where each part of a laid-out Worker goes, relative to its wrangler.json. */
export const WORKER_DIR = "worker";
export const ASSETS_DIR = "assets";
export const MIGRATIONS_DIR = "migrations";
/** The config Wrangler deploys, next to the parts it names. */
export const DEPLOY_CONFIG = "wrangler.json";

/** Wrangler's module rule type for each module type in the manifest. */
const RULE_TYPES = {
  esm: "ESModule",
  text: "Text",
  wasm: "CompiledWasm",
  data: "Data",
} as const;

// A name the manifest gives a file becomes a path and a glob: only plain
// relative paths, with nothing a glob would read as a pattern.
const GLOB_CHARACTERS = /[*?[\]{}!]/u;

/**
 * `name` under `dir`, refused unless it's a plain relative path that stays
 * inside it: the manifest names every file the layout writes.
 */
const inside = (dir: string, name: string): string => {
  const segments = name.replace(/^\//u, "").split("/");
  if (
    name.includes("\\") ||
    GLOB_CHARACTERS.test(name) ||
    segments.some((segment) => ["", ".", ".."].includes(segment))
  ) {
    throw new Error(`${name} isn't a plain path inside the release`);
  }
  return path.join(dir, ...segments);
};

type Binding = WorkerEntry["bindings"][number];

/** `binding[key]` as a string; the deploy is refused when it isn't one. */
const text = (binding: Binding, key: string): string => {
  const value = binding[key];
  if (typeof value !== "string") {
    throw new TypeError(`Binding ${binding.name} has no ${key}`);
  }
  return value;
};

/** The binding config Wrangler takes, grouped by its key in wrangler.json. */
interface BindingConfig {
  durableObjects: { name: string; class_name: string }[];
  workflows: { name: string; binding: string; class_name: string }[];
  workerLoaders: { binding: string }[];
  d1Databases: {
    binding: string;
    database_name: string;
    migrations_dir: string;
  }[];
  r2Buckets: { binding: string; bucket_name: string; jurisdiction: string }[];
  ai?: { binding: string };
  sendEmail: { name: string }[];
  versionMetadata?: { binding: string };
  services: { binding: string; service: string; entrypoint?: string }[];
  assetsBinding?: string;
}

const emptyBindings = (): BindingConfig => ({
  durableObjects: [],
  workflows: [],
  workerLoaders: [],
  d1Databases: [],
  r2Buckets: [],
  sendEmail: [],
  services: [],
});

/**
 * Adds one of the manifest's bindings to `config`: the inverse of
 * manifest-lib.ts's `bindingsOf`.
 */
const addBinding = (
  config: BindingConfig,
  worker: WorkerEntry,
  binding: Binding
): void => {
  switch (binding.type) {
    case "durable_object_namespace": {
      config.durableObjects.push({
        name: binding.name,
        class_name: text(binding, "class_name"),
      });
      return;
    }
    case "workflow": {
      config.workflows.push({
        name: text(binding, "workflow_name"),
        binding: binding.name,
        class_name: text(binding, "class_name"),
      });
      return;
    }
    case "worker_loader": {
      config.workerLoaders.push({ binding: binding.name });
      return;
    }
    case "d1": {
      // The placeholder the admin fills in with the account's id;
      // Wrangler finds the database by its name instead.
      const database = worker.d1Databases.find(
        (entry) => entry.binding === binding.name
      );
      if (
        database === undefined ||
        binding.id !== d1IdPlaceholder(binding.name)
      ) {
        throw new Error(
          `${worker.name}'s D1 binding ${binding.name} isn't one of its databases`
        );
      }
      config.d1Databases.push({
        binding: binding.name,
        database_name: database.databaseName,
        migrations_dir: `${MIGRATIONS_DIR}/${binding.name}`,
      });
      return;
    }
    case "r2_bucket": {
      config.r2Buckets.push({
        binding: binding.name,
        bucket_name: text(binding, "bucket_name"),
        jurisdiction: text(binding, "jurisdiction"),
      });
      return;
    }
    case "ai": {
      config.ai = { binding: binding.name };
      return;
    }
    case "send_email": {
      config.sendEmail.push({ name: binding.name });
      return;
    }
    case "version_metadata": {
      config.versionMetadata = { binding: binding.name };
      return;
    }
    case "service": {
      const { entrypoint } = binding;
      config.services.push({
        binding: binding.name,
        service: text(binding, "service"),
        ...(typeof entrypoint === "string" ? { entrypoint } : {}),
      });
      return;
    }
    case "assets": {
      config.assetsBinding = binding.name;
      return;
    }
    default: {
      throw new Error(
        `${worker.name}'s binding ${binding.name} is a ${binding.type}, which a deploy from the release doesn't handle`
      );
    }
  }
};

/**
 * Wrangler's module rules: every module by its exact name, with its type.
 * Each rule falls through to the next, which names other files: without
 * it Wrangler ignores every rule after the first of a type.
 */
const moduleRules = (
  worker: WorkerEntry
): { type: string; globs: string[]; fallthrough: true }[] =>
  Object.entries(RULE_TYPES).flatMap(([type, ruleType]) => {
    const globs = worker.modules
      .filter((module) => module.type === type)
      .map((module) => module.name);
    return globs.length === 0
      ? []
      : [{ type: ruleType, globs, fallthrough: true as const }];
  });

/** The manifest's entry for `app`, e.g. `core`. */
export const workerOf = (
  manifest: ReleaseManifest,
  app: string
): WorkerEntry => {
  const worker = manifest.workers[app];
  if (worker === undefined) {
    throw new Error(
      `Release ${manifest.releaseId} has no Worker ${app} (it has ${Object.keys(manifest.workers).join(", ")})`
    );
  }
  return worker;
};

/**
 * The wrangler.json that deploys `worker` of `manifest` from its laid-out
 * files (`layOutWorker`): its name, modules, compatibility date and
 * flags, bindings, Durable Object migrations, crons, static files and
 * settings, as the manifest has them.
 */
export const deployConfig = (
  manifest: ReleaseManifest,
  worker: WorkerEntry
): Record<string, unknown> => {
  const bindings = emptyBindings();
  for (const binding of worker.bindings) {
    addBinding(bindings, worker, binding);
  }
  if (worker.assets !== undefined && bindings.assetsBinding === undefined) {
    throw new Error(`${worker.name} serves static files without a binding`);
  }
  return {
    name: worker.name,
    main: `${WORKER_DIR}/${worker.mainModule}`,
    base_dir: WORKER_DIR,
    no_bundle: true,
    find_additional_modules: true,
    rules: moduleRules(worker),
    compatibility_date: manifest.compatibilityDate,
    compatibility_flags: worker.compatibilityFlags,
    workers_dev: worker.workersDev,
    preview_urls: worker.previewUrls,
    keep_vars: worker.keepVars,
    observability: worker.observability,
    secrets: { required: worker.requiredSecrets },
    migrations: worker.durableObjectMigrations,
    triggers: { crons: worker.crons },
    durable_objects: { bindings: bindings.durableObjects },
    workflows: bindings.workflows,
    worker_loaders: bindings.workerLoaders,
    d1_databases: bindings.d1Databases,
    r2_buckets: bindings.r2Buckets,
    send_email: bindings.sendEmail,
    services: bindings.services,
    ...(bindings.ai === undefined ? {} : { ai: bindings.ai }),
    ...(bindings.versionMetadata === undefined
      ? {}
      : { version_metadata: bindings.versionMetadata }),
    ...(worker.assets === undefined
      ? {}
      : {
          assets: {
            directory: ASSETS_DIR,
            binding: bindings.assetsBinding,
            ...worker.assets.config,
          },
        }),
  };
};

/** A Worker of a release laid out for Wrangler (`layOutWorker`). */
export interface LaidOutWorker {
  manifest: ReleaseManifest;
  worker: WorkerEntry;
  /** Its wrangler.json. */
  config: string;
}

const write = (file: string, bytes: Uint8Array): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
};

/**
 * Lays out `app` of the release in `releaseDir` under `outDir` for
 * Wrangler: the release is checked against its manifest first, every file
 * of it (`verifyRelease`), and refused on the first one that doesn't
 * match, before anything is written. What's written are the bytes that
 * were checked.
 */
export const layOutWorker = async (
  releaseDir: string,
  app: string,
  outDir: string
): Promise<LaidOutWorker> => {
  const { manifest, blobs } = await verifyRelease(releaseDir);
  const worker = workerOf(manifest, app);
  const config = deployConfig(manifest, worker);
  const blob = (key: string): Buffer => {
    const bytes = blobs.get(key);
    if (bytes === undefined) {
      throw new Error(`${key} is missing from the release`);
    }
    return bytes;
  };

  for (const module of worker.modules) {
    write(
      inside(path.join(outDir, WORKER_DIR), module.name),
      blob(module.r2Key)
    );
  }
  for (const [assetPath, { hash }] of Object.entries(
    worker.assets?.manifest ?? {}
  )) {
    write(
      inside(path.join(outDir, ASSETS_DIR), assetPath),
      blob(assetKey(hash))
    );
  }
  for (const database of worker.d1Databases) {
    const dir = path.join(outDir, MIGRATIONS_DIR, database.binding);
    mkdirSync(dir, { recursive: true });
    for (const migration of database.migrations) {
      write(inside(dir, migration.name), blob(migration.r2Key));
    }
  }
  const configFile = path.join(outDir, DEPLOY_CONFIG);
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  return { manifest, worker, config: configFile };
};

/** A Worker's modules as lines to compare: its main module, then each module. */
const describeModules = (
  mainModule: string,
  modules: readonly { name: string; type: string; sha256: string }[]
): string[] => [
  `main ${mainModule}`,
  ...modules
    .map(({ name, type, sha256 }) => `${name} ${type} ${sha256}`)
    .toSorted(),
];

/**
 * Throws unless `uploaded`, the modules Wrangler would upload for
 * `worker` (its dry run's output, read with `collectModules`), are the
 * manifest's: the same names, types and SHA-256, the same main module.
 */
export const assertUploadMatches = (
  worker: WorkerEntry,
  uploaded: { mainModule: string; modules: CollectedModule[] }
): void => {
  const expected = describeModules(worker.mainModule, worker.modules);
  const actual = describeModules(uploaded.mainModule, uploaded.modules);
  const differ = [
    ...expected.filter((line) => !actual.includes(line)),
    ...actual.filter((line) => !expected.includes(line)),
  ];
  if (differ.length > 0) {
    throw new Error(
      `Wrangler would upload ${worker.name} other than the release has it:\n${differ.join("\n")}`
    );
  }
};

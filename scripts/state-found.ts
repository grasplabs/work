/**
 * Reads what the repo declares as client state (`FoundState`) from its
 * files: the Worker configs under `apps/`, the client Workers' SQLite
 * schema folders and migrations, and the source of the client Workers and
 * the packages they bundle. The registry's coverage check compares it with
 * the registry (state-coverage.ts).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ClientStateRegistry } from "@grasp-os/shared/state-registry";

import {
  durableObjectClassesOf,
  migrationTables,
  runtimeTablesOf,
  schemaTables,
  workerBindingsOf,
} from "./state-coverage.ts";
import type { FoundState, WorkerBindings } from "./state-coverage.ts";

const configNames = ["wrangler.jsonc", "wrangler.json"];

/** Every file under `dir`, as paths relative to `root`. */
const filesUnder = (root: string, dir: string): string[] =>
  existsSync(path.join(root, dir))
    ? readdirSync(path.join(root, dir), {
        recursive: true,
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          path.relative(root, path.join(entry.parentPath, entry.name))
        )
        .map((file) => file.split(path.sep).join("/"))
        .toSorted()
    : [];

/** Source a Worker runs: TypeScript, neither a test nor a migration. */
const isSource = (file: string): boolean =>
  file.endsWith(".ts") &&
  !file.endsWith(".d.ts") &&
  !file.includes(".test.") &&
  !file.includes("/migrations/") &&
  !file.includes("/node_modules/");

/** The repo's state as its files declare it, read from `root`. */
export const foundStateOf = (
  root: string,
  registry: ClientStateRegistry
): FoundState => {
  const read = (file: string): string =>
    readFileSync(path.join(root, file), "utf-8");
  const configs = readdirSync(path.join(root, "apps"))
    .flatMap((app) => configNames.map((name) => `apps/${app}/${name}`))
    .filter((file) => existsSync(path.join(root, file)))
    .toSorted();
  const workers: Record<string, WorkerBindings> = {};
  const appDirs: string[] = [];
  for (const [worker, { config }] of Object.entries(registry.workers)) {
    if (!existsSync(path.join(root, config))) {
      continue;
    }
    workers[worker] = workerBindingsOf(read(config));
    appDirs.push(path.posix.dirname(config));
  }
  const schemas: Record<string, string[]> = {};
  // The apps' schema folders, and a package's that owns a whole database
  // an app binds (the Brain's, packages/brain/src/db).
  const packageDbs = readdirSync(path.join(root, "packages"))
    .map((pkg) => `packages/${pkg}`)
    .filter((dir) => existsSync(path.join(root, dir, "src/db")));
  for (const appDir of [...appDirs, ...packageDbs]) {
    for (const file of filesUnder(root, `${appDir}/src/db`)) {
      if (path.posix.basename(file) !== "schema.ts") {
        continue;
      }
      const folder = path.posix.dirname(file);
      const migrations = filesUnder(root, `${folder}/migrations`)
        .filter((migration) => migration.endsWith(".sql"))
        .map(read);
      schemas[folder] = [
        ...new Set([
          ...schemaTables(read(file)),
          ...migrationTables(migrations),
        ]),
      ].toSorted();
    }
  }
  // The client Workers' own source, and the packages they bundle: a
  // package's class or table runs in whichever Worker imports it.
  const packageSources = readdirSync(path.join(root, "packages")).flatMap(
    (pkg) => filesUnder(root, `packages/${pkg}/src`)
  );
  const sources = [
    ...appDirs.flatMap((appDir) => filesUnder(root, `${appDir}/src`)),
    ...packageSources,
  ].filter(isSource);
  const texts = Object.fromEntries(sources.map((file) => [file, read(file)]));
  const runtimeTables: Record<string, string[]> = {};
  for (const [file, source] of Object.entries(texts)) {
    const tables = runtimeTablesOf(source);
    if (tables.length > 0) {
      runtimeTables[file] = tables;
    }
  }
  return {
    workers,
    configs,
    schemas,
    runtimeTables,
    classes: durableObjectClassesOf(texts),
    exists: (file) => existsSync(path.join(root, file)),
  };
};

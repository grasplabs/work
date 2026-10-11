/**
 * The on-prem profile's D1 in a workerd config: the D1 service
 * (apps/core/src/on-prem/d1.ts) as a Worker of its own, and each of core's
 * D1 bindings as workerd's built-in D1 client pointed at it. The workerd
 * smoke run serves core with it; its test serves a Worker of its own.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

import { z } from "zod";

import { parseJsonc } from "./wrangler-config-rules.ts";

/** One migration file, as the D1 service applies it (its `D1Migration`). */
export interface D1Migration {
  name: string;
  queries: string[];
}

/** One D1 database: its binding, and where its migration files are. */
export interface D1DatabaseConfig {
  binding: string;
  migrationsDir: string;
}

const statementBreakpoint = "--> statement-breakpoint";
const commentLine = /^\s*--.*$/gmu;

/**
 * A database's migrations as Wrangler applies them: its `.sql` files in
 * name order, each split at Drizzle's statement breakpoints.
 */
export const d1Migrations = (migrationsDir: string): D1Migration[] =>
  readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .toSorted()
    .map((file) => ({
      name: file,
      queries: readFileSync(path.join(migrationsDir, file), "utf-8")
        .split(statementBreakpoint)
        .map((query) => query.trim())
        .filter((query) => query.replace(commentLine, "").trim().length > 0),
    }));

/** Every D1 database a Worker binds, from its wrangler.jsonc. */
export const d1DatabasesOf = (wranglerConfig: string): D1DatabaseConfig[] =>
  z
    .object({
      d1_databases: z.array(
        z.object({ binding: z.string(), migrations_dir: z.string() })
      ),
    })
    .parse(parseJsonc(readFileSync(wranglerConfig, "utf-8")))
    .d1_databases.map(({ binding, migrations_dir: migrationsDir }) => ({
      binding,
      migrationsDir: path.resolve(path.dirname(wranglerConfig), migrationsDir),
    }));

/** The D1 service's name in the workerd config. */
export const d1ServiceName = "d1";

const d1Source = path.join(
  import.meta.dirname,
  "../apps/core/src/on-prem/d1.ts"
);

/**
 * Writes the D1 service's module and its databases' migrations into `out`,
 * next to the config, which embeds them (`d1Service`).
 */
export const writeD1Service = (
  out: string,
  databases: readonly D1DatabaseConfig[]
): void => {
  // The service imports nothing but the runtime's own modules, so it needs
  // no bundling: its types are stripped and that is the module.
  writeFileSync(
    path.join(out, "d1.js"),
    stripTypeScriptTypes(readFileSync(d1Source, "utf-8"))
  );
  writeFileSync(
    path.join(out, "d1-migrations.json"),
    JSON.stringify(
      Object.fromEntries(
        databases.map(({ binding, migrationsDir }) => [
          binding,
          d1Migrations(migrationsDir),
        ])
      )
    )
  );
};

/**
 * The D1 service's capnp entry. Its databases live in the disk service
 * `storage`: workerd keeps a Durable Object's SQLite database only on disk,
 * not in memory.
 */
export const d1Service = (
  storage: string
): string => `(name = "${d1ServiceName}", worker = (
    modules = [(name = "d1.js", esModule = embed "d1.js")],
    compatibilityDate = "2026-09-15",
    bindings = [
      (name = "DATABASES", durableObjectNamespace = (className = "D1Store")),
      (name = "MIGRATIONS", json = embed "d1-migrations.json"),
    ],
    durableObjectNamespaces = [
      (className = "D1Store", uniqueKey = "D1Store", enableSql = true),
    ],
    durableObjectStorage = (localDisk = "${storage}"),
  ))`;

/**
 * Each database's binding: workerd's built-in D1 client, which sends its
 * queries to the D1 service with the binding's name, the way Miniflare
 * binds D1 for Wrangler's local dev and the tests.
 */
export const d1Bindings = (databases: readonly D1DatabaseConfig[]): string[] =>
  databases.map(
    ({ binding }) =>
      `(name = "${binding}", wrapped = (moduleName = "cloudflare-internal:d1-api", innerBindings = [(name = "fetcher", service = (name = "${d1ServiceName}", props = (json = ${JSON.stringify(JSON.stringify({ database: binding }))})))]))`
  );

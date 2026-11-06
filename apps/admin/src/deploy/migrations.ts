/**
 * A release's D1 migrations, applied to a client's databases before its
 * Workers are deployed: expand only (AGENTS.md), so the running version
 * keeps working against the new schema. Each database skips what it has
 * already applied, so running this again after a failure applies only
 * what's left.
 *
 * Reading what a database has applied and applying the rest aren't one
 * step, so two runs at once could apply a migration twice: a deploy
 * expects to be its client's only runner (src/deploy/deploy.ts).
 */
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";

import type { CloudflareApi } from "../cloudflare/api.ts";
import { D1MigrationError } from "../cloudflare/d1-migration-error.ts";
import { applyD1Migrations } from "../cloudflare/workers.ts";
import type { BeforeMigration } from "../cloudflare/workers.ts";
import type { ReleaseStore } from "../releases/import.ts";
import { DeployError } from "./errors.ts";
import { readBlob } from "./release.ts";

const decoder = new TextDecoder("utf-8", { fatal: true });

type MigrationFile = WorkerEntry["d1Databases"][number]["migrations"][number];

/** A migration list as its files' names and hashes, to compare two. */
const fingerprint = (migrations: readonly MigrationFile[]): string =>
  JSON.stringify(migrations.map(({ name, sha256 }) => [name, sha256]));

/**
 * Each database the release's Workers bind, once, with its migrations.
 * Two Workers may bind one database, but only with the same migrations.
 */
export const databaseMigrations = (
  manifest: ReleaseManifest
): Map<string, readonly MigrationFile[]> => {
  const byName = new Map<string, readonly MigrationFile[]>();
  for (const worker of Object.values(manifest.workers)) {
    for (const { databaseName, migrations } of worker.d1Databases) {
      const seen = byName.get(databaseName);
      if (seen !== undefined && fingerprint(seen) !== fingerprint(migrations)) {
        throw new DeployError(
          "migration_lists_differ",
          `Two Workers give ${databaseName} different migrations`
        );
      }
      byName.set(databaseName, migrations);
    }
  }
  return byName;
};

/**
 * Applies each database's pending migrations from the release, one
 * database at a time, reading each migration from `store` and checking it
 * against the manifest first. Returns how many each database applied, by
 * name. `databases` gives each database's id by name. `before` is
 * checked before each migration (`applyD1Migrations`).
 */
export const migrateDatabases = async (
  api: CloudflareApi,
  accountId: string,
  databases: ReadonlyMap<string, string>,
  manifest: ReleaseManifest,
  store: ReleaseStore,
  before?: BeforeMigration
): Promise<Map<string, number>> => {
  const applied = new Map<string, number>();
  for (const [name, files] of databaseMigrations(manifest)) {
    const id = databases.get(name);
    if (id === undefined) {
      throw new Error(`No database ${name} to migrate`);
    }
    // oxlint-disable-next-line no-await-in-loop -- one database at a time
    const migrations = await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        sql: decoder.decode(await readBlob(store, file)),
      }))
    );
    try {
      // oxlint-disable-next-line no-await-in-loop -- one database at a time
      const names = await applyD1Migrations(
        api,
        accountId,
        id,
        migrations,
        async () => {
          await before?.();
        }
      );
      applied.set(name, names.length);
    } catch (error) {
      // A migration D1 refused is the migration's, named; anything else
      // (an API that didn't answer, or answered 429 or 5xx, a runner that
      // lost its client) stays its own.
      if (!(error instanceof D1MigrationError)) {
        throw error;
      }
      throw new DeployError(
        "d1_migration_failed",
        `Migration ${error.migration} of ${name} failed`,
        { cause: error }
      );
    }
  }
  return applied;
};

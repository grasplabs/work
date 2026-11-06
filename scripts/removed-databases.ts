import { z } from "zod";

import { parseJsonc } from "./jsonc.ts";

/**
 * Which deleted migrations belong to a database a branch removes whole, so
 * check-migrations.ts lets them go: a database whose storage the same
 * branch deletes has nothing left to apply its migrations to. Only a
 * removal that leaves no trace and deletes the storage counts, never a
 * move, a journal deleted on its own, or a folder gone while its storage
 * lives on.
 */

/** What HEAD and the branch's diff say, as the rule reads them. */
export interface BranchView {
  /** The files the branch deleted since it left main. */
  deleted: ReadonlySet<string>;
  /** Whether HEAD has anything under `dir`. */
  hasTree: (dir: string) => boolean;
  /** Whether a `wrangler.jsonc` or `package.json` at HEAD has `text` in it. */
  configNames: (text: string) => boolean;
  /** Durable Object classes a `deleted_classes` step the branch added deletes. */
  deletedClasses: ReadonlySet<string>;
  /** The `migrations_dir` of every D1 binding the branch removed. */
  removedMigrationDirs: ReadonlySet<string>;
}

/** A database folder's Durable Object class, by Wrangler's naming: `model-ledger` is `ModelLedger`. */
const classOf = (name: string): string =>
  name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

/**
 * Whether deleted migration `file` is one of a database removed whole: its
 * folder (`src/db/<name>/`) gone at HEAD, its journal deleted in the same
 * branch, no Worker config or package script still naming it, and its
 * storage deleted by the same branch: its Durable Object class in a new
 * `deleted_classes` step, or the D1 binding that applied these migrations
 * removed.
 */
export const ofRemovedDatabase = (file: string, view: BranchView): boolean => {
  const at = file.lastIndexOf("/migrations/");
  if (at === -1 || !view.deleted.has(file)) {
    return false;
  }
  const dir = file.slice(0, at);
  const name = dir.slice(dir.lastIndexOf("/") + 1);
  const storageDeleted =
    view.deletedClasses.has(classOf(name)) ||
    view.removedMigrationDirs.has(`${dir}/migrations`);
  return (
    storageDeleted &&
    !view.hasTree(dir) &&
    view.deleted.has(`${dir}/migrations/meta/_journal.json`) &&
    !view.configNames(`db/${name}/`)
  );
};

const wranglerSchema = z.looseObject({
  migrations: z
    .array(z.looseObject({ deleted_classes: z.array(z.string()).optional() }))
    .optional(),
  d1_databases: z
    .array(z.looseObject({ migrations_dir: z.string().optional() }))
    .optional(),
});

/** What a `wrangler.jsonc` at `path` deletes and applies: its deleted classes and its D1 migration folders, relative to the repository. */
export const storageOf = (
  path: string,
  text: string | undefined
): { deletedClasses: string[]; migrationDirs: string[] } => {
  if (text === undefined) {
    return { deletedClasses: [], migrationDirs: [] };
  }
  const config = wranglerSchema.parse(parseJsonc(text));
  const base = path.slice(0, path.lastIndexOf("/") + 1);
  return {
    deletedClasses: (config.migrations ?? []).flatMap(
      ({ deleted_classes: deleted = [] }) => deleted
    ),
    migrationDirs: (config.d1_databases ?? []).flatMap(
      ({ migrations_dir: dir }) =>
        dir === undefined ? [] : [`${base}${dir.replace(/^\.\//u, "")}`]
    ),
  };
};

import { describe, expect, it } from "vite-plus/test";

import { ofRemovedDatabase, storageOf } from "./removed-databases.ts";
import type { BranchView } from "./removed-databases.ts";

const dir = "apps/core/src/db/model-ledger";
const migration = `${dir}/migrations/0003_spend.sql`;
const journal = `${dir}/migrations/meta/_journal.json`;

/** The branch as it would be, its database removed whole unless said otherwise. */
const branch = ({
  deleted = [migration, journal],
  tree = [],
  config = "",
  deletedClasses = ["ModelLedger"],
  removedMigrationDirs = [],
}: {
  deleted?: string[];
  tree?: string[];
  config?: string;
  deletedClasses?: string[];
  removedMigrationDirs?: string[];
} = {}): BranchView => ({
  deleted: new Set(deleted),
  hasTree: (path) => tree.some((file) => file.startsWith(`${path}/`)),
  configNames: (text) => config.includes(text),
  deletedClasses: new Set(deletedClasses),
  removedMigrationDirs: new Set(removedMigrationDirs),
});

describe(ofRemovedDatabase, () => {
  it("lets go the migrations of a database removed whole, its storage deleted by its class or its D1 binding", () => {
    expect({
      byClass: ofRemovedDatabase(migration, branch()),
      byBinding: ofRemovedDatabase(
        migration,
        branch({
          deletedClasses: [],
          removedMigrationDirs: [`${dir}/migrations`],
        })
      ),
    }).toStrictEqual({ byClass: true, byBinding: true });
  });

  it("holds every other deletion of a migration main shipped to the rule", () => {
    expect({
      // The folder and journal gone, its storage still live: no class
      // deleted, no binding removed.
      storageLives: ofRemovedDatabase(
        migration,
        branch({ deletedClasses: [] })
      ),
      // Another class deleted, not this database's.
      otherClass: ofRemovedDatabase(
        migration,
        branch({ deletedClasses: ["ChatState"] })
      ),
      // The journal deleted while the folder stays.
      folderStays: ofRemovedDatabase(
        migration,
        branch({ tree: [`${dir}/schema.ts`] })
      ),
      // The migration alone, its journal kept.
      journalKept: ofRemovedDatabase(
        migration,
        branch({ deleted: [migration] })
      ),
      // The folder moved: its new place named by the package's scripts.
      moved: ofRemovedDatabase(
        migration,
        branch({
          config:
            '"db:generate": "drizzle-kit generate --config src/db/model-ledger/drizzle.config.ts"',
        })
      ),
      // A migration folder that has no journal of its own, as testdata's.
      noJournal: ofRemovedDatabase(
        "scripts/release/testdata/migrations/0001_init.sql",
        branch({
          deleted: ["scripts/release/testdata/migrations/0001_init.sql"],
        })
      ),
      // A migration the branch didn't delete.
      notDeleted: ofRemovedDatabase(migration, branch({ deleted: [journal] })),
    }).toStrictEqual({
      storageLives: false,
      otherClass: false,
      folderStays: false,
      journalKept: false,
      moved: false,
      noJournal: false,
      notDeleted: false,
    });
  });
});

describe(storageOf, () => {
  it("reads a config's deleted classes and its D1 migration folders, from the repository's root", () => {
    expect(
      storageOf(
        "apps/core/wrangler.jsonc",
        `{
          // Comments, as Wrangler's configs have them.
          "d1_databases": [{ "binding": "DB", "migrations_dir": "./src/db/core/migrations" }],
          "migrations": [
            { "tag": "v1", "new_sqlite_classes": ["ModelLedger"] },
            { "tag": "v2", "deleted_classes": ["ModelLedger"] },
          ],
        }`
      )
    ).toStrictEqual({
      deletedClasses: ["ModelLedger"],
      migrationDirs: ["apps/core/src/db/core/migrations"],
    });
  });
});

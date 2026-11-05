import { describe, expect, it } from "vite-plus/test";

import { ofRemovedDatabase } from "./removed-databases.ts";
import type { BranchView } from "./removed-databases.ts";

const dir = "apps/core/src/db/model-ledger";
const migration = `${dir}/migrations/0003_spend.sql`;
const journal = `${dir}/migrations/meta/_journal.json`;

/** The branch as it would be, its database removed whole unless said otherwise. */
const branch = ({
  deleted = [migration, journal],
  tree = [],
  config = "",
}: {
  deleted?: string[];
  tree?: string[];
  config?: string;
} = {}): BranchView => ({
  deleted: new Set(deleted),
  hasTree: (path) => tree.some((file) => file.startsWith(`${path}/`)),
  configNames: (text) => config.includes(text),
});

describe(ofRemovedDatabase, () => {
  it("lets go the migrations of a database removed whole: its folder, its journal and every config naming it gone", () => {
    expect(ofRemovedDatabase(migration, branch())).toBeTruthy();
  });

  it("holds every other deletion of a migration main shipped to the rule", () => {
    expect({
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
      folderStays: false,
      journalKept: false,
      moved: false,
      noJournal: false,
      notDeleted: false,
    });
  });
});

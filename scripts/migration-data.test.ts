import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { asDeployed, seed, skippedErrors } from "./migration-data.ts";
import { checkDatabase } from "./migration-safety.ts";
import type { Migration } from "./migration-safety.ts";

const base = `CREATE TABLE \`chats\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`title\` text,
	\`kind\` text DEFAULT 'chat' NOT NULL,
	\`owner_id\` text NOT NULL,
	\`created_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`people\` (\`id\` text PRIMARY KEY NOT NULL, \`name\` text);
--> statement-breakpoint
CREATE TABLE \`notes\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`person_id\` text NOT NULL REFERENCES \`people\`(\`id\`) ON DELETE cascade,
	\`body\` text
);`;

const judging = {
  now: new Date("2026-11-28T12:00:00Z"),
  indexedBy: new Set<string>(),
};

/** The errors of `migrations`, the last of them added by the branch. */
const errorsOf = (migrations: Migration[]) => {
  const added = migrations.length - 1;
  return checkDatabase("db", migrations, { ...judging, from: added, added });
};

/** What a marker must name for `next`, a migration the branch adds. */
const flagged = (next: string, before = base): string[] =>
  errorsOf([
    { idx: 0, tag: "0000_base", sql: before },
    { idx: 1, tag: "0001_next", sql: next },
  ]).errors.flatMap((found) =>
    found
      .split("\n")
      .filter((line) => !line.startsWith("  ") || line.startsWith("  - "))
      .filter((line) => !line.endsWith("after a rollback:"))
      .map((line) => line.replace(/^ {2}- /u, "").replace(/ \(.*\)$/u, ""))
  );

/** The first change's detail and statements, as the message lists them. */
const listed = (next: string, before = base): string[] =>
  errorsOf([
    { idx: 0, tag: "0000_base", sql: before },
    { idx: 1, tag: "0001_next", sql: next },
  ])
    .errors.flatMap((found) => found.split("\n"))
    .filter((line) => line.startsWith("  - ") || line.startsWith("      by: "));

/** drizzle-kit's rebuild of `chats`, copying `copy` (an INSERT … SELECT). */
const rebuildChats = (
  copy: string
) => `PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE \`__new_chats\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`title\` text,
	\`kind\` text DEFAULT 'chat' NOT NULL,
	\`owner_id\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`summary\` text
);
--> statement-breakpoint
${copy}
DROP TABLE \`chats\`;--> statement-breakpoint
ALTER TABLE \`__new_chats\` RENAME TO \`chats\`;--> statement-breakpoint
PRAGMA foreign_keys=ON;`;

const copyAll =
  "INSERT INTO `__new_chats`(id, title, kind, owner_id, created_at) SELECT id, title, kind, owner_id, created_at FROM `chats`;--> statement-breakpoint";

/** A table no generated row gets into: a trigger refuses them all. */
const locked = `${base}
--> statement-breakpoint
CREATE TABLE \`locked\` (\`id\` text PRIMARY KEY NOT NULL, \`note\` text);
--> statement-breakpoint
CREATE TRIGGER \`locked_closed\` BEFORE INSERT ON \`locked\` BEGIN SELECT RAISE(ABORT, 'locked is closed'); END;`;

const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number(), tag: z.string() })),
});

const repo = (dir: string): Migration[] =>
  journalSchema
    .parse(JSON.parse(readFileSync(`${dir}/meta/_journal.json`, "utf-8")))
    .entries.map(({ idx, tag }) => ({
      idx,
      tag,
      sql: readFileSync(`${dir}/${tag}.sql`, "utf-8"),
    }));

/** What a marker must name for real migration `idx`, as if newly added. */
const flaggedInHistory = (dir: string, idx: number): string[] =>
  errorsOf(repo(dir).slice(0, idx + 1))
    .errors.flatMap((found) => found.split("\n"))
    .filter((line) => line.startsWith("  - "))
    .map((line) => line.replace(/^ {2}- /u, "").replace(/ \(.*\)$/u, ""));

describe("deletes and updates, whatever their WHERE", () => {
  it.each([
    ["DELETE FROM `chats` WHERE `kind` = 'chat';", "delete rows chats"],
    ["DELETE FROM `chats` WHERE `title` LIKE 'tmp%';", "delete rows chats"],
    [
      "DELETE FROM `chats` WHERE `created_at` > 1700000000000;",
      "delete rows chats",
    ],
    [
      "UPDATE `chats` SET `title` = NULL WHERE json_extract(`title`, '$.type') = 'file';",
      "change values chats.title",
    ],
    [
      "UPDATE `chats` SET `title` = json_remove(`title`, '$.seed');",
      "change values chats.title",
    ],
  ])("refuses %s", (statement, subject) => {
    expect(flagged(statement)).toStrictEqual([subject]);
  });

  it("lists the statement that makes the change", () => {
    expect(listed("DELETE FROM `chats` WHERE `kind` = 'chat';")).toStrictEqual([
      "  - delete rows chats (a DELETE, whatever rows it matches)",
      "      by: DELETE FROM `chats` WHERE `kind` = 'chat';",
    ]);
  });

  it("refuses a delete from a table no generated row gets into", () => {
    expect(flagged("DELETE FROM `locked`;", locked)).toStrictEqual([
      "delete rows locked",
    ]);
  });

  it("refuses rebuilding a table no generated row gets into", () => {
    expect(
      flagged(
        `CREATE TABLE \`__new_locked\` (\`id\` text PRIMARY KEY NOT NULL, \`note\` text);--> statement-breakpoint
INSERT INTO \`__new_locked\` SELECT * FROM \`locked\`;--> statement-breakpoint
DROP TABLE \`locked\`;--> statement-breakpoint
ALTER TABLE \`__new_locked\` RENAME TO \`locked\`;`,
        locked
      )
    ).toStrictEqual(["delete rows locked"]);
  });

  it("passes an insert, a backfill of a new column, and writes to a table the migration creates", () => {
    expect(
      flagged(`INSERT INTO \`people\` (\`id\`, \`name\`) VALUES ('p-new', 'New');--> statement-breakpoint
ALTER TABLE \`chats\` ADD \`summary\` text;--> statement-breakpoint
UPDATE \`chats\` SET \`summary\` = \`title\` || ' by ' || \`owner_id\`;--> statement-breakpoint
CREATE TABLE \`drafts\` (\`id\` text PRIMARY KEY NOT NULL, \`body\` text);--> statement-breakpoint
INSERT INTO \`drafts\` SELECT \`id\`, \`title\` FROM \`chats\`;--> statement-breakpoint
UPDATE \`drafts\` SET \`body\` = NULL;--> statement-breakpoint
DELETE FROM \`drafts\`;`)
    ).toStrictEqual([]);
  });

  it("passes what a trigger writes", () => {
    expect(
      flagged(
        "INSERT INTO `people` (`id`, `name`) VALUES ('p-new', 'New');",
        `${base}
--> statement-breakpoint
CREATE TRIGGER \`people_touch\` AFTER INSERT ON \`people\` BEGIN UPDATE \`chats\` SET \`title\` = NULL WHERE 0; END;`
      )
    ).toStrictEqual([]);
  });

  it("passes a change its marker names, and lists what the marker covers", () => {
    const { errors, notes } = errorsOf([
      { idx: 0, tag: "0000_base", sql: base },
      {
        idx: 1,
        tag: "0001_next",
        sql: "-- contract: delete rows chats: release 26.11.40 removed the last use\nDELETE FROM `chats` WHERE `kind` = 'chat';",
      },
    ]);
    expect(errors).toStrictEqual([]);
    expect(notes).toStrictEqual([
      "db/0001_next.sql: its contract markers cover",
      "  - delete rows chats (a DELETE, whatever rows it matches)",
      "      by: DELETE FROM `chats` WHERE `kind` = 'chat';",
    ]);
  });

  it("refuses a marker for no change", () => {
    expect(
      flagged(
        "-- contract: change values chats.title: release 26.11.40 removed the last use\nALTER TABLE `chats` ADD `summary` text;"
      )
    ).toStrictEqual([
      "db/0001_next.sql has a contract marker for change values chats.title, which it does not change in a way the release before it relies on: remove the marker.",
    ]);
  });
});

describe("history replayed as if added", () => {
  it("refuses core 0050, 0113 and 0192's deletes and rewrites", () => {
    const core = "apps/core/src/db/core/migrations";
    expect(flaggedInHistory(core, 50)).toStrictEqual([
      "change values dependency_locks.lock",
      "delete rows dependency_requests",
    ]);
    expect(flaggedInHistory(core, 113)).toStrictEqual([
      "delete rows workflow_binding_approvals",
      "delete rows sdk_release_pins",
    ]);
    expect(flaggedInHistory(core, 192)).toContain("delete rows permissions");
  });

  it("refuses deletes from today's permissions, accounts and stored records", () => {
    const added = (dir: string, sql: string) => {
      const migrations = repo(dir);
      return errorsOf([
        ...migrations,
        { idx: migrations.length, tag: "9999_next", sql },
      ])
        .errors.flatMap((found) => found.split("\n"))
        .filter((line) => line.startsWith("  - "))
        .map((line) => line.replace(/^ {2}- /u, "").replace(/ \(.*\)$/u, ""));
    };
    const core = "apps/core/src/db/core/migrations";
    expect(
      added(core, "DELETE FROM `permissions` WHERE `subject_type` = 'agent';")
    ).toStrictEqual(["delete rows permissions"]);
    expect(added(core, "DELETE FROM `accounts`;")).toStrictEqual([
      "delete rows accounts",
    ]);
    expect(
      added(
        "apps/core/src/db/data-store/migrations",
        "DELETE FROM `sdk_records`;"
      )
    ).toStrictEqual(["delete rows sdk_records"]);
  });
});

describe("rows before and after", () => {
  it("refuses a rebuild that copies nothing", () => {
    expect(flagged(rebuildChats(""))).toStrictEqual(["delete rows chats"]);
  });

  it("refuses a rebuild that swaps two columns", () => {
    expect(
      listed(
        rebuildChats(
          "INSERT INTO `__new_chats`(id, title, kind, owner_id, created_at) SELECT id, title, owner_id, kind, created_at FROM `chats`;--> statement-breakpoint"
        )
      )
    ).toStrictEqual([
      "  - change values chats.kind (4 of 5 rows, now holds what chats.owner_id held)",
      "  - change values chats.owner_id (4 of 5 rows, now holds what chats.kind held)",
    ]);
  });

  it("refuses a rebuild that rewrites JSON on the way", () => {
    expect(
      flagged(
        rebuildChats(
          "INSERT INTO `__new_chats`(id, title, kind, owner_id, created_at) SELECT id, json_set(title, '$.moved', 1), kind, owner_id, created_at FROM `chats`;--> statement-breakpoint"
        )
      )
    ).toStrictEqual(["change values chats.title"]);
  });

  it("refuses renaming a column and adding one under its name", () => {
    expect(
      flagged(`ALTER TABLE \`chats\` RENAME COLUMN \`title\` TO \`title2\`;--> statement-breakpoint
ALTER TABLE \`chats\` ADD \`title\` text;`)
    ).toStrictEqual(["change values chats.title"]);
  });

  it("refuses dropping a table and creating it again as it was", () => {
    expect(
      flagged(`DROP TABLE \`chats\`;--> statement-breakpoint
CREATE TABLE \`chats\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`title\` text,
	\`kind\` text DEFAULT 'chat' NOT NULL,
	\`owner_id\` text NOT NULL,
	\`created_at\` integer NOT NULL
);`)
    ).toStrictEqual(["delete rows chats"]);
  });

  it("refuses a rebuild of a parent whose children go with it, as D1 runs it", () => {
    expect(
      flagged(`PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE \`__new_people\` (\`id\` text PRIMARY KEY NOT NULL, \`name\` text, \`email\` text);
--> statement-breakpoint
INSERT INTO \`__new_people\`(id, name) SELECT id, name FROM \`people\`;--> statement-breakpoint
DROP TABLE \`people\`;--> statement-breakpoint
ALTER TABLE \`__new_people\` RENAME TO \`people\`;--> statement-breakpoint
PRAGMA foreign_keys=ON;`)
    ).toStrictEqual(["delete rows notes"]);
  });

  it("refuses a dedupe of rows that differ only by key", () => {
    expect(
      flagged(
        `CREATE TABLE \`__new_tags\` (\`name\` text NOT NULL, \`color\` text, CONSTRAINT \`tags_name\` UNIQUE(\`name\`));--> statement-breakpoint
INSERT OR IGNORE INTO \`__new_tags\` SELECT \`name\`, \`color\` FROM \`tags\`;--> statement-breakpoint
DROP TABLE \`tags\`;--> statement-breakpoint
ALTER TABLE \`__new_tags\` RENAME TO \`tags\`;`,
        "CREATE TABLE `tags` (`name` text NOT NULL, `color` text);"
      )
    ).toContain("delete rows tags");
  });

  it("names a migration the rows refuse", () => {
    expect(
      flagged(
        "CREATE UNIQUE INDEX `chats_kind` ON `chats` (`kind`);",
        base.replace(
          "`kind` text DEFAULT 'chat' NOT NULL",
          "`kind` text DEFAULT 'chat' NOT NULL CHECK(`kind` IN ('chat', 'task'))"
        )
      )
    ).toStrictEqual([
      "db/0001_next.sql does not apply to the rows the release before it wrote: UNIQUE constraint failed: chats.kind",
      "add unique key chats",
    ]);
  });

  it("passes a faithful rebuild, and one that reads text as a JSON list", () => {
    expect(flagged(rebuildChats(copyAll))).toStrictEqual([]);
    expect(
      flagged(
        "CREATE TABLE `chat_regions` AS SELECT json_set(`region`.`value`, '$.ok', 1) AS `value` FROM `chats`, json_each(`chats`.`title`) AS `region`;"
      )
    ).toStrictEqual([]);
  });

  it("keeps a table that takes only JSON strings when another needs a list", () => {
    expect(
      flagged(
        `CREATE TABLE \`regions\` AS SELECT json_set(\`region\`.\`value\`, '$.ok', 1) AS \`value\` FROM \`chats\`, json_each(\`chats\`.\`title\`) AS \`region\`;--> statement-breakpoint
CREATE TABLE \`__new_labels\` (\`id\` text PRIMARY KEY NOT NULL, \`name\` text NOT NULL);--> statement-breakpoint
DROP TABLE \`labels\`;--> statement-breakpoint
ALTER TABLE \`__new_labels\` RENAME TO \`labels\`;`,
        `${base}
--> statement-breakpoint
CREATE TABLE \`labels\` (\`id\` text PRIMARY KEY NOT NULL, \`name\` text NOT NULL, CONSTRAINT "plain" CHECK(json_type(\`name\`) = 'text'));`
      )
    ).toStrictEqual(["delete rows labels"]);
  });

  it("judges no data of a migration main already has", () => {
    const { errors } = checkDatabase(
      "db",
      [
        { idx: 0, tag: "0000_base", sql: base },
        {
          idx: 1,
          tag: "0001_next",
          sql: "-- contract: delete rows chats: release 26.11.40 removed the last use\nDELETE FROM `chats`;",
        },
      ],
      { ...judging, from: 1, added: 2 }
    );
    expect(errors).toStrictEqual([]);
  });
});

/** What `seed` writes to a database of `sql`: rows per table, and what it skips. */
const seeded = (sql: string) => {
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  const result = seed(db);
  const counts = Object.fromEntries(
    result.seeded.map((table) => [
      table,
      db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()?.n,
    ])
  );
  const kinds = db
    .prepare("SELECT DISTINCT `kind` FROM `notes` ORDER BY `kind`")
    .all()
    .map(({ kind }) => kind);
  db.close();
  return { counts, kinds, skipped: result.skipped };
};

describe(seed, () => {
  it("writes rows parents first, every value a CHECK allows, a repeat, an empty one, and a table of one row", () => {
    expect(
      seeded(`CREATE TABLE \`notes\` (\`id\` text PRIMARY KEY, \`person_id\` text NOT NULL REFERENCES \`people\`(\`id\`), \`kind\` text NOT NULL, \`body\` text, CONSTRAINT "kinds" CHECK(\`kind\` IN ('a', 'b', 'c', 'd')));
CREATE TABLE \`people\` (\`id\` text PRIMARY KEY);
CREATE TABLE \`settings\` (\`id\` integer PRIMARY KEY, \`value\` text, CONSTRAINT "one_row" CHECK(\`id\` = 1));`)
    ).toStrictEqual({
      counts: { people: 5, notes: 6, settings: 1 },
      kinds: ["a", "b", "c", "d"],
      skipped: [],
    });
  });

  it("names each table that takes no row, and why", () => {
    expect(
      seeded(`CREATE TABLE \`notes\` (\`id\` text PRIMARY KEY, \`kind\` text);
CREATE TABLE \`locked\` (\`id\` text PRIMARY KEY);
CREATE TRIGGER \`locked_closed\` BEFORE INSERT ON \`locked\` BEGIN SELECT RAISE(ABORT, 'locked is closed'); END;
CREATE VIRTUAL TABLE \`words\` USING fts5(\`word\`);`).skipped
    ).toStrictEqual([
      { table: "words", reason: "a virtual table" },
      { table: "locked", reason: "locked is closed" },
    ]);
  });
});

describe(skippedErrors, () => {
  const skipped = [{ table: "locked", reason: "locked is closed" }];

  it("passes as many skipped tables as recorded", () => {
    expect(skippedErrors("db", skipped, { db: 1 })).toStrictEqual([]);
  });

  it("refuses more skipped tables than recorded, and asks to lower it for fewer", () => {
    expect(skippedErrors("db", skipped, {})).toStrictEqual([
      "db: 1 tables take no generated row, more than the 0 scripts/migration-data.ts allows, so the data check covers less: make them take one, or raise skippedTables with the reason.",
    ]);
    expect(skippedErrors("db", [], { db: 1 })).toStrictEqual([
      "db: 0 tables take no generated row, fewer than the 1 scripts/migration-data.ts allows: lower skippedTables to 0.",
    ]);
  });
});

describe(asDeployed, () => {
  it("drops foreign_keys toggles, which D1 and Durable Objects ignore", () => {
    expect(
      asDeployed(
        "PRAGMA foreign_keys=OFF;--> statement-breakpoint\nDROP TABLE `x`;\nPRAGMA foreign_keys = ON;"
      )
    ).toBe("--> statement-breakpoint\nDROP TABLE `x`;\n");
  });
});

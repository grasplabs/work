import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { asDeployed, seed, skippedErrors } from "./migration-data.ts";
import { checkDatabase } from "./migration-safety.ts";

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

/** The data changes and other errors of `next`, a migration a branch adds. */
const judged = (next: string, before = base): string[] =>
  checkDatabase(
    "db",
    [
      { idx: 0, tag: "0000_base", sql: before },
      { idx: 1, tag: "0001_next", sql: next },
    ],
    {
      from: 1,
      added: 1,
      now: new Date("2026-11-28T12:00:00Z"),
      indexedBy: new Set(),
    }
  ).errors.flatMap((found) =>
    found
      .split("\n")
      .filter((line) => line.startsWith("  - ") || !line.startsWith("  "))
      .map((line) => line.replace(/^ {2}- /u, ""))
      .filter((line) => !line.endsWith("after a rollback:"))
  );

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

describe("the data check", () => {
  it("refuses setting a column to NULL", () => {
    expect(judged("UPDATE `chats` SET `title` = NULL;")).toStrictEqual([
      'change values chats.title (2 of 3 rows, "\\"chats.title#0\\"" to null)',
    ]);
  });

  it("refuses deleting rows", () => {
    expect(judged("DELETE FROM `chats`;")).toStrictEqual([
      "delete rows chats (3 of 3 rows gone)",
    ]);
  });

  it("refuses a rebuild that copies nothing", () => {
    expect(judged(rebuildChats(""))).toStrictEqual([
      "delete rows chats (3 of 3 rows gone)",
    ]);
  });

  it("refuses a rebuild that swaps two columns", () => {
    expect(
      judged(
        rebuildChats(
          "INSERT INTO `__new_chats`(id, title, kind, owner_id, created_at) SELECT id, title, owner_id, kind, created_at FROM `chats`;--> statement-breakpoint"
        )
      )
    ).toStrictEqual([
      "change values chats.kind (3 of 3 rows, now holds what chats.owner_id held)",
      "change values chats.owner_id (3 of 3 rows, now holds what chats.kind held)",
    ]);
  });

  it("refuses renaming a column and adding one under its name", () => {
    expect(
      judged(`ALTER TABLE \`chats\` RENAME COLUMN \`title\` TO \`title2\`;--> statement-breakpoint
ALTER TABLE \`chats\` ADD \`title\` text;`)
    ).toStrictEqual([
      'change values chats.title (2 of 3 rows, "\\"chats.title#0\\"" to null)',
    ]);
  });

  it("refuses dropping a table and creating it again as it was", () => {
    expect(
      judged(`DROP TABLE \`chats\`;--> statement-breakpoint
CREATE TABLE \`chats\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`title\` text,
	\`kind\` text DEFAULT 'chat' NOT NULL,
	\`owner_id\` text NOT NULL,
	\`created_at\` integer NOT NULL
);`)
    ).toStrictEqual(["delete rows chats (3 of 3 rows gone)"]);
  });

  it("refuses a rebuild of a parent whose children go with it, as D1 runs it", () => {
    expect(
      judged(`PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE \`__new_people\` (\`id\` text PRIMARY KEY NOT NULL, \`name\` text, \`email\` text);
--> statement-breakpoint
INSERT INTO \`__new_people\`(id, name) SELECT id, name FROM \`people\`;--> statement-breakpoint
DROP TABLE \`people\`;--> statement-breakpoint
ALTER TABLE \`__new_people\` RENAME TO \`people\`;--> statement-breakpoint
PRAGMA foreign_keys=ON;`)
    ).toStrictEqual(["delete rows notes (3 of 3 rows gone)"]);
  });

  it("names a migration the rows refuse", () => {
    expect(judged("UPDATE `chats` SET `id` = 'one';")).toStrictEqual([
      "db/0001_next.sql does not apply to the rows the release before it wrote: UNIQUE constraint failed: chats.id",
    ]);
  });

  it("passes adding columns, a rebuild that copies every row, and a backfill of a new column", () => {
    expect(
      judged(`ALTER TABLE \`chats\` ADD \`summary\` text;--> statement-breakpoint
UPDATE \`chats\` SET \`summary\` = \`title\` || ' by ' || \`owner_id\`;`)
    ).toStrictEqual([]);
    expect(
      judged(
        rebuildChats(
          "INSERT INTO `__new_chats`(id, title, kind, owner_id, created_at) SELECT id, title, kind, owner_id, created_at FROM `chats`;--> statement-breakpoint"
        )
      )
    ).toStrictEqual([]);
  });

  it("passes a migration that reads a text column as a JSON list of objects", () => {
    expect(
      judged(
        "CREATE TABLE `chat_regions` AS SELECT json_set(`region`.`value`, '$.ok', 1) AS `value` FROM `chats`, json_each(`chats`.`title`) AS `region`;"
      )
    ).toStrictEqual([]);
  });

  it("refuses losing one of two equal rows of a table without a primary key", () => {
    expect(
      judged(
        `CREATE TABLE \`__new_marks\` (\`c\` text NOT NULL);
INSERT INTO \`__new_marks\` SELECT DISTINCT \`c\` FROM \`marks\`;
DROP TABLE \`marks\`;
ALTER TABLE \`__new_marks\` RENAME TO \`marks\`;`,
        "CREATE TABLE `marks` (`c` text NOT NULL, CONSTRAINT \"cs\" CHECK(`c` IN ('x', 'y')));"
      )
    ).toStrictEqual(["delete rows marks (1 of 3 rows gone)"]);
  });

  it("keeps a table that takes only JSON strings when another needs a list", () => {
    expect(
      judged(
        `CREATE TABLE \`regions\` AS SELECT json_set(\`region\`.\`value\`, '$.ok', 1) AS \`value\` FROM \`chats\`, json_each(\`chats\`.\`title\`) AS \`region\`;--> statement-breakpoint
DELETE FROM \`labels\`;`,
        `${base}
--> statement-breakpoint
CREATE TABLE \`labels\` (\`id\` text PRIMARY KEY NOT NULL, \`name\` text NOT NULL, CONSTRAINT "plain" CHECK(json_type(\`name\`) = 'text'));`
      )
    ).toStrictEqual(["delete rows labels (3 of 3 rows gone)"]);
  });

  it("passes a change its marker names, and refuses a marker for no change", () => {
    expect(
      judged(
        "-- contract: delete rows chats: release 26.11.40 removed the last use\nDELETE FROM `chats`;"
      )
    ).toStrictEqual([]);
    expect(
      judged(
        "-- contract: change values chats.title: release 26.11.40 removed the last use\nALTER TABLE `chats` ADD `summary` text;"
      )
    ).toStrictEqual([
      "db/0001_next.sql has a contract marker for change values chats.title, which it does not change in a way the release before it relies on: remove the marker.",
    ]);
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
      { from: 1, added: 2, now: new Date(), indexedBy: new Set() }
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
  db.close();
  return { counts, skipped: result.skipped };
};

describe(seed, () => {
  it("writes rows parents first, with a CHECK's values and a table of one row", () => {
    expect(
      seeded(`CREATE TABLE \`notes\` (\`id\` text PRIMARY KEY, \`person_id\` text NOT NULL REFERENCES \`people\`(\`id\`), \`kind\` text NOT NULL, CONSTRAINT "kinds" CHECK(\`kind\` IN ('a', 'b')));
CREATE TABLE \`people\` (\`id\` text PRIMARY KEY);
CREATE TABLE \`settings\` (\`id\` integer PRIMARY KEY, \`value\` text, CONSTRAINT "one_row" CHECK(\`id\` = 1));`)
    ).toStrictEqual({
      counts: { people: 3, notes: 3, settings: 1 },
      skipped: [],
    });
  });

  it("names each table that takes no row, and why", () => {
    expect(
      seeded(`CREATE TABLE \`locked\` (\`id\` text PRIMARY KEY);
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

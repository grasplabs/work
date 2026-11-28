import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import {
  checkDatabase,
  checksOf,
  contractMarker,
  schemaOf,
  unsafeChanges,
} from "./migration-safety.ts";

const base = `CREATE TABLE \`chats\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`title\` text,
	\`kind\` text DEFAULT 'chat' NOT NULL,
	\`owner_id\` text NOT NULL,
	\`created_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`people\` (\`id\` text PRIMARY KEY NOT NULL);`;

/**
 * What `next` changes that the release before it relies on, applied after
 * `base` and `earlier`.
 */
const changes = (next: string, earlier = ""): string[] => {
  const db = new DatabaseSync(":memory:");
  db.exec(base);
  db.exec(earlier);
  const before = schemaOf(db);
  db.exec(next);
  const found = unsafeChanges(before, schemaOf(db));
  db.close();
  return found;
};

/** drizzle-kit's rebuild of `chats` with `columns`, copying `copied`. */
const rebuild = (
  columns: string,
  copied = "id, title, kind, owner_id, created_at"
) =>
  `PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE \`__new_chats\` (${columns});
--> statement-breakpoint
INSERT INTO \`__new_chats\`(${copied}) SELECT ${copied} FROM \`chats\`;--> statement-breakpoint
DROP TABLE \`chats\`;--> statement-breakpoint
ALTER TABLE \`__new_chats\` RENAME TO \`chats\`;--> statement-breakpoint
PRAGMA foreign_keys=ON;`;

const columns = {
  id: "`id` text PRIMARY KEY NOT NULL",
  title: "`title` text",
  kind: "`kind` text DEFAULT 'chat' NOT NULL",
  owner: "`owner_id` text NOT NULL",
  created: "`created_at` integer NOT NULL",
};
const all = Object.values(columns);
const withColumns = (...list: string[]) => list.join(",\n\t");

describe(unsafeChanges, () => {
  it("passes what the previous release runs on", () => {
    expect(
      changes(`ALTER TABLE \`chats\` ADD \`summary\` text;--> statement-breakpoint
ALTER TABLE \`chats\` ADD \`pinned\` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE \`tags\` (\`id\` text PRIMARY KEY NOT NULL, \`name\` text NOT NULL, CONSTRAINT "named" CHECK(length(name) > 0));--> statement-breakpoint
CREATE INDEX \`chats_owner\` ON \`chats\` (\`owner_id\`);--> statement-breakpoint
CREATE UNIQUE INDEX \`tags_name\` ON \`tags\` (\`name\`);`)
    ).toStrictEqual([]);
  });

  it("passes a rebuild that keeps every column as it was, or loosens it", () => {
    expect(
      changes(
        rebuild(
          withColumns(
            columns.id,
            columns.title,
            columns.kind,
            "`owner_id` text",
            columns.created,
            "`summary` text"
          )
        )
      )
    ).toStrictEqual([]);
  });

  it("does not judge dropping an index", () => {
    expect(
      changes(`CREATE INDEX \`chats_owner\` ON \`chats\` (\`owner_id\`);--> statement-breakpoint
DROP INDEX \`chats_owner\`;`)
    ).toStrictEqual([]);
  });

  it("flags dropping or renaming a table", () => {
    expect(changes("DROP TABLE `people`;")).toStrictEqual([
      "drops or renames table people",
    ]);
    expect(changes("ALTER TABLE `people` RENAME TO `persons`;")).toStrictEqual([
      "drops or renames table people",
    ]);
  });

  it("flags dropping or renaming a column", () => {
    expect(changes("ALTER TABLE `chats` DROP COLUMN `title`;")).toStrictEqual([
      "drops or renames column chats.title",
    ]);
    expect(
      changes("ALTER TABLE `chats` RENAME COLUMN `title` TO `name`;")
    ).toStrictEqual(["drops or renames column chats.title"]);
    expect(
      changes(
        rebuild(
          withColumns(columns.id, columns.kind, columns.owner, columns.created),
          "id, kind, owner_id, created_at"
        )
      )
    ).toStrictEqual(["drops or renames column chats.title"]);
  });

  it("flags a type change", () => {
    expect(
      changes(
        rebuild(
          withColumns(
            columns.id,
            "`title` integer",
            columns.kind,
            columns.owner,
            columns.created
          )
        )
      )
    ).toStrictEqual(["changes the type of chats.title from text to integer"]);
  });

  it("flags making a column NOT NULL, even with a default", () => {
    expect(
      changes(
        rebuild(
          withColumns(
            columns.id,
            "`title` text DEFAULT '' NOT NULL",
            columns.kind,
            columns.owner,
            columns.created
          )
        )
      )
    ).toStrictEqual(["makes chats.title NOT NULL"]);
  });

  it("flags dropping the default of a NOT NULL column", () => {
    expect(
      changes(
        rebuild(
          withColumns(
            columns.id,
            columns.title,
            "`kind` text NOT NULL",
            columns.owner,
            columns.created
          )
        )
      )
    ).toStrictEqual(["drops the default of NOT NULL column chats.kind"]);
  });

  it("flags a new NOT NULL column without a default, and passes one with a default", () => {
    expect(
      changes(rebuild(withColumns(...all, "`team_id` text NOT NULL")))
    ).toStrictEqual(["adds NOT NULL column chats.team_id without a default"]);
    expect(
      changes(
        rebuild(withColumns(...all, "`team_id` text DEFAULT 'none' NOT NULL"))
      )
    ).toStrictEqual([]);
    expect(
      changes(
        rebuild(withColumns(...all, "`team_id` text DEFAULT NULL NOT NULL"))
      )
    ).toStrictEqual(["adds NOT NULL column chats.team_id without a default"]);
  });

  it("flags a foreign key on columns that were there, and passes one on a new column", () => {
    expect(
      changes(
        rebuild(
          withColumns(
            ...all,
            "FOREIGN KEY (`owner_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade"
          )
        )
      )
    ).toStrictEqual([
      "adds or changes a foreign key on chats: (owner_id) references people (id) on update NO ACTION on delete CASCADE",
    ]);
    expect(
      changes(
        "ALTER TABLE `chats` ADD `reviewer_id` text REFERENCES people(id);"
      )
    ).toStrictEqual([]);
  });

  it("flags a unique key on columns that were there", () => {
    expect(
      changes("CREATE UNIQUE INDEX `chats_title` ON `chats` (`title`);")
    ).toStrictEqual(["adds a unique key on chats (title)"]);
    expect(
      changes(
        'CREATE UNIQUE INDEX `chats_title` ON `chats` (`title`) WHERE "chats"."kind" = \'chat\';'
      )
    ).toStrictEqual([
      "adds a unique key on chats (title) where chats.kind = 'chat'",
    ]);
    expect(
      changes("CREATE UNIQUE INDEX `chats_title` ON `chats` (lower(`title`));")
    ).toStrictEqual(["adds a unique key on chats (<lower(title)>)"]);
    expect(
      changes(
        "CREATE UNIQUE INDEX `chats_title_length` ON `chats` (length(`title`));",
        "CREATE UNIQUE INDEX `chats_title` ON `chats` (lower(`title`));"
      )
    ).toStrictEqual(["adds a unique key on chats (<length(title)>)"]);
    expect(
      changes(
        "CREATE UNIQUE INDEX `chats_title_nocase` ON `chats` (`title` COLLATE NOCASE);",
        "CREATE UNIQUE INDEX `chats_title` ON `chats` (`title`);"
      )
    ).toStrictEqual(["adds a unique key on chats (title collate nocase)"]);
  });

  it("passes a unique key an earlier one implies, or whose WHERE reads a new column", () => {
    expect(
      changes(
        "CREATE UNIQUE INDEX `chats_id_title` ON `chats` (`id`, `title`);"
      )
    ).toStrictEqual([]);
    expect(
      changes(`ALTER TABLE \`chats\` ADD \`archived\` integer;--> statement-breakpoint
CREATE UNIQUE INDEX \`chats_title\` ON \`chats\` (\`title\`) WHERE "chats"."archived" = 0;`)
    ).toStrictEqual([]);
  });

  it("flags a CHECK on columns that were there, and passes one that reads a new column", () => {
    expect(
      changes(
        rebuild(
          withColumns(
            ...all,
            "CONSTRAINT \"kinds\" CHECK(\"kind\" IN ('chat', 'task'))"
          )
        )
      )
    ).toStrictEqual([
      "adds or changes a CHECK on chats: kind in ('chat', 'task')",
    ]);
    expect(
      changes(
        rebuild(
          withColumns(
            ...all,
            "`agent_id` text",
            'CONSTRAINT "one_owner" CHECK((owner_id IS NULL) <> (agent_id IS NULL))'
          )
        )
      )
    ).toStrictEqual([]);
  });

  it("flags a CHECK whose string values change, or behind a comment", () => {
    const kinds = (values: string) =>
      rebuild(
        withColumns(...all, `CONSTRAINT "kinds" CHECK("kind" IN (${values}))`)
      );
    expect(
      changes(kinds("'Chat', 'task'"), kinds("'chat', 'task'"))
    ).toStrictEqual([
      "adds or changes a CHECK on chats: kind in ('Chat', 'task')",
    ]);
    expect(
      changes(
        rebuild(
          withColumns(
            ...all,
            "CHECK /* a title ( */\n\n\n      (length(title) > 0)"
          )
        )
      )
    ).toStrictEqual(["adds or changes a CHECK on chats: length(title) > 0"]);
  });
});

describe(checksOf, () => {
  it("reads every CHECK's expression, past strings and nested parentheses", () => {
    expect(
      checksOf(
        "CREATE TABLE `t` (`a` text CHECK(a <> 'check('), `b` int, CONSTRAINT \"c\" CHECK ((b > 0) AND (b < 9)))"
      )
    ).toStrictEqual(["a <> 'check('", "(b > 0) and (b < 9)"]);
  });
});

describe(contractMarker, () => {
  it("reads the release a marker names", () => {
    expect(
      contractMarker(
        "-- contract: release 26.11.40 removed the last use\nDROP TABLE `people`;"
      )
    ).toStrictEqual({ release: "26.11.40" });
  });

  it("is undefined without a marker", () => {
    expect(contractMarker("DROP TABLE `people`;")).toBeUndefined();
  });

  it("refuses a marker that does not read as it must", () => {
    for (const sql of [
      "-- contract: release dev-abc removed the last use",
      "-- contract: release 26.13.1 removed the last use",
      "-- Contract: 26.11.40",
      "-- contract: release 26.11.40 removed the last use\n-- contract: release 26.11.41 removed the last use",
    ]) {
      expect(contractMarker(sql)).toHaveProperty("error");
    }
  });
});

describe(checkDatabase, () => {
  const judged = (next: string, from = 1) =>
    checkDatabase(
      "db",
      [
        { idx: 0, tag: "0000_base", sql: base },
        { idx: 1, tag: "0001_next", sql: next },
      ],
      from
    );

  it("refuses an unsafe migration without a marker, naming each change and the marker", () => {
    const [error, ...rest] = judged("DROP TABLE `people`;");
    expect(rest).toStrictEqual([]);
    expect(error).toContain("db/0001_next.sql breaks the release before it");
    expect(error).toContain("  - drops or renames table people");
    expect(error).toContain(
      "-- contract: release 26.11.40 removed the last use"
    );
  });

  it("passes an unsafe migration with a marker", () => {
    expect(
      judged(
        "-- contract: release 26.11.40 removed the last use\nDROP TABLE `people`;"
      )
    ).toStrictEqual([]);
  });

  it("refuses a marker on a safe migration", () => {
    expect(
      judged(
        "-- contract: release 26.11.40 removed the last use\nALTER TABLE `chats` ADD `summary` text;"
      )
    ).toStrictEqual([
      "db/0001_next.sql has a contract marker but changes nothing the release before it relies on: remove the marker.",
    ]);
  });

  it("refuses a marker that does not read as it must", () => {
    expect(
      judged("-- contract: after 26.11.40\nDROP TABLE `people`;")
    ).toStrictEqual([
      'db/0001_next.sql needs one contract marker that reads "-- contract: release 26.11.40 removed the last use", with a published release\'s id, and has: -- contract: after 26.11.40.',
    ]);
  });

  it("does not judge a migration before the first one checked", () => {
    expect(judged("DROP TABLE `people`;", 2)).toStrictEqual([]);
  });
});

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import {
  checkDatabase,
  checksOf,
  contractMarkers,
  cutOffErrors,
  journalErrors,
  schemaOf,
  unsafeChanges,
} from "./migration-safety.ts";
import type { Change } from "./migration-safety.ts";

const base = `CREATE TABLE \`chats\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`title\` text,
	\`kind\` text DEFAULT 'chat' NOT NULL,
	\`owner_id\` text NOT NULL,
	\`created_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`people\` (\`id\` text PRIMARY KEY NOT NULL);`;

const line = ({ subject, detail }: Change): string =>
  detail === undefined ? subject : `${subject} (${detail})`;

/**
 * What `next` changes that the release before it relies on, applied after
 * `base` and `earlier`.
 */
const changes = (
  next: string,
  earlier = "",
  indexedBy: ReadonlySet<string> = new Set()
): string[] => {
  const db = new DatabaseSync(":memory:");
  db.exec(base);
  db.exec(earlier);
  const before = schemaOf(db);
  db.exec(next);
  const found = unsafeChanges(before, schemaOf(db), indexedBy).map(line);
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

/** `chats_owner` dropped and created again as `definition`. */
const recreated = (definition: string) =>
  `DROP INDEX \`chats_owner\`;--> statement-breakpoint
${definition}`;

/** A trigger that refuses changing a chat's owner, its body as given. */
const ownerKept = (body = "SELECT RAISE(ABORT, 'owner kept');") =>
  `CREATE TRIGGER \`chats_owner_kept\` BEFORE UPDATE OF \`owner_id\` ON \`chats\`
BEGIN
	${body}
END;`;

describe(unsafeChanges, () => {
  it("passes what the previous release runs on", () => {
    expect(
      changes(`ALTER TABLE \`chats\` ADD \`summary\` text;--> statement-breakpoint
ALTER TABLE \`chats\` ADD \`pinned\` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE \`tags\` (\`id\` text PRIMARY KEY NOT NULL, \`name\` text NOT NULL, CONSTRAINT "named" CHECK(length(name) > 0));--> statement-breakpoint
CREATE TRIGGER \`tags_kept\` BEFORE DELETE ON \`tags\` BEGIN SELECT RAISE(ABORT, 'kept'); END;--> statement-breakpoint
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
            "`title` text DEFAULT ''",
            columns.kind,
            "`owner_id` text",
            columns.created,
            "`summary` text"
          )
        )
      )
    ).toStrictEqual([]);
  });

  it("flags dropping or renaming a table", () => {
    expect(changes("DROP TABLE `people`;")).toStrictEqual([
      "drop table people (dropped or renamed)",
    ]);
    expect(changes("ALTER TABLE `people` RENAME TO `persons`;")).toStrictEqual([
      "drop table people (dropped or renamed)",
    ]);
  });

  it("flags dropping or renaming a view", () => {
    expect(
      changes(
        "DROP VIEW `chat_titles`;",
        "CREATE VIEW `chat_titles` AS SELECT `id`, `title` FROM `chats`;"
      )
    ).toStrictEqual(["drop view chat_titles (dropped or renamed)"]);
  });

  it("flags dropping or renaming a column", () => {
    expect(changes("ALTER TABLE `chats` DROP COLUMN `title`;")).toStrictEqual([
      "drop column chats.title (dropped or renamed)",
    ]);
    expect(
      changes("ALTER TABLE `chats` RENAME COLUMN `title` TO `name`;")
    ).toStrictEqual(["drop column chats.title (dropped or renamed)"]);
    expect(
      changes(
        rebuild(
          withColumns(columns.id, columns.kind, columns.owner, columns.created),
          "id, kind, owner_id, created_at"
        )
      )
    ).toStrictEqual(["drop column chats.title (dropped or renamed)"]);
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
    ).toStrictEqual(["change type chats.title (text to integer)"]);
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
    ).toStrictEqual(["make not null chats.title"]);
  });

  it("flags a changed or removed default", () => {
    const kind = (column: string) =>
      rebuild(
        withColumns(
          columns.id,
          columns.title,
          column,
          columns.owner,
          columns.created
        )
      );
    expect(changes(kind("`kind` text NOT NULL"))).toStrictEqual([
      "change default chats.kind ('chat' to none)",
    ]);
    expect(changes(kind("`kind` text DEFAULT NULL NOT NULL"))).toStrictEqual([
      "change default chats.kind ('chat' to none)",
    ]);
    expect(changes(kind("`kind` text DEFAULT 'task' NOT NULL"))).toStrictEqual([
      "change default chats.kind ('chat' to 'task')",
    ]);
  });

  it("flags a new NOT NULL column without a default, and passes one with a default", () => {
    expect(
      changes(rebuild(withColumns(...all, "`team_id` text NOT NULL")))
    ).toStrictEqual(["add not null column chats.team_id (without a default)"]);
    expect(
      changes(
        rebuild(withColumns(...all, "`team_id` text DEFAULT 'none' NOT NULL"))
      )
    ).toStrictEqual([]);
    expect(
      changes(
        rebuild(withColumns(...all, "`team_id` text DEFAULT NULL NOT NULL"))
      )
    ).toStrictEqual(["add not null column chats.team_id (without a default)"]);
  });

  it("flags a changed primary key, and a removed AUTOINCREMENT", () => {
    expect(
      changes(
        rebuild(
          withColumns(
            "`id` text NOT NULL",
            columns.title,
            columns.kind,
            columns.owner,
            columns.created,
            "PRIMARY KEY(`id`, `owner_id`)"
          )
        )
      )
    ).toStrictEqual(["change primary key chats ((id) to (id, owner_id))"]);
    expect(
      changes(
        `CREATE TABLE \`__new_events\` (\`id\` integer PRIMARY KEY, \`name\` text);--> statement-breakpoint
INSERT INTO \`__new_events\` SELECT * FROM \`events\`;--> statement-breakpoint
DROP TABLE \`events\`;--> statement-breakpoint
ALTER TABLE \`__new_events\` RENAME TO \`events\`;`,
        "CREATE TABLE `events` (`id` integer PRIMARY KEY AUTOINCREMENT, `name` text);"
      )
    ).toStrictEqual(["drop autoincrement events"]);
  });

  it("flags dropping an index code names with INDEXED BY, and no other", () => {
    const earlier = "CREATE INDEX `chats_owner` ON `chats` (`owner_id`);";
    expect(
      changes("DROP INDEX `chats_owner`;", earlier, new Set(["chats_owner"]))
    ).toStrictEqual(["drop index chats_owner (code names it with INDEXED BY)"]);
    expect(changes("DROP INDEX `chats_owner`;", earlier)).toStrictEqual([]);
  });

  it("flags changing an index code names with INDEXED BY, and passes one written again as it was", () => {
    const earlier =
      "CREATE INDEX `chats_owner` ON `chats` (`owner_id`) WHERE `kind` = 'chat';";
    expect(
      changes(
        recreated(
          "CREATE INDEX `chats_owner` ON `chats` (`owner_id`) WHERE `kind` = 'task';"
        ),
        earlier,
        new Set(["chats_owner"])
      )
    ).toStrictEqual([
      "change index chats_owner (code names it with INDEXED BY)",
    ]);
    expect(
      changes(
        recreated(
          'CREATE INDEX  "chats_owner"  ON "chats" ("owner_id") WHERE "kind" = \'chat\';'
        ),
        earlier,
        new Set(["chats_owner"])
      )
    ).toStrictEqual([]);
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
      "add foreign key chats.owner_id ((owner_id) references people (id) on update NO ACTION on delete CASCADE)",
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
    ).toStrictEqual(["add unique key chats ((title))"]);
    expect(
      changes(
        'CREATE UNIQUE INDEX `chats_title` ON `chats` (`title`) WHERE "chats"."kind" = \'chat\';'
      )
    ).toStrictEqual([
      "add unique key chats ((title) where chats.kind = 'chat')",
    ]);
    expect(
      changes("CREATE UNIQUE INDEX `chats_title` ON `chats` (lower(`title`));")
    ).toStrictEqual(["add unique key chats ((<lower(title)>))"]);
    expect(
      changes(
        "CREATE UNIQUE INDEX `chats_title_length` ON `chats` (length(`title`));",
        "CREATE UNIQUE INDEX `chats_title` ON `chats` (lower(`title`));"
      )
    ).toStrictEqual(["add unique key chats ((<length(title)>))"]);
    expect(
      changes(
        "CREATE UNIQUE INDEX `chats_title_nocase` ON `chats` (`title` COLLATE NOCASE);",
        "CREATE UNIQUE INDEX `chats_title` ON `chats` (`title`);"
      )
    ).toStrictEqual(["add unique key chats ((title collate nocase))"]);
  });

  it("passes a unique key an earlier one implies, or whose WHERE reads a new column", () => {
    expect(
      changes(
        "CREATE UNIQUE INDEX `chats_id_title` ON `chats` (`id`, `title`);"
      )
    ).toStrictEqual([]);
    expect(
      changes(
        "CREATE UNIQUE INDEX `chats_title_owner` ON `chats` (lower(`title`), `owner_id`);",
        "CREATE UNIQUE INDEX `chats_title` ON `chats` (lower(`title`));"
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
    ).toStrictEqual(["add check chats (kind in ('chat', 'task'))"]);
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
    ).toStrictEqual(["add check chats (kind in ('Chat', 'task'))"]);
    expect(
      changes(
        rebuild(
          withColumns(
            ...all,
            "CHECK /* a title ( */\n\n\n      (length(title) > 0)"
          )
        )
      )
    ).toStrictEqual(["add check chats (length(title) > 0)"]);
  });

  it("flags a new or changed trigger that can refuse writes to a table that was there", () => {
    const refusing =
      "add trigger chats_owner_kept (added or changed, and can refuse writes to chats)";
    expect(changes(ownerKept())).toStrictEqual([refusing]);
    expect(
      changes(
        `DROP TRIGGER \`chats_owner_kept\`;--> statement-breakpoint
${ownerKept("SELECT RAISE(ABORT, 'the owner is kept');")}`,
        ownerKept()
      )
    ).toStrictEqual([refusing]);
    expect(
      changes(ownerKept("UPDATE `people` SET `id` = `id` WHERE 0;"))
    ).toStrictEqual([]);
  });

  it("passes a trigger written again as it was", () => {
    expect(
      changes(
        `DROP TRIGGER \`chats_owner_kept\`;--> statement-breakpoint
${ownerKept("SELECT   RAISE(ABORT,   'owner kept');")}`,
        ownerKept()
      )
    ).toStrictEqual([]);
  });
});

describe(checksOf, () => {
  it("reads every CHECK's expression, past strings, comments and nested parentheses", () => {
    expect(
      checksOf(
        "CREATE TABLE `t` (`a` text CHECK(a <> 'check('), -- check(no)\n `b` int, CONSTRAINT \"c\" CHECK /* ( */ ((b > 0) AND (b < 9)))"
      )
    ).toStrictEqual(["a <> 'check('", "(b > 0) and (b < 9)"]);
  });
});

describe(contractMarkers, () => {
  const now = new Date("2026-11-28T12:00:00Z");

  it("reads the change each marker names", () => {
    expect(
      contractMarkers(
        "-- contract: drop table people: release 26.11.40 removed the last use\n  -- contract: drop column chats.title: release 26.10.2 removed the last use\nDROP TABLE `people`;",
        now
      )
    ).toStrictEqual({
      subjects: new Set(["drop table people", "drop column chats.title"]),
      errors: [],
    });
  });

  it("counts only whole-line comments outside strings and block comments", () => {
    const marker =
      "-- contract: drop table people: release 26.11.40 removed the last use";
    for (const sql of [
      `SELECT '\n${marker}\n';`,
      `/*\n${marker}\n*/`,
      `DROP TABLE \`people\`; ${marker}`,
    ]) {
      expect(contractMarkers(sql, now).subjects).toStrictEqual(new Set());
    }
  });

  it("refuses a marker that does not read as it must", () => {
    for (const sql of [
      "-- contract: drop table people: release dev-abc removed the last use",
      "-- contract: drop table people: release 26.13.1 removed the last use",
      "-- contract: release 26.11.40 removed the last use",
      "-- Contract: drop table people",
    ]) {
      expect(contractMarkers(sql, now).errors).toHaveLength(1);
    }
  });

  it("refuses a release of a later month, and two markers for one change", () => {
    expect(
      contractMarkers(
        "-- contract: drop table people: release 26.12.1 removed the last use",
        now
      ).errors
    ).toStrictEqual([
      "names release 26.12.1, which is of a later month than this one",
    ]);
    expect(
      contractMarkers(
        "-- contract: drop table people: release 26.11.1 removed the last use\n-- contract: drop table people: release 26.11.2 removed the last use",
        now
      ).errors
    ).toStrictEqual(["has two contract markers for drop table people"]);
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
      {
        from,
        added: from,
        now: new Date("2026-11-28T12:00:00Z"),
        indexedBy: new Set(),
      }
    ).errors;
  const dropPeople =
    "-- contract: drop table people: release 26.11.40 removed the last use";
  const dropTitle =
    "-- contract: drop column chats.title: release 26.11.40 removed the last use";
  const both = "DROP TABLE `people`;\nALTER TABLE `chats` DROP COLUMN `title`;";

  it("refuses an unsafe migration without a marker, naming each change and its marker", () => {
    const [error, ...rest] = judged("DROP TABLE `people`;");
    expect(rest).toStrictEqual([]);
    expect(error).toContain("db/0001_next.sql breaks the release before it");
    expect(error).toContain("  - drop table people (dropped or renamed)");
    expect(error).toContain(
      "  -- contract: drop table people: release YY.MM.N removed the last use"
    );
  });

  it("passes an unsafe migration with a marker for each change", () => {
    expect(judged(`${dropPeople}\n${dropTitle}\n${both}`)).toStrictEqual([]);
  });

  it("refuses a change its markers do not name", () => {
    const [error, ...rest] = judged(`${dropPeople}\n${both}`);
    expect(rest).toStrictEqual([]);
    expect(error).toContain("  - drop column chats.title (dropped or renamed)");
    expect(error).not.toContain("drop table people");
  });

  it("refuses a marker that names no change", () => {
    expect(
      judged(`${dropTitle}\nALTER TABLE \`chats\` ADD \`summary\` text;`)
    ).toStrictEqual([
      "db/0001_next.sql has a contract marker for drop column chats.title, which it does not change in a way the release before it relies on: remove the marker.",
    ]);
  });

  it("refuses a marker that does not read as it must", () => {
    const [error] = judged(
      "-- contract: after 26.11.40\nALTER TABLE `chats` ADD `summary` text;"
    );
    expect(error).toContain(
      'db/0001_next.sql has the contract marker "-- contract: after 26.11.40"'
    );
  });

  it("does not judge a migration before the first one checked", () => {
    expect(judged("DROP TABLE `people`;", 2)).toStrictEqual([]);
  });

  it("names the migration that does not apply", () => {
    const [error] = judged("ALTER TABLE `nothing` ADD `x` text;");
    expect(error).toContain(
      "db/0001_next.sql does not apply after the migrations before it: no such table: nothing"
    );
  });
});

describe(journalErrors, () => {
  const tags = ["0000_chats", "0001_titles"];
  const migrationsJs = (
    names: string[]
  ) => `import journal from './meta/_journal.json';
${tags.map((tag, at) => `import m000${at} from './${tag}.sql';`).join("\n")}

  export default {
    journal,
    migrations: {
      ${names.join(",\n")}
    }
  }
`;

  it("passes a folder, and a Durable Object's migrations.js, that match the journal", () => {
    expect(
      journalErrors(
        "db",
        tags,
        ["0001_titles.sql", "0000_chats.sql"],
        migrationsJs(["m0000", "m0001"])
      )
    ).toStrictEqual([]);
  });

  it("refuses a .sql the journal does not list, and an entry without its .sql", () => {
    expect(
      journalErrors("db", tags, ["0000_chats.sql", "0002_orphan.sql"])
    ).toStrictEqual([
      "db/0002_orphan.sql is not in its journal, so nothing checks it but it would ship: generate migrations with `vp run -r db:generate`, or remove it.",
      "db/meta/_journal.json lists 0001_titles, which has no .sql file.",
    ]);
  });

  it("refuses a migrations.js that leaves one out or reorders them", () => {
    for (const names of [["m0000"], ["m0001", "m0000"]]) {
      expect(
        journalErrors(
          "db",
          tags,
          ["0000_chats.sql", "0001_titles.sql"],
          migrationsJs(names)
        )
      ).toStrictEqual([
        "db/migrations.js does not apply the journal's migrations, in its order: generate it again with `vp run -r db:generate`.",
      ]);
    }
  });
});

describe(cutOffErrors, () => {
  it("passes a cut-off at most the migrations main had where the branch left it", () => {
    expect(
      cutOffErrors({ db: 59 }, new Set(["db"]), new Map([["db", 59]]))
    ).toStrictEqual([]);
  });

  it("refuses a cut-off that covers a migration the branch adds", () => {
    expect(
      cutOffErrors({ db: 60 }, new Set(["db"]), new Map([["db", 59]]))
    ).toStrictEqual([
      "scripts/migration-safety.ts judges db from migration 60, but main had 59 where the branch left it: a cut-off never covers a migration the branch adds.",
    ]);
  });

  it("refuses a cut-off for a database there is not", () => {
    expect(cutOffErrors({ gone: 3 }, new Set(), new Map())).toStrictEqual([
      "scripts/migration-safety.ts names gone, which has no journal: remove it from firstChecked.",
    ]);
  });
});

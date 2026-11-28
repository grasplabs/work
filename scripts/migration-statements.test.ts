import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import {
  runRecordingWrites,
  shownStatement,
  statementChanges,
  triggerSql,
} from "./migration-statements.ts";

const recorded = (sql: string) => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE \`p\` (\`id\` text PRIMARY KEY, \`kind\` text);
CREATE TABLE \`log\` (\`x\` text);
CREATE TRIGGER \`p_logged\` AFTER INSERT ON \`p\` BEGIN UPDATE \`log\` SET \`x\` = NEW.\`id\`; END;`);
  // The trigger is main's: what it writes is free.
  const writes = runRecordingWrites(db, sql, triggerSql(db)).map(
    ({ kind, table, column }) =>
      `${kind} ${table}${column === undefined ? "" : `.${column}`}`
  );
  db.close();
  return writes;
};

describe(runRecordingWrites, () => {
  it("records each statement's deletes and updates, not its trigger's, nor a drop's own delete", () => {
    expect(
      recorded(`INSERT INTO \`p\` VALUES ('a', 'b');--> statement-breakpoint
DELETE FROM \`p\` WHERE \`kind\` LIKE 'tmp%';--> statement-breakpoint
INSERT INTO \`p\` VALUES ('a', 'c') ON CONFLICT(\`id\`) DO UPDATE SET \`kind\` = excluded.\`kind\`;--> statement-breakpoint
DROP TABLE \`log\`;`)
    ).toStrictEqual(["delete p", "update p.kind", "drop log"]);
  });

  it("keeps an explicit delete of a table the same statement group drops", () => {
    expect(
      recorded(`DELETE FROM \`p\` WHERE \`kind\` LIKE 'tmp%';
CREATE TABLE \`__new_p\` (\`id\` text PRIMARY KEY, \`kind\` text);
INSERT INTO \`__new_p\` SELECT * FROM \`p\`;
DROP TABLE \`p\`;
ALTER TABLE \`__new_p\` RENAME TO \`p\`;`)
    ).toStrictEqual(["delete p", "drop p", "rename __new_p"]);
  });
});

describe(statementChanges, () => {
  const context = {
    base: new Map([
      [
        "p",
        {
          columns: new Map([
            ["id", 0],
            ["kind", 0],
          ]),
        },
      ],
    ]),
    moved: new Set<string>(),
    after: new Set(["p"]),
    skipped: new Set<string>(),
  };

  it("names every delete and update, on any table, but a backfill of a column the branch added", () => {
    expect(
      statementChanges(
        [
          { kind: "delete", table: "p", statement: "DELETE FROM p WHERE 0;" },
          { kind: "delete", table: "p", statement: "-- gone\nDELETE FROM p;" },
          {
            kind: "update",
            table: "p",
            column: "kind",
            statement: "UPDATE p SET kind = 1;",
          },
          {
            kind: "update",
            table: "p",
            column: "added",
            statement: "UPDATE p SET added = kind;",
          },
          { kind: "delete", table: "fresh", statement: "DELETE FROM fresh;" },
        ],
        context
      ).map(({ subject, statements }) => [subject, statements])
    ).toStrictEqual([
      ["delete rows p", ["DELETE FROM p WHERE 0;", "DELETE FROM p;"]],
      ["change values p.kind", ["UPDATE p SET kind = 1;"]],
      ["delete rows fresh", ["DELETE FROM fresh;"]],
    ]);
  });

  it("names a copy that is more than plain, but one into a derived table", () => {
    const copy = (intoNew: boolean, moved: string[]) =>
      statementChanges(
        [
          {
            kind: "copy",
            table: "d",
            statement: "INSERT INTO d SELECT id FROM p WHERE kind = 1;",
            detail: "Eq",
            sources: ["p"],
            intoNew,
          },
        ],
        { ...context, moved: new Set(moved) }
      ).map(({ subject }) => subject);
    expect(copy(true, [])).toStrictEqual([]);
    expect(copy(false, [])).toStrictEqual(["change values d"]);
    expect(copy(true, ["d"])).toStrictEqual(["change values d"]);
    expect(copy(true, ["p"])).toStrictEqual(["change values d"]);
  });

  it("names a rebuild of a table no generated row got into, and passes one of a covered table", () => {
    const drop = [
      { kind: "drop" as const, table: "p", statement: "DROP TABLE p;" },
    ];
    expect(statementChanges(drop, context)).toStrictEqual([]);
    expect(
      statementChanges(drop, { ...context, skipped: new Set(["p"]) }).map(
        ({ subject }) => subject
      )
    ).toStrictEqual(["delete rows p"]);
  });
});

describe(shownStatement, () => {
  it("shows a statement on one line, without its comments", () => {
    expect(
      shownStatement("-- why\nDELETE FROM `p`\n  WHERE `kind` = 'x';")
    ).toBe("DELETE FROM `p` WHERE `kind` = 'x';");
  });
});

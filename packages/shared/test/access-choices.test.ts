import { describe, expect, it } from "vite-plus/test";

import {
  accessAfter,
  changeAnswer,
  choicesFor,
  enforcedChange,
  seeAnswer,
  seeing,
  withAccess,
} from "../src/access-choices.ts";
import type { Answer } from "../src/access-choices.ts";
import type { DataModelRule, DataModelTable } from "../src/data-model.ts";

// Each answer to who can see and change a table's records, as the access
// it saves and as the store enforces that (who changes takes the write
// mode, the read rules and the write rules, never the read mode), from
// the threat model: an answer saved as wider access than it says; who
// changes reaching records who sees doesn't; an access only code can say
// lost or changed by opening the page; and who changes widened by a
// change of who sees. Core's access-choices.test.ts holds a member's
// writes to each.

/** The deals table: an assignee and a team field, its access as given. */
const deals = (
  read: DataModelTable["access"]["read"],
  write: DataModelTable["access"]["write"],
  rows: { read?: DataModelRule[]; write?: DataModelRule[] } = {}
): DataModelTable => ({
  id: "deals",
  name: "deals",
  fields: [
    {
      id: "f1",
      name: "assignee",
      type: { kind: "person" },
      required: false,
      code: "v.person()",
      nullable: false,
      defaultCode: null,
    },
    {
      id: "f2",
      name: "salesTeam",
      type: { kind: "text", trim: false, min: null, max: null },
      required: false,
      code: "v.string()",
      nullable: false,
      defaultCode: null,
    },
  ],
  indexes: [],
  searchIndex: null,
  sensitive: false,
  access: {
    read,
    write,
    rows: { read: rows.read ?? [], write: rows.write ?? [] },
  },
});

/** Who sees and who changes, as `table` saved with these answers enforces them. */
const savedAs = (
  table: DataModelTable,
  answers: { read?: Answer; write?: Answer }
) => {
  const saved = withAccess(table, accessAfter(table, answers));
  return {
    see: seeAnswer(seeing(saved)),
    change: changeAnswer(enforcedChange(saved)),
  };
};

describe("who can see and change a table's records", () => {
  it("saves each answer, given to both, as access the store enforces as that answer", () => {
    const table = deals("appMembers", "appMembers");
    const answers = choicesFor(table);
    expect(
      answers.map((answer) => savedAs(table, { read: answer, write: answer }))
    ).toStrictEqual(answers.map((answer) => ({ see: answer, change: answer })));
  });

  it("never lets who changes reach further than who sees: only their own, then everyone, saves only their own", () => {
    const table = deals("appMembers", "appMembers");
    expect({
      access: accessAfter(table, {
        read: { kind: "added" },
        write: { kind: "everyone" },
      }),
      enforced: savedAs(table, {
        read: { kind: "added" },
        write: { kind: "everyone" },
      }),
    }).toStrictEqual({
      access: { read: "owner", write: "owner" },
      enforced: { see: { kind: "added" }, change: { kind: "added" } },
    });
  });

  it("narrows who changes with who sees", () => {
    const table = deals("appMembers", "appMembers");
    expect([
      savedAs(table, { read: { kind: "added" } }),
      savedAs(table, { read: { kind: "builders" } }),
      savedAs(table, { read: { kind: "person", field: "assignee" } }),
    ]).toStrictEqual([
      { see: { kind: "added" }, change: { kind: "added" } },
      { see: { kind: "builders" }, change: { kind: "builders" } },
      {
        see: { kind: "person", field: "assignee" },
        change: { kind: "person", field: "assignee" },
      },
    ]);
  });

  it("keeps who changes as enforced when who sees widens: read rules the writes took are kept", () => {
    // Writes take the read rules: only the assignee changes a deal.
    const assigned = deals("appMembers", "appMembers", {
      read: [{ kind: "person", field: "assignee" }],
    });
    // And the owner too: only a deal they added and are assigned.
    const both = deals("appMembers", "appMembers", {
      read: [{ kind: "person", field: "assignee" }],
      write: [{ kind: "owner" }],
    });
    expect({
      assigned: accessAfter(assigned, { read: { kind: "everyone" } }),
      assignedEnforced: savedAs(assigned, { read: { kind: "everyone" } }),
      both: accessAfter(both, { read: { kind: "everyone" } }),
      bothEnforced: savedAs(both, { read: { kind: "everyone" } }),
    }).toStrictEqual({
      assigned: {
        read: "appMembers",
        write: "appMembers",
        rows: { write: [{ kind: "person", field: "assignee" }] },
      },
      assignedEnforced: {
        see: { kind: "everyone" },
        change: { kind: "person", field: "assignee" },
      },
      // Both together no one answer says: nobody changes deals until
      // someone answers again, rather than more people than before.
      both: { read: "appMembers", write: "none" },
      bothEnforced: { see: { kind: "everyone" }, change: { kind: "nobody" } },
    });
  });

  it("reads an access no answer says as the App's code's, and saves it unchanged", () => {
    const table = deals("appMembers", "appMembers", {
      read: [{ kind: "owner" }, { kind: "role", role: "builder" }],
    });
    expect({
      ...savedAs(table, {}),
      saved: accessAfter(table, {}),
    }).toStrictEqual({
      see: { kind: "code" },
      change: { kind: "code" },
      saved: {
        read: "appMembers",
        write: "appMembers",
        rows: {
          read: [{ kind: "owner" }, { kind: "role", role: "builder" }],
        },
      },
    });
  });
});

import type {
  DataModelRule,
  DataModelTable,
} from "@grasp-os/shared/data-model";
import { describe, expect, it } from "vite-plus/test";

import {
  accessAfter,
  changing,
  choiceOf,
  choicesFor,
  directionOf,
  seeing,
} from "./access-choices.ts";
import type { Answer } from "./access-choices.ts";

// Each answer to who can see and change a table's records, as the access
// it saves, from the threat model: an answer saved as wider access than it
// says; an access only code can say lost or changed by opening the page;
// and who changes records widened by a change of who sees them.

/** The deals table: an owner and a team field, its access as given. */
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
      name: "owner",
      type: { kind: "person" },
      required: true,
      code: "v.person()",
    },
    {
      id: "f2",
      name: "salesTeam",
      type: { kind: "text", trim: false, min: null, max: null },
      required: false,
      code: "v.string()",
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

describe("who can see and change a table's records", () => {
  it("saves each answer as exactly the access it says, and reads it back as that answer", () => {
    const table = deals("appMembers", "appMembers");
    const answers = choicesFor(table);
    expect(
      answers.map((answer) => [
        answer,
        accessAfter(table, { read: answer, write: answer }),
      ])
    ).toStrictEqual([
      [{ kind: "everyone" }, { read: "appMembers", write: "appMembers" }],
      [{ kind: "added" }, { read: "owner", write: "owner" }],
      [
        { kind: "person", field: "owner" },
        {
          read: "appMembers",
          write: "appMembers",
          rows: {
            read: [{ kind: "person", field: "owner" }],
            write: [{ kind: "person", field: "owner" }],
          },
        },
      ],
      [
        { kind: "team", field: "salesTeam" },
        {
          read: "appMembers",
          write: "appMembers",
          rows: {
            read: [{ kind: "team", field: "salesTeam" }],
            write: [{ kind: "team", field: "salesTeam" }],
          },
        },
      ],
      [{ kind: "builders" }, { read: "appBuilders", write: "appBuilders" }],
      [{ kind: "nobody" }, { read: "none", write: "none" }],
    ]);
    expect(
      answers.map((answer) => [
        choiceOf(directionOf(answer)),
        choiceOf(directionOf(answer, true)),
      ])
    ).toStrictEqual(answers.map((answer) => [answer, answer]));
  });

  it("reads an access no answer says as the App's code's, and saves it unchanged", () => {
    const table = deals("appMembers", "appMembers", {
      read: [{ kind: "owner" }, { kind: "role", role: "builder" }],
    });
    expect({
      seeing: choiceOf(seeing(table)),
      changing: choiceOf(changing(table)),
      saved: accessAfter(table, {}),
    }).toStrictEqual({
      seeing: { kind: "code" },
      changing: { kind: "code" },
      saved: {
        read: "appMembers",
        write: "appMembers",
        rows: {
          read: [{ kind: "owner" }, { kind: "role", role: "builder" }],
        },
      },
    });
  });

  it("never widens who changes records when who sees them widens", () => {
    // Changes follow the read rules: only the owner changes a deal.
    const table = deals("appMembers", "appMembers", {
      read: [{ kind: "person", field: "owner" }],
    });
    const before = choiceOf(changing(table));
    const after = accessAfter(table, { read: { kind: "everyone" } });
    expect({ before, after }).toStrictEqual({
      before: { kind: "person", field: "owner" },
      after: {
        read: "appMembers",
        write: "appMembers",
        rows: { write: [{ kind: "person", field: "owner" }] },
      },
    });
  });

  it("lets everyone who sees a record change it, under read rules, as an answer of its own", () => {
    const table = deals("appMembers", "appMembers", {
      read: [{ kind: "team", field: "salesTeam" }],
    });
    const everyone: Answer = { kind: "everyone" };
    const saved = accessAfter(table, { write: everyone });
    const reread = deals(saved.read, saved.write, saved.rows);
    expect({
      saved,
      seeing: choiceOf(seeing(reread)),
      changing: choiceOf(changing(reread)),
    }).toStrictEqual({
      saved: {
        read: "appMembers",
        write: "appMembers",
        rows: {
          read: [{ kind: "team", field: "salesTeam" }],
          write: [{ kind: "role", role: "user" }],
        },
      },
      seeing: { kind: "team", field: "salesTeam" },
      changing: everyone,
    });
  });
});

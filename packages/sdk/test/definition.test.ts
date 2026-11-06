import { describe, expect, test } from "vite-plus/test";

import { AppDefinitionError } from "../src/app.ts";
import { evaluateExpression } from "../src/definition-expression.ts";
import { applyOperation } from "../src/definition-operations.ts";
import type { DefinitionOperation } from "../src/definition-operations.ts";
import { schemaSource, validatorSource } from "../src/definition-source.ts";
import {
  definitionManifest,
  definitionText,
  emptyDefinition,
  readDefinition,
} from "../src/definition.ts";
import type { AppDefinition } from "../src/definition.ts";
import { descriptorOf } from "../src/value-schema.ts";
import { v } from "../src/values.ts";

// An App's definition (definition.ts): the operations that change it, the
// code generated from it, and what a definition of unknown origin is
// refused for. Pure, so unit tests; core's tools and builds are tested
// through core (apps/core/test/agent-builds.test.ts), and that the code
// generated from a definition seals as the App it is, there too
// (app-releases.test.ts), where a seal runs it.

/** IDs counted up, so a test can name them. */
const counter = () => {
  let next = 0;
  return () => {
    next += 1;
    return `id${String(next)}`;
  };
};

/** `operations` applied in order to an empty App's definition. */
const defined = (...operations: DefinitionOperation[]): AppDefinition => {
  const newId = counter();
  let definition = emptyDefinition("Tasks");
  for (const operation of operations) {
    definition = applyOperation(definition, operation, newId);
  }
  return definition;
};

const tasks = (): AppDefinition =>
  defined(
    {
      op: "addTable",
      name: "tasks",
      fields: {
        title: "v.string().trim().min(1).max(200)",
        done: "v.boolean().default(false)",
        owner: "v.person().optional()",
      },
      access: { read: "appMembers", write: "appMembers" },
    },
    { op: "addIndex", table: "tasks", name: "by_title", fields: ["title"] }
  );

describe("operations", () => {
  test("give every table and field an ID that a rename keeps", () => {
    const before = tasks();
    const after = applyOperation(before, {
      op: "renameField",
      table: "tasks",
      field: "title",
      name: "name",
    });
    const [table] = after.tables;
    expect(table?.id).toBe(before.tables[0]?.id);
    expect(table?.fields.map(({ id, name }) => [id, name])).toStrictEqual([
      ["id2", "name"],
      ["id3", "done"],
      ["id4", "owner"],
    ]);
    // The index names the field by its ID, so it follows the rename.
    expect(table?.indexes).toStrictEqual([
      { name: "by_title", fields: ["id2"] },
    ]);
    expect(schemaSource(after)).toContain('.index("by_title", ["name"])');
  });

  test("rename a table by its ID, every field that refers to it following", () => {
    const before = defined(
      {
        op: "addTable",
        name: "tasks",
        fields: { title: "v.string()" },
        access: { read: "appMembers", write: "appMembers" },
      },
      {
        op: "addTable",
        name: "notes",
        fields: { task: 'v.id("tasks")', tasks: 'v.array(v.id("tasks"))' },
        access: { read: "appMembers", write: "appMembers" },
      }
    );

    const after = applyOperation(before, {
      op: "renameTable",
      table: "tasks",
      name: "todos",
    });

    expect(after.tables.map(({ id, name }) => [id, name])).toStrictEqual(
      before.tables.map(({ id, name }) => [
        id,
        name === "tasks" ? "todos" : name,
      ])
    );
    expect(schemaSource(after)).toContain('task: v.id("todos")');
    expect(schemaSource(after)).toContain('tasks: v.array(v.id("todos"))');
    expect(() =>
      applyOperation(before, {
        op: "renameTable",
        table: "tasks",
        name: "Notes",
      })
    ).toThrow(/differs from it only in case/u);
  });

  test("refuse what code couldn't declare, changing nothing", () => {
    const before = tasks();
    const refusals: [DefinitionOperation, RegExp][] = [
      [{ op: "addTable", name: "tasks" }, /already/u],
      [
        { op: "addField", table: "tasks", name: "title", type: "v.string()" },
        /changeField/u,
      ],
      [
        { op: "addField", table: "nope", name: "x", type: "v.string()" },
        /no table `nope`/u,
      ],
      [
        { op: "addField", table: "tasks", name: "_x", type: "v.string()" },
        /name/u,
      ],
      [
        { op: "addField", table: "tasks", name: "x", type: "v.strin()" },
        /isn't a method/u,
      ],
      [
        {
          op: "addField",
          table: "tasks",
          name: "x",
          type: "globalThis.fetch('x')",
        },
        /isn't known/u,
      ],
      [
        {
          op: "addField",
          table: "tasks",
          name: "x",
          type: "v.string().constructor('x')",
        },
        /isn't a method/u,
      ],
      [
        {
          op: "addField",
          table: "tasks",
          name: "x",
          type: "v.id('elsewhere')",
        },
        /doesn't have/u,
      ],
      [
        {
          op: "changeField",
          table: "tasks",
          field: "nope",
          type: "v.string()",
        },
        /no field `nope`/u,
      ],
      [
        {
          op: "setAccess",
          table: "tasks",
          access: {
            read: "owner",
            write: "owner",
            rows: { read: [{ kind: "role", role: "builder" }] },
          },
        },
        /appMembers/u,
      ],
      [
        { op: "addIndex", table: "tasks", name: "by_owner", fields: ["nope"] },
        /no field/u,
      ],
      [
        {
          op: "addPermission",
          permission: "permission.ai({ maxOutputTokens: 0 })",
        },
        /maxOutputTokens/u,
      ],
      [
        { op: "addPermission", permission: "fetch('https://example.com')" },
        /builder's methods/u,
      ],
      // What would reach past the builders: a prototype's, a computed
      // member, a function's own methods, code in a template or a spread.
      [
        {
          op: "addField",
          table: "tasks",
          name: "x",
          type: "v.__proto__.string()",
        },
        /./u,
      ],
      [
        { op: "addField", table: "tasks", name: "x", type: 'v["string"]()' },
        /./u,
      ],
      [
        { op: "addField", table: "tasks", name: "x", type: "v.string.call(v)" },
        /./u,
      ],
      [
        {
          op: "addField",
          table: "tasks",
          name: "x",
          type: ["v.literal(`$", "{globalThis.fetch}`)"].join(""),
        },
        /./u,
      ],
      [
        {
          op: "addField",
          table: "tasks",
          name: "x",
          type: "v.object({ ...globalThis })",
        },
        /./u,
      ],
      // A key given twice: which value would it hold?
      [
        {
          op: "addField",
          table: "tasks",
          name: "x",
          type: "v.object({ title: v.string(), title: v.number() })",
        },
        /`title` is a key twice/u,
      ],
      [
        {
          op: "addPermission",
          permission: 'permission.hasOwnProperty("ai")',
        },
        /./u,
      ],
      [
        {
          op: "addPermission",
          permission: 'permission.ai({ "__proto__": { maxOutputTokens: 5 } })',
        },
        /./u,
      ],
      [
        {
          op: "addField",
          table: "tasks",
          name: "x",
          type: 'v.object({ "__proto__": v.string() })',
        },
        /./u,
      ],
      // A search index is the table's one, which has no name.
      [
        {
          op: "addIndex",
          table: "tasks",
          name: "by_text",
          fields: ["title"],
          search: true,
        },
        /no name/u,
      ],
      [{ op: "addIndex", table: "tasks", fields: ["title"] }, /has a name/u],
    ];
    for (const [operation, message] of refusals) {
      expect(() => applyOperation(before, operation)).toThrow(message);
    }
    expect(tasks()).toStrictEqual(before);
  });

  test("keep a table's one search index, and a table sensitive once it is declared so", () => {
    const searched = applyOperation(tasks(), {
      op: "addIndex",
      table: "tasks",
      fields: ["title"],
      search: true,
    });
    expect(searched.tables[0]?.searchIndex).toStrictEqual(["id2"]);
    expect(() =>
      applyOperation(searched, {
        op: "addIndex",
        table: "tasks",
        fields: ["title"],
        search: true,
      })
    ).toThrow(/search index already/u);
    const sensitive = applyOperation(tasks(), {
      op: "setAccess",
      table: "tasks",
      access: { read: "owner", write: "owner" },
      sensitive: true,
    });
    // Access set again without `sensitive` keeps it; `false` is refused.
    const reset = applyOperation(sensitive, {
      op: "setAccess",
      table: "tasks",
      access: { read: "appMembers", write: "appMembers" },
    });
    expect(reset.tables[0]?.sensitive).toBeTruthy();
    expect(() =>
      applyOperation(sensitive, {
        op: "setAccess",
        table: "tasks",
        access: { read: "owner", write: "owner" },
        sensitive: false,
      })
    ).toThrow(/stays so/u);
  });

  test("keep a field's answer when it is renamed, as it fills the same records by the field's ID", () => {
    const answered = applyOperation(tasks(), {
      op: "addField",
      table: "tasks",
      name: "priority",
      type: 'v.enum(["low", "high"])',
      answer: "low",
    });
    const renamed = applyOperation(answered, {
      op: "renameField",
      table: "tasks",
      field: "priority",
      name: "urgency",
    });
    expect(renamed.answers).toStrictEqual(answered.answers);
  });

  test("keep an answer for the records a required field is added to", () => {
    const after = applyOperation(tasks(), {
      op: "addField",
      table: "tasks",
      name: "priority",
      type: 'v.enum(["low", "high"])',
      answer: "low",
    });
    const priority = after.tables[0]?.fields.find(
      ({ name }) => name === "priority"
    );
    expect(after.answers).toStrictEqual([
      { table: "id1", field: priority?.id, value: "low" },
    ]);
    expect(definitionManifest(after).answers).toStrictEqual([
      { table: "tasks", field: "priority", value: "low" },
    ]);
  });
});

describe("generated code", () => {
  test("declares the type each field was given, exactly", () => {
    const types = [
      v.string().trim().email().min(3).max(320).nullable().default(null),
      v.number().integer().min(-5).max(10).optional(),
      v.enum(["a", "b"]),
      v.literal(null),
      v
        .array(v.object({ "odd key": v.id("tasks", { onDelete: "cascade" }) }))
        .max(3),
      v.union(v.string(), v.money()),
      v.record(v.timestamp()),
      v
        .object({ nested: v.boolean().default(true) })
        .default({ nested: false }),
    ];
    for (const type of types) {
      const source = validatorSource(descriptorOf(type));
      expect(descriptorOf(evaluateExpression(source, { v }))).toStrictEqual(
        descriptorOf(type)
      );
    }
  });
});

describe("reading", () => {
  test("reads back what it wrote", () => {
    const definition = tasks();
    expect(readDefinition(definitionText(definition))).toStrictEqual(
      definition
    );
  });

  test("refuses a definition that isn't one", () => {
    const text = definitionText(tasks());
    const refused = [
      "not json",
      JSON.stringify({ ...tasks(), extra: 1 }),
      text.replace('"id3"', '"id2"'),
      text.replace(
        '"fields": [\n            "id2"',
        '"fields": [\n            "id9"'
      ),
      JSON.stringify({
        ...tasks(),
        permissions: [
          { "~permission": "ai", alias: "ai", maxOutputTokens: -1 },
        ],
      }),
    ];
    for (const input of refused) {
      expect(() => readDefinition(input)).toThrow(/./u);
    }
    expect(() => readDefinition("not json")).toThrow(AppDefinitionError);
    // Two fields of one table named alike, each with an ID of its own.
    const twice = text.replace('"name": "done"', '"name": "title"');
    expect(twice).not.toBe(text);
    expect(() => readDefinition(twice)).toThrow(AppDefinitionError);
    expect(() => readDefinition(twice)).toThrow(/named `title`/u);
  });
});

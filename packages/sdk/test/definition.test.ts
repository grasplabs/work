import { describe, expect, test } from "vite-plus/test";

import { AppDefinitionError } from "../src/app.ts";
import { evaluateExpression } from "../src/definition-expression.ts";
import { applyOperation } from "../src/definition-operations.ts";
import type { DefinitionOperation } from "../src/definition-operations.ts";
import {
  configSource,
  schemaSource,
  validatorSource,
} from "../src/definition-source.ts";
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
// through core (apps/core/test/agent-definition.test.ts).

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
    ];
    for (const [operation, message] of refusals) {
      expect(() => applyOperation(before, operation)).toThrow(message);
    }
    expect(tasks()).toStrictEqual(before);
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

  test("writes the config and the schema the definition declares", () => {
    const definition = applyOperation(
      applyOperation(
        applyOperation(tasks(), {
          op: "setAccess",
          table: "tasks",
          access: {
            read: "appMembers",
            write: "appMembers",
            rows: {
              read: [{ kind: "owner" }, { kind: "person", field: "owner" }],
            },
          },
        }),
        {
          op: "addPermission",
          permission: "permission.ai({ maxOutputTokens: 500 })",
        }
      ),
      { op: "addPermission", permission: "people" }
    );
    const schema = schemaSource(definition);
    expect(schema).toContain(
      'import { defineSchema, defineTable, rows, v } from "@grasp-os/sdk";'
    );
    expect(schema).toContain("title: v.string().trim().min(1).max(200),");
    expect(schema).toContain('rows.person("owner")');
    const config = configSource(definition);
    expect(config).toContain(
      "export const permissions = {\n  ai: permission.ai({\n    maxOutputTokens: 500\n  })\n};"
    );
    expect(config).toContain(
      "permissions: {\n    ai: permissions.ai,\n    people: true\n  }"
    );
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
  });
});

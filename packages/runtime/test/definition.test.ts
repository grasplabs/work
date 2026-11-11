import { describe, expect, test } from "vite-plus/test";

import { AppDefinitionError } from "../src/app-definition-error.ts";
import { evaluateExpression } from "../src/definition-expression.ts";
import {
  applyOperation,
  withExportedFunctions,
} from "../src/definition-operations.ts";
import type { DefinitionOperation } from "../src/definition-operations.ts";
import {
  definitionSources,
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
import { expressionMaxDepth } from "../src/oxc-parse.ts";
import { isWorkflowPermission } from "../src/permission-checks.ts";
import { permission } from "../src/permission.ts";
import { descriptorOf } from "../src/sealed-descriptors.ts";
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

/** The names of the first table's fields. */
const fieldNames = (definition: AppDefinition) =>
  definition.tables[0]?.fields.map(({ name }) => name);

/** `definition` as Grasp stores it: its text's JSON, compact descriptors. */
const stored = (definition: AppDefinition): Record<string, unknown> =>
  // SAFETY: a definition's text is a JSON object.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  JSON.parse(definitionText(definition)) as Record<string, unknown>;

/** `operations` applied in order to an empty App's definition. */
const defined = (...operations: DefinitionOperation[]): AppDefinition => {
  const newId = counter();
  let definition = emptyDefinition("Tasks");
  for (const operation of operations) {
    definition = applyOperation(definition, operation, newId);
  }
  return definition;
};

/**
 * A field of `tasks` typed `v.string()` cast `casts` times: three nodes
 * deep (a call, its method, `v`), each `as` one more. A chain oxc parses
 * without recursion, which the evaluator reads with it.
 */
const typed = (casts: number): DefinitionOperation => ({
  op: "addField",
  table: "tasks",
  name: "x",
  type: `v.string()${" as never".repeat(casts)}`,
});

/**
 * A field of `tasks` typed as objects nested `levels` deep, each with two
 * modifiers: seven nodes a level.
 */
const nested = (levels: number): DefinitionOperation => ({
  op: "addField",
  table: "tasks",
  name: "x",
  type: `${"v.object({ a: ".repeat(levels)}v.string()${" }).optional().nullable()".repeat(levels)}`,
});

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
      // Nested too deep to read, under the length an expression may be.
      [
        {
          op: "addField",
          table: "tasks",
          name: "x",
          type: `${"1+".repeat(3000)}1`,
        },
        /isn't one expression/u,
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
      // A workflow's events, listens and decisions come from the version
      // bound (`setWorkflowContract`), never written with it by hand.
      [
        {
          op: "addPermission",
          permission:
            'permission.workflow("triage", { args: v.object({}), returns: v.null(), events: { edited: { type: "tasks.task.edited", data: v.null() } } })',
        },
        /come from the version you bind/u,
      ],
      [
        {
          op: "addPermission",
          permission:
            'permission.workflow("triage", { args: v.object({}), returns: v.null(), decisions: { sign: { value: v.boolean(), context: v.null() } } })',
        },
        /come from the version you bind/u,
      ],
      // A workflow's events, listens and decisions are set on a workflow
      // the App declares, never declaring one.
      [
        {
          op: "setWorkflowContract",
          alias: "triage",
          contract: { events: {}, listens: {}, decisions: {} },
        },
        /declares no workflow `triage`/u,
      ],
    ];
    for (const [operation, message] of refusals) {
      expect(() => applyOperation(before, operation)).toThrow(message);
    }
    expect(tasks()).toStrictEqual(before);
  });

  test("read a type nested as deep as an expression may be, and refuse one level more", () => {
    const atLimit = expressionMaxDepth - 3;
    expect(fieldNames(applyOperation(tasks(), typed(atLimit)))).toStrictEqual([
      "title",
      "done",
      "owner",
      "x",
    ]);
    expect(() => applyOperation(tasks(), typed(atLimit + 1))).toThrow(
      `That isn't one expression: It nests more than ${expressionMaxDepth} levels deep.`
    );
  });

  test("read a type nested as deep as a schema may be, with two modifiers at every level", () => {
    expect(fieldNames(applyOperation(tasks(), nested(30)))).toStrictEqual([
      "title",
      "done",
      "owner",
      "x",
    ]);
    // One level more is past what a schema may nest, not an expression.
    expect(() => applyOperation(tasks(), nested(31))).toThrow(
      /schema nests too deep/u
    );
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

  test("remove a field, an index, a table and a permission, with their answers", () => {
    const answered = applyOperation(
      applyOperation(tasks(), {
        op: "addField",
        table: "tasks",
        name: "priority",
        type: 'v.enum(["low", "high"])',
        answer: "low",
      }),
      { op: "addPermission", permission: "people" }
    );
    const fieldless = applyOperation(answered, {
      op: "removeField",
      table: "tasks",
      field: "priority",
    });
    const indexless = applyOperation(fieldless, {
      op: "removeIndex",
      table: "tasks",
      name: "by_title",
    });
    const tableless = applyOperation(answered, {
      op: "removeTable",
      table: "tasks",
    });
    expect({
      fields: fieldNames(fieldless),
      answers: fieldless.answers,
      indexes: indexless.tables[0]?.indexes,
      // Nothing reads `title` once its index is gone, so it goes too.
      untitled: fieldNames(
        applyOperation(indexless, {
          op: "removeField",
          table: "tasks",
          field: "title",
        })
      ),
      permissions: applyOperation(indexless, {
        op: "removePermission",
        alias: "people",
      }).permissions,
      tables: tableless.tables,
      tableAnswers: tableless.answers,
    }).toStrictEqual({
      fields: ["title", "done", "owner"],
      answers: [],
      indexes: [],
      untitled: ["done", "owner"],
      permissions: [],
      tables: [],
      tableAnswers: [],
    });
  });

  test("regenerate the config of an App that reads people, however its definition holds the permission", () => {
    const withPeople = (people: object) =>
      readDefinition({ ...stored(tasks()), permissions: [people] });
    const configs = [
      // As `addPermission` writes it, and as a definition may hold it.
      withPeople({ "~permission": "people", alias: "people" }),
      withPeople({ "~permission": "people" }),
    ].map((definition) => definitionSources(definition)["grasp.config.ts"]);
    expect(
      configs.map((config) => config?.includes("people: true"))
    ).toStrictEqual([true, true]);
  });

  test("refuse a removal that would leave something pointing at nothing", () => {
    const linked = applyOperation(
      applyOperation(
        applyOperation(tasks(), {
          op: "addIndex",
          table: "tasks",
          fields: ["title"],
          search: true,
        }),
        {
          op: "setAccess",
          table: "tasks",
          access: {
            read: "appMembers",
            write: "appMembers",
            rows: { read: [{ kind: "person", field: "owner" }] },
          },
        }
      ),
      {
        op: "addTable",
        name: "notes",
        fields: { task: 'v.id("tasks")' },
      }
    );
    const unsearched = applyOperation(linked, {
      op: "removeIndex",
      table: "tasks",
      search: true,
    });
    const refusals: [AppDefinition, DefinitionOperation, RegExp][] = [
      [
        linked,
        { op: "removeField", table: "tasks", field: "title" },
        /the index `by_title`, the search index: remove or change them first/u,
      ],
      [
        linked,
        { op: "removeField", table: "tasks", field: "owner" },
        /a row rule/u,
      ],
      [
        linked,
        { op: "removeField", table: "tasks", field: "nope" },
        /no field/u,
      ],
      // `notes.task` links to it.
      [linked, { op: "removeTable", table: "tasks" }, /`tasks`/u],
      [linked, { op: "removeTable", table: "nope" }, /no table `nope`/u],
      [
        linked,
        { op: "removeIndex", table: "tasks", name: "nope" },
        /no index/u,
      ],
      [linked, { op: "removePermission", alias: "nope" }, /no permission/u],
      [
        unsearched,
        { op: "removeIndex", table: "tasks", search: true },
        /no search index/u,
      ],
    ];
    for (const [definition, operation, message] of refusals) {
      expect(() => applyOperation(definition, operation)).toThrow(message);
    }
    expect(unsearched.tables[0]?.searchIndex).toBeUndefined();
  });

  test("move a field to its place, keeping its ID, and refuse a place its table hasn't", () => {
    const moved = applyOperation(tasks(), {
      op: "moveField",
      table: "tasks",
      field: "owner",
      to: 0,
    });
    expect(
      moved.tables[0]?.fields.map(({ id, name }) => [id, name])
    ).toStrictEqual([
      ["id4", "owner"],
      ["id2", "title"],
      ["id3", "done"],
    ]);
    expect(() =>
      applyOperation(tasks(), {
        op: "moveField",
        table: "tasks",
        field: "owner",
        to: 3,
      })
    ).toThrow(/from 0 to 2/u);
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

/**
 * What the `permission.workflow(...)` call in `definition`'s
 * grasp.config.ts declares, evaluated as the builders evaluate code.
 */
const configured = (definition: AppDefinition) => {
  const config = definitionSources(definition)["grasp.config.ts"] ?? "";
  const start = config.indexOf("permission.workflow(");
  let depth = 0;
  let end = start;
  for (let index = start; index < config.length; index += 1) {
    depth += config[index] === "(" ? 1 : 0;
    depth -= config[index] === ")" ? 1 : 0;
    if (depth === 0 && config[index] === ")") {
      end = index + 1;
      break;
    }
  }
  const declared = evaluateExpression(config.slice(start, end), {
    permission,
    v,
  });
  return isWorkflowPermission(declared)
    ? {
        alias: declared.alias,
        events: declared.events,
        listens: declared.listens,
        decisions: declared.decisions,
      }
    : undefined;
};

describe("a workflow's contract", () => {
  const triage = () =>
    defined(
      {
        op: "addPermission",
        permission:
          'permission.workflow("triage", { args: v.object({ title: v.string() }), returns: v.null() })',
      },
      { op: "addPermission", permission: "people" }
    );
  const title = descriptorOf(v.object({ title: v.string().max(200) }));
  const contract = {
    events: {
      edited: { type: "tasks.task.edited", data: title },
      approved: { type: "tasks.task.approved", data: descriptorOf(v.null()) },
    },
    listens: { "do/1/wait": ["edited", "approved"] },
    decisions: {
      sign: { value: descriptorOf(v.boolean()), context: title },
    },
  };

  test("is set on a declared workflow, read back from its text, and declared in grasp.config.ts", () => {
    const definition = applyOperation(triage(), {
      op: "setWorkflowContract",
      alias: "triage",
      contract,
    });
    const readBack = readDefinition(JSON.parse(definitionText(definition)));
    const declared = definitionManifest(readBack).permissions.triage;
    // As `permission.workflow` declares it: each listen's events in name order.
    const expected = {
      events: contract.events,
      listens: { "do/1/wait": ["approved", "edited"] },
      decisions: contract.decisions,
    };
    expect({
      readBack: definitionText(readBack) === definitionText(definition),
      sources:
        JSON.stringify(definitionSources(readBack)) ===
        JSON.stringify(definitionSources(definition)),
      declared:
        declared?.["~permission"] === "workflows"
          ? {
              events: declared.events,
              listens: declared.listens,
              decisions: declared.decisions,
            }
          : undefined,
      configured: configured(definition),
    }).toStrictEqual({
      readBack: true,
      sources: true,
      declared: expected,
      configured: { alias: "triage", ...expected },
    });
    // Set again with none, its code declares none.
    const cleared = applyOperation(definition, {
      op: "setWorkflowContract",
      alias: "triage",
      contract: { events: {}, listens: {}, decisions: {} },
    });
    expect(configured(cleared)).toStrictEqual({
      alias: "triage",
      events: {},
      listens: {},
      decisions: {},
    });
  });

  test.each<[string, string, Record<string, unknown>, RegExp]>([
    [
      "another kind's permission",
      "people",
      contract,
      /declares no workflow `people`/u,
    ],
    ["an inherited key", "constructor", contract, /declares no workflow/u],
    [
      "a listen naming an event it doesn't declare",
      "triage",
      { ...contract, listens: { "do/1/wait": ["uploaded"] } },
      /listens for events the workflow declares/u,
    ],
    [
      "an event type that isn't one",
      "triage",
      {
        ...contract,
        events: { ...contract.events, edited: { type: "", data: title } },
      },
      /type is 1 to/u,
    ],
    [
      "an event alias that isn't plain",
      "triage",
      {
        events: { "task edited": contract.events.edited },
        listens: {},
        decisions: {},
      },
      /isn't an event's or a decision's alias/u,
    ],
    [
      "a decision's own value schema",
      "triage",
      {
        ...contract,
        decisions: {
          sign: { ...contract.decisions.sign, valueSchema: title },
        },
      },
      /has no `valueSchema`/u,
    ],
    [
      "a descriptor that doesn't read",
      "triage",
      {
        ...contract,
        decisions: {
          sign: { value: { kind: "script" }, context: title },
        },
      },
      /./u,
    ],
  ])("refuses %s, changing nothing", (_case, alias, given, message) => {
    const before = triage();
    expect(() =>
      applyOperation(before, {
        op: "setWorkflowContract",
        alias,
        // SAFETY: deliberately ill-formed contracts, as a tool might send.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        contract: given as never,
      })
    ).toThrow(message);
    expect(definitionText(before)).toBe(definitionText(triage()));
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

/** `value` with every object's keys in reverse order, all the way down. */
const reversed = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(reversed);
  }
  return typeof value === "object" && value !== null
    ? Object.fromEntries(
        Object.entries(value)
          .toReversed()
          .map(([key, item]) => [key, reversed(item)])
      )
    : value;
};

describe("reading", () => {
  test("reads back what it stores, as the same text whatever the key order", () => {
    const definition = tasks();
    const text = definitionText(definition);
    expect(readDefinition(JSON.parse(text))).toStrictEqual(definition);
    const reordered = Object.fromEntries(
      Object.entries(stored(definition)).toReversed()
    );
    expect(definitionText(readDefinition(reordered))).toBe(text);
  });

  test("gives equal definitions one text whatever order their records' keys came in, and keeps an object type's fields in their declared order", () => {
    const definition = defined(
      {
        op: "addTable",
        name: "orders",
        fields: {
          shipping: "v.object({ street: v.string(), city: v.string() })",
        },
        access: { read: "appMembers", write: "appMembers" },
      },
      {
        op: "addPermission",
        permission:
          'permission.workflow("triage", { args: v.object({ title: v.string(), body: v.string() }), returns: v.null() })',
      }
    );
    // Every key reversed, an object type's fields too: another type.
    const shuffled = readDefinition(reversed(stored(definition)));
    const text = definitionText(definition);
    expect({
      permissions: definitionText({
        ...definition,
        permissions: definition.permissions.map((held) =>
          Object.fromEntries(Object.entries(held).toReversed())
        ),
      }),
      fields: text.indexOf('"street"') < text.indexOf('"city"'),
      reorderedType: definitionText(shuffled) === text,
    }).toStrictEqual({ permissions: text, fields: true, reorderedType: false });
  });

  test("generates the same code from a definition as from its stored text read back, an object default's keys whatever their order", () => {
    const definition = defined({
      op: "addTable",
      name: "places",
      fields: {
        address:
          'v.object({ street: v.string(), city: v.string() }).default({ street: "Main", city: "Utrecht" })',
      },
      access: { read: "appMembers", write: "appMembers" },
    });
    const readBack = readDefinition(JSON.parse(definitionText(definition)));
    expect(definitionSources(readBack)).toStrictEqual(
      definitionSources(definition)
    );
  });

  test("refuses a definition over its size before reading any of it", () => {
    expect(() =>
      readDefinition({ ...stored(tasks()), name: "x".repeat(1024 * 1024) })
    ).toThrow(/at most/u);
  });

  test("holds every type in its compact form, and says which one it can't read", () => {
    const text = definitionText(tasks());

    expect(text).toContain('"type":{"default":false,"kind":"boolean"}');
    expect(() =>
      readDefinition(
        JSON.parse(
          text.replace('"kind":"boolean"', '"kind":"boolean","nullable":false')
        )
      )
    ).toThrow(/`tasks\.done`/u);
  });

  test("refuses a definition that isn't one", () => {
    const text = definitionText(tasks());
    const refused = [
      "not a definition",
      { ...stored(tasks()), extra: 1 },
      JSON.parse(text.replace('"id3"', '"id2"')),
      JSON.parse(text.replace('"fields":["id2"]', '"fields":["id9"]')),
      {
        ...stored(tasks()),
        permissions: [
          { "~permission": "ai", alias: "ai", maxOutputTokens: -1 },
        ],
      },
    ];
    for (const input of refused) {
      expect(() => readDefinition(input)).toThrow(/./u);
    }
    expect(() => readDefinition("not a definition")).toThrow(
      AppDefinitionError
    );
    // Two fields of one table named alike, each with an ID of its own.
    const twice = text.replace('"name":"done"', '"name":"title"');
    expect(twice).not.toBe(text);
    expect(() => readDefinition(JSON.parse(twice))).toThrow(AppDefinitionError);
    expect(() => readDefinition(JSON.parse(twice))).toThrow(/named `title`/u);
  });
});

describe("functions", () => {
  /** IDs counted up across one test's commits. */
  let newId = counter();

  /** The definition `exported` gives IDs, over `previous`. */
  const exporting = (
    exported: string[],
    {
      definition = emptyDefinition("Tasks"),
      previous = [],
    }: { definition?: AppDefinition; previous?: AppDefinition[] } = {}
  ) => withExportedFunctions(definition, previous, exported, newId);

  test("give each exported function an ID, which the next commit keeps and a function gone loses", () => {
    newId = counter();
    const first = exporting(["tasks.create", "tasks.list"]);
    const next = exporting(["tasks.create", "tasks.done"], {
      previous: [first],
    });

    expect({ first: first.functions, next: next.functions }).toStrictEqual({
      first: [
        { id: "id1", name: "tasks.create" },
        { id: "id2", name: "tasks.list" },
      ],
      next: [
        { id: "id1", name: "tasks.create" },
        { id: "id3", name: "tasks.done" },
      ],
    });
    // No code is generated from them: the IDs stay in the definition.
    expect(definitionSources(next)).toStrictEqual(
      definitionSources(emptyDefinition("Tasks"))
    );
  });

  test("keep a function's ID through a rename it says, and give the function at its old path a new one", () => {
    newId = counter();
    const first = exporting(["tasks.create"]);
    const renamed = applyOperation(first, {
      op: "renameFunction",
      function: "tasks.create",
      name: "tasks.add",
    });

    const next = exporting(["tasks.add", "tasks.create"], {
      definition: renamed,
      previous: [first],
    });

    expect(next.functions?.find(({ name }) => name === "tasks.add")?.id).toBe(
      "id1"
    );
    expect(
      next.functions?.find(({ name }) => name === "tasks.create")?.id
    ).not.toBe("id1");
  });

  test("give a function back the ID an older version gave it, past a commit that left it out", () => {
    newId = counter();
    const live = exporting(["tasks.create"]);
    const dropped = exporting([], { previous: [live] });

    const back = exporting(["tasks.create"], { previous: [dropped, live] });

    expect(back.functions).toStrictEqual([{ id: "id1", name: "tasks.create" }]);
  });

  test("keep the text of a definition that gives no function an ID", () => {
    newId = counter();
    const none = exporting([]);
    const one = exporting(["a.b"]);

    expect(definitionText(none)).toBe(definitionText(emptyDefinition("Tasks")));
    expect(stored(none)).not.toHaveProperty("functions");
    expect(readDefinition(stored(one))).toStrictEqual(one);
  });

  test("refuse a rename to a path that isn't one, one held already, or of a function with no ID", () => {
    newId = counter();
    const before = exporting(["tasks.create", "tasks.list"]);
    const refusals: [DefinitionOperation, RegExp][] = [
      [
        { op: "renameFunction", function: "tasks.create", name: "tasks.list" },
        /already/u,
      ],
      [
        { op: "renameFunction", function: "tasks.create", name: "create" },
        /path/u,
      ],
      [
        {
          op: "renameFunction",
          function: "tasks.create",
          name: "__proto__.create",
        },
        /path/u,
      ],
      [
        {
          op: "renameFunction",
          function: "tasks.create",
          name: "tasks.__proto__",
        },
        /path/u,
      ],
      [
        { op: "renameFunction", function: "tasks.gone", name: "tasks.all" },
        /no function `tasks\.gone`/u,
      ],
    ];
    for (const [operation, problem] of refusals) {
      expect(() => applyOperation(before, operation)).toThrow(problem);
    }
  });

  test("refuse a definition giving two functions one ID or one path, or a path that isn't one", () => {
    newId = counter();
    const text = definitionText(exporting(["tasks.create", "tasks.list"]));
    const sameId = text.replace('"id":"id2"', '"id":"id1"');
    const samePath = text.replace('"tasks.list"', '"tasks.create"');
    const protoPath = text.replace('"tasks.list"', '"__proto__.list"');

    expect(sameId).not.toBe(text);
    expect(() => readDefinition(JSON.parse(sameId))).toThrow(/ID `id1`/u);
    expect(() => readDefinition(JSON.parse(samePath))).toThrow(
      /named `tasks\.create`/u
    );
    expect(() => readDefinition(JSON.parse(protoPath))).toThrow(
      AppDefinitionError
    );
  });
});

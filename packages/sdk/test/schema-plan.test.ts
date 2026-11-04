import { describe, expect, test } from "vite-plus/test";

import {
  manifestText,
  planSchemaChange,
  readSchemaManifest,
  schemaCovered,
  schemaManifest,
} from "../src/host.ts";
import type { SchemaAccess, SchemaManifest, SchemaPlan } from "../src/host.ts";
import { defineSchema, defineTable, rows, v } from "../src/values.ts";
import type { ValueShape } from "../src/values.ts";

// How a store's data contract changes when it is handed a schema: which
// changes apply on their own, which the store checks every record for as
// their release is made current, and which need a migration (spec 17.1,
// 17.4). Pure, so unit tests; the store applying a plan is tested through
// the store (apps/core/test/schema-contract.test.ts).

const ownerOnly: SchemaAccess = {
  tables: { notes: { read: "owner", write: "owner" } },
};

const noteFields = {
  title: v.string().min(1).max(200),
  archivedAt: v.timestamp().optional(),
};

const titleIndex: Record<string, string[]> = { by_title: ["title"] };

/** A Notes schema with `fields`, its indexes and `access`. */
const notes = (
  fields: ValueShape,
  indexes: Record<string, string[]> = titleIndex,
  access: SchemaAccess = ownerOnly
): SchemaManifest => {
  const base = schemaManifest(
    defineSchema({ notes: defineTable(fields) }),
    access
  );
  // Indexes as data, read back through the host's checks.
  return readSchemaManifest(
    JSON.stringify({
      ...base,
      tables: {
        notes: {
          ...base.tables.notes,
          indexes: Object.fromEntries(
            Object.entries(indexes).map(([name, on]) => [name, { fields: on }])
          ),
        },
      },
    })
  ).manifest;
};

const v1 = notes(noteFields);

/** The plan's contract, or a failed test. */
const contractOf = (plan: SchemaPlan): SchemaManifest => {
  if (!plan.accepted) {
    throw new Error(`Refused: ${JSON.stringify(plan.refused)}`);
  }
  return plan.contract;
};

/** The plan's checks, each with its answer, or a failed test. */
const checksOf = (plan: SchemaPlan) => {
  contractOf(plan);
  return plan.checks.map(({ table, field, answer }) => ({
    table,
    field,
    answer,
  }));
};

/** The plan's refusals, or a failed test. */
const refusedOf = (plan: SchemaPlan) => {
  if (plan.accepted) {
    throw new Error("Accepted");
  }
  return plan.refused;
};

/** JSON text of `value` with every object's keys in reverse order. */
const reversedText = (value: unknown): string =>
  JSON.stringify(value, (_key, part: unknown) =>
    typeof part === "object" && part !== null && !Array.isArray(part)
      ? Object.fromEntries(Object.entries(part).toReversed())
      : part
  );

/** Notes whose `parent` is a reference to `target`, or a plain string. */
const linked = (target: "notes" | "tags", asId: boolean): SchemaManifest =>
  schemaManifest(
    defineSchema({
      notes: defineTable({
        title: v.string(),
        parent: asId ? v.id(target).optional() : v.string().optional(),
      }),
      tags: defineTable({ name: v.string() }),
    }),
    {
      tables: {
        notes: { read: "owner", write: "owner" },
        tags: { read: "owner", write: "owner" },
      },
    }
  );

/** Notes with `fields` besides a title, beside a Tags table. */
const linkedNotes = (fields: ValueShape): SchemaManifest =>
  schemaManifest(
    defineSchema({
      notes: defineTable({ title: v.string(), ...fields }),
      tags: defineTable({ name: v.string() }),
    }),
    {
      tables: {
        notes: { read: "owner", write: "owner" },
        tags: { read: "owner", write: "owner" },
      },
    }
  );

const tableNames = (prefix: string): string[] =>
  Array.from({ length: 40 }, (_, index) => `${prefix}${index}`);
const many = (names: string[]): SchemaManifest =>
  schemaManifest(
    defineSchema(
      Object.fromEntries(
        names.map((name) => [name, defineTable({ name: v.string() })])
      )
    )
  );

describe("a store's first schema", () => {
  test("becomes its contract whole", () => {
    const plan = planSchemaChange(null, v1);
    expect(manifestText(contractOf(plan))).toBe(manifestText(v1));
    expect(plan).toMatchObject({
      changed: true,
      addedTables: ["notes"],
      addedFields: [],
      retainedTables: [],
    });
  });
});

describe("safe changes", () => {
  test("the same schema, its keys in another order, changes nothing", () => {
    const reread = readSchemaManifest(reversedText(v1)).manifest;
    const plan = planSchemaChange(v1, reread);
    expect(plan).toMatchObject({
      accepted: true,
      changed: false,
      addedTables: [],
      addedFields: [],
      addedIndexes: [],
    });
    expect(manifestText(contractOf(plan))).toBe(manifestText(v1));
  });

  test("an optional field is added to the contract", () => {
    const v2 = notes({ ...noteFields, category: v.string().optional() });
    const plan = planSchemaChange(v1, v2);
    expect(plan).toMatchObject({
      changed: true,
      addedFields: [{ table: "notes", field: "category" }],
    });
    expect(manifestText(contractOf(plan))).toBe(manifestText(v2));
  });

  test("a defaulted field left out stays in the contract: the store fills it in", () => {
    const v2 = notes({
      ...noteFields,
      category: v.string().default("general"),
    });
    const contract = contractOf(planSchemaChange(v1, v2));
    expect(planSchemaChange(contract, v1)).toMatchObject({
      accepted: true,
      changed: false,
      retainedFields: [{ table: "notes", field: "category" }],
    });
  });

  test("a defaulted field is added to the contract, to be filled in first", () => {
    const v2 = notes({
      ...noteFields,
      category: v.string().default("general"),
      archived: v.boolean().nullable().default(null),
    });
    const plan = planSchemaChange(v1, v2);
    expect(plan).toMatchObject({
      accepted: true,
      changed: true,
      addedFields: [
        { table: "notes", field: "archived" },
        { table: "notes", field: "category" },
      ],
      filledFields: [
        { table: "notes", field: "archived" },
        { table: "notes", field: "category" },
      ],
    });
    expect(manifestText(contractOf(plan))).toBe(manifestText(v2));
    // Applied: the contract has it, so nothing is left to fill.
    expect(planSchemaChange(contractOf(plan), v2)).toMatchObject({
      changed: false,
      filledFields: [],
    });
  });

  test("a new table's defaulted fields fill nothing: it holds no records", () => {
    const v2 = schemaManifest(
      defineSchema({
        notes: defineTable(noteFields).index("by_title", ["title"]),
        tags: defineTable({ weight: v.number().default(1) }),
      }),
      { tables: { ...ownerOnly.tables, tags: { read: "owner" } } }
    );
    expect(planSchemaChange(v1, v2)).toMatchObject({
      accepted: true,
      addedTables: ["tags"],
      filledFields: [],
    });
  });

  test("a new table may have required fields: it holds no records", () => {
    const v2 = schemaManifest(
      defineSchema({
        notes: defineTable(noteFields).index("by_title", ["title"]),
        tags: defineTable({ name: v.string(), weight: v.number().default(1) }),
      }),
      { tables: { ...ownerOnly.tables, tags: { read: "owner" } } }
    );
    const plan = planSchemaChange(v1, v2);
    expect(plan).toMatchObject({ addedTables: ["tags"] });
    expect(Object.keys(contractOf(plan).tables)).toStrictEqual([
      "notes",
      "tags",
    ]);
  });

  test("an index added or redefined installs beside the one it replaces", () => {
    const v2 = notes(noteFields, {
      by_title: ["title", "_createdAt"],
      by_archived: ["archivedAt"],
    });
    const plan = planSchemaChange(v1, v2);
    expect(plan).toMatchObject({
      addedIndexes: [
        { table: "notes", index: "by_archived" },
        { table: "notes", index: "by_title" },
      ],
      retainedIndexes: [{ table: "notes", index: "by_title" }],
    });
    expect(contractOf(plan).tables.notes?.indexes).toStrictEqual(
      v2.tables.notes?.indexes
    );
  });

  test("an optional field or a table left out stays in the contract", () => {
    const v2 = schemaManifest(
      defineSchema({
        notes: defineTable(noteFields).index("by_title", ["title"]),
        tags: defineTable({ name: v.string() }),
      }),
      { tables: { ...ownerOnly.tables, tags: { read: "owner" } } }
    );
    const contract = contractOf(planSchemaChange(v1, v2));
    const narrower = notes({ title: noteFields.title });
    const plan = planSchemaChange(contract, narrower);
    expect(plan).toMatchObject({
      accepted: true,
      changed: false,
      retainedTables: ["tags"],
      retainedFields: [{ table: "notes", field: "archivedAt" }],
    });
    expect(manifestText(contractOf(plan))).toBe(manifestText(contract));
  });

  test("an enum's members in another order are no change; a new one widens it", () => {
    const status = (values: [string, ...string[]]) =>
      notes({ ...noteFields, status: v.enum(values).optional() });
    const contract = contractOf(
      planSchemaChange(null, status(["open", "done"]))
    );
    const plan = planSchemaChange(contract, status(["done", "open"]));
    expect(plan).toMatchObject({ accepted: true, changed: false });
    expect(manifestText(contractOf(plan))).toBe(manifestText(contract));
    expect(
      planSchemaChange(contract, status(["done", "open", "late"]))
    ).toMatchObject({
      accepted: true,
      changed: true,
      activates: false,
      widenedFields: [{ table: "notes", field: "status" }],
      checks: [],
    });
  });

  test("an enum in a record's values, or in a field named `value`, may reorder too", () => {
    const nested = (values: [string, ...string[]]) =>
      notes({
        ...noteFields,
        tags: v.record(v.enum(values)).optional(),
        value: v.enum(values).optional(),
        detail: v.object({ value: v.enum(values) }).optional(),
      });
    const contract = contractOf(planSchemaChange(null, nested(["a", "b"])));
    expect(planSchemaChange(contract, nested(["b", "a"]))).toMatchObject({
      accepted: true,
      changed: false,
    });
    expect(
      checksOf(planSchemaChange(contract, nested(["a", "c"]))).map(
        ({ field }) => field
      )
    ).toStrictEqual(["detail", "tags", "value"]);
  });

  test("an older version is compatible with the contract it grew into", () => {
    const v2 = notes({ ...noteFields, category: v.string().optional() });
    const contract = contractOf(planSchemaChange(v1, v2));
    expect(planSchemaChange(contract, v1)).toMatchObject({
      accepted: true,
      changed: false,
    });
    expect(schemaCovered(contract, v1)).toBeTruthy();
  });

  test("a version that leaves out one addition and adds another keeps both", () => {
    const withCategory = notes({
      ...noteFields,
      category: v.string().optional(),
    });
    const withColour = notes({ ...noteFields, colour: v.string().optional() });
    const contract = contractOf(
      planSchemaChange(
        contractOf(planSchemaChange(v1, withCategory)),
        withColour
      )
    );
    expect(Object.keys(contract.tables.notes?.fields ?? {})).toStrictEqual([
      "archivedAt",
      "category",
      "colour",
      "title",
    ]);
  });
});

describe("a widening", () => {
  test("applies at once, every record fitting it, and the version before stays covered", () => {
    for (const title of [
      v.string().min(1).max(500),
      v.string().max(200),
      v.string().min(1).max(200).optional(),
      v.string().min(1).max(200).nullable(),
    ]) {
      const plan = planSchemaChange(v1, notes({ ...noteFields, title }));
      expect(plan).toMatchObject({
        accepted: true,
        changed: true,
        activates: false,
        widenedFields: [{ table: "notes", field: "title" }],
        checks: [],
      });
      // Every value version 1 writes, the widened contract takes.
      expect(schemaCovered(contractOf(plan), v1)).toBeTruthy();
    }
  });

  test("a required field left out stays in the contract as optional", () => {
    const plan = planSchemaChange(
      v1,
      notes({ archivedAt: noteFields.archivedAt }, {})
    );
    expect(plan).toMatchObject({
      accepted: true,
      activates: false,
      retainedFields: [{ table: "notes", field: "title" }],
    });
    expect(contractOf(plan).tables.notes?.fields.title).toMatchObject({
      kind: "string",
      presence: "optional",
    });
  });

  test("another default changes no record", () => {
    const status = (fallback: string) =>
      notes({
        ...noteFields,
        status: v.array(v.string()).default([fallback, "z"]),
      });
    expect(planSchemaChange(status("a"), status("b"))).toMatchObject({
      accepted: true,
      activates: false,
      widenedFields: [{ table: "notes", field: "status" }],
    });
  });
});

describe("a change the store checks every record for", () => {
  test("a narrowing, a type change or a field made required waits for activation", () => {
    for (const title of [
      v.number(),
      v.string().min(1).max(100),
      v.string().email(),
    ]) {
      const plan = planSchemaChange(v1, notes({ ...noteFields, title }));
      expect(plan).toMatchObject({ accepted: true, activates: true });
      expect(checksOf(plan)).toStrictEqual([
        { table: "notes", field: "title", answer: null },
      ]);
      // Version 1's writes may not fit the narrowed contract.
      expect(schemaCovered(contractOf(plan), v1)).toBeFalsy();
    }
    const required = planSchemaChange(
      v1,
      notes({ ...noteFields, archivedAt: v.timestamp() })
    );
    expect(checksOf(required)).toStrictEqual([
      { table: "notes", field: "archivedAt", answer: null },
    ]);
  });

  test("a required or nullable-only field added is checked: records must hold it", () => {
    const v2 = notes({
      ...noteFields,
      category: v.string().default("general"),
      priority: v.number(),
      summary: v.string().nullable(),
    });
    const plan = planSchemaChange(v1, v2);
    expect(plan).toMatchObject({
      accepted: true,
      activates: true,
      filledFields: [{ table: "notes", field: "category" }],
    });
    expect(checksOf(plan)).toStrictEqual([
      { table: "notes", field: "priority", answer: null },
      { table: "notes", field: "summary", answer: null },
    ]);
  });

  test("offers the answers that suit the change", () => {
    const status = (values: [string, ...string[]]) =>
      notes({ ...noteFields, status: v.enum(values) });
    const renamed = planSchemaChange(
      status(["todo", "done"]),
      status(["open", "done"])
    );
    const typed = planSchemaChange(
      notes({ ...noteFields, size: v.string() }),
      notes({ ...noteFields, size: v.number() })
    );
    const added = planSchemaChange(
      v1,
      notes({ ...noteFields, size: v.number() })
    );
    expect({
      renamed: renamed.checks.map(({ answers }) => answers),
      typed: typed.checks.map(({ answers }) => answers),
      added: added.checks.map(({ answers }) => answers),
    }).toStrictEqual({
      renamed: [["value", "field", "map"]],
      typed: [["value", "field", "convert"]],
      added: [["value", "field"]],
    });
  });

  test("carries the App's answer for the field, and ignores answers for other fields", () => {
    const status = (values: [string, ...string[]]) =>
      notes({ ...noteFields, status: v.enum(values) });
    const answer = {
      table: "notes",
      field: "status",
      kind: "map",
      values: { todo: "open" },
    } as const;
    const plan = planSchemaChange(
      status(["todo", "done"]),
      status(["open", "done"]),
      {
        answers: [
          answer,
          { table: "notes", field: "title", kind: "value", value: "x" },
        ],
      }
    );
    expect(checksOf(plan)).toStrictEqual([
      { table: "notes", field: "status", answer },
    ]);
  });

  test("a changed access mode or row rule changes no record, and applies at activation", () => {
    const shared: SchemaAccess = {
      tables: { notes: { read: "appMembers", write: "appMembers" } },
    };
    const fields = { title: v.string(), team: v.string() };
    const plain = schemaManifest(
      defineSchema({ notes: defineTable(fields) }),
      shared
    );
    const byTeam = schemaManifest(
      defineSchema({
        notes: defineTable(fields).access({ read: [rows.team("team")] }),
      }),
      shared
    );
    const owned = schemaManifest(
      defineSchema({ notes: defineTable(fields) }),
      ownerOnly
    );
    for (const [before, after] of [
      [plain, byTeam],
      [byTeam, plain],
      [plain, owned],
      [owned, plain],
    ] as const) {
      const plan = planSchemaChange(before, after);
      expect(plan).toMatchObject({
        accepted: true,
        activates: true,
        ruleChanges: ["notes"],
        checks: [],
      });
      expect(contractOf(plan).tables.notes?.access).toStrictEqual(
        after.tables.notes?.access
      );
      expect(contractOf(plan).tables.notes?.rules).toStrictEqual(
        after.tables.notes?.rules
      );
      // The data is the same: either version's writes fit.
      expect(schemaCovered(contractOf(plan), before)).toBeTruthy();
    }
  });

  test("a rename takes the old field's value, and keeps the old field", () => {
    const before = notes({ ...noteFields, body: v.string() });
    const after = notes({ ...noteFields, text: v.string() });
    const renames = [{ table: "notes", from: "body", to: "text" }];
    const plan = planSchemaChange(before, after, { renames });
    expect(plan).toMatchObject({
      accepted: true,
      activates: true,
      renames,
      retainedFields: [{ table: "notes", field: "body" }],
    });
    expect(checksOf(plan)).toStrictEqual([
      {
        table: "notes",
        field: "text",
        answer: { table: "notes", field: "text", kind: "field", from: "body" },
      },
    ]);
    expect(contractOf(plan).tables.notes?.fields.body?.presence).toBe(
      "optional"
    );
  });
});

describe("changes that need a migration", () => {
  test("a defaulted field that can hold a record ID, at any depth, is refused", () => {
    const before = linkedNotes({});
    const after = linkedNotes({
      tag: v.id("tags").nullable().default(null),
      tags: v.array(v.id("tags")).default([]),
      either: v.union(v.string(), v.id("tags")).default("none"),
      nested: v.object({ tag: v.id("tags").optional() }).default({}),
      label: v.string().default("none"),
    });
    const plan = planSchemaChange(before, after);
    expect(refusedOf(plan)).toStrictEqual([
      { table: "notes", field: "either", reason: "defaulted_reference_added" },
      { table: "notes", field: "nested", reason: "defaulted_reference_added" },
      { table: "notes", field: "tag", reason: "defaulted_reference_added" },
      { table: "notes", field: "tags", reason: "defaulted_reference_added" },
    ]);
    expect(plan.filledFields).toStrictEqual([
      { table: "notes", field: "label" },
    ]);
  });

  test("a required reference or file added is refused: the store's indexes would have to follow", () => {
    expect(
      refusedOf(
        planSchemaChange(linkedNotes({}), linkedNotes({ tag: v.id("tags") }))
      )
    ).toStrictEqual([
      { table: "notes", field: "tag", reason: "required_field_added" },
    ]);
    expect(
      refusedOf(planSchemaChange(v1, notes({ ...noteFields, scan: v.file() })))
    ).toStrictEqual([
      { table: "notes", field: "scan", reason: "required_field_added" },
    ]);
  });

  test("a field turned into a reference, or pointed at another table, is refused", () => {
    // Records written before hold no reference the store indexed, so a
    // record they name could be deleted under them (GRA-416's restrict).
    const refusal = [
      { table: "notes", field: "parent", reason: "field_changed" },
    ];
    expect(
      refusedOf(planSchemaChange(linked("notes", false), linked("notes", true)))
    ).toStrictEqual(refusal);
    expect(
      refusedOf(planSchemaChange(linked("notes", true), linked("tags", true)))
    ).toStrictEqual(refusal);
    expect(
      refusedOf(planSchemaChange(linked("notes", true), linked("notes", false)))
    ).toStrictEqual(refusal);
  });

  test("an answer or a rename that would rewrite a field a row rule reads is refused", () => {
    const shared: SchemaAccess = {
      tables: { notes: { read: "appMembers", write: "appMembers" } },
    };
    const ruled = (team: ReturnType<typeof v.string>, more: ValueShape = {}) =>
      schemaManifest(
        defineSchema({
          notes: defineTable({ title: v.string(), team, ...more }).access({
            read: [rows.team("team")],
          }),
        }),
        shared
      );
    const before = ruled(v.string());
    const after = ruled(v.string().max(10));
    // Checked, it rewrites nothing: who sees a record stays as it was.
    expect(planSchemaChange(before, after).accepted).toBeTruthy();
    expect(
      refusedOf(
        planSchemaChange(before, after, {
          answers: [
            { table: "notes", field: "team", kind: "value", value: "all" },
          ],
        })
      )
    ).toStrictEqual([
      { table: "notes", field: "team", reason: "rule_field_rewritten" },
    ]);
  });

  test("a field kept from an older version, coming back as another type, is checked", () => {
    const v2 = notes({ ...noteFields, category: v.string().optional() });
    const contract = contractOf(planSchemaChange(v1, v2));
    const v3 = notes({ ...noteFields, category: v.number().optional() });
    expect(checksOf(planSchemaChange(contract, v3))).toStrictEqual([
      { table: "notes", field: "category", answer: null },
    ]);
  });

  test("every refusal is listed, and a refused plan has no contract", () => {
    const v2 = linkedNotes({ tag: v.id("tags"), size: v.id("tags") });
    const plan = planSchemaChange(linkedNotes({ size: v.string() }), v2);
    expect(plan).not.toHaveProperty("contract");
    expect(refusedOf(plan).map(({ reason }) => reason)).toStrictEqual([
      "field_changed",
      "required_field_added",
    ]);
  });

  test("a union past a schema's limits is refused", () => {
    const contract = contractOf(planSchemaChange(null, many(tableNames("a"))));
    expect(
      refusedOf(planSchemaChange(contract, many(tableNames("b"))))
    ).toStrictEqual([{ table: "", reason: "contract_invalid" }]);
  });
});

/** What a store reserved of `manifest`: its tables' fields, as declared. */
const reservedOf = (manifest: SchemaManifest) =>
  Object.fromEntries(
    Object.entries(manifest.tables).map(([table, { fields }]) => [
      table,
      fields,
    ])
  );

describe("a field the store reserved", () => {
  const category = notes({
    ...noteFields,
    category: v.string().max(20).default("general"),
  });

  test("is added again as it was, and refused with any other descriptor", () => {
    const reserved = reservedOf(category);
    expect(planSchemaChange(v1, category, { reserved })).toMatchObject({
      accepted: true,
      filledFields: [{ table: "notes", field: "category" }],
    });
    // Another type, or the same type without its default: either way the
    // values a backfill filled in might not mean what the field says.
    for (const other of [
      v.number().optional(),
      v.string().max(20).optional(),
      v.string().max(20).default("news"),
    ]) {
      expect(
        refusedOf(
          planSchemaChange(v1, notes({ ...noteFields, category: other }), {
            reserved,
          })
        )
      ).toStrictEqual([
        { table: "notes", field: "category", reason: "reserved_field_changed" },
      ]);
    }
  });

  test("is refused with another descriptor on a table the schema adds", () => {
    const tags = (asNumber: boolean) =>
      schemaManifest(
        defineSchema({
          notes: defineTable(noteFields),
          tags: defineTable({ name: asNumber ? v.number() : v.string() }),
        }),
        {
          tables: {
            notes: { read: "owner", write: "owner" },
            tags: { read: "owner", write: "owner" },
          },
        }
      );
    const reserved = reservedOf(tags(false));
    expect(
      planSchemaChange(v1, tags(false), { reserved }).accepted
    ).toBeTruthy();
    expect(
      refusedOf(planSchemaChange(v1, tags(true), { reserved }))
    ).toStrictEqual([
      { table: "tags", field: "name", reason: "reserved_field_changed" },
    ]);
  });
});

describe("a table an explicit migration transforms", () => {
  const migrated = new Set(["notes"]);
  const target = notes({
    title: v.string().min(1).max(500),
    archivedAt: v.timestamp().optional(),
    category: v.enum(["launch", "general"]),
  });

  test("takes a required field and a changed one, with the target's descriptors, filling nothing", () => {
    // Unmigrated, its required field and narrowed title are checked.
    expect(planSchemaChange(v1, target)).toMatchObject({ activates: true });

    const plan = planSchemaChange(v1, target, { migrated });
    const contract = contractOf(plan);

    expect(plan).toMatchObject({
      accepted: true,
      migratedTables: ["notes"],
      addedFields: [{ table: "notes", field: "category" }],
      filledFields: [],
    });
    expect(manifestText(contract)).toBe(manifestText(target));
  });

  test("still refuses a reference added, values that can't overlap and a table on one side only", () => {
    const referring = notes({ ...noteFields, author: v.id("notes") });

    expect(planSchemaChange(v1, referring, { migrated })).toMatchObject({
      accepted: false,
      refused: [
        { table: "notes", field: "author", reason: "required_field_added" },
      ],
    });
    const disjoint = notes({ ...noteFields, title: v.number() });
    expect(planSchemaChange(v1, disjoint, { migrated })).toMatchObject({
      accepted: false,
      refused: [{ table: "notes", field: "title", reason: "values_disjoint" }],
    });
    const elsewhere = planSchemaChange(v1, target, {
      migrated: new Set(["people"]),
    });
    expect(elsewhere.accepted).toBeFalsy();
    expect(elsewhere.accepted ? [] : elsewhere.refused).toContainEqual({
      table: "people",
      reason: "migration_table_invalid",
    });
  });
});

describe("a table declared sensitive", () => {
  const plain = schemaManifest(
    defineSchema({ notes: defineTable(noteFields) }),
    ownerOnly
  );
  const sensitive = schemaManifest(
    defineSchema({ notes: defineTable(noteFields).sensitive() }),
    ownerOnly
  );

  test("leaves a table that never declares it as it was, and reads back as declared", () => {
    expect(manifestText(plain)).not.toContain("sensitive");
    expect(
      readSchemaManifest(manifestText(sensitive)).manifest.tables.notes
    ).toMatchObject({ sensitive: true });
    expect(() =>
      readSchemaManifest(
        manifestText(sensitive).replace('"sensitive":true', '"sensitive":false')
      )
    ).toThrow(/sensitive/u);
  });

  test("needs no migration, declared or left out again", () => {
    expect(planSchemaChange(plain, sensitive).accepted).toBeTruthy();
    expect(planSchemaChange(sensitive, plain).accepted).toBeTruthy();
  });
});

import { describe, expect, test } from "vite-plus/test";

import {
  manifestText,
  planSchemaChange,
  readSchemaManifest,
  schemaManifest,
} from "../src/host.ts";
import type { SchemaAccess, SchemaManifest, SchemaPlan } from "../src/host.ts";
import { defineSchema, defineTable, v } from "../src/values.ts";
import type { ValueShape } from "../src/values.ts";

// How a store's data contract changes when it is handed a schema: which
// changes apply on their own and which need a migration (spec 17.1,
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

  test("an enum's members in another order are no change; a union's are", () => {
    const status = (values: [string, ...string[]]) =>
      notes({ ...noteFields, status: v.enum(values).optional() });
    const contract = contractOf(
      planSchemaChange(null, status(["open", "done"]))
    );
    const plan = planSchemaChange(contract, status(["done", "open"]));
    expect(plan).toMatchObject({ accepted: true, changed: false });
    expect(manifestText(contractOf(plan))).toBe(manifestText(contract));
    expect(
      refusedOf(planSchemaChange(contract, status(["done", "open", "late"])))
    ).toStrictEqual([
      { table: "notes", field: "status", reason: "field_changed" },
    ]);
    const either = (first: "string" | "number") =>
      notes({
        ...noteFields,
        size:
          first === "string"
            ? v.union(v.string(), v.number()).optional()
            : v.union(v.number(), v.string()).optional(),
      });
    expect(
      refusedOf(
        planSchemaChange(
          contractOf(planSchemaChange(null, either("string"))),
          either("number")
        )
      )
    ).toStrictEqual([
      { table: "notes", field: "size", reason: "field_changed" },
    ]);
  });

  test("an older version is compatible with the contract it grew into", () => {
    const v2 = notes({ ...noteFields, category: v.string().optional() });
    const contract = contractOf(planSchemaChange(v1, v2));
    expect(planSchemaChange(contract, v1)).toMatchObject({
      accepted: true,
      changed: false,
    });
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

describe("changes that need a migration", () => {
  test("a required, nullable-only or defaulted field added is refused", () => {
    const v2 = notes({
      ...noteFields,
      category: v.string().default("general"),
      priority: v.number(),
      summary: v.string().nullable(),
    });
    expect(refusedOf(planSchemaChange(v1, v2))).toStrictEqual([
      { table: "notes", field: "category", reason: "defaulted_field_added" },
      { table: "notes", field: "priority", reason: "required_field_added" },
      { table: "notes", field: "summary", reason: "required_field_added" },
    ]);
  });

  test("any change to a field's descriptor is refused", () => {
    for (const title of [
      v.number(),
      v.string().min(1).max(100),
      v.string().min(1).max(200).optional(),
      v.string().min(1).max(200).default("Untitled"),
    ]) {
      expect(
        refusedOf(planSchemaChange(v1, notes({ ...noteFields, title })))
      ).toStrictEqual([
        { table: "notes", field: "title", reason: "field_changed" },
      ]);
    }
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

  test("a changed access mode is refused, looser or tighter", () => {
    const shared = notes(noteFields, undefined, {
      tables: { notes: { read: "appMembers", write: "owner" } },
    });
    expect(refusedOf(planSchemaChange(v1, shared))).toStrictEqual([
      { table: "notes", reason: "access_changed" },
    ]);
    expect(refusedOf(planSchemaChange(shared, v1))).toStrictEqual([
      { table: "notes", reason: "access_changed" },
    ]);
  });

  test("a required field left out is refused: the schema's inserts would lack it", () => {
    expect(
      refusedOf(
        planSchemaChange(v1, notes({ archivedAt: noteFields.archivedAt }, {}))
      )
    ).toStrictEqual([
      { table: "notes", field: "title", reason: "required_field_removed" },
    ]);
  });

  test("a field kept from an older version can't come back as another type", () => {
    const v2 = notes({ ...noteFields, category: v.string().optional() });
    const contract = contractOf(planSchemaChange(v1, v2));
    const v3 = notes({ ...noteFields, category: v.number().optional() });
    expect(refusedOf(planSchemaChange(contract, v3))).toStrictEqual([
      { table: "notes", field: "category", reason: "field_changed" },
    ]);
  });

  test("every refusal is listed, and a refused plan has no contract", () => {
    const v2 = notes(
      { title: v.string(), priority: v.number() },
      {},
      { tables: { notes: { read: "appMembers", write: "appMembers" } } }
    );
    const plan = planSchemaChange(v1, v2);
    expect(plan).not.toHaveProperty("contract");
    expect(refusedOf(plan).map(({ reason }) => reason)).toStrictEqual([
      "required_field_added",
      "field_changed",
      "access_changed",
    ]);
  });

  test("a union past a schema's limits is refused", () => {
    const contract = contractOf(planSchemaChange(null, many(tableNames("a"))));
    expect(
      refusedOf(planSchemaChange(contract, many(tableNames("b"))))
    ).toStrictEqual([{ table: "", reason: "contract_invalid" }]);
  });
});

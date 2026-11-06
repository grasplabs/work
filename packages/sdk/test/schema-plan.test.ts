import { describe, expect, test } from "vite-plus/test";

import {
  manifestText,
  planSchemaChange,
  readSchemaManifest,
  schemaCovered,
  schemaManifest,
  withDefaultsFilled,
} from "../src/host.ts";
import type { AccessMode, SchemaManifest, SchemaPlan } from "../src/host.ts";
import { descriptorOf } from "../src/value-schema.ts";
import { defineSchema, defineTable, rows, v } from "../src/values.ts";
import type { SchemaDefinition, ValueShape } from "../src/values.ts";

// How a store's data contract changes when it is handed a schema: which
// changes apply on their own, which the store checks every record for as
// their release is made current, and which need a migration (spec 17.1,
// 17.4). Pure, so unit tests; the store applying a plan is tested through
// the store (apps/core/test/schema-contract.test.ts).

/** Access declared for a schema's tables by name: a table or mode left out is `none`. */
interface DeclaredAccess {
  readonly tables?: Readonly<
    Record<string, { readonly read?: AccessMode; readonly write?: AccessMode }>
  >;
}

/**
 * `schema`'s manifest, its tables given `declared` access, read back as a
 * host reads a manifest: checked as `.access` checks a declaration.
 */
const manifestOf = (
  schema: SchemaDefinition,
  declared: DeclaredAccess
): SchemaManifest => {
  const base = schemaManifest(schema);
  return readSchemaManifest(
    JSON.stringify({
      ...base,
      tables: Object.fromEntries(
        Object.entries(base.tables).map(([name, table]) => {
          const held = Object.hasOwn(declared.tables ?? {}, name)
            ? declared.tables?.[name]
            : undefined;
          return [
            name,
            {
              ...table,
              access: {
                read: held?.read ?? "none",
                write: held?.write ?? "none",
              },
            },
          ];
        })
      ),
    })
  ).manifest;
};

const ownerOnly: DeclaredAccess = {
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
  access: DeclaredAccess = ownerOnly
): SchemaManifest => {
  const base = manifestOf(defineSchema({ notes: defineTable(fields) }), access);
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

/** The IDs of the Notes table `t1` with `fields`' IDs by name. */
const notesIds = (fields: Record<string, string>) => ({
  notes: { id: "t1", fields },
});

/** `manifest`, whose one table is `notes`, with that table named `name`. */
const tableNamed = (manifest: SchemaManifest, name: string): SchemaManifest =>
  readSchemaManifest(
    JSON.stringify({ ...manifest, tables: { [name]: manifest.tables.notes } })
  ).manifest;

/** Two tables of titles, named `first` and `second`. */
const notesAndMemos = (first: string, second: string): SchemaManifest =>
  manifestOf(
    defineSchema({
      [first]: defineTable({ title: v.string() }),
      [second]: defineTable({ title: v.string() }),
    }),
    {
      tables: {
        [first]: { read: "owner", write: "owner" },
        [second]: { read: "owner", write: "owner" },
      },
    }
  );

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
      }).access({ read: "owner", write: "owner" }),
      tags: defineTable({ name: v.string() }).access({
        read: "owner",
        write: "owner",
      }),
    })
  );

/** Notes with `fields` besides a title, beside a Tags table. */
const linkedNotes = (fields: ValueShape): SchemaManifest =>
  schemaManifest(
    defineSchema({
      notes: defineTable({ title: v.string(), ...fields }).access({
        read: "owner",
        write: "owner",
      }),
      tags: defineTable({ name: v.string() }).access({
        read: "owner",
        write: "owner",
      }),
    })
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
    const v2 = manifestOf(
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
    const v2 = manifestOf(
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
    const v2 = manifestOf(
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
  test("never adds a nested default: records stored without it lack it, so it is checked and filled in", () => {
    const detail = (tone: ValueShape[string]) =>
      notes({ ...noteFields, detail: v.object({ tone }).optional() });
    const before = detail(v.string().optional());
    const after = detail(v.string().default("plain"));
    const plan = planSchemaChange(before, after);
    expect(plan).toMatchObject({ accepted: true, activates: true });
    expect(checksOf(plan)).toStrictEqual([
      { table: "notes", field: "detail", answer: null },
    ]);
    // A version without it writes records that lack it.
    expect(schemaCovered(contractOf(plan), before)).toBeFalsy();
  });

  test("never adds a nested default inside a union's member either", () => {
    const detail = (tone: ValueShape[string]) =>
      notes({
        ...noteFields,
        detail: v.union(v.object({ tone }), v.string()).optional(),
      });
    const before = detail(v.string().optional());
    const after = detail(v.string().default("plain"));
    const plan = planSchemaChange(before, after);
    expect(plan).toMatchObject({ accepted: true, activates: true });
    expect(checksOf(plan)).toStrictEqual([
      { table: "notes", field: "detail", answer: null },
    ]);
    expect(schemaCovered(contractOf(plan), before)).toBeFalsy();
  });

  test("never counts a nested default as a widening, wherever it is nested", () => {
    for (const [before, after] of [
      // In an array's items, and in a record's values.
      [
        v.array(v.object({ tone: v.string().optional() })),
        v.array(v.object({ tone: v.string().default("plain") })),
      ],
      [
        v.record(v.object({ tone: v.string().optional() })),
        v.record(v.object({ tone: v.string().default("plain") })),
      ],
      // A new nested field with a default.
      [v.object({}), v.object({ tone: v.string().default("plain") })],
      // Deeper down.
      [
        v.object({ inner: v.object({ tone: v.string().optional() }) }),
        v.object({ inner: v.object({ tone: v.string().default("plain") }) }),
      ],
    ] as const) {
      const plan = planSchemaChange(
        notes({ ...noteFields, detail: before.optional() }),
        notes({ ...noteFields, detail: after.optional() })
      );
      expect(plan).toMatchObject({ accepted: true, activates: true });
      expect(checksOf(plan)).toStrictEqual([
        { table: "notes", field: "detail", answer: null },
      ]);
    }
  });

  test("fills a default in the union member a value fits, as a read of it would", () => {
    const detail = descriptorOf(
      v.union(
        v.object({ count: v.number() }),
        v.object({ tone: v.string().default("plain") })
      )
    );
    expect({
      member: withDefaultsFilled(detail, {}),
      first: withDefaultsFilled(detail, { count: 1 }),
      held: withDefaultsFilled(detail, { tone: "warm" }),
    }).toStrictEqual({
      // `{}` fits only the second member, which defaults its tone.
      member: { tone: "plain" },
      first: { count: 1 },
      held: { tone: "warm" },
    });
  });

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

  test("carries the App's answer for the field, and ignores answers for other fields", () => {
    const status = (values: [string, ...string[]]) =>
      notes({ ...noteFields, status: v.enum(values) });
    const answer = { table: "notes", field: "status", value: "open" };
    const plan = planSchemaChange(
      status(["todo", "done"]),
      status(["open", "done"]),
      {
        answers: [answer, { table: "notes", field: "title", value: "x" }],
      }
    );
    expect(checksOf(plan)).toStrictEqual([
      { table: "notes", field: "status", answer },
    ]);
  });

  test("a changed access mode or row rule changes no record, and applies at activation", () => {
    const fields = { title: v.string(), team: v.string() };
    const plain = schemaManifest(
      defineSchema({
        notes: defineTable(fields).access({
          read: "appMembers",
          write: "appMembers",
        }),
      })
    );
    const byTeam = schemaManifest(
      defineSchema({
        notes: defineTable(fields).access({
          read: "appMembers",
          write: "appMembers",
          rows: { read: [rows.team("team")] },
        }),
      })
    );
    const owned = schemaManifest(
      defineSchema({
        notes: defineTable(fields).access({ read: "owner", write: "owner" }),
      })
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

  test("a field renamed by its ID moves its values to the new name, the old one leaving", () => {
    const before = notes({ ...noteFields, body: v.string() });
    const after = notes({ ...noteFields, text: v.string() });
    const plan = planSchemaChange(before, after, {
      ids: {
        contract: notesIds({ title: "f1", body: "f2" }),
        target: notesIds({ title: "f1", text: "f2" }),
      },
    });
    expect(plan).toMatchObject({
      accepted: true,
      activates: true,
      renames: [{ table: "notes", from: "body", to: "text" }],
      retainedFields: [],
    });
    expect(plan.checks).toStrictEqual([
      { table: "notes", field: "text", answer: null, from: "body" },
    ]);
    expect(
      Object.keys(contractOf(plan).tables.notes?.fields ?? {})
    ).toStrictEqual(["archivedAt", "text", "title"]);
    // A version that still writes the old name no longer fits.
    expect(schemaCovered(contractOf(plan), before)).toBeFalsy();
    // Without IDs, every name is its own: the old field is kept.
    expect(planSchemaChange(before, after)).toMatchObject({
      renames: [],
      retainedFields: [{ table: "notes", field: "body" }],
    });
  });

  test("a rename back, as a rollback makes, moves the values back", () => {
    const withBody = notes({ ...noteFields, body: v.string() });
    const withText = notes({ ...noteFields, text: v.string() });
    const bodyIds = notesIds({ title: "f1", body: "f2" });
    const textIds = notesIds({ title: "f1", text: "f2" });
    const renamed = contractOf(
      planSchemaChange(withBody, withText, {
        ids: { contract: bodyIds, target: textIds },
      })
    );
    const back = planSchemaChange(renamed, withBody, {
      ids: { contract: textIds, target: bodyIds },
    });
    expect(back).toMatchObject({
      accepted: true,
      renames: [{ table: "notes", from: "text", to: "body" }],
    });
    expect(schemaCovered(contractOf(back), withBody)).toBeTruthy();
    expect(schemaCovered(contractOf(back), withText)).toBeFalsy();
  });

  test("a rename with a narrower type checks the moved values, a record lacking one taking the answer", () => {
    const before = notes({ ...noteFields, body: v.string().optional() });
    const after = notes({ ...noteFields, text: v.string().max(10) });
    const answer = { table: "notes", field: "text", value: "none" };
    const plan = planSchemaChange(before, after, {
      answers: [answer],
      ids: {
        contract: notesIds({ title: "f1", body: "f2" }),
        target: notesIds({ title: "f1", text: "f2" }),
      },
    });
    expect(plan.checks).toStrictEqual([
      { table: "notes", field: "text", answer, from: "body" },
    ]);
  });

  test("a table renamed by its ID keeps its records under its new name, its fields' changes planned as any table's", () => {
    const before = notes({ ...noteFields, body: v.string() });
    const after = tableNamed(
      notes({
        ...noteFields,
        text: v.string(),
        extra: v.string().optional(),
      }),
      "memos"
    );
    const plan = planSchemaChange(before, after, {
      ids: {
        contract: notesIds({ title: "f1", body: "f2" }),
        target: {
          memos: { id: "t1", fields: { title: "f1", text: "f2", extra: "f3" } },
        },
      },
    });

    expect(plan).toMatchObject({
      accepted: true,
      activates: true,
      renamedTables: [{ from: "notes", to: "memos" }],
      renames: [{ table: "memos", from: "body", to: "text" }],
      addedTables: [],
      retainedTables: [],
    });
    expect(Object.keys(contractOf(plan).tables)).toStrictEqual(["memos"]);
    // A version that still names the old table no longer fits.
    expect(schemaCovered(contractOf(plan), before)).toBeFalsy();
    expect(schemaCovered(contractOf(plan), after)).toBeTruthy();
  });

  test("a reference follows a table renamed, and a rollback renames it back", () => {
    const referring = (table: "notes" | "memos") =>
      manifestOf(
        defineSchema({
          [table]: defineTable({ title: v.string() }),
          tags: defineTable({ name: v.string(), note: v.id(table) }),
        }),
        {
          tables: {
            [table]: { read: "owner", write: "owner" },
            tags: { read: "owner", write: "owner" },
          },
        }
      );
    const tagIds = { id: "t2", fields: { name: "f3", note: "f4" } };
    const notesSide = {
      notes: { id: "t1", fields: { title: "f1" } },
      tags: tagIds,
    };
    const memosSide = {
      memos: { id: "t1", fields: { title: "f1" } },
      tags: tagIds,
    };

    const renamed = planSchemaChange(referring("notes"), referring("memos"), {
      ids: { contract: notesSide, target: memosSide },
    });
    const back = planSchemaChange(contractOf(renamed), referring("notes"), {
      ids: { contract: memosSide, target: notesSide },
    });

    // The reference isn't a change of what the tags hold.
    expect(renamed).toMatchObject({
      accepted: true,
      renamedTables: [{ from: "notes", to: "memos" }],
      checks: [],
      widenedFields: [],
    });
    expect(back).toMatchObject({
      accepted: true,
      renamedTables: [{ from: "memos", to: "notes" }],
    });
    expect(contractOf(back)).toStrictEqual(referring("notes"));
  });

  test("a name the contract holds for another field or table is refused", () => {
    const before = notes({ ...noteFields, body: v.string() });
    // `body` is another field now, the first one renamed to `text`.
    const reused = notes({ ...noteFields, body: v.string(), text: v.string() });
    expect(
      refusedOf(
        planSchemaChange(before, reused, {
          ids: {
            contract: notesIds({ title: "f1", body: "f2" }),
            target: notesIds({ title: "f1", body: "f3", text: "f2" }),
          },
        })
      )
    ).toStrictEqual([{ table: "notes", field: "body", reason: "id_changed" }]);
    const otherTable = { notes: { id: "t2", fields: { title: "f1" } } };
    expect(
      refusedOf(
        planSchemaChange(before, before, {
          ids: { contract: notesIds({ title: "f1" }), target: otherTable },
        })
      )
    ).toStrictEqual([{ table: "notes", reason: "id_changed" }]);
    // The notes renamed to `memos`, a name the contract holds for another
    // table.
    const both = notesAndMemos("notes", "memos");
    expect(
      refusedOf(
        planSchemaChange(both, notesAndMemos("memos", "archive"), {
          ids: {
            contract: {
              notes: { id: "t1", fields: { title: "f1" } },
              memos: { id: "t2", fields: { title: "f2" } },
            },
            target: {
              memos: { id: "t1", fields: { title: "f1" } },
              archive: { id: "t2", fields: { title: "f2" } },
            },
          },
        })
      )
    ).toStrictEqual([{ table: "memos", reason: "id_changed" }]);
  });
});

/** Notes whose rows a team rule on `team` chooses, with `more` fields. */
const teamRuled = (team: ReturnType<typeof v.string>, more: ValueShape = {}) =>
  schemaManifest(
    defineSchema({
      notes: defineTable({ title: v.string(), team, ...more }).access({
        read: "appMembers",
        write: "appMembers",
        rows: {
          read: [rows.team("team")],
        },
      }),
    })
  );

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

  test("a field a row rule reads that a check would fill a default into is refused, with no answer too", () => {
    const before = schemaManifest(
      defineSchema({
        notes: defineTable({
          title: v.string(),
          team: v.string().optional(),
        }).access({
          read: "appMembers",
          write: "appMembers",
          rows: { read: [rows.team("team")] },
        }),
      })
    );
    const after = schemaManifest(
      defineSchema({
        notes: defineTable({
          title: v.string(),
          team: v.string().max(10).default("sales"),
        }).access({
          read: "appMembers",
          write: "appMembers",
          rows: { read: [rows.team("team")] },
        }),
      })
    );
    expect(refusedOf(planSchemaChange(before, after))).toStrictEqual([
      { table: "notes", field: "team", reason: "rule_field_rewritten" },
    ]);
  });

  test("a defaulted field a row rule reads is refused: filling it in would choose who sees records", () => {
    const plain = schemaManifest(
      defineSchema({
        notes: defineTable({ title: v.string() }).access({
          read: "appMembers",
          write: "appMembers",
        }),
      })
    );
    const byTeam = schemaManifest(
      defineSchema({
        notes: defineTable({
          title: v.string(),
          team: v.string().default("sales"),
        }).access({
          read: "appMembers",
          write: "appMembers",
          rows: { read: [rows.team("team")] },
        }),
      })
    );
    expect(refusedOf(planSchemaChange(plain, byTeam))).toStrictEqual([
      { table: "notes", field: "team", reason: "rule_field_rewritten" },
    ]);
  });

  test("an answer or a rename that would rewrite a field a row rule reads is refused", () => {
    const before = teamRuled(v.string());
    const after = teamRuled(v.string().max(10));
    // Checked, it rewrites nothing: who sees a record stays as it was.
    expect(planSchemaChange(before, after).accepted).toBeTruthy();
    expect(
      refusedOf(
        planSchemaChange(before, after, {
          answers: [{ table: "notes", field: "team", value: "all" }],
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
          notes: defineTable(noteFields).access({
            read: "owner",
            write: "owner",
          }),
          tags: defineTable({
            name: asNumber ? v.number() : v.string(),
          }).access({ read: "owner", write: "owner" }),
        })
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
    defineSchema({
      notes: defineTable(noteFields).access({ read: "owner", write: "owner" }),
    })
  );
  const sensitive = schemaManifest(
    defineSchema({
      notes: defineTable(noteFields)
        .sensitive()
        .access({ read: "owner", write: "owner" }),
    })
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

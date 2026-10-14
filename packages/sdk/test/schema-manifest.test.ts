import { sha256Hex } from "@grasp-os/shared/encoding";
import { describe, expect, test } from "vite-plus/test";

import {
  diffSchemaManifests,
  manifestMaxBytes,
  manifestText,
  readSchemaManifest,
  schemaHash,
  schemaLimits,
  schemaManifest,
  schemaReferences,
} from "../src/host.ts";
import type { SchemaAccess, SchemaManifest, TableAccess } from "../src/host.ts";
import type { AnySchema } from "../src/value-schema.ts";
import { defineSchema, defineTable, v } from "../src/values.ts";
import type {
  SchemaDefinition,
  StringSchema,
  ValueShape,
} from "../src/values.ts";

// A schema's canonical manifest, its hash, the diff of two versions and
// the reading of a manifest of unknown origin. Pure, so unit tests; a
// store's host reading one is tested through the store
// (apps/core/test/data-stores.test.ts).

const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
  summary: v.string().max(10_000).nullable().default(null),
};

/** The Notes fields, or a version of them: the title stays a string. */
type NoteFields = Readonly<
  Record<"body" | "summary", AnySchema> & Record<"title", StringSchema>
>;

const notes = (fields: NoteFields) =>
  defineSchema({
    notes: defineTable(fields)
      .index("by_updated", ["_updatedAt"])
      .index("by_title", ["title"]),
  });

const access: SchemaAccess = {
  tables: { notes: { read: "owner", write: "owner" } },
};

const manifestOf = (
  schema: SchemaDefinition,
  declared: SchemaAccess = access
): SchemaManifest => schemaManifest(schema, declared);

/** JSON text of `value` with every object's keys in reverse order. */
const reversedText = (value: unknown): string =>
  JSON.stringify(value, (_key, part: unknown) =>
    typeof part === "object" && part !== null && !Array.isArray(part)
      ? Object.fromEntries(Object.entries(part).toReversed())
      : part
  );

/** The Notes table of a manifest's JSON. */
const notesOf = (json: Record<string, unknown>): Record<string, unknown> =>
  // SAFETY: the Notes manifest's JSON, as these tests make it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  (json.tables as Record<string, Record<string, unknown>>).notes ?? {};

/** The Notes table's fields in a manifest's JSON. */
const fieldsOf = (json: Record<string, unknown>): Record<string, unknown> =>
  // SAFETY: as above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  notesOf(json).fields as Record<string, unknown>;

const titleOf = (json: Record<string, unknown>) => fieldsOf(json).title;

const anyAccess = (declared: unknown): SchemaAccess =>
  // SAFETY: none, on purpose: the manifest checks what the types refuse.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately ill-typed input
  declared as SchemaAccess;

const codeOf = (read: () => unknown): unknown => {
  try {
    read();
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : error;
  }
  return "accepted";
};

// The text and hash a stored schema hash was taken of. If either changes,
// every stored hash changes meaning: change them only with
// `manifestVersion`.
const GOLDEN_TEXT =
  '{"descriptorVersion":1,"managedFields":["_id","_ownerId","_rev","_createdAt","_updatedAt"],"manifestVersion":1,"tables":{"projects":{"access":{"read":"appMembers","write":"appBuilders"},"fields":{"name":{"descriptorVersion":1,"email":false,"kind":"string","max":80,"min":1,"nullable":false,"presence":"required","trim":true}},"indexes":{}},"tasks":{"access":{"read":"owner","write":"owner"},"fields":{"due":{"descriptorVersion":1,"kind":"timestamp","nullable":true,"presence":"required"},"meta":{"descriptorVersion":1,"fields":{"source":{"descriptorVersion":1,"email":false,"kind":"string","nullable":false,"presence":"required","trim":false},"tries":{"defaultValue":1,"descriptorVersion":1,"integer":false,"kind":"number","nullable":false,"presence":"default"}},"kind":"object","nullable":false,"presence":"required"},"note":{"descriptorVersion":1,"kind":"union","members":[{"descriptorVersion":1,"email":false,"kind":"string","max":500,"nullable":false,"presence":"required","trim":false},{"descriptorVersion":1,"kind":"literal","nullable":false,"presence":"required","value":0}],"nullable":false,"presence":"optional"},"project":{"descriptorVersion":1,"kind":"id","nullable":false,"presence":"required","tableName":"projects"},"rank":{"descriptorVersion":1,"integer":true,"kind":"number","min":0,"nullable":false,"presence":"required"},"status":{"defaultValue":"open","descriptorVersion":1,"kind":"enum","nullable":false,"presence":"default","values":["open","done"]}},"indexes":{"by_project_status":{"fields":["project","status","_createdAt"]},"by_rank":{"fields":["rank"]}}}}}';
const GOLDEN_HASH =
  "bc2297808e81c663e909053d76ec9e4d7f2626cf4e05236689194e1d611fbc8c";

/** The hash of a one-table schema of `fields`. */
const hashOfFields = async (fields: ValueShape): Promise<string> =>
  await schemaHash(
    schemaManifest(defineSchema({ things: defineTable(fields) }))
  );

describe("canonical manifests", () => {
  test("declaring fields, tables, indexes and access in another order changes nothing", async () => {
    const people = defineTable({ name: v.string() });
    const first = manifestOf(
      defineSchema({
        notes: defineTable(noteFields)
          .index("by_updated", ["_updatedAt"])
          .index("by_title", ["title"]),
        people,
      }),
      {
        tables: {
          notes: { read: "owner", write: "owner" },
          people: { write: "none", read: "appMembers" },
        },
      }
    );
    const second = manifestOf(
      defineSchema({
        people,
        notes: defineTable({
          summary: noteFields.summary,
          body: noteFields.body,
          title: v.string().max(200).min(1).trim(),
        })
          .index("by_title", ["title"])
          .index("by_updated", ["_updatedAt"]),
      }),
      {
        tables: {
          people: { read: "appMembers" },
          notes: { write: "owner", read: "owner" },
        },
      }
    );
    expect(manifestText(second)).toBe(manifestText(first));
    await expect(schemaHash(second)).resolves.toBe(await schemaHash(first));
    expect(diffSchemaManifests(first, second).hasChanges).toBeFalsy();
  });

  test.each([
    ["a string's minimum of 0", v.string().min(0), v.string()],
    [
      "an array's minimum of 0",
      v.array(v.string()).min(0),
      v.array(v.string()),
    ],
    [
      "an integer's bound between integers",
      v.number().integer().min(1.5).max(9.9),
      v.number().integer().min(2).max(9),
    ],
    [
      "an integer's bound, whichever came first",
      v.number().min(1.5).integer(),
      v.number().integer().min(2),
    ],
    [
      "an integer's bound past the safe integers",
      v
        .number()
        .integer()
        .min(Number.MIN_SAFE_INTEGER - 10),
      v.number().integer(),
    ],
    ["a union with null", v.union(v.string(), v.null()), v.string().nullable()],
    [
      "a union with null first",
      v.union(v.null(), v.string().max(3)),
      v.string().max(3).nullable(),
    ],
    [
      "a union of several with null",
      v.union(v.string(), v.literal(null), v.number()),
      v.union(v.string(), v.number()).nullable(),
    ],
    ["a union of one", v.union(v.boolean()), v.boolean()],
    ["null that is also nullable", v.null().nullable(), v.null()],
  ])("%s hashes as what it means", async (_, first, second) => {
    await expect(hashOfFields({ value: first })).resolves.toBe(
      await hashOfFields({ value: second })
    );
  });

  test("bounds made one form still check what they said", () => {
    const rank = v.number().integer().min(1.5);
    expect(rank["~standard"].validate(1).issues).toBeDefined();
    expect(rank["~standard"].validate(2)).toStrictEqual({ value: 2 });
    const maybe = v.union(v.string().max(3), v.null());
    expect(maybe["~standard"].validate(null)).toStrictEqual({ value: null });
    expect(maybe["~standard"].validate("abcd").issues).toBeDefined();
    expect(codeOf(() => v.number().integer().min(1.2).max(1.8))).toBe(
      "definition.contradictory_bounds"
    );
  });

  test("tables named like Object's own methods have manifests", async () => {
    const names = ["constructor", "toString", "hasOwnProperty", "valueOf"];
    const tables = Object.fromEntries(
      names.map((name) => [name, defineTable({ title: v.string() })])
    );
    const declared: Record<string, TableAccess> = Object.fromEntries([
      ["toString", { read: "owner" }],
    ]);
    const manifest = schemaManifest(defineSchema(tables), {
      tables: declared,
    });
    const accessOf = (table: string) =>
      Object.hasOwn(manifest.tables, table)
        ? manifest.tables[table]?.access
        : undefined;
    expect(Object.keys(manifest.tables).toSorted()).toStrictEqual(
      names.toSorted()
    );
    expect(accessOf("toString")).toStrictEqual({
      read: "owner",
      write: "none",
    });
    expect(accessOf("valueOf")).toStrictEqual({ read: "none", write: "none" });
    const read = readSchemaManifest(manifestText(manifest));
    await expect(schemaHash(read.manifest)).resolves.toBe(
      await schemaHash(manifest)
    );
  });

  test("a schema whose manifest is too large is refused where it is declared", () => {
    // Each of these tables' descriptors is within its own limits; together
    // they are over the manifest's.
    const wide = Object.fromEntries(
      Array.from({ length: 400 }, (_, n) => [
        `f${n}`,
        v.enum(["a".repeat(200), "b".repeat(200), "c".repeat(200)]),
      ])
    );
    const tables = Object.fromEntries(
      Array.from({ length: 4 }, (_, n) => [`t${n}`, defineTable(wide)])
    );
    expect(codeOf(() => schemaManifest(defineSchema(tables)))).toBe(
      "schema.too_large"
    );
  });

  test("access left out is `none`, as if declared so", async () => {
    const declared = manifestOf(notes(noteFields), {
      tables: { notes: { read: "none", write: "none" } },
    });
    const omitted = manifestOf(notes(noteFields), {});
    await expect(schemaHash(omitted)).resolves.toBe(await schemaHash(declared));
    expect(omitted.tables.notes?.access).toStrictEqual({
      read: "none",
      write: "none",
    });
  });

  test("a manifest's canonical text is stable, and its hash is that text's SHA-256", async () => {
    const manifest = manifestOf(
      defineSchema({
        projects: defineTable({ name: v.string().trim().min(1).max(80) }),
        tasks: defineTable({
          project: v.id("projects"),
          status: v.enum(["open", "done"]).default("open"),
          rank: v.number().integer().min(0),
          note: v.union(v.string().max(500), v.literal(0)).optional(),
          meta: v.object({ source: v.string(), tries: v.number().default(1) }),
          due: v.timestamp().nullable(),
        })
          .index("by_project_status", ["project", "status", "_createdAt"])
          .index("by_rank", ["rank"]),
      }),
      {
        tables: {
          projects: { read: "appMembers", write: "appBuilders" },
          tasks: { read: "owner", write: "owner" },
        },
      }
    );
    const text = manifestText(manifest);
    expect(text).toBe(GOLDEN_TEXT);
    await expect(sha256Hex(text)).resolves.toBe(GOLDEN_HASH);
    await expect(schemaHash(manifest)).resolves.toBe(GOLDEN_HASH);
  });

  test("access must name the schema's tables and modes that exist", () => {
    expect(
      codeOf(() =>
        manifestOf(notes(noteFields), { tables: { people: { read: "owner" } } })
      )
    ).toBe("schema.unknown_table");
    for (const declared of [
      { tables: { notes: { read: "everyone" } } },
      { tables: { notes: { read: null } } },
      { tables: { notes: { read: "owner", delete: "owner" } } },
      { tables: { notes: "owner" } },
      { tables: [] },
      { grants: {} },
    ]) {
      expect(
        codeOf(() => manifestOf(notes(noteFields), anyAccess(declared)))
      ).toMatch(/^schema\.invalid_access$/u);
    }
  });

  test("only a schema `defineSchema` made has a manifest", () => {
    const real = notes(noteFields);
    expect(codeOf(() => schemaManifest({ tables: { ...real.tables } }))).toBe(
      "schema.invalid_table"
    );
  });
});

describe("diffs", () => {
  const before = manifestOf(notes(noteFields));

  test("a changed default is a changed field, with both descriptors", () => {
    const after = manifestOf(
      notes({ ...noteFields, body: v.string().max(100_000).default("-") })
    );
    const diff = diffSchemaManifests(before, after);
    expect(diff.fields).toStrictEqual([
      {
        table: "notes",
        field: "body",
        change: "changed",
        before: before.tables.notes?.fields.body,
        after: after.tables.notes?.fields.body,
      },
    ]);
    expect(diff.fields[0]?.after?.defaultValue).toBe("-");
    expect([diff.tables, diff.indexes, diff.access]).toStrictEqual([
      [],
      [],
      [],
    ]);
  });

  test("a changed constraint or presence is a changed field", () => {
    const narrower = manifestOf(
      notes({ ...noteFields, title: v.string().trim().min(1).max(100) })
    );
    const optional = manifestOf(
      notes({ ...noteFields, summary: v.string().max(10_000).optional() })
    );
    expect(
      diffSchemaManifests(before, narrower).fields.map(
        ({ field, change, after }) => [
          field,
          change,
          after?.kind === "string" ? after.max : undefined,
        ]
      )
    ).toStrictEqual([["title", "changed", 100]]);
    expect(
      diffSchemaManifests(before, optional).fields.map(({ field, after }) => [
        field,
        after?.presence,
        after?.nullable,
      ])
    ).toStrictEqual([["summary", "optional", false]]);
  });

  test("an index's field order is part of it", () => {
    const fields = { title: v.string(), rank: v.number() };
    const ordered = (
      keys: readonly ["title", "rank"] | readonly ["rank", "title"]
    ) =>
      manifestOf(
        defineSchema({ notes: defineTable(fields).index("by_both", keys) })
      );
    expect(
      diffSchemaManifests(
        ordered(["title", "rank"]),
        ordered(["rank", "title"])
      ).indexes
    ).toStrictEqual([
      {
        table: "notes",
        index: "by_both",
        change: "changed",
        before: ["title", "rank"],
        after: ["rank", "title"],
      },
    ]);
  });

  test("a changed access mode is an access change", () => {
    const after = manifestOf(notes(noteFields), {
      tables: { notes: { read: "appMembers", write: "owner" } },
    });
    expect(diffSchemaManifests(before, after)).toStrictEqual({
      hasChanges: true,
      tables: [],
      fields: [],
      indexes: [],
      access: [
        {
          table: "notes",
          before: { read: "owner", write: "owner" },
          after: { read: "appMembers", write: "owner" },
        },
      ],
    });
  });

  test("tables, fields and indexes added, removed and renamed each show", () => {
    const after = manifestOf(
      defineSchema({
        notes: defineTable({
          title: noteFields.title,
          body: noteFields.body,
          archivedAt: v.timestamp().optional(),
        })
          .index("by_updated", ["_updatedAt"])
          .index("by_heading", ["title"]),
        people: defineTable({ name: v.string() }),
      }),
      { tables: { notes: { read: "owner", write: "owner" } } }
    );
    const diff = diffSchemaManifests(before, after);
    expect(diff.tables).toStrictEqual([{ table: "people", change: "added" }]);
    expect(
      diff.fields.map(({ table, field, change }) => [table, field, change])
    ).toStrictEqual([
      ["notes", "archivedAt", "added"],
      ["notes", "summary", "removed"],
      ["people", "name", "added"],
    ]);
    // A renamed index is a new one beside the old, which stays while
    // anything pinned uses it.
    expect(
      diff.indexes.map(({ index, change }) => [index, change])
    ).toStrictEqual([
      ["by_heading", "added"],
      ["by_title", "removed"],
    ]);
    expect(diff.access).toStrictEqual([
      { table: "people", after: { read: "none", write: "none" } },
    ]);
    expect(diffSchemaManifests(after, before).tables).toStrictEqual([
      { table: "people", change: "removed" },
    ]);
  });
});

describe("reading a manifest", () => {
  const manifest = manifestOf(notes(noteFields));

  test("a manifest read back is the same manifest, whatever order its keys are in", async () => {
    for (const text of [manifestText(manifest), reversedText(manifest)]) {
      const read = readSchemaManifest(text);
      expect(manifestText(read.manifest)).toBe(manifestText(manifest));
      // oxlint-disable-next-line no-await-in-loop -- two texts, each hashed in turn
      await expect(schemaHash(read.manifest)).resolves.toBe(
        // oxlint-disable-next-line no-await-in-loop -- as above
        await schemaHash(manifest)
      );
      expect(Object.keys(read.schema.tables)).toStrictEqual(["notes"]);
    }
  });

  /** The manifest's JSON, changed by `change`, as text. */
  const changed = (change: (json: Record<string, unknown>) => void): string => {
    // SAFETY: a manifest's text is a JSON object.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const json = JSON.parse(manifestText(manifest)) as Record<string, unknown>;
    change(json);
    return JSON.stringify(json);
  };

  test.each([
    ["text that isn't JSON", "{", "schema.invalid_manifest"],
    ["JSON that isn't an object", "[]", "schema.invalid_manifest"],
    [
      "another manifest version",
      changed((json) => {
        json.manifestVersion = 2;
      }),
      "schema.invalid_manifest",
    ],
    [
      "another descriptor version",
      changed((json) => {
        json.descriptorVersion = 2;
      }),
      "schema.invalid_manifest",
    ],
    [
      "other managed fields",
      changed((json) => {
        json.managedFields = ["_id"];
      }),
      "schema.invalid_manifest",
    ],
    [
      "a key it doesn't have",
      changed((json) => {
        json.grants = {};
      }),
      "schema.invalid_manifest",
    ],
    [
      "a table with a key it doesn't have",
      changed((json) => {
        notesOf(json).sql = "DROP TABLE sdk_records";
      }),
      "schema.invalid_manifest",
    ],
    [
      "a table without its access",
      changed((json) => {
        delete notesOf(json).access;
      }),
      "schema.invalid_manifest",
    ],
    [
      "access modes given as null",
      changed((json) => {
        notesOf(json).access = { read: null, write: null };
      }),
      "schema.invalid_access",
    ],
    [
      "one access mode given as null",
      changed((json) => {
        notesOf(json).access = { read: "owner", write: null };
      }),
      "schema.invalid_access",
    ],
    [
      "an access mode that doesn't exist",
      changed((json) => {
        notesOf(json).access = { read: "everyone", write: "none" };
      }),
      "schema.invalid_access",
    ],
    [
      "a managed field declared as a field",
      changed((json) => {
        fieldsOf(json)._ownerId = titleOf(json);
      }),
      "schema.invalid_name",
    ],
    [
      "a prototype key as a table",
      changed((json) => {
        // Parsed back as an own key, as JSON.parse makes it.
        json.tables = JSON.parse(
          `{"__proto__":${JSON.stringify(notesOf(json))}}`
        );
      }),
      "schema.invalid_name",
    ],
    [
      "a field whose descriptor has an unknown kind",
      changed((json) => {
        fieldsOf(json).title = {
          descriptorVersion: 1,
          kind: "bytes",
          nullable: false,
          presence: "required",
        };
      }),
      "definition.invalid_descriptor",
    ],
    [
      "a field whose default its schema refuses",
      changed((json) => {
        fieldsOf(json).body = {
          descriptorVersion: 1,
          kind: "string",
          trim: false,
          email: false,
          max: 1,
          nullable: false,
          presence: "default",
          defaultValue: "too long",
        };
      }),
      "definition.invalid_default",
    ],
    [
      "an index on a field the table hasn't",
      changed((json) => {
        notesOf(json).indexes = { by_missing: { fields: ["missing"] } };
      }),
      "schema.invalid_index",
    ],
    [
      "an index with a key it doesn't have",
      changed((json) => {
        notesOf(json).indexes = {
          by_title: { fields: ["title"], unique: true },
        };
      }),
      "schema.invalid_manifest",
    ],
    [
      "a record ID naming a table it hasn't",
      changed((json) => {
        fieldsOf(json).author = {
          descriptorVersion: 1,
          kind: "id",
          tableName: "people",
          nullable: false,
          presence: "required",
        };
      }),
      "schema.unknown_table",
    ],
  ])("refuses %s", (_, text, code) => {
    expect(codeOf(() => readSchemaManifest(text))).toBe(code);
  });

  test("refuses what is too large before reading it", () => {
    const tables = Object.fromEntries(
      Array.from({ length: schemaLimits.tables + 1 }, (_, n) => [
        `t${n}`,
        // Not even a table: the count is refused first.
        null,
      ])
    );
    expect(
      codeOf(() =>
        readSchemaManifest(
          changed((json) => {
            json.tables = tables;
          })
        )
      )
    ).toBe("schema.too_large");
    expect(
      codeOf(() => readSchemaManifest(" ".repeat(manifestMaxBytes + 1)))
    ).toBe("schema.too_large");
    // Bytes, not characters: text under the limit in code units but over
    // it in UTF-8 is too large too.
    const wide = "漢".repeat(Math.ceil(manifestMaxBytes / 3) + 1);
    expect(wide.length).toBeLessThan(manifestMaxBytes);
    expect(codeOf(() => readSchemaManifest(`"${wide}"`))).toBe(
      "schema.too_large"
    );
    // A descriptor nested past the limit is refused, not followed.
    let deep: unknown = {
      descriptorVersion: 1,
      kind: "null",
      nullable: false,
      presence: "required",
    };
    for (let level = 0; level < 40; level += 1) {
      deep = {
        descriptorVersion: 1,
        kind: "array",
        item: deep,
        nullable: false,
        presence: "required",
      };
    }
    expect(
      codeOf(() =>
        readSchemaManifest(
          changed((json) => {
            fieldsOf(json).deep = deep;
          })
        )
      )
    ).toBe("definition.too_large");
  });

  test("refuses anything but text", () => {
    // SAFETY: none, on purpose: an object isn't read, only text.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately ill-typed view
    const readAnything = readSchemaManifest as (input: unknown) => unknown;
    expect(codeOf(() => readAnything(manifest))).toBe(
      "schema.invalid_manifest"
    );
  });
});

describe("references", () => {
  test("a record ID's delete policy is part of the manifest, restrict left out as the default", async () => {
    const withPolicy = (onDelete?: "restrict" | "cascade") =>
      manifestOf(
        defineSchema({
          people: defineTable({ name: v.string() }),
          notes: defineTable({
            author: v.id("people", onDelete && { onDelete }).optional(),
          }),
        }),
        {}
      );
    const unsaid = await schemaHash(withPolicy());
    await expect(schemaHash(withPolicy("restrict"))).resolves.toBe(unsaid);
    const cascade = withPolicy("cascade");
    await expect(schemaHash(cascade)).resolves.not.toBe(unsaid);
    const read = readSchemaManifest(manifestText(cascade));
    expect(read.manifest.tables.notes?.fields.author).toMatchObject({
      kind: "id",
      tableName: "people",
      onDelete: "cascade",
      presence: "optional",
    });
    expect(
      Reflect.has(
        withPolicy("restrict").tables.notes?.fields.author ?? {},
        "onDelete"
      )
    ).toBeFalsy();
  });

  test("every record ID a table declares, with where it is and what it names", () => {
    const schema = defineSchema({
      people: defineTable({
        name: v.string(),
        manager: v.id("people").nullable(),
      }),
      notes: defineTable({
        author: v.id("people"),
        meta: v.object({
          reviewers: v.array(v.id("people")),
          byRole: v.record(v.union(v.id("people"), v.id("people"))),
        }),
        title: v.string(),
      }),
    });
    expect(schemaReferences(manifestOf(schema, {}))).toStrictEqual([
      {
        table: "notes",
        path: [{ kind: "field", name: "author" }],
        target: "people",
      },
      {
        table: "notes",
        path: [
          { kind: "field", name: "meta" },
          { kind: "field", name: "byRole" },
          { kind: "value" },
        ],
        target: "people",
      },
      {
        table: "notes",
        path: [
          { kind: "field", name: "meta" },
          { kind: "field", name: "reviewers" },
          { kind: "item" },
        ],
        target: "people",
      },
      {
        table: "people",
        path: [{ kind: "field", name: "manager" }],
        target: "people",
      },
    ]);
  });
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Release } from "../src/app-releases.ts";
import { commitFiles } from "../src/apps.ts";
import {
  transformBatch,
  transformBatchMaxRows,
} from "../src/migration-transform.ts";
import type { TransformRow } from "../src/migration-transform.ts";
import { appWith, failure, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";

// An App's explicit migrations (spec 17.2), sealed with its release and
// run by the host on batches of records, through the real compiler, seal
// and Loader isolates. What can go wrong, and the test that shows it
// doesn't:
//
// - A reviewer approves a transform to another schema than the release
//   seals: "is sealed only when it transforms to the release's schema".
// - A migration is built from server code, or reaches the network while
//   its code loads: "is refused at the seal".
// - The transform writes a managed field, an undeclared key, a value of
//   the wrong type or a document past the store's limit, or drops a field
//   the target doesn't declare: "validates every output against the
//   target table, and keeps what the target doesn't declare".
// - App code sees a row it wasn't written for: "refuses a row that doesn't
//   fit its input before App code sees it".
// - App code forges the runner's answer, or fails outside a handler:
//   "refuses an answer that isn't its rows".

/** A schema hash no release seals: what an author writes before the seal tells them. */
const placeholder = "0".repeat(64);

/** The fields of a stored note before the migration: no category yet. */
const schemaFile = `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
  category: v.enum(["launch", "general"]),
};

export default defineSchema({ notes: defineTable(noteFields) });
`;

/** Notes, with `migrations` (file name to source) registered in order. */
const notesFiles = (
  migrations: Readonly<Record<string, string>>
): Record<string, string> => {
  const names = Object.keys(migrations);
  return {
    "schema.ts": schemaFile,
    ...Object.fromEntries(
      Object.entries(migrations).map(([name, source]) => [
        `migrations/${name}.ts`,
        source,
      ])
    ),
    "app.ts": `import { app } from "@grasp-os/sdk";
import schema from "./schema.ts";
${names.map((name, index) => `import m${index} from "./migrations/${name}.ts";`).join("\n")}

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: {},
  screens: [],
  uses: [],
  migrations: [${names.map((_name, index) => `m${index}`).join(", ")}],
});
`,
  };
};

/** A migration of notes named `name`, transforming to `toSchema` with `handler`. */
const migrationSource = (
  name: string,
  handler: string,
  { toSchema = placeholder, input = "", prelude = "" } = {}
): string => `import { migration, v } from "@grasp-os/sdk";
import { noteFields } from "../schema.ts";
${prelude}
export default migration({
  name: ${JSON.stringify(name)},
  fromSchema: ${JSON.stringify("f".repeat(64))},
  toSchema: ${JSON.stringify(toSchema)},
  table: "notes",
  ${input}
  output: v.object(noteFields),
  handler: ${handler},
});
`;

/** The transforms the tests run, each a migration of one App. */
const handlers = {
  "derive-category": `(ctx, row) => ({
    title: row.title,
    body: row.body,
    category: row.body.toLowerCase().includes("launch") ? "launch" : "general",
  })`,
  "sees-input-only": `(ctx, row) => ({
    title: Object.keys(row).sort().join(","),
    category: "general",
  })`,
  "writes-managed": `(ctx, row) => ({ ...row, category: "general", _id: "n_forged" })`,
  "writes-undeclared": `(ctx, row) => ({ ...row, category: "general", priority: 1 })`,
  "writes-wrong-type": `(ctx, row) => ({ ...row, category: 42 })`,
  "writes-too-much": `(ctx, row) => ({ ...row, category: "general", body: "x".repeat(100000) })`,
  "spreads-row": `(ctx, row) => ({ ...row, category: "general" })`,
  "rewrites-retained": `(ctx, row) => ({ ...row, category: "general", legacy: "changed" })`,
  throws: `(ctx, row) => {
    if (ctx.id === "n2") throw new Error("Can't tell this one's category");
    return { ...row, category: "general" };
  }`,
  "never-runs": `() => { throw new Error("App code ran"); }`,
} as const;

type Name = keyof typeof handlers;

/** What each migration declares as its input, when it declares one. */
const inputs: Readonly<Record<string, string>> = {
  "derive-category":
    "input: v.object({ title: noteFields.title, body: noteFields.body }),",
  "sees-input-only":
    "input: v.object({ title: noteFields.title, body: noteFields.body }),",
  "never-runs": "input: v.object({ title: noteFields.title }),",
};

/** The App's files with every migration of `handlers`, to `toSchema`. */
const filesTo = (toSchema: string): Record<string, string> =>
  notesFiles(
    Object.fromEntries(
      Object.entries(handlers).map(([name, handler]) => [
        name,
        migrationSource(name, handler, {
          toSchema,
          input: Object.hasOwn(inputs, name) ? (inputs[name] ?? "") : "",
        }),
      ])
    )
  );

/** The code and details of what `work` threw. */
const refusalOf = async (
  work: () => Promise<unknown>
): Promise<{ code: unknown; details: unknown }> => {
  try {
    await work();
  } catch (error) {
    return typeof error === "object" && error !== null
      ? {
          code: Reflect.get(error, "code"),
          details: Reflect.get(error, "details"),
        }
      : { code: undefined, details: undefined };
  }
  return { code: "ok", details: undefined };
};

/** The schema hash a seal refused a migration for, naming the one it must name. */
const namedSchema = (details: unknown): string => {
  const toSchema: unknown =
    typeof details === "object" && details !== null
      ? Reflect.get(details, "toSchema")
      : undefined;
  if (typeof toSchema !== "string") {
    throw new TypeError("The seal named no schema hash");
  }
  return toSchema;
};

/**
 * The fixture's App sealed as version 2, after version 1 named a wrong
 * `toSchema` and the seal answered the one it must name.
 */
const sealedTransforms = async (): Promise<{
  fixture: Fixture;
  release: Release;
  refused: { code: unknown; details: unknown };
}> => {
  const fixture = await appWith(filesTo(placeholder));
  const refused = await refusalOf(async () => await seal(fixture));
  await commitFiles(
    env,
    fixture.owner,
    fixture.app,
    filesTo(namedSchema(refused.details)),
    "Fix"
  );
  return { fixture, release: await seal(fixture, 2), refused };
};

/** The App sealed once for the whole file, when first asked: a seal takes seconds. */
let sealedOnce: ReturnType<typeof sealedTransforms> | undefined;
const sealed = async () => await (sealedOnce ??= sealedTransforms());

/** Rows of notes, as a store holds them. */
const rows: TransformRow[] = [
  { id: "n1", fields: { title: "Plan", body: "Launch on Monday" } },
  { id: "n2", fields: { title: "Idea", body: "", legacy: "kept" } },
];

const run = async (name: Name, batch: readonly TransformRow[] = rows) => {
  const { release } = await sealed();
  return await transformBatch(env, release, name, batch);
};

describe("an explicit migration", { timeout: 120_000 }, () => {
  it("is sealed only when it transforms to the release's schema, which the refusal names", async () => {
    const { release, refused } = await sealed();

    expect(refused).toStrictEqual({
      code: "version.invalid_migration",
      details: {
        migration: "derive-category",
        toSchema: release.manifest.schemaHash,
      },
    });
    expect(release.app.migrations["derive-category"]).toMatchObject({
      table: "notes",
      toSchema: release.manifest.schemaHash,
    });
  });

  it.each([
    [
      "built from server code",
      {
        "operations/helpers.ts": "export const label = 'general';\n",
        "migrations/derive-category.ts": migrationSource(
          "derive-category",
          "(ctx, row) => ({ ...row, category: label })",
          { prelude: 'import { label } from "../operations/helpers.ts";' }
        ),
      },
      "version.build_failed",
    ],
    [
      "that reaches the network while its code loads",
      {
        "migrations/derive-category.ts": migrationSource(
          "derive-category",
          "(ctx, row) => row",
          { prelude: 'await fetch("https://example.com");' }
        ),
      },
      "version.inspection_failed",
    ],
  ])("is refused at the seal when %s", async (_case, changes, code) => {
    const fixture = await appWith({
      ...notesFiles({ "derive-category": "" }),
      ...changes,
    });
    await expect(failure(async () => await seal(fixture))).resolves.toBe(code);
  });
});

describe("transforming a batch", { timeout: 120_000 }, () => {
  it("derives each record's fields, keeping what the target doesn't declare", async () => {
    await expect(run("derive-category")).resolves.toStrictEqual({
      ok: true,
      rows: [
        {
          id: "n1",
          fields: {
            title: "Plan",
            body: "Launch on Monday",
            category: "launch",
          },
        },
        {
          id: "n2",
          fields: {
            title: "Idea",
            body: "",
            category: "general",
            legacy: "kept",
          },
        },
      ],
    });
  });

  it("hands the handler only the fields its input declares, normalized", async () => {
    const outcome = await run("sees-input-only", [
      { id: "n1", fields: { title: "Plan", legacy: "kept" } },
    ]);

    expect(outcome).toStrictEqual({
      ok: true,
      rows: [
        {
          id: "n1",
          fields: {
            title: "body,title",
            body: "",
            category: "general",
            legacy: "kept",
          },
        },
      ],
    });
  });

  it("refuses a row that doesn't fit its input before App code sees it", async () => {
    await expect(
      run("never-runs", [
        { id: "n1", fields: { title: "Plan" } },
        { id: "n2", fields: { title: 7 } },
      ])
    ).resolves.toMatchObject({
      ok: false,
      failure: { id: "n2", reason: "invalid_input" },
    });
  });

  it.each([
    ["writes-managed", "invalid_output"],
    ["writes-undeclared", "invalid_output"],
    ["writes-wrong-type", "invalid_output"],
  ] as const)(
    "validates every output against the target table: %s is refused",
    async (name, reason) => {
      await expect(run(name)).resolves.toMatchObject({
        ok: false,
        failure: { id: "n1", reason },
      });
    }
  );

  it("refuses a record its output would make larger than a store holds", async () => {
    await expect(
      run("writes-too-much", [
        { id: "n1", fields: { title: "Plan", legacy: "y".repeat(40_000) } },
      ])
    ).resolves.toMatchObject({
      ok: false,
      failure: { id: "n1", reason: "too_large" },
    });
  });

  it("passes a field the target doesn't declare through unchanged, and refuses changing it", async () => {
    const retained = [{ id: "n2", fields: { title: "Idea", legacy: "kept" } }];

    await expect(run("spreads-row", retained)).resolves.toStrictEqual({
      ok: true,
      rows: [
        {
          id: "n2",
          fields: {
            title: "Idea",
            body: "",
            category: "general",
            legacy: "kept",
          },
        },
      ],
    });
    await expect(run("rewrites-retained", retained)).resolves.toMatchObject({
      ok: false,
      failure: { id: "n2", reason: "invalid_output" },
    });
  });

  it("names the record whose transform threw", async () => {
    await expect(run("throws")).resolves.toStrictEqual({
      ok: false,
      failure: {
        id: "n2",
        reason: "threw",
        issues: ["Can't tell this one's category"],
      },
    });
  });

  it("refuses a batch past its bounds, which only a caller's bug sends", async () => {
    const many = Array.from(
      { length: transformBatchMaxRows + 1 },
      (_, index) => ({
        id: `n${index}`,
        fields: { title: "Note", body: "" },
      })
    );
    await expect(run("derive-category", many)).rejects.toThrow(
      /past its bounds/u
    );
  });
});

describe("App code that forges its answer", { timeout: 120_000 }, () => {
  it("refuses an answer that isn't its rows", async () => {
    // The App's code makes the runner in its isolate answer fewer rows
    // than it was sent, as though they had been transformed.
    const forging = migrationSource("derive-category", "(ctx, row) => row", {
      prelude: `const stringify = JSON.stringify;
JSON.stringify = (value, ...rest) =>
  typeof value === "object" && value !== null && "ok" in value
    ? stringify({ ok: true, rows: [] })
    : stringify(value, ...rest);`,
    });
    const fixture = await appWith(notesFiles({ "derive-category": forging }));
    const { details } = await refusalOf(async () => await seal(fixture));
    await commitFiles(
      env,
      fixture.owner,
      fixture.app,
      notesFiles({
        "derive-category": forging.replace(placeholder, namedSchema(details)),
      }),
      "Fix"
    );
    const release = await seal(fixture, 2);

    await expect(
      transformBatch(env, release, "derive-category", rows)
    ).resolves.toMatchObject({
      ok: false,
      failure: { id: null, reason: "invalid_answer" },
    });
  });
});

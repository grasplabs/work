import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { activateVersion } from "../src/app-activation.ts";
import type { Release } from "../src/app-releases.ts";
import { commitFiles } from "../src/apps.ts";
import {
  transformBatch,
  transformBatchMaxRows,
} from "../src/migration-transform.ts";
import type { TransformRow } from "../src/migration-transform.ts";
import { SandboxUnavailableError } from "../src/sandboxed.ts";
import { reviewVersion } from "../src/version-review.ts";
import { appWith, failure, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";

// An App's explicit migrations (spec 17.2), sealed with its release and
// run by the host on batches of records, through the real compiler, seal
// and Loader isolates. What can go wrong, and the test that shows it
// doesn't (the sandbox's deadline, an unanswering supervisor and the
// network at run time on plain workerd: scripts/workerd-sandbox.test.ts):
//
// - A reviewer approves a transform to another schema than the release
//   seals: "is sealed only when it transforms to the release's schema";
//   or doesn't learn that it rewrites every record of its table: "is
//   listed in its version's review".
// - A migration is built from server code, or reaches the network while
//   its code loads: "is refused at the seal when …".
// - The transform writes a managed field, an undeclared key or a value of
//   the wrong type: "validates every output against the target table";
//   a document past the store's limit: "refuses a record its output would
//   make larger than a store holds"; drops or rewrites a field the target
//   doesn't declare: "derives each record's fields, keeping what the
//   target doesn't declare" and "passes a field the target doesn't
//   declare through unchanged, and refuses changing it".
// - App code sees a row it wasn't written for: "refuses a row that doesn't
//   fit its input before App code sees it", "hands the handler only the
//   fields its input declares".
// - One owner's data reaches another owner's record through module state:
//   "refuses a batch that mixes owners of a table with owner access".
// - A caller hands it managed fields, or a batch past its bounds: "refuses
//   rows holding managed fields", "refuses a batch past its bounds".
// - The transform answers differently each time, through the prototypes,
//   `Intl` or a `toJSON`: "takes away randomness and clocks …".
// - App code forges the runner's answer, answers too much, or fails
//   outside a handler: "refuses an answer that isn't its rows", "refuses
//   an answer past its bound".
// - The sandbox can't run it: "is unavailable, never the App's failure".

/** A schema hash no release seals: what an author writes before the seal tells them. */
const placeholder = "0".repeat(64);

/** The table migration `name` transforms: one of its own, as a store allows one migration a table. */
const tableOf = (name: string): string => name.replaceAll("-", "_");

/** The tables of an App migrating `names`: each one's own, or `notes` for none. */
const tablesOf = (names: readonly string[]): string[] =>
  names.length === 0 ? ["notes"] : names.map((name) => tableOf(name));

/** The schema of `names`' tables, each with `fields`. */
const schemaOf = (names: readonly string[], fields: string): string =>
  `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export const noteFields = {
${fields}
};

export default defineSchema({
${tablesOf(names)
  .map((table) => `  ${table}: defineTable(noteFields),`)
  .join("\n")}
});
`;

const baseFields = `  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),`;

/** The fields of a note after the migration: a category, required. */
const migratedFields = `${baseFields}
  category: v.enum(["launch", "general"]),`;

/** The App's registration, with `names`' migrations from `migrations/`. */
const appOf = (names: readonly string[], registered: boolean): string => {
  const access = tablesOf(names)
    .map((table) => `${table}: { read: "owner", write: "owner" }`)
    .join(", ");
  return `import { app } from "@grasp-os/sdk";
import schema from "./schema.ts";
${registered ? names.map((name, index) => `import m${index} from "./migrations/${name}.ts";`).join("\n") : ""}

export default app({
  name: "Notes",
  schema,
  access: { tables: { ${access} } },
  operations: {},
  screens: [],
  uses: [],
  migrations: [${registered ? names.map((_name, index) => `m${index}`).join(", ") : ""}],
});
`;
};

/** Notes before the migrations of `names`: no category yet. */
const baseFiles = (names: readonly string[]): Record<string, string> => ({
  "schema.ts": schemaOf(names, baseFields),
  "app.ts": appOf(names, false),
});

/** Notes, with `migrations` (file name to source) registered in order. */
const notesFiles = (
  migrations: Readonly<Record<string, string>>
): Record<string, string> => {
  const names = Object.keys(migrations);
  return {
    "schema.ts": schemaOf(names, migratedFields),
    ...Object.fromEntries(
      Object.entries(migrations).map(([name, source]) => [
        `migrations/${name}.ts`,
        source,
      ])
    ),
    "app.ts": appOf(names, true),
  };
};

/** Migration `name` of its own table, `fromSchema` to `toSchema`, with `handler`. */
const migrationSource = (
  name: string,
  handler: string,
  {
    fromSchema = "f".repeat(64),
    toSchema = placeholder,
    input = "",
    prelude = "",
  } = {}
): string => `import { migration, v } from "@grasp-os/sdk";
import { noteFields } from "../schema.ts";
${prelude}
export default migration({
  name: ${JSON.stringify(name)},
  fromSchema: ${JSON.stringify(fromSchema)},
  toSchema: ${JSON.stringify(toSchema)},
  table: ${JSON.stringify(tableOf(name))},
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

/**
 * More transforms, sealed in an App of their own: an App registers at most
 * `appMaxMigrations`.
 */
const moreHandlers = {
  "answers-too-much": `(ctx, row) => ({ title: row.title, body: "x".repeat(100000), category: "general" })`,
  "remembers-rows": `(() => {
    let seen = "";
    return (ctx, row) => {
      const title = seen === "" ? row.title : seen;
      seen = row.title;
      return { ...row, title, category: "general" };
    };
  })()`,
  "crypto-prototype": `(ctx, row) => ({ ...row, category: Object.getPrototypeOf(crypto).randomUUID.call(crypto) })`,
  "date-prototype": `(ctx, row) => ({ ...row, category: String(new (Object.getPrototypeOf(new Date(0)).constructor)()) })`,
  "intl-format": `(ctx, row) => ({ ...row, category: new Intl.DateTimeFormat("en").format() })`,
  "intl-parts": `(ctx, row) => ({ ...row, category: new Intl.DateTimeFormat("en").formatToParts()[0].value })`,
  "late-json": `(ctx, row) => ({ ...row, category: { toJSON: () => String(Math.random()) } })`,
  "formats-given-date": `(ctx, row) => ({ ...row, title: new Intl.DateTimeFormat("en", { timeZone: "UTC" }).format(new Date(0)), category: "general" })`,
  "formats-detached": `(ctx, row) => {
    const { format } = new Intl.DateTimeFormat("en", { timeZone: "UTC" });
    return { ...row, title: format(0), category: "general" };
  }`,
  "formats-detached-now": `(ctx, row) => {
    const { format } = new Intl.DateTimeFormat("en", { timeZone: "UTC" });
    return { ...row, title: format(), category: "general" };
  }`,
} as const;

type Name = keyof typeof handlers | keyof typeof moreHandlers;

/** What each migration declares as its input, when it declares one. */
const inputs: Readonly<Record<string, string>> = {
  "derive-category":
    "input: v.object({ title: noteFields.title, body: noteFields.body }),",
  "sees-input-only":
    "input: v.object({ title: noteFields.title, body: noteFields.body }),",
  "never-runs": "input: v.object({ title: noteFields.title }),",
};

/** The App's files with every migration of `group`, `fromSchema` to `toSchema`. */
const filesTo = (
  group: Readonly<Record<string, string>>,
  fromSchema: string,
  toSchema: string
): Record<string, string> =>
  notesFiles(
    Object.fromEntries(
      Object.entries(group).map(([name, handler]) => [
        name,
        migrationSource(name, handler, {
          fromSchema,
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
 * Notes sealed as version 1 without a category, then version `files`
 * makes (from version 1's schema) sealed as version 3, after version 2
 * named a wrong `toSchema` and the seal answered the one it must name.
 */
const sealedMigrating = async (
  names: readonly string[],
  files: (fromSchema: string, toSchema: string) => Record<string, string>
): Promise<{
  fixture: Fixture;
  release: Release;
  refused: { code: unknown; details: unknown };
}> => {
  const fixture = await appWith(baseFiles(names));
  const base = await seal(fixture);
  const fromSchema = base.manifest.schemaHash;
  await commitFiles(
    env,
    fixture.owner,
    fixture.app,
    files(fromSchema, placeholder),
    "Migrate"
  );
  const refused = await refusalOf(async () => await seal(fixture, 2));
  await commitFiles(
    env,
    fixture.owner,
    fixture.app,
    files(fromSchema, namedSchema(refused.details)),
    "Fix"
  );
  return { fixture, release: await seal(fixture, 3), refused };
};

/** An App with every migration of `group` sealed (`sealedMigrating`). */
const sealedTransforms = async (group: Readonly<Record<string, string>>) =>
  await sealedMigrating(Object.keys(group), (fromSchema, toSchema) =>
    filesTo(group, fromSchema, toSchema)
  );

/** Each App sealed once for the whole file, when first asked: a seal takes seconds. */
let sealedOnce: ReturnType<typeof sealedTransforms> | undefined;
let moreOnce: ReturnType<typeof sealedTransforms> | undefined;
const sealed = async () => await (sealedOnce ??= sealedTransforms(handlers));
const sealedMore = async () =>
  await (moreOnce ??= sealedTransforms(moreHandlers));

/** The owner of the records the tests transform. */
const owner = "u_owner";

/** A record of `owner` (by default the tests' one) with `fields`. */
const note = (id: string, fields: TransformRow["fields"], of = owner) => ({
  id,
  owner: of,
  fields,
});

/** Rows of notes, as a store holds them. */
const rows: TransformRow[] = [
  note("n1", { title: "Plan", body: "Launch on Monday" }),
  note("n2", { title: "Idea", body: "", legacy: "kept" }),
];

const run = async (name: Name, batch: readonly TransformRow[] = rows) => {
  const { release } = await (Object.hasOwn(handlers, name)
    ? sealed()
    : sealedMore());
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
      table: "derive_category",
      toSchema: release.manifest.schemaHash,
    });
  });

  it("is listed in its version's review with its table, every one when no version is current", async () => {
    const { fixture } = await sealed();
    const review = await reviewVersion(env, fixture.owner, fixture.app, 3);

    expect(review.migrations).toContainEqual({
      name: "derive-category",
      table: "derive_category",
      change: "added",
    });
    expect(review.migrations).toHaveLength(Object.keys(handlers).length);
  });

  it("is listed in the review when declared inline in app.ts", async () => {
    const inline = notesFiles({});
    inline["app.ts"] = `import { app, migration, v } from "@grasp-os/sdk";
import schema, { noteFields } from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: {},
  screens: [],
  uses: [],
  migrations: [
    migration({
      name: "inline-category",
      fromSchema: ${JSON.stringify("f".repeat(64))},
      toSchema: ${JSON.stringify(placeholder)},
      table: "notes",
      output: v.object(noteFields),
      handler: (ctx, row) => ({ ...row, category: "general" }),
    }),
  ],
});
`;
    const fixture = await appWith(inline);
    const review = await reviewVersion(env, fixture.owner, fixture.app, 1);

    expect(review.migrations).toStrictEqual([
      { name: "inline-category", table: "notes", change: "added" },
    ]);
  });

  it("is listed in the review when a version only registers a migration file the current one had", async () => {
    const source = migrationSource(
      "derive-category",
      handlers["derive-category"],
      {
        input: inputs["derive-category"],
      }
    );
    const unregistered = {
      ...notesFiles({ "derive-category": source }),
      "app.ts": appOf(["derive-category"], false),
    };
    const fixture = await appWith(unregistered);
    await activateVersion(env, fixture.owner, fixture.app, 1);
    const { version } = await commitFiles(
      env,
      fixture.owner,
      fixture.app,
      notesFiles({ "derive-category": source }),
      "Register"
    );
    const review = await reviewVersion(
      env,
      fixture.owner,
      fixture.app,
      version
    );

    expect(review.files.map(({ path }) => path)).toStrictEqual(["app.ts"]);
    expect(review.migrations).toStrictEqual([
      { name: "derive-category", table: "derive_category", change: "added" },
    ]);
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
        note("n1", {
          title: "Plan",
          body: "Launch on Monday",
          category: "launch",
        }),
        note("n2", {
          title: "Idea",
          body: "",
          category: "general",
          legacy: "kept",
        }),
      ],
    });
  });

  it("hands the handler only the fields its input declares, normalized", async () => {
    const outcome = await run("sees-input-only", [
      note("n1", { title: "Plan", legacy: "kept" }),
    ]);

    expect(outcome).toStrictEqual({
      ok: true,
      rows: [
        note("n1", {
          title: "body,title",
          body: "",
          category: "general",
          legacy: "kept",
        }),
      ],
    });
  });

  it("refuses a row that doesn't fit its input before App code sees it", async () => {
    await expect(
      run("never-runs", [
        note("n1", { title: "Plan" }),
        note("n2", { title: 7 }),
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
        note("n1", { title: "Plan", legacy: "y".repeat(40_000) }),
      ])
    ).resolves.toMatchObject({
      ok: false,
      failure: { id: "n1", reason: "too_large" },
    });
  });

  it("passes a field the target doesn't declare through unchanged, and refuses changing it", async () => {
    const retained = [note("n2", { title: "Idea", legacy: "kept" })];

    await expect(run("spreads-row", retained)).resolves.toStrictEqual({
      ok: true,
      rows: [
        note("n2", {
          title: "Idea",
          body: "",
          category: "general",
          legacy: "kept",
        }),
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

  it("refuses a batch that mixes owners of a table with owner access, which only a caller's bug sends", async () => {
    // The handler carries the previous row's title into the next one:
    // within one owner's batch that's their own data; across owners it
    // would hand one owner's note to another.
    const mixed = [
      note("n1", { title: "Mine" }, "u_alice"),
      note("n2", { title: "Theirs" }, "u_bob"),
    ];
    await expect(run("remembers-rows", mixed)).rejects.toThrow(/mixes owners/u);
    await expect(
      run("remembers-rows", [
        note("n1", { title: "Mine" }, "u_alice"),
        note("n2", { title: "Also mine" }, "u_alice"),
      ])
    ).resolves.toMatchObject({
      ok: true,
      rows: [
        { owner: "u_alice", fields: { title: "Mine" } },
        { owner: "u_alice", fields: { title: "Mine" } },
      ],
    });
  });

  it("refuses rows holding managed fields, which only a caller's bug sends", async () => {
    await expect(
      run("spreads-row", [note("n1", { title: "Plan", _ownerId: "u_bob" })])
    ).rejects.toThrow(/managed fields/u);
  });

  it.each([
    ["crypto-prototype", "randomness"],
    ["date-prototype", "the clock"],
    ["intl-format", "the clock"],
    ["formats-detached-now", "the clock"],
    ["intl-parts", "the clock"],
    ["late-json", "randomness"],
  ] as const)(
    "takes away randomness and clocks: %s is refused",
    async (name, refused) => {
      const outcome = await run(name, [note("n1", { title: "Plan" })]);
      expect(outcome).toMatchObject({
        ok: false,
        failure: { id: "n1", reason: "threw" },
      });
      expect(outcome.ok ? [] : outcome.failure.issues).toStrictEqual([
        `A migration is pure: ${refused} isn't available while it transforms rows.`,
      ]);
    }
  );

  it.each(["formats-given-date", "formats-detached"] as const)(
    "still formats a date it is given: %s",
    async (name) => {
      await expect(
        run(name, [note("n1", { title: "Plan" })])
      ).resolves.toMatchObject({
        ok: true,
        rows: [{ fields: { title: "1/1/1970" } }],
      });
    }
  );

  it("refuses an answer past its bound", async () => {
    const many = Array.from({ length: 45 }, (_, index) =>
      note(`n${index}`, { title: "Note" })
    );
    const outcome = await run("answers-too-much", many);
    expect(outcome).toMatchObject({
      ok: false,
      failure: { id: null, reason: "invalid_answer" },
    });
    expect(outcome.ok ? "" : outcome.failure.issues.join(",")).toContain(
      "The migration's answer is too large."
    );
  });

  it("is unavailable, never the App's failure, where no sandbox bounds it", async () => {
    const { release } = await sealed();
    await expect(
      transformBatch(
        {
          ...env,
          RUNTIME_PROFILE: "workerd",
          SANDBOX_HOST: undefined,
          SANDBOX_IN_PROCESS: undefined,
        },
        release,
        "derive-category",
        rows
      )
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("refuses a batch past its bounds, which only a caller's bug sends", async () => {
    const many = Array.from({ length: transformBatchMaxRows + 1 }, (_, index) =>
      note(`n${index}`, { title: "Note", body: "" })
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
    const forgingPrelude = `const stringify = JSON.stringify;
JSON.stringify = (value, ...rest) =>
  typeof value === "object" && value !== null && "ok" in value
    ? stringify({ ok: true, rows: [] })
    : stringify(value, ...rest);`;
    const { release } = await sealedMigrating(
      ["derive-category"],
      (fromSchema, toSchema) =>
        notesFiles({
          "derive-category": migrationSource(
            "derive-category",
            "(ctx, row) => row",
            {
              fromSchema,
              toSchema,
              prelude: forgingPrelude,
            }
          ),
        })
    );

    await expect(
      transformBatch(env, release, "derive-category", rows)
    ).resolves.toMatchObject({
      ok: false,
      failure: { id: null, reason: "invalid_answer" },
    });
  });
});

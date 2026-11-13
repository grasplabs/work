import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Release } from "../src/app-releases.ts";
import { reviewDraft } from "../src/app-review.ts";
import {
  transformBatch,
  failedOutside,
  inputMismatch,
  outputMismatch,
  threwOnRecord,
  transformBatchMaxRows,
} from "../src/migration-run.ts";
import type { TransformRow } from "../src/migration-run.ts";
import { SandboxUnavailableError } from "../src/sandboxed.ts";
import { testApp, withFiles } from "./app-definitions.ts";
import type { TableSpec, TestApp } from "./app-definitions.ts";
import { commitDefined } from "./apps.ts";
import { appWith, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";

// An App's explicit migrations (spec 17.2), sealed with its release and
// run by the host on batches of records, through the real compiler, seal
// and Loader isolates. What can go wrong, and the test that shows it
// doesn't (the sandbox's deadline, an unanswering supervisor and the
// network at run time on plain workerd:
// scripts/workerd-sandbox-inspection.test.ts):
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
//   "refuses a batch that mixes owners of a table with owner access"; one
//   person's or team's on a table with row rules: "refuses a batch that
//   mixes two people's or two teams' rows", and fixtures of different
//   people run a batch each: "runs fixtures of different people …".
// - The transform moves a record into someone else's sight by rewriting
//   a field a row rule reads: "refuses an output that changes a field a
//   row rule reads".
// - The transform writes a record its builders can't read into its
//   failure, through what it throws, a stack it forges or a key it
//   writes: "shows nothing App code can influence of a failure …", "names
//   the record whose transform threw, but not what it said …",
//   "validates every output against the target table".
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

/** `fields` as the App's values.ts exports them, as `name`, for its migrations. */
const valuesOf = (
  name: string,
  fields: Readonly<Record<string, string>>
): string => `import { v } from "@grasp-os/sdk";

export const ${name} = {
${Object.entries(fields)
  .map(([field, type]) => `  ${field}: ${type},`)
  .join("\n")}
};
`;

/** The definition of `names`' tables, each with `fields`, and the fields as values.ts exports them. */
const schemaOf = (
  names: readonly string[],
  fields: Readonly<Record<string, string>>
): TestApp =>
  testApp(
    {
      name: "Notes",
      tables: Object.fromEntries(
        tablesOf(names).map((table) => [
          table,
          { fields, access: { read: "owner", write: "owner" } },
        ])
      ),
    },
    {
      "values.ts": valuesOf("noteFields", fields),
    }
  );

const baseFields = {
  title: "v.string().trim().min(1).max(200)",
  body: 'v.string().max(100_000).default("")',
};

/** The fields of a note after the migration: a category, required. */
const migratedFields = {
  ...baseFields,
  category: 'v.enum(["launch", "general"])',
};

/** Notes before the migrations of `names`: no category yet. */
const baseFiles = (names: readonly string[]): TestApp =>
  schemaOf(names, baseFields);

/** Notes, with `migrations` (file name to source) registered in order. */
const notesFiles = (migrations: Readonly<Record<string, string>>): TestApp => {
  const names = Object.keys(migrations);
  return withFiles(
    schemaOf(names, migratedFields),
    Object.fromEntries(
      Object.entries(migrations).map(([name, source]) => [
        `server/migrations/${name}.ts`,
        source,
      ])
    )
  );
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
    fixtures = '[{ row: { title: "Fixture" } }]',
  } = {}
): string => `import { defineMigration, v } from "@grasp-os/sdk";
import { noteFields } from "../../values.ts";
${prelude}
export default defineMigration({
  name: ${JSON.stringify(name)},
  fromSchema: ${JSON.stringify(fromSchema)},
  toSchema: ${JSON.stringify(toSchema)},
  table: ${JSON.stringify(tableOf(name))},
  ${input}
  output: v.object(noteFields),
  fixtures: ${fixtures},
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
  // Past the types (`as never`), as an attacker's code would: the host
  // refuses what these write, whatever their types say.
  "writes-managed": `(ctx, row) => ({ ...row, category: "general", _id: "n_forged" }) as never`,
  "writes-undeclared": `(ctx, row) => ({ ...row, category: "general", priority: 1 }) as never`,
  "writes-wrong-type": `(ctx, row) => ({ ...row, category: 42 }) as never`,
  "writes-too-much": `(ctx, row) => ({ ...row, title: String(row.title), category: "general", body: "x".repeat(100000) })`,
  "spreads-row": `(ctx, row) => ({ ...row, title: String(row.title), category: "general" })`,
  "rewrites-retained": `(ctx, row) => ({ ...row, category: "general", legacy: "changed" }) as never`,
  throws: `(ctx, row) => {
    if (ctx.id === "n2") throw new Error("Can't tell this one's category");
    return { ...row, title: String(row.title), category: "general" };
  }`,
  "never-runs": `() => { throw new Error("App code ran"); }`,
} as const;

/**
 * More transforms, sealed in an App of their own: an App registers at most
 * `appMaxMigrations`.
 */
const moreHandlers = {
  "answers-too-much": `(ctx, row) => ({ title: String(row.title), body: "x".repeat(100000), category: "general" })`,
  "remembers-rows": `(() => {
    let seen = "";
    return (ctx, row) => {
      const title = seen === "" ? String(row.title) : seen;
      seen = String(row.title);
      return { ...row, title, category: "general" };
    };
  })()`,
  // Past the types (`as never`), as an attacker's code would: the
  // sandbox takes randomness and clocks away, whatever the types say.
  "crypto-prototype": `(ctx, row) => ({ ...row, category: Object.getPrototypeOf(crypto).randomUUID.call(crypto) }) as never`,
  "date-prototype": `(ctx, row) => ({ ...row, category: String(new (Object.getPrototypeOf(new Date(0)).constructor)()) }) as never`,
  "intl-format": `(ctx, row) => ({ ...row, category: new Intl.DateTimeFormat("en").format() }) as never`,
  "intl-parts": `(ctx, row) => ({ ...row, category: new Intl.DateTimeFormat("en").formatToParts()[0].value }) as never`,
  "late-json": `(ctx, row) => ({ ...row, category: { toJSON: () => String(Math.random()) } }) as never`,
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
): TestApp =>
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
  files: (fromSchema: string, toSchema: string) => TestApp,
  first: TestApp = baseFiles(names)
): Promise<{
  fixture: Fixture;
  release: Release;
  refused: { code: unknown; details: unknown };
}> => {
  const fixture = await appWith(first);
  const base = await seal(fixture);
  const fromSchema = base.manifest.schemaHash;
  await commitDefined(
    env,
    fixture.owner,
    fixture.app,
    files(fromSchema, placeholder),
    "Migrate"
  );
  const refused = await refusalOf(async () => await seal(fixture, 2));
  await commitDefined(
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

/**
 * What sealing `source` as migration `name` answers: "ok", or the
 * refusal's code and the files its diagnostics name. A type error is
 * refused as the code is checked, before the migration's `toSchema` is;
 * once past that, its `toSchema` is the one the seal names.
 */
const sealedSource = async (
  name: string,
  source: (fromSchema: string, toSchema: string) => string
): Promise<{ code: unknown; files: string[] }> => {
  const fixture = await appWith(baseFiles([name]));
  const base = await seal(fixture);
  const fromSchema = base.manifest.schemaHash;
  const commit = async (toSchema: string) =>
    await commitDefined(
      env,
      fixture.owner,
      fixture.app,
      notesFiles({ [name]: source(fromSchema, toSchema) }),
      "Migrate"
    );
  await commit(placeholder);
  const named = await refusalOf(async () => await seal(fixture, 2));
  let refused = named;
  if (named.code === "version.invalid_migration") {
    await commit(namedSchema(named.details));
    refused = await refusalOf(async () => await seal(fixture, 3));
  }
  const { code, details } = refused;
  const diagnostics: unknown =
    typeof details === "object" && details !== null
      ? Reflect.get(details, "diagnostics")
      : undefined;
  return {
    code,
    files: Array.isArray(diagnostics)
      ? [
          ...new Set(
            diagnostics.map((diagnostic: unknown) =>
              String(
                typeof diagnostic === "object" && diagnostic !== null
                  ? Reflect.get(diagnostic, "file")
                  : diagnostic
              )
            )
          ),
        ].toSorted()
      : [],
  };
};

describe("a migration's types", { timeout: 120_000 }, () => {
  it.each([
    [
      "seals a spread of the previous shape it declares, with the field it adds",
      "input: v.object({ title: noteFields.title }),",
      '(ctx, row) => ({ ...row, category: "general" })',
      { code: "ok", files: [] },
    ],
    [
      "refuses a field of the wrong type for its table",
      "input: v.object({ title: noteFields.title }),",
      "(ctx, row) => ({ ...row, category: 42 })",
      { code: "version.build_failed", files: ["server/migrations/typed.ts"] },
    ],
    [
      "refuses a spread of a row it declares no shape for, which lacks a field its table requires",
      "",
      '(ctx, row) => ({ ...row, category: "general" })',
      { code: "version.build_failed", files: ["server/migrations/typed.ts"] },
    ],
  ])("%s", async (_case, input, handler, expected) => {
    await expect(
      sealedSource("typed", (fromSchema, toSchema) =>
        migrationSource("typed", handler, { fromSchema, toSchema, input })
      )
    ).resolves.toStrictEqual(expected);
  });
});

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

  it("is listed in a draft's changes with its table and how many fixtures publishing runs it on, every one when no version is live", async () => {
    const { fixture } = await sealed();
    const review = await reviewDraft(
      env,
      fixture.owner,
      { id: fixture.app, currentVersion: null },
      { base: 3, changes: {}, definition: null, revision: 0 }
    );

    expect(review.migrations).toContainEqual({
      name: "derive-category",
      table: "derive_category",
      change: "added",
      fixtures: 1,
    });
    expect(review.migrations).toContainEqual({
      name: "writes-managed",
      table: "writes_managed",
      change: "added",
      fixtures: 1,
    });
    expect(review.migrations).toHaveLength(Object.keys(handlers).length);
  });

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
    // Each owner's notes: the failure names only the declared fields it
    // fails on, never a key the output made up.
    ["writes-managed", [outputMismatch]],
    ["writes-undeclared", [outputMismatch]],
    ["writes-wrong-type", [outputMismatch, "category: doesn't fit"]],
  ] as const)(
    "validates every output against the target table: %s is refused",
    async (name, issues) => {
      await expect(run(name)).resolves.toStrictEqual({
        ok: false,
        failure: { id: "n1", reason: "invalid_output", issues },
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

  it("names the record whose transform threw, but not what it said, on a table each owner reads alone", async () => {
    await expect(run("throws")).resolves.toStrictEqual({
      ok: false,
      failure: { id: "n2", reason: "threw", issues: [threwOnRecord] },
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
    await expect(run("remembers-rows", mixed)).rejects.toThrow(
      /shows to different people/u
    );
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

/** Who reads and writes the table of salary migration `name` (see below). */
const salaryAccess = (name: string): TableSpec["access"] => {
  if (name.startsWith("none-")) {
    return { read: "none", write: "appMembers" };
  }
  if (name.startsWith("open-")) {
    return { read: "appMembers", write: "appMembers" };
  }
  return {
    read: "appMembers",
    write: "appMembers",
    rows: {
      read: [
        { kind: "person", field: "employee" },
        { kind: "team", field: "team" },
      ],
    },
  };
};

/**
 * Salaries read by the person each names and the team it is for, each
 * migration's table its own, with `fields`; an `open-` or `none-`
 * migration's table has no rules: an `open-` one's members read it, and
 * no one reads a `none-` one's.
 */
const salariesSchema = (
  names: readonly string[],
  fields: Readonly<Record<string, string>>
): TestApp =>
  testApp(
    {
      name: "Notes",
      tables: Object.fromEntries(
        names.map((name) => [
          tableOf(name),
          { fields, access: salaryAccess(name) },
        ])
      ),
    },
    {
      "values.ts": valuesOf("salaryFields", fields),
    }
  );

const salaryBase = {
  employee: "v.person()",
  team: "v.string()",
  amount: "v.number()",
};

/** Module state of each salary migration: the row before, while a call lasts. */
const salaryPrelude = "let previous: number | undefined;";

/** Transforms of salaries: each adds a band, as version 2 requires. */
const salaryHandlers = {
  // Carries the previous row's amount into the next one, through the
  // module state a batch's rows share (`previous`, `salaryPrelude`):
  // within one person's rows that is their own; across people it would
  // show one's salary to another.
  "carries-amount": `(ctx, row) => {
    const amount = previous ?? row.amount;
    previous = row.amount;
    return { ...row, amount, band: amount > 50000 ? "high" : "low" };
  }`,
  // Hands every salary to its author, or to their team, to read.
  "hands-to-me": `(ctx, row) => ({ ...row, employee: "u_mallory", band: "low" })`,
  "moves-team": `(ctx, row) => ({ ...row, team: "t_mallory", band: "low" })`,
  // Writes the salary into its failure, which the builder is shown.
  "throws-amount": `(ctx, row) => {
    throw new Error(\`Salary: \${row.amount}\`);
  }`,
  // The same, past the stack too: a forged one, its column the salary.
  "forges-stack": `(ctx, row) => {
    const error = new Error("Nothing to see");
    error.stack = \`Error\\n    at handler (app~migrations~forges-stack.js:1:\${row.amount})\`;
    throw error;
  }`,
  // The salary as a key of its output, which validation names.
  "keys-amount": `(ctx, row) => ({ ...row, band: "low", [String(row.amount)]: 1 }) as never`,
  "open-throws-amount": `(ctx, row) => {
    throw new Error(\`Salary: \${row.amount}\`);
  }`,
  "none-throws-amount": `(ctx, row) => {
    throw new Error(\`Salary: \${row.amount}\`);
  }`,
  // Throws the salary outside its own body: as the isolate serializes
  // the batch's answer, after the handler returned.
  // (A `toJSON` every object inherits, which throws only on the runner's
  // answer, the one object with an own `ok`.)
  "stringifies-amount": `(ctx, row) => {
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value(this: object): unknown {
        if (Object.hasOwn(this, "ok")) {
          throw new Error(\`Salary: \${row.amount}\`);
        }
        return this;
      },
    });
    return { ...row, band: "low" };
  }`,
  // Declares an input no salary under 100,000 fits (`refinedInput`).
  "refines-amount": `(ctx, row) => ({ ...row, band: "high" })`,
  "open-refines-amount": `(ctx, row) => ({ ...row, band: "high" })`,
} as const;

/** An input that refines a salary's amount: none under 100,000 fits. */
const refinedInput =
  "input: v.object({ employee: noteFields.employee, team: noteFields.team, amount: v.number().min(100000) }),";

/** What each salary migration's fixtures are: two people's, as records are. */
const salaryFixtures = `[
    { row: { employee: "u_ann", team: "t_a", amount: 70000 }, expect: { employee: "u_ann", team: "t_a", amount: 70000, band: "high" } },
    { row: { employee: "u_bob", team: "t_a", amount: 30000 }, expect: { employee: "u_bob", team: "t_a", amount: 30000, band: "low" } },
  ]`;

let salariesOnce: ReturnType<typeof sealedMigrating> | undefined;
const sealedSalaries = async () =>
  await (salariesOnce ??= sealedMigrating(
    Object.keys(salaryHandlers),
    (fromSchema, toSchema) => {
      const names = Object.keys(salaryHandlers);
      return withFiles(
        salariesSchema(names, {
          ...salaryBase,
          band: 'v.enum(["low", "high"])',
        }),
        Object.fromEntries(
          Object.entries(salaryHandlers).map(([name, handler]) => [
            `server/migrations/${name}.ts`,
            migrationSource(name, handler, {
              fromSchema,
              toSchema,
              fixtures: salaryFixtures,
              prelude: salaryPrelude,
              input: name.endsWith("refines-amount")
                ? refinedInput
                : "input: v.object({ employee: noteFields.employee, team: noteFields.team, amount: noteFields.amount }),",
            }).replaceAll("noteFields", "salaryFields"),
          ])
        )
      );
    },
    salariesSchema(Object.keys(salaryHandlers), salaryBase)
  ));

/** A salary record of `employee` in `team`. */
const salary = (
  id: string,
  employee: string,
  team: string,
  amount: number
): TransformRow => ({
  id,
  owner: "u_importer",
  fields: { employee, team, amount },
});

// A builder, or the AI for them, who can't read Bob's salary ships a
// migration of a table whose row rules read who a row is for: carrying
// Bob's amount into their own row through module state, or handing his
// row to themselves or their team, would let them read it.
describe("transforming a table with row rules", { timeout: 120_000 }, () => {
  const runSalaries = async (
    name: keyof typeof salaryHandlers,
    batch: readonly TransformRow[]
  ) => {
    const { release } = await sealedSalaries();
    return await transformBatch(env, release, name, batch);
  };

  it("refuses a batch that mixes two people's or two teams' rows, which only a caller's bug sends", async () => {
    await expect(
      runSalaries("carries-amount", [
        salary("s1", "u_bob", "t_a", 90_000),
        salary("s2", "u_mallory", "t_a", 30_000),
      ])
    ).rejects.toThrow(/shows to different people/u);
    await expect(
      runSalaries("carries-amount", [
        salary("s1", "u_bob", "t_a", 90_000),
        salary("s2", "u_bob", "t_b", 30_000),
      ])
    ).rejects.toThrow(/shows to different people/u);
    // One person's rows of one team: what carries stays theirs.
    await expect(
      runSalaries("carries-amount", [
        salary("s1", "u_bob", "t_a", 90_000),
        salary("s2", "u_bob", "t_a", 30_000),
      ])
    ).resolves.toMatchObject({
      ok: true,
      rows: [
        { fields: { employee: "u_bob", amount: 90_000 } },
        { fields: { employee: "u_bob", amount: 90_000 } },
      ],
    });
  });

  it("shows nothing App code can influence of a failure on a record its table hides: not what it threw, in its handler or after, a stack it forged, a key it wrote or an input it refused", async () => {
    const record = [salary("s1", "u_bob", "t_a", 91_234)];
    const thrown = await runSalaries("throws-amount", record);
    const forged = await runSalaries("forges-stack", record);
    const keyed = await runSalaries("keys-amount", record);
    const outside = await runSalaries("stringifies-amount", record);
    const refined = await runSalaries("refines-amount", record);
    // A table no one reads hides as much.
    const unread = await runSalaries("none-throws-amount", record);
    // On a table every member reads, what it threw is shown as it said.
    const open = await runSalaries("open-throws-amount", record);

    const threw = {
      ok: false,
      failure: { id: "s1", reason: "threw", issues: [threwOnRecord] },
    };
    expect({
      thrown,
      forged,
      keyed,
      outside,
      refined,
      unread,
      open,
      leaked: JSON.stringify([
        thrown,
        forged,
        keyed,
        outside,
        refined,
        unread,
      ]).includes("91234"),
    }).toStrictEqual({
      thrown: threw,
      forged: threw,
      keyed: {
        ok: false,
        failure: {
          id: "s1",
          reason: "invalid_output",
          issues: [outputMismatch],
        },
      },
      outside: {
        ok: false,
        failure: {
          id: null,
          reason: "invalid_answer",
          issues: [failedOutside],
        },
      },
      refined: {
        ok: false,
        failure: {
          id: "s1",
          reason: "invalid_input",
          issues: [inputMismatch, "amount: doesn't fit"],
        },
      },
      unread: threw,
      open: {
        ok: false,
        failure: { id: "s1", reason: "threw", issues: ["Salary: 91234"] },
      },
      leaked: false,
    });
  });

  it("shows a record that doesn't fit the migration's input in full on a table every member reads", async () => {
    const outcome = await runSalaries("open-refines-amount", [
      salary("s1", "u_bob", "t_a", 91_234),
    ]);

    expect(outcome).toMatchObject({
      ok: false,
      failure: { id: "s1", reason: "invalid_input" },
    });
    const issues = outcome.ok ? [] : outcome.failure.issues;
    expect(issues).not.toContain(inputMismatch);
    expect(issues).toStrictEqual([expect.stringMatching(/^amount: ./u)]);
  });

  it("runs fixtures of different people a batch each as the release is sealed", async () => {
    const { release } = await sealedSalaries();
    const evidence = new Map(
      release.manifest.migrationEvidence.map((found) => [
        found.migration,
        found,
      ])
    );
    expect(evidence.get("carries-amount")?.failure ?? null).toBeNull();
  });
});

describe("App code that forges its answer", { timeout: 120_000 }, () => {
  it("refuses an answer that isn't its rows", async () => {
    // The App's code makes the runner in its isolate answer fewer rows
    // than it was sent, as though they had been transformed.
    // Past the types, as an attacker's code would: it forges at run time.
    const forgingPrelude = `const stringify = JSON.stringify;
Reflect.set(JSON, "stringify", (value: unknown, ...rest: unknown[]) =>
  typeof value === "object" && value !== null && "ok" in value
    ? stringify({ ok: true, rows: [] })
    : Reflect.apply(stringify, JSON, [value, ...rest]));`;
    const { release } = await sealedMigrating(
      ["derive-category"],
      (fromSchema, toSchema) =>
        notesFiles({
          "derive-category": migrationSource(
            "derive-category",
            "(ctx, row) => row as never",
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

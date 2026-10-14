import { canonicalText } from "@grasp-os/shared/json";
import { describe, expect, test } from "vite-plus/test";

import { databaseWriter } from "../src/database.ts";
import { inspectApp, readAppManifest } from "../src/host.ts";
import { AppError, app, resource } from "../src/index.ts";
import type { AppDefinition } from "../src/index.ts";
import { readResourceDeclaration } from "../src/resources.ts";
import { runFunction } from "../src/runner.ts";
import { serverModule } from "../src/server.ts";
import { defineSchema, defineTable, v } from "../src/values.ts";

// How an App registers its server functions, and what inspection makes of
// them (spec 7.1, 7.4, 7.5): pure checks of a declaration, so unit tests.
// That the host enforces the result is tested through the host
// (apps/core/test/operations.test.ts).

const schema = defineSchema({
  notes: defineTable({
    title: v.string(),
    rank: v.number().optional(),
    body: v.string().default(""),
  }),
  people: defineTable({ name: v.string() }),
});

const server = serverModule(schema);

const list = server.query({
  args: {},
  returns: v.null(),
  handler: () => null,
});
const create = server.mutation({
  args: { title: v.string() },
  returns: v.null(),
  handler: () => null,
});
const send = server.action({
  args: {},
  returns: v.null(),
  handler: () => null,
});
const secret = server.internalQuery({
  args: {},
  returns: v.null(),
  handler: () => null,
});

type Registration = AppDefinition<(typeof schema)["tables"]>;

// SAFETY: deliberately ill-typed views, for declarations the types refuse.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const looseApp = app as (definition: unknown) => unknown;
// SAFETY: as above.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const looseQuery = server.query as (declaration: unknown) => unknown;
// SAFETY: as above.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const looseAction = server.action as (declaration: unknown) => unknown;
// SAFETY: as above.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const LooseAppError = AppError as new (
  code: unknown,
  message: unknown,
  details?: unknown
) => AppError;

/** The Notes registration. */
const registration: Registration = {
  name: "Notes",
  schema,
  access: {
    tables: {
      notes: { read: "appMembers", write: "owner" },
      people: { read: "appMembers" },
    },
  },
  operations: { notes: { list, create, send } },
  screens: [],
  uses: [],
};

/** Notes, with `changes` to its registration. */
const notes = (changes: Partial<Registration> = {}) =>
  app({ ...registration, ...changes });

/** Registers Notes with `changes` the types refuse. */
const looseNotes = (changes: object) =>
  looseApp({ ...registration, ...changes });

/**
 * A connector declaration of `contract`, read back as the host reads a
 * manifest's: in code a contract is one of the catalog's, so any other
 * string arrives only as data.
 */
const connectorOf = (contract: string) =>
  readResourceDeclaration({
    "~resource": "connector",
    alias: "mail",
    contract,
    actions: ["send"],
  });

/** A store declaration of `operations`, read back as the host reads a manifest's. */
const declare = (operations: unknown) => () =>
  readResourceDeclaration({ "~resource": "store", alias: "crm", operations });

const refusal = (register: () => unknown): string => {
  try {
    register();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("The registration was accepted");
};

describe("access", () => {
  test("a table or mode the App doesn't declare is none", () => {
    const { manifest } = inspectApp(
      notes({ access: { tables: { notes: { read: "owner" } } } })
    );
    expect(manifest.schema.tables.notes?.access).toStrictEqual({
      read: "owner",
      write: "none",
    });
    expect(manifest.schema.tables.people?.access).toStrictEqual({
      read: "none",
      write: "none",
    });
    expect(manifest.operations["notes.create"]?.tables.people).toStrictEqual({
      read: false,
      insert: false,
      update: false,
      delete: false,
    });
  });

  test("each kind gets only its own capacity", () => {
    const { manifest } = inspectApp(notes());
    expect(manifest.operations["notes.list"]?.tables.notes).toStrictEqual({
      read: true,
      insert: false,
      update: false,
      delete: false,
    });
    expect(manifest.operations["notes.create"]?.tables.notes).toStrictEqual({
      read: true,
      insert: true,
      update: true,
      delete: true,
    });
    // An action has no direct data capacity at all.
    expect(manifest.operations["notes.send"]?.tables.notes).toStrictEqual({
      read: false,
      insert: false,
      update: false,
      delete: false,
    });
  });

  test("an override narrows, and a verb or table it leaves out is denied", () => {
    const { manifest } = inspectApp(
      notes({
        operationAccess: {
          "notes.create": { tables: { notes: { insert: true } } },
        },
      })
    );
    expect(manifest.operations["notes.create"]?.tables).toStrictEqual({
      notes: { read: false, insert: true, update: false, delete: false },
      people: { read: false, insert: false, update: false, delete: false },
    });
    // Functions without one keep the App's scope.
    expect(manifest.operations["notes.list"]?.tables.notes?.read).toBeTruthy();
  });

  test.each([
    [
      "a verb the App's mode doesn't allow",
      { "notes.create": { tables: { people: { insert: true } } } },
      "widens access",
    ],
    [
      "a read the App's mode doesn't allow",
      {
        "notes.list": { tables: { notes: { read: true }, people: {} } },
        "notes.create": { tables: { people: { read: true, delete: true } } },
      },
      "widens access",
    ],
    [
      "a query writing",
      { "notes.list": { tables: { notes: { read: true, insert: true } } } },
      "a query only reads",
    ],
    [
      "an action at all",
      { "notes.send": { tables: { notes: { read: false } } } },
      "an action has no tables",
    ],
    [
      "an unknown path",
      { "notes.missing": { tables: {} } },
      "isn't registered",
    ],
    [
      "an internal-looking unknown path",
      { secret: { tables: {} } },
      "isn't registered",
    ],
    [
      "an unknown table",
      { "notes.create": { tables: { invoices: { read: false } } } },
      "doesn't have",
    ],
    [
      "an unknown verb",
      { "notes.create": { tables: { notes: { upsert: false } } } },
      "has no verb",
    ],
    [
      "a verb that isn't a boolean",
      { "notes.create": { tables: { notes: { insert: "yes" } } } },
      "is a boolean",
    ],
    [
      "a key besides tables",
      { "notes.create": { tables: {}, admin: true } },
      "is `{ tables }`",
    ],
  ])("an override with %s is refused", (_case, operationAccess, message) => {
    expect(refusal(() => looseNotes({ operationAccess }))).toContain(message);
  });
});

describe("resources", () => {
  test("are frozen all the way down, so nothing checked can change before registration", () => {
    const model = resource.model("summarizer", {
      structuredOutput: v.object({ summary: v.string() }),
      maxOutputTokens: 100,
    });
    const knowledge = resource.knowledge("help", {
      operations: ["search"],
      collections: ["handbook"],
    });
    const connector = resource.connector("mail", {
      contract: "microsoft-365.mail@1",
      actions: ["send"],
    });
    const template = resource.template("letter", {
      contract: "grasp.letter@1",
    });
    const fields =
      model.structuredOutput?.kind === "object"
        ? model.structuredOutput.fields
        : {};
    expect({
      operation: Reflect.set(knowledge.operations, 0, "read"),
      added: Reflect.set(knowledge.operations, 1, "read"),
      collection: Reflect.set(knowledge.collections, 0, "secret"),
      action: Reflect.set(connector.actions, 0, "delete"),
      output: Reflect.set(fields, "extra", { kind: "string" }),
      outputKind: Reflect.set(model.structuredOutput ?? {}, "kind", "string"),
      contract: Reflect.set(template, "contract", "grasp.other@1"),
    }).toStrictEqual({
      operation: false,
      added: false,
      collection: false,
      action: false,
      output: false,
      outputKind: false,
      contract: false,
    });
    expect([
      knowledge.operations,
      connector.actions,
      model.structuredOutput?.kind,
    ]).toStrictEqual([["search"], ["send"], "object"]);
  });

  test("a store declaration reads back as code declared it, and calls only a store's queries and mutations", () => {
    const store = resource.store("crm", {
      operations: {
        "contacts.list": {
          kind: "query",
          args: { limit: v.number().optional() },
          returns: v.array(v.string()),
        },
        "contacts.add": {
          kind: "mutation",
          args: { name: v.string() },
          returns: v.null(),
        },
      },
    });
    // As a manifest holds it: data, read back through the same checks.
    const read = readResourceDeclaration(structuredClone(store));
    const shape = {
      kind: "query",
      args: store.operations["contacts.list"]?.args,
      returns: store.operations["contacts.list"]?.returns,
    };
    expect({
      read: JSON.stringify(read) === JSON.stringify(store),
      frozen: Reflect.set(store.operations, "contacts.remove", shape),
    }).toStrictEqual({ read: true, frozen: false });
    expect(
      [
        refusal(declare({ "contacts.ping": { ...shape, kind: "action" } })),
        refusal(declare({ "contacts..list": shape })),
        refusal(declare({ "a.b.c.d.e": shape })),
        refusal(declare({})),
        refusal(
          declare({ "contacts.list": { ...shape, args: shape.returns } })
        ),
        refusal(declare({ "contacts.list": { ...shape, extra: true } })),
      ].map((message) => message.length > 0)
    ).toStrictEqual([true, true, true, true, true, true]);
    expect(
      refusal(declare({ "contacts.ping": { ...shape, kind: "action" } }))
    ).toContain("never its actions");
  });
});

/** Declares statistics with `config`, one the types may refuse. */
const statistics = (config: unknown) => () =>
  // SAFETY: a config the types refuse, checked at run time.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  resource.statistics("stats", config as { operations: ["read"] });

describe("a statistics declaration", () => {
  test("reads back as code declared it, and reads only the platform's measures it lists, with `read`", () => {
    const own = resource.statistics("stats", { operations: ["record"] });
    const platform = resource.statistics("platform", {
      operations: ["read"],
      platform: ["platform.workflow_runs"],
    });
    expect({
      own: JSON.stringify(readResourceDeclaration(structuredClone(own))),
      platform: JSON.stringify(
        readResourceDeclaration(structuredClone(platform))
      ),
      frozen: Reflect.set(platform.platform, 1, "platform.improvement_signals"),
      ownPlatform: own.platform,
    }).toStrictEqual({
      own: JSON.stringify(own),
      platform: JSON.stringify(platform),
      frozen: false,
      ownPlatform: [],
    });
    expect(
      [
        statistics({
          operations: ["record"],
          platform: ["platform.workflow_runs"],
        }),
        statistics({ operations: ["read"], platform: ["platform.everything"] }),
        statistics({ operations: ["read"], platform: [] }),
        statistics({
          operations: ["read"],
          platform: ["platform.workflow_runs", "platform.workflow_runs"],
        }),
        statistics({ operations: ["write"] }),
        statistics({ operations: ["read"], measures: [] }),
      ].map((declaration) => refusal(declaration).length > 0)
    ).toStrictEqual([true, true, true, true, true, true]);
  });
});

describe("inspection", () => {
  test("hands out a manifest frozen all the way down, and handlers it can't change", () => {
    const registered = notes();
    const { manifest, functions } = inspectApp(registered);
    const verbs = manifest.operations["notes.list"]?.tables.notes;
    expect(Reflect.set(verbs ?? {}, "insert", true)).toBeFalsy();
    expect(
      [
        manifest,
        manifest.schema,
        manifest.schema.tables.notes?.access,
        manifest.operations["notes.create"]?.uses,
      ].every((part) => Object.isFrozen(part))
    ).toBeTruthy();
    // A caller that ignores the read-only type: its copy changes, not the App.
    if (functions instanceof Map) {
      functions.set("notes.list", create);
    }
    expect(inspectApp(registered).functions.get("notes.list")).toBe(list);
    expect(
      inspectApp(registered).manifest.operations["notes.list"]?.tables.notes
        ?.insert
    ).toBeFalsy();
  });
});

describe("paths", () => {
  test("public and internal functions get distinct paths from their maps", () => {
    const { manifest, functions } = inspectApp(
      notes({ internalOperations: { jobs: { secret } } })
    );
    expect(Object.keys(manifest.operations).toSorted()).toStrictEqual([
      "jobs.secret",
      "notes.create",
      "notes.list",
      "notes.send",
    ]);
    expect(manifest.operations["jobs.secret"]?.visibility).toBe("internal");
    expect(manifest.operations["notes.list"]?.visibility).toBe("public");
    expect(functions.get("notes.list")).toBe(list);
  });

  test.each([
    [
      "an internal function in the public tree",
      { operations: { secret } },
      "is internal",
    ],
    [
      "a public function in the internal tree",
      { internalOperations: { list } },
      "is public",
    ],
    [
      "one path in both trees",
      {
        operations: { jobs: { secret: list } },
        internalOperations: { jobs: { secret } },
      },
      "as public and as internal",
    ],
    [
      "one function at two paths",
      { operations: { a: list, b: list } },
      "registered twice",
    ],
    [
      "a helper beside the functions",
      { operations: { notes: { list, fields: { title: v.string() } } } },
      "isn't a server function",
    ],
    [
      "a key that isn't an identifier",
      { operations: { "notes-list": list } },
      "isn't an identifier",
    ],
    [
      "a path deeper than four",
      { operations: { a: { b: { c: { d: { list } } } } } },
      "up to 4",
    ],
  ])("%s is refused", (_case, changes, message) => {
    expect(refusal(() => looseNotes(changes))).toContain(message);
  });

  test("a getter is refused, so a path is read once", () => {
    const operations = {};
    Object.defineProperty(operations, "list", {
      enumerable: true,
      get: () => list,
    });
    expect(refusal(() => notes({ operations }))).toContain("getter");
  });

  test("a function declared for another schema is refused", () => {
    const other = serverModule(
      defineSchema({ notes: defineTable({ title: v.string() }) })
    );
    const foreign = other.query({
      args: {},
      returns: v.null(),
      handler: () => null,
    });
    expect(refusal(() => notes({ operations: { foreign } }))).toContain(
      "another schema"
    );
  });
});

describe("uses", () => {
  const mail = resource.connector("mail", {
    contract: "microsoft-365.mail@1",
    actions: ["send"],
  });

  test("a function's uses become paths and aliases", () => {
    const notify = server.action({
      args: {},
      returns: v.null(),
      uses: [list, secret, create, mail],
      handler: () => null,
    });
    const { manifest } = inspectApp(
      notes({
        operations: { notes: { list, create, notify } },
        internalOperations: { secret },
        uses: [mail],
      })
    );
    expect(manifest.operations["notes.notify"]?.uses).toStrictEqual([
      { type: "function", path: "notes.list", kind: "query" },
      { type: "function", path: "secret", kind: "query" },
      { type: "function", path: "notes.create", kind: "mutation" },
      { type: "resource", kind: "connector", alias: "mail" },
    ]);
  });

  test("a mutation runs queries only, and never reaches outside", () => {
    const viaMutation = server.mutation({
      args: {},
      returns: v.null(),
      uses: [create],
      handler: () => null,
    });
    expect(
      refusal(() =>
        notes({ operations: { notes: { list, create, viaMutation } } })
      )
    ).toContain("may run the App's queries");
    const viaResource = server.mutation({
      args: {},
      returns: v.null(),
      uses: [mail],
      handler: () => null,
    });
    expect(
      refusal(() => notes({ operations: { viaResource }, uses: [mail] }))
    ).toContain("only an action uses resources");
  });

  test("an action's resource must be one the App lists", () => {
    const sendMail = server.action({
      args: {},
      returns: v.null(),
      uses: [mail],
      handler: () => null,
    });
    expect(refusal(() => notes({ operations: { sendMail } }))).toContain(
      "doesn't list"
    );
    // The same alias declared again is another requirement, not this one.
    const lookalike = resource.connector("mail", {
      contract: "microsoft-365.mail@1",
      actions: ["send"],
    });
    expect(
      refusal(() => notes({ operations: { sendMail }, uses: [lookalike] }))
    ).toContain("doesn't list");
    expect(
      refusal(() => notes({ operations: { list }, uses: [mail, lookalike] }))
    ).toContain("alias `mail`");
  });

  test("a contract is short enough to name in an audit event", () => {
    // 256 characters, the most an identifier may be, then one more.
    const longest = `${"a".repeat(254)}@1`;
    const tooLong = `${"a".repeat(255)}@1`;
    const read = connectorOf(longest);
    expect({
      template: resource.template("letter", { contract: longest }).contract,
      connector: "contract" in read ? read.contract : null,
    }).toStrictEqual({ template: longest, connector: longest });
    expect(
      [
        refusal(() => resource.template("letter", { contract: tooLong })),
        refusal(() => connectorOf(tooLong)),
      ].map((message) => message.includes("at most 256 characters"))
    ).toStrictEqual([true, true]);
  });

  test("a function the App doesn't register can't be used", () => {
    const orphan = server.query({
      args: {},
      returns: v.null(),
      handler: () => null,
    });
    const caller = server.action({
      args: {},
      returns: v.null(),
      uses: [orphan],
      handler: () => null,
    });
    expect(refusal(() => notes({ operations: { caller } }))).toContain(
      "doesn't register"
    );
  });

  test("a workflow is started by an action or staged by a mutation, only one the App lists, and reads back as declared", () => {
    const followUp = resource.workflow("followUp", {
      input: v.object({ title: v.string().trim() }),
    });
    const start = server.action({
      args: {},
      returns: v.null(),
      uses: [followUp],
      handler: () => null,
    });
    const stage = server.mutation({
      args: {},
      returns: v.null(),
      uses: [list, followUp],
      handler: () => null,
    });
    const registered = notes({
      operations: { notes: { list, start, stage } },
      uses: [followUp],
    });
    const { manifest } = inspectApp(registered);
    const lookalike = resource.workflow("followUp", {
      input: v.object({ title: v.string().trim() }),
    });
    expect({
      start: manifest.operations["notes.start"]?.uses,
      stage: manifest.operations["notes.stage"]?.uses,
      declared: manifest.workflows.followUp?.input,
      // A workflow is neither an action's resource nor a screen's.
      resources: Object.keys(manifest.resources),
      readBack:
        canonicalText(readAppManifest(JSON.stringify(manifest))) ===
        canonicalText(manifest),
      unlisted: refusal(() =>
        notes({ operations: { notes: { list, start } } })
      ).includes("doesn't list"),
      // The same alias declared again is another requirement, not this one.
      lookalike: refusal(() =>
        notes({ operations: { notes: { list, start } }, uses: [lookalike] })
      ).includes("doesn't list"),
      sameAlias: refusal(() =>
        notes({
          operations: { notes: { list } },
          uses: [followUp, resource.template("followUp", { contract: "a@1" })],
        })
      ).includes("alias `followUp`"),
    }).toStrictEqual({
      start: [{ type: "workflow", alias: "followUp" }],
      stage: [
        { type: "function", path: "notes.list", kind: "query" },
        { type: "workflow", alias: "followUp" },
      ],
      declared: v.object({ title: v.string().trim() }).descriptor,
      resources: [],
      readBack: true,
      unlisted: true,
      lookalike: true,
      sameAlias: true,
    });
  });

  test("a manifest can't make a workflow out of something else", () => {
    const followUp = resource.workflow("followUp", { input: v.object({}) });
    const start = server.action({
      args: {},
      returns: v.null(),
      uses: [followUp],
      handler: () => null,
    });
    const { manifest } = inspectApp(
      notes({ operations: { notes: { list, start } }, uses: [followUp] })
    );
    // A mutable copy, as JSON: what a manifest read back is.
    const operations: Record<string, { uses: unknown[] }> = {};
    for (const [path, operation] of Object.entries(manifest.operations)) {
      operations[path] = { ...operation, uses: [...operation.uses] };
    }
    const data: {
      operations: Record<string, { uses: unknown[] }>;
      workflows: Record<string, unknown>;
      resources: Record<string, unknown>;
    } = {
      ...manifest,
      operations,
      workflows: { ...manifest.workflows },
      resources: { ...manifest.resources },
    };
    const altered = (change: (copy: typeof data) => void): string => {
      const copy = structuredClone(data);
      change(copy);
      return refusal(() => readAppManifest(JSON.stringify(copy)));
    };
    expect({
      // A use of a workflow the manifest doesn't declare.
      undeclared: altered((copy) => {
        copy.workflows = {};
      }).includes("doesn't declare"),
      // A workflow filed among an action's resources.
      asResource: altered((copy) => {
        copy.resources = copy.workflows;
        copy.workflows = {};
      }).includes("isn't an action's resource"),
      // A query that starts one.
      byQuery: altered((copy) => {
        copy.operations["notes.list"]?.uses.push({
          type: "workflow",
          alias: "followUp",
        });
      }).includes("A query uses nothing"),
    }).toStrictEqual({
      undeclared: true,
      asResource: true,
      byQuery: true,
    });
  });

  test("uses lists declarations, never names or IDs", () => {
    expect(
      refusal(() =>
        looseAction({
          args: {},
          returns: v.null(),
          uses: ["notes.list"],
          handler: () => null,
        })
      )
    ).toContain("never IDs or names");
  });
});

describe("declarations", () => {
  test.each([
    ["`input`", { input: {}, returns: v.null() }, "not `input`"],
    ["`output`", { args: {}, output: v.null() }, "not `output`"],
    ["`reads`", { args: {}, returns: v.null(), reads: [] }, "no `reads`"],
    ["no `returns`", { args: {} }, "declares what it `returns`"],
    [
      "`uses` on a query",
      { args: {}, returns: v.null(), uses: [] },
      "uses nothing",
    ],
    [
      "a `returns` that isn't a schema",
      { args: {}, returns: {} },
      "`v` schemas",
    ],
  ])("a query with %s is refused", (_case, declaration, message) => {
    expect(
      refusal(() => looseQuery({ handler: () => null, ...declaration }))
    ).toContain(message);
  });

  test("arguments are a strict object of the declared fields", () => {
    const result = create.args["~standard"].validate({ title: "a", more: 1 });
    expect(result.issues?.map(({ code }) => code)).toStrictEqual([
      "value.unknown_key",
    ]);
  });
});

describe(AppError, () => {
  test("carries its code, message and bounded details", () => {
    const error = new AppError("note.not_found", "The note is unavailable.", {
      id: "n1",
    });
    expect(error).toBeInstanceOf(Error);
    expect([
      error.name,
      error.code,
      error.message,
      error.details,
    ]).toStrictEqual([
      "AppError",
      "note.not_found",
      "The note is unavailable.",
      { id: "n1" },
    ]);
  });

  test.each([
    ["a platform namespace", "data.conflict", "platform's `data`"],
    [
      "the connections' namespace",
      "connection.not_offered",
      "platform's `connection`",
    ],
    ["the screens' namespace", "screen.invalid", "platform's `screen`"],
    [
      "the resources' namespace",
      "resource.unavailable",
      "platform's `resource`",
    ],
    ["another platform namespace", "auth.unauthenticated", "platform's `auth`"],
    ["one segment", "notfound", "dotted"],
    ["upper case", "Note.Missing", "dotted"],
  ])("refuses a code in %s", (_case, code, message) => {
    expect(refusal(() => new AppError(code, "Message"))).toContain(message);
  });

  test("refuses an empty or long message, and large or non-JSON details", () => {
    expect(refusal(() => new AppError("a.b", ""))).toContain("message");
    expect(refusal(() => new AppError("a.b", "x".repeat(501)))).toContain(
      "message"
    );
    expect(
      refusal(() => new AppError("a.b", "m", { text: "x".repeat(17_000) }))
    ).toContain("details");
    expect(
      refusal(() => new LooseAppError("a.b", "m", { at: new Date() }))
    ).toContain("details");
  });
});

describe("ctx.db for writing", () => {
  test("an insert hands the host its table and fields, and answers the minted ID", async () => {
    const requests: unknown[] = [];
    const db = databaseWriter(
      schema,
      async () => await Promise.resolve(null),
      async (request) => {
        requests.push(request);
        return await Promise.resolve("minted");
      }
    );
    await expect(db.insert("notes", { title: "a" })).resolves.toBe("minted");
    expect(requests).toStrictEqual([
      { kind: "insert", table: "notes", fields: { title: "a" } },
    ]);
  });

  test("a write without its expected revision is refused before the host", async () => {
    const db = databaseWriter(
      schema,
      async () => await Promise.resolve(null),
      async () => await Promise.reject(new Error("reached the host"))
    );
    // SAFETY: deliberately ill-typed views, for calls the types refuse.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const looseDelete = db.delete as (...args: unknown[]) => Promise<void>;
    // SAFETY: as above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const looseInsert = db.insert as (...args: unknown[]) => Promise<unknown>;
    await expect(looseDelete("notes", "n", {})).rejects.toThrow(
      "expectedRevision"
    );
    await expect(looseInsert("missing", { title: "a" })).rejects.toThrow(
      "no such table"
    );
  });
});

describe("the runner", () => {
  test("hands App code a called function's domain failure as its own AppError class, as it arrives across an isolate", async () => {
    const recover = server.action({
      args: {},
      returns: v.string(),
      uses: [create],
      handler: async (ctx) => {
        try {
          await ctx.runMutation(create, { title: "a" });
          return "accepted";
        } catch (error) {
          return error instanceof AppError
            ? `${error.code}: ${error.message}`
            : "not an AppError";
        }
      },
    });
    const registered = notes({
      operations: { notes: { list, create, recover } },
    });
    // What crosses an isolate boundary: an Error named AppError, its class lost.
    const crossed = Object.assign(new Error("Notes are closed."), {
      name: "AppError",
      code: "note.closed",
    });
    const channel = {
      read: async () => await Promise.resolve(null),
      write: async () => await Promise.resolve(null),
      call: async () => await Promise.reject(crossed),
      resource: async () => await Promise.resolve(null),
      emit: async () => await Promise.resolve(null),
    };
    await expect(
      runFunction(registered, "notes.recover", {}, channel)
    ).resolves.toBe("note.closed: Notes are closed.");
  });
});

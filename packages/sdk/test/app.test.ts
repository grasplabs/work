import { canonicalText } from "@grasp-os/shared/json";
import { describe, expect, test } from "vite-plus/test";

import { databaseWriter } from "../src/database.ts";
import { inspectApp, readAppManifest, registerApp } from "../src/host.ts";
import type { ServerModules } from "../src/host.ts";
import { AppError, defineApp, permission } from "../src/index.ts";
import type { AppConfig, WorkflowEventReference } from "../src/index.ts";
import { readPermissionDeclaration } from "../src/permissions.ts";
import { runFunction } from "../src/runner.ts";
import { serverModule } from "../src/server.ts";
import { defineSchema, defineTable, v } from "../src/values.ts";

// How an App registers itself from its parts (its config and schema, and
// the server functions its modules under `server/` export),
// and what inspection makes of them (spec 7.1, 7.4, 7.5): pure checks of
// a declaration, so unit tests.
// That the host enforces the result is tested through the host
// (apps/core/test/operations.test.ts).

const schema = defineSchema({
  notes: defineTable({
    title: v.string(),
    rank: v.number().optional(),
    body: v.string().default(""),
  }).access({ read: "appMembers", write: "owner" }),
  people: defineTable({ name: v.string() }).access({ read: "appMembers" }),
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

/** Notes' config, as one registration to vary. */
type Registration = AppConfig;

// SAFETY: deliberately ill-typed views, for declarations the types refuse.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const looseDefineApp = defineApp as (
  config: unknown
) => ReturnType<typeof defineApp>;
// SAFETY: as above.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const looseQuery = server.query as (declaration: unknown) => unknown;
// SAFETY: as above.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const looseMutation = server.mutation as (declaration: unknown) => unknown;
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
const registration: Registration = { name: "Notes" };

/** Notes' server modules: `server/notes.ts`. */
const notesModules: ServerModules = { notes: { list, create, send } };

/** Registers `config` and `modules` as the host's entry does. */
const registerParts = (
  config: ReturnType<typeof defineApp>,
  modules: ServerModules
) =>
  registerApp({
    config,
    schema,
    modules,
    migrations: [],
  });

/**
 * Notes, with `changes` to its registration, and its functions from
 * `modules`, as the host's entry registers them.
 */
const notes = (
  changes: Partial<Registration> = {},
  modules: ServerModules = notesModules
) => {
  const config = { ...registration, ...changes };
  return registerParts(defineApp(config), modules);
};

/** Registers Notes, and its functions, with `changes` the types refuse. */
const looseNotes = (changes: object) =>
  registerParts(looseDefineApp({ ...registration, ...changes }), notesModules);

/**
 * A connector declaration of `contract`, read back as the host reads a
 * manifest's: in code a contract is one of the catalog's, so any other
 * string arrives only as data.
 */
const connectorOf = (contract: string) =>
  readPermissionDeclaration({
    "~permission": "connections",
    alias: "mail",
    contract,
    actions: ["send"],
  });

const refusal = (register: () => unknown): string => {
  try {
    register();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("The registration was accepted");
};

/** The reference `@server/_generated/api` generates for `workflow`'s `edited` event. */
const eventOf = (workflow: string): WorkflowEventReference => ({
  kind: "workflowEvent",
  resourceId: "app",
  resourceVersion: 1,
  workflow,
  workflowFingerprint: "0".repeat(64),
  alias: "edited",
  type: "notes.note.edited",
  fingerprint: "f".repeat(64),
  data: v.object({ title: v.string() }).descriptor,
});

describe("access", () => {
  test("a table without its own access is none, and a mode it leaves out too", () => {
    const { manifest } = inspectApp(notes());
    expect(manifest.schema.tables.people?.access).toStrictEqual({
      read: "appMembers",
      write: "none",
    });
    expect(manifest.operations["notes.create"]?.tables.people).toStrictEqual({
      read: true,
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

  test("a function's tables narrow, and a verb or table they leave out is denied", () => {
    const narrowed = server.mutation({
      tables: { notes: { insert: true } },
      args: {},
      returns: v.null(),
      handler: () => null,
    });
    const { manifest } = inspectApp(
      notes({}, { notes: { list, create: narrowed, send } })
    );
    expect(manifest.operations["notes.create"]?.tables).toStrictEqual({
      notes: { read: false, insert: true, update: false, delete: false },
      people: { read: false, insert: false, update: false, delete: false },
    });
    // Functions without them keep their tables' access.
    expect(manifest.operations["notes.list"]?.tables.notes?.read).toBeTruthy();
    // And so does the manifest read back.
    expect(
      canonicalText(readAppManifest(JSON.stringify(manifest)))
    ).toStrictEqual(canonicalText(manifest));
  });

  test.each([
    [
      "a verb the table's access doesn't allow",
      "mutation",
      { people: { insert: true } },
      "widens access",
    ],
    [
      "a query writing",
      "query",
      { notes: { read: true, insert: true } },
      "a query only reads",
    ],
  ] as const)("tables with %s are refused", (_case, kind, tables, message) => {
    const declared = (kind === "query" ? looseQuery : looseMutation)({
      tables,
      args: {},
      returns: v.null(),
      handler: () => null,
    });
    expect(refusal(() => notes({}, { notes: { list, declared } }))).toContain(
      message
    );
  });

  test.each([
    [
      "an action at all",
      "action",
      { notes: { read: false } },
      "An action has no tables",
    ],
    [
      "an unknown table",
      "mutation",
      { invoices: { read: false } },
      "doesn't have",
    ],
    [
      "an unknown verb",
      "mutation",
      { notes: { upsert: false } },
      "to booleans",
    ],
    [
      "a verb that isn't a boolean",
      "mutation",
      { notes: { insert: "yes" } },
      "to booleans",
    ],
  ] as const)(
    "tables with %s are refused as declared",
    (_case, kind, tables, message) => {
      const declare = kind === "action" ? looseAction : looseMutation;
      expect(
        refusal(() =>
          declare({ tables, args: {}, returns: v.null(), handler: () => null })
        )
      ).toContain(message);
    }
  );
});

describe("permissions", () => {
  test("are frozen all the way down, so nothing checked can change before registration", () => {
    const brain = permission.brain({
      operations: ["search"],
      collections: ["handbook"],
    });
    const connection = permission.connection("mail", {
      contract: "microsoft-365.mail@1",
      actions: ["send"],
    });
    const ai = permission.ai({ maxOutputTokens: 100 });
    expect({
      operation: Reflect.set(brain.operations, 0, "read"),
      added: Reflect.set(brain.operations, 1, "read"),
      collection: Reflect.set(brain.collections, 0, "secret"),
      action: Reflect.set(connection.actions, 0, "delete"),
      tokens: Reflect.set(ai, "maxOutputTokens", 100_000),
    }).toStrictEqual({
      operation: false,
      added: false,
      collection: false,
      action: false,
      tokens: false,
    });
    expect([brain.operations, connection.actions, ai.alias]).toStrictEqual([
      ["search"],
      ["send"],
      "ai",
    ]);
  });

  test("each kind sits under its own key, each alias once", () => {
    const mail = permission.connection("mail", {
      contract: "microsoft-365.mail@1",
      actions: ["send"],
    });
    const ai = permission.ai({ maxOutputTokens: 100 });
    const followUp = permission.workflow("mail", {
      input: v.object({}),
      output: v.null(),
    });
    const { manifest } = inspectApp(
      notes({ permissions: { ai, connections: [mail], people: true } })
    );
    expect({
      resources: Object.keys(manifest.resources).toSorted(),
      people: manifest.people,
      readBack:
        canonicalText(readAppManifest(JSON.stringify(manifest))) ===
        canonicalText(manifest),
    }).toStrictEqual({
      resources: ["ai", "mail"],
      people: true,
      readBack: true,
    });
    expect(
      [
        // A kind the App can't hold.
        refusal(() => looseNotes({ permissions: { model: ai } })),
        // A declaration under another kind's key.
        refusal(() => looseNotes({ permissions: { connections: [ai] } })),
        refusal(() => looseNotes({ permissions: { ai: mail } })),
        // One where a list goes, and a list where one goes.
        refusal(() => looseNotes({ permissions: { connections: mail } })),
        refusal(() => looseNotes({ permissions: { ai: [ai] } })),
        // A declaration `permission` didn't make.
        refusal(() =>
          looseNotes({ permissions: { connections: [{ ...mail }] } })
        ),
        refusal(() => looseNotes({ permissions: { people: "yes" } })),
        // The superseded keys.
        refusal(() => looseNotes({ uses: [] })),
        refusal(() => looseNotes({ people: true })),
      ].map((message) => message.length > 0)
    ).toStrictEqual([true, true, true, true, true, true, true, true, true]);
    expect(
      refusal(() =>
        notes({ permissions: { connections: [mail], workflows: [followUp] } })
      )
    ).toContain("alias `mail`");
  });

  test("the fixed aliases are each one kind's", () => {
    const connection = permission.connection("ai", {
      contract: "microsoft-365.mail@1",
      actions: ["send"],
    });
    expect(
      refusal(() => notes({ permissions: { connections: [connection] } }))
    ).toContain("`ai` is the alias of the App's `ai` permission");
    expect(
      refusal(() =>
        readPermissionDeclaration({
          "~permission": "ai",
          alias: "writer",
          maxOutputTokens: 10,
        })
      )
    ).toContain("always `ai`");
  });

  test("the platform's own functions are `grasp`'s, exactly", () => {
    const grasp = permission.grasp();
    const shape = structuredClone(grasp.functions["statistics.read"]);
    expect({
      read:
        JSON.stringify(readPermissionDeclaration(structuredClone(grasp))) ===
        JSON.stringify(grasp),
      alias: grasp.alias,
      paths: Object.keys(grasp.functions),
    }).toStrictEqual({
      read: true,
      alias: "grasp",
      paths: ["statistics.read"],
    });
    // A manifest can't widen the platform's functions under its alias.
    expect(
      refusal(() =>
        readPermissionDeclaration({
          "~permission": "grasp",
          alias: "grasp",
          functions: { "statistics.write": shape },
        })
      )
    ).toContain("grasp");
  });

  test("an App never declares another App's functions, in code or in a manifest", () => {
    const grasp = permission.grasp();
    expect({
      // No constructor for it: Apps don't call each other.
      inCode: Object.hasOwn(permission, "app"),
      // A manifest that names another App's functions is no declaration
      // this SDK reads: no `apps` kind, and `grasp` only as the platform's.
      asApps: refusal(() =>
        readPermissionDeclaration({
          "~permission": "apps",
          alias: "crm",
          functions: grasp.functions,
        })
      ).includes("isn't one this SDK knows"),
      underAnotherAlias: refusal(() =>
        readPermissionDeclaration({
          "~permission": "grasp",
          alias: "crm",
          functions: grasp.functions,
        })
      ).includes("always `grasp`"),
    }).toStrictEqual({ inCode: false, asApps: true, underAnotherAlias: true });
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
  test("each function's path is its module's and its export's, its visibility its kind's, and helpers are passed over", () => {
    const { manifest, functions } = inspectApp(
      notes(
        {},
        {
          notes: { list, create, send, fields: { title: v.string() } },
          "admin/jobs": { secret, limit: 10 },
        }
      )
    );
    expect(Object.keys(manifest.operations).toSorted()).toStrictEqual([
      "admin.jobs.secret",
      "notes.create",
      "notes.list",
      "notes.send",
    ]);
    expect(manifest.operations["admin.jobs.secret"]?.visibility).toBe(
      "internal"
    );
    expect(manifest.operations["notes.list"]?.visibility).toBe("public");
    expect(functions.get("notes.list")).toBe(list);
  });

  test.each([
    [
      "one function at two paths",
      { a: { list }, b: { list } },
      "exported twice",
    ],
    [
      "a module whose name isn't an identifier",
      { "notes-list": { list } },
      "doesn't make a function path",
    ],
    ["a path deeper than four", { "a/b/c/d": { list } }, "up to 4"],
    [
      "a module at a path the platform keeps",
      { workflows: { list } },
      "is the platform's",
    ],
    [
      "an export named as a reference's own data",
      { notes: { name: list } },
      "a reference itself answers",
    ],
  ])("%s is refused", (_case, modules, message) => {
    expect(refusal(() => notes({}, modules))).toContain(message);
  });

  test("an export is read once, as it registers, whatever a getter would answer later", () => {
    // A bundler's module namespace exposes exports as getters.
    let reads = 0;
    const module = {};
    Object.defineProperty(module, "list", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? list : create;
      },
    });
    const registered = notes({}, { notes: module });
    expect({
      reads,
      kind: inspectApp(registered).manifest.operations["notes.list"]?.kind,
      runs: inspectApp(registered).functions.get("notes.list"),
    }).toStrictEqual({ reads: 1, kind: "query", runs: list });
  });

  test("a config inspected without the rest of its App is refused", () => {
    expect(refusal(() => inspectApp(defineApp(registration)))).toContain(
      "registerApp"
    );
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
    expect(refusal(() => notes({}, { notes: { foreign } }))).toContain(
      "another schema"
    );
  });
});

describe("uses", () => {
  const mail = permission.connection("mail", {
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
      notes(
        { permissions: { connections: [mail] } },
        { notes: { list, create, notify }, jobs: { secret } }
      )
    );
    expect(manifest.operations["notes.notify"]?.uses).toStrictEqual([
      { type: "function", path: "notes.list", kind: "query" },
      { type: "function", path: "jobs.secret", kind: "query" },
      { type: "function", path: "notes.create", kind: "mutation" },
      { type: "resource", kind: "connections", alias: "mail" },
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
      refusal(() => notes({}, { notes: { list, create, viaMutation } }))
    ).toContain("may run the App's queries");
    const viaResource = server.mutation({
      args: {},
      returns: v.null(),
      uses: [mail],
      handler: () => null,
    });
    expect(
      refusal(() =>
        notes(
          { permissions: { connections: [mail] } },
          { notes: { viaResource } }
        )
      )
    ).toContain("only an action reaches `connections`");
  });

  test("an action's permission must be one the App lists", () => {
    const sendMail = server.action({
      args: {},
      returns: v.null(),
      uses: [mail],
      handler: () => null,
    });
    expect(refusal(() => notes({}, { notes: { sendMail } }))).toContain(
      "don't list"
    );
    // The same alias declared again is another requirement, not this one.
    const lookalike = permission.connection("mail", {
      contract: "microsoft-365.mail@1",
      actions: ["send"],
    });
    expect(
      refusal(() =>
        notes(
          { permissions: { connections: [lookalike] } },
          { notes: { sendMail } }
        )
      )
    ).toContain("don't list");
    expect(
      refusal(() =>
        notes(
          { permissions: { connections: [mail, lookalike] } },
          { notes: { list } }
        )
      )
    ).toContain("alias `mail`");
  });

  test("a contract is short enough to name in an audit event", () => {
    // 256 characters, the most an identifier may be, then one more.
    const longest = `${"a".repeat(254)}@1`;
    const tooLong = `${"a".repeat(255)}@1`;
    const read = connectorOf(longest);
    expect("contract" in read ? read.contract : null).toBe(longest);
    expect(refusal(() => connectorOf(tooLong))).toContain(
      "at most 256 characters"
    );
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
    expect(refusal(() => notes({}, { notes: { caller } }))).toContain(
      "doesn't register"
    );
  });

  test("a workflow is started by an action or staged by a mutation, only one the App lists, and reads back as declared", () => {
    const followUp = permission.workflow("followUp", {
      input: v.object({ title: v.string().trim() }),
      output: v.object({ done: v.boolean() }),
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
    const registered = notes(
      { permissions: { workflows: [followUp] } },
      { notes: { list, start, stage } }
    );
    const { manifest } = inspectApp(registered);
    const lookalike = permission.workflow("followUp", {
      input: v.object({ title: v.string().trim() }),
      output: v.object({ done: v.boolean() }),
    });
    expect({
      start: manifest.operations["notes.start"]?.uses,
      stage: manifest.operations["notes.stage"]?.uses,
      declared: manifest.workflows.followUp?.input,
      declaredOutput: manifest.workflows.followUp?.output,
      // A workflow is neither an action's permission nor a page's.
      resources: Object.keys(manifest.resources),
      readBack:
        canonicalText(readAppManifest(JSON.stringify(manifest))) ===
        canonicalText(manifest),
      unlisted: refusal(() => notes({}, { notes: { list, start } })).includes(
        "don't list"
      ),
      // The same alias declared again is another requirement, not this one.
      lookalike: refusal(() =>
        notes(
          { permissions: { workflows: [lookalike] } },
          { notes: { list, start } }
        )
      ).includes("don't list"),
      sameAlias: refusal(() =>
        notes(
          {
            permissions: {
              workflows: [followUp],
              connections: [
                permission.connection("followUp", {
                  contract: "microsoft-365.mail@1",
                  actions: ["send"],
                }),
              ],
            },
          },
          { notes: { list } }
        )
      ).includes("alias `followUp`"),
    }).toStrictEqual({
      start: [{ type: "workflow", alias: "followUp" }],
      stage: [
        { type: "function", path: "notes.list", kind: "query" },
        { type: "workflow", alias: "followUp" },
      ],
      declared: v.object({ title: v.string().trim() }).descriptor,
      declaredOutput: v.object({ done: v.boolean() }).descriptor,
      resources: [],
      readBack: true,
      unlisted: true,
      lookalike: true,
      sameAlias: true,
    });
  });

  test("a workflow's event is notified by a mutation only, of a workflow the App lists, and reads back as declared", () => {
    const followUp = permission.workflow("followUp", {
      input: v.object({ title: v.string().trim() }),
      output: v.object({ done: v.boolean() }),
    });
    const edited = eventOf("workflows.followUp");
    const notify = server.mutation({
      args: {},
      returns: v.null(),
      uses: [edited],
      handler: () => null,
    });
    const registered = notes(
      { permissions: { workflows: [followUp] } },
      { notes: { list, notify } }
    );
    const { manifest } = inspectApp(registered);
    const byAction = server.action({
      args: {},
      returns: v.null(),
      uses: [edited],
      handler: () => null,
    });
    const otherWorkflow = server.mutation({
      args: {},
      returns: v.null(),
      uses: [eventOf("workflows.archive")],
      handler: () => null,
    });
    expect({
      notify: manifest.operations["notes.notify"]?.uses,
      readBack:
        canonicalText(readAppManifest(JSON.stringify(manifest))) ===
        canonicalText(manifest),
      byAction: refusal(() =>
        notes(
          { permissions: { workflows: [followUp] } },
          { notes: { list, byAction } }
        )
      ).includes("only a mutation notifies"),
      otherWorkflow: refusal(() =>
        notes(
          { permissions: { workflows: [followUp] } },
          { notes: { list, otherWorkflow } }
        )
      ).includes("don't list"),
      madeUp: refusal(() =>
        Reflect.apply(server.mutation, server, [
          {
            args: {},
            returns: v.null(),
            uses: [{ ...edited, fingerprint: "not a fingerprint" }],
            handler: () => null,
          },
        ])
      ).includes("never IDs or names"),
    }).toStrictEqual({
      notify: [
        {
          type: "workflowEvent",
          workflow: "followUp",
          alias: "edited",
          eventType: "notes.note.edited",
          fingerprint: "f".repeat(64),
        },
      ],
      readBack: true,
      byAction: true,
      otherWorkflow: true,
      madeUp: true,
    });
  });

  test("a workflow's input is there, or its default, when a start leaves it out", () => {
    const optional = refusal(() =>
      permission.workflow("followUp", {
        input: v.string().optional(),
        output: v.null(),
      })
    );
    const defaulted = permission.workflow("followUp", {
      input: v.string().default("Today"),
      output: v.null(),
    });
    // Declared without the output a run gives, it is refused, whatever
    // the types let through.
    const noOutput = refusal(() =>
      Reflect.apply(permission.workflow, permission, [
        "followUp",
        { input: v.object({}) },
      ])
    );
    expect({
      optional: optional.includes("never only optional"),
      defaulted: defaulted.input.presence,
      noOutput: noOutput.length > 0,
    }).toStrictEqual({ optional: true, defaulted: "default", noOutput: true });
  });

  test("a manifest can't make a workflow out of something else", () => {
    const followUp = permission.workflow("followUp", {
      input: v.object({}),
      output: v.null(),
    });
    const start = server.action({
      args: {},
      returns: v.null(),
      uses: [followUp],
      handler: () => null,
    });
    const { manifest } = inspectApp(
      notes(
        { permissions: { workflows: [followUp] } },
        { notes: { list, start } }
      )
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
      }).includes("isn't an action's permission"),
      // A query that starts one.
      byQuery: altered((copy) => {
        copy.operations["notes.list"]?.uses.push({
          type: "workflow",
          alias: "followUp",
        });
      }).includes("A query uses nothing"),
      // A workflow without the output a run gives.
      noOutput:
        altered((copy) => {
          const declared = manifest.workflows.followUp;
          if (declared !== undefined) {
            const { output: _output, ...withoutOutput } = declared;
            copy.workflows = { followUp: withoutOutput };
          }
        }).length > 0,
    }).toStrictEqual({
      undeclared: true,
      asResource: true,
      byQuery: true,
      noOutput: true,
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

describe("answers for a schema change", () => {
  test("are recorded in the manifest, read back as declared, and checked against the schema", () => {
    const { manifest } = inspectApp(
      notes({
        answers: [
          { table: "notes", field: "rank", value: 0 },
          { table: "notes", field: "body", value: "" },
        ],
      })
    );
    expect({
      answers: manifest.answers,
      none: "answers" in inspectApp(notes()).manifest,
      readBack:
        canonicalText(readAppManifest(JSON.stringify(manifest))) ===
        canonicalText(manifest),
      unknownField: refusal(() =>
        looseNotes({
          answers: [{ table: "notes", field: "colour", value: 1 }],
        })
      ),
    }).toStrictEqual({
      answers: [
        { table: "notes", field: "rank", value: 0 },
        { table: "notes", field: "body", value: "" },
      ],
      none: false,
      readBack: true,
      unknownField: "`notes` has no field `colour` to answer for.",
    });
  });
});

describe("declarations", () => {
  test.each([
    ["`input`", { input: {}, returns: v.null() }, "not `input`"],
    ["`output`", { args: {}, output: v.null() }, "not `output`"],
    ["`reads`", { args: {}, returns: v.null(), reads: [] }, "no `reads`"],
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
    ["the pages' namespace", "page.invalid", "platform's `page`"],
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
    const registered = notes({}, { notes: { list, create, recover } });
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
      people: async () => await Promise.resolve(null),
    };
    await expect(
      runFunction(registered, "notes.recover", {}, channel)
    ).resolves.toBe("note.closed: Notes are closed.");
  });
});

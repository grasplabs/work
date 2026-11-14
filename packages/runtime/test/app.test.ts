import { canonicalText } from "@grasp-os/shared/json";
import { describe, expect, test } from "vite-plus/test";

import {
  databaseWriter,
  inspectApp,
  readAppManifest,
  registerApp,
} from "../src/host.ts";
import type { ServerModules } from "../src/host.ts";
import { AppError, defineApp, permission } from "../src/index.ts";
import type { AppConfig, WorkflowEventReference } from "../src/index.ts";
import { readPermissionDeclaration } from "../src/permission-read.ts";
import { runFunction } from "../src/runner.ts";
import { serverModule } from "../src/server.ts";
import { defineSchema, defineTable, v } from "../src/values.ts";

// How an App registers itself from its parts (its config and schema, and
// the server functions its modules under `server/` export),
// and what inspection makes of them (spec 7.1, 7.4, 7.5): pure checks of
// a declaration, so unit tests.
// That the host enforces the result is tested through the host
// (apps/core/test/function-host.test.ts).

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
const eventOf = <Workflow extends string>(
  workflow: Workflow
): WorkflowEventReference<Workflow, "edited", { title: string }> => ({
  name: `${workflow}.events.edited`,
});

describe("what a function may use", () => {
  test("is the App's: the manifest lists its permissions once, by alias, and no function narrows them", () => {
    const mail = permission.connection("mail", {
      contract: "microsoft-365.mail@1",
      actions: ["send"],
    });
    const files = permission.files({ operations: ["upload"] });
    const followUp = permission.workflow("followUp", {
      args: v.object({}),
      returns: v.null(),
    });
    const { manifest } = inspectApp(
      notes({
        permissions: {
          connections: [mail],
          files,
          workflows: [followUp],
          people: true,
        },
      })
    );
    expect({
      permissions: Object.fromEntries(
        Object.entries(manifest.permissions).map(([alias, declared]) => [
          alias,
          declared["~permission"],
        ])
      ),
      fn: Object.keys(manifest.functions["notes.send"] ?? {}).toSorted(),
      readBack:
        canonicalText(readAppManifest(JSON.stringify(manifest))) ===
        canonicalText(manifest),
    }).toStrictEqual({
      permissions: {
        mail: "connections",
        files: "files",
        followUp: "workflows",
        people: "people",
      },
      fn: ["args", "kind", "path", "returns", "stream", "visibility"],
      readBack: true,
    });
  });

  test.each([
    ["A query", looseQuery],
    ["A mutation", looseMutation],
    ["An action", looseAction],
  ] as const)(
    "%s that lists its own `uses` or `tables` is refused, never narrowed",
    (named, declare) => {
      expect([
        refusal(() =>
          declare({
            uses: [],
            args: {},
            returns: v.null(),
            handler: () => null,
          })
        ),
        refusal(() =>
          declare({
            tables: { notes: { read: true } },
            args: {},
            returns: v.null(),
            handler: () => null,
          })
        ),
      ]).toStrictEqual([
        `${named}'s declaration has no \`uses\`.`,
        `${named}'s declaration has no \`tables\`.`,
      ]);
    }
  );

  test("a manifest read back can't carry a function's own uses or verbs", () => {
    const { manifest } = inspectApp(notes());
    const withExtra = (extra: object): string => {
      // SAFETY: a plain copy of the manifest, whose functions are objects.
      const data = structuredClone(manifest) as {
        functions: Record<string, object>;
      };
      data.functions["notes.list"] = {
        ...data.functions["notes.list"],
        ...extra,
      };
      return refusal(() => readAppManifest(JSON.stringify(data)));
    };
    expect([
      withExtra({ uses: [] }),
      withExtra({ tables: { notes: { read: true } } }),
    ]).toStrictEqual([
      "`notes.list` isn't a function as a manifest holds one.",
      "`notes.list` isn't a function as a manifest holds one.",
    ]);
  });
});

describe("permissions", () => {
  test("are frozen all the way down, so nothing checked can change before registration", () => {
    const brain = permission.brain({ operations: ["recall"] });
    const connection = permission.connection("mail", {
      contract: "microsoft-365.mail@1",
      actions: ["send"],
    });
    const ai = permission.ai({ maxOutputTokens: 100 });
    expect({
      operation: Reflect.set(brain.operations, 0, "remember"),
      added: Reflect.set(brain.operations, 1, "remember"),
      action: Reflect.set(connection.actions, 0, "delete"),
      tokens: Reflect.set(ai, "maxOutputTokens", 100_000),
    }).toStrictEqual({
      operation: false,
      added: false,
      action: false,
      tokens: false,
    });
    expect([brain.operations, connection.actions, ai.alias]).toStrictEqual([
      ["recall"],
      ["send"],
      "ai",
    ]);
  });

  test("a manifest read back refuses a Brain declaration with no operations or one it can't have, never reading it as all", () => {
    const { manifest } = inspectApp(
      notes({
        permissions: { brain: permission.brain({ operations: ["recall"] }) },
      })
    );
    const withOperations = (operations: unknown): string => {
      // SAFETY: a plain copy of the manifest, whose permissions are objects.
      const data = structuredClone(manifest) as {
        permissions: Record<string, object>;
      };
      data.permissions.brain = { ...data.permissions.brain, operations };
      return refusal(() => readAppManifest(JSON.stringify(data)));
    };
    expect([
      withOperations([]),
      withOperations(["skills"]),
      withOperations(["skills.write"]),
      withOperations(["skills.read", "skills.read"]),
      withOperations(["entities"]),
    ]).toStrictEqual([
      expect.stringMatching(
        /^A permission lists between 1 and \d+ operations\.$/u
      ),
      "A permission lists operations it can't have.",
      "A permission lists operations it can't have.",
      "A permission lists `skills.read` twice.",
      "A permission lists operations it can't have.",
    ]);
  });

  test("each kind sits under its own key, each alias once", () => {
    const mail = permission.connection("mail", {
      contract: "microsoft-365.mail@1",
      actions: ["send"],
    });
    const ai = permission.ai({ maxOutputTokens: 100 });
    const followUp = permission.workflow("mail", {
      args: v.object({}),
      returns: v.null(),
    });
    const { manifest } = inspectApp(
      notes({ permissions: { ai, connections: [mail], people: true } })
    );
    expect({
      permissions: Object.keys(manifest.permissions).toSorted(),
      readBack:
        canonicalText(readAppManifest(JSON.stringify(manifest))) ===
        canonicalText(manifest),
    }).toStrictEqual({
      permissions: ["ai", "mail", "people"],
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
    const access = manifest.schema.tables.notes?.access;
    expect(Reflect.set(access ?? {}, "write", "appMembers")).toBeFalsy();
    expect(
      [
        manifest,
        manifest.schema,
        manifest.schema.tables.notes?.access,
        manifest.functions["notes.create"],
        manifest.permissions,
      ].every((part) => Object.isFrozen(part))
    ).toBeTruthy();
    // A caller that ignores the read-only type: its copy changes, not the App.
    if (functions instanceof Map) {
      functions.set("notes.list", create);
    }
    expect(inspectApp(registered).functions.get("notes.list")).toBe(list);
    expect(
      inspectApp(registered).manifest.schema.tables.notes?.access.write
    ).toBe("owner");
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
    expect(Object.keys(manifest.functions).toSorted()).toStrictEqual([
      "admin.jobs.secret",
      "notes.create",
      "notes.list",
      "notes.send",
    ]);
    expect(manifest.functions["admin.jobs.secret"]?.visibility).toBe(
      "internal"
    );
    expect(manifest.functions["notes.list"]?.visibility).toBe("public");
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
      kind: inspectApp(registered).manifest.functions["notes.list"]?.kind,
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

/** A channel that records every call App code makes, answering null. */
const recordingChannel = () => {
  const calls: unknown[][] = [];
  const record =
    (method: string) =>
    async (...args: unknown[]): Promise<null> => {
      calls.push([method, ...args]);
      return await Promise.resolve(null);
    };
  return {
    calls,
    channel: {
      read: record("read"),
      write: record("write"),
      call: record("call"),
      permission: record("permission"),
      emit: record("emit"),
      people: async () => await Promise.resolve(null),
    },
  };
};

/** A client read past its types: the members the tests below reach. */
interface Loose {
  (...args: unknown[]): Promise<unknown>;
  readonly tools: Loose;
  readonly billing: Loose;
  readonly sendMail: Loose;
  readonly statistics: Loose;
  readonly read: Loose;
}

// SAFETY: deliberately loose, to read what a client holds at run time.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const loose = (client: unknown): Loose => client as Loose;

/** What a client holds: its own names, its prototype, and whether it's frozen. */
const shapeOf = (client: object) => ({
  own: Reflect.ownKeys(client),
  prototype: Reflect.getPrototypeOf(client),
  frozen: Object.isFrozen(client),
});

describe("the App's permissions in a function's context", () => {
  const mail = permission.connection("mail", {
    contract: "microsoft-365.mail@1",
    actions: ["send"],
  });
  const followUp = permission.workflow("followUp", {
    args: v.object({ title: v.string().trim() }),
    returns: v.object({ done: v.boolean() }),
  });

  test("an action has every permission the App declares, and nothing else", async () => {
    const reach = server.action({
      args: {},
      returns: v.array(v.string()),
      handler: (ctx) =>
        [
          Object.keys(ctx.connections),
          Object.keys(ctx.workflows),
          "ai" in ctx ? ["ai"] : [],
          "brain" in ctx ? ["brain"] : [],
        ].flat(),
    });
    const registered = notes(
      { permissions: { connections: [mail], workflows: [followUp] } },
      { notes: { list, reach } }
    );
    const { channel } = recordingChannel();
    await expect(
      runFunction(registered, "notes.reach", {}, channel)
    ).resolves.toStrictEqual(["mail", "followUp"]);
  });

  test("a mutation stages the App's workflows, a query has none, and neither reaches a connection", async () => {
    const stage = server.mutation({
      args: {},
      returns: v.array(v.string()),
      handler: (ctx) => [
        ...Object.keys(ctx.workflows),
        ...("connections" in ctx ? ["connections"] : []),
      ],
    });
    const read = server.query({
      args: {},
      returns: v.array(v.string()),
      handler: (ctx) =>
        ["workflows", "notifyPeople", "connections", "runQuery"].filter(
          (key) => key in ctx
        ),
    });
    const registered = notes(
      { permissions: { connections: [mail], workflows: [followUp] } },
      { notes: { stage, read } }
    );
    const { channel } = recordingChannel();
    await expect(
      runFunction(registered, "notes.stage", {}, channel)
    ).resolves.toStrictEqual(["followUp"]);
    await expect(
      runFunction(registered, "notes.read", {}, channel)
    ).resolves.toStrictEqual([]);
  });

  test("each declared action is a member that sends its declared name, and nothing else is a member", async () => {
    const tools = permission.connection("tools", {
      contract: "composio.tools@1",
      actions: ["send-mail", "LIST_ROWS"],
    });
    const billing = permission.connection("billing", {
      contract: "http.request@1",
      actions: ["get"],
    });
    const reach = server.action({
      args: {},
      handler: async (ctx) => {
        const connections = loose(ctx.connections);
        const grasp = loose(Reflect.get(ctx, "grasp"));
        await connections.tools.sendMail({ to: "ada" });
        await grasp.statistics.read({ days: 1 });
        return {
          connections: shapeOf(connections),
          tools: shapeOf(connections.tools),
          billing: shapeOf(connections.billing),
          grasp: shapeOf(grasp),
          statistics: shapeOf(grasp.statistics),
          inherited: ["constructor", "toString", "__proto__", "call"].map(
            (name) => typeof Reflect.get(connections.tools, name)
          ),
        };
      },
    });
    const registered = notes(
      {
        permissions: {
          connections: [tools, billing],
          grasp: permission.grasp(),
        },
      },
      { notes: { reach } }
    );
    const { calls, channel } = recordingChannel();
    await expect(
      runFunction(registered, "notes.reach", {}, channel)
    ).resolves.toStrictEqual({
      connections: { own: ["tools", "billing"], prototype: null, frozen: true },
      tools: { own: ["sendMail", "LIST_ROWS"], prototype: null, frozen: true },
      billing: { own: ["fetch"], prototype: null, frozen: true },
      grasp: { own: ["statistics"], prototype: null, frozen: true },
      statistics: { own: ["read"], prototype: null, frozen: true },
      inherited: ["undefined", "undefined", "undefined", "undefined"],
    });
    expect(calls).toStrictEqual([
      ["permission", "tools", "call", ["send-mail", { to: "ada" }]],
      ["permission", "grasp", "call", ["statistics.read", { days: 1 }]],
    ]);
  });

  test("the Brain's skill operations are members of `skills`, each sending its operation, and only the declared ones are members", async () => {
    const reach = server.action({
      args: {},
      handler: async (ctx) => {
        const brain = loose(Reflect.get(ctx, "brain"));
        const skills = loose(Reflect.get(brain, "skills"));
        await loose(Reflect.get(skills, "select"))({ task: "refunds" });
        return {
          brain: shapeOf(brain),
          skills: shapeOf(skills),
          read: typeof Reflect.get(skills, "read"),
        };
      },
    });
    const registered = notes(
      {
        permissions: {
          brain: permission.brain({ operations: ["recall", "skills.select"] }),
        },
      },
      { notes: { reach } }
    );
    const { calls, channel } = recordingChannel();
    await expect(
      runFunction(registered, "notes.reach", {}, channel)
    ).resolves.toStrictEqual({
      brain: { own: ["recall", "skills"], prototype: null, frozen: true },
      skills: { own: ["select"], prototype: null, frozen: true },
      read: "undefined",
    });
    expect(calls).toStrictEqual([
      ["permission", "brain", "skills.select", [{ task: "refunds" }]],
    ]);
  });

  test("the Brain's operations are members of their own names, its entity ones of `entities`, each sending its operation", async () => {
    const reach = server.action({
      args: {},
      handler: async (ctx) => {
        const brain = loose(Reflect.get(ctx, "brain"));
        const entities = loose(Reflect.get(brain, "entities"));
        await loose(Reflect.get(brain, "recall"))({ question: "q" });
        await loose(Reflect.get(entities, "get"))({ entity: "e" });
        return { brain: shapeOf(brain), entities: shapeOf(entities) };
      },
    });
    const registered = notes(
      {
        permissions: {
          brain: permission.brain({
            operations: ["recall", "skills.read", "entities.get"],
          }),
        },
      },
      { notes: { reach } }
    );
    const { calls, channel } = recordingChannel();
    await expect(
      runFunction(registered, "notes.reach", {}, channel)
    ).resolves.toStrictEqual({
      brain: {
        own: ["recall", "skills", "entities"],
        prototype: null,
        frozen: true,
      },
      entities: { own: ["get"], prototype: null, frozen: true },
    });
    expect(calls).toStrictEqual([
      ["permission", "brain", "recall", [{ question: "q" }]],
      ["permission", "brain", "entities.get", [{ entity: "e" }]],
    ]);
  });

  test("a connection can't list two actions with one member", () => {
    expect(
      refusal(() =>
        permission.connection("tools", {
          contract: "composio.tools@1",
          actions: ["send-mail", "sendMail"],
        })
      )
    ).toContain("called alike");
  });

  test("a connection can't list an action the runtime would call unasked", () => {
    const refused = ["then", "toJSON", "toString", "valueOf", "to-JSON"].map(
      (action) =>
        refusal(() =>
          permission.connection("tools", {
            contract: "composio.tools@1",
            actions: [action],
          })
        ).includes("run it unasked")
    );
    expect(refused).toStrictEqual([true, true, true, true, true]);
  });

  test("a call names the App's function by its path, internal ones included, and the host decides it", async () => {
    const compose = server.action({
      args: {},
      returns: v.null(),
      handler: async (ctx) => {
        await ctx.runQuery(secret, {});
        await ctx.runMutation(create, { title: "a" });
        return null;
      },
    });
    const registered = notes(
      {},
      { notes: { list, create, compose }, jobs: { secret } }
    );
    const { calls, channel } = recordingChannel();
    await runFunction(registered, "notes.compose", {}, channel);
    expect(calls.filter(([method]) => method === "call")).toStrictEqual([
      ["call", "query", "jobs.secret", {}],
      ["call", "mutation", "notes.create", { title: "a" }],
    ]);
  });

  test("a function the App doesn't register can't be called", async () => {
    const orphan = server.query({
      args: {},
      returns: v.null(),
      handler: () => null,
    });
    const caller = server.action({
      args: {},
      returns: v.null(),
      handler: async (ctx) => await ctx.runQuery(orphan, {}),
    });
    const registered = notes({}, { notes: { caller } });
    const { calls, channel } = recordingChannel();
    await expect(
      runFunction(registered, "notes.caller", {}, channel)
    ).rejects.toMatchObject({ code: "function.not_found" });
    expect(calls).toStrictEqual([]);
  });

  test("a mutation notifies with a generated event reference, by the aliases its name holds, for the host to resolve", async () => {
    const edited = eventOf("workflows.followUp");
    // Typed by the config, as the generated `server/_generated/server` is.
    const granted = serverModule(
      schema,
      defineApp({ name: "Notes", permissions: { workflows: [followUp] } })
    );
    const notify = granted.mutation({
      args: {},
      returns: v.null(),
      handler: (ctx) => {
        ctx.sendEvent(edited, { runId: "run1", data: { title: "a" } });
        return null;
      },
    });
    // Whatever else a reference carries is never read, nor sent.
    const carrying = {
      ...edited,
      kind: "workflowEvent",
      workflow: "workflows.other",
      alias: "deleted",
      type: "notes.note.deleted",
    };
    const forgedEvents: unknown[] = [
      // Names that aren't an event's.
      { name: "workflows.followUp" },
      { name: "workflows.followUp.mutations.send" },
      { name: "notes.create" },
      { name: "workflows.followUp.events" },
      { name: "workflows.followUp.events.edited.more" },
      { name: "workflows.followUp.events.edited " },
      // Aliases that aren't plain names.
      { name: "workflows.__proto__.events.edited" },
      { name: "workflows.followUp.events.__proto__" },
      { name: "workflows.follow-up.events.edited" },
      { name: `workflows.followUp.events.${"e".repeat(65)}` },
      // Forged objects: the old shape, an inherited name, a name not text.
      {
        kind: "workflowEvent",
        workflow: "workflows.followUp",
        alias: "edited",
        type: "notes.note.edited",
      },
      Object.create(edited),
      { name: ["workflows.followUp.events.edited"] },
      "workflows.followUp.events.edited",
      null,
    ];
    const forged = server.mutation({
      args: { which: v.number().integer() },
      returns: v.null(),
      handler: (ctx, { which }) => {
        // One the host would take first: nothing is sent unless all are.
        Reflect.apply(ctx.sendEvent, ctx, [
          edited,
          { runId: "run1", data: { title: "a" } },
        ]);
        Reflect.apply(ctx.sendEvent, ctx, [
          forgedEvents[which],
          { runId: "run1", data: {} },
        ]);
        return null;
      },
    });
    const carried = server.mutation({
      args: {},
      returns: v.null(),
      handler: (ctx) => {
        Reflect.apply(ctx.sendEvent, ctx, [
          carrying,
          { runId: "run1", data: { title: "b" } },
        ]);
        return null;
      },
    });
    const registered = notes(
      { permissions: { workflows: [followUp] } },
      { notes: { notify, forged, carried } }
    );
    const { calls, channel } = recordingChannel();
    await runFunction(registered, "notes.notify", {}, channel);
    await runFunction(registered, "notes.carried", {}, channel);
    expect(calls).toStrictEqual([
      [
        "permission",
        "followUp",
        "sendEvent",
        ["edited", "run1", { title: "a" }],
      ],
      [
        "permission",
        "followUp",
        "sendEvent",
        ["edited", "run1", { title: "b" }],
      ],
    ]);
    const refused = await Promise.all(
      forgedEvents.map(async (_event, which) => {
        const recording = recordingChannel();
        try {
          await runFunction(
            registered,
            "notes.forged",
            { which },
            recording.channel
          );
        } catch (error) {
          const code: unknown =
            error instanceof Error ? Reflect.get(error, "code") : undefined;
          return { code, calls: recording.calls };
        }
        return { code: "accepted", calls: recording.calls };
      })
    );
    expect(refused).toStrictEqual(
      forgedEvents.map(() => ({ code: "function.not_found", calls: [] }))
    );
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

  test("a workflow reads back as declared, and shares no alias", () => {
    const { manifest } = inspectApp(
      notes({ permissions: { workflows: [followUp] } })
    );
    const declared = manifest.permissions.followUp;
    expect({
      kind: declared?.["~permission"],
      args: declared?.["~permission"] === "workflows" ? declared.args : null,
      readBack:
        canonicalText(readAppManifest(JSON.stringify(manifest))) ===
        canonicalText(manifest),
      sameAlias: refusal(() =>
        notes({
          permissions: {
            workflows: [followUp],
            connections: [
              permission.connection("followUp", {
                contract: "microsoft-365.mail@1",
                actions: ["send"],
              }),
            ],
          },
        })
      ).includes("alias `followUp`"),
    }).toStrictEqual({
      kind: "workflows",
      args: v.object({ title: v.string().trim() }).descriptor,
      readBack: true,
      sameAlias: true,
    });
  });

  test("a workflow's args are there, or their default, when a start leaves them out", () => {
    const optional = refusal(() =>
      permission.workflow("followUp", {
        args: v.string().optional(),
        returns: v.null(),
      })
    );
    const defaulted = permission.workflow("followUp", {
      args: v.string().default("Today"),
      returns: v.null(),
    });
    // Declared without what a run returns, it is refused, whatever
    // the types let through.
    const noReturns = refusal(() =>
      Reflect.apply(permission.workflow, permission, [
        "followUp",
        { args: v.object({}) },
      ])
    );
    expect({
      optional: optional.includes("never only optional"),
      defaulted: defaulted.args.presence,
      noReturns: noReturns.length > 0,
    }).toStrictEqual({ optional: true, defaulted: "default", noReturns: true });
  });

  test("a manifest can't file a permission under another alias, or make one out of something else", () => {
    const { manifest } = inspectApp(
      notes({ permissions: { workflows: [followUp], people: true } })
    );
    const altered = (
      change: (permissions: Record<string, unknown>) => void
    ): string => {
      // SAFETY: a plain copy of the manifest, whose permissions are objects.
      const copy = structuredClone(manifest) as {
        permissions: Record<string, unknown>;
      };
      change(copy.permissions);
      return refusal(() => readAppManifest(JSON.stringify(copy)));
    };
    expect({
      // A workflow under an alias that isn't its own.
      renamed: altered((permissions) => {
        permissions.other = permissions.followUp;
        delete permissions.followUp;
      }).includes("isn't filed under its alias"),
      // A workflow without what a run returns.
      noReturns:
        altered((permissions) => {
          // SAFETY: the workflow declaration, an object with its returns.
          const { returns: _returns, ...withoutReturns } =
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            permissions.followUp as { returns: unknown };
          permissions.followUp = withoutReturns;
        }).length > 0,
      // `people` that declares more than itself.
      widenedPeople: altered((permissions) => {
        permissions.people = {
          "~permission": "people",
          alias: "people",
          teams: ["all"],
        };
      }).includes("declares nothing but itself"),
      // A kind no App holds.
      unknownKind: altered((permissions) => {
        permissions.crm = { "~permission": "apps", alias: "crm" };
      }).includes("isn't one this SDK knows"),
    }).toStrictEqual({
      renamed: true,
      noReturns: true,
      widenedPeople: true,
      unknownKind: true,
    });
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
    ["`input`", { input: {}, returns: v.null() }, "has no `input`"],
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
      "the permissions' namespace",
      "permission.unavailable",
      "platform's `permission`",
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

  test("a write with options it doesn't take is refused before the host", async () => {
    const db = databaseWriter(
      schema,
      async () => await Promise.resolve(null),
      async () => await Promise.reject(new Error("reached the host"))
    );
    // SAFETY: deliberately ill-typed views, for calls the types refuse.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const loosePatch = db.patch as (...args: unknown[]) => Promise<void>;
    // SAFETY: as above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const looseDelete = db.delete as (...args: unknown[]) => Promise<void>;
    // SAFETY: as above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const looseInsert = db.insert as (...args: unknown[]) => Promise<unknown>;
    await expect(
      loosePatch("notes", "n", {}, { expectedRevision: 1 })
    ).rejects.toThrow("{ unset }");
    await expect(
      looseDelete("notes", "n", { expectedRevision: 1 })
    ).rejects.toThrow("takes no options");
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
      permission: async () => await Promise.resolve(null),
      emit: async () => await Promise.resolve(null),
      people: async () => await Promise.resolve(null),
    };
    await expect(
      runFunction(registered, "notes.recover", {}, channel)
    ).resolves.toBe("note.closed: Notes are closed.");
  });
});

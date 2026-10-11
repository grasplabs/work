import {
  AppError,
  app,
  defineSchema,
  defineTable,
  resource,
  v,
} from "@grasp-os/sdk";
import { inspectApp, manifestText } from "@grasp-os/sdk/host";
import { runFunction } from "@grasp-os/sdk/runner";
import type { OperationChannel } from "@grasp-os/sdk/runner";
import { serverModule } from "@grasp-os/sdk/server";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { effectErrors } from "@grasp-os/shared/operations";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { operationRoles } from "../src/app-access.ts";
import { createApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { callMaxDepth, callOperation } from "../src/operations.ts";
import type {
  BoundResource,
  ResourceBindings,
  ResourceContext,
  Runner,
} from "../src/operations.ts";

// Actions (spec 7.4, 12): server functions with no database, which
// compose the App's queries and mutations, each its own invocation, and
// reach outside only through the resources they declare. Run through
// core's operation host against a real store and the App's real roles.
// The resource adapters below stand for the outside providers (connect's
// connectors, the model gateway): the only thing mocked.

const schema = defineSchema({
  notes: defineTable({ title: v.string().trim().min(1).max(200) }),
});

const { query, mutation, action, internalQuery, doc } = serverModule(schema);

const get = query({
  args: { id: v.id("notes") },
  returns: doc("notes").nullable(),
  handler: async (ctx, args) => await ctx.db.get("notes", args.id),
});

const count = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => await ctx.db.query("notes").count(),
});

const create = mutation({
  args: { title: v.string() },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

const reject = mutation({
  args: {},
  returns: v.null(),
  handler: () => {
    throw new AppError("note.rejected", "Notes are closed today.");
  },
});

/** A mutation that inserts, then counts in its staged state. */
const createAndCount = mutation({
  args: { title: v.string() },
  returns: v.number(),
  uses: [count],
  handler: async (ctx, args) => {
    await ctx.db.insert("notes", args);
    return await ctx.runQuery(count, {});
  },
});

/** Narrowed to inserting: the queries it runs can't read for it. */
const blindCount = mutation({
  args: {},
  returns: v.number(),
  uses: [count],
  handler: async (ctx) => await ctx.runQuery(count, {}),
});

const compose = action({
  args: { title: v.string() },
  returns: v.object({ title: v.string(), count: v.number() }),
  uses: [create, get, count],
  handler: async (ctx, args) => {
    const id = await ctx.runMutation(create, { title: args.title });
    const note = await ctx.runQuery(get, { id });
    if (!note) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    return { title: note.title, count: await ctx.runQuery(count, {}) };
  },
});

const createThenFail = action({
  args: { title: v.string() },
  returns: v.null(),
  uses: [create],
  handler: async (ctx, args) => {
    await ctx.runMutation(create, { title: args.title });
    throw new AppError("note.after_create", "Created, then failed.");
  },
});

const rethrow = action({
  args: {},
  returns: v.null(),
  uses: [reject],
  handler: async (ctx) => await ctx.runMutation(reject, {}),
});

const recover = action({
  args: {},
  returns: v.string(),
  uses: [reject],
  handler: async (ctx) => {
    try {
      await ctx.runMutation(reject, {});
      return "accepted";
    } catch (error) {
      return error instanceof Error && "code" in error
        ? String(error.code)
        : "unknown";
    }
  },
});

// A chain of actions one deeper than a call may go (`callMaxDepth`, 3),
// each calling the next: `level0` reaches `level4` four calls down.
const level4 = action({
  args: {},
  returns: v.string(),
  handler: () => "deep",
});
const level3 = action({
  args: {},
  returns: v.string(),
  uses: [level4],
  handler: async (ctx) => await ctx.runAction(level4, {}),
});
const level2 = action({
  args: {},
  returns: v.string(),
  uses: [level3],
  handler: async (ctx) => await ctx.runAction(level3, {}),
});
const level1 = action({
  args: {},
  returns: v.string(),
  uses: [level2],
  handler: async (ctx) => await ctx.runAction(level2, {}),
});
const level0 = action({
  args: {},
  returns: v.string(),
  uses: [level1],
  handler: async (ctx) => await ctx.runAction(level1, {}),
});

const mail = resource.connector("mail", {
  contract: "grasp.mail@1",
  actions: ["send"],
});
const summarizer = resource.model("summarizer", {
  structuredOutput: v.object({ summary: v.string() }),
  maxOutputTokens: 200,
});
const help = resource.knowledge("help", {
  operations: ["search"],
  collections: ["handbook"],
});
const letter = resource.template("letter", { contract: "grasp.letter@1" });

const sendMail = action({
  args: { to: v.string().email() },
  returns: v.object({ messageId: v.string() }),
  uses: [mail],
  handler: async (ctx, args) => {
    const sent = await ctx.resources.mail.call("send", { to: args.to });
    if (typeof sent !== "object" || sent === null || Array.isArray(sent)) {
      throw new AppError("mail.unexpected", "The mail answer was unexpected.");
    }
    return {
      messageId: typeof sent.messageId === "string" ? sent.messageId : "",
    };
  },
});

const summarize = action({
  args: { text: v.string() },
  returns: v.object({ summary: v.string() }),
  uses: [summarizer],
  handler: async (ctx, args) =>
    await ctx.resources.summarizer.generate({ prompt: args.text }),
});

const searchHelp = action({
  args: { text: v.string().min(1) },
  returns: v
    .array(v.object({ title: v.string(), excerpt: v.string() }))
    .max(20),
  uses: [help],
  handler: async (ctx, args) =>
    await ctx.resources.help.search({ text: args.text, limit: 5 }),
});

const readLetter = action({
  args: {},
  returns: v.number(),
  uses: [letter],
  handler: async (ctx) => {
    const template = await ctx.resources.letter.read();
    return template.version;
  },
});

const streaming = action({
  args: {},
  returns: v.null(),
  stream: v.object({ done: v.number() }),
  handler: () => null,
});

const notesApp = app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: {
    notes: { get, create, reject, createAndCount, blindCount },
    actions: {
      compose,
      createThenFail,
      rethrow,
      recover,
      sendMail,
      summarize,
      searchHelp,
      readLetter,
      streaming,
    },
    chain: { level0, level1, level2, level3, level4 },
  },
  internalOperations: { count },
  operationAccess: {
    "notes.blindCount": { tables: { notes: { insert: true } } },
  },
  screens: {},
  uses: [mail, summarizer, help, letter],
});

const { manifest } = inspectApp(notesApp);

const defaultRun: Runner = async (path, args, channel) =>
  await runFunction(notesApp, path, args, channel);

/** A person of the organization in `role`, as their session has them. */
const person = async (): Promise<Acting> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, 'builder', ?)"
    ).bind(crypto.randomUUID(), userId, Date.now()),
  ]);
  return { userId, role: "builder", teams: [], staff: false };
};

interface Fixture {
  readonly owner: Acting;
  readonly appId: AppId;
  readonly store: OpenStore;
}

const notes = async (): Promise<Fixture> => {
  const owner = await person();
  const { id: appId } = await createApp(env, owner, { name: "Notes" });
  const store = await openStore(env, await createStore(env, owner));
  await store.defineTables(manifestText(manifest.schema));
  return { owner, appId, store };
};

interface CallOptions {
  readonly run?: Runner;
  readonly idempotencyKey?: string;
  readonly resources?: ResourceBindings;
}

const call = async (
  { owner, appId, store }: Fixture,
  kind: string,
  path: string,
  args: unknown,
  { run = defaultRun, idempotencyKey, resources }: CallOptions = {}
): Promise<OperationResult> =>
  await callOperation(
    { manifest, run },
    {
      principal: owner.userId,
      consumer: { resourceId: appId, resourceVersion: 1 },
      store,
      requestId: crypto.randomUUID(),
      deadline: Date.now() + 60_000,
      runId: null,
      authorize: async () => await operationRoles(env, owner, appId),
      ...(resources === undefined ? {} : { resources }),
    },
    { path, kind },
    args,
    idempotencyKey === undefined ? {} : { idempotencyKey }
  );

const valueOf = (result: OperationResult): Json => {
  if (!result.ok) {
    throw new Error(`The call failed: ${result.error.code}`);
  }
  return result.value;
};

/** A failed call's error without its request ID, which must be there. */
const failureOf = (result: OperationResult) => {
  if (result.ok) {
    throw new Error("The call succeeded");
  }
  const { requestId, ...rest } = result.error;
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
  return rest;
};

const codeOf = (result: OperationResult): string =>
  result.ok ? "ok" : result.error.code;

/** How many notes the store holds for the fixture's owner. */
const noteCount = async (fixture: Fixture): Promise<Json> =>
  valueOf(
    await call(fixture, "mutation", "notes.createAndCount", { title: "probe" })
  );

/**
 * A runner that does `misuse` with its channel instead of running the
 * function at `path`, and runs the App's own code for any other.
 */
const misusing = (
  path: string,
  misuse: (channel: OperationChannel) => Promise<unknown>
): Runner => {
  const run: Runner = async (called, args, channel) =>
    called === path
      ? await misuse(channel)
      : await defaultRun(called, args, channel);
  return run;
};

/** A provider that answers every request with one message ID. */
const messageSent = async () => await Promise.resolve({ messageId: "m" });

/** A binding of `kind` serving `contract`, answering with `answer`. */
const bound = (
  kind: BoundResource["kind"],
  contract: string | null,
  answer: (
    method: string,
    args: readonly Json[],
    context: ResourceContext
  ) => Promise<unknown>
): BoundResource => ({ kind, contract, call: answer });

/** Bindings serving each alias with the binding `of` gives, if any. */
const bindingsOf =
  (of: Readonly<Record<string, BoundResource>>): ResourceBindings =>
  async (declaration) =>
    await Promise.resolve(
      Object.hasOwn(of, declaration.alias) ? of[declaration.alias] : undefined
    );

describe("composing the App's functions", () => {
  it("runs the queries and mutations it uses, internal ones included", async () => {
    const fixture = await notes();
    expect(
      valueOf(
        await call(fixture, "action", "actions.compose", { title: " Plan " })
      )
    ).toStrictEqual({ title: "Plan", count: 1 });
  });

  it("commits each mutation on its own: a later failure keeps it", async () => {
    const fixture = await notes();
    expect(
      failureOf(
        await call(fixture, "action", "actions.createThenFail", {
          title: "Kept",
        })
      )
    ).toStrictEqual({
      code: "note.after_create",
      message: "Created, then failed.",
      category: "domain",
      retryable: false,
    });
    // The probe inserts one more and counts both.
    await expect(noteCount(fixture)).resolves.toBe(2);
  });

  it("answers the same mutation's outcome again when the action is called again under its key", async () => {
    const fixture = await notes();
    const first = await call(
      fixture,
      "action",
      "actions.compose",
      { title: "Once" },
      { idempotencyKey: "a1" }
    );
    const again = await call(
      fixture,
      "action",
      "actions.compose",
      { title: "Once" },
      { idempotencyKey: "a1" }
    );
    const other = await call(
      fixture,
      "action",
      "actions.compose",
      { title: "Once" },
      { idempotencyKey: "a2" }
    );
    expect([first, again, other].map(valueOf)).toStrictEqual([
      { title: "Once", count: 1 },
      { title: "Once", count: 1 },
      { title: "Once", count: 2 },
    ]);
  });

  it("hands a domain failure of a function it called to its code, to handle or throw on", async () => {
    const fixture = await notes();
    expect({
      thrownOn: failureOf(await call(fixture, "action", "actions.rethrow", {})),
      handled: valueOf(await call(fixture, "action", "actions.recover", {})),
    }).toStrictEqual({
      thrownOn: {
        code: "note.rejected",
        message: "Notes are closed today.",
        category: "domain",
        retryable: false,
      },
      handled: "note.rejected",
    });
  });

  it("goes as deep as a call may, and no deeper", async () => {
    const fixture = await notes();
    expect(callMaxDepth).toBe(3);
    expect({
      deepest: codeOf(await call(fixture, "action", "chain.level0", {})),
      shallower: valueOf(await call(fixture, "action", "chain.level1", {})),
    }).toStrictEqual({
      deepest: "operation.depth_exceeded",
      shallower: "deep",
    });
  });

  it("lets a mutation run a query in its staged state, reading only what both may read", async () => {
    const fixture = await notes();
    expect({
      staged: valueOf(
        await call(fixture, "mutation", "notes.createAndCount", { title: "a" })
      ),
      narrowed: codeOf(await call(fixture, "mutation", "notes.blindCount", {})),
    }).toStrictEqual({ staged: 1, narrowed: "data.access_denied" });
  });

  it("refuses a stream until the streaming runtime delivers it", async () => {
    const fixture = await notes();
    expect(codeOf(await call(fixture, "action", "actions.streaming", {}))).toBe(
      "operation.unsupported"
    );
  });
});

describe("an action's channel", () => {
  it("has no database, and calls only what the action uses, as the kind it is", async () => {
    const fixture = await notes();
    const attempt = async (
      misuse: (channel: OperationChannel) => Promise<unknown>
    ) =>
      codeOf(
        await call(
          fixture,
          "action",
          "actions.compose",
          { title: "x" },
          {
            run: misusing("actions.compose", misuse),
          }
        )
      );
    expect({
      read: await attempt(
        async (channel) =>
          await channel.read({
            kind: "get",
            table: "notes",
            id: "x",
            expectedRevision: null,
          })
      ),
      write: await attempt(
        async (channel) =>
          await channel.write({
            kind: "insert",
            table: "notes",
            fields: { title: "x" },
          })
      ),
      unused: await attempt(
        async (channel) => await channel.call("mutation", "notes.reject", {})
      ),
      wrongKind: await attempt(
        async (channel) =>
          await channel.call("mutation", "notes.get", { id: "x" })
      ),
      resource: await attempt(
        async (channel) => await channel.resource("mail", "call", ["send", {}])
      ),
    }).toStrictEqual({
      read: "operation.no_database",
      write: "operation.no_database",
      unused: "operation.not_found",
      wrongKind: "operation.kind_mismatch",
      resource: "resource.not_allowed",
    });
  });
});

describe("resources", () => {
  const mailBinding = (
    answer: (
      args: readonly Json[],
      context: ResourceContext
    ) => Promise<unknown>
  ) =>
    bindingsOf({
      mail: bound(
        "connector",
        "grasp.mail@1",
        async (_method, args, context) => await answer(args, context)
      ),
    });

  it("reach the provider through the binding, with a key derived from the action's own", async () => {
    const fixture = await notes();
    const seen: ResourceContext[] = [];
    const resources = mailBinding(async (args, context) => {
      seen.push(context);
      return await Promise.resolve({ messageId: `m-${JSON.stringify(args)}` });
    });
    const send = async (key: string) =>
      await call(
        fixture,
        "action",
        "actions.sendMail",
        { to: "ada@acme.test" },
        {
          resources,
          idempotencyKey: key,
        }
      );
    const results = [await send("k1"), await send("k1"), await send("k2")];
    expect({
      results: results.map(valueOf),
      sameKey: seen[0]?.idempotencyKey === seen[1]?.idempotencyKey,
      otherKey: seen[0]?.idempotencyKey === seen[2]?.idempotencyKey,
    }).toStrictEqual({
      results: Array.from({ length: 3 }, () => ({
        messageId: 'm-["send",{"to":"ada@acme.test"}]',
      })),
      sameKey: true,
      otherKey: false,
    });
  });

  it("are unavailable without a binding, or with one serving another contract or kind", async () => {
    const fixture = await notes();
    const send = async (resources?: ResourceBindings) =>
      codeOf(
        await call(
          fixture,
          "action",
          "actions.sendMail",
          { to: "ada@acme.test" },
          resources === undefined ? {} : { resources }
        )
      );
    expect({
      none: await send(),
      otherContract: await send(
        bindingsOf({ mail: bound("connector", "grasp.mail@2", messageSent) })
      ),
      otherKind: await send(
        bindingsOf({ mail: bound("model", null, messageSent) })
      ),
    }).toStrictEqual({
      none: "resource.unavailable",
      otherContract: "resource.unavailable",
      otherKind: "resource.unavailable",
    });
  });

  it("refuse a use the declaration doesn't allow, before the provider hears of it", async () => {
    const fixture = await notes();
    let reached = false;
    const resources = mailBinding(async () => {
      reached = true;
      return await Promise.resolve({ messageId: "m" });
    });
    const attempt = async (
      misuse: (channel: OperationChannel) => Promise<unknown>
    ) =>
      codeOf(
        await call(
          fixture,
          "action",
          "actions.sendMail",
          { to: "ada@acme.test" },
          {
            resources,
            run: misusing("actions.sendMail", misuse),
          }
        )
      );
    expect({
      undeclaredAction: await attempt(
        async (channel) =>
          await channel.resource("mail", "call", ["delete", {}])
      ),
      undeclaredAlias: await attempt(
        async (channel) =>
          await channel.resource("help", "search", [{ text: "a" }])
      ),
      reached,
    }).toStrictEqual({
      undeclaredAction: "resource.not_allowed",
      undeclaredAlias: "resource.not_allowed",
      reached: false,
    });
  });

  it("never pass a provider's failure on, but keep an unknown outcome as it is", async () => {
    const fixture = await notes();
    const send = async (failure: Error) =>
      failureOf(
        await call(
          fixture,
          "action",
          "actions.sendMail",
          { to: "ada@acme.test" },
          {
            resources: mailBinding(async () => await Promise.reject(failure)),
          }
        )
      );
    expect({
      leaked: await send(
        new Error("401 from provider: token sk-live-abc123 rejected")
      ),
      unknown: await send(effectErrors.create("effect.outcome_unknown")),
    }).toStrictEqual({
      leaked: {
        code: "internal.unexpected",
        message: "Something went wrong.",
        category: "operational",
        retryable: false,
      },
      unknown: {
        code: "effect.outcome_unknown",
        message:
          "Whether the external request took effect is unknown. It wasn't retried.",
        category: "uncertain",
        retryable: false,
      },
    });
  });

  it("check what a model, knowledge and a template answer against their contracts", async () => {
    const fixture = await notes();
    const summarizeWith = async (answer: unknown) =>
      await call(
        fixture,
        "action",
        "actions.summarize",
        { text: "long" },
        {
          resources: bindingsOf({
            summarizer: bound(
              "model",
              null,
              async () => await Promise.resolve(answer)
            ),
          }),
        }
      );
    const searchWith = async (answer: unknown) =>
      await call(
        fixture,
        "action",
        "actions.searchHelp",
        { text: "leave" },
        {
          resources: bindingsOf({
            help: bound(
              "knowledge",
              null,
              async () => await Promise.resolve(answer)
            ),
          }),
        }
      );
    const readWith = async (answer: unknown) =>
      await call(
        fixture,
        "action",
        "actions.readLetter",
        {},
        {
          resources: bindingsOf({
            letter: bound(
              "template",
              "grasp.letter@1",
              async () => await Promise.resolve(answer)
            ),
          }),
        }
      );
    expect({
      summary: valueOf(await summarizeWith({ summary: "Short" })),
      summaryWrong: codeOf(await summarizeWith({ summary: 1 })),
      hits: valueOf(
        await searchWith([{ title: "Leave", excerpt: "Days off" }])
      ),
      hitsWithMore: codeOf(
        await searchWith([{ title: "Leave", excerpt: "Days off", secret: "x" }])
      ),
      template: valueOf(
        await readWith({ contract: "grasp.letter@1", version: 3, content: {} })
      ),
      otherTemplate: codeOf(
        await readWith({ contract: "grasp.other@1", version: 3, content: {} })
      ),
    }).toStrictEqual({
      summary: { summary: "Short" },
      summaryWrong: "contract.invalid_resource_result",
      hits: [{ title: "Leave", excerpt: "Days off" }],
      hitsWithMore: "contract.invalid_resource_result",
      template: 3,
      otherTemplate: "contract.invalid_resource_result",
    });
  });
});

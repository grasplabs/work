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
import { connectErrors } from "@grasp-os/shared/connect";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { streamMaxEmits } from "@grasp-os/shared/operation-limits";
import { effectErrors, operationErrors } from "@grasp-os/shared/operations";
import type { OperationResult } from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { WriterRoles } from "@grasp-os/shared/stores";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { keepsReceipt } from "../src/action-invocation.ts";
import { operationRoles } from "../src/app-access.ts";
import { invocationFor, runInvocationFor } from "../src/app-functions.ts";
import { createApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { callMaxNested } from "../src/call-limits.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import {
  callMaxDepth,
  callMaxResourceRequests,
  callOperation,
} from "../src/operations.ts";
import type {
  BoundResource,
  ProgressSink,
  ResourceBindings,
  ResourceContext,
  Runner,
  UseRefusal,
} from "../src/operations.ts";
import { hostedRelease } from "../src/release-runner.ts";
import { allEvents } from "./audit-events.ts";
import { appWith, seal } from "./sealed-apps.ts";

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
  contract: "microsoft-365.mail@1",
  actions: ["send"],
});

/** A mail to `to`, as the contract's `send` takes it. */
const mailTo = (to: string) => ({
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "Hi.",
  to: [to],
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
// Guest chats it lists and reads, and never invites.
const guestbook = resource.guests("guestbook", {
  operations: ["list", "read"],
});

/** A workflow the App declares, which no function here lists. */
const followUp = resource.workflow("followUp", {
  input: v.object({ who: v.string() }),
  output: v.object({ status: v.string() }),
});

const sendMail = action({
  args: { to: v.string().email() },
  returns: v.object({ mailbox: v.string() }),
  uses: [mail],
  handler: async (ctx, args) => {
    const sent = await ctx.resources.mail.call("send", mailTo(args.to));
    return { mailbox: sent.mailbox };
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

const listGuests = action({
  args: {},
  returns: v.number(),
  uses: [guestbook],
  handler: async (ctx) => {
    const chats = await ctx.resources.guestbook.list();
    return chats.length;
  },
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

const remove = mutation({
  args: { id: v.id("notes"), expectedRevision: v.number().integer().min(1) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete("notes", args.id, {
      expectedRevision: args.expectedRevision,
    });
    return null;
  },
});

/** Reads the table `reads` times. */
const readMany = internalQuery({
  args: { reads: v.number().integer().min(0).max(1000) },
  returns: v.number(),
  handler: async (ctx, args) => {
    for (let index = 0; index < args.reads; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one read after the other
      await ctx.db.query("notes").first();
    }
    return args.reads;
  },
});

/** Runs `calls` queries, each reading `reads` times. */
const fanOut = action({
  args: {
    calls: v.number().integer().min(0).max(1000),
    reads: v.number().integer().min(0).max(1000),
  },
  returns: v.number(),
  uses: [readMany],
  handler: async (ctx, args) => {
    for (let index = 0; index < args.calls; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one call after the other
      await ctx.runQuery(readMany, { reads: args.reads });
    }
    return args.calls;
  },
});

/** Sends `count` mails. */
const sendMany = action({
  args: { count: v.number().integer().min(0).max(1000) },
  returns: v.number(),
  uses: [mail],
  handler: async (ctx, args) => {
    for (let index = 0; index < args.count; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one request after the other
      await ctx.resources.mail.call("send", mailTo("ada@acme.test"));
    }
    return args.count;
  },
});

/** Sends one mail, as `sendMail` does, from another action. */
const sendMailToo = action({
  args: { to: v.string().email() },
  returns: v.null(),
  uses: [mail],
  handler: async (ctx, args) => {
    await ctx.resources.mail.call("send", mailTo(args.to));
    return null;
  },
});

/** Creates a note, as `compose` does first, from another action. */
const createOnly = action({
  args: { title: v.string() },
  returns: v.id("notes"),
  uses: [create],
  handler: async (ctx, args) =>
    await ctx.runMutation(create, { title: args.title }),
});

/**
 * Looks note `id` up, counts the notes only while it exists, then creates
 * one: how many queries it runs depends on the data.
 */
const conditional = action({
  args: { id: v.id("notes") },
  returns: v.id("notes"),
  uses: [get, count, create],
  handler: async (ctx, args) => {
    const note = await ctx.runQuery(get, { id: args.id });
    if (note) {
      await ctx.runQuery(count, {});
    }
    return await ctx.runMutation(create, { title: "conditional" });
  },
});

/** Catches a called mutation's domain failure by its class. */
const recoverByClass = action({
  args: {},
  returns: v.string(),
  uses: [reject],
  handler: async (ctx) => {
    try {
      await ctx.runMutation(reject, {});
      return "accepted";
    } catch (error) {
      return error instanceof AppError ? error.code : "not an AppError";
    }
  },
});

/** Starts a mutation and returns without waiting for it. */
const fireAndForget = action({
  args: { title: v.string() },
  returns: v.null(),
  uses: [create],
  handler: (ctx, args) => {
    void ctx.runMutation(create, { title: args.title });
    return null;
  },
});

/** Races a mutation against an answer ready at once. */
const raced = action({
  args: { title: v.string() },
  returns: v.string(),
  uses: [create],
  handler: async (ctx, args) =>
    await Promise.race([
      ctx.runMutation(create, { title: args.title }).then(() => "mutation"),
      Promise.resolve("first"),
    ]),
});

/** Races a mutation that fails against an answer ready at once. */
const racedFailure = action({
  args: {},
  returns: v.string(),
  uses: [reject],
  handler: async (ctx) => {
    const rejected = ctx.runMutation(reject, {});
    rejected.catch(() => null);
    return await Promise.race([
      rejected.then(() => "mutation"),
      Promise.resolve("first"),
    ]);
  },
});

/** Starts a mutation a little after it has returned. */
const startLater = action({
  args: { title: v.string() },
  returns: v.null(),
  uses: [create],
  handler: (ctx, args) => {
    setTimeout(() => {
      ctx.runMutation(create, { title: args.title }).catch(() => null);
    }, 5);
    return null;
  },
});

/** Starts a mutation, handles its failure, and returns without waiting. */
const fireAndForgetCaught = action({
  args: { title: v.string() },
  returns: v.null(),
  uses: [create],
  handler: (ctx, args) => {
    ctx.runMutation(create, { title: args.title }).catch(() => null);
    return null;
  },
});

/** Counts the notes twice, failing when the two counts differ. */
const consistentPair = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const counted = await ctx.db.query("notes").count();
    const listed = await ctx.db.query("notes").collect();
    if (counted !== listed.length) {
      throw new AppError("note.torn", "The notes changed between two reads.");
    }
    return counted;
  },
});

/** Starts a consistency check and returns without waiting for it. */
const checkLater = mutation({
  args: {},
  returns: v.string(),
  uses: [consistentPair],
  handler: (ctx) => {
    ctx.runQuery(consistentPair, {}).catch(() => null);
    return "done";
  },
});

const streaming = action({
  args: {},
  returns: v.null(),
  stream: v.object({ done: v.number() }),
  handler: async (ctx) => {
    await ctx.emit({ done: 1 });
    await ctx.emit({ done: 2 });
    return null;
  },
});

/** Runs the streaming action nested, where its progress has nowhere to go. */
const nestsStreaming = action({
  args: {},
  returns: v.string(),
  uses: [streaming],
  handler: async (ctx) => {
    try {
      // @ts-expect-error -- a streaming action isn't run nested
      await ctx.runAction(streaming, {});
    } catch (error) {
      const code: unknown =
        error instanceof Error ? Reflect.get(error, "code") : undefined;
      return typeof code === "string" ? code : "thrown";
    }
    return "ran";
  },
});

/** A streaming action that saves a note after its first snapshot. */
const savesWhileStreaming = action({
  args: { title: v.string() },
  returns: v.null(),
  stream: v.object({ done: v.number() }),
  uses: [create],
  handler: async (ctx, args) => {
    await ctx.emit({ done: 0 });
    await ctx.runMutation(create, { title: args.title });
    return null;
  },
});

/** A streaming action that sends a mail after its first snapshot. */
const sendsWhileStreaming = action({
  args: { to: v.string().email() },
  returns: v.null(),
  stream: v.object({ done: v.number() }),
  uses: [mail],
  handler: async (ctx, args) => {
    await ctx.emit({ done: 0 });
    await ctx.resources.mail.call("send", mailTo(args.to));
    return null;
  },
});

/** A streaming action that sends a mail without waiting for it, and returns. */
const sendsAndLeaves = action({
  args: { to: v.string().email() },
  returns: v.null(),
  stream: v.object({ done: v.number() }),
  uses: [mail],
  handler: async (ctx, args) => {
    await ctx.emit({ done: 0 });
    void ctx.resources.mail.call("send", mailTo(args.to));
    return null;
  },
});

/** A streaming action that saves a note without waiting for it, and returns. */
const savesAndLeaves = action({
  args: { title: v.string() },
  returns: v.null(),
  stream: v.object({ done: v.number() }),
  uses: [create],
  handler: async (ctx, args) => {
    await ctx.emit({ done: 0 });
    void ctx.runMutation(create, { title: args.title });
    return null;
  },
});

/** A streaming action that emits `count` snapshots, then answers how many. */
const emitsMany = action({
  args: { count: v.number().integer().min(0) },
  returns: v.number(),
  stream: v.object({ done: v.number() }),
  handler: async (ctx, args) => {
    for (let done = 1; done <= args.count; done += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one snapshot after another
      await ctx.emit({ done });
    }
    return args.count;
  },
});

/** Saves a note, then sends a mail. */
const savesThenSends = action({
  args: { title: v.string(), to: v.string().email() },
  returns: v.null(),
  uses: [create, mail],
  handler: async (ctx, args) => {
    await ctx.runMutation(create, { title: args.title });
    await ctx.resources.mail.call("send", mailTo(args.to));
    return null;
  },
});

/** An action that doesn't stream: its context has no `emit`. */
const emitsAnyway = action({
  args: {},
  returns: v.string(),
  handler: (ctx) => ("emit" in ctx ? "emit" : "no emit"),
});

const notesApp = app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: {
    notes: {
      get,
      create,
      reject,
      createAndCount,
      blindCount,
      remove,
      checkLater,
    },
    actions: {
      listGuests,
      compose,
      createThenFail,
      rethrow,
      recover,
      sendMail,
      summarize,
      searchHelp,
      readLetter,
      streaming,
      nestsStreaming,
      emitsAnyway,
      savesWhileStreaming,
      sendsWhileStreaming,
      sendsAndLeaves,
      savesAndLeaves,
      emitsMany,
      savesThenSends,
      fanOut,
      sendMany,
      sendMailToo,
      createOnly,
      conditional,
      recoverByClass,
      fireAndForget,
      raced,
      racedFailure,
      startLater,
      fireAndForgetCaught,
    },
    chain: { level0, level1, level2, level3, level4 },
  },
  internalOperations: { count, readMany, consistentPair },
  operationAccess: {
    "notes.blindCount": { tables: { notes: { insert: true } } },
  },
  screens: [],
  uses: [mail, summarizer, help, letter, guestbook, followUp],
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
  /** How long the call may take, in milliseconds: a minute unless set. */
  readonly within?: number;
  readonly idempotencyKey?: string;
  readonly resources?: ResourceBindings;
  /** The admission, in place of the caller's roles read as they are. */
  readonly authorize?: () => Promise<WriterRoles>;
  /** For a streaming action: where its progress goes. */
  readonly progress?: ProgressSink;
  /** Cancels the call once aborted. */
  readonly cancelled?: AbortSignal;
  /** Told of each effect the call makes. */
  readonly onEffect?: () => void;
  /** Keeps the evidence of a use the host refused. */
  readonly refusedUse?: (refusal: UseRefusal) => Promise<void>;
}

const call = async (
  { owner, appId, store }: Fixture,
  kind: string,
  path: string,
  args: unknown,
  {
    run = defaultRun,
    idempotencyKey,
    resources,
    within = 60_000,
    authorize,
    progress,
    cancelled,
    onEffect,
    refusedUse,
  }: CallOptions = {}
): Promise<OperationResult> =>
  await callOperation(
    { manifest, run },
    {
      principal: owner.userId,
      consumer: { resourceId: appId, resourceVersion: 1 },
      store,
      requestId: crypto.randomUUID(),
      deadline: Date.now() + within,
      runId: null,
      authorize:
        authorize ?? (async () => await operationRoles(env, owner, appId)),
      ...(resources === undefined ? {} : { resources }),
      ...(refusedUse === undefined ? {} : { refusedUse }),
    },
    { path, kind },
    args,
    {
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(progress === undefined ? {} : { progress }),
      ...(cancelled === undefined ? {} : { cancelled }),
      ...(onEffect === undefined ? {} : { onEffect }),
    }
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

/** A provider that answers every request as one mail sent. */
const messageSent = async () =>
  await Promise.resolve({ mailbox: "m", sent: true });

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

describe("the one admission", () => {
  it("admits each resource request as each commit is admitted, by the same authorize", async () => {
    const fixture = await notes();
    const roles = await operationRoles(env, fixture.owner, fixture.appId);
    // Counts its calls, and refuses from the `refuseFrom`th on.
    const counted = (refuseFrom = Number.POSITIVE_INFINITY) => {
      const seen = { calls: 0 };
      const authorize = async (): Promise<WriterRoles> => {
        seen.calls += 1;
        if (seen.calls >= refuseFrom) {
          throw permissionErrors.create("permission.denied", {
            action: "call",
          });
        }
        return await Promise.resolve(roles);
      };
      return { seen, authorize };
    };
    let provided = 0;
    const resources = bindingsOf({
      summarizer: bound("model", null, async () => {
        provided += 1;
        return await Promise.resolve({ summary: "short" });
      }),
    });
    const commit = counted();
    await call(fixture, "mutation", "notes.create", { title: "Plan" }, commit);
    const request = counted();
    await call(
      fixture,
      "action",
      "actions.summarize",
      { text: "long" },
      {
        ...request,
        resources,
      }
    );
    // Refused as the request is about to go: the provider never sees it.
    const refusing = counted(2);
    const refused = await call(
      fixture,
      "action",
      "actions.summarize",
      { text: "long" },
      { authorize: refusing.authorize, resources }
    );
    expect({
      // The start and the commit; the start and the request.
      commit: commit.seen.calls,
      request: request.seen.calls,
      refused: codeOf(refused),
      provided,
    }).toStrictEqual({
      commit: 2,
      request: 2,
      refused: "permission.denied",
      provided: 1,
    });
  });
});

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

  it("runs a streaming action only where its progress has somewhere to go", async () => {
    const fixture = await notes();
    const published: Json[] = [];
    const sink = {
      publish: (progress: Json) => {
        published.push(progress);
      },
    };
    expect({
      single: codeOf(await call(fixture, "action", "actions.streaming", {})),
      streamed: codeOf(
        await call(
          fixture,
          "action",
          "actions.streaming",
          {},
          { progress: sink }
        )
      ),
      published,
      // An action that answers once, given somewhere for progress.
      other: codeOf(
        await call(
          fixture,
          "action",
          "actions.compose",
          { title: "x" },
          {
            progress: sink,
          }
        )
      ),
      nested: valueOf(
        await call(fixture, "action", "actions.nestsStreaming", {})
      ),
      noEmit: valueOf(await call(fixture, "action", "actions.emitsAnyway", {})),
      cancelled: codeOf(
        await call(
          fixture,
          "action",
          "actions.streaming",
          {},
          {
            progress: sink,
            cancelled: AbortSignal.abort(),
          }
        )
      ),
    }).toStrictEqual({
      single: "operation.mode_mismatch",
      streamed: "ok",
      published: [{ done: 1 }, { done: 2 }],
      other: "operation.mode_mismatch",
      nested: "operation.mode_mismatch",
      noEmit: "no emit",
      cancelled: "operation.cancelled",
    });
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
        "microsoft-365.mail@1",
        async (_method, args, context) => await answer(args, context)
      ),
    });

  it("reach the provider through the binding, with a key derived from the action's own", async () => {
    const fixture = await notes();
    const seen: ResourceContext[] = [];
    const resources = mailBinding(async (args, context) => {
      seen.push(context);
      return await Promise.resolve({
        mailbox: `m-${JSON.stringify(args)}`,
        sent: true,
      });
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
        mailbox: `m-${JSON.stringify(["send", mailTo("ada@acme.test")])}`,
      })),
      sameKey: true,
      otherKey: false,
    });
  });

  it("end by a server invocation's wall time however late a deadline the caller gives", async () => {
    const fixture = await notes();
    // Spec 18.1: a server invocation has 60 seconds of wall time.
    const wallMs = 60_000;
    const left: number[] = [];
    const resources = mailBinding(async (_args, context) => {
      left.push(context.deadline - Date.now());
      return await Promise.resolve({ mailbox: "m", sent: true });
    });
    const send = async (within: number) =>
      valueOf(
        await call(
          fixture,
          "action",
          "actions.sendMail",
          { to: "ada@acme.test" },
          { resources, within }
        )
      );
    // What a deadline leaves once the provider hears of it: within
    // `[expected - slack, expected]`, the slack for the call's own work.
    const slack = 5000;
    const leaves = (ms: number | undefined, expected: number) =>
      ms !== undefined && ms <= expected && ms > expected - slack;
    await send(wallMs / 2);
    await send(wallMs);
    await send(wallMs + 1);
    await send(10 * wallMs);
    // No time at all: never an end, nor one no comparison can reach.
    await send(Number.POSITIVE_INFINITY);
    await send(Number.NaN);
    const [early, atLimit, pastLimit, late, endless, notATime] = left;
    expect({
      early: leaves(early, wallMs / 2),
      atLimit: leaves(atLimit, wallMs),
      pastLimit: leaves(pastLimit, wallMs),
      late: leaves(late, wallMs),
      endless: leaves(endless, wallMs),
      notATime: leaves(notATime, wallMs),
    }).toStrictEqual({
      early: true,
      atLimit: true,
      pastLimit: true,
      late: true,
      endless: true,
      notATime: true,
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
        bindingsOf({
          mail: bound("connector", "microsoft-365.mail@2", messageSent),
        })
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
      return await Promise.resolve({ mailbox: "m", sent: true });
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
    // A guests resource that lists and reads, asked to invite: refused
    // before its binding hears of it, so no chat is made and nothing is
    // audited.
    let invited = false;
    const guests = bindingsOf({
      guestbook: bound("guests", null, async () => {
        invited = true;
        return await Promise.resolve([]);
      }),
    });
    const invite = codeOf(
      await call(
        fixture,
        "action",
        "actions.listGuests",
        {},
        {
          resources: guests,
          run: misusing(
            "actions.listGuests",
            async (channel) =>
              await channel.resource("guestbook", "invite", [
                { name: "Anna", skill: "interview-a-stakeholder" },
              ])
          ),
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
      invite,
      invited,
    }).toStrictEqual({
      undeclaredAction: "resource.not_allowed",
      undeclaredAlias: "resource.not_allowed",
      reached: false,
      invite: "resource.not_allowed",
      invited: false,
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

/** A sink whose run `cancel()` cancels. */
const cancellable = () => {
  const controller = new AbortController();
  return {
    sink: {
      publish: () => {
        // Progress isn't what these test.
      },
    },
    signal: controller.signal,
    cancel: () => {
      controller.abort();
    },
  };
};

describe("what an action's invocation keeps", () => {
  /** Mail refused for a busy model budget, before anything was sent. */
  const busy = bindingsOf({
    mail: bound("connector", "microsoft-365.mail@1", async () => {
      await Promise.resolve();
      throw operationErrors.create("resource.budget_busy");
    }),
  });

  it("counts an effect once a mutation committed, though a later request was refused for a busy budget", async () => {
    const fixture = await notes();
    let effects = 0;
    const result = await call(
      fixture,
      "action",
      "actions.savesThenSends",
      { title: "Saved", to: "ada@acme.test" },
      {
        resources: busy,
        onEffect: () => {
          effects += 1;
        },
      }
    );
    const outcome = { result, reached: true, effects };
    expect({
      code: codeOf(result),
      effects,
      kept: keepsReceipt(outcome),
    }).toStrictEqual({
      code: "resource.budget_busy",
      effects: 1,
      // Running it again would act on the note it saved.
      kept: true,
    });
  });

  it("counts no effect for a request a busy budget refused before it was sent", async () => {
    const fixture = await notes();
    let effects = 0;
    const result = await call(
      fixture,
      "action",
      "actions.sendMail",
      { to: "ada@acme.test" },
      {
        resources: busy,
        onEffect: () => {
          effects += 1;
        },
      }
    );
    expect({
      code: codeOf(result),
      effects,
      kept: keepsReceipt({ result, reached: true, effects }),
    }).toStrictEqual({
      code: "resource.budget_busy",
      effects: 0,
      kept: false,
    });
  });
});

describe("a streaming action's progress budget", () => {
  it("emits up to its own budget of snapshots, apart from the calls it makes", async () => {
    const fixture = await notes();
    const published: Json[] = [];
    const sink = {
      publish: (progress: Json) => {
        published.push(progress);
      },
    };
    const many = await call(
      fixture,
      "action",
      "actions.emitsMany",
      { count: streamMaxEmits },
      { progress: sink }
    );
    const over = await call(
      fixture,
      "action",
      "actions.emitsMany",
      { count: streamMaxEmits + 1 },
      { progress: sink }
    );
    expect({
      many: valueOf(many),
      // Far past the 100 calls an invocation may make.
      published: published.length,
      over: codeOf(over),
    }).toStrictEqual({
      many: streamMaxEmits,
      published: streamMaxEmits * 2,
      over: "operation.emit_limit",
    });
  });
});

describe("cancelling a streaming action", () => {
  it("commits nothing when the cancel lands after a mutation's handler, before its commit", async () => {
    const fixture = await notes();
    const { sink, signal, cancel } = cancellable();
    // The nested mutation's handler has run; the cancel lands before its
    // commit.
    const run: Runner = async (path, args, channel) => {
      const answer = await defaultRun(path, args, channel);
      if (path === "notes.create") {
        cancel();
      }
      return answer;
    };
    const result = await call(
      fixture,
      "action",
      "actions.savesWhileStreaming",
      { title: "Never" },
      { progress: sink, cancelled: signal, run }
    );
    // It can't tell, from the run alone, that nothing committed: uncertain.
    expect({
      code: codeOf(result),
      notes: await noteCount(fixture),
    }).toStrictEqual({ code: "operation.outcome_unknown", notes: 1 });
  });

  it("answers an uncertain outcome when the cancel lands during a mutation's commit", async () => {
    const fixture = await notes();
    const { sink, signal, cancel } = cancellable();
    const committing: Fixture = {
      ...fixture,
      store: {
        ...fixture.store,
        commit: async (request) => {
          cancel();
          return await fixture.store.commit(request);
        },
      },
    };
    const result = await call(
      committing,
      "action",
      "actions.savesWhileStreaming",
      { title: "Maybe" },
      { progress: sink, cancelled: signal }
    );
    // The commit went through: a definite "cancelled" would be untrue.
    expect({
      code: codeOf(result),
      notes: await noteCount(fixture),
    }).toStrictEqual({ code: "operation.outcome_unknown", notes: 2 });
  });

  it("sends nothing when the cancel lands before a resource request goes out", async () => {
    const fixture = await notes();
    const { sink, signal, cancel } = cancellable();
    let sent = 0;
    const mailBound = bound("connector", "microsoft-365.mail@1", async () => {
      sent += 1;
      return await Promise.resolve({ mailbox: "m-1", sent: true });
    });
    // Resolving the binding is the last step before the request is sent.
    const resources: ResourceBindings = async (declaration) => {
      cancel();
      return await bindingsOf({ mail: mailBound })(declaration);
    };
    const result = await call(
      fixture,
      "action",
      "actions.sendsWhileStreaming",
      { to: "ada@acme.test" },
      { progress: sink, cancelled: signal, resources }
    );
    expect({ code: codeOf(result), sent }).toStrictEqual({
      code: "operation.outcome_unknown",
      sent: 0,
    });
  });

  it("answers an uncertain outcome when the cancel lands while a request is out", async () => {
    const fixture = await notes();
    const { sink, signal, cancel } = cancellable();
    let sent = 0;
    const resources = bindingsOf({
      mail: bound("connector", "microsoft-365.mail@1", async () => {
        sent += 1;
        cancel();
        await scheduler.wait(50);
        return { mailbox: "m-1", sent: true };
      }),
    });
    const result = await call(
      fixture,
      "action",
      "actions.sendsWhileStreaming",
      { to: "ada@acme.test" },
      { progress: sink, cancelled: signal, resources }
    );
    expect({ code: codeOf(result), sent }).toStrictEqual({
      code: "operation.outcome_unknown",
      sent: 1,
    });
  });

  it("answers an uncertain outcome when the cancel lands while a request it left running is out", async () => {
    const fixture = await notes();
    const { sink, signal, cancel } = cancellable();
    let sent = 0;
    const resources = bindingsOf({
      mail: bound("connector", "microsoft-365.mail@1", async () => {
        sent += 1;
        cancel();
        await scheduler.wait(100);
        return { mailbox: "m-1", sent: true };
      }),
    });
    // Its handler has returned; the run waits for the request it left.
    const result = await call(
      fixture,
      "action",
      "actions.sendsAndLeaves",
      { to: "ada@acme.test" },
      { progress: sink, cancelled: signal, resources }
    );
    expect({ code: codeOf(result), sent }).toStrictEqual({
      code: "operation.outcome_unknown",
      sent: 1,
    });
  });

  it("answers once a request it left running at the cancel has settled, never cutting it off", async () => {
    const fixture = await notes();
    const { sink, signal, cancel } = cancellable();
    let settled = false;
    const resources = bindingsOf({
      mail: bound("connector", "microsoft-365.mail@1", async () => {
        cancel();
        await scheduler.wait(300);
        settled = true;
        return { mailbox: "m-1", sent: true };
      }),
    });
    const result = await call(
      fixture,
      "action",
      "actions.sendsAndLeaves",
      { to: "ada@acme.test" },
      { progress: sink, cancelled: signal, resources }
    );
    // Its tail kept alive until it settled: never cut off with the
    // object the call ran in (GRA-701).
    const settledByAnswer = settled;
    expect({ code: codeOf(result), settledByAnswer }).toStrictEqual({
      code: "operation.outcome_unknown",
      settledByAnswer: true,
    });
  });

  it("answers once a commit it left running at the cancel has landed", async () => {
    const fixture = await notes();
    const { sink, signal, cancel } = cancellable();
    const committing: Fixture = {
      ...fixture,
      store: {
        ...fixture.store,
        commit: async (request) => {
          cancel();
          await scheduler.wait(300);
          return await fixture.store.commit(request);
        },
      },
    };
    const result = await call(
      committing,
      "action",
      "actions.savesAndLeaves",
      { title: "Maybe" },
      { progress: sink, cancelled: signal }
    );
    const notesByAnswer = await noteCount(fixture);
    expect({ code: codeOf(result), notesByAnswer }).toStrictEqual({
      code: "operation.outcome_unknown",
      notesByAnswer: 2,
    });
  });

  it("answers once a request it left running past its deadline has settled", async () => {
    const fixture = await notes();
    let settled = false;
    const resources = bindingsOf({
      mail: bound("connector", "microsoft-365.mail@1", async () => {
        await scheduler.wait(800);
        settled = true;
        return { mailbox: "m-1", sent: true };
      }),
    });
    const result = await call(
      fixture,
      "action",
      "actions.sendsAndLeaves",
      { to: "ada@acme.test" },
      { progress: cancellable().sink, resources, within: 400 }
    );
    const settledByAnswer = settled;
    expect({ code: codeOf(result), settledByAnswer }).toStrictEqual({
      code: "operation.unfinished_call",
      settledByAnswer: true,
    });
  });

  it("waits for what it left under way at a cancel no more than a moment", async () => {
    const fixture = await notes();
    const { sink, signal, cancel } = cancellable();
    let settled = false;
    const resources = bindingsOf({
      mail: bound("connector", "microsoft-365.mail@1", async () => {
        cancel();
        await scheduler.wait(5000);
        settled = true;
        return { mailbox: "m-1", sent: true };
      }),
    });
    const started = Date.now();
    const result = await call(
      fixture,
      "action",
      "actions.sendsAndLeaves",
      { to: "ada@acme.test" },
      { progress: sink, cancelled: signal, resources }
    );
    expect({
      code: codeOf(result),
      settledByAnswer: settled,
      answeredWithinAMoment: Date.now() - started < 3000,
    }).toStrictEqual({
      code: "operation.outcome_unknown",
      settledByAnswer: false,
      answeredWithinAMoment: true,
    });
  });

  it("answers a definite cancel when nothing it started is under way", async () => {
    const fixture = await notes();
    const { sink, signal, cancel } = cancellable();
    const publishing = {
      ...sink,
      // Cancelled as its first snapshot arrives, before it saves anything.
      publish: () => {
        cancel();
      },
    };
    const result = await call(
      fixture,
      "action",
      "actions.savesWhileStreaming",
      { title: "Never" },
      { progress: publishing, cancelled: signal }
    );
    expect({
      code: codeOf(result),
      notes: await noteCount(fixture),
    }).toStrictEqual({ code: "operation.cancelled", notes: 1 });
  });
});

describe("one call's budget", () => {
  it("bounds the functions one action runs, at any depth, and their reads together", async () => {
    const fixture = await notes();
    const fan = async (calls: number, reads: number) =>
      codeOf(await call(fixture, "action", "actions.fanOut", { calls, reads }));
    expect({
      allowed: await fan(callMaxNested, 0),
      tooMany: await fan(callMaxNested + 1, 0),
      // 270 reads together, each query's 90 within its own host calls.
      readsTogether: await fan(3, 90),
    }).toStrictEqual({
      allowed: "ok",
      tooMany: "operation.call_limit",
      readsTogether: "operation.read_limit",
    });
  });

  it("bounds the resource requests one call makes", async () => {
    const fixture = await notes();
    const resources = bindingsOf({
      mail: bound("connector", "microsoft-365.mail@1", messageSent),
    });
    const send = async (requests: number) =>
      codeOf(
        await call(
          fixture,
          "action",
          "actions.sendMany",
          { count: requests },
          { resources }
        )
      );
    expect({
      allowed: await send(callMaxResourceRequests),
      tooMany: await send(callMaxResourceRequests + 1),
    }).toStrictEqual({ allowed: "ok", tooMany: "operation.call_limit" });
  });
});

describe("derived keys", () => {
  /** The idempotency key the provider got for one mail of `path`, by `fixture`'s owner. */
  const keySent = async (fixture: Fixture, path: string): Promise<string> => {
    const seen: string[] = [];
    await call(
      fixture,
      "action",
      path,
      { to: "ada@acme.test" },
      {
        idempotencyKey: "same",
        resources: bindingsOf({
          mail: bound(
            "connector",
            "microsoft-365.mail@1",
            async (_method, _args, context) => {
              seen.push(context.idempotencyKey);
              return await Promise.resolve({ mailbox: "m", sent: true });
            }
          ),
        }),
      }
    );
    return seen[0] ?? "";
  };

  it("differ across callers, Apps and actions sharing a key", async () => {
    const first = await notes();
    const second = await notes();
    const keys = [
      await keySent(first, "actions.sendMail"),
      await keySent(second, "actions.sendMail"),
      await keySent(first, "actions.sendMailToo"),
      await keySent(first, "actions.sendMail"),
    ];
    expect({
      acrossCallersAndApps: keys[0] === keys[1],
      acrossActions: keys[0] === keys[2],
      sameCall: keys[0] === keys[3],
    }).toStrictEqual({
      acrossCallersAndApps: false,
      acrossActions: false,
      sameCall: true,
    });
  });

  it("never give one action another's outcome under the same key", async () => {
    const fixture = await notes();
    const options = { idempotencyKey: "shared" };
    const composed = await call(
      fixture,
      "action",
      "actions.compose",
      { title: "A" },
      options
    );
    const created = await call(
      fixture,
      "action",
      "actions.createOnly",
      { title: "A" },
      options
    );
    expect({
      composed: codeOf(composed),
      created: typeof valueOf(created),
    }).toStrictEqual({
      composed: "ok",
      created: "string",
    });
    // Both inserted: the probe counts them and itself.
    await expect(noteCount(fixture)).resolves.toBe(3);
  });

  it("treat the same action under the same key with other input as another submission", async () => {
    const fixture = await notes();
    const options = { idempotencyKey: "reused" };
    const first = await call(
      fixture,
      "action",
      "actions.createOnly",
      { title: "A" },
      options
    );
    const other = await call(
      fixture,
      "action",
      "actions.createOnly",
      { title: "B" },
      options
    );
    expect({
      other: codeOf(other),
      distinct: valueOf(first) !== valueOf(other),
    }).toStrictEqual({ other: "ok", distinct: true });
  });

  it("place mutations by what changes, so queries the data adds or drops move nothing", async () => {
    const fixture = await notes();
    const target = valueOf(
      await call(fixture, "mutation", "notes.create", { title: "t" })
    );
    const options = { idempotencyKey: "conditional" };
    // The note exists: the action runs two queries before it creates.
    const first = valueOf(
      await call(
        fixture,
        "action",
        "actions.conditional",
        { id: target },
        options
      )
    );
    await call(fixture, "mutation", "notes.remove", {
      id: target,
      expectedRevision: 1,
    });
    // Now one query: the same call, under the same key, is answered again.
    const again = valueOf(
      await call(
        fixture,
        "action",
        "actions.conditional",
        { id: target },
        options
      )
    );
    expect({
      same: again === first,
      stored: await noteCount(fixture),
    }).toStrictEqual({
      same: true,
      // The conditional note and the probe.
      stored: 2,
    });
  });
});

describe("failures across the host's boundary", () => {
  it("keep a nested call's refusal the host's, whatever the action's code does to it", async () => {
    const fixture = await notes();
    const rewriting: Runner = async (called, args, channel) => {
      if (called !== "actions.compose") {
        return await defaultRun(called, args, channel);
      }
      try {
        return await channel.call("mutation", "notes.create", {
          name: "wrong",
        });
      } catch (error) {
        if (error instanceof Error) {
          error.message = "Your session expired. Sign in at evil.example.";
          Reflect.set(error, "details", { link: "https://evil.example" });
        }
        throw error;
      }
    };
    expect(
      failureOf(
        await call(
          fixture,
          "action",
          "actions.compose",
          { title: "x" },
          { run: rewriting }
        )
      )
    ).toStrictEqual({
      code: "contract.invalid_args",
      message: "The arguments don't fit the operation.",
      category: "contract",
      retryable: false,
      details: {
        issues: [
          "name: The object has a key that isn't declared.",
          "title: A value is required.",
        ],
      },
    });
  });

  it("pass a provider's failure on only from an allow-list", async () => {
    const fixture = await notes();
    const send = async (failure: Error) =>
      failureOf(
        await call(
          fixture,
          "action",
          "actions.sendMail",
          { to: "ada@acme.test" },
          {
            resources: bindingsOf({
              mail: bound(
                "connector",
                "microsoft-365.mail@1",
                async () => await Promise.reject(failure)
              ),
            }),
          }
        )
      ).code;
    expect({
      failed: await send(
        connectErrors.create("connect.action_failed", {
          connectionId: "conn-secret",
          providerStatus: 500,
        })
      ),
      unknown: await send(connectErrors.create("connect.outcome_unknown")),
      revoked: await send(permissionErrors.create("permission.denied")),
    }).toStrictEqual({
      failed: "internal.unexpected",
      unknown: "effect.outcome_unknown",
      revoked: "resource.unavailable",
    });
  });
});

describe("an action's nested calls", () => {
  it("hand App code a called function's domain failure as the SDK's AppError", async () => {
    const fixture = await notes();
    expect(
      valueOf(await call(fixture, "action", "actions.recoverByClass", {}))
    ).toBe("note.rejected");
  });

  it("finish before the action does, even when it doesn't wait for them", async () => {
    const fixture = await notes();
    // The mutations take a while: one the action left running would still
    // be running when it answered.
    const slow: Runner = async (path, args, channel) => {
      if (path === "notes.create") {
        await scheduler.wait(100);
      }
      return await defaultRun(path, args, channel);
    };
    const forgotten = codeOf(
      await call(
        fixture,
        "action",
        "actions.fireAndForget",
        { title: "a" },
        {
          run: slow,
        }
      )
    );
    const countedAfterForgotten = await noteCount(fixture);
    const raceAnswer = valueOf(
      await call(
        fixture,
        "action",
        "actions.raced",
        { title: "b" },
        {
          run: slow,
        }
      )
    );
    expect({
      forgotten,
      // The forgotten note and the probe.
      countedAfterForgotten,
      raced: raceAnswer,
      // And now the raced note and a second probe too.
      countedAfterRaced: await noteCount(fixture),
    }).toStrictEqual({
      forgotten: "ok",
      countedAfterForgotten: 2,
      raced: "first",
      countedAfterRaced: 4,
    });
  });

  it("hand App code that talks to its channel directly the SDK's AppError too", async () => {
    const fixture = await notes();
    const direct: Runner = async (called, args, channel) => {
      if (called !== "actions.recoverByClass") {
        return await defaultRun(called, args, channel);
      }
      try {
        await channel.call("mutation", "notes.reject", {});
        return "accepted";
      } catch (error) {
        return error instanceof AppError ? error.code : "not an AppError";
      }
    };
    expect(
      valueOf(
        await call(
          fixture,
          "action",
          "actions.recoverByClass",
          {},
          {
            run: direct,
          }
        )
      )
    ).toBe("note.rejected");
  });

  it("fail the action when one it didn't wait for fails", async () => {
    const fixture = await notes();
    expect(
      failureOf(await call(fixture, "action", "actions.racedFailure", {}))
    ).toStrictEqual({
      code: "note.rejected",
      message: "Notes are closed today.",
      category: "domain",
      retryable: false,
    });
  });

  it("can't be started once the action has finished", async () => {
    const fixture = await notes();
    expect(
      codeOf(
        await call(fixture, "action", "actions.startLater", { title: "late" })
      )
    ).toBe("ok");
    await scheduler.wait(300);
    // Only the probe: the late mutation was refused.
    await expect(noteCount(fixture)).resolves.toBe(1);
  });

  it("answer a call left running past the deadline as unfinished", async () => {
    const fixture = await notes();
    const slow: Runner = async (path, args, channel) => {
      if (path === "notes.create") {
        await scheduler.wait(600);
      }
      return await defaultRun(path, args, channel);
    };
    expect(
      failureOf(
        await call(
          fixture,
          "action",
          "actions.fireAndForgetCaught",
          { title: "slow" },
          { run: slow, within: 300 }
        )
      )
    ).toStrictEqual({
      code: "operation.unfinished_call",
      message:
        "The operation left a call it started running past its deadline.",
      category: "contract",
      retryable: false,
    });
  });

  it("run a mutation again when a query it left running failed on reads a commit made stale", async () => {
    const fixture = await notes();
    let runs = 0;
    // Another caller commits between the left-running query's two reads,
    // the first time only.
    const run: Runner = async (path, args, channel) => {
      if (path === "notes.checkLater") {
        runs += 1;
      }
      if (path !== "consistentPair" || runs > 1) {
        return await defaultRun(path, args, channel);
      }
      let reads = 0;
      const tearing: OperationChannel = {
        read: async (request) => {
          const answer = await channel.read(request);
          reads += 1;
          if (reads === 1) {
            await call(fixture, "mutation", "notes.create", {
              title: "meanwhile",
            });
          }
          return answer;
        },
        write: async (request) => await channel.write(request),
        call: async (kind, called, callArgs) =>
          await channel.call(kind, called, callArgs),
        resource: async (alias, method, callArgs) =>
          await channel.resource(alias, method, callArgs),
        emit: async (progress) => await channel.emit(progress),
      };
      return await defaultRun(path, args, tearing);
    };
    expect({
      answer: valueOf(
        await call(fixture, "mutation", "notes.checkLater", {}, { run })
      ),
      runs,
    }).toStrictEqual({ answer: "done", runs: 2 });
  });
});

describe("evidence of a refused use", () => {
  it("is kept once per call, for the first use refused, before App code hears of it, naming only what the manifest has", async () => {
    const fixture = await notes();
    const resources = bindingsOf({
      mail: bound("connector", "microsoft-365.mail@1", messageSent),
    });
    /** What a call of sendMail kept, its code asking `asks` and swallowing each refusal. */
    const kept = async (
      ...asks: ((channel: OperationChannel) => Promise<unknown>)[]
    ) => {
      const order: string[] = [];
      const heard: UseRefusal[] = [];
      const result = await call(
        fixture,
        "action",
        "actions.sendMail",
        { to: "ada@acme.test" },
        {
          resources,
          // Kept only once a write's time has passed: a refusal App code
          // heard first would come before it.
          refusedUse: async (refusal) => {
            await scheduler.wait(20);
            heard.push(refusal);
            order.push("kept");
          },
          run: misusing("actions.sendMail", async (channel) => {
            for (const ask of asks) {
              try {
                // oxlint-disable-next-line no-await-in-loop -- one ask after another
                await ask(channel);
              } catch {
                order.push("refused");
              }
            }
            return { mailbox: "m" };
          }),
        }
      );
      return { result: codeOf(result), heard, order };
    };
    // An alias the App doesn't have, then one it has that sendMail doesn't
    // list: only the first is kept, as App code's text it is named by no
    // one.
    const loop = await kept(
      async (channel) => await channel.resource("nope", "search", [{}]),
      async (channel) =>
        await channel.resource("help", "search", [{ text: "a" }])
    );
    const appResource = await kept(
      async (channel) =>
        await channel.resource("help", "search", [{ text: "a" }])
    );
    // A function sendMail doesn't list, and one the App doesn't have.
    const fn = await kept(
      async (channel) =>
        await channel.call("mutation", "notes.create", { title: "x" })
    );
    const noFunction = await kept(
      async (channel) => await channel.call("query", "notes.nothing", {})
    );
    // A workflow the App declares that sendMail doesn't list.
    const workflow = await kept(
      async (channel) =>
        await channel.resource("followUp", "start", [{ who: "Ada" }])
    );
    // A declared resource asked for an action it doesn't declare.
    const request = await kept(
      async (channel) => await channel.resource("mail", "call", ["delete", {}])
    );
    expect({
      loop,
      appResource: appResource.heard,
      function: fn.heard,
      noFunction: noFunction.heard,
      workflow: workflow.heard,
      request: request.heard,
    }).toStrictEqual({
      loop: {
        result: "ok",
        heard: [
          {
            function: "actions.sendMail",
            use: { kind: "resource", name: null },
            reason: "use_undeclared",
            errorCode: "resource.not_allowed",
          },
        ],
        // Kept before App code heard of the refusal.
        order: ["kept", "refused", "refused"],
      },
      appResource: [
        {
          function: "actions.sendMail",
          use: { kind: "resource", name: "help" },
          reason: "use_undeclared",
          errorCode: "resource.not_allowed",
        },
      ],
      function: [
        {
          function: "actions.sendMail",
          use: { kind: "function", name: "notes.create" },
          reason: "use_undeclared",
          errorCode: "operation.not_found",
        },
      ],
      noFunction: [
        {
          function: "actions.sendMail",
          use: { kind: "function", name: null },
          reason: "use_undeclared",
          errorCode: "operation.not_found",
        },
      ],
      workflow: [
        {
          function: "actions.sendMail",
          use: { kind: "workflow", name: "followUp" },
          reason: "use_undeclared",
          errorCode: "resource.not_allowed",
        },
      ],
      request: [
        {
          function: "actions.sendMail",
          use: { kind: "resource", name: "mail" },
          reason: "request_not_allowed",
          errorCode: "resource.not_allowed",
        },
      ],
    });
  });

  it("is kept for a mutation asking a resource it can't use, and is no part of a refusal the hook couldn't keep", async () => {
    const fixture = await notes();
    const heard: UseRefusal[] = [];
    const asked = await call(
      fixture,
      "mutation",
      "notes.create",
      { title: "x" },
      {
        refusedUse: async (refusal) => {
          heard.push(refusal);
          await Promise.resolve();
        },
        run: misusing(
          "notes.create",
          async (channel) =>
            await channel.resource("mail", "call", ["send", {}])
        ),
      }
    );
    // A workflow the App declares that the mutation doesn't list.
    const workflowHeard: UseRefusal[] = [];
    const startsUnlisted = await call(
      fixture,
      "mutation",
      "notes.create",
      { title: "z" },
      {
        refusedUse: async (refusal) => {
          workflowHeard.push(refusal);
          await Promise.resolve();
        },
        run: misusing(
          "notes.create",
          async (channel) =>
            await channel.resource("followUp", "start", [{ who: "Ada" }])
        ),
      }
    );
    // A hook that fails leaves the refusal as it was.
    const failing = await call(
      fixture,
      "mutation",
      "notes.create",
      { title: "y" },
      {
        refusedUse: async () => {
          await Promise.resolve();
          throw new Error("Unavailable");
        },
        run: misusing(
          "notes.create",
          async (channel) =>
            await channel.resource("mail", "call", ["send", {}])
        ),
      }
    );
    expect({
      asked: codeOf(asked),
      heard,
      startsUnlisted: codeOf(startsUnlisted),
      workflowHeard,
      failing: codeOf(failing),
    }).toStrictEqual({
      asked: "operation.no_resources",
      heard: [
        {
          function: "notes.create",
          use: { kind: "resource", name: "mail" },
          reason: "use_undeclared",
          errorCode: "operation.no_resources",
        },
      ],
      startsUnlisted: "operation.no_resources",
      workflowHeard: [
        {
          function: "notes.create",
          use: { kind: "workflow", name: "followUp" },
          reason: "use_undeclared",
          errorCode: "operation.no_resources",
        },
      ],
      failing: "operation.no_resources",
    });
  });

  it("is kept by core as app.use.refused, from a person's call and a run's", async () => {
    const fixture = await appWith({
      "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";
export default defineSchema({ notes: defineTable({ title: v.string() }) });
`,
      "operations/notes.ts": `import { v } from "@grasp-os/sdk";
import { action, query } from "#grasp/server";
export const label = query({ args: {}, returns: v.string(), handler: () => "label" });
export const probe = action({ args: {}, returns: v.null(), handler: async () => null });
`,
      "app.ts": `import { app } from "@grasp-os/sdk";
import { label, probe } from "./operations/notes.ts";
import schema from "./schema.ts";
export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { notes: { label, probe } },
  screens: [],
  uses: [],
});
`,
    });
    const release = await seal(fixture);
    const hosted = hostedRelease(env, release);
    // Code that goes around its SDK: it asks the host for a function its
    // uses don't list, swallowing the refusal, and answers all the same.
    const run: Runner = async (path, args, channel) => {
      if (path !== "notes.probe") {
        return await hosted.run(path, args, channel);
      }
      try {
        await channel.call("query", "notes.label", {});
      } catch {
        // Swallowed.
      }
      return null;
    };
    const appId = appIdSchema.parse(fixture.app);
    const personRequest = crypto.randomUUID();
    const byPerson = await callOperation(
      { manifest: release.app, run },
      await invocationFor(env, release, {
        by: fixture.owner,
        requestId: personRequest,
        deadline: Date.now() + 30_000,
      }),
      { path: "notes.probe", kind: "action" },
      {}
    );
    const runId = runIdSchema.parse(crypto.randomUUID());
    const runRequest = crypto.randomUUID();
    const byRun = await callOperation(
      { manifest: release.app, run },
      await runInvocationFor(
        env,
        release,
        {
          run: {
            app: appId,
            workflow: workflowIdSchema.parse("probing"),
            runId,
            version: 1,
            shareSubject: fixture.owner.userId,
            authority: {
              subject: { type: "app", appId },
              onBehalfOf: fixture.owner.userId,
              mode: "workflow",
              appVersion: 1,
            },
          },
          requestId: runRequest,
          deadline: Date.now() + 30_000,
          stillCurrent: async () => {
            await Promise.resolve();
          },
          requireHolds: () => {
            // The step holds its lease throughout.
          },
          held: () => {
            throw new Error("Nothing is held here");
          },
        },
        "notes.probe"
      ),
      { path: "notes.probe", kind: "action" },
      {}
    );
    const events = await allEvents();
    const kept = events
      .filter(
        (event) =>
          event.action === "app.use.refused" && event.target?.id === appId
      )
      .map(({ actor, requestId, detail }) => ({ actor, requestId, detail }))
      .toSorted((one, other) =>
        String(one.detail?.runId).localeCompare(String(other.detail?.runId))
      );
    const evidence = (requestId: string, from: string | null) => ({
      actor: { type: "app", appId, part: "server" },
      requestId,
      detail: {
        version: 1,
        person: fixture.owner.userId,
        runId: from,
        function: "notes.probe",
        useKind: "function",
        useName: "notes.label",
        reason: "use_undeclared",
        errorCode: "operation.not_found",
      },
    });
    expect({
      byPerson: codeOf(byPerson),
      byRun: codeOf(byRun),
      kept,
    }).toStrictEqual({
      byPerson: "ok",
      byRun: "ok",
      kept: [
        evidence(runRequest, runId),
        evidence(personRequest, null),
      ].toSorted((one, other) =>
        String(one.detail.runId).localeCompare(String(other.detail.runId))
      ),
    });
  });
});

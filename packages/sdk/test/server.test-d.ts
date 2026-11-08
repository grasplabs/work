// Compile-time guarantees of server functions: what each kind's context
// has and hasn't of the App's permissions, how arguments and returns are
// typed, and which references `runQuery`, `runMutation` and `runAction`
// take. This file is
// type-checked by `vp check` and never run: every `@ts-expect-error` below
// must stay an error.
import { expectTypeOf } from "vite-plus/test";

import { AppError, defineApp, permission } from "../src/index.ts";
import { serverModule } from "../src/server.ts";
import type {
  ActionCtx,
  FunctionArgs,
  FunctionReturn,
  MutationCtx,
  NotifyReceipt,
  PeopleNotification,
  QueryCtx,
  RunHandle,
} from "../src/server.ts";
import type { Id } from "../src/value-types.ts";
import {
  defineSchema,
  defineTable,
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "../src/values.ts";
import { summarizeNote } from "./notes/grasp.config.ts";
import { workflows } from "./notes/server/_generated/api.ts";
import type { invoiceWorkflow } from "./workflows/invoice-approval.ts";

const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
  summary: v.string().max(10_000).nullable().default(null),
  rank: v.number().optional(),
};

const schema = defineSchema({
  notes: defineTable(noteFields)
    .index("by_updated", ["_updatedAt"])
    .index("by_title", ["title"]),
  people: defineTable({ name: v.string() }),
});

// An App without permissions: its functions reach nothing outside it.
const { query, mutation, action, internalQuery, doc } = serverModule(schema);

// An App's permissions: every function may use them, as its kind allows.
const mail = permission.connection("mail", {
  contract: "microsoft-365.mail@1",
  actions: ["send"],
});
const brain = permission.brain({
  operations: ["search"],
  collections: ["handbook"],
});
const ai = permission.ai({ maxOutputTokens: 500 });
const followUp = permission.workflow("followUp", {
  input: v.object({
    noteId: v.id("notes"),
    reason: v.string().default("new"),
  }),
  output: v.null(),
});
const optional = permission.workflow("optional", {
  input: v.string().default("ready"),
  output: v.null(),
});
const granted = serverModule(
  schema,
  defineApp({
    name: "Notes",
    permissions: {
      connections: [mail],
      brain,
      ai,
      workflows: [followUp, optional, summarizeNote],
      people: true,
    },
  })
);

type Tables = (typeof schema)["tables"];

declare const noteId: Id<"notes">;
declare const anything: unknown;

// The complete Notes operations of spec 9.4 type-check as written.
const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("notes")),
  handler: async (ctx, args) =>
    await ctx.db
      .query("notes")
      .withIndex("by_updated")
      .order("desc")
      .paginate(args.pagination),
});

const get = query({
  args: { id: v.id("notes") },
  returns: doc("notes").nullable(),
  handler: async (ctx, args) => await ctx.db.get("notes", args.id),
});

const create = mutation({
  args: { title: noteFields.title, body: noteFields.body },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

const update = mutation({
  args: {
    id: v.id("notes"),
    title: noteFields.title,
    body: v.string().max(100_000),
  },
  returns: doc("notes"),
  handler: async (ctx, args) => {
    const previous = await ctx.db.get("notes", args.id);
    if (!previous) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    await ctx.db.patch("notes", args.id, {
      title: args.title,
      body: args.body,
    });
    const updated = await ctx.db.get("notes", args.id);
    if (!updated) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    return updated;
  },
});

const remove = mutation({
  args: { id: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete("notes", args.id);
    return null;
  },
});
void [list, update, remove];

// A caller may leave out a defaulted argument; the handler always has it.
expectTypeOf<FunctionArgs<typeof create>>().toEqualTypeOf<{
  title: string;
  body?: string | undefined;
}>();
mutation({
  args: { body: noteFields.body },
  returns: v.string(),
  handler: (_ctx, args) => {
    expectTypeOf(args.body).toEqualTypeOf<string>();
    return args.body;
  },
});

// A handler's return is the declared return, as `Infer` has it.
query({
  args: {},
  returns: v.number(),
  // @ts-expect-error -- a string isn't the declared number
  handler: () => "1",
});

action({
  args: {},
  returns: v.string(),
  // @ts-expect-error -- a number isn't the declared string
  handler: () => 1,
});

// Without `returns`, the handler's answer is the return, of every kind.
const counted = query({ args: {}, handler: () => ({ count: 1 }) });
expectTypeOf<FunctionReturn<typeof counted>>().toEqualTypeOf<{
  count: number;
}>();
const saved = mutation({
  args: {},
  handler: async () => await Promise.resolve("saved"),
});
expectTypeOf<FunctionReturn<typeof saved>>().toEqualTypeOf<string>();
const tallied = action({ args: {}, handler: () => 1 });
expectTypeOf<FunctionReturn<typeof tallied>>().toEqualTypeOf<number>();
// There is no `input`/`output` form.
// @ts-expect-error -- `input` is superseded by `args`
query({ input: {}, returns: v.null(), handler: () => null });
// @ts-expect-error -- `output` is superseded by `returns`
query({ args: {}, output: v.null(), handler: () => null });
// @ts-expect-error -- no `reads` list
query({ args: {}, returns: v.null(), reads: ["notes"], handler: () => null });
// @ts-expect-error -- no `writes` list
mutation({ args: {}, returns: v.null(), writes: [], handler: () => null });

// A query reads, and nothing else: no writer and no permissions, whatever
// the App declares.
granted.query({
  args: { id: v.id("notes") },
  returns: v.null(),
  handler: (ctx) => {
    expectTypeOf(ctx).toEqualTypeOf<QueryCtx<Tables>>();
    expectTypeOf(ctx.db).not.toHaveProperty("insert");
    expectTypeOf(ctx.db).not.toHaveProperty("patch");
    expectTypeOf(ctx.db).not.toHaveProperty("replace");
    expectTypeOf(ctx.db).not.toHaveProperty("delete");
    expectTypeOf(ctx).not.toHaveProperty("runQuery");
    expectTypeOf(ctx).not.toHaveProperty("connections");
    expectTypeOf(ctx).not.toHaveProperty("ai");
    // No `ctx.data`, and no notifications.
    expectTypeOf(ctx).not.toHaveProperty("data");
    expectTypeOf(ctx).not.toHaveProperty("notify");
    return null;
  },
});
// @ts-expect-error -- no function lists its own `uses`
query({ args: {}, returns: v.null(), uses: [get], handler: () => null });
// @ts-expect-error -- nor narrows its tables
query({ args: {}, tables: { notes: {} }, handler: () => null });
// @ts-expect-error -- nor a mutation
mutation({ args: {}, uses: [], handler: () => null });
// @ts-expect-error -- only an action streams
query({ args: {}, returns: v.null(), stream: v.string(), handler: () => null });

// A mutation writes the schema's tables, as their types say.
mutation({
  args: { id: v.id("notes"), person: v.id("people") },
  returns: v.null(),
  handler: async (ctx, args) => {
    expectTypeOf(ctx).toEqualTypeOf<MutationCtx<Tables>>();
    expectTypeOf(ctx.db.insert("notes", { title: "a" })).resolves.toEqualTypeOf<
      Id<"notes">
    >();
    // @ts-expect-error -- `title` is required on insert
    await ctx.db.insert("notes", { body: "b" });
    // @ts-expect-error -- the schema has no such table
    await ctx.db.insert("missing", { title: "a" });
    // @ts-expect-error -- a managed field can't be written
    await ctx.db.insert("notes", { title: "a", _ownerId: "u" });
    // @ts-expect-error -- a person's ID isn't a note's
    await ctx.db.patch("notes", args.person, {});
    // A patch sets the fields it names, and nothing else.
    await ctx.db.patch("notes", args.id, { title: "b" });
    // @ts-expect-error -- a patch sets a field to its stored type
    await ctx.db.patch("notes", args.id, { title: 1 });
    await ctx.db.patch(
      "notes",
      args.id,
      {},
      {
        unset: ["rank"],
      }
    );
    await ctx.db.patch(
      "notes",
      args.id,
      {},
      {
        // @ts-expect-error -- only an optional field can be unset
        unset: ["body"],
      }
    );
    // @ts-expect-error -- a replacement is the whole record
    await ctx.db.replace("notes", args.id, {});
    // The App's queries run in its staged state.
    expectTypeOf(ctx.runQuery(get, { id: args.id })).resolves.toExtend<{
      title: string;
    } | null>();
    // No permissions (so no network), queries only, no `ctx.data`, and no
    // event of a workflow the App doesn't declare.
    expectTypeOf(ctx).not.toHaveProperty("connections");
    expectTypeOf(ctx).not.toHaveProperty("ai");
    expectTypeOf(ctx).not.toHaveProperty("runMutation");
    expectTypeOf(ctx).not.toHaveProperty("runAction");
    expectTypeOf(ctx).not.toHaveProperty("data");
    // @ts-expect-error -- an event of a workflow the App doesn't declare
    ctx.sendEvent(workflows.summarizeNote.events.styleChosen, {
      runId: "run-1",
      data: { style: "short" },
    });
    return null;
  },
});
granted.mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // Never a mutation or an action, whatever the App declares.
    // @ts-expect-error -- a mutation isn't a query
    await ctx.runQuery(create, { title: "a" });
    expectTypeOf(ctx).not.toHaveProperty("runMutation");
    expectTypeOf(ctx).not.toHaveProperty("connections");
    expectTypeOf(ctx).not.toHaveProperty("ai");
    expectTypeOf(ctx).not.toHaveProperty("brain");
    return null;
  },
});

// An action has no database, and reaches what the App declares.
const secret = internalQuery({
  args: {},
  returns: v.string(),
  handler: () => "s",
});

granted.action({
  args: { noteId: v.id("notes"), to: v.string().email() },
  returns: v.object({ summary: v.string() }),
  handler: async (ctx, args) => {
    expectTypeOf(ctx).toExtend<ActionCtx>();
    // No database, and no notifications of runs: it tells people only.
    expectTypeOf(ctx).not.toHaveProperty("db");
    expectTypeOf(ctx).not.toHaveProperty("notify");
    expectTypeOf(ctx.notifyPeople).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(
      ctx.notifyPeople
    ).returns.resolves.toEqualTypeOf<NotifyReceipt>();
    const note = await ctx.runQuery(get, { id: args.noteId });
    expectTypeOf(note).toExtend<{ title: string } | null>();
    // @ts-expect-error -- a mutation isn't a query
    await ctx.runQuery(create, { title: "a" });
    // @ts-expect-error -- wrong arguments
    await ctx.runMutation(create, { name: "a" });
    expectTypeOf(
      ctx.runMutation(create, { title: "a" })
    ).resolves.toEqualTypeOf<Id<"notes">>();
    // Internal functions of the App are its own server code's to call.
    expectTypeOf(ctx.runQuery(secret, {})).resolves.toEqualTypeOf<string>();
    await ctx.connections.mail.call("send", {
      mailbox: "team@acme.test",
      subject: "Hello",
      body: "Hi.",
      to: [args.to],
    });
    // @ts-expect-error -- an action the declaration doesn't list
    await ctx.connections.mail.call("delete", {});
    expectTypeOf(ctx.brain.search({ text: "a" })).resolves.toEqualTypeOf<
      { title: string; excerpt: string }[]
    >();
    // Only the App's declared operations and permissions.
    expectTypeOf(ctx.brain).not.toHaveProperty("read");
    expectTypeOf(ctx.connections).not.toHaveProperty("calendar");
    expectTypeOf(ctx).not.toHaveProperty("guests");
    return await ctx.ai.generate({
      prompt: "Summarize",
      output: v.object({ summary: v.string() }),
    });
  },
});
action({
  args: {},
  returns: v.null(),
  handler: (ctx) => {
    // The App's functions, but nothing outside an App that declares nothing.
    expectTypeOf(ctx.runQuery(get, { id: noteId })).resolves.toExtend<{
      title: string;
    } | null>();
    expectTypeOf(ctx.connections).not.toHaveProperty("mail");
    expectTypeOf(ctx).not.toHaveProperty("ai");
    expectTypeOf(ctx).not.toHaveProperty("brain");
    return null;
  },
});

// An action may declare progress snapshots for the streaming runtime.
action({
  args: {},
  returns: v.null(),
  stream: v.object({ done: v.number() }),
  handler: () => null,
});

// Workflows (spec 7.4, 9.5): an action starts one of the App's, and a
// mutation stages a start of one for after it commits, each by its alias.
// Neither reaches the engine, and neither starts what the App doesn't
// declare.
declare const engineWorkflow: ReturnType<typeof invoiceWorkflow>;

granted.action({
  args: { noteId: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Its input as a caller passes it: the default may be left out.
    const handle = await ctx.workflows.followUp.start({ noteId: args.noteId });
    expectTypeOf(handle).toEqualTypeOf<RunHandle>();
    // An input with a default may be left out altogether.
    await ctx.workflows.optional.start();
    // @ts-expect-error -- input the declaration doesn't take
    await ctx.workflows.followUp.start({ note: args.noteId });
    // @ts-expect-error -- `followUp` needs its input
    await ctx.workflows.followUp.start();
    // Only the App's: no other workflow, and no connection or query.
    expectTypeOf(ctx.workflows).not.toHaveProperty("unlisted");
    expectTypeOf(ctx.workflows).not.toHaveProperty("mail");
    expectTypeOf(ctx.workflows).not.toHaveProperty("get");
    // A workflow is no connection, and there is no engine.
    expectTypeOf(ctx.connections).not.toHaveProperty("followUp");
    expectTypeOf(ctx).not.toHaveProperty("engine");
    return null;
  },
});
action({
  args: {},
  returns: v.null(),
  handler: (ctx) => {
    // The App declares no workflow.
    expectTypeOf(ctx.workflows).not.toHaveProperty("followUp");
    return null;
  },
});
defineApp({
  name: "Notes",
  // @ts-expect-error -- an engine workflow isn't an App's permission
  permissions: { workflows: [engineWorkflow] },
});

granted.mutation({
  args: { title: noteFields.title },
  returns: v.id("notes"),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("notes", { title: args.title });
    // Staged with the insert, started once both have committed.
    expectTypeOf(
      ctx.workflows.followUp.start({ noteId: id })
    ).resolves.toBeVoid();
    // @ts-expect-error -- input the declaration doesn't take
    await ctx.workflows.followUp.start({ noteId: 1 });
    // Only the App's.
    expectTypeOf(ctx.workflows).not.toHaveProperty("unlisted");
    return id;
  },
});
mutation({
  args: { noteId: v.id("notes") },
  returns: v.null(),
  handler: async (ctx) => {
    // The App declares no workflow.
    expectTypeOf(ctx.workflows).not.toHaveProperty("followUp");
    // Tells people once it commits, whatever the App declares.
    expectTypeOf(
      ctx.notifyPeople("person", { title: "Done" })
    ).resolves.toBeVoid();
    // @ts-expect-error -- a title is required
    await ctx.notifyPeople("person", { body: "Done" });
    return null;
  },
});

// A query starts nothing, now or after.
expectTypeOf<QueryCtx<Tables>>().not.toHaveProperty("notifyPeople");
expectTypeOf<QueryCtx<Tables>>().not.toHaveProperty("workflows");

// `doc` is a whole record of the pinned schema.
// @ts-expect-error -- the schema has no such table
doc("missing");

// `ctx.sendEvent` (spec 10.7.4): a mutation's only, for an event of one of
// the App's workflows, its data inferred from the reference and never
// from the call, and answering nothing (it stages; the commit delivers).
granted.mutation({
  args: { runId: v.string() },
  returns: v.null(),
  handler: (ctx, args) => {
    expectTypeOf(ctx.sendEvent).returns.toBeVoid();
    ctx.sendEvent(workflows.summarizeNote.events.styleChosen, {
      runId: args.runId,
      data: { style: "short" },
    });
    ctx.sendEvent(workflows.summarizeNote.events.noteEdited, {
      runId: args.runId,
      data: { noteId },
    });
    ctx.sendEvent(workflows.summarizeNote.events.styleChosen, {
      runId: args.runId,
      // @ts-expect-error -- a value outside the event's enum
      data: { style: "medium" },
    });
    ctx.sendEvent(workflows.summarizeNote.events.styleChosen, {
      runId: args.runId,
      // @ts-expect-error -- the other event's data: never inferred from the call
      data: { noteId },
    });
    ctx.sendEvent(workflows.summarizeNote.events.styleChosen, {
      runId: args.runId,
      // @ts-expect-error -- data typed as nothing in particular
      data: anything,
    });
    // @ts-expect-error -- an event of a workflow the App doesn't declare
    ctx.sendEvent(workflows.archiveNotes.events.confirmed, {
      runId: args.runId,
      data: { confirmed: true },
    });
    // @ts-expect-error -- an event's name, not its reference
    ctx.sendEvent("styleChosen", {
      runId: args.runId,
      data: { style: "short" },
    });
    // @ts-expect-error -- a run's ID is required
    ctx.sendEvent(workflows.summarizeNote.events.styleChosen, {
      data: { style: "short" },
    });
    return null;
  },
});

// A query reads only, and an action has no transaction to stage one in:
// neither has `notify`. An action tells people (`notifyPeople`).
query({
  args: {},
  returns: v.null(),
  handler: (ctx) => {
    expectTypeOf(ctx).not.toHaveProperty("notify");
    return null;
  },
});
action({
  args: {},
  returns: v.null(),
  handler: (ctx) => {
    expectTypeOf(ctx).not.toHaveProperty("notify");
    expectTypeOf(ctx.notifyPeople)
      .parameter(1)
      .toEqualTypeOf<PeopleNotification>();
    return null;
  },
});

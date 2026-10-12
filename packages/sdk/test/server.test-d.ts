// Compile-time guarantees of server functions: what each kind's context
// has and hasn't, how arguments and returns are typed, and which
// references `runQuery`, `runMutation` and `runAction` take. This file is
// type-checked by `vp check` and never run: every `@ts-expect-error` below
// must stay an error.
import { expectTypeOf } from "vite-plus/test";

import { AppError, resource } from "../src/index.ts";
import { serverModule } from "../src/server.ts";
import type { ActionCtx, MutationCtx, QueryCtx } from "../src/server.ts";
import {
  defineSchema,
  defineTable,
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "../src/values.ts";
import type { Id } from "../src/values.ts";

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

const { query, mutation, action, internalQuery, doc } = serverModule(schema);

type Tables = (typeof schema)["tables"];

declare const noteId: Id<"notes">;

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
    expectedRevision: v.number().integer().min(1),
    title: noteFields.title,
    body: v.string().max(100_000),
  },
  returns: doc("notes"),
  handler: async (ctx, args) => {
    const previous = await ctx.db.get("notes", args.id, {
      expectedRevision: args.expectedRevision,
    });
    if (!previous) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    await ctx.db.patch(
      "notes",
      args.id,
      { title: args.title, body: args.body },
      { expectedRevision: args.expectedRevision }
    );
    const updated = await ctx.db.get("notes", args.id);
    if (!updated) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    return updated;
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
void [list, update, remove];

// A caller may leave out a defaulted argument; the handler always has it.
expectTypeOf<NonNullable<(typeof create)["~argsIn"]>>().toEqualTypeOf<{
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

// `returns` is mandatory, and there is no `input`/`output` form.
// @ts-expect-error -- no `returns`
query({ args: {}, handler: () => null });
// @ts-expect-error -- `input` is superseded by `args`
query({ input: {}, returns: v.null(), handler: () => null });
// @ts-expect-error -- `output` is superseded by `returns`
query({ args: {}, output: v.null(), handler: () => null });
// @ts-expect-error -- no `reads` list
query({ args: {}, returns: v.null(), reads: ["notes"], handler: () => null });
// @ts-expect-error -- no `writes` list
mutation({ args: {}, returns: v.null(), writes: [], handler: () => null });

// A query reads, and nothing else: no writer, no uses, no resources.
query({
  args: { id: v.id("notes") },
  returns: v.null(),
  handler: (ctx) => {
    expectTypeOf(ctx).toEqualTypeOf<QueryCtx<Tables>>();
    expectTypeOf(ctx.db).not.toHaveProperty("insert");
    expectTypeOf(ctx.db).not.toHaveProperty("patch");
    expectTypeOf(ctx.db).not.toHaveProperty("replace");
    expectTypeOf(ctx.db).not.toHaveProperty("delete");
    expectTypeOf(ctx).not.toHaveProperty("runQuery");
    expectTypeOf(ctx).not.toHaveProperty("resources");
    // No `ctx.data`, and no notifications.
    expectTypeOf(ctx).not.toHaveProperty("data");
    expectTypeOf(ctx).not.toHaveProperty("notify");
    return null;
  },
});
// @ts-expect-error -- a query uses nothing
query({ args: {}, returns: v.null(), uses: [get], handler: () => null });
// @ts-expect-error -- only an action streams
query({ args: {}, returns: v.null(), stream: v.string(), handler: () => null });

// A mutation writes the schema's tables, as their types say.
mutation({
  args: { id: v.id("notes"), person: v.id("people") },
  returns: v.null(),
  uses: [get],
  handler: async (ctx, args) => {
    expectTypeOf(ctx).toEqualTypeOf<
      MutationCtx<Tables, readonly [typeof get]>
    >();
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
    await ctx.db.patch("notes", args.person, {}, { expectedRevision: 1 });
    // @ts-expect-error -- a patch asserts the revision it expects
    await ctx.db.patch("notes", args.id, { title: "b" });
    // @ts-expect-error -- a patch sets a field to its stored type
    await ctx.db.patch("notes", args.id, { title: 1 }, { expectedRevision: 1 });
    await ctx.db.patch(
      "notes",
      args.id,
      {},
      {
        expectedRevision: 1,
        unset: ["rank"],
      }
    );
    await ctx.db.patch(
      "notes",
      args.id,
      {},
      {
        expectedRevision: 1,
        // @ts-expect-error -- only an optional field can be unset
        unset: ["body"],
      }
    );
    // @ts-expect-error -- a replacement is the whole record
    await ctx.db.replace("notes", args.id, {}, { expectedRevision: 1 });
    // The queries it uses run in its staged state.
    expectTypeOf(ctx.runQuery(get, { id: args.id })).resolves.toExtend<{
      title: string;
    } | null>();
    // No resources (so no network), queries only, no `ctx.data`, and
    // notifications are the runtime of 10.7.4's.
    expectTypeOf(ctx).not.toHaveProperty("resources");
    expectTypeOf(ctx).not.toHaveProperty("runMutation");
    expectTypeOf(ctx).not.toHaveProperty("runAction");
    expectTypeOf(ctx).not.toHaveProperty("data");
    expectTypeOf(ctx).not.toHaveProperty("notify");
    return null;
  },
});
mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // @ts-expect-error -- a query the mutation doesn't list in `uses`
    await ctx.runQuery(get, { id: noteId });
    return null;
  },
});

// An action has no database, and calls only what it lists.
const mail = resource.connector("mail", {
  contract: "grasp.mail@1",
  actions: ["send"],
});
const help = resource.knowledge("help", {
  operations: ["search"],
  collections: ["handbook"],
});
const summarizer = resource.model("summarizer", {
  structuredOutput: v.object({ summary: v.string() }),
  maxOutputTokens: 500,
});
const secret = internalQuery({
  args: {},
  returns: v.string(),
  handler: () => "s",
});

action({
  args: { noteId: v.id("notes"), to: v.string().email() },
  returns: v.object({ summary: v.string() }),
  uses: [get, create, mail, help, summarizer, secret],
  handler: async (ctx, args) => {
    expectTypeOf(ctx).toExtend<ActionCtx<readonly [typeof get]>>();
    // No database, and no notifications.
    expectTypeOf(ctx).not.toHaveProperty("db");
    expectTypeOf(ctx).not.toHaveProperty("notify");
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
    await ctx.resources.mail.call("send", { to: args.to });
    // @ts-expect-error -- an action the declaration doesn't list
    await ctx.resources.mail.call("delete", {});
    expectTypeOf(
      ctx.resources.help.search({ text: "a" })
    ).resolves.toEqualTypeOf<{ title: string; excerpt: string }[]>();
    // Only the declared operations and resources.
    expectTypeOf(ctx.resources.help).not.toHaveProperty("read");
    expectTypeOf(ctx.resources).not.toHaveProperty("calendar");
    return await ctx.resources.summarizer.generate({ prompt: "Summarize" });
  },
});
action({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // @ts-expect-error -- a function it doesn't list in `uses`
    await ctx.runQuery(get, { id: noteId });
    expectTypeOf(ctx.resources).not.toHaveProperty("mail");
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

// `doc` is a whole record of the pinned schema.
expectTypeOf(doc("notes").shape._rev).toExtend<unknown>();
// @ts-expect-error -- the schema has no such table
doc("missing");

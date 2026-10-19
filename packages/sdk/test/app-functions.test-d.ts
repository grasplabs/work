// Compile-time guarantees of `appFunctions` (GRA-711): a workflow calls its
// App's public functions by their registered paths, typed by the App's own
// definitions grouped as its `operations` registers them, under the repo's
// strict config (`noUncheckedIndexedAccess`). This file is type-checked by
// `vp check` and never run: every `@ts-expect-error` below must stay an
// error.
/* oxlint-disable require-await -- stand-in handlers */
import type { Json } from "@grasp-os/shared/json";
import { expectTypeOf } from "vite-plus/test";

import type { Id } from "../src/index.ts";
import { serverModule } from "../src/server.ts";
import { defineSchema, defineTable, v } from "../src/values.ts";
import { appFunctions } from "../src/workflow.ts";
import type {
  AppErrorPayload,
  FunctionResult,
  WorkflowEnv,
} from "../src/workflow.ts";

const { query, mutation, action, internalMutation } = serverModule(
  defineSchema({ drafts: defineTable({ title: v.string() }) })
);

const reviewer = query({
  args: {},
  returns: v.literal(true),
  handler: async () => true as const,
});
const propose = mutation({
  args: { title: v.string(), guest: v.boolean() },
  returns: v.id("drafts"),
  handler: async (ctx, args) =>
    await ctx.db.insert("drafts", { title: args.title }),
});
const notes = action({
  args: { chat: v.string() },
  returns: v.object({ notes: v.string() }),
  handler: async () => ({ notes: "" }),
});
const purge = internalMutation({
  args: {},
  returns: v.null(),
  handler: async () => null,
});

/** The App's functions, grouped as its `operations` registers them. */
interface Intake {
  drafts: {
    reviewer: typeof reviewer;
    propose: typeof propose;
    purge: typeof purge;
  };
  chats: { notes: typeof notes };
}

declare const env: WorkflowEnv;
const functions = appFunctions<Intake>(env);

// Each kind offers its public functions by path, typed by its definition.
expectTypeOf(functions.query("drafts.reviewer", {})).resolves.toEqualTypeOf<
  FunctionResult<true>
>();
expectTypeOf(
  functions.mutation("drafts.propose", { title: "Notes", guest: false })
).resolves.toEqualTypeOf<FunctionResult<Id<"drafts">>>();
expectTypeOf(
  functions.action("chats.notes", { chat: "c1" })
).resolves.toEqualTypeOf<FunctionResult<{ notes: string }>>();

// A failure is explicit, with the host's error.
const answered = await functions.query("drafts.reviewer", {});
if (!answered.ok) {
  expectTypeOf(answered.error).toEqualTypeOf<AppErrorPayload>();
}

// Another kind's path.
// @ts-expect-error -- drafts.propose is a mutation
void functions.query("drafts.propose", { title: "x", guest: false });

// An internal function: never a caller's.
// @ts-expect-error -- drafts.purge is internal
void functions.mutation("drafts.purge", {});

// A path the App doesn't register.
// @ts-expect-error -- no drafts.missing
void functions.query("drafts.missing", {});

// Arguments its definition doesn't take.
// @ts-expect-error -- guest is required
void functions.mutation("drafts.propose", { title: "x" });

// No method besides the three kinds.
// @ts-expect-error -- no call on the stub
void functions.call;

// Untyped, any path with JSON, answering JSON.
expectTypeOf(
  appFunctions(env).query("drafts.list", { limit: 1 })
).resolves.toEqualTypeOf<FunctionResult<Json>>();

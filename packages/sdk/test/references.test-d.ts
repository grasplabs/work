// Compile-time guarantees of the references the host generates (spec 7.3,
// 8, 32.1), checked against the Notes fixture's generated modules: what a
// browser calls with them infers each function's arguments, return,
// kind, visibility and progress from its descriptors alone, without a
// cast or a generic argument, and to exactly the types the server's own
// definitions infer. This file is type-checked by `vp check` and never
// run: every `@ts-expect-error` below must stay an error.
import { expectTypeOf } from "vite-plus/test";

import type {
  AnyOperationReference,
  ArgsOf,
  Id,
  OperationReference,
  ProgressOf,
  ReturnOf,
} from "../src/index.ts";
import type { ValueDescriptor } from "../src/value-descriptor.ts";
import type { workflows } from "./notes/server/_generated/api.ts";
import {
  api,
  preferences,
  permissions,
} from "./notes/server/_generated/api.ts";
import { internal } from "./notes/server/_generated/internal.ts";
import type {
  create,
  exportAll,
  get,
  list,
  remove,
  tally,
  update,
} from "./notes/server/notes.ts";

// What a browser's call signatures look like: one public reference of the
// right kind, with its arguments, answering its return. The real hooks
// come with the client SDK; these hold the reference types to them.
declare const query: <
  Reference extends OperationReference<unknown, unknown, "query">,
>(
  reference: Reference,
  args: ArgsOf<Reference>
) => Promise<ReturnOf<Reference>>;
declare const mutation: <
  Reference extends OperationReference<unknown, unknown, "mutation">,
>(
  reference: Reference,
  args: ArgsOf<Reference>
) => Promise<ReturnOf<Reference>>;
declare const action: <
  Reference extends OperationReference<unknown, unknown, "action">,
>(
  reference: Reference,
  args: ArgsOf<Reference>
) => Promise<ReturnOf<Reference>>;
/** A single answer only: a streaming reference has its own entry. */
declare const single: (
  reference: OperationReference<unknown, unknown, "action">
) => void;
declare const noteId: Id<"notes">;

// Each reference's arguments and return are exactly its definition's.
expectTypeOf<ArgsOf<typeof api.notes.create>>().toEqualTypeOf<
  ArgsOf<typeof create>
>();
expectTypeOf<ReturnOf<typeof api.notes.create>>().toEqualTypeOf<
  ReturnOf<typeof create>
>();
expectTypeOf<ArgsOf<typeof api.notes.list>>().toEqualTypeOf<
  ArgsOf<typeof list>
>();
expectTypeOf<ReturnOf<typeof api.notes.list>>().toEqualTypeOf<
  ReturnOf<typeof list>
>();
expectTypeOf<ReturnOf<typeof api.notes.get>>().toEqualTypeOf<
  ReturnOf<typeof get>
>();
expectTypeOf<ArgsOf<typeof api.notes.update>>().toEqualTypeOf<
  ArgsOf<typeof update>
>();
expectTypeOf<ReturnOf<typeof api.notes.update>>().toEqualTypeOf<
  ReturnOf<typeof update>
>();
expectTypeOf<ArgsOf<typeof api.notes.remove>>().toEqualTypeOf<
  ArgsOf<typeof remove>
>();
expectTypeOf<ReturnOf<typeof api.notes.tally>>().toEqualTypeOf<
  ReturnOf<typeof tally>
>();
expectTypeOf<ArgsOf<typeof api.notes.exportAll>>().toEqualTypeOf<
  ArgsOf<typeof exportAll>
>();

// A mutation's and an action's reference always holds its kind, which
// `useForm` sends by, and its arguments' descriptor; a query's holds neither.
expectTypeOf(api.notes.create.kind).toEqualTypeOf<"mutation">();
expectTypeOf(api.notes.tally.kind).toEqualTypeOf<"action">();
expectTypeOf(api.notes.create.args).toEqualTypeOf<ValueDescriptor>();
// @ts-expect-error a query's reference holds no kind
void api.notes.get.kind;
// @ts-expect-error nor its arguments
void api.notes.get.args;

// A streaming reference carries its progress type; any other none.
expectTypeOf<ProgressOf<typeof api.notes.exportAll>>().toEqualTypeOf<{
  done: number;
}>();
expectTypeOf<ProgressOf<typeof api.notes.create>>().toBeNever();
single(api.notes.tally);
// @ts-expect-error a streaming action isn't a single answer
single(api.notes.exportAll);

// The phantom members are no names an editor offers or JSON holds.
expectTypeOf<Extract<keyof typeof api.notes.create, string>>().toEqualTypeOf<
  "name" | "kind" | "args"
>();
expectTypeOf<Extract<keyof typeof api.notes.get, string>>().toEqualTypeOf<
  "name" | "returns"
>();

// Calls infer from the reference alone: no cast, no generic argument.
expectTypeOf(
  mutation(api.notes.create, { title: "Launch" })
).resolves.toEqualTypeOf<Id<"notes">>();
expectTypeOf(query(api.notes.get, { id: noteId })).resolves.toEqualTypeOf<
  ReturnOf<typeof get>
>();
expectTypeOf(query(api.notes.list, { pagination: {} })).resolves.toEqualTypeOf<
  ReturnOf<typeof list>
>();
expectTypeOf(action(api.notes.tally, {})).resolves.toEqualTypeOf<number>();

// A defaulted argument may be left out; a required one may not.
void mutation(api.notes.create, { title: "Launch", body: "" });
// @ts-expect-error `title` is required
void mutation(api.notes.create, { body: "" });
// @ts-expect-error `title` is a string
void mutation(api.notes.create, { title: 1 });
// @ts-expect-error no key the arguments don't declare
void mutation(api.notes.create, { title: "Launch", owner: "someone" });
// @ts-expect-error an ID of another table
void query(api.notes.get, { id: "not-an-id" });

// The wrong kind fails, whichever way round.
// @ts-expect-error a mutation isn't a query
void query(api.notes.create, { title: "Launch" });
// @ts-expect-error a query isn't a mutation
void mutation(api.notes.get, { id: noteId });
// @ts-expect-error a query isn't an action
void action(api.notes.list, { pagination: {} });

// Internal references never reach a browser's signatures, nor its api.
// @ts-expect-error an internal reference isn't public
void query(internal.notes.count, {});
// @ts-expect-error the api has no internal function
void api.notes.count;

// The literal permissions.
expectTypeOf(permissions.files.operations).toEqualTypeOf<
  readonly ["upload", "read", "attach"]
>();
expectTypeOf(permissions.links.origins).toEqualTypeOf<
  readonly ["https://help.example.com"]
>();
// @ts-expect-error a permission the App doesn't declare
void permissions.mail;

// Preferences: `get` and `update`, a query and a mutation like any other,
// answering every declared field and `_rev`; a patch names only fields
// the App declared, each optional.
expectTypeOf<keyof typeof preferences>().toEqualTypeOf<"get" | "update">();
expectTypeOf(preferences.get).toExtend<
  OperationReference<
    Record<never, never>,
    { _rev: number; compact: boolean },
    "query"
  >
>();
expectTypeOf(preferences.update).toExtend<
  OperationReference<
    { expectedRevision: number; patch: { compact?: boolean } },
    { _rev: number; compact: boolean },
    "mutation"
  >
>();
void query(preferences.get, {});
void mutation(preferences.update, { expectedRevision: 0, patch: {} });
void mutation(preferences.update, {
  expectedRevision: 0,
  // @ts-expect-error a preference the App doesn't declare
  patch: { dark: true },
});
// @ts-expect-error an update names the revision it read
void mutation(preferences.update, { patch: { compact: true } });
// @ts-expect-error `get` reads; it isn't a mutation
void mutation(preferences.get, {});

// The workflows the App binds, and nothing else (workflow-references.test-d.ts).
expectTypeOf<keyof typeof workflows>().toEqualTypeOf<
  "archiveNotes" | "summarizeNote"
>();

// Any reference takes a single answer's and a stream's alike.
const anyReferences: readonly AnyOperationReference[] = [
  api.notes.create,
  api.notes.exportAll,
  internal.notes.count,
];
void anyReferences;

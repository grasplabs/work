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
  Infer,
  InferInput,
  OperationReference,
  ProgressOf,
  ReturnOf,
  ScreenInputOf,
} from "../src/index.ts";
import type { workflows } from "./notes/.grasp/references.ts";
import {
  api,
  preferences,
  resources,
  screens,
} from "./notes/.grasp/references.ts";
import { internal } from "./notes/.grasp/server-references.ts";
import type {
  create,
  exportAll,
  get,
  list,
  remove,
  tally,
  update,
} from "./notes/operations/notes.ts";

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
  reference: OperationReference<unknown, unknown, "action"> & {
    readonly mode: "single";
  }
) => void;
declare const noteId: Id<"notes">;

// Each reference's arguments and return are exactly its definition's.
expectTypeOf<ArgsOf<typeof api.notes.create>>().toEqualTypeOf<
  ArgsOf<typeof create>
>();
expectTypeOf<ReturnOf<typeof api.notes.create>>().toEqualTypeOf<
  Infer<(typeof create)["returns"]>
>();
expectTypeOf<ArgsOf<typeof api.notes.list>>().toEqualTypeOf<
  InferInput<(typeof list)["args"]>
>();
expectTypeOf<ReturnOf<typeof api.notes.list>>().toEqualTypeOf<
  Infer<(typeof list)["returns"]>
>();
expectTypeOf<ReturnOf<typeof api.notes.get>>().toEqualTypeOf<
  Infer<(typeof get)["returns"]>
>();
expectTypeOf<ArgsOf<typeof api.notes.update>>().toEqualTypeOf<
  ArgsOf<typeof update>
>();
expectTypeOf<ReturnOf<typeof api.notes.update>>().toEqualTypeOf<
  Infer<(typeof update)["returns"]>
>();
expectTypeOf<ArgsOf<typeof api.notes.remove>>().toEqualTypeOf<
  ArgsOf<typeof remove>
>();
expectTypeOf<ReturnOf<typeof api.notes.tally>>().toEqualTypeOf<
  Infer<(typeof tally)["returns"]>
>();
expectTypeOf<ArgsOf<typeof api.notes.exportAll>>().toEqualTypeOf<
  ArgsOf<typeof exportAll>
>();

// Kind, visibility and mode are literals, never a union to fall back on.
expectTypeOf(api.notes.create.kind).toEqualTypeOf<"mutation">();
expectTypeOf(api.notes.list.kind).toEqualTypeOf<"query">();
expectTypeOf(api.notes.tally.kind).toEqualTypeOf<"action">();
expectTypeOf(api.notes.create.visibility).toEqualTypeOf<"public">();
expectTypeOf(internal.notes.count.visibility).toEqualTypeOf<"internal">();
expectTypeOf(api.notes.create.mode).toEqualTypeOf<"single">();
expectTypeOf(api.notes.exportAll.mode).toEqualTypeOf<"stream">();

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
  | "resourceId"
  | "resourceVersion"
  | "contractId"
  | "fingerprint"
  | "kind"
  | "mode"
  | "stream"
  | "visibility"
  | "args"
  | "returns"
>();

// Calls infer from the reference alone: no cast, no generic argument.
expectTypeOf(
  mutation(api.notes.create, { title: "Launch" })
).resolves.toEqualTypeOf<Id<"notes">>();
expectTypeOf(query(api.notes.get, { id: noteId })).resolves.toEqualTypeOf<
  Infer<(typeof get)["returns"]>
>();
expectTypeOf(query(api.notes.list, { pagination: {} })).resolves.toEqualTypeOf<
  Infer<(typeof list)["returns"]>
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

// A screen's route input, and the literal resources.
expectTypeOf<ScreenInputOf<typeof screens.note>>().toEqualTypeOf<{
  id: Id<"notes">;
}>();
expectTypeOf(screens.note.name).toEqualTypeOf<"note">();
expectTypeOf(resources.attachments.operations).toEqualTypeOf<
  readonly ["upload", "read", "attach"]
>();
expectTypeOf(resources.help.origins).toEqualTypeOf<
  readonly ["https://help.example.com"]
>();
// @ts-expect-error a resource the App doesn't declare
void resources.mail;

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
// And its mode says so: either, never only a stream.
const anyModes: readonly AnyOperationReference["mode"][] = ["single", "stream"];
void anyModes;

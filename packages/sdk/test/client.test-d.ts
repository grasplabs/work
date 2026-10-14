// Compile-time guarantees of the session client and its hooks (spec 10.1,
// 10.7.1), against the Notes fixture's generated references: arguments
// and results are inferred from the reference alone, without a cast or a
// generic argument; leaving out required input, passing the wrong input,
// an unknown option, a query's key, an internal or streaming reference,
// or a reference of another kind fails. This file is type-checked by
// `vp check` and never run: every `@ts-expect-error` below must stay an
// error.
import { expectTypeOf } from "vite-plus/test";

import type { GraspClient } from "../src/client.ts";
import type { Id } from "../src/index.ts";
import { useAction, useClient, useMutation, useQuery } from "../src/react.ts";
import type { GraspError } from "../src/react.ts";
import { api } from "./notes/.grasp/references.ts";
import { internal } from "./notes/.grasp/server-references.ts";

declare const client: GraspClient;
declare const noteId: Id<"notes">;
declare const signal: AbortSignal;

type Note = NonNullable<
  Awaited<ReturnType<typeof client.query<typeof api.notes.get>>>
>;

// The hooks, called as a component calls them.
export const useChecks = (): void => {
  // Queries: the declared result, or undefined while loading or skipped.
  expectTypeOf(useQuery(api.notes.get, { id: noteId })).toEqualTypeOf<
    Note | null | undefined
  >();
  expectTypeOf(useQuery(api.notes.get, "skip")).toEqualTypeOf<
    Note | null | undefined
  >();
  expectTypeOf(
    useQuery(api.notes.list, { pagination: { pageSize: 50 } })?.items
  ).toEqualTypeOf<Note[] | undefined>();
  // @ts-expect-error -- a query's input is required
  void useQuery(api.notes.get);
  // @ts-expect-error -- null doesn't skip a query; only "skip" does
  void useQuery(api.notes.get, null);
  // @ts-expect-error -- the wrong field
  void useQuery(api.notes.get, { noteId });
  // @ts-expect-error -- a mutation isn't a query
  void useQuery(api.notes.create, { title: "x" });
  // @ts-expect-error -- an internal reference isn't callable from a screen
  void useQuery(internal.notes.count, {});

  // Mutations and actions: stable callables answering the declared value.
  const create = useMutation(api.notes.create);
  expectTypeOf(create({ title: "First" })).toEqualTypeOf<
    Promise<Id<"notes">>
  >();
  expectTypeOf(
    create({ title: "First" }, { signal, idempotencyKey: "first" })
  ).toEqualTypeOf<Promise<Id<"notes">>>();
  // @ts-expect-error -- required input can't be left out
  void create();
  // @ts-expect-error -- a required field is missing
  void create({ body: "" });
  // @ts-expect-error -- a field of the wrong type
  void create({ title: 1 });
  // @ts-expect-error -- options are checked strictly
  void create({ title: "x" }, { retries: 3 });
  // @ts-expect-error -- there are no aliases beside the callable
  void create.mutate;

  const remove = useMutation(api.notes.remove);
  expectTypeOf(remove({ id: noteId, expectedRevision: 1 })).toEqualTypeOf<
    Promise<null>
  >();

  const tally = useAction(api.notes.tally);
  // An empty input may be left out; options then follow `{}`.
  expectTypeOf(tally()).toEqualTypeOf<Promise<number>>();
  expectTypeOf(tally({}, { idempotencyKey: "count" })).toEqualTypeOf<
    Promise<number>
  >();
  // @ts-expect-error -- a streaming action has its own hook (GRA-258)
  void useAction(api.notes.exportAll);
  // @ts-expect-error -- a query isn't an action
  void useAction(api.notes.get);
  // @ts-expect-error -- a mutation isn't an action
  void useAction(api.notes.create);

  // The imperative client: the same contracts, as promises.
  const session = useClient();
  expectTypeOf(session).toEqualTypeOf<GraspClient>();
};

expectTypeOf(client.query(api.notes.get, { id: noteId })).toEqualTypeOf<
  Promise<Note | null>
>();
expectTypeOf(
  client.query(api.notes.get, { id: noteId }, { signal })
).toEqualTypeOf<Promise<Note | null>>();
// @ts-expect-error -- a query takes no idempotency key
void client.query(api.notes.get, { id: noteId }, { idempotencyKey: "k" });
expectTypeOf(
  client.mutation(api.notes.update, {
    id: noteId,
    expectedRevision: 1,
    title: "t",
    body: "",
  })
).toEqualTypeOf<Promise<Note>>();
expectTypeOf(client.action(api.notes.tally)).toEqualTypeOf<Promise<number>>();
// @ts-expect-error -- no `run`, `mutate` or `act` beside query, mutation and action
void client.mutate;
// @ts-expect-error -- the client's internals aren't App code's
void client.entry;

// Failures are structured errors to branch on.
declare const failure: GraspError;
expectTypeOf(failure.code).toEqualTypeOf<string>();
expectTypeOf(failure.category).toEqualTypeOf<
  | "source"
  | "contract"
  | "domain"
  | "authorization"
  | "operational"
  | "uncertain"
  | "safety"
>();

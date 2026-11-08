import type { Grant } from "./ctx-workflows.ts";
import { defineFunction, refuse } from "./define-function.ts";
import type {
  ActionDefinition,
  MutationDefinition,
  QueryDefinition,
  StreamActionDefinition,
} from "./define-function.ts";
import { tablesOf } from "./define-schema.ts";
import type { SchemaDefinition } from "./schema-types.ts";
import type {
  ActionCtx,
  MutationCtx,
  QueryCtx,
  StreamActionCtx,
} from "./server-ctx.ts";
import type {
  AnyTables,
  Declared,
  FunctionKind,
  ResultFor,
  ServerFunction,
  Visibility,
} from "./server-function.ts";
import type { AnySchema } from "./value-schema.ts";
import type { Infer, ObjectSchema, ValueShape } from "./value-types.ts";
import { v } from "./values.ts";

export type { Grant, RunHandle, Workflows } from "./ctx-workflows.ts";
export type { ActionDefinition } from "./define-function.ts";
export type { ArgsOf, ReturnOf } from "./function-references.ts";
export type {
  ActionCtx,
  Auth,
  CallerCtx,
  MutationCtx,
  NotifyReceipt,
  PeopleNotification,
  QueryCtx,
} from "./server-ctx.ts";
export type {
  AnyFunction,
  FunctionKind,
  FunctionReference,
  Visibility,
} from "./server-function.ts";

// An App's server functions: queries, mutations and
// actions, public or internal, each declared with its arguments, its
// return and a handler `handler(ctx, args)`. A definition is a value: it
// runs nothing and registers nothing. The App registers it under a path
// by exporting it from a module under `server/` (app.ts), and the host runs it, validating the
// arguments it is called with and what it returns against the declared
// schemas, which it holds as descriptors, never trusting App code to.
//
// What a handler can do is what its context has: what its kind allows of
// the App's permissions (grasp.config.ts), the App's one list, as in
// Convex, where every function of an app may use what the app may. The
// three kinds differ on purpose:
// - a query reads (`ctx.db` reads only), and has nothing to write with or
//   call out through;
// - a mutation reads and stages writes (`ctx.db`), which commit together
//   after it returns, and may run the App's queries in the same staged
//   state (`ctx.runQuery`); it has no resources, so no network, and the
//   only thing it starts is one of the App's workflows, after it commits
//   (`ctx.afterCommit.workflows`), as part of that commit, and the only
//   event it sends is one of the App's workflows', to a run of the App's
//   own, likewise (`ctx.notify`); it tells people only once
//   it commits, likewise (`ctx.afterCommit.notifyPeople`);
// - an action has no `db` at all: it composes the App's functions
//   (`runQuery`, `runMutation`, `runAction`), each its own invocation,
//   reaches outside the App only through the App's permissions (`ctx.ai`,
//   `ctx.connections`, `ctx.brain`, `ctx.grasp`, `ctx.guests`), starts
//   the App's workflows (`ctx.workflows`), and tells people through the
//   platform's notifications (`ctx.notifyPeople`).
// What a function reads and writes is its tables' access and row rules
// for whoever calls, which the store decides. The host enforces each of
// these again at run time, against the App's sealed manifest, whatever
// App code sends it; the types here make the mistakes fail to compile
// first.
//
// The constructors are specialized to the App's schema by `serverModule`,
// which the generated `server/_generated/server` module calls; an author never
// writes their generics. There is no `input`/`output` form, no `reads` or
// `writes` list, no per-function `uses` or `tables` and no `ctx.data`:
// the superseded shapes are refused, not aliased.
//
// Adapted from Baseflare's server function constructors (MIT, © 2026
// Baseflare contributors: packages/baseflare/src/server/functions), with
// Grasp's mandatory returns, strict keys and capability-free actions.

/** The managed fields of a record of table `TableName`, as schemas. */
const managedShape = <TableName extends string>(table: TableName) => ({
  _id: v.id(table),
  _ownerId: v.string().min(1),
  _rev: v.number().integer().min(1),
  _createdAt: v.timestamp(),
  _updatedAt: v.timestamp(),
});

type ManagedShape<TableName extends string> = ReturnType<
  typeof managedShape<TableName>
>;

/**
 * `action` and `internalAction`: a streaming action when the declaration
 * has `stream` (its handler's context has `emit`), any other otherwise.
 */
interface ActionConstructor<
  Vis extends Visibility,
  Grants extends Grant = never,
> {
  <
    const Shape extends ValueShape,
    Stream extends AnySchema,
    Returns extends AnySchema | undefined = undefined,
    Result extends ResultFor<Returns> = ResultFor<Returns>,
  >(
    declaration: StreamActionDefinition<Shape, Returns, Result, Grants, Stream>
  ): ServerFunction<
    "action",
    Vis,
    Shape,
    Declared<Returns, Result>,
    StreamActionCtx<Grants, Infer<Stream>>,
    Stream
  >;
  <
    const Shape extends ValueShape,
    Returns extends AnySchema | undefined = undefined,
    Result extends ResultFor<Returns> = ResultFor<Returns>,
  >(
    declaration: ActionDefinition<Shape, Returns, Result, Grants>
  ): ServerFunction<
    "action",
    Vis,
    Shape,
    Declared<Returns, Result>,
    ActionCtx<Grants>
  >;
}

/** `query` and `internalQuery`. */
type QueryConstructor<Tables extends AnyTables, Vis extends Visibility> = <
  const Shape extends ValueShape,
  Returns extends AnySchema | undefined = undefined,
  Result extends ResultFor<Returns> = ResultFor<Returns>,
>(
  declaration: QueryDefinition<Tables, Shape, Returns, Result>
) => ServerFunction<
  "query",
  Vis,
  Shape,
  Declared<Returns, Result>,
  QueryCtx<Tables>
>;

/** `mutation` and `internalMutation`. */
type MutationConstructor<
  Tables extends AnyTables,
  Vis extends Visibility,
  Grants extends Grant = never,
> = <
  const Shape extends ValueShape,
  Returns extends AnySchema | undefined = undefined,
  Result extends ResultFor<Returns> = ResultFor<Returns>,
>(
  declaration: MutationDefinition<Tables, Shape, Returns, Result, Grants>
) => ServerFunction<
  "mutation",
  Vis,
  Shape,
  Declared<Returns, Result>,
  MutationCtx<Tables, Grants>
>;

/**
 * The server constructors and `doc`, specialized to one schema and to
 * what the App's permissions grant (`Grants`).
 */
interface ServerModule<Tables extends AnyTables, Grants extends Grant = never> {
  readonly query: QueryConstructor<Tables, "public">;
  readonly internalQuery: QueryConstructor<Tables, "internal">;
  readonly mutation: MutationConstructor<Tables, "public", Grants>;
  readonly internalMutation: MutationConstructor<Tables, "internal", Grants>;
  readonly action: ActionConstructor<"public", Grants>;
  readonly internalAction: ActionConstructor<"internal", Grants>;
  /**
   * The schema of a whole record of `table` under this schema: its
   * managed fields and its declared fields, for a function's `returns`.
   */
  readonly doc: <TableName extends keyof Tables & string>(
    table: TableName
  ) => ObjectSchema<ManagedShape<TableName> & Tables[TableName]["fields"]>;
}

/**
 * The server constructors for `schema`, typed by what `config` grants
 * (`defineApp`'s answer, which carries its permissions' types): what the
 * generated `server/_generated/server` module exports for an App or a
 * store, never imported by App code directly. The config shapes types
 * only: the host checks every use against the App's sealed permissions.
 * Throws for anything but a schema `defineSchema` made.
 */
export const serverModule = <
  Tables extends AnyTables,
  Grants extends Grant = never,
>(
  schema: SchemaDefinition<Tables>,
  _config?: { readonly "~grants"?: Grants }
): ServerModule<Tables, Grants> => {
  // Throws for anything `defineSchema` didn't make.
  const tables = tablesOf(schema);
  const constructor =
    (kind: FunctionKind, visibility: Visibility) => (declaration: unknown) =>
      defineFunction(schema, kind, visibility, declaration);
  const module = {
    query: constructor("query", "public"),
    internalQuery: constructor("query", "internal"),
    mutation: constructor("mutation", "public"),
    internalMutation: constructor("mutation", "internal"),
    action: constructor("action", "public"),
    internalAction: constructor("action", "internal"),
    doc: (table: unknown) => {
      if (typeof table !== "string" || !Object.hasOwn(tables, table)) {
        return refuse("`doc` names a table of the schema.");
      }
      return v.object({
        ...managedShape(table),
        ...schema.tables[table]?.fields,
      });
    },
  };
  // SAFETY: each constructor checks its declaration at run time as the
  // definition types of `ServerModule` describe it, and answers the
  // frozen definition; `doc` answers the object schema of the table's
  // managed and declared fields.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return Object.freeze(module) as ServerModule<Tables, Grants>;
};

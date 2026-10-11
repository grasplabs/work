import { usesMaxEntries } from "@grasp-os/shared/operation-limits";

import type { DatabaseReader, DatabaseWriter } from "./database.ts";
import { isResource } from "./resources.ts";
import type { AnyResource, ResourceClient } from "./resources.ts";
import { tablesOf } from "./schema.ts";
import type { AnyTable, SchemaDefinition } from "./schema.ts";
import { isPlainObject } from "./value-descriptor.ts";
import { descriptorOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";
import { v } from "./values.ts";
import type {
  Infer,
  InferInput,
  ObjectInput,
  ObjectOutput,
  ObjectSchema,
  ValueShape,
} from "./values.ts";

// An App's server functions (spec 7.1, 7.4): queries, mutations and
// actions, public or internal, each declared with its arguments, its
// return and a handler `handler(ctx, args)`. A definition is a value: it
// runs nothing and registers nothing. The App registers it under a path
// (`app({ operations })`, app.ts), and the host runs it, validating the
// arguments it is called with and what it returns against the declared
// schemas, which it holds as descriptors, never trusting App code to.
//
// What a handler can do is what its context has, and the three differ on
// purpose:
// - a query reads (`ctx.db` reads only), and has nothing to write with or
//   call out through: no `uses`;
// - a mutation reads and stages writes (`ctx.db`), which commit together
//   after it returns, and may run the App's queries in the same staged
//   state (`ctx.runQuery`); it has no resources, so no network;
// - an action has no `db` at all: it composes the App's functions
//   (`runQuery`, `runMutation`, `runAction`), each its own invocation,
//   and reaches outside capabilities only through `ctx.resources`, for
//   the resources its `uses` lists.
// The host enforces each of these again at run time, whatever App code
// sends it; the types here make the mistakes fail to compile first.
//
// The constructors are specialized to the App's schema by `serverModule`,
// which the generated `#grasp/server` module calls; an author never
// writes their generics. There is no `input`/`output` form, no `reads` or
// `writes` list and no `ctx.data`: the superseded shapes of spec 7 are
// refused, not aliased.
//
// Adapted from Baseflare's server function constructors (MIT, © 2026
// Baseflare contributors: packages/baseflare/src/server/functions), with
// Grasp's mandatory returns, strict keys and capability-free actions.

/** The three kinds of server function. */
export type FunctionKind = "query" | "mutation" | "action";

/** Who may call a function directly: anyone allowed, or the App's own code. */
export type Visibility = "public" | "internal";

/** A schema's tables, by name. */
type AnyTables = Readonly<Record<string, AnyTable>>;

/**
 * A function as callers type it: its kind, visibility, arguments (as a
 * caller passes them and as the handler gets them) and return. The
 * phantom members carry inference only and are never set.
 */
export interface FunctionReference<
  Kind extends FunctionKind = FunctionKind,
  Vis extends Visibility = Visibility,
  ArgsIn = unknown,
  Return = unknown,
> {
  readonly kind: Kind;
  readonly visibility: Vis;
  readonly "~argsIn"?: ArgsIn;
  readonly "~return"?: Return;
}

/** Any function reference: its phantom members are only ever read. */
export type AnyReference = FunctionReference;

/** The arguments a caller passes to `Reference`. */
export type ArgsOf<Reference> =
  Reference extends FunctionReference<FunctionKind, Visibility, infer ArgsIn>
    ? ArgsIn
    : never;

/** What `Reference` returns. */
export type ReturnOf<Reference> =
  Reference extends FunctionReference<
    FunctionKind,
    Visibility,
    unknown,
    infer Return
  >
    ? Return
    : never;

/** What a function's `uses` may list: functions of the App, and resources. */
export type Use = AnyReference | AnyResource;

/** The references of kind `Kind` among `Uses`. */
type UsedOfKind<
  Uses extends readonly Use[],
  Kind extends FunctionKind,
> = Extract<Uses[number], FunctionReference<Kind>>;

/** `ctx.runQuery`: one of the queries `Uses` lists, with its arguments. */
type RunQuery<Uses extends readonly Use[]> = <
  Reference extends UsedOfKind<Uses, "query">,
>(
  reference: Reference,
  args: ArgsOf<Reference>
) => Promise<ReturnOf<Reference>>;

/** `ctx.runMutation`: one of the mutations `Uses` lists. */
type RunMutation<Uses extends readonly Use[]> = <
  Reference extends UsedOfKind<Uses, "mutation">,
>(
  reference: Reference,
  args: ArgsOf<Reference>
) => Promise<ReturnOf<Reference>>;

/** `ctx.runAction`: one of the actions `Uses` lists. */
type RunAction<Uses extends readonly Use[]> = <
  Reference extends UsedOfKind<Uses, "action">,
>(
  reference: Reference,
  args: ArgsOf<Reference>
) => Promise<ReturnOf<Reference>>;

/** `ctx.resources`: a client for each resource `Uses` lists, by alias. */
export type Resources<Uses extends readonly Use[]> = {
  readonly [
    Resource in Extract<Uses[number], AnyResource> as Resource["alias"]
  ]: ResourceClient<Resource>;
};

/** What a query's handler has: reads, and nothing else. */
export interface QueryCtx<Tables extends AnyTables> {
  readonly db: DatabaseReader<Tables>;
}

/**
 * What a mutation's handler has: reads and staged writes, which commit
 * together once it returns, and the queries it `uses`, run in the same
 * staged state.
 */
export interface MutationCtx<
  Tables extends AnyTables,
  Uses extends readonly Use[] = readonly [],
> {
  readonly db: DatabaseWriter<Tables>;
  readonly runQuery: RunQuery<Uses>;
}

/**
 * What an action's handler has: the functions and resources it `uses`.
 * No database: what it reads and writes goes through the App's queries
 * and mutations, each committed on its own.
 *
 * An action is not atomic across its calls. A query it runs and a
 * mutation it runs after are two invocations: nothing fences the
 * mutation on what the query read, so a record can change between them,
 * and a mutation that committed stays committed if the action fails
 * later. Read and change together in one mutation when the change depends
 * on the read (a mutation's `expectedRevision` and read set fence it).
 *
 * Called again under the same idempotency key with the same input, an
 * action gets the earlier outcomes of the mutations and resource requests
 * it makes, matched by their order among those (queries don't count).
 * That order follows the data: if, on the second call, the data has the
 * action run the same mutation at a place with other arguments, it gets
 * `submission.key_conflict`; a different mutation at that place runs
 * anew. Keep what an action changes, and in what order, a function of its
 * input.
 */
export interface ActionCtx<Uses extends readonly Use[] = readonly []> {
  readonly runQuery: RunQuery<Uses>;
  readonly runMutation: RunMutation<Uses>;
  readonly runAction: RunAction<Uses>;
  readonly resources: Resources<Uses>;
}

/** A handler's answer: its return, or a promise of it. */
type Answer<Returns extends AnySchema> =
  | Infer<Returns>
  | Promise<Infer<Returns>>;

/** A declared server function, as the App registers it. */
export interface ServerFunction<
  Kind extends FunctionKind,
  Vis extends Visibility,
  Shape extends ValueShape,
  Returns extends AnySchema,
  Ctx,
> extends FunctionReference<Kind, Vis, ObjectInput<Shape>, Infer<Returns>> {
  readonly args: ObjectSchema<Shape>;
  readonly returns: Returns;
  readonly uses: readonly Use[];
  /** An action's progress snapshots (spec 10.7.6), or null. */
  readonly stream: AnySchema | null;
  readonly handler: (ctx: Ctx, args: ObjectOutput<Shape>) => unknown;
}

/**
 * Any declared server function. Its handler takes nothing it could be
 * called with: only the runner calls it, with the context of its kind.
 */
export interface AnyFunction extends FunctionReference {
  readonly args: AnySchema;
  readonly returns: AnySchema;
  readonly uses: readonly Use[];
  readonly stream: AnySchema | null;
  readonly handler: (ctx: never, args: never) => unknown;
}

/** A query's declaration. */
export interface QueryDefinition<
  Tables extends AnyTables,
  Shape extends ValueShape,
  Returns extends AnySchema,
> {
  readonly args: Shape;
  readonly returns: Returns;
  readonly handler: (
    ctx: QueryCtx<Tables>,
    args: ObjectOutput<Shape>
  ) => Answer<Returns>;
}

/** A mutation's declaration. */
export interface MutationDefinition<
  Tables extends AnyTables,
  Shape extends ValueShape,
  Returns extends AnySchema,
  Uses extends readonly Use[],
> {
  readonly args: Shape;
  readonly returns: Returns;
  /** The queries it runs and the notifications it sends; none unless listed. */
  readonly uses?: Uses;
  readonly handler: (
    ctx: MutationCtx<Tables, Uses>,
    args: ObjectOutput<Shape>
  ) => Answer<Returns>;
}

/** An action's declaration. */
export interface ActionDefinition<
  Shape extends ValueShape,
  Returns extends AnySchema,
  Uses extends readonly Use[],
> {
  readonly args: Shape;
  readonly returns: Returns;
  /** The functions and resources it calls; none unless listed. */
  readonly uses?: Uses;
  /**
   * Its progress snapshots, when it streams them (spec 10.7.6): declared
   * here, delivered by the streaming runtime.
   */
  readonly stream?: AnySchema;
  readonly handler: (
    ctx: ActionCtx<Uses>,
    args: ObjectOutput<Shape>
  ) => Answer<Returns>;
}

/** Why a server function's declaration was refused. */
export class FunctionDefinitionError extends Error {
  readonly code = "function.invalid_definition";

  constructor(message: string) {
    super(message);
    this.name = "FunctionDefinitionError";
  }
}

const refuse = (message: string): never => {
  throw new FunctionDefinitionError(message);
};

/** What the SDK knows of a definition it made, and App code can't forge. */
export interface FunctionState {
  readonly schema: SchemaDefinition;
}

/** Every definition a constructor made, with the schema it was made for. */
const functions = new WeakMap<object, FunctionState>();

/** Whether `value` is a server function a constructor made. */
export const isServerFunction = (value: unknown): value is AnyFunction =>
  typeof value === "object" && value !== null && functions.has(value);

/** The state of a definition a constructor made; throws for anything else. */
export const functionState = (value: unknown): FunctionState => {
  const state =
    typeof value === "object" && value !== null
      ? functions.get(value)
      : undefined;
  return state ?? refuse("That isn't a server function a constructor made.");
};

/** The keys each kind's declaration has; any other is refused. */
const declarationKeys: Readonly<Record<FunctionKind, readonly string[]>> = {
  query: ["args", "returns", "handler"],
  mutation: ["args", "returns", "uses", "handler"],
  action: ["args", "returns", "uses", "stream", "handler"],
};

/** Hints for the superseded shapes spec 7 refuses rather than aliases. */
const supersededHints: Readonly<Record<string, string>> = {
  input: "Declare `args`, a map of field schemas, not `input`.",
  output: "Declare `returns`, not `output`.",
  reads: "There is no `reads` list: table access is the App's `access`.",
  writes: "There is no `writes` list: table access is the App's `access`.",
  uses: "A query uses nothing: it only reads.",
  stream: "Only an action streams.",
};

const usesOf = (uses: unknown): readonly Use[] => {
  if (uses === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(uses) || uses.length > usesMaxEntries) {
    return refuse(`\`uses\` lists at most ${usesMaxEntries} references.`);
  }
  const list: readonly unknown[] = uses;
  const checked: Use[] = [];
  for (const use of list) {
    if (!isServerFunction(use) && !isResource(use)) {
      return refuse(
        "`uses` lists the App's server functions and `resource` declarations, never IDs or names."
      );
    }
    checked.push(use);
  }
  return Object.freeze(checked);
};

/** A definition of `kind` and `visibility` from `declaration`, checked. */
const defineFunction = (
  schema: SchemaDefinition,
  kind: FunctionKind,
  visibility: Visibility,
  declaration: unknown
): AnyFunction => {
  if (!isPlainObject(declaration)) {
    return refuse(`A ${kind} is declared with an object.`);
  }
  for (const key of Object.keys(declaration)) {
    if (!declarationKeys[kind].includes(key)) {
      refuse(
        supersededHints[key] ?? `A ${kind}'s declaration has no \`${key}\`.`
      );
    }
  }
  const { args, returns, handler, uses, stream } = declaration;
  if (!isPlainObject(args)) {
    refuse(`A ${kind}'s \`args\` is a map of field names to schemas.`);
  }
  if (returns === undefined) {
    refuse(
      `A ${kind} declares what it \`returns\`; use \`v.null()\` for nothing.`
    );
  }
  // Throws for anything but a `v` schema.
  descriptorOf(returns);
  if (stream !== undefined) {
    descriptorOf(stream);
  }
  if (typeof handler !== "function") {
    refuse(`A ${kind}'s \`handler\` is a function of \`(ctx, args)\`.`);
  }
  // SAFETY: `args` was checked to be a plain object; `v.object` checks
  // each of its fields is a `v` schema, and refuses the shape otherwise.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const argsSchema = v.object(args as ValueShape);
  const definition = Object.freeze({
    kind,
    visibility,
    args: argsSchema,
    // SAFETY: `descriptorOf` above accepted it, so it is a `v` schema.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    returns: returns as AnySchema,
    uses: usesOf(uses),
    // SAFETY: as `returns`, when given.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    stream: (stream ?? null) as AnySchema | null,
    // SAFETY: checked to be a function; the host calls it with the
    // context of its kind and the validated arguments.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    handler: handler as AnyFunction["handler"],
  });
  functions.set(definition, Object.freeze({ schema }));
  return definition;
};

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

/** The server constructors and `doc`, specialized to one schema. */
export interface ServerModule<Tables extends AnyTables> {
  readonly query: <const Shape extends ValueShape, Returns extends AnySchema>(
    declaration: QueryDefinition<Tables, Shape, Returns>
  ) => ServerFunction<"query", "public", Shape, Returns, QueryCtx<Tables>>;
  readonly internalQuery: <
    const Shape extends ValueShape,
    Returns extends AnySchema,
  >(
    declaration: QueryDefinition<Tables, Shape, Returns>
  ) => ServerFunction<"query", "internal", Shape, Returns, QueryCtx<Tables>>;
  readonly mutation: <
    const Shape extends ValueShape,
    Returns extends AnySchema,
    const Uses extends readonly Use[] = readonly [],
  >(
    declaration: MutationDefinition<Tables, Shape, Returns, Uses>
  ) => ServerFunction<
    "mutation",
    "public",
    Shape,
    Returns,
    MutationCtx<Tables, Uses>
  >;
  readonly internalMutation: <
    const Shape extends ValueShape,
    Returns extends AnySchema,
    const Uses extends readonly Use[] = readonly [],
  >(
    declaration: MutationDefinition<Tables, Shape, Returns, Uses>
  ) => ServerFunction<
    "mutation",
    "internal",
    Shape,
    Returns,
    MutationCtx<Tables, Uses>
  >;
  readonly action: <
    const Shape extends ValueShape,
    Returns extends AnySchema,
    const Uses extends readonly Use[] = readonly [],
  >(
    declaration: ActionDefinition<Shape, Returns, Uses>
  ) => ServerFunction<"action", "public", Shape, Returns, ActionCtx<Uses>>;
  readonly internalAction: <
    const Shape extends ValueShape,
    Returns extends AnySchema,
    const Uses extends readonly Use[] = readonly [],
  >(
    declaration: ActionDefinition<Shape, Returns, Uses>
  ) => ServerFunction<"action", "internal", Shape, Returns, ActionCtx<Uses>>;
  /**
   * The schema of a whole record of `table` under this schema: its
   * managed fields and its declared fields, for a function's `returns`.
   */
  readonly doc: <TableName extends keyof Tables & string>(
    table: TableName
  ) => ObjectSchema<ManagedShape<TableName> & Tables[TableName]["fields"]>;
}

/**
 * The server constructors for `schema`: what the generated `#grasp/server`
 * module exports for an App or a store, never imported by App code
 * directly. Throws for anything but a schema `defineSchema` made.
 */
export const serverModule = <Tables extends AnyTables>(
  schema: SchemaDefinition<Tables>
): ServerModule<Tables> => {
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
  return Object.freeze(module) as ServerModule<Tables>;
};

/** The arguments a caller passes to function `Fn`, as `InferInput` has them. */
export type FunctionArgs<Fn extends AnyFunction> = InferInput<Fn["args"]>;

/** What function `Fn` returns, as `Infer` has it. */
export type FunctionReturn<Fn extends AnyFunction> = Infer<Fn["returns"]>;

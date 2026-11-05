import { usesMaxEntries } from "@grasp-os/shared/operation-limits";

import type { DatabaseReader, DatabaseWriter } from "./database.ts";
import type { PeopleDirectory, User } from "./people.ts";
import { isPermission, isWorkflowPermission } from "./permissions.ts";
import type {
  AiClient,
  AiPermission,
  AnyPermission,
  AppClientOf,
  AppPermission,
  BrainClientOf,
  BrainPermission,
  ConnectionClientOf,
  ConnectionPermission,
  GuestsClientOf,
  GuestsPermission,
  WorkflowPermission,
} from "./permissions.ts";
import { eventReferenceData, referenceName } from "./references.ts";
import type {
  ArgsOf,
  Callable,
  EventDataOf,
  ReferenceKind,
  ReferenceVisibility,
  ReturnOf,
  SingleAnswer,
  WorkflowEventReference,
} from "./references.ts";
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
// by exporting it from a module under `server/` (app.ts), and the host runs it, validating the
// arguments it is called with and what it returns against the declared
// schemas, which it holds as descriptors, never trusting App code to.
//
// What a handler can do is what its context has, and the three differ on
// purpose:
// - a query reads (`ctx.db` reads only), and has nothing to write with or
//   call out through: no `uses`;
// - a mutation reads and stages writes (`ctx.db`), which commit together
//   after it returns, and may run the App's queries in the same staged
//   state (`ctx.runQuery`); it has no resources, so no network, and the
//   only thing it starts is a workflow it lists, after it commits
//   (`ctx.afterCommit.start`), as part of that commit, and the only event
//   it sends is one it lists, to a run of the App's own, likewise
//   (`ctx.notify`, spec 10.7.4); it tells people only once it commits,
//   likewise (`ctx.afterCommit.notifyPeople`);
// - an action has no `db` at all: it composes the App's functions
//   (`runQuery`, `runMutation`, `runAction`), each its own invocation,
//   and reaches outside the App only through the permissions its `uses`
//   lists (`ctx.ai`, `ctx.connections`, `ctx.brain`, `ctx.apps`,
//   `ctx.guests`), starts only the workflows it lists (`ctx.workflows`),
//   and tells people through the platform's notifications
//   (`ctx.notifyPeople`).
// The host enforces each of these again at run time, whatever App code
// sends it; the types here make the mistakes fail to compile first.
//
// The constructors are specialized to the App's schema by `serverModule`,
// which the generated `server/_generated/server` module calls; an author never
// writes their generics. There is no `input`/`output` form, no `reads` or
// `writes` list and no `ctx.data`: the superseded shapes of spec 7 are
// refused, not aliased.
//
// Adapted from Baseflare's server function constructors (MIT, © 2026
// Baseflare contributors: packages/baseflare/src/server/functions), with
// Grasp's mandatory returns, strict keys and capability-free actions.

/** The three kinds of server function. */
export type FunctionKind = ReferenceKind;

/** Who may call a function directly: anyone allowed, or the App's own code. */
export type Visibility = ReferenceVisibility;

/** A schema's tables, by name. */
type AnyTables = Readonly<Record<string, AnyTable>>;

/**
 * A function as callers type it: its kind, visibility, arguments (as a
 * caller passes them and as the handler gets them) and return. A
 * definition is one, and so is the reference generated for it (spec 8):
 * the phantom members carry inference only and are never set.
 */
export type FunctionReference<
  Kind extends FunctionKind = FunctionKind,
  Vis extends Visibility = Visibility,
  ArgsIn = unknown,
  Return = unknown,
  Progress = unknown,
> = Callable<Kind, Vis, ArgsIn, Return, Progress>;

/** Any function reference: its phantom members are only ever read. */
export type AnyReference = FunctionReference;

export type { ArgsOf, ReturnOf } from "./references.ts";

/**
 * What a function's `uses` may list: functions of the App, permissions,
 * the workflows it starts, and the events of the App's workflows it
 * notifies runs of (`workflows.<workflow>.events.<alias>`, a mutation's
 * only).
 */
export type Use = AnyReference | AnyPermission | AnyWorkflow | AnyWorkflowEvent;

/** Any generated event reference, whatever its data. */
export type AnyWorkflowEvent = WorkflowEventReference<
  string,
  string,
  string,
  // oxlint-disable-next-line typescript/no-explicit-any -- the data is only read, by `EventDataOf`
  any
>;

/** The event references among `Uses`. */
type UsedEvent<Uses extends readonly Use[]> = Extract<
  Uses[number],
  AnyWorkflowEvent
>;

/**
 * `ctx.notify`: stages the event `event` (one `Uses` lists) for run
 * `runId` of its workflow, with `data` as that event declares it, never
 * inferred from the call.
 */
type Notify<Uses extends readonly Use[]> = <Event extends UsedEvent<Uses>>(
  event: Event,
  notification: {
    readonly runId: string;
    readonly data: NoInfer<EventDataOf<Event>>;
  }
) => void;

/** Any workflow declaration, whatever its input. */
// oxlint-disable-next-line typescript/no-explicit-any -- the input is only read, by `WorkflowInput`
export type AnyWorkflow = WorkflowPermission<string, any>;

/** The workflows among `Uses`. */
type UsedWorkflow<Uses extends readonly Use[]> = Extract<
  Uses[number],
  AnyWorkflow
>;

/** The input a caller starts workflow `Workflow` with. */
export type WorkflowInput<Workflow> =
  Workflow extends WorkflowPermission<string, infer Input> ? Input : never;

/**
 * A workflow start the host admitted: durable from the moment it resolves,
 * whatever happens to the caller next. It doesn't wait for the run.
 */
export interface RunHandle {
  /**
   * The start's receipt: the same for every attempt of the same start (an
   * action called again under the same idempotency key).
   */
  readonly startId: string;
  /** The run executing it. */
  readonly runId: string;
  /** The version of the workflow it started: the one its alias binds. */
  readonly version: number;
}

/**
 * What a start of `Workflow` takes: its input, which may be left out where
 * the input schema takes none (its default, say).
 */
type StartArgs<Workflow> =
  undefined extends WorkflowInput<Workflow>
    ? [input?: WorkflowInput<Workflow>]
    : [input: WorkflowInput<Workflow>];

/**
 * `ctx.workflows` (and a mutation's `ctx.afterCommit.workflows`): each
 * workflow `Uses` lists, by its alias, started with its input, answering
 * `Started`.
 */
export type Workflows<Uses extends readonly Use[], Started> = {
  readonly [Workflow in UsedWorkflow<Uses> as Workflow["alias"]]: {
    readonly start: (...input: StartArgs<Workflow>) => Promise<Started>;
  };
};

/**
 * What App code tells people (`ctx.notifyPeople`,
 * `ctx.afterCommit.notifyPeople`): a
 * notification in their Grasp inbox that opens the App.
 */
export interface PeopleNotification {
  /** At most 120 characters. */
  readonly title: string;
  /** At most 1000 characters. */
  readonly body?: string;
  /**
   * The App's screen it opens on, by name (`"orders"`); the App's first
   * when it names none, or one the App doesn't have. Never a URL.
   */
  readonly link?: string;
}

/**
 * What a send did: how many people it told. Never who, nor how many it
 * skipped.
 */
export interface NotifyReceipt {
  readonly delivered: number;
}

/**
 * Tells `to` (a person's ID or a team's: each of its members) about
 * something in the App, in their Grasp notifications. Only people in the
 * organization who can open the App are told; anyone else is skipped,
 * never refused. Bounded: a title and body within their limits,
 * at most 50 people a send, and an App sends at most 200 notifications an
 * hour, all its calls together (`resource.limit_reached` past it, the
 * whole send refused). Each send is audited, with how many it told and
 * skipped, never what it said. A call a visitor makes, or one from a
 * workflow's run, tells nobody (`resource.unavailable`).
 */
type NotifyPeople<Told> = (
  to: string,
  notification: PeopleNotification
) => Promise<Told>;

/**
 * `ctx.afterCommit`: what a mutation hands on once it commits, as part of
 * its commit, so nothing is handed on for a mutation that doesn't.
 */
export interface AfterCommit<Uses extends readonly Use[]> {
  /**
   * Each workflow `Uses` lists, by alias: `start(input)` starts it once
   * the mutation has committed, staged with its writes, in the same
   * transaction, and started from the store's outbox exactly once. A
   * mutation that fails, is rolled back or is superseded starts nothing.
   */
  readonly workflows: Workflows<Uses, void>;
  /**
   * Tells people about what the mutation did, once it has committed
   * (`NotifyPeople`): checked as it is staged (`resource.invalid_args`
   * for a title or body past its limit), staged with its writes and sent
   * from the store's outbox exactly once. Whom it reaches, and the App's
   * hourly limit, are decided as it is sent: one past the limit then is
   * dropped, and audited. A mutation that fails, is rolled back or is
   * superseded tells nobody. Not `ctx.notify`, which sends a workflow's
   * run an event.
   */
  readonly notifyPeople: NotifyPeople<void>;
}

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

/**
 * `ctx.runAction`: one of the actions `Uses` lists that answers once. A
 * streaming one isn't callable here: its progress has no one to go to.
 */
type RunAction<Uses extends readonly Use[]> = <
  Reference extends UsedOfKind<Uses, "action">,
>(
  reference: SingleAnswer<Reference>,
  args: ArgsOf<Reference>
) => Promise<ReturnOf<Reference>>;

/** `Value` under `Key`, or nothing at all when it is `never`. */
type Present<Key extends string, Value> = [Value] extends [never]
  ? unknown
  : Readonly<Record<Key, Value>>;

/** The `ai` permission among `Uses`, as `ctx.ai`. */
type AiOf<Uses extends readonly Use[]> = [
  Extract<Uses[number], AiPermission>,
] extends [never]
  ? never
  : AiClient;

/**
 * What an action reaches through the permissions its `Uses` lists, each
 * only when listed: `ai`, `brain` and `guests`, and the connections and
 * other Apps by alias.
 */
export type PermissionClients<Uses extends readonly Use[]> = {
  /** Each connection `Uses` lists, by alias. */
  readonly connections: {
    readonly [
      Connection in Extract<
        Uses[number],
        ConnectionPermission
      > as Connection["alias"]
    ]: ConnectionClientOf<Connection>;
  };
  /** Each other App `Uses` lists, by alias (the platform's: `grasp`). */
  readonly apps: {
    readonly [
      Called in Extract<Uses[number], AppPermission> as Called["alias"]
    ]: AppClientOf<Called>;
  };
} & Present<"ai", AiOf<Uses>> &
  Present<"brain", BrainClientOf<Extract<Uses[number], BrainPermission>>> &
  Present<"guests", GuestsClientOf<Extract<Uses[number], GuestsPermission>>>;

/** `ctx.auth`: who the call is for, as Convex's `ctx.auth` answers it. */
export interface Auth {
  /**
   * Who the call is for (`User`): their ID, name, address and roles in
   * the App (`builder`, `user`; none for a visitor the App was shared
   * with, whose `id` is their session's: key a visitor by `email`). A
   * workflow run's call is for the person the run acts for. Read once as
   * the call starts, from core's own record of who is signed in.
   */
  readonly getUser: () => Promise<User>;
}

/**
 * What every handler has, whatever its kind: who is calling, and the
 * organization's people (people.ts). Both come from core's own record of
 * who is signed in, never from the caller's request.
 */
export interface CallerCtx {
  readonly auth: Auth;
  /**
   * The organization's members, read-only, for an App that declares it
   * (`app({ permissions: { people: true } })`; `permission.denied` otherwise): by ID, by
   * name or email, or by team, at most 100 a read, each with only their
   * name, email and teams. A visitor's call is refused it
   * (`visitor.not_granted`).
   */
  readonly people: PeopleDirectory;
}

/** What a query's handler has: reads, and nothing else. */
export interface QueryCtx<Tables extends AnyTables> extends CallerCtx {
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
> extends CallerCtx {
  readonly db: DatabaseWriter<Tables>;
  readonly runQuery: RunQuery<Uses>;
  readonly afterCommit: AfterCommit<Uses>;
  /**
   * Notifies run `runId` of one of the App's workflows with an event its
   * `uses` lists (spec 10.7.4): staged with the mutation's writes, in the
   * same transaction, and delivered to the run's inbox from the store's
   * outbox after the commit, once. The host checks the run, the data and
   * the App's grant to send as the mutation runs, and fails the mutation
   * if any doesn't hold; a mutation that fails, is rolled back or is
   * superseded notifies nothing. Its success is the local commit, never
   * the run taking the event, which the host checks again as it delivers.
   */
  readonly notify: Notify<Uses>;
}

/**
 * What an action's handler has besides its permissions
 * (`PermissionClients`): the functions it `uses`, its workflows and the
 * platform's notifications.
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
export interface ActionBaseCtx<
  Uses extends readonly Use[] = readonly [],
> extends CallerCtx {
  readonly runQuery: RunQuery<Uses>;
  readonly runMutation: RunMutation<Uses>;
  readonly runAction: RunAction<Uses>;
  /**
   * Each workflow its `uses` lists, by alias: `start(input)` resolves once
   * the host has admitted the start durably, not once the run ends.
   * Called again under the same idempotency key, the action gets the same
   * start back, matched by its place among the action's starts, as its
   * mutations and permission requests are by theirs. Keep that order a
   * function of the input: starts made at once, in whichever order they
   * happen to land (`Promise.race`), can swap places on the second call.
   */
  readonly workflows: Workflows<Uses, RunHandle>;
  /**
   * Tells people now (`NotifyPeople`), resolving once they are told: how
   * many were. Called again under the same idempotency key, it tells
   * nobody twice, matched by its place among the action's sends. Keep that
   * order a function of the input, and await sends one at a time: sends
   * made at once, in whichever order they happen to land, can swap places
   * on the second call and tell people twice.
   */
  readonly notifyPeople: NotifyPeople<NotifyReceipt>;
}

/**
 * What an action's handler has: the functions, permissions and workflows
 * it `uses`. No database: what it reads and writes goes through the App's
 * queries and mutations, each committed on its own.
 */
export type ActionCtx<Uses extends readonly Use[] = readonly []> =
  ActionBaseCtx<Uses> & PermissionClients<Uses>;

/**
 * What a streaming action's handler has (spec 10.7.6): an action's
 * context, and `emit`.
 */
export type StreamActionCtx<
  Uses extends readonly Use[] = readonly [],
  Progress = unknown,
> = ActionCtx<Uses> & StreamEmit<Progress>;

/** A streaming action's `emit`. */
export interface StreamEmit<Progress> {
  /**
   * Publishes `progress` as the action's latest snapshot, for the screen
   * that runs it: validated against the action's `stream` schema, and no
   * larger than an operation's result. Each snapshot is complete, so the
   * host may skip one a slow screen hasn't read yet for a newer one: emit
   * the whole state (the text so far), never a delta, and keep critical
   * events in a mutation or a workflow, never in progress. Rejects once
   * the action is cancelled or has ended (`operation.cancelled`,
   * `operation.ended`).
   */
  readonly emit: (progress: Progress) => Promise<void>;
}

/**
 * What a handler may answer, `Returns` the schema its declaration gives
 * (`undefined` where it gives none): what the schema infers, or anything,
 * which the host checks as JSON only (spec 32.6). One signature for both,
 * as Convex's: a wrong answer is then reported where it is, not as no
 * overload matching.
 */
type ResultFor<Returns extends AnySchema | undefined> =
  Returns extends AnySchema ? Infer<Returns> : unknown;

/** What a function answers: its `returns` schema's, or its handler's. */
type Declared<
  Returns extends AnySchema | undefined,
  Result,
> = Returns extends AnySchema ? Infer<Returns> : Result;

/**
 * A declared server function, as the App registers it. `Return` is what
 * it answers: what its `returns` schema infers, or, where it declares
 * none, what its handler answers.
 */
export interface ServerFunction<
  Kind extends FunctionKind,
  Vis extends Visibility,
  Shape extends ValueShape,
  Return,
  Ctx,
  Stream extends AnySchema | null = null,
> extends Callable<
  Kind,
  Vis,
  ObjectInput<Shape>,
  Return,
  Stream extends AnySchema ? Infer<Stream> : never
> {
  readonly kind: Kind;
  readonly visibility: Vis;
  readonly args: ObjectSchema<Shape>;
  /** Its `returns` schema, which the host checks its answers against; null where it declares none. */
  readonly returns: AnySchema | null;
  readonly uses: readonly Use[];
  /** An action's progress snapshots (spec 10.7.6), or null. */
  readonly stream: Stream;
  readonly handler: (ctx: Ctx, args: ObjectOutput<Shape>) => unknown;
}

/**
 * Any declared server function. Its handler takes nothing it could be
 * called with: only the runner calls it, with the context of its kind.
 */
export interface AnyFunction extends FunctionReference {
  readonly kind: FunctionKind;
  readonly visibility: Visibility;
  readonly args: AnySchema;
  readonly returns: AnySchema | null;
  readonly uses: readonly Use[];
  readonly stream: AnySchema | null;
  readonly handler: (ctx: never, args: never) => unknown;
}

/** A query's declaration. */
export interface QueryDefinition<
  Tables extends AnyTables,
  Shape extends ValueShape,
  Returns extends AnySchema | undefined,
  Result,
> {
  readonly args: Shape;
  /** What it answers; without it, what its handler answers. */
  readonly returns?: Returns;
  readonly handler: (
    ctx: QueryCtx<Tables>,
    args: ObjectOutput<Shape>
  ) => Result | Promise<Result>;
}

/** A mutation's declaration. */
export interface MutationDefinition<
  Tables extends AnyTables,
  Shape extends ValueShape,
  Returns extends AnySchema | undefined,
  Result,
  Uses extends readonly Use[],
> {
  readonly args: Shape;
  /** What it answers; without it, what its handler answers. */
  readonly returns?: Returns;
  /**
   * The queries it runs, the workflows it starts and the events it
   * notifies runs of; none unless listed.
   */
  readonly uses?: Uses;
  readonly handler: (
    ctx: MutationCtx<Tables, Uses>,
    args: ObjectOutput<Shape>
  ) => Result | Promise<Result>;
}

/** An action's declaration. */
export interface ActionDefinition<
  Shape extends ValueShape,
  Returns extends AnySchema | undefined,
  Result,
  Uses extends readonly Use[],
> {
  readonly args: Shape;
  /** What it answers; without it, what its handler answers. */
  readonly returns?: Returns;
  /** The functions, permissions and workflows it calls; none unless listed. */
  readonly uses?: Uses;
  /** Declared only by a streaming action (`StreamActionDefinition`). */
  readonly stream?: undefined;
  readonly handler: (
    ctx: ActionCtx<Uses>,
    args: ObjectOutput<Shape>
  ) => Result | Promise<Result>;
}

/**
 * A streaming action's declaration (spec 10.7.6): an action's, and the
 * schema of the progress snapshots its handler emits (`ctx.emit`). It
 * runs only in the foreground, for a screen following it (`useStream`).
 */
export interface StreamActionDefinition<
  Shape extends ValueShape,
  Returns extends AnySchema | undefined,
  Result,
  Uses extends readonly Use[],
  Stream extends AnySchema,
> {
  readonly args: Shape;
  /** What it answers; without it, what its handler answers. */
  readonly returns?: Returns;
  /** The functions, permissions and workflows it calls; none unless listed. */
  readonly uses?: Uses;
  /** Its progress snapshots: each one whole, bounded like a result. */
  readonly stream: Stream;
  readonly handler: (
    ctx: StreamActionCtx<Uses, Infer<Stream>>,
    args: ObjectOutput<Shape>
  ) => Result | Promise<Result>;
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
    if (
      !isServerFunction(use) &&
      !isPermission(use) &&
      !isWorkflowPermission(use) &&
      referenceName(use) === undefined &&
      eventReferenceData(use) === undefined
    ) {
      return refuse(
        "`uses` lists the App's server functions, their generated references, `permission` declarations and its workflows' generated event references, never IDs or names."
      );
    }
    // SAFETY: one of those just checked: a definition, a permission or
    // workflow declaration, or a function reference read as data.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    checked.push(use as Use);
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
  // Optional: without it, the handler's answer is its return (spec 32.6).
  // Throws for anything but a `v` schema.
  if (returns !== undefined) {
    descriptorOf(returns);
  }
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
    returns: (returns ?? null) as AnySchema | null,
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

/**
 * `action` and `internalAction`: a streaming action when the declaration
 * has `stream` (its handler's context has `emit`), any other otherwise.
 */
export interface ActionConstructor<Vis extends Visibility> {
  <
    const Shape extends ValueShape,
    Stream extends AnySchema,
    Returns extends AnySchema | undefined = undefined,
    Result extends ResultFor<Returns> = ResultFor<Returns>,
    const Uses extends readonly Use[] = readonly [],
  >(
    declaration: StreamActionDefinition<Shape, Returns, Result, Uses, Stream>
  ): ServerFunction<
    "action",
    Vis,
    Shape,
    Declared<Returns, Result>,
    StreamActionCtx<Uses, Infer<Stream>>,
    Stream
  >;
  <
    const Shape extends ValueShape,
    Returns extends AnySchema | undefined = undefined,
    Result extends ResultFor<Returns> = ResultFor<Returns>,
    const Uses extends readonly Use[] = readonly [],
  >(
    declaration: ActionDefinition<Shape, Returns, Result, Uses>
  ): ServerFunction<
    "action",
    Vis,
    Shape,
    Declared<Returns, Result>,
    ActionCtx<Uses>
  >;
}

/** `query` and `internalQuery`. */
export type QueryConstructor<
  Tables extends AnyTables,
  Vis extends Visibility,
> = <
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
export type MutationConstructor<
  Tables extends AnyTables,
  Vis extends Visibility,
> = <
  const Shape extends ValueShape,
  Returns extends AnySchema | undefined = undefined,
  Result extends ResultFor<Returns> = ResultFor<Returns>,
  const Uses extends readonly Use[] = readonly [],
>(
  declaration: MutationDefinition<Tables, Shape, Returns, Result, Uses>
) => ServerFunction<
  "mutation",
  Vis,
  Shape,
  Declared<Returns, Result>,
  MutationCtx<Tables, Uses>
>;

/** The server constructors and `doc`, specialized to one schema. */
export interface ServerModule<Tables extends AnyTables> {
  readonly query: QueryConstructor<Tables, "public">;
  readonly internalQuery: QueryConstructor<Tables, "internal">;
  readonly mutation: MutationConstructor<Tables, "public">;
  readonly internalMutation: MutationConstructor<Tables, "internal">;
  readonly action: ActionConstructor<"public">;
  readonly internalAction: ActionConstructor<"internal">;
  /**
   * The schema of a whole record of `table` under this schema: its
   * managed fields and its declared fields, for a function's `returns`.
   */
  readonly doc: <TableName extends keyof Tables & string>(
    table: TableName
  ) => ObjectSchema<ManagedShape<TableName> & Tables[TableName]["fields"]>;
}

/**
 * The server constructors for `schema`: what the generated `server/_generated/server`
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

/** What function `Fn` returns: its `returns` schema's, or its handler's. */
export type FunctionReturn<Fn extends AnyFunction> = ReturnOf<Fn>;

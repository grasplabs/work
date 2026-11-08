import type { Grant, Notify, RunHandle, Workflows } from "./ctx-workflows.ts";
import type { DatabaseReader } from "./database-reader.ts";
import type { DatabaseWriter } from "./database-writer.ts";
import type { ArgsOf, ReturnOf, SingleAnswer } from "./function-references.ts";
import type { PeopleDirectory, User } from "./people.ts";
import type {
  AiClient,
  BrainClientOf,
  ConnectionClientOf,
  GuestsClientOf,
  GraspClient,
} from "./permission-clients.ts";
import type {
  AiPermission,
  BrainPermission,
  ConnectionPermission,
  GraspPermission,
  GuestsPermission,
} from "./permission-types.ts";
import type { AnyTables, FunctionReference } from "./server-function.ts";

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
interface AfterCommit<Grants extends Grant> {
  /**
   * Each of the App's workflows, by alias: `start(input)` starts it once
   * the mutation has committed, staged with its writes, in the same
   * transaction, and started from the store's outbox exactly once. A
   * mutation that fails, is rolled back or is superseded starts nothing.
   */
  readonly workflows: Workflows<Grants, void>;
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

/**
 * `ctx.runQuery`: one of the App's queries, public or internal, by its
 * reference (`api.…`, `internal.…`), with its arguments.
 */
type RunQuery = <Reference extends FunctionReference<"query">>(
  reference: Reference,
  args: ArgsOf<Reference>
) => Promise<ReturnOf<Reference>>;

/** `ctx.runMutation`: one of the App's mutations. */
type RunMutation = <Reference extends FunctionReference<"mutation">>(
  reference: Reference,
  args: ArgsOf<Reference>
) => Promise<ReturnOf<Reference>>;

/**
 * `ctx.runAction`: one of the App's actions that answers once. A
 * streaming one isn't callable here: its progress has no one to go to.
 */
type RunAction = <Reference extends FunctionReference<"action">>(
  reference: SingleAnswer<Reference>,
  args: ArgsOf<Reference>
) => Promise<ReturnOf<Reference>>;

/** `Value` under `Key`, or nothing at all when it is `never`. */
type Present<Key extends string, Value> = [Value] extends [never]
  ? unknown
  : Readonly<Record<Key, Value>>;

/** The `ai` permission among `Grants`, as `ctx.ai`. */
type AiOf<Grants extends Grant> = [Extract<Grants, AiPermission>] extends [
  never,
]
  ? never
  : AiClient;

/**
 * What an action reaches through the App's permissions (`Grants`), each
 * only when declared: `ai`, `brain`, `grasp` (the platform's own
 * functions) and `guests`, and the connections by alias.
 */
type PermissionClients<Grants extends Grant> = {
  /** Each of the App's connections, by alias. */
  readonly connections: {
    readonly [
      Connection in Extract<Grants, ConnectionPermission> as Connection["alias"]
    ]: ConnectionClientOf<Connection>;
  };
} & Present<"ai", AiOf<Grants>> &
  Present<
    "grasp",
    [Extract<Grants, GraspPermission>] extends [never] ? never : GraspClient
  > &
  Present<"brain", BrainClientOf<Extract<Grants, BrainPermission>>> &
  Present<"guests", GuestsClientOf<Extract<Grants, GuestsPermission>>>;

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
 * together once it returns, and the App's queries, run in the same staged
 * state.
 */
export interface MutationCtx<
  Tables extends AnyTables,
  Grants extends Grant = never,
> extends CallerCtx {
  readonly db: DatabaseWriter<Tables>;
  readonly runQuery: RunQuery;
  readonly afterCommit: AfterCommit<Grants>;
  /**
   * Notifies run `runId` of one of the App's workflows with one of its
   * events: staged with the mutation's writes, in the
   * same transaction, and delivered to the run's inbox from the store's
   * outbox after the commit, once. The host checks the run, the data and
   * the App's grant to send as the mutation runs, and fails the mutation
   * if any doesn't hold; a mutation that fails, is rolled back or is
   * superseded notifies nothing. Its success is the local commit, never
   * the run taking the event, which the host checks again as it delivers.
   */
  readonly notify: Notify<Grants>;
}

/**
 * What an action's handler has besides the App's permissions
 * (`PermissionClients`): the App's functions, its workflows and the
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
interface ActionBaseCtx<Grants extends Grant = never> extends CallerCtx {
  readonly runQuery: RunQuery;
  readonly runMutation: RunMutation;
  readonly runAction: RunAction;
  /**
   * Each of the App's workflows, by alias: `start(input)` resolves once
   * the host has admitted the start durably, not once the run ends.
   * Called again under the same idempotency key, the action gets the same
   * start back, matched by its place among the action's starts, as its
   * mutations and permission requests are by theirs. Keep that order a
   * function of the input: starts made at once, in whichever order they
   * happen to land (`Promise.race`), can swap places on the second call.
   */
  readonly workflows: Workflows<Grants, RunHandle>;
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
 * What an action's handler has: the App's functions, permissions and
 * workflows. No database: what it reads and writes goes through the App's
 * queries and mutations, each committed on its own.
 */
export type ActionCtx<Grants extends Grant = never> = ActionBaseCtx<Grants> &
  PermissionClients<Grants>;

/**
 * What a streaming action's handler has: an action's
 * context, and `emit`.
 */
export type StreamActionCtx<
  Grants extends Grant = never,
  Progress = unknown,
> = ActionCtx<Grants> & StreamEmit<Progress>;

/** A streaming action's `emit`. */
interface StreamEmit<Progress> {
  /**
   * Publishes `progress` as the action's latest snapshot, for the page
   * that runs it: validated against the action's `stream` schema, and no
   * larger than an operation's result. Each snapshot is complete, so the
   * host may skip one a slow page hasn't read yet for a newer one: emit
   * the whole state (the text so far), never a delta, and keep critical
   * events in a mutation or a workflow, never in progress. Rejects once
   * the action is cancelled or has ended (`function.cancelled`,
   * `function.ended`).
   */
  readonly emit: (progress: Progress) => Promise<void>;
}

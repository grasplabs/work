import type { Json } from "@grasp-os/shared/json";

import type { DatabaseWriter } from "./database-writer.ts";
import type {
  FunctionArgs,
  Callable,
  ReferenceKind,
  FunctionReturn,
  SingleAnswer,
} from "./function-references.ts";
import type { SchemaDefinition } from "./schema-types.ts";
import type { AnyTables } from "./server-function.ts";
import type {
  AnyWorkflowReference,
  WorkflowArgsOf,
  WorkflowReturnOf,
} from "./workflow-references.ts";

/** A public function of the App, as `@server/_generated/api` generates its reference. */
export type PublicReference<Kind extends ReferenceKind> = Callable<
  Kind,
  "public"
> & { readonly name: string };

/**
 * A live query an identity follows (`subscribe`), as a page follows
 * one: core reads it again after every write that changed what it read,
 * as the identity, and pushes each result in order.
 */
export interface LiveQuery<Value> {
  /**
   * The next snapshot that `predicate` accepts (the next one, without a
   * predicate), passing over those it doesn't. Waits no longer than the
   * test may run. Fails on a refusal core pushes, such as
   * `function.not_found`, and once core stops following the query.
   */
  next: (predicate?: (value: Value) => boolean) => Promise<Value>;
  /** Stops following it: core releases its subscription. */
  close: () => Promise<void>;
}

/** Who a test acts as (`t.withIdentity`). */
export interface TestIdentityFields {
  /**
   * Their name, as `ctx.auth.getUser()` answers it: the same name in one
   * test is the same person.
   */
  readonly name: string;
  /** Their role in the App: `user` unless said. */
  readonly role?: "user" | "builder";
  /**
   * The teams they are in, by team ID, as a table's `team` row rules
   * match them: none unless said.
   */
  readonly teams?: readonly string[];
}

/** `ctx` of `t.run`: the App's tables, read and written directly. */
export interface TestRunContext<Tables extends AnyTables> {
  readonly db: DatabaseWriter<Tables>;
}

/**
 * Runs `fn` with `ctx.db` on the test's store as one transaction, which
 * commits once `fn` returns, as a mutation's does, and commits nothing if
 * it throws. The App's access modes and row rules don't apply: a test
 * seeds and inspects whatever it needs to. Answers what `fn` returns.
 */
export type TestRun<Tables extends AnyTables> = <Value>(
  fn: (ctx: TestRunContext<Tables>) => Value | Promise<Value>
) => Promise<Value>;

/** What a test gives a run it starts (`identity.start`), beside its args. */
export interface TestStartOptions {
  /**
   * The workflow's parameter values: a parameter not named takes its
   * declared default, never the organization's own value.
   */
  readonly params?: Readonly<Record<string, Json>>;
  /**
   * What each of its model bindings answers, by the binding's alias: no
   * model is ever asked. A model call whose binding is given nothing
   * fails the run (`workflow.test_unfixtured`).
   */
  readonly models?: Readonly<Record<string, Json>>;
  /**
   * Who may answer each of its decisions, by the decision binding's
   * alias: identities of this test.
   */
  readonly deciders?: Readonly<Record<string, readonly TestIdentity[]>>;
  /**
   * A fault: once task `restartAfterStep`'s step is journaled the first
   * time, the run's activation ends there, as if its process died, and
   * the engine runs it again from its journal, a generation later.
   */
  readonly restartAfterStep?: string;
}

/**
 * Someone a test acts as (`t.withIdentity`). Each call goes to core,
 * which resolves the reference against the App's release as it resolves a
 * page's, and runs the function through the operation host, as them. A
 * call answers the function's value; a refusal rejects with the
 * `GraspError` a page's call gets, its `code` such as `note.not_found`.
 */
export interface TestIdentity<Tables extends AnyTables = AnyTables> {
  /** Calls one of the App's public queries. */
  query: <Reference extends PublicReference<"query">>(
    reference: Reference,
    args: FunctionArgs<Reference>
  ) => Promise<FunctionReturn<Reference>>;
  /** Calls one of the App's public mutations. */
  mutation: <Reference extends PublicReference<"mutation">>(
    reference: Reference,
    args: FunctionArgs<Reference>
  ) => Promise<FunctionReturn<Reference>>;
  /**
   * Calls one of the App's public actions. A test binds no resources, so
   * an action that reaches one is refused (`resource.unavailable`):
   * outside systems aren't the tests' to touch.
   */
  action: <Reference extends PublicReference<"action">>(
    // A streaming action runs only for a page following it, never through
    // a call that answers once: its type is refused here, as the host
    // refuses it (`function.mode_mismatch`), and so is a union any member
    // of which streams (not distributed).
    reference: SingleAnswer<Reference>,
    args: FunctionArgs<Reference>
  ) => Promise<FunctionReturn<Reference>>;
  /**
   * Follows one of the App's public queries, through the realtime
   * subscription a page follows one through. A test that doesn't
   * `close` it has it closed as it ends.
   */
  subscribe: <Reference extends PublicReference<"query">>(
    reference: Reference,
    args: FunctionArgs<Reference>
  ) => Promise<LiveQuery<FunctionReturn<Reference>>>;
  /**
   * Starts a run of one of the workflows the App binds (`workflows` from
   * `@server/_generated/api`), as a page's `useWorkflow` starts one: the
   * same version, run on the real engine, with nothing of the
   * organization's around it. Its model calls answer what `options.models`
   * gives; its calls of the App's functions run on this test's own store;
   * other calls that leave its own code (a connection's, the Brain's, an
   * action's) are refused (`resource.unavailable`). The run is removed as
   * the test ends.
   */
  start: <Reference extends AnyWorkflowReference>(
    reference: Reference,
    args: WorkflowArgsOf<Reference>,
    options?: TestStartOptions
  ) => Promise<WorkflowTestRun<WorkflowReturnOf<Reference>>>;
  /**
   * Answers the decision `run` waits for in its task `task` (a
   * `grasp.decision` call), as this identity: approved or declined, with
   * `value` as the decision's contract takes it. Waits for the run to ask
   * it, until the test's deadline; one already answered isn't waited on.
   * Only an identity the start named as a decider of its binding answers
   * it, and only once, while the run goes on: anything else is refused
   * (`decision.forbidden`, `decision.invalid`, `decision.closed`,
   * `decision.not_found`).
   */
  respond: (
    run: WorkflowTestRun,
    task: string,
    answer: TestDecisionAnswer
  ) => Promise<void>;
  /** As `t.run`, its inserts theirs. */
  run: TestRun<Tables>;
}

/** How a test identity answers a run's decision (`respond`). */
export interface TestDecisionAnswer {
  readonly approved: boolean;
  /** What the answer carries, as the decision's contract takes it. */
  readonly value?: Json;
  /**
   * For a task inside loops, which time the run asks it: `0` the first,
   * `1` the second, counting every time it asked, across all the loops
   * around it, as the run host counts a task's runs. Without it, the
   * task's latest decision.
   */
  readonly run?: number;
}

/**
 * A run a test identity started (`start`): its handle, for `t.runs` and
 * `t.effects`. Only the test that started it can ask about it.
 */
export interface WorkflowTestRun<Returns = unknown> {
  /** The workflow's registered path, such as `workflows.summarizeNote`. */
  readonly workflow: string;
  /** Types only: never set. */
  readonly result?: Returns;
}

/** How a test's run ended (`t.runs.untilTerminal`). */
export type TestRunOutcome<Returns = unknown> =
  | { readonly status: "completed"; readonly result: Returns }
  | {
      readonly status: "failed";
      /** A code the platform defines, in its own words: never the run's. */
      readonly code: string;
      readonly message: string;
    }
  | { readonly status: "cancelled" };

/** What a test asks of the runs it started. */
export interface TestRuns {
  /**
   * How `run` ended, once it has: completed with its result as the App
   * declares it (`returns`), failed with the platform's code and words
   * for why (never what the run read), or cancelled. Fails the test if
   * it hasn't ended by the test's own deadline.
   */
  untilTerminal: <Returns>(
    run: WorkflowTestRun<Returns>
  ) => Promise<TestRunOutcome<Returns>>;
}

/** What a test asks of the effects its runs made. */
export interface TestEffects {
  /**
   * How many times `run`'s task `task` completed its step, as the engine
   * recorded it: a step replayed after a restart counts once.
   */
  completedCount: (run: WorkflowTestRun, task: string) => Promise<number>;
  /**
   * How many model requests `run`'s task `task` made, as the test's model
   * provider counted them as it answered each, apart from the engine: a
   * step replayed from its journal asks again for none.
   */
  modelRequestCount: (run: WorkflowTestRun, task: string) => Promise<number>;
}

/** The time a test's runs see (`t.clock`). */
export interface TestClock {
  /**
   * Moves the time of this test's runs, those under way and those it
   * starts later, `ms` milliseconds on: a sleep, a wait's timeout or a
   * retry that comes due by then runs now, without waiting for it.
   */
  advance: (ms: number) => Promise<void>;
}

/** What each test of an `appTest` suite gets. */
export interface AppTestContext<Tables extends AnyTables = AnyTables> {
  /**
   * Someone with `role` in the App (`user` unless said), in `teams`. The
   * same name in one test is the same person: naming them again with
   * another role or other teams fails the test. At most 20 a test.
   */
  withIdentity: (identity: TestIdentityFields) => TestIdentity<Tables>;
  /**
   * Runs `fn` with `ctx.db` on the test's store, as one transaction: its
   * inserts belong to the test itself, which is nobody in the App.
   */
  run: TestRun<Tables>;
  /** The runs its identities started (`TestIdentity.start`). */
  runs: TestRuns;
  /** What those runs' steps did. */
  effects: TestEffects;
  /** The time its runs see. */
  clock: TestClock;
}

/** One test: what it does, through `t`. */
export type AppTestFunction<Tables extends AnyTables = AnyTables> = (
  t: AppTestContext<Tables>
) => Promise<void>;

/** An App's test suite, as `appTest` describes it. */
export interface AppTestSuite {
  readonly kind: "app";
  /** The App's schema, which `t.run`'s `ctx.db` reads and writes by. */
  readonly schema: SchemaDefinition;
  readonly tests: Readonly<Record<string, AppTestFunction>>;
}

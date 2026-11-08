import type { Json } from "@grasp-os/shared/json";

import type {
  AnyWorkflowReference,
  ArgsOf,
  Callable,
  ReferenceKind,
  ReturnOf,
  SingleAnswer,
  WorkflowInputOf,
  WorkflowOutputOf,
} from "./references.ts";

/** A public function of the App, as `@server/_generated/api` generates its reference. */
export type PublicReference<Kind extends ReferenceKind> = Callable<
  Kind,
  "public"
> & { readonly name: string };

/**
 * A live query a principal follows (`subscribe`), as a page follows
 * one: core reads it again after every write that changed what it read,
 * as the principal, and pushes each result in order.
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

/**
 * A fixture principal (`t.as`): someone with the role in the App the
 * suite's fixture gives them. Each call goes to core, which resolves the
 * reference against the App's release as it resolves a page's, and
 * runs the function through the operation host. A call answers the
 * function's value; a failure fails the test, unless the test expects it
 * with `t.rejectsCode`.
 */
export interface TestPrincipal {
  /** Calls one of the App's public queries. */
  query: <Reference extends PublicReference<"query">>(
    reference: Reference,
    args: ArgsOf<Reference>
  ) => Promise<ReturnOf<Reference>>;
  /** Calls one of the App's public mutations. */
  mutation: <Reference extends PublicReference<"mutation">>(
    reference: Reference,
    args: ArgsOf<Reference>
  ) => Promise<ReturnOf<Reference>>;
  /**
   * Calls one of the App's public actions. A fixture binds no resources,
   * so an action that reaches one is refused (`resource.unavailable`):
   * outside systems aren't the tests' to touch.
   */
  action: <Reference extends PublicReference<"action">>(
    // A streaming action runs only for a page following it (spec
    // 10.7.6), never through a call that answers once: its type is
    // refused here, as the host refuses it (`function.mode_mismatch`),
    // and so is a union any member of which streams (not distributed).
    reference: SingleAnswer<Reference>,
    args: ArgsOf<Reference>
  ) => Promise<ReturnOf<Reference>>;
  /**
   * Follows one of the App's public queries, through the realtime
   * subscription a page follows one through. A test that doesn't
   * `close` it has it closed as it ends.
   */
  subscribe: <Reference extends PublicReference<"query">>(
    reference: Reference,
    args: ArgsOf<Reference>
  ) => Promise<LiveQuery<ReturnOf<Reference>>>;
  /**
   * Starts a run of one of the workflows the App binds (`workflows` from
   * `@server/_generated/api`), as a page's `useWorkflow` starts one: the same version,
   * run on the real engine, with nothing of the organization's around it.
   * A model call answers what the fixture gives its binding
   * (`workflows.<alias>.models.<binding>`): no model is ever asked. A store
   * call runs the App's public query or mutation the fixture names for its
   * binding (`workflows.<alias>.operations.<binding>`) on this test's own
   * store, which the test's principals read too. A binding the fixture
   * gives nothing fails the run (`workflow.test_unfixtured`). Other calls
   * that leave its own code (a connection's, Knowledge's, an action's) are
   * refused (`resource.unavailable`). The run is removed as the test ends.
   */
  start: <Reference extends AnyWorkflowReference>(
    reference: Reference,
    input: WorkflowInputOf<Reference>
  ) => Promise<WorkflowTestRun<WorkflowOutputOf<Reference>>>;
  /**
   * Answers the decision `run` waits for in its task `task` (a
   * `grasp.decision` call), as this principal: approved or declined, with
   * `value` as the decision's contract takes it: inside loops, the item
   * `answer.at` names, else the task's latest. Waits for the run to ask it,
   * until the test's deadline; one already answered isn't waited on. Only
   * the principal it asks answers it, one the fixture lets answer through
   * its binding
   * (`workflows.<alias>.deciders`), and only once, while the run goes on:
   * anything else fails, as `t.rejectsCode` reads it (`decision.forbidden`,
   * `decision.invalid`, `decision.closed`, `decision.not_found`).
   */
  respond: (
    run: WorkflowTestRun,
    task: string,
    answer: TestDecisionAnswer
  ) => Promise<void>;
}

/** How a test principal answers a run's decision (`respond`). */
export interface TestDecisionAnswer {
  readonly approved: boolean;
  /** What the answer carries, as the decision's contract takes it. */
  readonly value?: Json;
  /**
   * For a task inside `for` loops, the item it asks for: each loop's
   * index, outermost first, such as `[1, 0]`. Without it, the task's
   * latest decision.
   */
  readonly at?: readonly number[];
}

/**
 * A run a test principal started (`start`): its handle, for `t.runs` and
 * `t.effects`. Only the test that started it can ask about it.
 */
export interface WorkflowTestRun<Output = unknown> {
  /** The workflow's registered path, such as `workflows.summarizeNote`. */
  readonly workflow: string;
  /** Types only: never set. */
  readonly output?: Output;
}

/** How a test's run ended (`t.runs.untilTerminal`). */
export type TestRunOutcome<Output = unknown> =
  | { readonly status: "completed"; readonly output: Output }
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
   * How `run` ended, once it has: completed with its output as the App
   * declares it, failed with the platform's code and words for why (never
   * what the run read), or cancelled. Fails the test if it
   * hasn't ended by the test's own deadline.
   */
  untilTerminal: <Output>(
    run: WorkflowTestRun<Output>
  ) => Promise<TestRunOutcome<Output>>;
}

/** What a test asks of the effects its runs made. */
export interface TestEffects {
  /**
   * How many times `run`'s task `task` completed its step, as the engine
   * recorded it: a step replayed after a restart counts once.
   */
  completedCount: (run: WorkflowTestRun, task: string) => Promise<number>;
}

/** What each test of an `appTest` suite gets. */
export interface AppTestContext {
  /**
   * The principal the suite's fixture (`tests/fixtures/<fixtures>.json`)
   * names `name`; the test fails if it names none. A fixture names each
   * one's App role and, for a table's `team` row rules, the teams they
   * are in: `{ "principals": { "ada": { "role": "user", "teams": ["sales"] } } }`.
   */
  as: (name: string) => Promise<TestPrincipal>;
  /**
   * Fails the test unless `actual` equals `expected` as JSON: the same
   * values, whatever order an object's keys are in.
   */
  equal: <Value>(actual: Value, expected: Value, message?: string) => void;
  /**
   * Fails the test unless `work` (a call, or a function that makes calls)
   * fails with error `code`, such as `note.not_found` or
   * `permission.denied`.
   */
  rejectsCode: (
    work: Promise<unknown> | (() => Promise<unknown>),
    code: string
  ) => Promise<void>;
}

/** One test: what it does, through `t`. */
export type AppTestFunction = (t: AppTestContext) => Promise<void>;

/** What `appTest` takes. */
export interface AppTestDefinition {
  /** The fixture the suite runs on: `tests/fixtures/<fixtures>.json`. */
  fixtures: string;
  /** Each test by its name, as people read it in a failure. */
  tests: Readonly<Record<string, AppTestFunction>>;
}

/** An App's test suite, as `appTest` describes it. */
export interface AppTestSuite {
  readonly kind: "app";
  readonly fixtures: string;
  readonly tests: Readonly<Record<string, AppTestFunction>>;
}

/** What each test of a `workflowTest` suite gets: `t`, with its runs. */
export interface WorkflowTestContext extends AppTestContext {
  /** The runs its principals started (`TestPrincipal.start`). */
  runs: TestRuns;
  /** What those runs' steps did, as the engine recorded it. */
  effects: TestEffects;
}

/** One workflow test: what it does, through `t`. */
export type WorkflowTestFunction = (t: WorkflowTestContext) => Promise<void>;

/** What `workflowTest` takes. */
export interface WorkflowTestDefinition {
  /** The fixture the suite runs on: `tests/fixtures/<fixtures>.json`. */
  fixtures: string;
  /** Each test by its name, as people read it in a failure. */
  tests: Readonly<Record<string, WorkflowTestFunction>>;
}

/** An App's suite of workflow tests, as `workflowTest` describes it. */
export interface WorkflowTestSuite {
  readonly kind: "workflow";
  readonly fixtures: string;
  readonly tests: Readonly<Record<string, WorkflowTestFunction>>;
}

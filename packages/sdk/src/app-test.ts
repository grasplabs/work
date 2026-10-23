// oxlint-disable max-classes-per-file -- a suite's own definition error, and the two failures a test can have, each a few lines
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import { messageOf } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";

import type {
  AnyWorkflowReference,
  ArgsOf,
  Callable,
  ReferenceKind,
  ReturnOf,
  StreamingFunction,
  WorkflowInputOf,
  WorkflowOutputOf,
} from "./references.ts";

// App tests (spec 28.2), as `@grasp-os/sdk/testing` exports them.
//
// `appTest` describes a suite and runs nothing itself. Core's trusted test
// runner loads an App's `tests/*.test.ts` in a sandboxed isolate, with the
// App's release and its generated `#grasp` references, and runs each suite
// with `runAppSuite` over a host it passes in: every call a test principal
// makes crosses back into core, which runs it through the real operation
// host on a fixture store of the test's own, as it runs a screen's call.
// Nothing here stands in for core; what a test asserts is what the App
// answered.

/** How a fixture or a principal is named: `notes`, `note-owner`. */
export const testNamePattern = /^[a-z][a-z0-9-]{0,63}$/u;

/** The most tests one suite holds. */
export const maxAppTests = 100;

/** The longest a test's name is, in characters. */
export const maxAppTestName = 200;

/**
 * How long one test may run before it fails, in milliseconds, its calls
 * included: they are real calls of the App's functions.
 */
export const appTestTimeoutMs = 30_000;

/** A public function of the App, as `#grasp` generates its reference. */
export type PublicReference<Kind extends ReferenceKind> = Callable<
  Kind,
  "public"
> & {
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly contractId: string;
  readonly fingerprint: string;
};

/**
 * The most snapshots a live query keeps that `next` hasn't taken: one
 * more fails the test.
 */
export const maxBufferedSnapshots = 100;

/**
 * A live query a principal follows (`subscribe`), as a screen follows
 * one: core reads it again after every write that changed what it read,
 * as the principal, and pushes each result in order.
 */
export interface LiveQuery<Value> {
  /**
   * The next snapshot that `predicate` accepts (the next one, without a
   * predicate), passing over those it doesn't. Waits no longer than the
   * test may run. Fails on a refusal core pushes, such as
   * `operation.not_found`, and once core stops following the query.
   */
  next: (predicate?: (value: Value) => boolean) => Promise<Value>;
  /** Stops following it: core releases its subscription. */
  close: () => Promise<void>;
}

/**
 * A fixture principal (`t.as`): someone with the role in the App the
 * suite's fixture gives them. Each call goes to core, which resolves the
 * reference against the App's release as it resolves a screen's, and
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
    // A streaming action runs only for a screen following it (spec
    // 10.7.6), never through a call that answers once: its type is
    // refused here, as the host refuses it (`operation.mode_mismatch`),
    // and so is a union any member of which streams (not distributed).
    reference: Reference &
      ([Extract<Reference, StreamingFunction>] extends [never]
        ? unknown
        : never),
    args: ArgsOf<Reference>
  ) => Promise<ReturnOf<Reference>>;
  /**
   * Follows one of the App's public queries, through the realtime
   * subscription a screen follows one through. A test that doesn't
   * `close` it has it closed as it ends.
   */
  subscribe: <Reference extends PublicReference<"query">>(
    reference: Reference,
    args: ArgsOf<Reference>
  ) => Promise<LiveQuery<ReturnOf<Reference>>>;
  /**
   * Starts a run of one of the workflows the App binds (`workflows` from
   * `#grasp`), as a screen's `useWorkflow` starts one: the same version,
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
   * names `name`; the test fails if it names none.
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

/** A suite declared wrong: says what to fix. */
export class TestDefinitionError extends Error {
  override name = "TestDefinitionError";
}

const refuseSuite: (message: string) => never = (message) => {
  throw new TestDefinitionError(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The suite `definition` declares, as `kind`, checked and frozen. */
const readSuite = <Test extends AppTestFunction | WorkflowTestFunction>(
  definition: unknown,
  kind: "app" | "workflow"
): {
  kind: "app" | "workflow";
  fixtures: string;
  tests: Readonly<Record<string, Test>>;
} => {
  if (!isRecord(definition)) {
    return refuseSuite(
      `${kind === "app" ? "appTest" : "workflowTest"} takes { fixtures, tests }.`
    );
  }
  const { fixtures, tests } = definition;
  if (typeof fixtures !== "string" || !testNamePattern.test(fixtures)) {
    return refuseSuite(
      "`fixtures` names a fixture in tests/fixtures/, such as `notes`: lowercase letters, digits and hyphens, starting with a letter."
    );
  }
  if (!isRecord(tests)) {
    return refuseSuite("`tests` maps each test's name to its function.");
  }
  // Defined, never assigned: a test named `__proto__` is a test, not a
  // new prototype that would drop it.
  const checked: Record<string, Test> = {};
  for (const [name, test] of Object.entries(tests)) {
    if (name.trim() === "" || name.length > maxAppTestName) {
      return refuseSuite(
        `A test's name is between 1 and ${maxAppTestName} characters.`
      );
    }
    if (typeof test !== "function") {
      return refuseSuite(`Test "${name}" isn't a function.`);
    }
    // A function, checked just above; what it does with `t` is the test's
    // own, and a failure is reported as the test's.
    Object.defineProperty(checked, name, {
      value: test,
      enumerable: true,
    });
  }
  const count = Object.keys(checked).length;
  if (count === 0 || count > maxAppTests) {
    return refuseSuite(
      `A suite has between 1 and ${maxAppTests} tests; this one has ${count}.`
    );
  }
  return Object.freeze({
    kind,
    fixtures,
    tests: Object.freeze(checked),
  });
};

/**
 * Declares one of an App's test suites: the default export of a file in
 * its `tests/` folder named `*.test.ts`, such as `tests/notes.test.ts`.
 * Every suite runs when a version of the App is made current, which is
 * refused while any of its tests fails.
 *
 * ```ts
 * import { appTest } from "@grasp-os/sdk/testing";
 * import { api } from "#grasp";
 *
 * export default appTest({
 *   fixtures: "notes",
 *   tests: {
 *     "an owner reads back the note they create": async (t) => {
 *       const owner = await t.as("note-owner");
 *       const id = await owner.mutation(api.notes.create, { title: "First" });
 *       t.equal((await owner.query(api.notes.get, { id }))?.title, "First");
 *     },
 *   },
 * });
 * ```
 */
export const appTest = (definition: AppTestDefinition): AppTestSuite => {
  const { fixtures, tests } = readSuite<AppTestFunction>(definition, "app");
  return Object.freeze({ kind: "app", fixtures, tests });
};

/**
 * Declares one of an App's suites of workflow tests: the default export of
 * a file in its `tests/` folder named `*.test.ts`, as `appTest`'s. Its
 * principals also start the workflows the App binds, each a real run on
 * the engine (`t.as(...).start`), and `t` follows those runs: how each
 * ended (`t.runs`) and what its steps did (`t.effects`). Its suites run,
 * and refuse a failing version, as `appTest`'s do.
 *
 * ```ts
 * import { workflowTest } from "@grasp-os/sdk/testing";
 * import { workflows } from "#grasp";
 *
 * export default workflowTest({
 *   fixtures: "notes",
 *   tests: {
 *     "a summary completes once": async (t) => {
 *       const owner = await t.as("note-owner");
 *       const run = await owner.start(workflows.summarize, { text: "Hi" });
 *       const outcome = await t.runs.untilTerminal(run);
 *       t.equal(outcome.status, "completed");
 *       t.equal(await t.effects.completedCount(run, "summarize"), 1);
 *     },
 *   },
 * });
 * ```
 */
export const workflowTest = (
  definition: WorkflowTestDefinition
): WorkflowTestSuite => {
  const { fixtures, tests } = readSuite<WorkflowTestFunction>(
    definition,
    "workflow"
  );
  return Object.freeze({ kind: "workflow", fixtures, tests });
};

/**
 * One test's session with core's test runner: a fresh fixture store, which
 * goes when the session closes. Core's side of it is an RPC target.
 */
export interface AppTestSession {
  /**
   * Why principal `name` can't be used, such as a fixture that doesn't
   * name them; nothing when it can. Answered, not thrown: what fails is
   * the test, never the session.
   */
  principal: (name: string) => Promise<string | undefined>;
  /**
   * Calls a function as principal `name`: `request` is the call's JSON
   * text (`{ reference, input }`), as a screen sends it, and the answer
   * the JSON text of what the call answered (an `OperationResult`).
   */
  call: (name: string, request: string) => Promise<string>;
  /**
   * Follows a query as principal `name`: `request` as `call` takes it.
   * Each push of core's (`{ revision, result }`, the result an
   * `OperationResult`) goes to `onSnapshot`, and `onLost` is called once
   * core lets go of the subscription. Answers what releases it, or why
   * core refused it: the JSON text of a failed `OperationResult`.
   */
  subscribe: (
    name: string,
    request: string,
    onSnapshot: (push: unknown) => void,
    onLost: () => void
  ) => Promise<{ subscription: AppTestSubscription } | { refusal: string }>;
  /**
   * Starts a workflow as principal `name`: `request` is a screen's start's
   * JSON text (`{ workflow, command: "start", input, idempotencyKey }`),
   * and the answer the JSON text of an `OperationResult` holding the run's
   * number in the session (`{ run }`).
   */
  start: (name: string, request: string) => Promise<string>;
  /**
   * How run `run` ended, once it has, as JSON text (a `TestRunOutcome`):
   * `null` when it hadn't by the test's deadline.
   */
  runOutcome: (run: number) => Promise<string>;
  /** How many times run `run`'s task `task` completed its step. */
  completedCount: (run: number, task: string) => Promise<number>;
  /**
   * Answers, as principal `name`, the decision run `run` waits for:
   * `request` is the answer's JSON text (`{ task, approved, value? }`), and
   * the answer the JSON text of an `OperationResult` holding nothing.
   */
  respond: (name: string, run: number, request: string) => Promise<string>;
  /**
   * Ends the session: removes the runs its test started, releases the
   * live queries it left open, and discards its fixture store.
   */
  close: () => Promise<void>;
}

/** A live query's subscription in core, as the session answers it. */
export interface AppTestSubscription {
  release: () => Promise<void>;
}

/** Core's test runner, as `runAppSuite` reaches it. */
export interface AppTestHost {
  /**
   * A session for the test named `name`, on fixture `fixtures`; throws
   * when the App has no such fixture, or it isn't one.
   */
  open: (fixtures: string, name: string) => Promise<AppTestSession>;
}

/** How one test went: no failures when it passed. */
export interface AppTestResult {
  name: string;
  failures: string[];
}

/** How a suite went, test by test, in order. */
export interface AppTestReport {
  fixtures: string;
  results: AppTestResult[];
}

/** A test's own assertion failing (`equal`, `rejectsCode`). */
class TestAssertionError extends Error {
  override name = "TestAssertionError";
}

/** A call the App or the host refused or failed. */
class TestCallError extends Error {
  override name = "TestCallError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The value an `OperationResult` holds; throws the failure it holds. */
const settled = (parsed: unknown): unknown => {
  if (isRecord(parsed) && parsed.ok === true) {
    return parsed.value;
  }
  const error = isRecord(parsed) ? parsed.error : undefined;
  if (
    isRecord(error) &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    throw new TestCallError(error.code, error.message);
  }
  throw new Error("The test runner answered something else than a result.");
};

/** The value a call's answer (an `OperationResult`'s text) holds. */
const unwrapped = (answer: string): unknown => settled(JSON.parse(answer));

/** The request a principal sends for `reference`, of `kind`, with `args`. */
const requestFor = (
  reference: unknown,
  kind: ReferenceKind,
  args: unknown
): string => {
  if (!isRecord(reference) || reference.kind !== kind) {
    throw new TestAssertionError(
      `expected a reference to one of the App's ${kind === "query" ? "queries" : `${kind}s`}, from #grasp`
    );
  }
  const { resourceId, resourceVersion, contractId, fingerprint } = reference;
  return JSON.stringify({
    reference: { resourceId, resourceVersion, contractId, fingerprint, kind },
    input: args,
  });
};

// Values as they cross from the host (JSON), in canonical JSON, so equal
// values compare equal whatever order their keys are in.
const canonical = (value: unknown): string => {
  const text = JSON.stringify(value);
  if (text === undefined) {
    return "undefined";
  }
  // SAFETY: parsing JSON text always gives a JSON value.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return canonicalJson(JSON.parse(text) as Json);
};

/**
 * Releases `stub`, an RPC stub core returned (a session, a subscription),
 * when it is one:
 * the isolate holds it no longer than its test.
 */
const disposed = (stub: object): void => {
  const dispose: unknown = Reflect.get(stub, Symbol.dispose);
  if (typeof dispose === "function") {
    Reflect.apply(dispose, stub, []);
  }
};

/** One test as it runs: its session, and what its live queries wait on. */
interface RunningTest {
  readonly session: AppTestSession;
  /** Ends each live query still open: the test is over. */
  readonly closers: Set<() => void>;
  /** What each `next` under way waits on, for a test that runs out of time. */
  readonly waiting: Set<{ readonly describe: () => string }>;
  /**
   * What failed the test outside its own calls, such as a live query that
   * left too many snapshots unread or that core stopped following for good:
   * it fails even if the test never asks.
   */
  readonly faults: Set<Error>;
}

/** The most of a snapshot a failure shows. */
const maxShownSnapshot = 300;

/** `value` as a failure shows it, cut short. */
const shown = (value: unknown): string => {
  const text = canonical(value);
  return text.length > maxShownSnapshot
    ? `${text.slice(0, maxShownSnapshot)}…`
    : text;
};

/** The contract a reference names, for a failure's text. */
const contractOf = (reference: unknown): string =>
  isRecord(reference) && typeof reference.contractId === "string"
    ? reference.contractId
    : "a query";

/** A push of core's, as far as a live query reads it. */
const readPush = (
  push: unknown
): { revision: number; result: unknown } | undefined =>
  isRecord(push) &&
  typeof push.revision === "number" &&
  Number.isSafeInteger(push.revision)
    ? { revision: push.revision, result: push.result }
    : undefined;

/**
 * How many times in a row core may let go of a live query, with no
 * snapshot in between, before the test fails: on that loss, it does. Core
 * lets go of one it can't keep fresh for now (a read that met a
 * concurrent write, a store that restarted), and a screen follows it
 * again from a fresh read; so does a test, but one core can't keep
 * following at all fails it.
 */
export const maxLostInARow = 5;

/** How long a test waits to follow again after each loss in a row, in ms. */
const refollowMs = 50;

/** One subscription to a live query, as the test follows it. */
interface Attempt {
  handle: AppTestSubscription | undefined;
}

/**
 * Follows `reference` with `args` as principal `name` (`subscribe`): the
 * snapshots core pushes, one at a time and in order, are kept until
 * `next` takes them. Lost, it follows again, as a screen does, from a
 * fresh read: a new subscription, whose predecessor's late pushes are
 * dropped.
 */
const followed = async (
  run: RunningTest,
  name: string,
  reference: unknown,
  args: unknown
): Promise<LiveQuery<unknown>> => {
  const request = requestFor(reference, "query", args);
  const contract = contractOf(reference);
  const snapshots: unknown[] = [];
  let last: { value: unknown } | undefined;
  let failure: Error | undefined;
  let closed = false;
  let wake: (() => void) | undefined;
  let attempt: Attempt | undefined;
  let lostInARow = 0;
  const notify = (): void => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  const fail = (error: unknown): void => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    notify();
  };
  /** Whether `of` is what the test follows now, and still may. */
  const current = (of: Attempt): boolean =>
    !closed && failure === undefined && attempt === of;
  const pushed = (of: Attempt, push: unknown): void => {
    const read = readPush(push);
    if (!current(of) || read === undefined) {
      return;
    }
    lostInARow = 0;
    let value: unknown;
    try {
      value = settled(read.result);
    } catch (error) {
      fail(error);
      return;
    }
    // Dropping one unread could drop the very snapshot a `next` will
    // wait for, which would then wait until the test's deadline: the
    // test fails now, saying why.
    if (snapshots.length >= maxBufferedSnapshots) {
      const overflow = new TestAssertionError(
        `more than ${maxBufferedSnapshots} snapshots of the live query of ${contract} went unread: take them with live.next, or close it`
      );
      run.faults.add(overflow);
      fail(overflow);
      return;
    }
    snapshots.push(value);
    last = { value };
    notify();
  };
  const end = (): Attempt | undefined => {
    closed = true;
    snapshots.length = 0;
    notify();
    const ended = attempt;
    attempt = undefined;
    return ended;
  };
  // As the test ends: nothing of it is held in the isolate past it.
  // Registered before the first subscription is asked for, so a test
  // that ends meanwhile still lets go of what it is answered (`follow`).
  const drop = (): void => {
    const ended = end();
    if (ended?.handle !== undefined) {
      disposed(ended.handle);
    }
  };
  run.closers.add(drop);
  const follow = async (): Promise<void> => {
    const of: Attempt = { handle: undefined };
    attempt = of;
    let handle: AppTestSubscription;
    try {
      const answer = await run.session.subscribe(
        name,
        request,
        (push) => {
          pushed(of, push);
        },
        () => {
          // oxlint-disable-next-line no-use-before-define -- each loss follows again, which may be lost
          lost(of);
        }
      );
      if ("refusal" in answer) {
        // Throws the refusal it holds, as a call's: `t.rejectsCode` reads it.
        settled(JSON.parse(answer.refusal));
        throw new Error(
          "The test runner refused a live query without saying why."
        );
      }
      handle = answer.subscription;
    } catch (error) {
      // Refused: nothing is followed, nor followed again.
      if (attempt === of) {
        attempt = undefined;
      }
      throw error;
    }
    if (current(of)) {
      of.handle = handle;
    } else {
      // Lost, closed or ended meanwhile.
      disposed(handle);
    }
  };
  const lost = (of: Attempt): void => {
    if (!current(of)) {
      return;
    }
    attempt = undefined;
    if (of.handle !== undefined) {
      disposed(of.handle);
    }
    lostInARow += 1;
    if (lostInARow >= maxLostInARow) {
      // A fault of the run's, as an overflow is: the test fails even if it
      // never asks this live query for a snapshot again. So is a refusal
      // to follow it again (`again`).
      const gone = new TestAssertionError(
        `core stopped following the live query of ${contract} ${lostInARow} times in a row`
      );
      run.faults.add(gone);
      fail(gone);
      return;
    }
    const again = async (): Promise<void> => {
      if (closed || failure !== undefined) {
        return;
      }
      try {
        await follow();
      } catch (error) {
        if (closed) {
          return;
        }
        // Refused or failed for good, out of the test's sight: a fault of
        // the run's, as five losses in a row are.
        fail(error);
        if (failure !== undefined) {
          run.faults.add(failure);
        }
      }
    };
    setTimeout(() => {
      void again();
    }, refollowMs * lostInARow);
  };
  try {
    await follow();
  } catch (error) {
    run.closers.delete(drop);
    throw error;
  }
  const waitOn = {
    describe: () =>
      `live.next on ${contract}, ${last === undefined ? "with no snapshot yet" : `whose last snapshot was ${shown(last.value)}`}`,
  };
  return {
    next: async (predicate) => {
      for (;;) {
        while (snapshots.length > 0) {
          const value = snapshots.shift();
          if (predicate === undefined || predicate(value)) {
            return value;
          }
        }
        if (failure !== undefined) {
          throw failure;
        }
        if (closed) {
          throw new TestAssertionError(
            `live.next on ${contract} after it was closed`
          );
        }
        if (wake !== undefined) {
          throw new TestAssertionError(
            `live.next on ${contract} waits for one snapshot at a time`
          );
        }
        const { promise, resolve } = Promise.withResolvers<null>();
        wake = (): void => {
          resolve(null);
        };
        run.waiting.add(waitOn);
        try {
          // One snapshot after another, in the order core pushed them.
          // oxlint-disable-next-line no-await-in-loop -- see above
          await promise;
        } finally {
          run.waiting.delete(waitOn);
        }
      }
    },
    close: async () => {
      if (closed) {
        return;
      }
      const ended = end();
      run.closers.delete(drop);
      if (ended?.handle !== undefined) {
        try {
          await ended.handle.release();
        } finally {
          // Nothing else holds it now, even if core couldn't be told.
          disposed(ended.handle);
        }
      }
    },
  };
};

/**
 * Each run a principal started: the test that started it, and its number
 * in that test's session, which names another run in any other test's.
 */
const runNumbers = new WeakMap<
  object,
  { readonly test: RunningTest; readonly number: number }
>();

/**
 * The number of `run` in `test`'s session, a handle one of `test`'s own
 * principals started; fails the test for any other, one kept from another
 * test included.
 */
const numberOf = (test: RunningTest, run: unknown): number => {
  const started =
    typeof run === "object" && run !== null ? runNumbers.get(run) : undefined;
  if (started === undefined) {
    throw new TestAssertionError(
      "expected a run a test principal started, from start"
    );
  }
  if (started.test !== test) {
    throw new TestAssertionError(
      "expected a run this test started, not one another test started"
    );
  }
  return started.number;
};

/** A key for one start, as a screen makes one: 16 random bytes in hex. */
const startKey = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

/** The start request for `reference` with `input`, as a screen sends it. */
const startRequestFor = (reference: unknown, input: unknown): string => {
  if (!isRecord(reference) || reference.kind !== "workflow") {
    throw new TestAssertionError(
      "expected a reference to one of the App's workflows, from #grasp"
    );
  }
  const { resourceId, resourceVersion, contractId, fingerprint } = reference;
  return JSON.stringify({
    workflow: {
      resourceId,
      resourceVersion,
      contractId,
      fingerprint,
      kind: "workflow",
    },
    command: "start",
    input,
    idempotencyKey: startKey(),
  });
};

/** What a start answers: the run's number in the session. */
const startedNumber = (value: unknown): number => {
  if (
    isRecord(value) &&
    typeof value.run === "number" &&
    Number.isSafeInteger(value.run)
  ) {
    return value.run;
  }
  throw new Error("The test runner answered a start without its run.");
};

const principalOf = (run: RunningTest, name: string): TestPrincipal => {
  const { session } = run;
  const call =
    (kind: ReferenceKind) =>
    async (reference: unknown, args: unknown): Promise<never> =>
      // SAFETY: the host checked the value against the function's
      // contract (its `returns`), which `ReturnOf` types.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      unwrapped(
        await session.call(name, requestFor(reference, kind, args))
      ) as never;
  return Object.freeze({
    query: call("query"),
    mutation: call("mutation"),
    action: call("action"),
    // SAFETY: what core pushes was checked against the query's contract
    // (its `returns`), which `ReturnOf` types.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    subscribe: (async (reference: unknown, args: unknown) =>
      await followed(run, name, reference, args)) as TestPrincipal["subscribe"],
    // SAFETY: a start answers the run's handle, whose output only types it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    start: (async (reference: unknown, input: unknown) => {
      const answer = await session.start(
        name,
        startRequestFor(reference, input)
      );
      const handle: WorkflowTestRun = Object.freeze({
        workflow:
          isRecord(reference) && typeof reference.contractId === "string"
            ? reference.contractId
            : "a workflow",
      });
      runNumbers.set(handle, {
        test: run,
        number: startedNumber(unwrapped(answer)),
      });
      return handle;
    }) as TestPrincipal["start"],
    respond: async (
      handle: WorkflowTestRun,
      task: string,
      { approved, value, at }: TestDecisionAnswer
    ): Promise<void> => {
      unwrapped(
        await session.respond(
          name,
          numberOf(run, handle),
          JSON.stringify({
            task,
            approved,
            ...(value === undefined ? {} : { value }),
            ...(at === undefined ? {} : { at }),
          })
        )
      );
    },
  });
};

/** The outcome `text` (`runOutcome`'s answer) holds; fails the test for none. */
const outcomeOf = (text: string, run: WorkflowTestRun): TestRunOutcome => {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null) {
    throw new TestAssertionError(
      `the run of ${run.workflow} didn't end before the test's deadline`
    );
  }
  if (
    isRecord(parsed) &&
    (parsed.status === "completed" ||
      parsed.status === "failed" ||
      parsed.status === "cancelled")
  ) {
    // SAFETY: core answers a `FixtureRunOutcome`, which this is the shape of.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return parsed as TestRunOutcome;
  }
  throw new Error("The test runner answered something else than an outcome.");
};

const contextFor = (run: RunningTest): WorkflowTestContext => ({
  runs: {
    // SAFETY: the run's output was checked against its version's output
    // schema as it ended, which `Output` types.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    untilTerminal: (async (handle: WorkflowTestRun) =>
      outcomeOf(
        await run.session.runOutcome(numberOf(run, handle)),
        handle
      )) as TestRuns["untilTerminal"],
  },
  effects: {
    completedCount: async (handle, task) =>
      await run.session.completedCount(numberOf(run, handle), task),
  },
  as: async (name) => {
    const refused = await run.session.principal(name);
    if (refused !== undefined) {
      throw new TestAssertionError(refused);
    }
    return principalOf(run, name);
  },
  equal: (actual, expected, message) => {
    if (canonical(actual) !== canonical(expected)) {
      throw new TestAssertionError(
        `${message === undefined ? "" : `${message}: `}expected ${canonical(expected)}, got ${canonical(actual)}`
      );
    }
  },
  rejectsCode: async (work, code) => {
    try {
      await (typeof work === "function" ? work() : work);
    } catch (error) {
      if (error instanceof TestCallError && error.code === code) {
        return;
      }
      throw new TestAssertionError(
        error instanceof TestCallError
          ? `expected ${code}, but the call failed with ${error.code}: ${error.message}`
          : `expected ${code}, but it threw ${messageOf(error)}`
      );
    }
    throw new TestAssertionError(`expected ${code}, but the call succeeded`);
  },
});

/** The most of one failure's text a report holds. */
const maxFailureLength = 2000;

/** Why a test failed, in one line. */
const failureOf = (error: unknown): string => {
  let failure = `threw ${messageOf(error)}`;
  if (error instanceof TestAssertionError) {
    failure = error.message;
  } else if (error instanceof TestCallError) {
    failure = `unexpected error ${error.code}: ${error.message}`;
  }
  return failure.slice(0, maxFailureLength);
};

/**
 * Runs `test` for at most `ms`: a test that never finishes fails, saying
 * what it still waited on (`waiting`), and the next one runs.
 */
const withinTime = async (
  test: Promise<void>,
  ms: number,
  waiting: RunningTest["waiting"]
): Promise<void> => {
  const limit = deadline(ms);
  try {
    await Promise.race([test, whenAborted(limit.signal)]);
  } catch (error) {
    if (limit.stopped() === "timeout") {
      const waits = [...waiting].map(({ describe }) => describe());
      throw new TestAssertionError(
        `didn't finish within ${ms / 1000} seconds${waits.length === 0 ? "" : `, still waiting in ${waits.join("; ")}`}`
      );
    }
    throw error;
  } finally {
    limit.clear();
  }
};

/**
 * Runs `suite` (a test file's default export) over core's `host`, one
 * test after another, each in a session of its own that is closed after
 * it. Never throws for a test: each failure is in the report. Throws for
 * a file whose default export isn't an `appTest` or `workflowTest` suite. Each test may run
 * `testTimeoutMs`: `appTestTimeoutMs`, or less where core says so.
 */
export const runAppSuite = async (
  suite: unknown,
  host: AppTestHost,
  { testTimeoutMs = appTestTimeoutMs }: { testTimeoutMs?: number } = {}
): Promise<AppTestReport> => {
  const timeoutMs = Math.min(testTimeoutMs, appTestTimeoutMs);
  if (!isRecord(suite) || (suite.kind !== "app" && suite.kind !== "workflow")) {
    return refuseSuite(
      "A test file (tests/*.test.ts) default-exports an appTest or workflowTest suite."
    );
  }
  const { fixtures, tests } = readSuite<WorkflowTestFunction>(
    suite,
    suite.kind
  );
  const results: AppTestResult[] = [];
  for (const [name, test] of Object.entries(tests)) {
    // One test after another: each may only rely on its own session.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const session = await host.open(fixtures, name);
    const run: RunningTest = {
      session,
      closers: new Set(),
      waiting: new Set(),
      faults: new Set(),
    };
    const failures: string[] = [];
    try {
      // oxlint-disable-next-line no-await-in-loop -- see above
      await withinTime(test(contextFor(run)), timeoutMs, run.waiting);
      const [fault] = run.faults;
      if (fault !== undefined) {
        throw fault;
      }
    } catch (error) {
      failures.push(failureOf(error));
    } finally {
      // Its live queries end with it: core releases their subscriptions
      // as the session closes.
      for (const drop of run.closers) {
        drop();
      }
      // oxlint-disable-next-line no-await-in-loop -- see above
      await session.close();
      disposed(session);
    }
    results.push({ name, failures });
  }
  return { fixtures, results };
};

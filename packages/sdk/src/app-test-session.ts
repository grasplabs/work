// oxlint-disable max-classes-per-file -- the two failures a test can have, each a few lines
import { canonicalJson, isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";

import type { ReferenceKind } from "./function-references.ts";

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
   * text (`{ reference, args }`), as a page sends it, and the answer
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
   * Starts a workflow as principal `name`: `request` is a call of its
   * reference's `start` mutation, as `call` takes one, and the answer the JSON text of an `OperationResult` holding the run's
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
export class TestAssertionError extends Error {
  override name = "TestAssertionError";
}

/** A call the App or the host refused or failed. */
export class TestCallError extends Error {
  override name = "TestCallError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The value an `OperationResult` holds; throws the failure it holds. */
export const settled = (parsed: unknown): unknown => {
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
export const unwrapped = (answer: string): unknown =>
  settled(JSON.parse(answer));

/** The request a principal sends for `reference`, of `kind`, with `args`. */
export const requestFor = (
  reference: unknown,
  kind: ReferenceKind,
  args: unknown
): string => {
  // A reference names its function; a mutation's or an action's also says
  // its kind, which must be the call's.
  if (
    !isRecord(reference) ||
    typeof reference.name !== "string" ||
    (reference.kind !== undefined && reference.kind !== kind)
  ) {
    throw new TestAssertionError(
      `expected a reference to one of the App's ${kind === "query" ? "queries" : `${kind}s`}, from @server/_generated/api`
    );
  }
  return JSON.stringify({
    reference: { name: reference.name, kind },
    args,
  });
};

// Values as they cross from the host (JSON), in canonical JSON, so equal
// values compare equal whatever order their keys are in. Serialised once:
// a getter or `toJSON` is read a single time.
export const canonical = (value: unknown): string => {
  const text = JSON.stringify(value);
  if (text === undefined) {
    return "undefined";
  }
  // SAFETY: what JSON.parse answers is JSON.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const json = JSON.parse(text) as Json;
  return canonicalJson(json);
};

/**
 * Releases `stub`, an RPC stub core returned (a session, a subscription),
 * when it is one:
 * the isolate holds it no longer than its test.
 */
export const disposed = (stub: object): void => {
  const dispose: unknown = Reflect.get(stub, Symbol.dispose);
  if (typeof dispose === "function") {
    Reflect.apply(dispose, stub, []);
  }
};

/** One test as it runs: its session, and what its live queries wait on. */
export interface RunningTest {
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

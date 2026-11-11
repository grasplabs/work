import { canonicalJson, isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";

import { readAnswer } from "./call-answers.ts";
import type { ReferenceKind } from "./function-references.ts";

/**
 * One test's session with core's test runner: a fresh store, which goes
 * when the session closes. Core's side of it is an RPC target. Each
 * identity the test acts as is named by the name it was given.
 */
export interface AppTestSession {
  /**
   * Registers who a test acts as: `request` is `{ name, role, teams }` as
   * JSON text. Answers why they can't be (a name given another role
   * before, too many people), nothing when they can: answered, not thrown,
   * since what fails is the test, never the session.
   */
  identify: (request: string) => Promise<string | undefined>;
  /**
   * Calls a function as identity `name`: `request` is the call's JSON
   * text (`{ reference, args }`), as a page sends it, and the answer
   * the JSON text of what the call answered (an `FunctionResult`).
   */
  call: (name: string, request: string) => Promise<string>;
  /**
   * Follows a query as identity `name`: `request` as `call` takes it.
   * Each push of core's (`{ revision, result }`, the result an
   * `FunctionResult`) goes to `onSnapshot`, and `onLost` is called once
   * core lets go of the subscription. Answers what releases it, or why
   * core refused it: the JSON text of a failed `FunctionResult`.
   */
  subscribe: (
    name: string,
    request: string,
    onSnapshot: (push: unknown) => void,
    onLost: () => void
  ) => Promise<{ subscription: AppTestSubscription } | { refusal: string }>;
  /**
   * Opens a transaction on the test's store (`t.run`), as identity `name`
   * or, for `null`, the test itself, which no access rule holds back.
   * Answers the JSON text of an `FunctionResult` holding its number
   * (`{ transaction }`).
   */
  begin: (name: string | null) => Promise<string>;
  /**
   * One read in transaction `transaction`, `request` a `ReadRequest` as
   * JSON text: the JSON text of an `FunctionResult`. It sees the
   * transaction's own writes.
   */
  read: (transaction: number, request: string) => Promise<string>;
  /**
   * One write staged in transaction `transaction`, `request` a
   * `WriteRequest` as JSON text: the JSON text of an `FunctionResult`
   * (an insert's minted ID).
   */
  write: (transaction: number, request: string) => Promise<string>;
  /**
   * Ends transaction `transaction`: commits what it staged when
   * `commit`, else drops it. Answers the JSON text of an `FunctionResult`
   * holding nothing, or why the commit was refused.
   */
  end: (transaction: number, commit: boolean) => Promise<string>;
  /**
   * Starts a workflow as identity `name`: `request` is a call of its
   * reference's `start` mutation, as `call` takes one, and `options` its
   * `TestStartOptions` as JSON text, deciders by name. The answer is the
   * JSON text of an `FunctionResult` holding the run's number in the
   * session (`{ run }`).
   */
  start: (name: string, request: string, options: string) => Promise<string>;
  /**
   * How run `run` ended, once it has, as JSON text (a `TestRunOutcome`):
   * `null` when it hadn't by the test's deadline.
   */
  runOutcome: (run: number) => Promise<string>;
  /**
   * Whether run `run` waits for something, or has ended, by the test's
   * deadline: false when neither.
   */
  runWaits: (run: number) => Promise<boolean>;
  /** How many times run `run`'s task `task` completed its step. */
  completedCount: (run: number, task: string) => Promise<number>;
  /** How many model requests run `run`'s task `task` made. */
  modelRequestCount: (run: number, task: string) => Promise<number>;
  /**
   * Moves the time of the session's runs `ms` milliseconds on: the JSON
   * text of an `FunctionResult` holding nothing, or why it was refused.
   */
  advanceClock: (ms: number) => Promise<string>;
  /**
   * Answers, as identity `name`, the decision run `run` waits for:
   * `request` is the answer's JSON text (`{ task, approved, value? }`),
   * and the answer the JSON text of an `FunctionResult` holding nothing.
   */
  respond: (name: string, run: number, request: string) => Promise<string>;
  /**
   * Ends the session: removes the runs its test started, releases the
   * live queries it left open, and discards its store.
   */
  close: () => Promise<void>;
}

/** A live query's subscription in core, as the session answers it. */
export interface AppTestSubscription {
  release: () => Promise<void>;
}

/** Core's test runner, as `runAppSuite` reaches it. */
export interface AppTestHost {
  /** A session for the test named `name`. */
  open: (name: string) => Promise<AppTestSession>;
}

/** How one test went: no failures when it passed. */
export interface AppTestResult {
  name: string;
  failures: string[];
}

/** How a suite went, test by test, in order. */
export interface AppTestReport {
  results: AppTestResult[];
}

/** A test used the harness wrong, or a wait of its own failed. */
export class TestAssertionError extends Error {
  override name = "TestAssertionError";
}

/**
 * The value core's answer (an `FunctionResult`'s JSON text) holds; throws
 * the `GraspError` a page's call gets for a refusal.
 */
export const unwrapped = (answer: string): unknown => {
  const result: unknown = JSON.parse(answer);
  const settled = readAnswer({ result });
  if (settled.kind === "value") {
    return settled.value;
  }
  if (settled.kind === "failed") {
    throw settled.error;
  }
  throw new Error("The test runner answered something else than a result.");
};

/** The request an identity sends for `reference`, of `kind`, with `args`. */
export const requestFor = (
  reference: unknown,
  kind: ReferenceKind,
  args: unknown
): string => {
  // A reference names its function, nothing more: the call says its kind,
  // and the host refuses a function of another.
  if (!isRecord(reference) || typeof reference.name !== "string") {
    throw new TestAssertionError(
      `expected a reference to one of the App's ${kind === "query" ? "queries" : `${kind}s`}, from @server/_generated/api`
    );
  }
  return JSON.stringify({
    reference: { name: reference.name, kind },
    args,
  });
};

// Values as they cross from the host (JSON), in canonical JSON, so a
// failure shows them the same whatever order their keys are in.
// Serialised once: a getter or `toJSON` is read a single time.
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
 * when it is one: the isolate holds it no longer than its test.
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
  /**
   * Who the test named, being registered with core (`identify`): why
   * one couldn't be, or nothing.
   */
  readonly pending: Set<Promise<string | undefined>>;
}

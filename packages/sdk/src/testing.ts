import { messageOf } from "@grasp-os/shared/errors";
import { runIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { isRetryable, maxStepRetries } from "@grasp-os/shared/workflows";
import { z } from "zod";

import type {
  DecisionAnswer,
  EngineDecision,
  ModelRequest,
  WorkflowEngine,
  WorkflowEnv,
} from "./engine.ts";
import { engineStepPattern } from "./steps.ts";
import type { WorkflowDefinition } from "./workflow.ts";

// An App's tests (`appTest`), which core's test runner runs against the
// real host: app-test.ts.
export {
  appTest,
  appTestTimeoutMs,
  maxAppTestName,
  maxAppTests,
  maxBufferedSnapshots,
  maxLostInARow,
  runAppSuite,
  TestDefinitionError,
  testNamePattern,
  workflowTest,
} from "./app-test.ts";
export type {
  AppTestContext,
  AppTestDefinition,
  AppTestFunction,
  AppTestHost,
  AppTestReport,
  AppTestResult,
  AppTestSession,
  AppTestSubscription,
  AppTestSuite,
  LiveQuery,
  PublicReference,
  TestDecisionAnswer,
  TestEffects,
  TestPrincipal,
  TestRunOutcome,
  TestRuns,
  WorkflowTestContext,
  WorkflowTestDefinition,
  WorkflowTestFunction,
  WorkflowTestRun,
  WorkflowTestSuite,
} from "./app-test.ts";

/**
 * Test harness for workflows. Runs a workflow in memory, with
 * the time-skipping and step-mocking of Temporal's test environment:
 *
 * - steps can be mocked by name, or made to fail;
 * - side-effect steps don't run: they're recorded with their input, so a
 *   test asserts what the workflow would change;
 * - decisions are answered up front, and a wait for one without an answer
 *   times out right away, as sleeps end right away.
 *
 * The workflow SDK's own tests run on it.
 */

/** A step's call, as a mock gets it. */
export interface StepCall {
  /** The step's name, with its key if it has one: `pay:inv-7`. */
  name: string;
  input?: Json;
}

/** A step's result instead of running it, or a function that computes it. */
export type StepMock = Json | ((call: StepCall) => Json | Promise<Json>);

/** What a step did in a test run. */
export type StepRecord =
  | {
      type: "step";
      /**
       * The step's name, with its key if it has one (`pay:inv-7`), or the
       * part of a decision (`review#ask`).
       */
      name: string;
      sideEffect: boolean;
      input?: Json;
      /**
       * `ran` for its function, `mocked` for a mocked result and `recorded`
       * for a side effect that didn't run, which has no result.
       */
      status: "ran" | "mocked" | "recorded";
      output: unknown;
    }
  | {
      type: "step";
      name: string;
      sideEffect: boolean;
      input?: Json;
      status: "failed";
      error: string;
    }
  | { type: "sleep"; name: string; milliseconds: number }
  | {
      type: "wait";
      name: string;
      eventType: string;
      timeout: number;
      /** What the wait ended with, or nothing before the timeout. */
      event: { received: true; payload: unknown } | { received: false };
    };

/** A side effect the run would have had, in the order it would happen. */
export interface SideEffect {
  name: string;
  input?: Json;
}

export interface TestEngineOptions {
  runId?: string;
  /** Parameter values people set, by name; missing ones use the default. */
  params?: Record<string, unknown>;
  /** What the workflow kept between its runs, by key; none when missing. */
  state?: Record<string, Json>;
  /**
   * Stand-ins for the run's bindings (`env.OUTLOOK`), for steps that run;
   * none when missing, and mocked steps don't need them.
   */
  env?: WorkflowEnv;
  /**
   * Step results by step name, instead of running the step. A keyed step
   * takes the mock for `name:key` (the key as the workflow gives it), or
   * else the one for `name`. An AI step's mock is the model's answer, which
   * is still checked against its schema. A side-effect step that isn't
   * mocked has no result.
   */
  mocks?: Readonly<Record<string, StepMock>>;
  /** Steps that fail, by name (as for mocks), with this error message. */
  failures?: Readonly<Record<string, string>>;
  /** Answers the model gateway; an AI step without a mock fails without it. */
  model?: (request: ModelRequest) => unknown;
  /**
   * Answers to decisions by the decision's name (as for mocks). A decision
   * without an answer times out, after its reminder if it has one. Each
   * decision asks one stand-in person, `test-person`.
   */
  decisions?: Readonly<Record<string, DecisionAnswer>>;
  /**
   * `record` (the default) records side-effect steps without running them;
   * `run` runs them, e.g. against a fake of the system they change.
   */
  sideEffects?: "record" | "run";
  /**
   * Called with the time each sleep, and each wait that times out, would
   * have taken. The test engine skips it; move a fake clock with it.
   */
  skipTime?: (milliseconds: number) => void;
}

interface StepName {
  /** With the key as the workflow gave it, not as the engine got it. */
  name: string;
  /** What a keyed step also answers to: its name without the key. */
  unkeyed?: string;
}

const stepNameOf = (engineName: string): StepName => {
  const groups = engineStepPattern.exec(engineName)?.groups;
  if (groups?.name === undefined || groups.key === undefined) {
    return { name: engineName };
  }
  const part = groups.part === undefined ? "" : `#${groups.part}`;
  return {
    name: `${groups.name}:${decodeURIComponent(groups.key)}${part}`,
    // The parts of a decision (`review#ask`) only match by their full name.
    ...(groups.part === undefined ? { unkeyed: groups.name } : {}),
  };
};

/** The value for a step: by its name and key, else by its name alone. */
const byStepName = <T>(
  values: Readonly<Record<string, T>> | undefined,
  { name, unkeyed }: StepName
): T | undefined => {
  if (values && Object.hasOwn(values, name)) {
    return values[name];
  }
  return values && unkeyed !== undefined && Object.hasOwn(values, unkeyed)
    ? values[unkeyed]
    : undefined;
};

/**
 * Runs `fn`, and again up to `retries` times while it fails with an error
 * that trying again may fix (`isRetryable`), as a real run does. Delays
 * and timeouts aren't simulated.
 */
const attempt = async <T>(
  retries: number,
  fn: () => Promise<T>
): Promise<T> => {
  let lastError: unknown;
  for (let attempts = 0; attempts <= retries; attempts += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- attempts are sequential by design
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error)) {
        break;
      }
    }
  }
  throw lastError;
};

/**
 * A failed step's error as some engines keep it: only its name and message
 * (Cloudflare Workflows does), so tests catch anything that relies on more.
 */
const asKept = (error: unknown): Error => {
  const kept = new Error(messageOf(error));
  if (error instanceof Error) {
    kept.name = error.name;
  }
  return kept;
};

/**
 * A step's result as an engine stores it: JSON text, or nothing. A result
 * that isn't JSON (a Date, a class) fails the step here, as it would when a
 * real engine stores it.
 */
const toStored = (step: string, result: unknown): string | undefined => {
  if (result === undefined) {
    return undefined;
  }
  if (!z.json().safeParse(result).success) {
    throw new Error(
      `Step "${step}" returned something that isn't JSON, which an engine can't store`
    );
  }
  return JSON.stringify(result);
};

// A fresh copy every time, so changing a result never changes its replays.
const fromStored = (stored: string | undefined): unknown =>
  stored === undefined ? undefined : JSON.parse(stored);

/**
 * An in-memory engine with the durable semantics workflows rely on: a step's
 * result is stored as JSON under its name, and running the workflow again on
 * the same engine replays it (completed steps return their stored result), as
 * a resume after a crash does.
 */
export const createTestEngine = (options: TestEngineOptions = {}) => {
  const recorded = new Map<string, unknown>();
  const results = new Map<string, string | undefined>();
  const steps: StepRecord[] = [];
  const modelRequests: ModelRequest[] = [];
  /** The decisions opened, once each. */
  const decisions: { step: string; from: string; deadline: number }[] = [];
  const runSideEffects = options.sideEffects === "run";
  // The SDK's own step (parameters) isn't the workflow's.
  const log = (record: StepRecord): void => {
    if (!record.name.startsWith("$")) {
      steps.push(record);
    }
  };

  const engine: WorkflowEngine = {
    runId: runIdSchema.parse(options.runId ?? "run-1"),
    params: options.params ?? {},
    // A copy: the run freezes what it reads, never the test's own object.
    state: structuredClone(options.state ?? {}),
    env: options.env ?? {},
    do: async (name, { retries, sideEffect = false, input }, fn) => {
      if (results.has(name)) {
        // SAFETY: only `do` stores under a name, with the result of the same
        // step, which a deterministic workflow asks for with the same T.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        return fromStored(results.get(name)) as Awaited<ReturnType<typeof fn>>;
      }
      const step = stepNameOf(name);
      const call = {
        name: step.name,
        ...(input === undefined ? {} : { input }),
      };
      const failure = byStepName(options.failures, step);
      const mock = byStepName(options.mocks, step);
      try {
        if (failure !== undefined) {
          throw new Error(failure);
        }
        let status: "ran" | "mocked" | "recorded" = "ran";
        let output: unknown;
        if (mock !== undefined) {
          status = "mocked";
          output = typeof mock === "function" ? await mock(call) : mock;
        } else if (sideEffect && !runSideEffects) {
          status = "recorded";
        } else {
          // As the engine: the platform's attempts when it declares none.
          output = await attempt(
            retries?.limit ?? maxStepRetries,
            async () => await fn()
          );
        }
        const stored = toStored(step.name, output);
        results.set(name, stored);
        log({
          type: "step",
          ...call,
          sideEffect,
          status,
          output: fromStored(stored),
        });
        // A copy of its own: the workflow may change what it gets back,
        // which must not change the record above.
        // SAFETY: a mock stands in for the step's result, and a side effect
        // that isn't run has none; the test decides what the step returns.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        return fromStored(stored) as Awaited<ReturnType<typeof fn>>;
      } catch (error) {
        log({
          type: "step",
          ...call,
          sideEffect,
          status: "failed",
          error: messageOf(error),
        });
        throw asKept(error);
      }
    },
    sleep: async (name, milliseconds) => {
      if (!recorded.has(name)) {
        recorded.set(name, null);
        log({ type: "sleep", name: stepNameOf(name).name, milliseconds });
        options.skipTime?.(milliseconds);
      }
      await Promise.resolve();
    },
    callModel: async (request) => {
      modelRequests.push(request);
      if (!options.model) {
        throw new Error(
          `Step "${request.step}" asks a model: mock it, or give the test a model`
        );
      }
      return await options.model(request);
    },
    // Idempotent per step, as the engine contract asks: opening a decision
    // again (a crash before its step was recorded) opens nothing new. A
    // decision's ID here is its step.
    openDecision: async ({ step, from, timeout }) => {
      let opened = decisions.find((decision) => decision.step === step);
      if (!opened) {
        opened = { step, from, deadline: Date.now() + timeout };
        decisions.push(opened);
      }
      return await Promise.resolve({
        decision: step,
        deadline: opened.deadline,
      });
    },
    decisionRecipients: async (decision) =>
      await Promise.resolve([
        {
          userId: "test-person",
          name: "Test Person",
          email: "test-person@grasp.test",
          link: `https://grasp.test/decisions/${decision}`,
        },
      ]),
    waitForDecision: async (name, { decision, timeout }) => {
      const replayed = recorded.get(name);
      if (replayed !== undefined) {
        // SAFETY: only this method records under a decision wait's name.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        return replayed as EngineDecision;
      }
      const answer = byStepName(options.decisions, stepNameOf(decision));
      const outcome: EngineDecision = answer
        ? {
            answered: true,
            approved: answer.approved,
            by: answer.by,
            payload: answer.payload ?? null,
          }
        : { answered: false };
      recorded.set(name, outcome);
      log({
        type: "wait",
        name: stepNameOf(name).name,
        eventType: `decision:${stepNameOf(decision).name}`,
        timeout,
        event: answer
          ? { received: true, payload: outcome }
          : { received: false },
      });
      if (!answer) {
        options.skipTime?.(timeout);
      }
      return await Promise.resolve(outcome);
    },
  };

  return {
    engine,
    steps,
    modelRequests,
    decisions,
  };
};

/** What a test run or dry run needs besides the workflow. */
export interface TestRunOptions extends Omit<
  TestEngineOptions,
  "sideEffects" | "skipTime"
> {
  /** The run's input, e.g. the invoice that started it. */
  input?: unknown;
}

/** How a test run or dry run went. */
export type TestRun<Output = unknown> = (
  | { status: "completed"; output: Output }
  | { status: "failed"; error: Error }
) & {
  /** What each step did, in order. */
  steps: StepRecord[];
  /** The side effects the run would have had, and their input. */
  sideEffects: SideEffect[];
};

/**
 * Runs a workflow once in memory. Side-effect steps are recorded, never run,
 * whatever the options say. Every other step runs unless it's
 * mocked. Never throws for the workflow: a run that fails comes back with
 * its error.
 */
export const testRun = async <Output>(
  definition: WorkflowDefinition<Output>,
  { input, ...options }: TestRunOptions = {}
): Promise<TestRun<Output>> => {
  const { engine, steps } = createTestEngine({
    ...options,
    // Last, so no option sets it: `TestRunOptions` has no `sideEffects`,
    // but untyped options (a test file's, sent to core) may.
    sideEffects: "record",
  });
  let outcome:
    | { status: "completed"; output: Output }
    | { status: "failed"; error: Error };
  try {
    outcome = {
      status: "completed",
      output: await definition.run(engine, input),
    };
  } catch (error) {
    outcome = {
      status: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  return {
    ...outcome,
    steps,
    sideEffects: steps.flatMap((record) =>
      record.type === "step" && record.sideEffect && record.status !== "failed"
        ? [
            {
              name: record.name,
              ...(record.input === undefined ? {} : { input: record.input }),
            },
          ]
        : []
    ),
  };
};

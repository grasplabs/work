// Runs a fixture on both engines and reads back what each did, through each
// engine's public binding and instance: status, subscription events, and
// what the fixture's callbacks noted. Nothing here reads either engine's
// storage.
import { env } from "cloudflare:workers";

import { Workflow } from "../src/binding.ts";
import { notesOf } from "./conformance-fixtures.ts";

const pollMs = 20;
const deadlineMs = 10_000;

/** What both engines' instances answer, as the suite uses them. */
export interface Instance {
  readonly id: string;
  readonly status: () => Promise<unknown>;
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly terminate: (options?: { rollback?: boolean }) => Promise<void>;
  readonly restart: (options?: {
    from?: {
      name: string;
      count?: number;
      type?: "do" | "sleep" | "waitForEvent";
    };
  }) => Promise<void>;
  readonly delete: () => Promise<void>;
  readonly sendEvent: (event: {
    type: string;
    payload: unknown;
  }) => Promise<void>;
  readonly subscribe: (options?: SubscribeOptions) => Promise<
    {
      next: () => Promise<IteratorResult<unknown, unknown>>;
    } & Disposable
  >;
}

export interface SubscribeOptions {
  cursor?: number;
  /** The one type the suite filters by, an event type of both engines. */
  filter?: "step_completed"[];
}

export interface Pair<T> {
  readonly reference: T;
  readonly engine: T;
}

/** The engine binding for `fixture`: Workerflow's, one definition each. */
export const engineBinding = (fixture: string): Workflow =>
  new Workflow(env.ENGINE, fixture);

/** Calls `create` on each engine's binding, with the same params. */
export const start = async (
  fixture: string,
  params: unknown = {}
): Promise<Pair<Instance>> => {
  const tag = crypto.randomUUID().slice(0, 8);
  const [reference, engine] = await Promise.all([
    env.REFERENCE.create({
      id: `reference-${fixture}-${tag}`,
      params: { fixture, params },
    }),
    engineBinding(fixture).create({ id: `engine-${fixture}-${tag}`, params }),
  ]);
  return { reference, engine };
};

/** `call` on each engine, side by side. */
export const onBoth = async <T>(
  pair: Pair<Instance>,
  call: (instance: Instance) => Promise<T>
): Promise<Pair<T>> => {
  const [reference, engine] = await Promise.all([
    call(pair.reference),
    call(pair.engine),
  ]);
  return { reference, engine };
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

/** An instance's status, its `status` field alone. */
export const statusName = async (instance: Instance): Promise<unknown> =>
  field(await instance.status(), "status");

const terminal = new Set(["complete", "errored", "terminated"]);

/** Polls the instance until its status is one of `statuses`. */
export const reached = async (
  instance: Instance,
  statuses: ReadonlySet<string> = terminal
): Promise<unknown> => {
  const started = Date.now();
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling, one read at a time
    const status = await instance.status();
    const name = field(status, "status");
    if (typeof name === "string" && statuses.has(name)) {
      return status;
    }
    if (Date.now() - started > deadlineMs) {
      throw new Error(
        `${instance.id} never reached ${[...statuses].join(" or ")}: ${JSON.stringify(status)}`
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- polling, one read at a time
    await scheduler.wait(pollMs);
  }
};

/** A run's outcome as both engines' statuses share it. */
export interface Outcome {
  readonly status: unknown;
  readonly output?: unknown;
  readonly error?: { readonly name: unknown; readonly message: unknown };
}

/** The shared fields of a status: its name, its output, its error. */
export const outcomeOf = (status: unknown): Outcome => {
  const name = field(status, "status");
  const error = field(status, "error");
  if (name === "complete") {
    return { status: name, output: field(status, "output") };
  }
  if (name === "errored") {
    return {
      status: name,
      error: { name: field(error, "name"), message: field(error, "message") },
    };
  }
  return { status: name };
};

/** Runs `fixture` on both engines to its end, and reads how each ended. */
export const ran = async (
  fixture: string,
  params: unknown = {}
): Promise<Pair<Outcome> & { readonly instances: Pair<Instance> }> => {
  const instances = await start(fixture, params);
  const outcomes = await onBoth(instances, async (instance) =>
    outcomeOf(await reached(instance))
  );
  return { ...outcomes, instances };
};

/** What the fixture's callbacks noted on each engine. */
export const notes = (pair: Pair<Instance>): Pair<unknown[]> => ({
  reference: notesOf(pair.reference.id),
  engine: notesOf(pair.engine.id),
});

/** A call's result, or the error it threw: its name and message. */
export type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly name: string; readonly message: string };

export const settle = async <T>(
  call: () => Promise<T>
): Promise<Settled<T>> => {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return error instanceof Error
      ? { ok: false, name: error.name, message: error.message }
      : { ok: false, name: "not an error", message: String(error) };
  }
};

/** Whether the call threw an error whose message holds `fragment`. */
export const threwWith = (
  settled: Settled<unknown>,
  fragment: string
): boolean => !settled.ok && settled.message.includes(fragment);

/** What an event says of its instance, apart from what happened. */
const instanceFields = new Set([
  "instanceId",
  "eventId",
  "timestamp",
  "params",
]);

/**
 * Every event a subscription with `options` delivers until the run ends,
 * as delivered. Each read races the deadline, and the subscription is
 * disposed however the reading ends, so a read left pending is released.
 */
export const delivered = async (
  instance: Instance,
  options?: SubscribeOptions
): Promise<unknown[]> => {
  const subscription = await instance.subscribe(options);
  const deadline = Promise.withResolvers<"expired">();
  const timer = setTimeout(() => {
    deadline.resolve("expired");
  }, deadlineMs);
  const values: unknown[] = [];
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a subscription answers one event at a time
      const result = await Promise.race([
        subscription.next(),
        deadline.promise,
      ]);
      if (result === "expired") {
        throw new Error(`the events of ${instance.id} never ended`);
      }
      if (result.done === true) {
        return values;
      }
      values.push(result.value);
    }
  } finally {
    clearTimeout(timer);
    subscription[Symbol.dispose]();
  }
};

/**
 * Reads the run's events until one of `type` arrives, and returns it: the
 * run has got there, whether or not it has ended. Bounded and disposed as
 * `delivered`.
 */
export const arrived = async (
  instance: Instance,
  type: string
): Promise<unknown> => {
  const subscription = await instance.subscribe();
  const deadline = Promise.withResolvers<"expired">();
  const timer = setTimeout(() => {
    deadline.resolve("expired");
  }, deadlineMs);
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a subscription answers one event at a time
      const result = await Promise.race([
        subscription.next(),
        deadline.promise,
      ]);
      if (result === "expired" || result.done === true) {
        throw new Error(`${instance.id} never got to ${type}`);
      }
      if (field(result.value, "type") === type) {
        return result.value;
      }
    }
  } finally {
    clearTimeout(timer);
    subscription[Symbol.dispose]();
  }
};

/**
 * Every event a subscription delivers until the run ends, without what is
 * the instance's own (its ID, its event numbers and times) and without
 * `workflow_started`'s params, which the reference's adapter wraps.
 */
export const eventsOf = async (
  instance: Instance
): Promise<Record<string, unknown>[]> => {
  const values = await delivered(instance);
  return values.map((value) => {
    const entries =
      typeof value === "object" && value !== null ? Object.entries(value) : [];
    return Object.fromEntries(
      entries.filter(([key]) => !instanceFields.has(key))
    );
  });
};

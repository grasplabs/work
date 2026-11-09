import { isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { sealedBuildLimits } from "@grasp-os/shared/sealed-builds";
import { expressionFailed } from "@grasp-os/shared/workflows";

import { AppError } from "./app-error.ts";
import type { WorkflowEngine } from "./engine.ts";
import { memberName, membersOf } from "./member-names.ts";
import type { AnySchema } from "./value-schema.ts";
import { invalidCall, issueText, WorkflowError } from "./workflow-error.ts";
import { eventWaitSchema } from "./workflow-steps.ts";
import type {
  CallOptions,
  CaughtError,
  Decision,
  DecisionRequest,
  Duration,
  EventWaitRequest,
  GenerateRequest,
  StepOptions,
} from "./workflow-steps.ts";
import type { WorkflowPermissions } from "./workflow.ts";

// The journal a workflow's handler runs on: the `ctx` whose every call is
// a step of its own, journaled under its step's name, on the engine the
// run host implements (engine.ts). Its threat model is workflow.ts's.
//
// The engine names each step `<step>:<part>`, and from a call's second
// run on (in a loop's items) `<step>:<part>@<count>`, its count of
// earlier runs; a decision's asking, the time it asked and its wait are
// `#ask`, `#asked` and `#answer` after its `task`:
//
// | call | parts, and what each records |
// | --- | --- |
// | a connection's action, a module, the model | `task`: `{ output }`, or `{ output, state }` |
// | a decision | `enter`: `{ recipients, prompt, input }`; `task`: the decision opened; `task#ask`; `task#asked`: when; `task#answer`: the wait |
// | an event wait | `enter`, with a match only: `{ key }`; `task`: the wait (`engine.listen`) |
// | a sleep | `task`: the sleep |
// | a sleep until a deadline | `enter`: `{ output: null, until }`; `task`: the sleep |
// | the run's result | `workflow:output`: `{ output }` |

/**
 * The runtime's built-ins, kept as this module loads: a run's main module
 * loads the SDK before any of the workflow's code, which could otherwise
 * put its own in their place.
 */
const { freeze, defineProperty } = Object;
const { isArray } = Array;
const { now } = Date;

/** A step's ID, as the format has it: an identifier. */
const stepPattern = /^[a-z][A-Za-z0-9]{0,63}$/u;

/**
 * A value the code computed, as JSON, as `JSON.stringify` writes it:
 * `undefined`, which JSON has no value for, is `null` on its own and in a
 * list, and an object's member set to it is left out; a number JSON can't
 * write (`NaN`, `±Infinity`) is `null`, and `-0` is `0`. Anything else
 * that isn't JSON (a function, a symbol, a bigint) is a `TypeError`.
 */
export const jsonValue = (value: unknown): Json => {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "number") {
    // `+ 0` makes `-0` `0`, as JSON writes it.
    return Number.isFinite(value) ? value + 0 : null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (isArray(value)) {
    return value.map((item: unknown) => jsonValue(item));
  }
  if (typeof value !== "object") {
    throw new TypeError("A workflow's values are JSON.");
  }
  const members: [string, Json][] = [];
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) {
      members.push([key, jsonValue(member)]);
    }
  }
  // Own fields, `__proto__` among them, as `fromEntries` defines each.
  return Object.fromEntries(members);
};

/**
 * `value` as data a workflow reads: JSON (`jsonValue`: `undefined` is
 * `null` in a list and left out of an object), every object copied into
 * one with no prototype and every object and list frozen, all the way
 * down. A field named `__proto__` or `constructor` is an own field holding
 * data like any other.
 */
/** `value`'s objects with no prototype, and every object and list frozen, in place. */
const frozenInPlace = <Value>(value: Value): Value => {
  if (typeof value === "object" && value !== null) {
    if (!isArray(value)) {
      Object.setPrototypeOf(value, null);
    }
    for (const item of Object.values(value)) {
      frozenInPlace(item);
    }
    freeze(value);
  }
  return value;
};

/**
 * A copy of `value`, a run's args as their schema checked them, as data
 * a workflow reads (`frozenData`), of its own type.
 */
export const frozenCopy = <Value>(value: Value): Value =>
  frozenInPlace(structuredClone(value));

export const frozenData = (value: unknown): Json => {
  const json = jsonValue(value);
  if (json === null || typeof json !== "object") {
    return json;
  }
  if (isArray(json)) {
    return freeze(json.map((item: Json) => frozenData(item)));
  }
  const copy: Record<string, Json> = {};
  Object.setPrototypeOf(copy, null);
  for (const [key, item] of Object.entries(json)) {
    defineProperty(copy, key, {
      value: frozenData(item),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return freeze(copy);
};

/**
 * `value` with no prototype, frozen: an object this module built, of its
 * own fields only, each data already.
 */
const dataObject = <Value extends object>(value: Value): Value => {
  Object.setPrototypeOf(value, null);
  return freeze(value);
};

/** A caught failure of `code` and `message`, as data (`dataObject`). */
const caughtOf = (
  code: string,
  message: string,
  details?: unknown,
  step?: string
): CaughtError =>
  dataObject({
    code,
    message,
    ...(details === undefined ? {} : { details: frozenData(details) }),
    ...(step === undefined ? {} : { step }),
  });

/**
 * A failure the run host sent, as a catch reads it: its code, its message
 * and its details, and its step where it names one; anything else of it
 * is dropped. Not of that shape, it is the platform's unexpected failure.
 */
const caughtFrom = (failure: Json): CaughtError => {
  if (
    isRecord(failure) &&
    typeof failure.code === "string" &&
    typeof failure.message === "string"
  ) {
    const { code, message, details, step } = failure;
    return caughtOf(
      code,
      message,
      details,
      typeof step === "string" ? step : undefined
    );
  }
  return caughtOf(expressionFailed, "The expression failed.");
};

/**
 * A call's failure, as the run host failed its step: its code, message
 * and details, and the step. Thrown on by the code where no catch takes
 * it, as the host's own failure.
 */
export class StepFailureError extends Error {
  readonly code: string;
  readonly caught: CaughtError;

  constructor(caught: CaughtError) {
    super(caught.message);
    this.name = "StepFailureError";
    this.code = caught.code;
    this.caught = caught;
  }
}

/**
 * An error a call failed with, as a catch reads it: frozen data with no
 * prototype (`CaughtError`). A run host's failure keeps its code, its
 * message and its details; the workflow's own `AppError` likewise; a
 * failure of the code itself (an expression that read a field of `null`)
 * is `expression.failed`, its words the platform's, never a value's.
 */
export const caughtError = (thrown: unknown): CaughtError => {
  if (thrown instanceof StepFailureError) {
    return thrown.caught;
  }
  if (thrown instanceof AppError) {
    return caughtOf(thrown.code, thrown.message, thrown.details);
  }
  if (thrown instanceof WorkflowError) {
    return caughtOf(thrown.code, thrown.message);
  }
  return caughtOf(expressionFailed, "The expression failed.");
};

/** `error`, as a call's step failed with it, for its catch. */
const failureOf = (error: unknown, step: string): unknown => {
  if (
    error instanceof StepFailureError ||
    error instanceof WorkflowError ||
    !(error instanceof Error)
  ) {
    return error;
  }
  const code: unknown = Reflect.get(error, "code");
  if (typeof code !== "string") {
    return error;
  }
  const details: unknown = Reflect.get(error, "details");
  return new StepFailureError(caughtOf(code, error.message, details, step));
};

/** A duration in milliseconds, as the format writes one. */
const durationUnits: Readonly<Record<string, number>> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

const durationPattern =
  /^(?<count>[1-9][0-9]{0,8}) (?<unit>second|minute|hour|day|week)s?$/u;

const millisecondsOf = (duration: Duration): number => {
  const groups = durationPattern.exec(duration)?.groups;
  const ms = Number(groups?.count) * (durationUnits[groups?.unit ?? ""] ?? 0);
  if (
    !Number.isSafeInteger(ms) ||
    ms <= 0 ||
    ms > sealedBuildLimits.deadlineMs
  ) {
    throw invalidCall(`"${duration}" isn't a duration of up to a year`);
  }
  return ms;
};

/** A member path being built: its leaf, where a name ends, and what follows. */
interface MemberNode {
  leaf?: unknown;
  readonly children: Map<string, MemberNode>;
}

/** `node`'s members, frozen objects with no prototype (`membersOf`). */
const builtMembers = (node: MemberNode): Readonly<Record<string, unknown>> =>
  membersOf(
    [...node.children].map(([member, child]) => [
      member,
      child.leaf ?? builtMembers(child),
    ])
  );

/** Refuses action `name`, which stands where another's member is. */
const overlapping = (name: string): WorkflowError =>
  new WorkflowError(
    "workflow.invalid_definition",
    `Action "${name}" stands where another action's member is.`
  );

/**
 * Members of `names`, each a path of members (`mail.send` is
 * `.mail.send`, each segment through `memberName`), its leaf `leafOf` the
 * declared name: frozen objects with no prototype. Two names whose paths
 * meet where one ends are refused.
 */
const pathMembers = (
  names: readonly string[],
  leafOf: (name: string) => unknown
): Readonly<Record<string, unknown>> => {
  const root: MemberNode = { children: new Map() };
  for (const name of names) {
    let node = root;
    for (const segment of name.split(".")) {
      const member = memberName(segment);
      const next = node.children.get(member) ?? { children: new Map() };
      node.children.set(member, next);
      node = next;
      if (node.leaf !== undefined) {
        throw overlapping(name);
      }
    }
    if (node.children.size > 0) {
      throw overlapping(name);
    }
    node.leaf = leafOf(name);
  }
  return builtMembers(root);
};

/**
 * What a decision's enter step records: whom it asks (a list of deciders,
 * the first its `from`), what and on what. Anything else fails the step.
 */
const askOf = (
  request: DecisionRequest
): { recipients: string[]; prompt: Json; input: Json } => {
  const recipients = jsonValue(request.recipients);
  if (
    !isArray(recipients) ||
    recipients.length === 0 ||
    !recipients.every((recipient) => typeof recipient === "string")
  ) {
    throw new TypeError(
      "A decision's recipients are a list of `person:`, `team:` and `role:` deciders."
    );
  }
  return {
    recipients: recipients.filter((recipient) => typeof recipient === "string"),
    prompt: jsonValue(request.prompt),
    input: jsonValue(request.input),
  };
};

/** What a sleep until a deadline's enter step records; anything else fails it. */
const deadlineOf = (until: number): { output: null; until: number } => {
  if (!Number.isSafeInteger(until) || until < 0) {
    throw new TypeError("A deadline is a whole number of ms since the epoch.");
  }
  return { output: null, until };
};

interface JournalConfig {
  readonly permissions: WorkflowPermissions;
  readonly state: Readonly<Record<string, AnySchema>>;
  readonly params: unknown;
}

/** `value`, held to `schema`, or a `TypeError` naming what doesn't fit. */
const fitted = (schema: AnySchema, value: unknown, what: string): Json => {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    throw new TypeError(`${what} validates asynchronously.`);
  }
  if (result.issues !== undefined) {
    throw new TypeError(
      `${what} isn't of its schema: ${issueText(result.issues)}`
    );
  }
  return jsonValue(result.value);
};

/**
 * The journaled `ctx` of one execution of a run on `engine` (see the
 * header), what freezes the handler's data, and what records its result.
 */
export const journaledCtx = (
  engine: WorkflowEngine,
  { permissions, state, params }: JournalConfig
): {
  ctx: object;
  recordResult: (step: string, result: unknown) => Promise<Json>;
} => {
  /** How many times each step ran in this execution. */
  const runs = new Map<string, number>();
  /**
   * The call running now, if any. Calls run one after another: one started
   * beside another would be journaled in an order a replay can't promise
   * to repeat.
   */
  let running: string | undefined;

  /**
   * The engine name of each part of this run of `step` (see the header),
   * once its options are checked.
   */
  const named = (
    options: unknown
  ): { step: string; part: (part: string) => string } => {
    const step = isRecord(options) ? options.step : undefined;
    if (typeof step !== "string" || !stepPattern.test(step)) {
      throw invalidCall(
        'A ctx call names its step: `{ step: "<id>" }`, an identifier'
      );
    }
    const count = runs.get(step) ?? 0;
    runs.set(step, count + 1);
    const suffix = count === 0 ? "" : `@${String(count)}`;
    return { step, part: (part) => `${step}:${part}${suffix}` };
  };

  /** Runs `call`, the only one running, its failures its step's. */
  const exclusive = async <T>(
    step: string,
    call: () => Promise<T>
  ): Promise<T> => {
    if (running !== undefined) {
      throw invalidCall(
        `Step "${step}" started while step "${running}" runs; await each call before the next`
      );
    }
    running = step;
    try {
      return await call();
    } catch (error) {
      throw failureOf(error, step);
    } finally {
      running = undefined;
    }
  };

  /** What a call's step keeps in state, each value held to its key's schema. */
  const kept = (
    keep: CallOptions["state"],
    output: Json
  ): Record<string, Json> | undefined => {
    if (keep === undefined) {
      return undefined;
    }
    const values = keep(frozenData(output));
    const record: Record<string, Json> = {};
    for (const [key, value] of Object.entries(values)) {
      const schema = Object.hasOwn(state, key) ? state[key] : undefined;
      if (schema === undefined) {
        throw new TypeError(`The workflow keeps no "${key}" in its state.`);
      }
      record[key] = fitted(schema, value, `State "${key}"`);
    }
    return record;
  };

  /** The retry choice the run host asks once a call's step failed. */
  const retryOf = (
    retry: CallOptions["retry"]
  ): ((error: Json) => Promise<unknown>) | undefined => {
    if (retry === undefined) {
      return undefined;
    }
    if (retry === true) {
      return async () => await Promise.resolve(true);
    }
    return async (failure) => await Promise.resolve(retry(caughtFrom(failure)));
  };

  /** A call through binding `alias`, as its step's one `task`. */
  const call =
    (alias: string, operation: string) =>
    async (args: unknown, options: CallOptions): Promise<Json> => {
      const { step, part } = named(options);
      return await exclusive(step, async () => {
        const sent = args === undefined ? {} : jsonValue(args);
        const record = await engine.do(
          part("task"),
          {},
          async () => {
            const binding = engine.env[alias];
            const method = binding?.call;
            if (method === undefined) {
              throw new WorkflowError(
                "workflow.invalid_step_call",
                `This workflow has no permission named ${alias}.`
              );
            }
            const output = jsonValue(await method(operation, sent));
            const writes = kept(options.state, output);
            return writes === undefined
              ? { output }
              : { output, state: writes };
          },
          retryOf(options.retry)
        );
        return frozenData(record.output);
      });
    };

  const connections = membersOf(
    Object.entries(permissions.connections ?? {}).map(([alias, actions]) => [
      alias,
      pathMembers(Object.keys(actions), (path) =>
        call(alias, actions[path] ?? path)
      ),
    ])
  );

  const modules = membersOf(
    Object.entries(permissions.modules ?? {}).map(([alias, kind]) => [
      alias,
      call(alias, kind === "compute" ? "grasp.compute" : "grasp.action"),
    ])
  );

  const ai =
    permissions.ai === true
      ? membersOf([
          [
            "generate",
            async (request: GenerateRequest, options: CallOptions) =>
              await call("ai", "grasp.model")(
                { instructions: request.instructions, input: request.input },
                options
              ),
          ],
        ])
      : undefined;

  const ask = async (
    request: DecisionRequest,
    options: StepOptions
  ): Promise<Decision> => {
    const { step, part } = named(options);
    return await exclusive(step, async () => {
      const entered = await engine.do(
        part("enter"),
        {},
        async () => await Promise.resolve(askOf(request))
      );
      const task = part("task");
      const from = String(entered.recipients[0]);
      const timeout =
        request.timeout === undefined
          ? sealedBuildLimits.deadlineMs
          : millisecondsOf(request.timeout);
      // The engine sets the deadline as the decision opens, so time spent
      // asking never pushes it out, and no answer counts after it.
      const { decision, deadline } = await engine.do(
        task,
        { input: { from } },
        async () =>
          await engine.openDecision({
            step: task,
            from,
            description: step,
            timeout,
          })
      );
      await engine.do(`${task}#ask`, { input: { from } }, async () => {
        await engine.askDecision(decision);
      });
      const askedAt = await engine.do(
        `${task}#asked`,
        {},
        async () => await Promise.resolve(now())
      );
      const answer = await engine.waitForDecision(`${task}#answer`, {
        decision,
        timeout: Math.max(deadline - askedAt, 0),
        last: true,
      });
      const decided: Decision = answer.answered
        ? {
            timedOut: false,
            approved: answer.approved,
            by: answer.by,
            payload: frozenData(answer.payload),
          }
        : { timedOut: true };
      return dataObject(decided);
    });
  };

  const decisions = membersOf(
    (permissions.decisions ?? []).map((alias) => [
      alias,
      membersOf([["ask", ask]]),
    ])
  );

  const waitFor = async (
    request: EventWaitRequest<string>,
    options: StepOptions
  ): Promise<Json> => {
    const { step, part } = named(options);
    return await exclusive(step, async () => {
      const { match } = request;
      if (match !== undefined) {
        await engine.do(
          part("enter"),
          {},
          async () => await Promise.resolve({ key: jsonValue(match.equals) })
        );
      }
      if (engine.listen === undefined) {
        throw invalidCall(
          `Step "${step}" waits for an event, which only a sealed build's run host runs`
        );
      }
      return frozenData(
        eventWaitSchema.parse(await engine.listen(part("task")))
      );
    });
  };

  const events = membersOf(
    Object.keys(permissions.events ?? {}).map((alias) => [
      alias,
      membersOf([["waitFor", waitFor]]),
    ])
  );

  const sleep = async (
    duration: Duration,
    options: StepOptions
  ): Promise<void> => {
    const { step, part } = named(options);
    await exclusive(step, async () => {
      await engine.sleep(part("task"), millisecondsOf(duration));
    });
  };

  const sleepUntil = async (
    until: number,
    options: StepOptions
  ): Promise<void> => {
    const { step, part } = named(options);
    await exclusive(step, async () => {
      const entered = await engine.do(
        part("enter"),
        {},
        async () => await Promise.resolve(deadlineOf(until))
      );
      if (engine.sleepUntil === undefined) {
        throw invalidCall(
          `Step "${step}" sleeps until a deadline, which only a sealed build's run host runs`
        );
      }
      await engine.sleepUntil(part("task"), entered.until);
    });
  };

  // The state the run's start froze, read only as its declared keys whose
  // values fit (a value an older version kept may not), each other one
  // undefined.
  const snapshot: Record<string, Json> = {};
  for (const [key, schema] of Object.entries(state)) {
    const value = Object.hasOwn(engine.state, key)
      ? engine.state[key]
      : undefined;
    if (value !== undefined) {
      try {
        snapshot[key] = fitted(schema, value, key);
      } catch {
        // Unfit: read as never kept.
      }
    }
  }

  const ctx = membersOf<unknown>([
    ["run", frozenData({ id: engine.runId })],
    ["params", frozenData(params)],
    ["state", frozenData(snapshot)],
    ["inbox", frozenData(engine.inbox ?? {})],
    ["connections", connections],
    ["decisions", decisions],
    ["events", events],
    ["modules", modules],
    ["ai", ai],
    ["sleep", sleep],
    ["sleepUntil", sleepUntil],
  ]);

  const recordResult = async (step: string, result: unknown): Promise<Json> => {
    const recorded = await engine.do(
      step,
      {},
      async () => await Promise.resolve({ output: jsonValue(result) })
    );
    return recorded.output;
  };

  return { ctx, recordResult };
};

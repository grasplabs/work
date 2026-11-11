import { isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { sealedBuildLimits } from "@grasp-os/shared/sealed-builds";

import type { WorkflowEngine } from "./engine.ts";
import { memberName, membersOf } from "./member-names.ts";
import type { AnySchema } from "./value-schema.ts";
import { failureOf, retryOf } from "./workflow-caught.ts";
import { dataObject, frozenData, jsonValue } from "./workflow-data.ts";
import { millisecondsOf } from "./workflow-duration.ts";
import { invalidCall, issueText, WorkflowError } from "./workflow-error.ts";
import { eventWaitSchema } from "./workflow-steps.ts";
import type {
  CallOptions,
  ConnectionCallOptions,
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
// | a connection's action, a files or Brain action, the model | `task`: `{ output }`, or `{ output, state }` |
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
const { isArray } = Array;
const { now } = Date;

/** A step's ID, as the format has it: an identifier. */
const stepPattern = /^[a-z][A-Za-z0-9]{0,63}$/u;

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
 * Members of `declared`, each name a path of members (`mail.send` is
 * `.mail.send`, each segment through `memberName`) to the leaf
 * `leafOf` makes of what it is declared as: frozen objects with no
 * prototype. Two names whose paths meet where one ends are refused.
 */
const pathMembers = (
  declared: Readonly<Record<string, string>>,
  leafOf: (target: string) => unknown
): Readonly<Record<string, unknown>> => {
  const root: MemberNode = { children: new Map() };
  for (const [name, target] of Object.entries(declared)) {
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
    node.leaf = leafOf(target);
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

/**
 * A connection call's files permissions (`into`, `from`), as the call
 * sends them beside its arguments: none for any other call, and only
 * aliases. The host holds them to the build's.
 */
const filesOf = (
  options: ConnectionCallOptions
): { into?: string; from?: string } | undefined => {
  const { into, from } = options;
  if (into === undefined && from === undefined) {
    return undefined;
  }
  if (
    (into !== undefined && typeof into !== "string") ||
    (from !== undefined && typeof from !== "string")
  ) {
    throw invalidCall("A call's `into` and `from` name files permissions");
  }
  return {
    ...(into === undefined ? {} : { into }),
    ...(from === undefined ? {} : { from }),
  };
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
    // Counted only as its first engine step is named: a call that fails
    // before it journals anything (its arguments not JSON, say) uses no
    // run of its step, so the host's count and the code's stay alike.
    const count = runs.get(step) ?? 0;
    const suffix = count === 0 ? "" : `@${String(count)}`;
    let counted = false;
    return {
      step,
      part: (part) => {
        if (!counted) {
          counted = true;
          runs.set(step, count + 1);
        }
        return `${step}:${part}${suffix}`;
      },
    };
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
      // Held to its key's schema, but kept as the code wrote it: what the
      // host holds the record to is the sealed template, whose literals
      // are exactly the document's, never the schema's defaults filled in.
      fitted(schema, value, `State "${key}"`);
      // `undefined`, as JSON leaves it out of an object (`jsonValue`):
      // nothing written, as the host takes a slot's value left out.
      if (value !== undefined) {
        record[key] = jsonValue(value);
      }
    }
    return record;
  };

  /** A call through binding `alias`, as its step's one `task`. */
  const call =
    (alias: string, operation: string) =>
    async (args: unknown, options: ConnectionCallOptions): Promise<Json> => {
      const { step, part } = named(options);
      const files = filesOf(options);
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
            const output = jsonValue(
              await (files === undefined
                ? method(operation, sent)
                : method(operation, sent, files))
            );
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
      pathMembers(actions, (operation) => call(alias, operation)),
    ])
  );

  // An App's functions, each by its path, each call sending the function's
  // stable ID through the App permission's alias: the host holds it to
  // the sealed call, whose App and function the document gave.
  const apps = membersOf(
    Object.entries(permissions.apps ?? {}).map(([alias, functions]) => [
      alias,
      pathMembers(functions, (id) => call(alias, id)),
    ])
  );

  /**
   * The members of each files or brain permission: exactly the actions its
   * steps take, each a call of that action through its alias.
   */
  const actionMembers = (
    held: Readonly<Record<string, readonly string[]>> | undefined
  ) =>
    membersOf(
      Object.entries(held ?? {}).map(([alias, actions]) => [
        alias,
        membersOf(actions.map((action) => [action, call(alias, action)])),
      ])
    );
  const files = actionMembers(permissions.files);
  const brain = actionMembers(permissions.brain);

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
    ["run", frozenData({ id: engine.runId, startedAt: engine.startedAt })],
    ["params", frozenData(params)],
    ["state", frozenData(snapshot)],
    ["inbox", frozenData(engine.inbox ?? {})],
    ["connections", connections],
    ["apps", apps],
    ["decisions", decisions],
    ["events", events],
    ["files", files],
    ["brain", brain],
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

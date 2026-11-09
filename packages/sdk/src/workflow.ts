import { workflowIdSchema } from "@grasp-os/shared/ids";
import type { RunId, WorkflowId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";

import type { WorkflowEngine, WorkflowEnv } from "./engine.ts";
import {
  callMethod as callGuard,
  optionalChain as optionalGuard,
  readMember as readGuard,
} from "./expression-runtime.ts";
import type { ValueSchema } from "./value-descriptor.ts";
import type { AnySchema } from "./value-schema.ts";
import type { Infer } from "./value-types.ts";
import { v } from "./values.ts";
import { checkOrThrow, parseOrThrow, WorkflowError } from "./workflow-error.ts";
import {
  describeParams,
  resolveParams,
  validateParams,
} from "./workflow-params.ts";
import type { ParamMetadata, ParamValues, Params } from "./workflow-params.ts";
import { createRunner } from "./workflow-runner.ts";
import type { StepRunner } from "./workflow-steps.ts";

/**
 * Workflow SDK: what the code core generates from a grasp-workflow/1
 * document (@grasp-os/workflow-schema's generate.ts) runs on, and the only
 * API that code sees. A workflow declares its parameters, then runs its
 * steps in code, each with its options inline:
 *
 * ```ts
 * export default workflow("invoice-approval", {
 *   params: {
 *     threshold: {
 *       label: "Review invoices above",
 *       type: v.money().default({ minorUnits: 500_000, currency: "EUR" }),
 *     },
 *   },
 *   input: v.object({ invoice: v.number() }),
 * }, async (step, { params, env }) => {
 *   await step.do("book", { key: "task", description: "book" },
 *     async () => ({ output: await env.ledger.call("entries.create", { invoice: 7 }) }));
 * });
 * ```
 */

// Workflow code imports only this module, so it gets `v` from here too:
// a workflow declares its values as an App does.
export { v } from "./values.ts";
export { brain } from "./brain.ts";
// The guards a workflow's JavaScript expressions run through, as the
// code generated from them imports them (expression-check.ts,
// `runtimeNames`).
export { jsonValue } from "./expression-runtime.ts";

/**
 * A value an expression reads, as generated code holds it: any. Code
 * generated from an expression must type-check whatever its data
 * (`input.count + 1`, `(line) => line.length > 3`), and on the guards'
 * JSON every operator but `===` is a type error TypeScript makes of
 * JavaScript that runs well. What an expression reads is type-checked
 * against the workflow's schemas where it is written, never in the
 * generated code, where its data is only JSON. The guards still decide
 * everything at run time.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- see above
type Read = any;

/** `readMember`, for generated code: what it reads is `Read`. */
export const readMember: (object: unknown, key: string | number) => Read =
  readGuard;

/**
 * `callMethod`, for generated code: what it answers is `Read`, and a
 * callback's parameters are, as the arrow written in its place takes them.
 */
export const callMethod: (
  receiver: unknown,
  name: string,
  args: readonly (Json | ((...values: Read[]) => unknown))[]
) => Read = callGuard;

/** `optionalChain`, for generated code: on `Read` values. */
export const optionalChain: (value: Read, rest: (value: Read) => Read) => Read =
  optionalGuard;

/**
 * `value`, checked by `schema` as `v` checks a value: what it answers,
 * typed so, or a `TypeError` naming the first thing that doesn't fit,
 * which fails the step it runs in. What generated code holds what a step
 * records to (a decision's recipients, a deadline).
 */
export const parse = <Input, Output>(
  schema: ValueSchema<Input, Output>,
  value: unknown
): Output => {
  const result = schema["~standard"].validate(value);
  if (result.issues === undefined) {
    return result.value;
  }
  const [issue] = result.issues;
  const at = issue?.path.join(".") ?? "";
  throw new TypeError(
    `Not of its schema: ${at === "" ? "" : `at ${at}: `}${issue?.message ?? "not of its schema"}`
  );
};

/**
 * The items a loop's enter step recorded, each as every value an
 * expression reads (`Read`), so an item read bare (`100 * item`) compiles
 * as its expression was checked. The host holds the record to a list
 * (`workflow.collection_invalid`); anything else is a `TypeError` here.
 */
export const itemsOf: (items: Json) => readonly Read[] = (items) => {
  if (!Array.isArray(items)) {
    throw new TypeError("A loop's items are a list.");
  }
  const list: readonly Json[] = items;
  return list;
};
// What generated code holds the state it keeps and reads to.
export { fittedState, fittedValue } from "./fitted-value.ts";
// What a step records and a binding is handed: a workflow's code names it
// to narrow what a binding answers (`unknown`) into a step's result.
export type { Json } from "@grasp-os/shared/json";
export { WorkflowError } from "./workflow-error.ts";
export { sensitiveParam } from "./workflow-params.ts";
export type { Param, ParamMetadata } from "./workflow-params.ts";
export type {
  CaughtError,
  Decision,
  DecisionOptions,
  DoOptions,
  Duration,
  EventWait,
  Retries,
  RetryChoice,
  SleepOptions,
  StepRunner,
  WorkflowEvent,
} from "./workflow-steps.ts";

/**
 * The runtime's `Object.freeze`, kept as this module loads: a run's main
 * module (core's workflows/sealed-isolate.ts) loads it before any of the App's code,
 * which could otherwise put its own in its place.
 */
const { freeze } = Object;

/** `value` frozen all the way down: JSON a run reads and never changes. */
const frozenJson = <Value extends Json | undefined>(value: Value): Value => {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      frozenJson(item);
    }
    freeze(value);
  }
  return value;
};

/** Everything a workflow reads besides its steps. */
export interface WorkflowContext<P extends Params, Input> {
  runId: RunId;
  input: Input;
  params: ParamValues<P>;
  /**
   * What the workflow kept between its runs, by key, as this run's start
   * found it: the same in every execution of the run, whatever later runs
   * write meanwhile, and frozen. A step sets it only as its definition
   * seals, once it succeeded.
   */
  state: Readonly<Record<string, Json>>;
  /**
   * Where outsiders send this run's events, by the alias of an event
   * binding whose contract takes them from outside: for replies to the
   * run's mail, its reply address (`reply-<token>@<host>`), to give that
   * mail as its Reply-To. Each is the run's own, the same for its whole
   * life, and takes nothing once it ended. Anyone the mail reaches can
   * reply through it: a reply is checked against the contract, but who
   * sent it isn't vouched for. Its `authentication` says what SPF, DKIM
   * and DMARC found as the deployment's mail service received it, each of
   * which domain (`null` where it recorded nothing, and `dmarc` also where
   * its verdict isn't of `from`: several From headers or mailboxes, none
   * readable, another domain, or an address with several `@` or cut to
   * fit). A `dmarc` pass means
   * `from`'s domain is verified; which address at that domain may send
   * stays the domain's own policy. A reply
   * delivered again is the same event; a reply after the run ended, or
   * one sent automatically (an out-of-office), is dropped and audited. A test run gets placeholders that
   * reach nobody; any run not on a sealed build's run host, none.
   */
  inbox: Readonly<Record<string, string>>;
  /**
   * The run's bindings, by name; call them in a step's own function, each
   * written out as `env.NAME.method(…)` (see `WorkflowEnv`). A binding the
   * run has no permission for is refused when it is called
   * (`permission.denied`).
   */
  env: WorkflowEnv;
}

// Definition

/** What the UI shows about a workflow besides its steps, as plain JSON. */
interface WorkflowMetadata {
  id: WorkflowId;
  params: ParamMetadata[];
}

/** A workflow, ready for the runtime to run. */
export interface WorkflowDefinition<Output> {
  metadata: WorkflowMetadata;
  /**
   * Runs (or replays) one run on `engine`; `input` is checked first. A
   * `WorkflowError` keeps its code even through an engine that keeps only a
   * failed step's error name and message.
   */
  run: (engine: WorkflowEngine, input?: unknown) => Promise<Output>;
}

/**
 * Defines a workflow. `params` are the tunable values; `run` is the workflow
 * itself, with every step and its options written inline. Checks the
 * definition right away, so a bad one fails when it loads.
 */
export const workflow = <
  const P extends Params,
  Output,
  InputSchema extends AnySchema = ValueSchema<undefined, undefined>,
>(
  id: string,
  config: {
    params: P;
    /** The run's input, as `v` declares it, e.g. the invoice that started it. */
    input?: InputSchema;
  },
  run: (
    step: StepRunner,
    context: WorkflowContext<P, Infer<InputSchema>>
  ) => Promise<Output>
): WorkflowDefinition<Output> => {
  const workflowId = parseOrThrow(
    workflowIdSchema,
    id,
    "workflow.invalid_definition",
    "Workflow ID"
  );
  validateParams(config.params);
  // With no input declared, a run takes none.
  const inputSchema: AnySchema = config.input ?? v.null().optional();

  const runOnce = async (
    engine: WorkflowEngine,
    rawInput: unknown
  ): Promise<Output> => {
    // SAFETY: checked by `config.input`, or to be null or left out when
    // there is none, as the default of `InputSchema` says.
    const input = checkOrThrow(
      inputSchema,
      rawInput,
      "workflow.invalid_input",
      "Input"
    ) as Infer<InputSchema>;
    // Recorded, so a replay runs with the values the run started with. A
    // value that doesn't fit fails for good: the error is non-retryable.
    const params = await engine.do(
      "$params",
      {},
      async () =>
        await Promise.resolve(resolveParams(config.params, engine.params))
    );
    const runner = createRunner(engine);
    return await run(
      // SAFETY: the untyped runner takes every call the typed one allows
      // and checks each option at run time.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      runner.steps as StepRunner,
      {
        runId: engine.runId,
        inbox: Object.freeze({ ...engine.inbox }),
        input,
        // SAFETY: resolveParams checks every declared parameter with its
        // type, which is what ParamValues<P> describes.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        params: Object.freeze(params) as ParamValues<P>,
        state: frozenJson(engine.state),
        // The host builds the run's bindings from its permissions; a
        // binding the run doesn't have when it calls fails then
        // (`permission.denied`).
        env: engine.env,
      }
    );
  };

  // Frozen, so no code can put another `run` in its place once it is
  // made (a module that imports the workflow's own file, say): the run
  // is held to the steps its review shows this one running.
  const definition: WorkflowDefinition<Output> = {
    metadata: {
      id: workflowId,
      params: describeParams(config.params),
    },
    run: async (engine, rawInput) => {
      try {
        return await runOnce(engine, rawInput);
      } catch (error) {
        // Engines may keep only a failed step's error name and message;
        // the code is in the name, so the error comes back whole.
        throw WorkflowError.from(error) ?? error;
      }
    },
  };
  return freeze(definition);
};

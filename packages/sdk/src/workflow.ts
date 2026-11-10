import type { RunId } from "@grasp-os/shared/ids";

import type { WorkflowEngine } from "./engine.ts";
import { unlistedInheritedNames } from "./expression-runtime.ts";
import type { MemberName } from "./member-names.ts";
import type { ValueSchema } from "./value-descriptor.ts";
import type { AnySchema } from "./value-schema.ts";
import type { Infer } from "./value-types.ts";
import { v } from "./values.ts";
import { checkOrThrow, WorkflowError } from "./workflow-error.ts";
import { frozenCopy, journaledCtx } from "./workflow-journal.ts";
import {
  describeParams,
  resolveParams,
  validateParams,
} from "./workflow-params.ts";
import type { ParamMetadata, ParamValues, Params } from "./workflow-params.ts";
import type {
  CallOptions,
  Decision,
  DecisionRequest,
  Duration,
  EventWait,
  EventWaitRequest,
  GenerateRequest,
  Read,
  StepOptions,
} from "./workflow-steps.ts";

/**
 * Workflow SDK: what the code core generates from a grasp-workflow/2
 * document (@grasp-os/workflow-schema's generate.ts) runs on, and the only
 * API that code sees. It reads as an App's code does: a workflow declares
 * its args, what it returns, its parameters and its permissions, and its
 * handler calls what it may reach through `ctx`, each call journaling
 * itself under its step:
 *
 * ```ts
 * export default defineWorkflow({
 *   args: v.object({ customer: v.string() }),
 *   returns: v.object({ id: v.string() }),
 *   permissions: { connections: { stripe: { "invoices.create": "invoices.create" } } },
 *   handler: async (ctx, args) => {
 *     const invoice = await ctx.connections.stripe.invoices.create(
 *       { customer: args.customer },
 *       { step: "invoice" }
 *     );
 *     return { id: invoice.id };
 *   },
 * });
 * ```
 *
 * Threat model, and how each is closed (the host's half is core's
 * workflows/sealed-run.ts):
 *
 * - Prototype access through data. Every value the handler reads (its
 *   args, parameters, state, inbox, each call's result, each event, each
 *   decision, each caught error) is JSON copied into objects with no
 *   prototype, frozen all the way down (`frozenData`, workflow-journal.ts),
 *   on a first run and on a replay alike: a field nobody wrote, `__proto__`
 *   and `constructor` included, is `undefined` or an own field holding
 *   data, never something inherited, and nothing changes it. The check of
 *   expressions (`@grasp-os/sdk/expression-check`) is the first layer, the
 *   isolate's frozen intrinsics the third.
 * - Members exposing undeclared names. `ctx.connections`, `ctx.decisions`,
 *   `ctx.events`, `ctx.modules` and `ctx.ai` are built only from
 *   `permissions`, as frozen objects with no prototype (`membersOf`),
 *   never a `Proxy`: an alias or action nobody declared, `constructor`
 *   and `__proto__` included, is `undefined`, and calling it is a
 *   `TypeError` before anything is journaled.
 * - Replay determinism without enter steps. A call's journal name is its
 *   step's ID and part, and from its second run in a loop on, the count
 *   of its earlier runs (`<step>:task@2`): deterministic as long as the
 *   code is, which it is, as its expressions read only journaled values
 *   and frozen inputs. Flow (an `if`, a loop's items) is evaluated again
 *   on replay from the same values, so it takes the same path. A step
 *   already journaled answers from the journal, its arguments not
 *   compared again: what keeps a replay on the same path is that the code
 *   is a pure function of journaled values, not a check. What a replay
 *   does past the journal is a call like any other, held to its sealed
 *   template and to the next run of its step (`@n`), so a replay that
 *   diverged reaches nothing the build doesn't seal.
 * - A call the build didn't seal. The members are the code's convenience:
 *   the host decides every call by the build's sealed table (the step a
 *   call names, its permission, its action, every literal of its
 *   arguments), whatever member made it, and refuses anything else.
 */

// Workflow code imports only this module (and its generated helpers), so
// it gets `v` and `AppError` from here: a workflow declares its values and
// raises its errors as an App does.
export { v } from "./values.ts";
export { AppError } from "./app-error.ts";
export { WorkflowError } from "./workflow-error.ts";
export { sensitiveParam } from "./workflow-params.ts";
export type { Json } from "@grasp-os/shared/json";
export type { Param, ParamMetadata } from "./workflow-params.ts";
export type {
  CallOptions,
  CaughtError,
  Decision,
  DecisionRequest,
  Duration,
  EventWait,
  EventWaitRequest,
  GenerateRequest,
  StepOptions,
  WorkflowEvent,
} from "./workflow-steps.ts";

/**
 * What a workflow may reach, as its handler calls it: its model
 * (`ai: true`), each connection's actions by alias, its decisions' and
 * event permissions' aliases (an event permission with the types it
 * waits for), and its own modules, each a compute or an action.
 *
 * A connection's actions are each its member path (`send`, or a dotted
 * one, `invoices.create`) and the operation its call names, as the host's
 * catalog has it (`mail.send`): an App's connection lists the action as
 * its contract names it (`send`), so a workflow's member reads the same,
 * and the host still gets the operation its build seals.
 */
export interface WorkflowPermissions {
  readonly ai?: true;
  readonly connections?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly decisions?: readonly string[];
  readonly events?: Readonly<Record<string, readonly string[]>>;
  readonly modules?: Readonly<Record<string, "compute" | "action">>;
}

/** A call of a connection's action, or of one of the workflow's modules. */
export type CallMember = (args: unknown, options: CallOptions) => Promise<Read>;

type UnionToIntersection<Union> = (
  Union extends unknown ? (value: Union) => void : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

/** The member path of action `Name`: `mail.send` is `.mail.send`. */
type PathMembers<
  Name extends string,
  Leaf,
> = Name extends `${infer Head}.${infer Tail}`
  ? Readonly<Record<MemberName<Head>, PathMembers<Tail, Leaf>>>
  : Readonly<Record<MemberName<Name>, Leaf>>;

/** A connection's members: each of its actions, by its member path. */
export type ConnectionMembers<Actions extends string> = UnionToIntersection<
  Actions extends unknown ? PathMembers<Actions, CallMember> : never
>;

/** What a decision permission's member does. */
export interface DecisionMembers {
  readonly ask: (
    request: DecisionRequest,
    options: StepOptions
  ) => Promise<Decision>;
}

/** What an event permission's member does, for its types. */
export interface EventMembers<Type extends string> {
  readonly waitFor: (
    request: EventWaitRequest<Type>,
    options: StepOptions
  ) => Promise<EventWait<Type>>;
}

/** What the workflow's model does. */
export interface AiMembers {
  readonly generate: (
    request: GenerateRequest,
    options: CallOptions
  ) => Promise<Read>;
}

type ListedOf<List> = List extends readonly (infer Item extends string)[]
  ? Item
  : never;

/** What a workflow's handler reaches, as its permissions declare it. */
export interface WorkflowCtx<
  Permissions extends WorkflowPermissions,
  P extends Params,
> {
  readonly run: { readonly id: RunId };
  readonly params: ParamValues<P>;
  /**
   * What the workflow kept between its runs, by key, as this run's start
   * found it: only the keys it declares whose values fit their schemas,
   * the same in every execution of the run, and frozen.
   */
  readonly state: Readonly<Record<string, Read>>;
  /**
   * Where outsiders send this run's events, by the alias of an event
   * permission whose contract takes them from outside: for replies to the
   * run's mail, its reply address (`reply-<token>@<host>`).
   */
  readonly inbox: Readonly<Record<string, string>>;
  readonly connections: {
    readonly [
      Alias in keyof NonNullable<Permissions["connections"]>
    ]: ConnectionMembers<
      Extract<keyof NonNullable<Permissions["connections"]>[Alias], string>
    >;
  };
  readonly decisions: Readonly<
    Record<ListedOf<Permissions["decisions"]>, DecisionMembers>
  >;
  readonly events: {
    readonly [Alias in keyof NonNullable<Permissions["events"]>]: EventMembers<
      ListedOf<NonNullable<Permissions["events"]>[Alias]>
    >;
  };
  readonly modules: {
    readonly [Alias in keyof NonNullable<Permissions["modules"]>]: CallMember;
  };
  readonly ai: Permissions["ai"] extends true ? AiMembers : undefined;
  /** Durably pauses the run for `duration`. */
  readonly sleep: (duration: Duration, options: StepOptions) => Promise<void>;
  /** Durably pauses the run until `until`, in ms since the epoch. */
  readonly sleepUntil: (until: number, options: StepOptions) => Promise<void>;
}

/** What `defineWorkflow` takes. */
export interface WorkflowConfig<
  Args extends AnySchema,
  Returns extends AnySchema,
  P extends Params,
  Permissions extends WorkflowPermissions,
> {
  /** What starts a run, as `v` declares it. */
  readonly args?: Args;
  /** What a run ends with, recorded as its last step. */
  readonly returns?: Returns;
  /** The tunable values people set without touching the workflow. */
  readonly params?: P;
  /** The keys the workflow keeps between its runs, each its schema. */
  readonly state?: Readonly<Record<string, AnySchema>>;
  readonly permissions?: Permissions;
  readonly handler: (
    ctx: WorkflowCtx<Permissions, P>,
    args: Infer<Args>
  ) => Promise<unknown>;
}

/** What the UI shows about a workflow besides its steps, as plain JSON. */
interface WorkflowMetadata {
  params: ParamMetadata[];
}

/** A workflow, ready for the runtime to run. */
export interface WorkflowDefinition {
  readonly metadata: WorkflowMetadata;
  /**
   * Runs (or replays) one run on `engine`; its args are checked first. A
   * `WorkflowError` keeps its code even through an engine that keeps only
   * a failed step's error name and message.
   */
  readonly run: (engine: WorkflowEngine, args?: unknown) => Promise<unknown>;
}

/**
 * The runtime's `Object.freeze`, kept as this module loads: a run's main
 * module (core's workflows/sealed-isolate.ts) loads it before any of the
 * workflow's code, which could otherwise put its own in its place.
 */
const { freeze } = Object;

/** The engine step the run's parameters are recorded in. */
const paramsStep = "$params";

/** The engine step the run's result is recorded in. */
const resultStep = "workflow:output";

/**
 * Defines a workflow (see the header). Checks the definition right away,
 * so a bad one fails when it loads.
 */
export const defineWorkflow = <
  const Permissions extends WorkflowPermissions = Record<never, never>,
  const P extends Params = Record<never, never>,
  Args extends AnySchema = ValueSchema<
    Record<never, never>,
    Record<never, never>
  >,
  Returns extends AnySchema = AnySchema,
>(
  config: WorkflowConfig<Args, Returns, P, Permissions>
): WorkflowDefinition => {
  const params: Params = config.params ?? {};
  validateParams(params);
  if (typeof config.handler !== "function") {
    throw new WorkflowError(
      "workflow.invalid_definition",
      "A workflow's handler is a function."
    );
  }
  // With no args declared, a run takes an object of none.
  const argsSchema: AnySchema = config.args ?? v.object({});

  const runOnce = async (
    engine: WorkflowEngine,
    rawArgs: unknown
  ): Promise<unknown> => {
    // Its expressions were lowered for the value prototypes
    // `inheritedNames` lists: a runtime whose prototypes hold another
    // function would read a field of its name as that function.
    const unlisted = unlistedInheritedNames();
    if (unlisted.length > 0) {
      throw new WorkflowError(
        "workflow.invalid_definition",
        `This runtime's values inherit functions its expressions weren't lowered for: ${unlisted.join(", ")}.`
      );
    }
    // SAFETY: checked by `config.args`, or to be an empty object when there
    // is none, as the default of `Args` says.
    const args = checkOrThrow(
      argsSchema,
      rawArgs,
      "workflow.invalid_input",
      "Args"
    ) as Infer<Args>;
    // Recorded, so a replay runs with the values the run started with. A
    // value that doesn't fit fails for good: the error is non-retryable.
    const values = await engine.do(
      paramsStep,
      {},
      async () => await Promise.resolve(resolveParams(params, engine.params))
    );
    const { ctx, recordResult } = journaledCtx(engine, {
      permissions: config.permissions ?? {},
      state: config.state ?? {},
      params: values,
    });
    const result = await config.handler(
      // SAFETY: the journal builds exactly the members `permissions`
      // declares, as `WorkflowCtx` types them, and the parameters as
      // `resolveParams` checked them.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      ctx as WorkflowCtx<Permissions, P>,
      frozenCopy(args)
    );
    if (config.returns === undefined) {
      return null;
    }
    return await recordResult(resultStep, result);
  };

  // Frozen, so no code can put another `run` in its place once it is
  // made (a module that imports the workflow's own file, say): the run
  // is held to the steps its review shows this one running.
  return freeze({
    metadata: freeze({ params: describeParams(params) }),
    run: async (engine: WorkflowEngine, rawArgs?: unknown) => {
      try {
        return await runOnce(engine, rawArgs);
      } catch (error) {
        // Engines may keep only a failed step's error name and message;
        // the code is in the name, so the error comes back whole.
        throw WorkflowError.from(error) ?? error;
      }
    },
  });
};

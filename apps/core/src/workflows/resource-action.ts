import type { Json } from "@grasp-os/shared/json";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { rpcArgumentDepth } from "@grasp-os/shared/screens";
import { passedBound } from "@grasp-os/shared/value-bounds";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";

import { forSandbox } from "../bindings.ts";
import { capability, runInSession } from "../sandbox-session.ts";
import { sandbox } from "../sandbox.ts";
import {
  callStub,
  SandboxUnavailableError,
  sessionHost,
} from "../sandboxed.ts";
import type { LoadedModules, SealedCall } from "../workflow-builds.ts";
import {
  actionMain,
  actionMainModule,
  readAnswer,
  requestModule,
} from "../workflow-modules.ts";
import type { BuiltCall } from "./resource-calls.ts";
import { requireShape } from "./resource-calls.ts";

// A run's call of one of its workflow's own actions (platform
// specification 13.6; GRA-666 has the threat model): a `grasp.operation`
// task whose binding names `local:code/<file>.ts#<export>`. The action
// runs in an isolate of its own, as a calculation does (workflow-modules.ts:
// no env, no network, no clock, no randomness, no code generation), with
// one capability more: the host's `call`, through which each of the
// bindings it declared in `uses` is called. How each threat is closed:
//
// - Reaching a binding it didn't declare. The host takes an alias only if
//   the action's sealed contract lists it, with the kind it lists, and the
//   call goes to the binding the run's start froze under that alias, of
//   that kind (`makeCall`): nothing the action passes names a target.
// - Authority that changed since the start. Each call is decided again as
//   it is made, as every named call of a run is (resource-authority.ts),
//   and counts as one of its lineage's host calls.
// - Effects without a record. Each call leaves its own receipts, under an
//   idempotency key of its own: its step's, with its ordinal in the
//   attempt. An action's step is tried once (resource-host.ts), and a
//   replay answers its record and calls nothing.
// - Escaping its step. Calls are bounded in number per attempt
//   (`maxActionCalls`), and refused once the attempt is over (its
//   deadline, the run's lease): the capability dies with the call.
// - A refusal the action swallows. The first refusal of one of its calls
//   fails the task with that refusal, whatever the action did with it.

/** The most resource calls one attempt of an action makes. */
export const maxActionCalls = 32;

/** An action's failure, as a run fails with it. */
const actionFailed = (): Error =>
  workflowResourceErrors.create("workflow.action_failed");

const jsonSchema = z.json();

/** What an action asks of a connector binding: an operation, and its args. */
const connectorRequestSchema = z.strictObject({
  operation: z.string().min(1).max(256),
  arguments: jsonSchema,
});

/** What an action asks of an operation binding: its args. */
const operationRequestSchema = z.strictObject({ arguments: jsonSchema });

/** What the host does for an action's resource calls (resource-host.ts). */
export interface ActionEffects {
  /**
   * Makes `call`, the action's `ordinal`th of its attempt (from 1), as one
   * of its run's named calls: its lineage's host call, its authority, its
   * receipts.
   */
  readonly make: (call: BuiltCall, ordinal: number) => Promise<Json>;
  /**
   * Whose actions it is among, which the sandbox caps per owner: the
   * workflow's actions, apart from its runs, so an action never waits for
   * a place its own run holds.
   */
  readonly owner: string;
  /** The run's own sandbox session, on-prem: the action's parent there. */
  readonly parent?: string | undefined;
}

/**
 * What `callAction` holds of an action's host, out of the isolate's reach
 * (no method the isolate can call): whether it still takes calls, the
 * first refusal of one, and every call made, to wait for.
 */
interface ActionHostState {
  live: boolean;
  refusal: Error | undefined;
  readonly made: Promise<unknown>[];
}

/** How deep and big one call's arguments may be: a step's payload. */
const callBounds = {
  depth: rpcArgumentDepth,
  size: platformLimits.stepPayloadBytes,
};

/**
 * The host's one capability in an action's isolate. It bounds what
 * reaches it itself, inside `call`, so a refusal of its bounds counts as
 * any other: it stands, whatever the action makes of it. One call at a
 * time: a call the action doesn't wait for still runs after the one
 * before, and the host waits for every one before the task records.
 */
class ActionHost extends RpcTarget {
  readonly #uses: ReadonlyMap<string, string>;
  readonly #effects: ActionEffects;
  readonly #state: ActionHostState;
  #count = 0;
  #last: Promise<unknown> = Promise.resolve();

  constructor(
    uses: readonly { readonly alias: string; readonly kind: string }[],
    effects: ActionEffects,
    state: ActionHostState
  ) {
    super();
    this.#uses = new Map(uses.map(({ alias, kind }) => [alias, kind]));
    this.#effects = effects;
    this.#state = state;
  }

  /** Makes a call of binding `alias` that the action declared it uses. */
  async call(alias: unknown, request: unknown): Promise<Json> {
    const previous = this.#last;
    const made = (async (): Promise<Json> => {
      await Promise.allSettled([previous]);
      try {
        return await this.#call(alias, request);
      } catch (error) {
        this.#state.refusal ??=
          error instanceof Error
            ? error
            : workflowResourceErrors.create("workflow.call_denied");
        // Expected refusals as they are; anything else opaque to the
        // isolate, its detail kept for the task.
        throw forSandbox(error);
      }
    })();
    this.#last = made;
    this.#state.made.push(made);
    return await made;
  }

  async #call(alias: unknown, request: unknown): Promise<Json> {
    if (!this.#state.live) {
      throw workflowResourceErrors.create("workflow.call_denied");
    }
    if (passedBound([alias, request], callBounds) !== undefined) {
      throw workflowResourceErrors.create("workflow.call_invalid");
    }
    const kind = typeof alias === "string" ? this.#uses.get(alias) : undefined;
    if (typeof alias !== "string" || kind === undefined) {
      throw workflowResourceErrors.create("workflow.call_denied");
    }
    if (this.#count >= maxActionCalls) {
      throw workflowResourceErrors.create("workflow.action_call_limit", {
        limit: maxActionCalls,
      });
    }
    this.#count += 1;
    const ordinal = this.#count;
    if (kind === "connector") {
      const parsed = connectorRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw workflowResourceErrors.create("workflow.call_invalid");
      }
      return await this.#effects.make(
        {
          name: "grasp.connector",
          binding: alias,
          operation: parsed.data.operation,
          arguments: parsed.data.arguments,
          // An action passes its own values only: no parameter of the run.
          sensitive: [],
        },
        ordinal
      );
    }
    const parsed = operationRequestSchema.safeParse(request);
    if (kind !== "operation" || !parsed.success) {
      throw workflowResourceErrors.create("workflow.call_invalid");
    }
    return await this.#effects.make(
      {
        name: "grasp.operation",
        binding: alias,
        arguments: parsed.data.arguments,
      },
      ordinal
    );
  }
}

/**
 * Runs `call`, a task's call of one of its workflow's own actions, with
 * `input` the arguments the host built: its answer, checked against the
 * action's sealed contract, each of its resource calls made through
 * `effects`. Given up at `deadline` (the attempt's).
 */
export const callAction = async (
  env: Env,
  compute: LoadedModules,
  sdk: Readonly<Record<string, string>>,
  call: Extract<SealedCall, { name: "grasp.action" }>,
  input: Json,
  deadline: number,
  effects: ActionEffects
): Promise<Json> => {
  const contract = compute.contracts.get(`${call.module}#${call.export}`);
  // The build's load checked every action task names an action's contract.
  if (contract?.kind !== "operation") {
    throw workflowResourceErrors.create("workflow.call_invalid");
  }
  const checked = requireShape(contract.input, input, "arguments");
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw actionFailed();
  }
  const state: ActionHostState = { live: true, refusal: undefined, made: [] };
  const host = new ActionHost(contract.uses ?? [], effects, state);
  const modules = {
    ...compute.modules,
    ...sdk,
    ...requestModule({
      module: call.module,
      export: call.export,
      input: checked,
    }),
    [actionMainModule]: actionMain(compute.paths),
  };
  const running = (async (): Promise<unknown> => {
    const onHost = sessionHost(env);
    if (onHost === undefined) {
      const entrypoint = env.LOADER.get(null, () => ({
        ...sandbox,
        mainModule: actionMainModule,
        modules,
        env: {},
      })).getEntrypoint("Action");
      return await callStub(entrypoint, "run", [host]);
    }
    return await runInSession(onHost, {
      mainModule: actionMainModule,
      modules,
      entrypoint: "Action",
      method: "run",
      args: [{ capability: capability(host, ["call"]) }],
      cpuMs: sandbox.limits.cpuMs,
      wallMs: remaining,
      owner: effects.owner,
      // A child of the run's own session: a process of its reserve, never
      // one the run would wait for while it holds its own.
      ...(effects.parent === undefined ? {} : { parent: effects.parent }),
    });
  })();
  // Settled either way, so once the deadline won, what the sandbox still
  // answers goes nowhere, and no rejection is left unhandled.
  const outcome = (async () => {
    try {
      return { ok: true as const, value: await running };
    } catch (error) {
      return { ok: false as const, error };
    }
  })();
  const timer = Promise.withResolvers<never>();
  const timeout = setTimeout(() => {
    timer.reject(actionFailed());
  }, remaining);
  let settled: Awaited<typeof outcome> | undefined;
  let callsDone = false;
  try {
    settled = await Promise.race([outcome, timer.promise]);
    // No call from now on; every one made settles before the task records,
    // within the attempt's deadline: a call the action didn't wait for
    // still has its effect and its receipt, or its refusal, in this step.
    state.live = false;
    await Promise.race([Promise.allSettled(state.made), timer.promise]);
    callsDone = true;
  } catch {
    // The deadline won: the action failed, or a call of it outlived it.
  } finally {
    clearTimeout(timeout);
    state.live = false;
  }
  // A refusal of one of its calls stands, whatever the action made of it,
  // and even when the deadline ended it.
  if (state.refusal !== undefined) {
    throw state.refusal;
  }
  if (settled === undefined || !callsDone) {
    throw actionFailed();
  }
  if (!settled.ok) {
    // The sandbox not answering at all is the platform's, never the action's.
    if (settled.error instanceof SandboxUnavailableError) {
      throw settled.error;
    }
    throw actionFailed();
  }
  const answer = readAnswer(
    settled.value,
    platformLimits.stepPayloadBytes,
    actionFailed
  );
  return requireShape(contract.output, answer, "output");
};

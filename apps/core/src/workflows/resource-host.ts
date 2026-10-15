import { kitModuleName } from "@grasp-os/compiler";
import { generatedImport } from "@grasp-os/open-workflow/generate";
import type { Json } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import {
  executionErrors,
  maxAttemptTimeoutMs,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type { AttemptLease } from "@grasp-os/workerflow/run";
import { writeJson } from "@grasp-os/workflow-expressions/bounded-json";
import {
  compileExpression,
  evaluateExpression,
} from "@grasp-os/workflow-expressions/evaluate";
import type { CompiledExpression } from "@grasp-os/workflow-expressions/evaluate";
import { evaluatorLimits } from "@grasp-os/workflow-expressions/limits";
import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";

import { memberRole } from "../auth/identity.ts";
import { generatedModule } from "../workflow-builds.ts";
import type { LoadedBuild, SealedTask } from "../workflow-builds.ts";
import { settling } from "./code.ts";
import type { RunHostCalls, Settled } from "./code.ts";
import {
  forIsolate,
  fromIsolate,
  isCpuLimitKill,
  settle,
  toStepError,
} from "./host.ts";
import type { RunStep } from "./host.ts";
import { ResourceAttemptHost } from "./resource-attempt-host.ts";

// The host a run of an independent workflow's sealed build runs against
// (resource-runs.ts): the calls the generated code's SDK makes
// (`@grasp-os/sdk/open-workflow`), from an isolate with an empty env, no
// network and nothing else of core's. Everything the isolate sends is
// untrusted, the generated code's included: it was sealed by the host, but
// the isolate runs it, and anything there could ask anything.
//
// Threat model, and how each is closed:
//
// - A step the build doesn't have. Every step is named after a task of
//   the sealed task table, of the kind its call is (`task:<id>`, a `set`
//   for `do`, a `wait` for `sleep`), and a wait lasts exactly what was
//   sealed: anything else is refused, and fails the run.
// - An expression that isn't the build's, or another task's. An attempt
//   evaluates only the sealed table's entries of its own task, by number;
//   the source comes from the verified build, never from the isolate.
// - Authority from the isolate. `$params` are the values the run's start
//   froze, `$workflow` and `$task` the host's own record of the run and
//   the step; only `.`, `$input` and `$context` are data the run carries,
//   captured once as the step started, so a retry or a replay evaluates
//   what the step started with, and an evaluation can't swap its data.
// - An attempt acting after it ended. Its host acts only while the engine
//   says it holds its lease and its function hasn't returned
//   (`execution.stale_attempt` otherwise).
// - A person who left. A run acts for the person whose start admitted it,
//   who must still be an active member before each step.
// - The isolate spending core's CPU. Expressions run in core, each held to
//   the evaluator's fuel; an attempt evaluates each of its task's slots
//   once, as generated code does, so a looping isolate can't make core
//   evaluate without end. What a whole activation may spend is the
//   lineage quotas' to bound (not yet kept for these runs: resource-runs.ts).

/** The main module of a run of a sealed build (`openRunMain`). */
export const openRunModule = "grasp-open-run.js";

/** The calls of an attempt's host (`ResourceAttemptHost`), for the sandbox. */
export const resourceAttemptMethods = ["evaluate"] as const;

/** The SDK module the generated code imports, by its flat name. */
const sdkModule = kitModuleName(generatedImport);

/**
 * The main module of a run of an independent workflow's sealed build:
 * the generated module's definition run on the engine its SDK takes, each
 * call sent to core's host, each error in plain data both ways. It imports
 * the SDK before the generated module, so the definition the SDK makes is
 * frozen with the runtime's own `Object.freeze`.
 */
export const openRunMain = `import { WorkerEntrypoint } from "cloudflare:workers";
import ${JSON.stringify(sdkModule)};
import definition from ${JSON.stringify(generatedModule)};
${settling}
const unwrapped = (result) => {
  if (result.ok) {
    return result.value;
  }
  const error = new Error(result.error.message);
  error.name = result.error.name;
  if (result.error.code !== undefined) {
    error.code = result.error.code;
  }
  throw error;
};

export class Run extends WorkerEntrypoint {
  async run(host, { input }) {
    return await settled(async () => {
      if (definition?.metadata?.profile !== "grasp-open-workflow/1" || typeof definition.run !== "function") {
        throw new Error("The generated module doesn't export its workflow.");
      }
      const engine = {
        do: async (name, data, fn) =>
          unwrapped(await host.do(name, { input: data }, async (attempt) =>
            await settled(async () =>
              await fn({ evaluate: async (slot) => unwrapped(await attempt.evaluate(slot)) })))),
        sleep: async (name, milliseconds) => {
          unwrapped(await host.sleep(name, milliseconds));
        },
      };
      return await definition.run(engine, input);
    });
  }
}
`;

/** The run a host serves, as the dispatcher loaded it. */
export interface HostedResourceRun {
  runId: string;
  workflowId: string;
  version: number;
  /** Whom it acts for: the person whose start admitted it. */
  principal: string;
  /** Its input, as its start admitted it: `$workflow.input`. */
  input: Json;
  /** The parameter values its start froze: `$params`. */
  params: Record<string, Json>;
  /** When it was admitted, in ms: `$workflow.startedAt`. */
  createdAt: number;
  /** Its sealed build, verified. */
  build: LoadedBuild;
}

/** How the host reaches back into the dispatcher. */
export interface ResourceHostHooks {
  /** The engine's lease of a step's attempt, while it holds. */
  leaseOf: (key: string, attempt: number) => AttemptLease | undefined;
  /**
   * Hears of each call of an attempt's function into the isolate, with
   * what settles once its step ends in this activation (dispatcher.ts,
   * `afterCpuKill`).
   */
  attemptCall?: (call: Promise<unknown>, stepDone: Promise<unknown>) => void;
  /** Hears, once, that the isolate asked for what generated code never does. */
  tampered: (error: { name: string; message: string; code?: string }) => void;
  /** The activation's fuel for expressions: {@link activationFuel} if unset. */
  activationFuel?: number;
}

/** A task's step name, as the SDK names it (`task:<id>`). */
const taskStep = /^task:(?<id>[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/u;

/** What a `set` task's step captures: its input and the context. */
const capturedSchema = z.strictObject({
  input: z.strictObject({ input: z.json(), context: z.json() }),
});

/** What core reads of the context the engine gives an attempt. */
const attemptContextSchema = z.object({
  attempt: z.int().positive(),
  idempotencyKey: z.string().min(1),
});

/**
 * A step's retries: platform failures (a timeout, the isolate's CPU) are
 * tried again; an expression's failure is the same every time, and isn't
 * (`isRetryable`).
 */
const stepConfig = {
  retries: { limit: 2, delay: 1000, backoff: "exponential" as const },
  timeout: maxAttemptTimeoutMs,
};

const maxResultBytes = platformLimits.stepPayloadBytes;

/**
 * What a step captures may take as JSON: its input and context, each at
 * most what a step records, and their framing.
 */
const maxCapturedBytes = 2 * platformLimits.stepPayloadBytes + 64;

/**
 * `value`, from the isolate, as plain JSON within `maxBytes`: written once
 * by the bounded writer before anything else reads it, so a value past the
 * bound (or a small graph of shared references that expands past it) costs
 * core no more than that much. Why it isn't, otherwise.
 */
const boundedJson = (
  value: unknown,
  maxBytes: number
):
  | { ok: true; value: Json }
  | { ok: false; refusal: "too_large" | "invalid" } => {
  const written = writeJson(value, {
    maxBytes,
    maxDepth: evaluatorLimits.maxJsonDepth + 2,
    maxNodes: maxBytes,
    sortKeys: false,
    safeIntegers: false,
  });
  if (!written.ok) {
    return written;
  }
  const parsed = z.json().safeParse(JSON.parse(written.text));
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, refusal: "invalid" };
};

/**
 * The jq fuel one attempt's expressions may spend together: eight
 * expressions' worth of the evaluator's own per-expression fuel (2^24,
 * workflow-expressions' jq.ts). That fuel is sized to about 100 ms of CPU
 * at worst (measured on V8 at 120,000 to 2,500,000 units a millisecond),
 * so an attempt spends at most about a second of core's CPU on
 * expressions, a sixtieth of its 60 s timeout, whatever its task holds
 * (at most 64 expressions, generate.ts) and however a step's three
 * attempts go. Real data transforms spend a tiny part of it. Running out
 * is `expression.budget_exhausted`, never retried: fuel is deterministic.
 */
const attemptFuel = 2 ** 27;

/**
 * The fuel one activation's attempts spend together on expressions: about
 * sixteen attempts' worst, some sixteen seconds of core's CPU, inside what
 * one invocation of the run's object may take. Each attempt's spend comes
 * off it; once it can't fund a whole attempt, the next is cut off as the
 * Loader cuts off an isolate past its CPU time (`isCpuLimitKill`), so the
 * engine parks its step for a retry and the activation suspends: the next
 * one, which replays what was recorded without evaluating it again, starts
 * from a fresh allowance. A long workflow goes on in turns, never holding
 * core's CPU for all its tasks at once.
 */
const activationFuel = 16 * attemptFuel;

/** One attempt of a task's step, from when the engine claims it. */
interface TaskAttempt {
  task: SealedTask;
  data: { input: Json; context: Json };
  /** When it started, in ms: `$task.startedAt`. */
  startedAt: number;
  key: string;
  number: number;
  /** The generation of the activation whose lease claimed it. */
  generation: number;
  /** When the engine gives up on it, by its lease: it acts no more after. */
  deadline: number;
  /** Whether its function has returned: its host acts no more. */
  over: boolean;
  /**
   * The slots it evaluated: generated code evaluates each of its task's
   * expressions once, so an attempt's evaluations, and the core CPU they
   * take, are bounded by its task's expressions in the sealed table.
   */
  evaluated: Set<number>;
  /** The fuel its evaluations have left together (`attemptFuel`). */
  budget: { fuel: number };
  /** Its evaluations under way: waited for before its fuel goes back. */
  pending: Set<Promise<unknown>>;
}

/** Expressions compiled once per build, by build hash and slot. */
const compiled = new Map<
  string,
  Promise<CompiledExpression<"taskDefinition">>
>();
const compiledMax = 256;

/**
 * One execution of a run of a sealed build, as its generated code's
 * engine. Every method answers `Settled`, never throws, so the error the
 * isolate sees is the one sent.
 */
export class ResourceRunHost
  extends RpcTarget
  implements RunHostCalls<ResourceAttemptHost>
{
  readonly #env: Env;
  readonly #step: RunStep;
  readonly #run: HostedResourceRun;
  readonly #hooks: ResourceHostHooks;
  #tampered: Error | undefined;
  /** Whether the Loader stopped the isolate past its CPU time. */
  #isolateStopped = false;
  /** The tasks whose step this activation asked for: each at most once. */
  readonly #asked = new Set<string>();
  /** What is left of this activation's fuel for expressions. */
  #activationFuel: number;

  constructor(
    env: Env,
    step: RunStep,
    run: HostedResourceRun,
    hooks: ResourceHostHooks
  ) {
    super();
    this.#env = env;
    this.#step = step;
    this.#run = run;
    this.#hooks = hooks;
    this.#activationFuel = hooks.activationFuel ?? activationFuel;
  }

  /**
   * Refuses, for good, what generated code never asks: the run fails with
   * it, whatever the isolate makes of the refusal.
   */
  #refuse(message: string): never {
    const error = workflowErrors.create("workflow.invalid");
    error.message = message;
    this.#tampered ??= error;
    this.#hooks.tampered(forIsolate(error));
    throw error;
  }

  /** The sealed task step `name` runs, of `kind`; refused otherwise. */
  #taskOf(name: unknown, kind: SealedTask["kind"]): SealedTask {
    if (this.#tampered !== undefined) {
      throw this.#tampered;
    }
    const id =
      typeof name === "string" ? taskStep.exec(name)?.groups?.id : undefined;
    const task = this.#run.build.tasks.find(
      (sealed) => sealed.id === id && sealed.kind === kind
    );
    if (task === undefined) {
      return this.#refuse(
        `The build has no ${kind} task as ${String(name).slice(0, 80)}.`
      );
    }
    // Each step at most once an activation, as generated code asks for it,
    // before anything is read: a module asking again, at once or in turn,
    // costs core nothing more.
    if (this.#asked.has(task.id)) {
      return this.#refuse(`Step of task "${task.id}" runs once.`);
    }
    this.#asked.add(task.id);
    return task;
  }

  /** The person the run acts for must still be an active member. */
  async #requirePerson(): Promise<void> {
    if (!(await memberRole(this.#env.DB, this.#run.principal))) {
      throw permissionErrors.create("permission.person_inactive");
    }
  }

  /**
   * Runs a `set` task's step: its function, in the isolate, gets a host of
   * the attempt through which it evaluates the task's expressions, on the
   * data the step captured. A replay answers the recorded output without
   * calling it.
   */
  async do(
    name: unknown,
    options: unknown,
    fn: (attempt: ResourceAttemptHost) => Promise<unknown>
  ): Promise<Settled<unknown>> {
    const stepDone = Promise.withResolvers<null>();
    try {
      return await settle(async () => {
        const task = this.#taskOf(name, "set");
        const bounded = boundedJson(options, maxCapturedBytes);
        const captured = capturedSchema.safeParse(
          bounded.ok ? bounded.value : undefined
        );
        if (!captured.success) {
          return this.#refuse("A task's step captures its input and context.");
        }
        const data = captured.data.input;
        await this.#requirePerson();
        const step = `task:${task.id}`;
        return await this.#step.do(step, stepConfig, async (context) => {
          const told = attemptContextSchema.parse(context);
          const lease = this.#hooks.leaseOf(told.idempotencyKey, told.attempt);
          if (lease === undefined) {
            throw new Error(`Step "${step}"'s attempt holds no lease`);
          }
          const attempt: TaskAttempt = {
            task,
            data,
            startedAt: Date.now(),
            key: told.idempotencyKey,
            number: told.attempt,
            generation: lease.generation,
            deadline: lease.deadline,
            over: false,
            evaluated: new Set(),
            budget: { fuel: attemptFuel },
            pending: new Set(),
          };
          // An activation that can't fund a whole attempt any more cuts it
          // off as the Loader does an isolate past its CPU time: its step
          // is retried in the next activation (see `activationFuel`). A
          // funded one holds its whole share from the start, so attempts
          // run at once can't each find the same fuel.
          const funded =
            !this.#isolateStopped && this.#activationFuel >= attemptFuel;
          if (funded) {
            this.#activationFuel -= attemptFuel;
          }
          const call = funded
            ? fn(
                new ResourceAttemptHost(
                  async (slot) => await this.#evaluate(attempt, slot)
                )
              )
            : Promise.reject(new Error("Worker exceeded CPU time limit."));
          this.#hooks.attemptCall?.(call, stepDone.promise);
          let result: Settled<unknown>;
          try {
            result = fromIsolate(await call);
          } catch (error) {
            if (!isCpuLimitKill(error)) {
              throw error;
            }
            this.#isolateStopped = true;
            result = { ok: false, error: forIsolate(error) };
          } finally {
            attempt.over = true;
            // What it didn't spend of its share goes back, once every
            // evaluation it started has settled: one it left running would
            // spend after its fuel went back. Over now, none starts jq.
            await Promise.allSettled(attempt.pending);
            if (funded) {
              this.#activationFuel += Math.max(0, attempt.budget.fuel);
            }
          }
          if (this.#tampered !== undefined) {
            throw this.#tampered;
          }
          if (!result.ok) {
            throw toStepError(result.error);
          }
          const value = boundedJson(result.value, maxResultBytes);
          if (!value.ok) {
            throw toStepError({
              name: "Error",
              message:
                value.refusal === "too_large"
                  ? `Task "${task.id}" answered more than a step may record`
                  : `Task "${task.id}" answered something that isn't JSON`,
            });
          }
          return value.value;
        });
      });
    } finally {
      stepDone.resolve(null);
    }
  }

  /** Runs a `wait` task: a durable sleep of exactly its sealed length. */
  async sleep(name: unknown, duration: unknown): Promise<Settled<null>> {
    return await settle(async () => {
      const task = this.#taskOf(name, "wait");
      if (task.kind !== "wait" || duration !== task.milliseconds) {
        return this.#refuse(`Task "${task.id}" waits as its build says.`);
      }
      await this.#requirePerson();
      await this.#step.sleep(`task:${task.id}`, task.milliseconds);
      return null;
    });
  }

  /** Generated code never waits for a decision (yet). */
  async waitForDecision(): Promise<Settled<unknown>> {
    return await settle(() => this.#refuse("The build has no decision tasks."));
  }

  /** `ResourceAttemptHost.evaluate`, for `attempt`. */
  async #evaluate(attempt: TaskAttempt, slot: unknown): Promise<Settled<Json>> {
    const evaluating = this.#evaluating(attempt, slot);
    attempt.pending.add(evaluating);
    try {
      return await evaluating;
    } finally {
      attempt.pending.delete(evaluating);
    }
  }

  /** `#evaluate`'s work. */
  async #evaluating(
    attempt: TaskAttempt,
    slot: unknown
  ): Promise<Settled<Json>> {
    return await settle(async () => {
      // Its lease first: an attempt the engine let go of, still running in
      // the isolate, is stale whatever it asks, and never taken for a
      // forged module that taints the run.
      this.#requireCurrent(attempt);
      const { build } = this.#run;
      const expression =
        typeof slot === "number" && Number.isSafeInteger(slot)
          ? build.expressions[slot]
          : undefined;
      if (expression === undefined || expression.taskId !== attempt.task.id) {
        return this.#refuse(
          `Task "${attempt.task.id}" has no expression ${String(slot).slice(0, 20)}.`
        );
      }
      if (attempt.evaluated.has(expression.slot)) {
        return this.#refuse(
          `Task "${attempt.task.id}" evaluates expression ${expression.slot} once.`
        );
      }
      attempt.evaluated.add(expression.slot);
      const key = `${build.hash}:${expression.slot}`;
      let compiling = compiled.get(key);
      if (compiling === undefined) {
        // Sealed: jq compiled it at publication, so it isn't run to compile
        // it again, and every attempt spends only what evaluating it does,
        // whether or not this isolate compiled it before.
        compiling = compileExpression(
          expression.source,
          {
            stage: expression.stage,
            scope: [expression.taskId],
            pointer: expression.pointer,
          },
          true
        );
        compiled.set(key, compiling);
        if (compiled.size > compiledMax) {
          const [oldest] = compiled.keys();
          if (oldest !== undefined) {
            compiled.delete(oldest);
          }
        }
      }
      let expressionCompiled: CompiledExpression<"taskDefinition">;
      try {
        expressionCompiled = await compiling;
      } catch (error) {
        compiled.delete(key);
        throw error;
      }
      // Compiling awaited: an attempt over meanwhile evaluates nothing.
      this.#requireCurrent(attempt);
      const { data } = attempt;
      const value = await evaluateExpression(
        expressionCompiled,
        {
          input: data.input,
          variables: {
            context: data.context,
            input: data.input,
            params: this.#run.params,
            task: {
              name: attempt.task.id,
              reference: attempt.task.pointer,
              input: data.input,
              output: null,
              startedAt: attempt.startedAt,
            },
            workflow: {
              id: this.#run.runId,
              input: this.#run.input,
              startedAt: this.#run.createdAt,
            },
          },
        },
        { kind: "json" },
        attempt.budget
      );
      // Judged again as it returns: compiling and evaluating awaited, and
      // an attempt the engine gave up on meanwhile gets nothing back.
      this.#requireCurrent(attempt);
      return value;
    });
  }

  /**
   * Refuses a call of `attempt` once it no longer holds, with
   * `execution.stale_attempt`: its function has returned, its deadline
   * has passed (the engine may not have noted the timeout yet, and still
   * hand out its lease), or the engine's journal no longer has it holding
   * its lease under the generation that claimed it. As the App host's
   * `#holds`.
   */
  #requireCurrent(attempt: TaskAttempt): void {
    const holds =
      !attempt.over &&
      Date.now() < attempt.deadline &&
      this.#hooks.leaseOf(attempt.key, attempt.number)?.generation ===
        attempt.generation;
    if (!holds) {
      throw executionErrors.create("execution.stale_attempt");
    }
  }
}

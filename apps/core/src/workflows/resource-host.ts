import { kitModuleName } from "@grasp-os/compiler";
import { generatedImport } from "@grasp-os/open-workflow/generate";
import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import {
  executionErrors,
  maxAttemptTimeoutMs,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type { AttemptLease } from "@grasp-os/workerflow/run";
import { writeJson } from "@grasp-os/workflow-expressions/bounded-json";
import { expressionError } from "@grasp-os/workflow-expressions/errors";
import {
  compileExpression,
  evaluateExpression,
} from "@grasp-os/workflow-expressions/evaluate";
import type {
  CompiledExpression,
  Stage,
} from "@grasp-os/workflow-expressions/evaluate";
import { evaluatorLimits } from "@grasp-os/workflow-expressions/limits";
import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";

import { memberRole } from "../auth/identity.ts";
import { generatedModule } from "../workflow-builds.ts";
import type {
  LoadedBuild,
  SealedExpression,
  SealedTask,
} from "../workflow-builds.ts";
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
//   the sealed task table and one of the steps it was sealed with
//   (`task:<id>` for a set or switch, or a wait's sleep; `enter:<id>` and
//   `leave:<id>` around a wait or a do), or the workflow's own
//   `workflow:input` and `workflow:output` when it has them; a wait lasts
//   exactly what was sealed. Anything else is refused, and fails the run.
// - A step run twice. Generated code has no loop, and each task runs at
//   most once (generate.ts): an activation that asks for a step it already
//   ran this activation is refused, so not even a forged module can loop
//   tasks, and a run's steps are bounded by its tasks.
// - An expression that isn't the build's, or another step's. An attempt
//   evaluates only the sealed table's entries of its own task, of the
//   stages its step runs (an enter step's if and input.from, say), by
//   number; the source comes from the verified build, never from the
//   isolate, and a condition is held to a boolean.
// - Authority from the isolate. `$params` are the values the run's start
//   froze, only those not sensitive (the build seals their names), and
//   `$workflow` and `$task` the host's own record of the run and the step.
//   Everything else is data the run carries, which the isolate passes:
//   `$context` and the raw input (what `if` and `input.from` see) as the
//   step starts, frozen from then on, so a retry evaluates what the step
//   started with; a task's transformed input and its output so far with
//   each evaluation. Each is bounded before it is read (`boundedJson`), and
//   none is ever a variable of the host's.
// - A task's data past its schema. The host checks what the step records
//   (its output and exported context) and the input it captured against
//   the task's sealed schema descriptors, by the SDK's own validator,
//   unchanged by it (`workflow.task_data_invalid`), whatever the isolate
//   checked; and takes a task as skipped only once its `if` answered false
//   in that attempt.
// - An attempt acting after it ended. Its host acts only while the engine
//   says it holds its lease and its function hasn't returned
//   (`execution.stale_attempt` otherwise).
// - A person who left. A run acts for the person whose start admitted it,
//   who must still be an active member before each step.
// - The isolate spending core's CPU. Expressions run in core, each held to
//   the evaluator's fuel and an attempt to a budget of fuel across them,
//   from which each evaluation is also charged a fixed cost and a cost per
//   byte of the data it reads (`attemptFuel`); an attempt evaluates each of
//   its step's slots once, as generated code does, at most 128 of them
//   (generate.ts), so a looping isolate can't make core evaluate without
//   end. What
//   a whole activation may spend is the lineage quotas' to bound (not yet
//   kept for these runs: resource-runs.ts).

/** The main module of a run of a sealed build (`openRunMain`). */
export const openRunModule = "grasp-open-run.js";

/** The calls of an attempt's host (`ResourceAttemptHost`), for the sandbox. */
export const resourceAttemptMethods = ["evaluate", "check"] as const;

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
              await fn({
                evaluate: async (slot, frame) => unwrapped(await attempt.evaluate(slot, frame)),
                check: async (which, value) => {
                  unwrapped(await attempt.check(which, value));
                },
              })))),
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

/** A step's name, as the SDK names it. */
const stepNamePattern =
  /^(?:(?<kind>task|enter|leave):(?<id>[a-z][a-z0-9]*(?:-[a-z0-9]+)*)|workflow:(?<flow>input|output))$/u;

/** The steps there are: a task's, or the workflow's own data flow. */
type StepKind =
  | "task"
  | "enter"
  | "leave"
  | "workflow-input"
  | "workflow-output";

const taskStepSchema = z.enum(["task", "enter", "leave"]);

/** The step an attempt belongs to: its kind and its task, if a task's. */
interface StepOf {
  kind: StepKind;
  /** The sealed task; none for the workflow's own steps. */
  task: SealedTask | undefined;
}

/**
 * The step of `build` that `name` names, as a `do` (`sleep` false) or a
 * wait's sleep; `undefined` when the build has no such step.
 */
const sealedStep = (
  build: LoadedBuild,
  name: unknown,
  sleep: boolean
): StepOf | undefined => {
  const groups =
    typeof name === "string" ? stepNamePattern.exec(name)?.groups : undefined;
  if (groups?.flow === "input" || groups?.flow === "output") {
    const kind = groups.flow === "input" ? "workflow-input" : "workflow-output";
    return !sleep && build.workflow[groups.flow]
      ? { kind, task: undefined }
      : undefined;
  }
  const kind = taskStepSchema.safeParse(groups?.kind);
  const task = build.tasks.find(({ id }) => id === groups?.id);
  if (!kind.success || task === undefined) {
    return undefined;
  }
  // A wait's `task:` step is its sleep, never a `do`.
  const isSleep = kind.data === "task" && task.kind === "wait";
  const fits = sleep ? isSleep : task.steps.includes(kind.data) && !isSleep;
  return fits ? { kind: kind.data, task } : undefined;
};

/** The stages of a task's expressions each kind of step evaluates. */
const stagesOf: Readonly<Record<StepKind, readonly Stage[]>> = {
  task: [
    "taskIf",
    "taskInputFrom",
    "taskDefinition",
    "taskOutputAs",
    "taskExportAs",
  ],
  enter: ["taskIf", "taskInputFrom"],
  leave: ["taskOutputAs", "taskExportAs"],
  "workflow-input": ["workflowInputFrom"],
  "workflow-output": ["workflowOutputAs"],
};

/** The schemas of its task each kind of step checks. */
const checksOf: Readonly<Record<StepKind, readonly DataCheck[]>> = {
  task: ["input", "output", "export"],
  enter: ["input"],
  leave: ["output", "export"],
  "workflow-input": [],
  "workflow-output": [],
};

type DataCheck = "input" | "output" | "export";
const dataCheckSchema = z.enum(["input", "output", "export"]);

/** What a step captures: its raw input and the context. */
const capturedSchema = z.strictObject({
  input: z.strictObject({ input: z.json(), context: z.json() }),
});

/** What the isolate passes with an evaluation: the task's data so far. */
const frameSchema = z.strictObject({ input: z.json(), output: z.json() });

/** What a task's step records (the SDK's `readRecord`). */
const recordSchema = z.union([
  z.strictObject({ skipped: z.literal(true) }),
  z.strictObject({
    output: z.json(),
    context: z.json().optional(),
    branch: z.int().min(0).optional(),
  }),
]);

/**
 * The most a step's capture or an evaluation's data may take as JSON: two
 * values, each at most what a step records (each is one, or the run's
 * input, which a receipt bounds lower), and their framing.
 */
const maxPassedBytes = 2 * platformLimits.stepPayloadBytes + 64;

/**
 * `value` as plain JSON, with its size in UTF-16 code units, if it is
 * plain JSON within `maxPassedBytes` and the evaluator's depth: written
 * once by the bounded writer, so nothing larger is walked, then read back
 * from that text. `undefined` otherwise.
 */
const boundedJson = (
  value: unknown
): { value: Json; size: number } | undefined => {
  const written = writeJson(value, {
    maxBytes: maxPassedBytes,
    maxDepth: evaluatorLimits.maxJsonDepth + 2,
    maxNodes: maxPassedBytes,
    sortKeys: false,
    safeIntegers: false,
  });
  if (!written.ok) {
    return undefined;
  }
  const parsed = z.json().safeParse(JSON.parse(written.text));
  return parsed.success
    ? { value: parsed.data, size: written.text.length }
    : undefined;
};

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

/**
 * A time, in ms, as the expression profile gives `$workflow.startedAt` and
 * `$task.startedAt`: the spec's date-time descriptor, its ISO 8601 text
 * and its epoch in seconds and milliseconds.
 */
const timestampOf = (ms: number): Json => ({
  iso8601: new Date(ms).toISOString(),
  epoch: { seconds: Math.floor(ms / 1000), milliseconds: ms },
});

/** What one step's result, or a run's output, may take as JSON. */
export const maxResultBytes = platformLimits.stepPayloadBytes;

/**
 * The fuel one attempt's evaluations may spend together: eight
 * expressions' worth of the evaluator's own per-expression fuel (2^24,
 * workflow-expressions' jq.ts, sized to about 140 ms of CPU at worst:
 * measured on V8 at 120,000 to 2,500,000 units a millisecond), so about
 * 1.1 s of metered work at most, a fiftieth of an attempt's 60 s timeout.
 *
 * Fuel meters jq. Each evaluation also costs core work that jq doesn't
 * meter: reading its data, writing its context text, a fresh jq instance
 * and its start-up. So each is charged `evaluationFuel` and
 * `fuelPerByte` for every code unit of the data it reads (the step's
 * capture, its frame and the run's input) before jq runs. With those, an
 * attempt runs at most 256 evaluations of no data (a step has at most 128,
 * generate.ts, which take half the budget), or 8 over a full MiB of data,
 * and core's unmetered work stays linear in what was charged. Real data
 * transforms spend a small part of it. Running out is
 * `expression.budget_exhausted`, never retried: the charges are
 * deterministic.
 */
const attemptFuel = 2 ** 27;

/** What one evaluation costs before jq runs: 1/32 of an expression's fuel. */
const evaluationFuel = 2 ** 19;

/** What each code unit of an evaluation's data costs: a MiB, 2^24. */
const fuelPerByte = 16;

/**
 * The fuel one activation's attempts spend together on expressions: about
 * sixteen attempts' worst, some sixteen seconds of core's CPU, inside what
 * one invocation of the run's object may take. Each attempt holds its
 * whole share as it starts and gives back what it didn't spend; once the
 * activation can't fund a whole attempt, the next is cut off as the Loader
 * cuts off an isolate past its CPU time (`isCpuLimitKill`), so the engine
 * parks its step for a retry and the activation suspends: the next one,
 * which replays what was recorded without evaluating it again, starts from
 * a fresh allowance. A long workflow goes on in turns, never holding core's
 * CPU for all its tasks at once.
 */
const activationFuel = 16 * attemptFuel;

/** One attempt of a step, from when the engine claims it. */
interface StepAttempt {
  step: StepOf;
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
   * The slots it evaluated: generated code evaluates each of its step's
   * expressions at most once, so an attempt's evaluations, and the core
   * CPU they take, are bounded by its step's expressions in the table.
   */
  evaluated: Set<number>;
  /** The schemas it checked, each at most once, as generated code does. */
  checked: Set<DataCheck>;
  /** The size of what the step captured, charged to each evaluation. */
  capturedSize: number;
  /** What its task's `if` answered in it, if it was evaluated. */
  ifHeld: boolean | undefined;
  /** The fuel its evaluations have left together (`attemptFuel`). */
  budget: { fuel: number };
  /** Its evaluations under way: waited for before its fuel goes back. */
  pending: Set<Promise<unknown>>;
}

/** Expressions compiled once per build, by build hash and slot. */
const compiled = new Map<string, Promise<CompiledExpression>>();
// Past the 128 slots of the largest step, so one step doesn't thrash it.
const compiledMax = 512;

/** Task schemas made once per build, by build hash, task and check. */
const schemas = new Map<string, ReturnType<typeof schemaFromDescriptor>>();
const schemasMax = 256;

const remember = <T>(
  cache: Map<string, T>,
  max: number,
  key: string,
  value: T
): T => {
  cache.set(key, value);
  if (cache.size > max) {
    const [oldest] = cache.keys();
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  return value;
};

/**
 * Requires `schema` to take `value` exactly as it is: a task's schema
 * checks its data, it never fills in or changes it
 * (`workflow.task_data_invalid` otherwise, and for no JSON at all).
 */
const conform = (
  schema: ReturnType<typeof schemaFromDescriptor>,
  value: Json | undefined
): void => {
  if (value === undefined) {
    throw workflowResourceErrors.create("workflow.task_data_invalid");
  }
  const snapshot = canonicalJson(value);
  const validated = schema["~standard"].validate(JSON.parse(snapshot));
  const accepted =
    !("then" in validated) &&
    validated.issues === undefined &&
    z.json().safeParse(validated.value).success &&
    canonicalJson(z.json().parse(validated.value)) === snapshot;
  if (!accepted) {
    throw workflowResourceErrors.create("workflow.task_data_invalid");
  }
};

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
  /** What is left of this activation's fuel for expressions. */
  #activationFuel: number;
  /** The steps this activation asked for: each at most once. */
  readonly #asked = new Set<string>();
  /** The parameters expressions may read: the build's, not sensitive. */
  readonly #readableParams: Record<string, Json>;
  /**
   * The size of what every evaluation serializes besides its step's data:
   * the run's input and the readable parameters, charged to each.
   */
  readonly #inputSize: number;

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
    this.#readableParams = Object.fromEntries(
      run.build.params.flatMap((name) =>
        Object.hasOwn(run.params, name)
          ? [[name, run.params[name] ?? null]]
          : []
      )
    );
    this.#inputSize =
      JSON.stringify(run.input).length +
      JSON.stringify(this.#readableParams).length;
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

  /**
   * The sealed step `name` is, as a `do` (`sleep` false) or a wait's sleep;
   * refused when the build has no such step, or this activation asked for
   * it already.
   */
  #stepOf(name: unknown, sleep: boolean): StepOf {
    if (this.#tampered !== undefined) {
      throw this.#tampered;
    }
    const shown = String(name).slice(0, 80);
    const step = sealedStep(this.#run.build, name, sleep);
    if (step === undefined) {
      return this.#refuse(`The build has no step ${shown}.`);
    }
    if (typeof name !== "string" || this.#asked.has(name)) {
      return this.#refuse(`Step ${shown} runs once.`);
    }
    this.#asked.add(name);
    return step;
  }

  /** The person the run acts for must still be an active member. */
  async #requirePerson(): Promise<void> {
    if (!(await memberRole(this.#env.DB, this.#run.principal))) {
      throw permissionErrors.create("permission.person_inactive");
    }
  }

  /**
   * Runs a step: its function, in the isolate, gets a host of the attempt
   * through which it evaluates the step's expressions and checks its
   * task's data, on the data the step captured. A replay answers the
   * recorded result without calling it.
   */
  async do(
    name: unknown,
    options: unknown,
    fn: (attempt: ResourceAttemptHost) => Promise<unknown>
  ): Promise<Settled<unknown>> {
    const stepDone = Promise.withResolvers<null>();
    try {
      return await settle(async () => {
        const step = this.#stepOf(name, false);
        const bounded = boundedJson(options);
        const captured = capturedSchema.safeParse(bounded?.value);
        if (bounded === undefined || !captured.success) {
          return this.#refuse(
            "A step captures its input and context, within a step's size."
          );
        }
        const data = captured.data.input;
        await this.#requirePerson();
        const stepName = String(name);
        return await this.#step.do(stepName, stepConfig, async (context) => {
          const told = attemptContextSchema.parse(context);
          const lease = this.#hooks.leaseOf(told.idempotencyKey, told.attempt);
          if (lease === undefined) {
            throw new Error(`Step "${stepName}"'s attempt holds no lease`);
          }
          const attempt: StepAttempt = {
            step,
            data,
            startedAt: Date.now(),
            key: told.idempotencyKey,
            number: told.attempt,
            generation: lease.generation,
            deadline: lease.deadline,
            over: false,
            evaluated: new Set(),
            checked: new Set(),
            capturedSize: bounded.size,
            ifHeld: undefined,
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
                new ResourceAttemptHost({
                  evaluate: async (slot, frame) =>
                    await this.#evaluate(attempt, slot, frame),
                  check: (which, value) => this.#check(attempt, which, value),
                })
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
          // A refusal is never retried: the same module refuses the same.
          if (this.#tampered !== undefined) {
            throw toStepError(forIsolate(this.#tampered));
          }
          if (!result.ok) {
            throw toStepError(result.error);
          }
          // Written once by the bounded writer before anything else reads
          // it: an answer past what a step records is refused having cost
          // core no more than that much.
          const written = writeJson(result.value, {
            maxBytes: maxResultBytes,
            maxDepth: evaluatorLimits.maxJsonDepth + 2,
            maxNodes: maxResultBytes,
            sortKeys: false,
            safeIntegers: false,
          });
          if (!written.ok) {
            throw toStepError({
              name: "Error",
              message:
                written.refusal === "too_large"
                  ? `Step "${stepName}" answered more than a step may record`
                  : `Step "${stepName}" answered something that isn't JSON`,
            });
          }
          const value = z.json().parse(JSON.parse(written.text));
          // Its record's checks, as the host makes them, spend the
          // activation's fuel as an evaluation of it would.
          this.#activationFuel -=
            evaluationFuel + fuelPerByte * written.text.length;
          try {
            this.#acceptRecord(attempt, value);
          } catch (error) {
            // A record off its task's schemas fails the same every time.
            throw toStepError(forIsolate(error));
          }
          return value;
        });
      });
    } finally {
      stepDone.resolve(null);
    }
  }

  /** Runs a `wait` task: a durable sleep of exactly its sealed length. */
  async sleep(name: unknown, duration: unknown): Promise<Settled<null>> {
    return await settle(async () => {
      const { task } = this.#stepOf(name, true);
      if (task?.kind !== "wait" || duration !== task.milliseconds) {
        return this.#refuse(
          `Task "${task?.id ?? ""}" waits as its build says.`
        );
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

  /** Whose an attempt's step is, as the table names it: `null` the workflow's. */
  static #ownerOf(step: StepOf): string | null {
    return step.task?.id ?? null;
  }

  /**
   * Refuses a call of `attempt` once it no longer holds, with
   * `execution.stale_attempt`: its function has returned, its deadline
   * has passed (the engine may not have noted the timeout yet, and still
   * hand out its lease), or the engine's journal no longer has it holding
   * its lease under the generation that claimed it. As the App host's
   * `#holds`.
   */
  #requireCurrent(attempt: StepAttempt): void {
    const holds =
      !attempt.over &&
      Date.now() < attempt.deadline &&
      this.#hooks.leaseOf(attempt.key, attempt.number)?.generation ===
        attempt.generation;
    if (!holds) {
      throw executionErrors.create("execution.stale_attempt");
    }
  }

  /** The sealed expression `slot`, if `attempt`'s step evaluates it. */
  #expressionOf(attempt: StepAttempt, slot: unknown): SealedExpression {
    const { build } = this.#run;
    const expression =
      typeof slot === "number" && Number.isSafeInteger(slot)
        ? build.expressions[slot]
        : undefined;
    const owner = ResourceRunHost.#ownerOf(attempt.step);
    if (
      expression === undefined ||
      expression.taskId !== owner ||
      !stagesOf[attempt.step.kind].includes(expression.stage)
    ) {
      return this.#refuse(
        `Step of "${owner ?? "the workflow"}" has no expression ${String(slot).slice(0, 20)}.`
      );
    }
    if (attempt.evaluated.has(expression.slot)) {
      return this.#refuse(
        `Step of "${owner ?? "the workflow"}" evaluates expression ${expression.slot} once.`
      );
    }
    attempt.evaluated.add(expression.slot);
    return expression;
  }

  /** `expression`, compiled once per build. */
  async #compiled(expression: SealedExpression): Promise<CompiledExpression> {
    const key = `${this.#run.build.hash}:${expression.slot}`;
    const compiling =
      compiled.get(key) ??
      remember(
        compiled,
        compiledMax,
        key,
        // Sealed: jq compiled it at publication, so it isn't run to
        // compile it again, and every attempt spends only what evaluating
        // it does, whether or not this isolate compiled it before.
        compileExpression(
          expression.source,
          {
            stage: expression.stage,
            scope: expression.taskId === null ? [] : [expression.taskId],
            pointer: expression.pointer,
          },
          true
        )
      );
    try {
      return await compiling;
    } catch (error) {
      compiled.delete(key);
      throw error;
    }
  }

  /**
   * What `expression` evaluates on, at its stage: `.` and the variables
   * its stage has, from the host's record, the step's capture and, for
   * what only the task's own work makes, `frame`.
   */
  #scopeOf(
    attempt: StepAttempt,
    expression: SealedExpression,
    frame: { input: Json; output: Json }
  ): { input: Json; variables: Record<string, Json> } {
    const { data, step } = attempt;
    const workflow = {
      id: this.#run.runId,
      input: this.#run.input,
      startedAt: timestampOf(this.#run.createdAt),
    };
    const params = this.#readableParams;
    const task = {
      name: step.task?.id ?? null,
      reference: step.task?.pointer ?? null,
      input: data.input,
      // Nothing yet before the task produces it (output.as and export.as
      // below see what it did).
      output: null,
      startedAt: timestampOf(attempt.startedAt),
    };
    switch (expression.stage) {
      case "workflowInputFrom": {
        return { input: this.#run.input, variables: { workflow, params } };
      }
      case "workflowOutputAs": {
        return {
          input: data.input,
          variables: { context: data.context, workflow, params },
        };
      }
      case "taskIf":
      case "taskInputFrom": {
        return {
          input: data.input,
          variables: { context: data.context, task, workflow, params },
        };
      }
      case "taskDefinition": {
        return {
          input: frame.input,
          variables: {
            context: data.context,
            input: frame.input,
            task,
            workflow,
            params,
          },
        };
      }
      case "taskOutputAs": {
        return {
          input: frame.output,
          variables: {
            context: data.context,
            input: frame.input,
            // The task has its output by now: as it produced it.
            task: { ...task, output: frame.output },
            workflow,
            params,
          },
        };
      }
      case "taskExportAs": {
        return {
          input: frame.output,
          variables: {
            context: data.context,
            input: frame.input,
            output: frame.output,
            // Its output as output.as left it, as `$output` is.
            task: { ...task, output: frame.output },
            workflow,
            params,
          },
        };
      }
      default: {
        return this.#refuse("The build has an expression of no stage.");
      }
    }
  }

  /**
   * Charges `attempt`'s budget for evaluating `expression` on a frame of
   * `frameSize` (`attemptFuel`); `expression.budget_exhausted` once it is
   * spent.
   */
  #charge(
    attempt: StepAttempt,
    expression: SealedExpression,
    frameSize: number
  ): void {
    const size = attempt.capturedSize + frameSize + this.#inputSize;
    attempt.budget.fuel -= evaluationFuel + fuelPerByte * size;
    if (attempt.budget.fuel <= 0) {
      throw expressionError(
        "expression.budget_exhausted",
        {
          pointer: expression.pointer,
          ...(expression.taskId === null ? {} : { taskId: expression.taskId }),
        },
        { remedy: "Do less work in the task's expressions, or split the task." }
      );
    }
  }

  /** `ResourceAttemptHost.evaluate`, for `attempt`. */
  async #evaluate(
    attempt: StepAttempt,
    slot: unknown,
    frame: unknown
  ): Promise<Settled<Json>> {
    const evaluating = this.#evaluating(attempt, slot, frame);
    attempt.pending.add(evaluating);
    try {
      return await evaluating;
    } finally {
      attempt.pending.delete(evaluating);
    }
  }

  /** `#evaluate`'s work. */
  async #evaluating(
    attempt: StepAttempt,
    slot: unknown,
    frame: unknown
  ): Promise<Settled<Json>> {
    return await settle(async () => {
      // Its lease first: an attempt the engine let go of, still running in
      // the isolate, is stale whatever it asks, and never taken for a
      // forged module that taints the run.
      this.#requireCurrent(attempt);
      const expression = this.#expressionOf(attempt, slot);
      const bounded = boundedJson(frame);
      const passed = frameSchema.safeParse(bounded?.value);
      if (bounded === undefined || !passed.success) {
        return this.#refuse(
          "An evaluation passes its task's data as JSON, within a step's size."
        );
      }
      this.#requireCurrent(attempt);
      this.#charge(attempt, expression, bounded.size);
      const expressionCompiled = await this.#compiled(expression);
      // Compiling awaited: an attempt over meanwhile evaluates nothing.
      this.#requireCurrent(attempt);
      const scope = this.#scopeOf(attempt, expression, passed.data);
      const value = await evaluateExpression(
        expressionCompiled,
        // SAFETY: #scopeOf gives exactly the variables of the expression's
        // stage, and evaluateExpression refuses any other set all the same.
        scope as Parameters<typeof evaluateExpression>[1],
        { kind: expression.result },
        attempt.budget
      );
      // Judged again as it returns: compiling and evaluating awaited, and
      // an attempt the engine gave up on meanwhile gets nothing back.
      this.#requireCurrent(attempt);
      if (expression.stage === "taskIf") {
        attempt.ifHeld = value === true;
      }
      return value;
    });
  }

  /** The native schema of `task`'s `which` data, made once per build. */
  #schemaOf(
    task: SealedTask,
    which: DataCheck
  ): ReturnType<typeof schemaFromDescriptor> | undefined {
    const descriptor = task.schemas[which];
    if (descriptor === undefined) {
      return undefined;
    }
    const key = `${this.#run.build.hash}:${task.id}:${which}`;
    return (
      schemas.get(key) ??
      remember(
        schemas,
        schemasMax,
        key,
        schemaFromDescriptor(JSON.stringify(descriptor))
      )
    );
  }

  /**
   * `ResourceAttemptHost.check`, for `attempt`: `value` against its task's
   * `which` schema, which must take it exactly as it is. A task's schema
   * checks its data; it never fills in or changes it.
   */
  #check(attempt: StepAttempt, which: unknown, value: unknown): Settled<null> {
    // Nothing to wait for: a check is the validator's, at once.
    let settled: Settled<null>;
    try {
      this.#checkNow(attempt, which, value);
      settled = { ok: true, value: null };
    } catch (error) {
      settled = { ok: false, error: forIsolate(error) };
    }
    return settled;
  }

  /** `#check`'s work: throws what refuses the value. */
  #checkNow(attempt: StepAttempt, which: unknown, value: unknown): void {
    // Its lease first, as for an evaluation: a stale attempt's check is
    // stale, never a forged one that taints the run.
    this.#requireCurrent(attempt);
    const kind = dataCheckSchema.safeParse(which);
    const { task } = attempt.step;
    const schema =
      kind.success &&
      task !== undefined &&
      checksOf[attempt.step.kind].includes(kind.data)
        ? this.#schemaOf(task, kind.data)
        : undefined;
    if (!kind.success || schema === undefined) {
      return this.#refuse(
        `Step of "${task?.id ?? "the workflow"}" has no ${String(which).slice(0, 20)} schema to check.`
      );
    }
    if (attempt.checked.has(kind.data)) {
      return this.#refuse(
        `Step of "${task?.id ?? ""}" checks its ${kind.data} once.`
      );
    }
    attempt.checked.add(kind.data);
    this.#requireCurrent(attempt);
    const data = boundedJson(value);
    // Charged as an evaluation of what it reads, so checks spend the
    // attempt's share of the activation's fuel as expressions do.
    attempt.budget.fuel -= evaluationFuel + fuelPerByte * (data?.size ?? 0);
    if (attempt.budget.fuel <= 0) {
      throw expressionError(
        "expression.budget_exhausted",
        {
          pointer: task?.pointer ?? "",
          ...(task === undefined ? {} : { taskId: task.id }),
        },
        { remedy: "Check less data in the task, or split the task." }
      );
    }
    conform(schema, data?.value);
  }

  /**
   * Accepts what `attempt`'s step records, whatever the isolate checked:
   * a skip only once its task's `if` answered false in it; otherwise the
   * input it captured, its output and the context it leaves, each against
   * its task's schema (`workflow.task_data_invalid`).
   */
  #acceptRecord(attempt: StepAttempt, value: Json): void {
    const { step, data } = attempt;
    const { task } = step;
    if (task === undefined) {
      if (!z.strictObject({ output: z.json() }).safeParse(value).success) {
        this.#refuse("The workflow's own step records its output.");
      }
      return;
    }
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success) {
      return this.#refuse(
        `Task "${task.id}"'s step records what its SDK does.`
      );
    }
    const record = parsed.data;
    const skipped = "skipped" in record;
    // A task with an `if` records an outcome only once the host evaluated
    // it in this step: leaving it out never takes the task past it.
    const hasIf =
      stagesOf[step.kind].includes("taskIf") &&
      this.#run.build.expressions.some(
        ({ taskId, stage }) => taskId === task.id && stage === "taskIf"
      );
    if (hasIf && attempt.ifHeld === undefined) {
      return this.#refuse(
        `Task "${task.id}" records an outcome only once its if was evaluated.`
      );
    }
    if (skipped !== (attempt.ifHeld === false)) {
      return this.#refuse(
        `Task "${task.id}" is skipped exactly when its if answered false.`
      );
    }
    if (skipped) {
      return;
    }
    const checks = checksOf[step.kind];
    const against: [DataCheck, Json][] = [
      ["input", data.input],
      ["output", record.output],
      // An exported null is the context; only none exported keeps it.
      ["export", record.context === undefined ? data.context : record.context],
    ];
    for (const [which, checked] of against) {
      const schema = checks.includes(which)
        ? this.#schemaOf(task, which)
        : undefined;
      if (schema !== undefined) {
        conform(schema, checked);
      }
    }
  }
}

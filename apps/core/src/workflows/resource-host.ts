import { kitModuleName } from "@grasp-os/compiler";
import { generatedImport } from "@grasp-os/open-workflow/generate";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import {
  executionErrors,
  maxAttemptTimeoutMs,
  stepIdempotencyKey,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import { encode } from "@grasp-os/workerflow/codec";
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
  SealedCall,
  SealedExpression,
  SealedTask,
  SealedTemplate,
} from "../workflow-builds.ts";
import { settling } from "./code.ts";
import type { RunHostCalls, Settled } from "./code.ts";
import { takesExactly } from "./exact-values.ts";
import {
  busyMarker,
  busyOf,
  cpuLimitKill,
  forIsolate,
  fromIsolate,
  isCpuLimitKill,
  loadWaitAfter,
  loadWaitStart,
  markerOf,
  queueTimedOut,
  settle,
  toStepError,
  waitKeyOf,
  waitStep,
} from "./host.ts";
import type { Busy, LoadWait, RunStep } from "./host.ts";
import type { AttemptAdmission, QuotaAttempt } from "./quotas.ts";
import { ResourceAttemptHost } from "./resource-attempt-host.ts";
import type { CallingRun } from "./resource-authority.ts";
import { makeCall } from "./resource-calls.ts";
import type { BuiltCall } from "./resource-calls.ts";

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
//   end; an activation funds a bounded number of attempts' fuel
//   (`activationFuel`), then yields to the next.
// - A run getting past the lineage quotas App runs are held to. Each
//   attempt is admitted by the same admission (quotas.ts, `admitAttempt`)
//   before its function runs, against its run's lineage, of which the run
//   is the root, and the client's shares of attempts running at once; it
//   settles once its function, every evaluation it started and its
//   record's checks are done, so their time counts. Each evaluation is one
//   of the lineage's host calls. What a run spends in core on expressions,
//   across every activation, retry, restart and replay, is so held to its
//   lineage's active time and host calls, which only grow: an
//   activation's fuel is only a tighter bound of its own. Each grasp call
//   is one too, taken before it is built or sent (`#made`): a lineage
//   with none left reaches nothing more outside core.
// - A refusal for load forged as a result. A lineage that is busy, or a
//   share that is full, ends the attempt as core's busy marker, which the
//   run waits on durably, as an App run does (host.ts, `busyMarker`); what
//   a step records is held to its SDK's record (`recordSchema`), which no
//   marker of core's is, so the isolate can't make core sleep or wait.
// - A named call the isolate shapes. A call task's call is the build's:
//   its binding, operation and argument template are sealed in the task
//   table, and the host builds the arguments itself (`#built`), evaluating
//   the template's expressions, which the isolate may not evaluate
//   (`#hostSlots`), and putting in a binding argument's sensitive value,
//   which never enters the isolate, an expression or a record. The
//   isolate only asks for the call, once per attempt, inside the task's
//   own step, and passes the task's transformed input. The call itself,
//   its authority decided again as it is made, is resource-calls.ts's.
// - An effect repeated. Each call is its task's step's work, recorded:
//   a replay answers the record and calls nothing; a retry of the step
//   calls again under the same key (`stepIdempotencyKey` of the step),
//   and a model call's step isn't retried at all (`configOf`).
// - Time, randomness and deadlines that change on replay. `grasp.now`,
//   `grasp.random` and a deadline (an expression wait's, a
//   `grasp.sleepUntil`'s) are made by the host within a step that records
//   them; a sleep must be until exactly the deadline its task's enter step
//   recorded (`#deadlines`), however it was reached.
// - Limits raising the host's ceilings. A task's timeout and the
//   workflow's model calls are held to the lower of the build's sealed
//   limit and the host's own (`configOf`, `HostedResourceRun`).

/** The main module of a run of a sealed build (`openRunMain`). */
export const openRunModule = "grasp-open-run.js";

/** The calls of an attempt's host (`ResourceAttemptHost`), for the sandbox. */
export const resourceAttemptMethods = [
  "evaluate",
  "check",
  "call",
  "until",
] as const;

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
                call: async (frame) => unwrapped(await attempt.call(frame)),
                until: async (frame) => unwrapped(await attempt.until(frame)),
              })))),
        sleep: async (name, milliseconds) => {
          unwrapped(await host.sleep(name, milliseconds));
        },
        sleepUntil: async (name, timestamp) => {
          unwrapped(await host.sleepUntil(name, timestamp));
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
  /** What its calls go by: its principal, invoker and frozen bindings. */
  calling: CallingRun;
  /**
   * The most model calls it may make: the lower of its build's limit and
   * the host's ceiling (resource-runs.ts).
   */
  maxModelCalls: number;
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
  /**
   * Admits a step's attempt against its run's lineage quotas and the
   * client's shares before its function runs (quotas.ts, `admitAttempt`),
   * throwing the refusal. Required: no attempt runs unadmitted.
   */
  admitAttempt: (attempt: QuotaAttempt) => Promise<AttemptAdmission>;
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

/** Whether `task` sleeps: a wait, or a `grasp.sleepUntil` call. */
const sleepsOf = (task: SealedTask): boolean =>
  task.kind === "wait" ||
  (task.kind === "call" && task.call.name === "grasp.sleepUntil");

/**
 * The template of `task`'s deadline, which its enter step resolves: an
 * expression wait's duration, a `grasp.sleepUntil` call's timestamp.
 */
const deadlineOf = (
  task: SealedTask
): { template: SealedTemplate; kind: "duration" | "timestamp" } | undefined => {
  if (task.kind === "wait" && task.duration !== undefined) {
    return { template: task.duration, kind: "duration" };
  }
  if (task.kind === "call" && task.call.name === "grasp.sleepUntil") {
    return { template: task.call.timestamp, kind: "timestamp" };
  }
  return undefined;
};

/** The step of `build` that `name` names, as a `do` (`sleep` false) or a
 * sleeping task's sleep; `undefined` when the build has no such step.
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
  // A sleeping task's `task:` step is its sleep, never a `do`.
  const isSleep = kind.data === "task" && sleepsOf(task);
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
    until: z.int().min(0).optional(),
  }),
]);

/** What an enter step journals: its record, and when its task started. */
const enteredSchema = z.strictObject({
  record: z.json(),
  startedAt: z.number(),
});

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
  /** Its step's place among the run's steps (host.ts, `countedStep`). */
  stepOrdinal: z.int().positive().optional(),
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
 * The calls whose step is tried once only (spec 13.7: at most one attempt
 * for an effect not proven idempotent, and for a model): an App's export,
 * which gets the step's key but needn't keep to it, and a model request.
 * A connector's side effect is keyed in connect, so a retry finds its
 * stored result; the time and a random number change nothing outside.
 */
const triedOnce = new Set<SealedCall["name"]>([
  "grasp.operation",
  "grasp.model",
]);

/**
 * The config of `step`'s attempts: the platform's, its timeout lowered to
 * its task's own (`timeout`, never above the host's ceiling), and no retry
 * for a call `triedOnce`.
 */
const configOf = (step: StepOf) => {
  const { task } = step;
  const timeout = Math.min(
    stepConfig.timeout,
    task?.timeoutMs ?? stepConfig.timeout
  );
  const once =
    step.kind === "task" &&
    task?.kind === "call" &&
    triedOnce.has(task.call.name);
  return {
    retries: once ? { ...stepConfig.retries, limit: 0 } : stepConfig.retries,
    timeout,
  };
};

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
  /**
   * What its task's `if` answered, as the host evaluated it in this
   * attempt: not yet, true or false. A call opens only once it held, for a
   * task that has one (`#call`), never on what the isolate says.
   */
  condition: "unevaluated" | "held" | "failed";
  /** What the host's evaluations of its task's `input.from` answered, by slot. */
  inputFrom: Map<number, Json>;
  /** The input its task's input schema took in this attempt, as JSON text. */
  checkedInput: string | undefined;
  /** The fuel its evaluations have left together (`attemptFuel`). */
  budget: { fuel: number };
  /** Its evaluations under way: waited for before its fuel goes back. */
  pending: Set<Promise<unknown>>;
  /**
   * Where its task's call is: not asked for, under way, answered, or
   * failed. Asked for once per attempt; its step records only an answered
   * one.
   */
  call: "none" | "pending" | "done" | "failed";
  /** What its task's call answered, once done: its raw output. */
  answer: Json | undefined;
  /** What the host's evaluations of its task's `output.as` answered, by slot. */
  outputAs: Map<number, Json>;
  /** What the host's evaluations of its task's `export.as` answered, by slot. */
  exportAs: Map<number, Json>;
  /** The deadline it resolved for its task, once (`until`). */
  until: number | undefined;
  /** Whether it asked for its deadline: once, however it went. */
  untilAsked: boolean;
  /** Its admission: what admits each evaluation as a host call. */
  admission: AttemptAdmission;
}

/** What every attempt of one step shares (`ResourceRunHost.#attempt`). */
interface StepRun {
  step: StepOf;
  name: string;
  data: { input: Json; context: Json };
  /** The size of what the step captured. */
  capturedSize: number;
  /** When its task started, as its enter step recorded it, if it has one. */
  taskStart: number | undefined;
  /** Whether it is an enter step, which journals when its task started. */
  entering: boolean;
  /** Its wait for load since its last admission (host.ts, `LoadWait`). */
  wait: LoadWait;
}

/** Expressions compiled once per build, by build hash and slot. */
const compiled = new Map<string, Promise<CompiledExpression>>();
// Past the 128 slots of the largest step, so one step doesn't thrash it.
const compiledMax = 512;

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
 * Requires the schema of `descriptor` (its JSON text) to take `value`
 * exactly as it is: a task's schema checks its data, it never fills in or
 * changes it (`workflow.task_data_invalid` otherwise, and for no JSON at
 * all).
 */
const conform = (descriptor: string, value: Json | undefined): void => {
  if (value === undefined || !takesExactly(descriptor, value)) {
    throw workflowResourceErrors.create("workflow.task_data_invalid");
  }
};

/** Every slot `template` names, nested ones included. */
const slotsOf = (template: SealedTemplate, into: Set<number>): void => {
  if ("slot" in template) {
    into.add(template.slot);
  } else if ("object" in template) {
    for (const [, item] of template.object) {
      slotsOf(item, into);
    }
  } else if ("array" in template) {
    for (const item of template.array) {
      slotsOf(item, into);
    }
  }
};

/** The templates of a task's call, by what each builds. */
const templatesOf = (call: SealedCall): SealedTemplate[] => {
  switch (call.name) {
    case "grasp.now":
    case "grasp.random": {
      return [];
    }
    case "grasp.operation":
    case "grasp.connector": {
      return [call.arguments];
    }
    case "grasp.model": {
      return [
        call.instructions,
        call.input,
        ...(call.model === undefined ? [] : [call.model]),
        ...(call.maxOutputTokens === undefined ? [] : [call.maxOutputTokens]),
      ];
    }
    case "grasp.sleepUntil": {
      return [call.timestamp];
    }
    default: {
      return call satisfies never;
    }
  }
};

/**
 * `template` filled from `evaluated`, the values of its slots by number:
 * undefined while one of them wasn't evaluated. It holds no binding
 * argument: an `input.from` never names one (generate.ts).
 */
const filledFrom = (
  template: SealedTemplate,
  evaluated: ReadonlyMap<number, Json>
): Json | undefined => {
  if ("literal" in template) {
    return template.literal;
  }
  if ("slot" in template) {
    return evaluated.get(template.slot);
  }
  if ("param" in template) {
    return undefined;
  }
  if ("array" in template) {
    const items: Json[] = [];
    for (const item of template.array) {
      const value = filledFrom(item, evaluated);
      if (value === undefined) {
        return undefined;
      }
      items.push(value);
    }
    return items;
  }
  const entries: [string, Json][] = [];
  for (const [key, item] of template.object) {
    const value = filledFrom(item, evaluated);
    if (value === undefined) {
      return undefined;
    }
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
};

/** The slots of `build`'s call and deadline templates (`#hostSlots`). */
const hostSlotsOf = (build: LoadedBuild): ReadonlySet<number> => {
  const slots = new Set<number>();
  for (const task of build.tasks) {
    if (task.kind === "call") {
      for (const template of templatesOf(task.call)) {
        slotsOf(template, slots);
      }
    } else if (task.kind === "wait" && task.duration !== undefined) {
      slotsOf(task.duration, slots);
    }
  }
  return slots;
};

/** The furthest a deadline may be, as the engine sleeps: 365 days. */
const maxDeadlineMs = 365 * 86_400_000;

/**
 * The deadline, in ms since the epoch, that a deadline template's `value`
 * means at `now`: a duration (whole milliseconds, as the evaluator returns
 * an expression wait's) from now, or a `grasp.sleepUntil` timestamp as it
 * is, a past one due at once. At most a year ahead; anything else is
 * `workflow.call_invalid`.
 */
const untilOf = (
  kind: "duration" | "timestamp",
  value: Json,
  now: number
): number => {
  const ms =
    typeof value === "number" && Number.isSafeInteger(value) ? value : -1;
  const until = kind === "duration" ? now + ms : ms;
  const valid = kind === "duration" ? ms > 0 : ms >= 0;
  if (!valid || until - now > maxDeadlineMs) {
    throw workflowResourceErrors.create("workflow.call_invalid", {
      issues: [
        kind === "duration"
          ? "wait: Give a positive duration of at most a year."
          : "timestamp: Give a time in milliseconds at most a year ahead.",
      ],
    });
  }
  return until;
};

/** A random number in [0, 1), from 53 random bits: never a credential. */
const randomFraction = (): number => {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint32Array(2));
  // 21 bits of one and 32 of the other: 53, a double's whole mantissa.
  return (Math.floor(high / 2 ** 11) * 2 ** 32 + low) / 2 ** 53;
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
  /**
   * When each task with an enter step started, as that step recorded it:
   * its leave step's `$task.startedAt`, in the attempt and on replay.
   */
  readonly #taskStarts = new Map<string, number>();
  /** The parameters expressions may read: the build's, not sensitive. */
  readonly #readableParams: Record<string, Json>;
  /**
   * The size of what every evaluation serializes besides its step's data:
   * the run's input and the readable parameters, charged to each.
   */
  readonly #inputSize: number;
  /**
   * The slots of the build's call and deadline templates: the host's to
   * evaluate as it builds them, never the isolate's.
   */
  readonly #hostSlots: ReadonlySet<number>;
  /**
   * The deadline each sleeping task's enter step recorded, by task, as
   * this activation reached it (fresh or replayed): its sleep is until
   * exactly then.
   */
  readonly #deadlines = new Map<string, number>();
  /**
   * The model calls the run has made: those its replayed steps recorded,
   * as this activation reached them, and those this activation made
   * itself, each counted as it is asked for (`#made`), before anything is
   * awaited. Each new one is held to `maxModelCalls`.
   */
  #modelCalls = 0;
  /** The model tasks whose call this activation made, counted then. */
  readonly #modelCallsMade = new Set<string>();

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
    this.#hostSlots = hostSlotsOf(run.build);
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
        // An enter step records when its task started beside its record,
        // and a leave step's expressions see that time, whatever separates
        // them (a wait, a nested do, another activation).
        const entering = step.kind === "enter" && step.task !== undefined;
        const taskStart =
          step.kind === "leave" && step.task !== undefined
            ? this.#taskStarts.get(step.task.id)
            : undefined;
        // Its wait for load since its last admission, read off the markers
        // its attempts recorded, so every replay counts the same.
        const run: StepRun = {
          step,
          name: stepName,
          data,
          capturedSize: bounded.size,
          taskStart,
          entering,
          wait: loadWaitStart,
        };
        const attemptStep = async (context: unknown): Promise<unknown> =>
          await this.#attempt(run, context, fn, stepDone.promise);
        let recorded = await this.#step.do(
          stepName,
          configOf(step),
          attemptStep
        );
        // Refused for load: the step runs again after a durable sleep, in
        // steps of core's own outside the run's step allowance, as an App
        // run's does (host.ts, `RunHost.do`), until it has waited as long
        // as a step may.
        const waitKey = await waitKeyOf(stepName);
        for (
          let marker = markerOf(recorded), round = 1;
          marker !== undefined;
          marker = markerOf(recorded), round += 1
        ) {
          // Only the host records a marker, and only a busy one.
          if (marker.kind !== "busy") {
            throw new Error(`Step "${stepName}" recorded a hold it can't have`);
          }
          run.wait = loadWaitAfter(run.wait, marker);
          if (run.wait.sleepMs <= 0) {
            throw toStepError(queueTimedOut(stepName, marker.maxWaitMs));
          }
          const prefix = waitStep(waitKey, "busy", round);
          // oxlint-disable-next-line no-await-in-loop -- one round at a time
          await this.#step.sleep(prefix, run.wait.sleepMs);
          // oxlint-disable-next-line no-await-in-loop -- one round at a time
          recorded = await this.#step.do(
            `${prefix}:run`,
            configOf(step),
            attemptStep
          );
        }
        let outcome = recorded;
        if (entering) {
          // The host's own journal entry, fresh or replayed.
          const journal = enteredSchema.parse(recorded);
          outcome = journal.record;
          if (step.task !== undefined) {
            this.#taskStarts.set(step.task.id, journal.startedAt);
          }
        }
        // Fresh or replayed alike: what the run has reached, in order.
        this.#noteRecorded(step, outcome);
        return outcome;
      });
    } finally {
      stepDone.resolve(null);
    }
  }

  /**
   * One attempt of step `run`, as the engine claimed it (`context`):
   * admitted, then its function `fn` called in the isolate, then settled
   * with what it, its evaluations and its record's checks used. Answers
   * what the step records: its record (with when its task started, for an
   * enter step), or core's busy marker when it was refused for load.
   */
  async #attempt(
    run: StepRun,
    context: unknown,
    fn: (attempt: ResourceAttemptHost) => Promise<unknown>,
    stepDone: Promise<unknown>
  ): Promise<unknown> {
    const { name: stepName, step } = run;
    const told = attemptContextSchema.parse(context);
    const lease = this.#hooks.leaseOf(told.idempotencyKey, told.attempt);
    if (lease === undefined) {
      throw new Error(`Step "${stepName}"'s attempt holds no lease`);
    }
    // An activation that can't fund a whole attempt any more cuts it
    // off as the Loader does an isolate past its CPU time: its step
    // is retried in the next activation (see `activationFuel`). A
    // funded one holds its whole share from the start, so attempts
    // run at once can't each find the same fuel.
    const funded = !this.#isolateStopped && this.#activationFuel >= attemptFuel;
    // A call tried once (`triedOnce`) is never cut off: its step has
    // no attempt to retry it in the next activation, so it runs on a
    // share of its own. Each step runs at most once an activation,
    // so these add at most one share for each such task.
    const triedOnly = configOf(step).retries.limit === 0;
    const runs = funded || (triedOnly && !this.#isolateStopped);
    // Only an attempt that runs is admitted: one cut off holds nothing of
    // its lineage.
    let admission: AttemptAdmission | undefined;
    if (runs) {
      const admitted = await this.#admitFunded(run, told, lease, funded);
      if (!("settle" in admitted)) {
        return busyMarker(admitted);
      }
      admission = admitted;
    }
    // Settled however it ends, from here on (the `finally` below).
    try {
      const attempt =
        admission === undefined
          ? undefined
          : ResourceRunHost.#newAttempt(run, told, lease, admission);
      const call =
        attempt === undefined
          ? Promise.reject(cpuLimitKill())
          : fn(this.#attemptHostOf(attempt));
      this.#hooks.attemptCall?.(call, stepDone);
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
        if (attempt !== undefined) {
          attempt.over = true;
          // What it didn't spend of its share goes back, once every
          // evaluation it started has settled: one it left running would
          // spend after its fuel went back. Over now, none starts jq.
          await Promise.allSettled(attempt.pending);
          if (funded) {
            this.#activationFuel += Math.max(0, attempt.budget.fuel);
          }
        }
      }
      // A refusal is never retried: the same module refuses the same.
      if (this.#tampered !== undefined) {
        throw toStepError(forIsolate(this.#tampered));
      }
      if (!result.ok || attempt === undefined) {
        throw toStepError(
          result.ok
            ? forIsolate(new Error("The attempt was cut off"))
            : result.error
        );
      }
      return this.#recordOf(run, attempt, result.value);
    } finally {
      // Settled last, however it ended: what it held of its lineage's time
      // turns into what it used, its evaluations' and its record's checks'
      // time included.
      await admission?.settle();
    }
  }

  /**
   * Admits an attempt of step `run` that runs (`#admit`), holding its
   * share of the activation's fuel while it does when `funded`, given
   * back if it is refused: its admission, or, refused for load, how long
   * to wait. Any other refusal is thrown, as the step's error.
   */
  async #admitFunded(
    run: StepRun,
    told: z.infer<typeof attemptContextSchema>,
    lease: AttemptLease,
    funded: boolean
  ): Promise<AttemptAdmission | Busy> {
    if (funded) {
      this.#activationFuel -= attemptFuel;
    }
    const admitted = await settle(
      async () => await this.#admit(told, lease, run.name, run.wait)
    );
    if (admitted.ok && "settle" in admitted.value) {
      return admitted.value;
    }
    if (funded) {
      this.#activationFuel += attemptFuel;
    }
    if (!admitted.ok) {
      throw toStepError(admitted.error);
    }
    return admitted.value;
  }

  /** A fresh attempt of step `run`, as the engine `told` of it, admitted. */
  static #newAttempt(
    run: StepRun,
    told: z.infer<typeof attemptContextSchema>,
    lease: AttemptLease,
    admission: AttemptAdmission
  ): StepAttempt {
    return {
      step: run.step,
      data: run.data,
      startedAt: run.taskStart ?? Date.now(),
      key: told.idempotencyKey,
      number: told.attempt,
      generation: lease.generation,
      deadline: lease.deadline,
      over: false,
      evaluated: new Set(),
      checked: new Set(),
      capturedSize: run.capturedSize,
      condition: "unevaluated",
      inputFrom: new Map(),
      checkedInput: undefined,
      budget: { fuel: attemptFuel },
      pending: new Set(),
      call: "none",
      answer: undefined,
      outputAs: new Map(),
      exportAs: new Map(),
      until: undefined,
      untilAsked: false,
      admission,
    };
  }

  /** The host `attempt`'s function gets in the isolate. */
  #attemptHostOf(attempt: StepAttempt): ResourceAttemptHost {
    return new ResourceAttemptHost({
      evaluate: async (slot, frame) =>
        await this.#evaluate(attempt, slot, frame),
      check: (which, value) => this.#check(attempt, which, value),
      call: async (frame) =>
        await ResourceRunHost.#tracked(attempt, this.#call(attempt, frame)),
      until: async (frame) =>
        await ResourceRunHost.#tracked(attempt, this.#until(attempt, frame)),
    });
  }

  /**
   * What `attempt` of step `run` records of `answer`, its function's: its
   * record, accepted against its task's schemas, with when its task
   * started beside it for an enter step.
   */
  #recordOf(run: StepRun, attempt: StepAttempt, answer: unknown): unknown {
    const { name: stepName } = run;
    // Written once by the bounded writer before anything else reads
    // it: an answer past what a step records is refused having cost
    // core no more than that much.
    const written = writeJson(answer, {
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
    this.#activationFuel -= evaluationFuel + fuelPerByte * written.text.length;
    try {
      this.#acceptRecord(attempt, value);
    } catch (error) {
      // A record off its task's schemas fails the same every time.
      throw toStepError(forIsolate(error));
    }
    if (!run.entering) {
      return value;
    }
    const journaled = { record: value, startedAt: attempt.startedAt };
    // Measured as the engine measures what a step returns: the
    // record fit, but with its start beside it may not.
    try {
      encode(journaled);
    } catch {
      throw toStepError({
        name: "Error",
        message: `Step "${stepName}" answered more than a step may record`,
      });
    }
    return journaled;
  }

  /**
   * Admits the attempt the engine `told` of, holding `lease`, of step
   * `step` that has waited `wait` for load, against its run's lineage
   * quotas and the client's shares (`ResourceHostHooks.admitAttempt`):
   * its admission, or, refused for load, how long to wait. Any other
   * refusal is thrown.
   */
  async #admit(
    told: z.infer<typeof attemptContextSchema>,
    lease: AttemptLease,
    step: string,
    wait: LoadWait
  ): Promise<AttemptAdmission | Busy> {
    try {
      return await this.#hooks.admitAttempt({
        key: told.idempotencyKey,
        step,
        number: told.attempt,
        ...(told.stepOrdinal === undefined
          ? {}
          : { ordinal: told.stepOrdinal }),
        generation: lease.generation,
        deadline: lease.deadline,
        waited: wait.rounds,
        ...(wait.rounds === 0 ? {} : { waitedMs: wait.waitedMs }),
      });
    } catch (error) {
      const busy = busyOf(error);
      if (busy === undefined) {
        throw error;
      }
      return busy;
    }
  }

  /**
   * Notes what step `step` recorded, as this activation reaches it, fresh
   * or replayed: a sleeping task's deadline, which its sleep must be until
   * exactly; a model call made, which counts against `maxModelCalls`.
   * Every record was accepted as it was made (`#acceptRecord`).
   */
  #noteRecorded(step: StepOf, value: unknown): void {
    const { task } = step;
    const record = recordSchema.safeParse(value);
    if (task === undefined || !record.success || "skipped" in record.data) {
      return;
    }
    if (step.kind === "enter" && record.data.until !== undefined) {
      this.#deadlines.set(task.id, record.data.until);
    }
    if (
      step.kind === "task" &&
      task.kind === "call" &&
      task.call.name === "grasp.model" &&
      // Made in this activation: counted as it was asked for.
      !this.#modelCallsMade.has(task.id)
    ) {
      this.#modelCalls += 1;
    }
  }

  /** Runs a `wait` task: a durable sleep of exactly its sealed length. */
  async sleep(name: unknown, duration: unknown): Promise<Settled<null>> {
    return await settle(async () => {
      const { task } = this.#stepOf(name, true);
      if (
        task?.kind !== "wait" ||
        task.milliseconds === undefined ||
        duration !== task.milliseconds
      ) {
        return this.#refuse(
          `Task "${task?.id ?? ""}" waits as its build says.`
        );
      }
      await this.#requirePerson();
      await this.#step.sleep(`task:${task.id}`, task.milliseconds);
      return null;
    });
  }

  /**
   * Runs a sleeping task whose deadline its enter step resolved (an
   * expression wait, a `grasp.sleepUntil` call): a durable sleep until
   * exactly the deadline it recorded, at once when that has passed.
   */
  async sleepUntil(name: unknown, timestamp: unknown): Promise<Settled<null>> {
    return await settle(async () => {
      const { task } = this.#stepOf(name, true);
      const deadline =
        task === undefined ? undefined : this.#deadlines.get(task.id);
      if (
        task === undefined ||
        deadlineOf(task) === undefined ||
        deadline === undefined ||
        timestamp !== deadline
      ) {
        return this.#refuse(
          `Task "${task?.id ?? ""}" sleeps until the deadline it recorded.`
        );
      }
      await this.#requirePerson();
      await this.#step.sleepUntil(`task:${task.id}`, deadline);
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

  /**
   * The sealed expression `slot`, if `attempt`'s step evaluates it: for the
   * isolate, one of its stages' but a template's (`#hostSlots`); for the
   * host building a template (`forHost`), a template's.
   */
  #expressionOf(
    attempt: StepAttempt,
    slot: unknown,
    forHost = false
  ): SealedExpression {
    const { build } = this.#run;
    const expression =
      typeof slot === "number" && Number.isSafeInteger(slot)
        ? build.expressions[slot]
        : undefined;
    const owner = ResourceRunHost.#ownerOf(attempt.step);
    if (
      expression === undefined ||
      expression.taskId !== owner ||
      this.#hostSlots.has(expression.slot) !== forHost ||
      (!forHost && !stagesOf[attempt.step.kind].includes(expression.stage))
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

  /**
   * `work` of `attempt`, among its work under way until it settles: its
   * fuel goes back only once all of it has, so nothing the isolate left
   * running (an evaluation, or a call or deadline the host builds from
   * expressions) spends after.
   */
  static async #tracked<T>(attempt: StepAttempt, work: Promise<T>): Promise<T> {
    attempt.pending.add(work);
    try {
      return await work;
    } finally {
      attempt.pending.delete(work);
    }
  }

  /** `ResourceAttemptHost.evaluate`, for `attempt`. */
  async #evaluate(
    attempt: StepAttempt,
    slot: unknown,
    frame: unknown
  ): Promise<Settled<Json>> {
    return await ResourceRunHost.#tracked(
      attempt,
      this.#evaluating(attempt, slot, frame)
    );
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
      this.#requireAnswered(attempt, expression, passed.data);
      const value = await this.#evaluated(
        attempt,
        expression,
        passed.data,
        bounded.size
      );
      if (expression.stage === "taskIf") {
        attempt.condition = value === true ? "held" : "failed";
      }
      if (expression.stage === "taskInputFrom") {
        attempt.inputFrom.set(expression.slot, value);
      }
      if (expression.stage === "taskOutputAs") {
        attempt.outputAs.set(expression.slot, value);
      }
      if (expression.stage === "taskExportAs") {
        attempt.exportAs.set(expression.slot, value);
      }
      return value;
    });
  }

  /**
   * `task`'s input as `attempt` transformed it, built by the host from the
   * task's sealed `input.from` and its own evaluations of it in this
   * attempt; the raw input where it has none; `undefined` until it can be.
   */
  static #transformedInput(
    attempt: StepAttempt,
    task: SealedTask
  ): Json | undefined {
    const inputFrom =
      task.kind === "call" || task.kind === "wait" ? task.inputFrom : undefined;
    return inputFrom === undefined
      ? attempt.data.input
      : filledFrom(inputFrom, attempt.inputFrom);
  }

  /**
   * The output a call task's step of `attempt` records, as the host built
   * it: its call's answer, transformed by its sealed `output.as` from the
   * host's own evaluations, where it has one; `undefined` until it can be.
   */
  static #shapedAnswer(
    attempt: StepAttempt,
    task: Extract<SealedTask, { kind: "call" }>
  ): Json | undefined {
    return task.outputAs === undefined
      ? attempt.answer
      : filledFrom(task.outputAs, attempt.outputAs);
  }

  /**
   * Refuses an `output.as` or `export.as` evaluation of `attempt`'s call
   * task unless it reads what the host has: the call's answer for
   * `output.as`, and the output as its `output.as` made it for `export.as`.
   * So a forged module can't put an answer the call never gave into what
   * the task records.
   */
  #requireAnswered(
    attempt: StepAttempt,
    expression: SealedExpression,
    { input, output }: { input: Json; output: Json }
  ): void {
    const { task } = attempt.step;
    const transforms =
      expression.stage === "taskOutputAs" ||
      expression.stage === "taskExportAs";
    if (
      !transforms ||
      task?.kind !== "call" ||
      task.call.name === "grasp.sleepUntil"
    ) {
      return;
    }
    const expected =
      expression.stage === "taskOutputAs"
        ? attempt.answer
        : ResourceRunHost.#shapedAnswer(attempt, task);
    // And on the input its call was made on, as the host built it.
    const transformed = ResourceRunHost.#transformedInput(attempt, task);
    if (
      attempt.call !== "done" ||
      expected === undefined ||
      transformed === undefined ||
      canonicalJson(expected) !== canonicalJson(output) ||
      canonicalJson(transformed) !== canonicalJson(input)
    ) {
      this.#refuse(`Task "${task.id}" transforms only its call's answer.`);
    }
  }

  /**
   * Evaluates `expression`, of `attempt`'s step, on `frame` (of `frameSize`
   * code units), charged to the attempt's budget, while it holds.
   */
  async #evaluated(
    attempt: StepAttempt,
    expression: SealedExpression,
    frame: { input: Json; output: Json },
    frameSize: number
  ): Promise<Json> {
    this.#requireCurrent(attempt);
    this.#charge(attempt, expression, frameSize);
    // One of its lineage's host calls, before any of core's CPU goes on
    // it: a lineage with none left evaluates nothing more, in this
    // activation or any later one.
    await attempt.admission.hostCall();
    this.#requireCurrent(attempt);
    const expressionCompiled = await this.#compiled(expression);
    // Compiling awaited: an attempt over meanwhile evaluates nothing.
    this.#requireCurrent(attempt);
    const scope = this.#scopeOf(attempt, expression, frame);
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
    return value;
  }

  /**
   * The value `template` builds, for `attempt`, on the task's transformed
   * input: its literals as they are, each slot its expression's one
   * result, evaluated here once each, and, where `sensitive` is given (a
   * connector call's arguments), a binding argument's sensitive value
   * from what the start froze, each also added to `sensitive`, so its
   * echo can be refused. A parameter the run has no value of, or one
   * where none may be, is refused: the build never seals one.
   */
  async #built(
    attempt: StepAttempt,
    template: SealedTemplate,
    frame: { input: Json; output: Json },
    frameSize: number,
    sensitive?: Json[]
  ): Promise<Json> {
    const build = async (part: SealedTemplate): Promise<Json> =>
      await this.#built(attempt, part, frame, frameSize, sensitive);
    if ("literal" in template) {
      return template.literal;
    }
    if ("slot" in template) {
      const expression = this.#expressionOf(attempt, template.slot, true);
      return await this.#evaluated(attempt, expression, frame, frameSize);
    }
    if ("param" in template) {
      const { params: values } = this.#run;
      if (sensitive === undefined || !Object.hasOwn(values, template.param)) {
        return this.#refuse("A binding argument is a connector call's.");
      }
      const value = values[template.param] ?? null;
      sensitive.push(value);
      return value;
    }
    const built: Json[] = [];
    const items = "array" in template ? template.array : template.object;
    for (const item of items) {
      // One at a time, in order: as the template lists them.
      // oxlint-disable-next-line no-await-in-loop -- see above
      built.push(await build(Array.isArray(item) ? item[1] : item));
    }
    if ("array" in template) {
      return built;
    }
    // Defined as own data properties: no key, `__proto__` included, is
    // anything else.
    const object: Record<string, Json> = {};
    for (const [index, [key]] of template.object.entries()) {
      Object.defineProperty(object, key, {
        value: built[index] ?? null,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return object;
  }

  /** The transformed input the isolate passes for a call or deadline. */
  #callFrame(frame: unknown): { input: Json; output: Json; size: number } {
    const bounded = boundedJson(frame);
    const passed = z
      .strictObject({ input: z.json() })
      .safeParse(bounded?.value);
    if (bounded === undefined || !passed.success) {
      return this.#refuse(
        "A call passes its task's input as JSON, within a step's size."
      );
    }
    return { input: passed.data.input, output: null, size: bounded.size };
  }

  /**
   * Refuses what `attempt` does for task `task` with `frame` (`doing`: its
   * call, or resolving its deadline) unless what comes before it in the
   * task held as the host itself saw it, in this attempt, never as the
   * isolate says: its `if` (where it has one) evaluated and true, its raw
   * input, as the step captured it, taken by its input schema (where it
   * has one), and the input it acts on as its `input.from` (where it has
   * one) made it, or that raw input. So a forged module can't send for a
   * task the sealed workflow skips, or build anything on input it never
   * checked.
   */
  #requireOpen(
    attempt: StepAttempt,
    task: SealedTask,
    frame: unknown,
    doing: "makes its call" | "resolves its deadline"
  ): void {
    const stages = new Set(
      this.#run.build.expressions
        .filter(({ taskId }) => taskId === task.id)
        .map(({ stage }) => stage)
    );
    if (attempt.condition === "failed") {
      return this.#refuse(`Task "${task.id}" is skipped.`);
    }
    if (stages.has("taskIf") && attempt.condition !== "held") {
      return this.#refuse(`Task "${task.id}" ${doing} only once its if held.`);
    }
    const expected = ResourceRunHost.#transformedInput(attempt, task);
    if (expected === undefined) {
      return this.#refuse(
        `Task "${task.id}" ${doing} only on the input its input.from made.`
      );
    }
    const input = canonicalJson(expected);
    if (canonicalJson(this.#callFrame(frame).input) !== input) {
      return this.#refuse(
        `Task "${task.id}" ${doing} on its own transformed input.`
      );
    }
    // The schema takes the raw input, before `input.from` transforms it.
    if (
      task.schemas.input !== undefined &&
      attempt.checkedInput !== canonicalJson(attempt.data.input)
    ) {
      return this.#refuse(
        `Task "${task.id}" ${doing} only once its input schema took its input.`
      );
    }
  }

  /**
   * `ResourceAttemptHost.call`, for `attempt`: its task's call, once,
   * inside the task's own step, built from what the build sealed and the
   * task's transformed input (`frame`): the time, a random number, or an
   * effect resource-calls.ts makes. Its answer is the task's raw output,
   * which the step records.
   */
  async #call(attempt: StepAttempt, frame: unknown): Promise<Settled<Json>> {
    return await settle(async () => {
      if (attempt.over) {
        throw executionErrors.create("execution.stale_attempt");
      }
      const { step } = attempt;
      const task = step.task?.kind === "call" ? step.task : undefined;
      if (
        step.kind !== "task" ||
        task === undefined ||
        task.call.name === "grasp.sleepUntil"
      ) {
        return this.#refuse(
          `Step of "${step.task?.id ?? "the workflow"}" makes no call.`
        );
      }
      if (attempt.call !== "none") {
        return this.#refuse(`Task "${task.id}" makes its call once.`);
      }
      attempt.call = "pending";
      this.#requireOpen(attempt, task, frame, "makes its call");
      try {
        const answer = await this.#made(attempt, task, frame);
        attempt.call = "done";
        attempt.answer = answer;
        return answer;
      } catch (error) {
        attempt.call = "failed";
        throw error;
      }
    });
  }

  /**
   * `#call`'s work, for `attempt` of call task `task`: the time, a random
   * number, or the effect resource-calls.ts makes, each first one of its
   * lineage's host calls. A model call then takes its place among the
   * run's model calls synchronously, with nothing awaited between the
   * check and the count, so steps run at once can't each find room for one
   * more, and a call its lineage refused takes none.
   */
  async #made(
    attempt: StepAttempt,
    task: Extract<SealedTask, { kind: "call" }>,
    frame: unknown
  ): Promise<Json> {
    const passed = this.#callFrame(frame);
    this.#requireCurrent(attempt);
    // One of its lineage's host calls, before anything of it is built or
    // sent, and before a model call takes its place: a lineage with none
    // left makes no more calls, in this attempt or any later one.
    await attempt.admission.hostCall();
    this.#requireCurrent(attempt);
    const { call } = task;
    if (call.name === "grasp.now") {
      return Date.now();
    }
    if (call.name === "grasp.random") {
      return randomFraction();
    }
    if (call.name === "grasp.sleepUntil") {
      return this.#refuse(`Task "${task.id}" makes no call.`);
    }
    if (call.name === "grasp.model") {
      if (this.#modelCalls >= this.#run.maxModelCalls) {
        throw workflowResourceErrors.create("workflow.model_call_limit", {
          limit: this.#run.maxModelCalls,
        });
      }
      this.#modelCalls += 1;
      this.#modelCallsMade.add(task.id);
    }
    const built = await this.#builtCall(attempt, call, passed);
    return await makeCall(this.#env, this.#run.calling, task.id, built, {
      key: stepIdempotencyKey(this.#run.runId, `task:${task.id}`),
      deadline: attempt.deadline,
      fence: {
        run: this.#run.runId,
        key: attempt.key,
        number: attempt.number,
        generation: attempt.generation,
      },
      requireHolds: () => {
        this.#requireCurrent(attempt);
      },
    });
  }

  /** `call`'s parts built (`#built`), as resource-calls.ts makes it. */
  async #builtCall(
    attempt: StepAttempt,
    call: Exclude<
      SealedCall,
      { name: "grasp.now" | "grasp.random" | "grasp.sleepUntil" }
    >,
    frame: { input: Json; output: Json; size: number }
  ): Promise<BuiltCall> {
    const part = async (template: SealedTemplate, sensitive?: Json[]) =>
      await this.#built(attempt, template, frame, frame.size, sensitive);
    switch (call.name) {
      case "grasp.operation": {
        return {
          name: call.name,
          binding: call.binding,
          arguments: await part(call.arguments),
        };
      }
      case "grasp.connector": {
        const sensitive: Json[] = [];
        return {
          name: call.name,
          binding: call.binding,
          operation: call.operation,
          // The only place a binding argument goes: to connect.
          arguments: await part(call.arguments, sensitive),
          sensitive,
        };
      }
      case "grasp.model": {
        return {
          name: call.name,
          binding: call.binding,
          instructions: await part(call.instructions),
          input: await part(call.input),
          outputSchema: call.outputSchema,
          ...(call.model === undefined
            ? {}
            : { model: await part(call.model) }),
          ...(call.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: await part(call.maxOutputTokens) }),
        };
      }
      default: {
        return call satisfies never;
      }
    }
  }

  /**
   * `ResourceAttemptHost.until`, for `attempt`: its task's deadline, once,
   * in its enter step: an expression wait's duration from now, or a
   * `grasp.sleepUntil` call's timestamp, built from what the build sealed
   * on the task's transformed input (`frame`). The step records it, so a
   * replay sleeps until the same time.
   */
  async #until(attempt: StepAttempt, frame: unknown): Promise<Settled<number>> {
    return await settle(async () => {
      if (attempt.over) {
        throw executionErrors.create("execution.stale_attempt");
      }
      const { step } = attempt;
      const { task } = step;
      const deadline =
        step.kind === "enter" && task !== undefined
          ? deadlineOf(task)
          : undefined;
      if (task === undefined || deadline === undefined) {
        return this.#refuse(
          `Step of "${task?.id ?? "the workflow"}" resolves no deadline.`
        );
      }
      // Taken before anything is awaited: two asked at once resolve one.
      if (attempt.untilAsked || attempt.condition === "failed") {
        return this.#refuse(`Task "${task.id}" resolves its deadline once.`);
      }
      attempt.untilAsked = true;
      this.#requireOpen(attempt, task, frame, "resolves its deadline");
      const passed = this.#callFrame(frame);
      const value = await this.#built(
        attempt,
        deadline.template,
        passed,
        passed.size
      );
      attempt.until = untilOf(deadline.kind, value, Date.now());
      return attempt.until;
    });
  }

  /** The descriptor text of `task`'s `which` schema, if it has one. */
  static #schemaOf(task: SealedTask, which: DataCheck): string | undefined {
    const descriptor = task.schemas[which];
    return descriptor === undefined ? undefined : JSON.stringify(descriptor);
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

  /**
   * Charges a check of `size` code units to `attempt`, as an evaluation of
   * what it reads, so checks spend the attempt's share of the activation's
   * fuel as expressions do.
   */
  static #chargeCheck(attempt: StepAttempt, size: number): void {
    attempt.budget.fuel -= evaluationFuel + fuelPerByte * size;
    if (attempt.budget.fuel > 0) {
      return;
    }
    const { task } = attempt.step;
    throw expressionError(
      "expression.budget_exhausted",
      {
        pointer: task?.pointer ?? "",
        ...(task === undefined ? {} : { taskId: task.id }),
      },
      { remedy: "Check less data in the task, or split the task." }
    );
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
        ? ResourceRunHost.#schemaOf(task, kind.data)
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
    ResourceRunHost.#chargeCheck(attempt, data?.size ?? 0);
    conform(schema, data?.value);
    if (kind.data === "input") {
      attempt.checkedInput = canonicalJson(data?.value ?? null);
    }
  }

  /** Whether `step`, of task `taskId`, evaluates the task's `if`. */
  #hasIf(step: StepOf, taskId: string): boolean {
    return (
      stagesOf[step.kind].includes("taskIf") &&
      this.#run.build.expressions.some(
        (expression) =>
          expression.taskId === taskId && expression.stage === "taskIf"
      )
    );
  }

  /**
   * Accepts what `attempt`'s step records, whatever the isolate checked:
   * a skip only once its task's `if` answered false in it; otherwise the
   * input it captured, its output and the context it leaves, each against
   * its task's schema (`workflow.task_data_invalid`).
   */
  /**
   * Refuses `record` of `attempt`'s call task unless it is what the host
   * built from its call's answer: its output, as its `output.as` made it,
   * and its context, as its `export.as` made it (none without one).
   */
  #requireRecordedAnswer(
    attempt: StepAttempt,
    task: Extract<SealedTask, { kind: "call" }>,
    record: { output: Json; context?: Json | undefined }
  ): void {
    if (attempt.call !== "done") {
      return this.#refuse(`Task "${task.id}"'s step makes its call.`);
    }
    const output = ResourceRunHost.#shapedAnswer(attempt, task);
    const context =
      task.exportAs === undefined
        ? undefined
        : filledFrom(task.exportAs, attempt.exportAs);
    const sameContext =
      context === undefined
        ? record.context === undefined && task.exportAs === undefined
        : record.context !== undefined &&
          canonicalJson(context) === canonicalJson(record.context);
    if (
      output === undefined ||
      canonicalJson(output) !== canonicalJson(record.output) ||
      !sameContext
    ) {
      this.#refuse(`Task "${task.id}"'s step records its call's answer.`);
    }
  }

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
    if (this.#hasIf(step, task.id) && attempt.condition === "unevaluated") {
      return this.#refuse(
        `Task "${task.id}" records an outcome only once its if was evaluated.`
      );
    }
    if (skipped !== (attempt.condition === "failed")) {
      return this.#refuse(
        `Task "${task.id}" is skipped exactly when its if answered false.`
      );
    }
    if (skipped) {
      return;
    }
    // A deadline is recorded exactly as the host resolved it in this
    // attempt, and only by an enter step that resolves one.
    if (record.until !== attempt.until) {
      return this.#refuse(
        `Task "${task.id}"'s step records the deadline the host resolved.`
      );
    }
    if (
      step.kind === "enter" &&
      deadlineOf(task) !== undefined &&
      record.until === undefined
    ) {
      return this.#refuse(
        `Task "${task.id}"'s enter step resolves its deadline.`
      );
    }
    // A call task's step records its call's answer: a record without one,
    // or after the call failed or before it answered, would let the
    // isolate answer for the effect.
    const callTask =
      step.kind === "task" &&
      task.kind === "call" &&
      task.call.name !== "grasp.sleepUntil";
    if (callTask) {
      this.#requireRecordedAnswer(attempt, task, record);
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
        ? ResourceRunHost.#schemaOf(task, which)
        : undefined;
      if (schema !== undefined) {
        conform(schema, checked);
      }
    }
  }
}

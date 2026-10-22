/**
 * The SDK of JSON workflows (grasp-open-workflow/1): what the code the host
 * generates from a workflow.json imports, and nothing else does. A builder
 * never writes against it: the host lowers each task of a validated
 * definition into a call here, in ordinary TypeScript control flow, and
 * seals that code with the version (core's workflow-builds.ts).
 *
 * ```ts
 * export default openWorkflow({ profile: "grasp-open-workflow/1" }, async (flow, input) => {
 *   let context: FlowValue = {};
 *   let output: FlowValue = input;
 *   t0_2: {
 *     const chosen = await flow.switch("route", { input: output, context }, {
 *       cases: [async (task) => await task.evaluate(0)],
 *     });
 *     ({ output, context } = chosen);
 *     if (chosen.branch === 0) {
 *       break t0_2;
 *     }
 *     ({ output, context } = await flow.set("small", { input: output, context }, {
 *       set: async () => ({ ["status"]: "small" }),
 *     }));
 *   }
 *   return output;
 * });
 * ```
 *
 * Each task's data flow, as upstream orders it (its `if` on the raw input,
 * the input's schema and `input.from`, the task itself, `output.as`, the
 * output's schema, `export.as` and the context's schema), runs inside one
 * durable step, whose result is recorded: a replay answers the recorded
 * result and runs nothing of the task again, a skipped task and a switch's
 * chosen case included. A task with a durable body (a `wait`, a nested
 * `do`) runs its stages before the body as one step (`enter`) and those
 * after it as another (`leave`). Which task runs next is the generated
 * code's own control flow: labelled blocks it can only leave forward.
 *
 * An expression is evaluated by the host, by its number in the expression
 * table sealed with the code; the code never holds an expression's source,
 * and nothing it passes becomes one. Parameters, the workflow's own input,
 * the task's descriptor and its raw input and context are the host's to
 * supply, from what the start froze and the step captured. A task's
 * schemas are the host's to check, by the native validator.
 *
 * A named call (an operation, a connector action, a model, the time, a
 * random number) is the host's to build and make, within its task's step,
 * from what the build sealed of the task: generated code only asks for it,
 * by its task, and passes the task's transformed input. Its answer is the
 * step's record, so a replay makes no call again. A deadline (a wait's
 * expression, a `grasp.sleepUntil` call's) is resolved once, by the host,
 * in its task's enter step, which records it.
 *
 * It imports nothing: generated code and its type check see only this
 * module.
 */

/** A JSON value, as generated code passes it between tasks. */
export type FlowValue =
  | null
  | boolean
  | number
  | string
  | FlowValue[]
  | { [key: string]: FlowValue };

/** The profile this SDK runs: what a definition's metadata must name. */
export const openWorkflowProfile = "grasp-open-workflow/1";

/** What generated code may do inside one stage of a task's step. */
export interface TaskScope {
  /**
   * Evaluates expression `slot` of the sealed table, one of this step's,
   * on the data of the stage it is in: its one result.
   */
  readonly evaluate: (slot: number) => Promise<FlowValue>;
}

/** One stage of a task: an evaluation of its sealed expressions. */
export type Stage = (task: TaskScope) => Promise<FlowValue>;

/** What a task's step starts from: its raw input and the context. */
export interface TaskData {
  readonly input: FlowValue;
  readonly context: FlowValue;
}

/** Where a task leaves the run: its output and the context after it. */
export interface FlowState {
  readonly output: FlowValue;
  readonly context: FlowValue;
}

/**
 * The stages before a task's own work. A flag asks the host to check, or,
 * `until`, to resolve the task's deadline (a wait's whose duration is an
 * expression, a `grasp.sleepUntil` call's), once, which the step records.
 */
export interface EnterPlan {
  readonly if?: Stage;
  readonly inputSchema?: true;
  readonly inputFrom?: Stage;
  readonly until?: true;
}

/**
 * A call task (a named call the host makes from what the build sealed:
 * its binding, its operation and how its arguments are built): the stages
 * around it.
 */
export interface CallPlan extends EnterPlan, LeavePlan {}

/** The stages after a task's own work. */
export interface LeavePlan {
  readonly outputAs?: Stage;
  readonly outputSchema?: true;
  readonly exportAs?: Stage;
  readonly exportSchema?: true;
}

/** A `set` task: its value, built on its transformed input. */
export interface SetPlan extends EnterPlan, LeavePlan {
  readonly set: Stage;
}

/**
 * A `switch` task: the conditions of its cases but the last, in order;
 * the last is the default, chosen when none holds. A switch has no `if`.
 */
export interface SwitchPlan extends Omit<EnterPlan, "if">, LeavePlan {
  readonly cases: readonly Stage[];
}

/** How a task with a durable body was entered. */
export interface Entered {
  /** Whether its `if` was false: its body and `leave` don't run. */
  readonly skipped: boolean;
  /** Its transformed input; its raw input when skipped. */
  readonly input: FlowValue;
  /** Its deadline, in ms since the epoch, as the host resolved it (`until`). */
  readonly until: number;
}

/** A switch's outcome: the case chosen, by its index. */
export interface Chosen extends FlowState {
  readonly branch: number;
}

/**
 * A `for` task: the stages before and after its loop, and its `while`,
 * evaluated before each item. Its collection (`for.in`) and its items'
 * keys (`metadata.grasp.key`) are the host's to evaluate, from what the
 * build sealed of the task, once, in its enter step, which records the
 * items: generated code never passes them.
 */
export interface ForPlan extends EnterPlan, LeavePlan {
  readonly while?: Stage;
  /** How many items run at once: 1 (one after another) if unset. */
  readonly concurrency?: number;
}

/**
 * Where a scope's list (an item of a `for`) leaves the run: its output
 * and the context after it, and whether an `end` in it ended the
 * workflow.
 */
export interface ScopeEnd extends FlowState {
  readonly end?: boolean;
}

/** A scope's list: its tasks on `flow`, the scope's own, from `state`. */
export type ScopeBody = (flow: Flow, state: FlowState) => Promise<ScopeEnd>;

/** Where a `for` task leaves the run, and whether its list ended it. */
export interface Looped extends FlowState {
  readonly end: boolean;
}

/**
 * A `fork` task: the stages before and after its branches, and whether
 * they compete (a race: the first branch that succeeds wins, its outcome
 * recorded).
 */
export interface ForkPlan extends EnterPlan, LeavePlan {
  readonly compete?: true;
  /** How many branches run at once: 1 (one after another) if unset. */
  readonly concurrency?: number;
}

/** The tasks generated code runs, one after the other. */
export interface Flow {
  /** The workflow's `input.from`, on its raw input. */
  readonly input: (input: FlowValue, from: Stage) => Promise<FlowValue>;
  /** The workflow's `output.as`, on the last task's output. */
  readonly output: (state: FlowState, as: Stage) => Promise<FlowValue>;
  /** Runs `set` task `id` on `data`, as one recorded step. */
  readonly set: (
    id: string,
    data: TaskData,
    plan: SetPlan
  ) => Promise<FlowState>;
  /**
   * Runs call task `id` on `data`, as one recorded step: the host makes
   * the task's call within it, once, and a replay answers what it
   * recorded, calling nothing.
   */
  readonly call: (
    id: string,
    data: TaskData,
    plan: CallPlan
  ) => Promise<FlowState>;
  /** Runs `switch` task `id` on `data`, its chosen case recorded. */
  readonly switch: (
    id: string,
    data: TaskData,
    plan: SwitchPlan
  ) => Promise<Chosen>;
  /** The stages of task `id` before its durable body, as one step. */
  readonly enter: (
    id: string,
    data: TaskData,
    plan: EnterPlan
  ) => Promise<Entered>;
  /**
   * The stages of task `id` after its durable body, as one step: `data`
   * as `enter` had it, `entered` its transformed input and `output` what
   * its body answered.
   */
  readonly leave: (
    id: string,
    data: TaskData,
    entered: FlowValue,
    output: FlowValue,
    plan: LeavePlan
  ) => Promise<FlowState>;
  /**
   * Runs `for` task `id` on `data`: its enter step records the items the
   * host resolved; then, one item after another while its `while` holds
   * (each check a recorded step of the item's), `body` on a flow of the
   * item's own scope, from the task's transformed input and the context
   * the item before left; then its leave step on the last item's output.
   * An `end` in the list ends the loop, and says so.
   */
  readonly for: (
    id: string,
    data: TaskData,
    plan: ForPlan,
    body: ScopeBody
  ) => Promise<Looped>;
  /**
   * Runs `fork` task `id` on `data`: its enter step, if it has stages
   * there; then its branches one after another (concurrency 1), each on a
   * flow of its own scope (`<fork>.<branch>`), from the task's transformed
   * input and the context as the task found it, so no branch sees
   * another's exports. Without `compete`, every branch runs and the
   * fork's output is their outputs in declaration order; with it, the
   * first branch that succeeds wins, the branches after it never run, and
   * its outcome is recorded (`task:<id>`): the fork's output is its
   * output, and a fork whose every branch failed fails as the last did.
   * Then its leave step, on that output. An `end` in a branch ends the
   * fork, and says so.
   */
  readonly fork: (
    id: string,
    data: TaskData,
    plan: ForkPlan,
    branches: readonly ScopeBody[]
  ) => Promise<Looped>;
  /** Durably waits `milliseconds` as task `id`, holding no isolate. */
  readonly wait: (id: string, milliseconds: number) => Promise<void>;
  /**
   * Durably waits as task `id` until `timestamp`, the deadline its enter
   * step recorded, holding no isolate: at once when it has passed.
   */
  readonly sleepUntil: (id: string, timestamp: number) => Promise<void>;
}

/** Which of a task's data the host checks against the task's schema. */
export type DataCheck = "input" | "output" | "export";

/**
 * What a stage's evaluation runs on, beyond what the step captured: the
 * task's transformed input (`$input`) and its output so far.
 */
export interface StageFrame {
  readonly input: FlowValue;
  readonly output: FlowValue;
}

/** What a task's call or deadline is built on: its transformed input. */
export interface CallFrame {
  readonly input: FlowValue;
}

/**
 * The host of one attempt of a step: evaluations, schema checks, and the
 * task's own call or deadline, which the host builds and makes from what
 * the build sealed of the task, never from anything generated code passes
 * but the task's transformed input.
 */
export interface AttemptHost {
  readonly evaluate: (slot: number, frame: StageFrame) => Promise<FlowValue>;
  readonly check: (which: DataCheck, value: FlowValue) => Promise<void>;
  /** Makes the task's call, once: its raw output. */
  readonly call: (frame: CallFrame) => Promise<FlowValue>;
  /** Resolves the task's deadline, once, in ms since the epoch. */
  readonly until: (frame: CallFrame) => Promise<number>;
  /**
   * Resolves a `for` task's collection, once, on its transformed input:
   * its items, which the step records.
   */
  readonly items: (frame: CallFrame) => Promise<FlowValue[]>;
  /**
   * Settles a scope of items or branches (a race's winner, or the one an
   * `end` came from) as `branch`, once: the host fences the others off and
   * answers the branch that settled it, which may be one an earlier
   * activation settled first.
   */
  readonly settle: (settled: { branch: number }) => Promise<number>;
}

/**
 * What core's run module hands a definition: the run's durable steps. Every
 * call goes to the host, which checks it again; nothing here is trusted.
 */
export interface OpenWorkflowEngine {
  /**
   * Runs `fn` as the step `name`, `input` captured as its data; `fn` gets
   * the step's attempt, through which it evaluates and checks.
   */
  readonly do: (
    name: string,
    input: TaskData,
    fn: (attempt: AttemptHost) => Promise<FlowValue>
  ) => Promise<FlowValue>;
  readonly sleep: (name: string, milliseconds: number) => Promise<void>;
  readonly sleepUntil: (name: string, timestamp: number) => Promise<void>;
}

/** What `openWorkflow` makes: frozen, so nothing puts another `run` in place. */
export interface OpenWorkflowDefinition {
  readonly metadata: { readonly profile: typeof openWorkflowProfile };
  readonly run: (
    engine: OpenWorkflowEngine,
    input: FlowValue
  ) => Promise<FlowValue>;
}

/**
 * The runtime's own `Object.freeze`, `Object.hasOwn`, `Array.isArray` and
 * `Number.isSafeInteger`, kept as this module loads: core's run module
 * loads it before the generated module.
 */
const { freeze, hasOwn } = Object;
const { isArray } = Array;
const { isSafeInteger } = Number;

/** A task's ID as the profile has it: kebab-case, at most 64 characters. */
const taskIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const maxTaskIdLength = 64;

/** The longest a task may wait, as the engine takes it: 365 days. */
const maxWaitMs = 365 * 86_400_000;

/** The most cases a switch has (the profile's maxSwitchCases). */
const maxCases = 64;

const requireTaskId = (id: unknown): string => {
  if (
    typeof id !== "string" ||
    id.length > maxTaskIdLength ||
    !taskIdPattern.test(id)
  ) {
    throw new TypeError("A task's ID is kebab-case, at most 64 characters");
  }
  return id;
};

/**
 * A step's name, as the host checks it: its kind of step, its task, then
 * the scope it runs in, if not the workflow's own: each `for` around it
 * and the item of it (`<for>.<index>`), outermost first, as
 * `@<for>.<index>/…`.
 */
const stepOf = (
  kind: "task" | "enter" | "leave" | "item",
  id: string,
  scope: string
): string => `${kind}:${requireTaskId(id)}${scope === "" ? "" : `@${scope}`}`;

/**
 * Scope `scope` with the item `index` of `for` task `id` (or the branch
 * `index` of `fork` task `id`) inside it.
 */
const itemScope = (scope: string, id: string, index: number): string =>
  `${scope === "" ? "" : `${scope}/`}${requireTaskId(id)}.${index}`;

// `Array.isArray` doesn't narrow a readonly array type.
const isStageList = (value: readonly Stage[]): value is readonly Stage[] =>
  isArray(value);

// As `isStageList`, for a fork's branches.
const isBodyList = (
  value: readonly ScopeBody[]
): value is readonly ScopeBody[] => isArray(value);

/** The most branches a fork has (the profile's maxForkBranches). */
const maxBranches = 64;

/** How one item or branch of a scope ended. */
type Outcome =
  | { readonly ok: true; readonly done: ScopeEnd }
  | { readonly ok: false; readonly error: unknown };

/** The most items or branches that run at once (spec 18). */
const maxConcurrency = 8;

/** `concurrency` as a scope takes it: a whole number from 1 to 8. */
const concurrencyOf = (concurrency: number | undefined): number => {
  if (concurrency === undefined) {
    return 1;
  }
  if (!isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError("A scope runs 1 to 8 items or branches at once");
  }
  return Math.min(concurrency, maxConcurrency);
};

/** Whether to start an item or a branch, or none from it on. */
type Admission = "run" | "skip" | "stop";

/**
 * Starts `count` items or branches, in order, at most `limit` at once,
 * each by `run`, which answers how it ended, or null when it didn't run
 * (its `while` was false), after which none later starts; `admit` says
 * whether to start each, skip it, or start none from it on. Answers when
 * every one that started has ended (`all`), and each one's end, by index,
 * as it comes (`ends`, one a started one resolves).
 */
const pooled = (
  count: number,
  limit: number,
  run: (index: number) => Promise<Outcome | null>,
  admit: (index: number) => Promise<Admission>
): {
  all: Promise<void>;
  ends: PromiseWithResolvers<Outcome | null>[];
} => {
  const ends = Array.from({ length: count }, () =>
    Promise.withResolvers<Outcome | null>()
  );
  let next = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped || next >= count) {
        return;
      }
      const index = next;
      next += 1;
      // One after another in each of the workers.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const admitted = await admit(index);
      if (admitted === "stop") {
        stopped = true;
        return;
      }
      if (admitted === "run") {
        // oxlint-disable-next-line no-await-in-loop -- see above
        const outcome = await run(index);
        ends[index]?.resolve(outcome);
        if (outcome === null) {
          stopped = true;
          return;
        }
      }
    }
  };
  const all = (async (): Promise<void> => {
    await Promise.all(
      Array.from({ length: Math.min(limit, count) }, async () => {
        await worker();
      })
    );
  })();
  return { all, ends };
};

/** Whether `error` is a step refused for a scope another settled over. */
const fencedOff = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  hasOwn(error, "code") &&
  Reflect.get(error, "code") === "workflow.branch_cancelled";

/** Whether `plan` has stages after its task's own work. */
const leaves = (plan: LeavePlan): boolean =>
  plan.outputAs !== undefined ||
  plan.outputSchema === true ||
  plan.exportAs !== undefined ||
  plan.exportSchema === true;

/** Whether `plan` has stages before its task's own work. */
const enters = (plan: EnterPlan): boolean =>
  plan.if !== undefined ||
  plan.inputSchema === true ||
  plan.inputFrom !== undefined;

/** What a step's stages work on as they go: its input, then its output. */
interface Frame {
  input: FlowValue;
  output: FlowValue;
}

const frameOf = (input: FlowValue): Frame => ({ input, output: null });

/** What a step captures: its raw input and the context, nothing else. */
const captured = (data: TaskData): TaskData => ({
  input: data.input,
  context: data.context,
});

/** A stage's evaluations, on what `frame` holds when each is made. */
const scopeOf = (attempt: AttemptHost, frame: Frame): TaskScope =>
  freeze({
    evaluate: async (slot: number) => {
      if (!isSafeInteger(slot) || slot < 0) {
        throw new TypeError("An expression's slot is its number");
      }
      return await attempt.evaluate(slot, {
        input: frame.input,
        output: frame.output,
      });
    },
  });

/** A condition's answer: the host holds it to a boolean, and so does this. */
const holds = (value: FlowValue): boolean => {
  if (typeof value !== "boolean") {
    throw new TypeError("A condition answers a boolean");
  }
  return value;
};

const isRecord = (value: FlowValue): value is Record<string, FlowValue> =>
  typeof value === "object" && value !== null && !isArray(value);

/** What a task's step recorded, read back: fresh or replayed alike. */
interface StepRecord {
  readonly skipped: boolean;
  readonly output: FlowValue;
  /** The context it exported, if it exported one. */
  readonly context?: FlowValue;
  readonly branch?: number;
  /** The deadline an enter step resolved, in ms since the epoch. */
  readonly until?: number;
  /** The items a `for` task's enter step resolved. */
  readonly items?: readonly FlowValue[];
}

const readRecord = (value: FlowValue): StepRecord => {
  if (!isRecord(value)) {
    throw new TypeError("A task's step records an object");
  }
  if (value.skipped === true) {
    return { skipped: true, output: null };
  }
  if (!hasOwn(value, "output")) {
    throw new TypeError("A task's step records its output");
  }
  const { branch, until, items } = value;
  if (items !== undefined && !isArray(items)) {
    throw new TypeError("A for task's enter step records its items");
  }
  if (
    branch !== undefined &&
    (typeof branch !== "number" || !isSafeInteger(branch) || branch < 0)
  ) {
    throw new TypeError("A switch records its case by number");
  }
  if (
    until !== undefined &&
    (typeof until !== "number" || !isSafeInteger(until) || until < 0)
  ) {
    throw new TypeError("A deadline is a time in milliseconds");
  }
  return {
    skipped: false,
    output: value.output ?? null,
    ...(hasOwn(value, "context") ? { context: value.context ?? null } : {}),
    ...(branch === undefined ? {} : { branch }),
    ...(until === undefined ? {} : { until }),
    ...(items === undefined ? {} : { items }),
  };
};

/**
 * The stages before a task's work, inside its step: `null` when its `if`
 * is false; its transformed input otherwise, `frame.input` set to it.
 */
const enterStages = async (
  attempt: AttemptHost,
  frame: Frame,
  plan: EnterPlan
): Promise<{ input: FlowValue } | null> => {
  const scope = scopeOf(attempt, frame);
  if (plan.if !== undefined && !holds(await plan.if(scope))) {
    return null;
  }
  if (plan.inputSchema === true) {
    await attempt.check("input", frame.input);
  }
  if (plan.inputFrom !== undefined) {
    frame.input = await plan.inputFrom(scope);
  }
  return { input: frame.input };
};

/**
 * The stages after a task's work, inside its step, from its raw output in
 * `frame.output`: the record of its transformed output and, if it
 * exports, the new context.
 */
const leaveStages = async (
  attempt: AttemptHost,
  frame: Frame,
  context: FlowValue,
  plan: LeavePlan
): Promise<Record<string, FlowValue>> => {
  const scope = scopeOf(attempt, frame);
  if (plan.outputAs !== undefined) {
    frame.output = await plan.outputAs(scope);
  }
  if (plan.outputSchema === true) {
    await attempt.check("output", frame.output);
  }
  if (plan.exportAs === undefined) {
    // Without export.as the context stays as it is: its schema checks it.
    if (plan.exportSchema === true) {
      await attempt.check("export", context);
    }
    return { output: frame.output };
  }
  const exported = await plan.exportAs(scope);
  if (plan.exportSchema === true) {
    await attempt.check("export", exported);
  }
  return { output: frame.output, context: exported };
};

/** Where a recorded task leaves the run, from where it started. */
const stateAfter = (data: TaskData, record: StepRecord): FlowState =>
  record.skipped
    ? { output: data.input, context: data.context }
    : {
        output: record.output,
        // An exported null is the context; only none exported keeps it.
        context: record.context === undefined ? data.context : record.context,
      };

/** The flow generated code runs on, over `engine`, in scope `within`. */
const flowOf = (engine: OpenWorkflowEngine, within = ""): Flow => {
  const named = (kind: "task" | "enter" | "leave" | "item", id: string) =>
    stepOf(kind, id, within);
  /**
   * Runs the `count` items or branches of task `id` (on `data`), at most
   * `limit` at once, each by `run` on a flow of its own scope. A race
   * (`compete`) settles on its first that succeeds; where `settles`, an
   * `end` in one settles the scope too. A scope settles in the task's own
   * step (`task:<id>`), once: the host fences the others off, so none of
   * them starts another step, and answers the one that settled it, an
   * earlier activation's included. Once settled, or once one failed
   * outside a race, none that hasn't started does. Answers how each ended,
   * and the one that won or ended it.
   */
  const scoped = async ({
    id,
    data,
    count,
    limit,
    settles,
    compete = false,
    run,
  }: {
    id: string;
    data: TaskData;
    count: number;
    limit: number;
    settles: boolean;
    compete?: boolean;
    /** How it ended; null when it didn't run (its `while` was false). */
    run: (index: number, flowIn: Flow) => Promise<ScopeEnd | null>;
  }): Promise<{
    outcomes: (Outcome | undefined)[];
    won?: ScopeEnd;
    end?: ScopeEnd;
  }> => {
    let settling: Promise<number> | undefined;
    // Outside a race, a failure fails the scope: none starts after it.
    let failing = false;
    // One after another, an end stops the items after it.
    let ending = false;
    const settle = async (branch: number): Promise<number> => {
      settling ??= (async () => {
        const record = readRecord(
          await engine.do(
            named("task", id),
            captured(data),
            async (attempt) => ({
              output: null,
              branch: await attempt.settle({ branch }),
            })
          )
        );
        if (record.branch === undefined || record.branch >= count) {
          throw new TypeError("A scope settles on one of its own");
        }
        return record.branch;
      })();
      return await settling;
    };
    const settled = Promise.withResolvers<number>();
    const pool = pooled(
      count,
      limit,
      async (index) => {
        let done: ScopeEnd | null;
        try {
          done = await run(index, flowOf(engine, itemScope(within, id, index)));
        } catch (error) {
          // A step refused for a scope another settled over fails nothing
          // of the scope: the one that settled it still starts.
          failing ||= !compete && !fencedOff(error);
          return { ok: false, error };
        }
        if (done === null) {
          return null;
        }
        if (done.end === true) {
          ending = true;
        }
        if (
          (compete || (settles && done.end === true)) &&
          settling === undefined
        ) {
          settled.resolve(await settle(index));
        }
        return { ok: true, done };
      },
      async (index) => {
        // Once settled, only the one it settled on starts (it may be an
        // earlier activation's, not yet replayed to): none of the others.
        if (settling !== undefined) {
          return index === (await settling) ? "run" : "skip";
        }
        return failing || ending ? "stop" : "run";
      }
    );
    // Every one that started has ended, or the scope settled and the one
    // it settled on has: those it fenced off are left to the engine,
    // their next steps run no attempt, and their sleeps wait for nothing.
    const won = await Promise.race([
      (async (): Promise<undefined> => {
        await pool.all;
        return undefined;
      })(),
      (async () => {
        const branch = await settled.promise;
        return { branch, outcome: await pool.ends[branch]?.promise };
      })(),
    ]);
    const outcomes = await Promise.all(
      pool.ends.map(async (end) => {
        const outcome = await Promise.race([
          end.promise,
          Promise.resolve(null),
        ]);
        return outcome ?? undefined;
      })
    );
    if (settling === undefined) {
      // One after another, an end stops the items after it by itself.
      const ender = outcomes.find(
        (outcome) => outcome?.ok === true && outcome.done.end === true
      );
      return ender?.ok === true ? { outcomes, end: ender.done } : { outcomes };
    }
    const branch = won?.branch ?? (await settling);
    const winner = won?.outcome ?? outcomes[branch];
    if (winner?.ok !== true) {
      throw new TypeError("A scope settles on one that succeeded");
    }
    return winner.done.end === true
      ? { outcomes, end: winner.done }
      : { outcomes, won: winner.done };
  };
  const flow: Flow = {
    input: async (input, from) => {
      const record = readRecord(
        await engine.do(
          "workflow:input",
          { input, context: {} },
          async (attempt) => ({
            output: await from(scopeOf(attempt, { input, output: null })),
          })
        )
      );
      return record.output;
    },
    output: async (state, as) => {
      const data = { input: state.output, context: state.context };
      const record = readRecord(
        await engine.do("workflow:output", data, async (attempt) => ({
          output: await as(
            scopeOf(attempt, { input: state.output, output: state.output })
          ),
        }))
      );
      return record.output;
    },
    set: async (id, data, plan) => {
      const record = readRecord(
        await engine.do(named("task", id), captured(data), async (attempt) => {
          const frame = frameOf(data.input);
          if ((await enterStages(attempt, frame, plan)) === null) {
            return { skipped: true };
          }
          frame.output = await plan.set(scopeOf(attempt, frame));
          return await leaveStages(attempt, frame, data.context, plan);
        })
      );
      return stateAfter(data, record);
    },
    switch: async (id, data, plan) => {
      const { cases } = plan;
      if (!isStageList(cases) || cases.length >= maxCases) {
        throw new TypeError("A switch has its cases' conditions, in order");
      }
      const record = readRecord(
        await engine.do(named("task", id), captured(data), async (attempt) => {
          const frame = frameOf(data.input);
          await enterStages(attempt, frame, plan);
          const scope = scopeOf(attempt, frame);
          let branch = cases.length;
          for (const [index, condition] of cases.entries()) {
            // One at a time, in order: the first that holds is chosen, and
            // none after it is evaluated.
            // oxlint-disable-next-line no-await-in-loop -- see above
            if (holds(await condition(scope))) {
              branch = index;
              break;
            }
          }
          // A switch answers its (transformed) input.
          frame.output = frame.input;
          return {
            ...(await leaveStages(attempt, frame, data.context, plan)),
            branch,
          };
        })
      );
      const { branch } = record;
      if (record.skipped || branch === undefined || branch > cases.length) {
        throw new TypeError("A switch records the case it chose");
      }
      return { ...stateAfter(data, record), branch };
    },
    call: async (id, data, plan) => {
      const record = readRecord(
        await engine.do(named("task", id), captured(data), async (attempt) => {
          const frame = frameOf(data.input);
          if ((await enterStages(attempt, frame, plan)) === null) {
            return { skipped: true };
          }
          // The host builds the call from what the build sealed of the
          // task, on its transformed input, and makes it.
          frame.output = await attempt.call({ input: frame.input });
          return await leaveStages(attempt, frame, data.context, plan);
        })
      );
      return stateAfter(data, record);
    },
    enter: async (id, data, plan) => {
      const record = readRecord(
        await engine.do(
          named("enter", id),
          captured(data),
          async (attempt): Promise<FlowValue> => {
            const frame = frameOf(data.input);
            const entered = await enterStages(attempt, frame, plan);
            if (entered === null) {
              return { skipped: true };
            }
            return plan.until === true
              ? {
                  output: entered.input,
                  until: await attempt.until({ input: entered.input }),
                }
              : { output: entered.input };
          }
        )
      );
      if (
        plan.until === true &&
        !record.skipped &&
        record.until === undefined
      ) {
        throw new TypeError("A task's enter step records its deadline");
      }
      return record.skipped
        ? { skipped: true, input: data.input, until: 0 }
        : { skipped: false, input: record.output, until: record.until ?? 0 };
    },
    leave: async (id, data, entered, output, plan) => {
      const record = readRecord(
        await engine.do(
          named("leave", id),
          captured(data),
          async (attempt) =>
            await leaveStages(
              attempt,
              { input: entered, output },
              data.context,
              plan
            )
        )
      );
      if (record.skipped) {
        throw new TypeError("A task's leave step isn't skipped");
      }
      return stateAfter(data, record);
    },
    for: async (id, data, plan, body) => {
      const limit = concurrencyOf(plan.concurrency);
      const record = readRecord(
        await engine.do(
          named("enter", id),
          captured(data),
          async (attempt): Promise<FlowValue> => {
            const frame = frameOf(data.input);
            const entered = await enterStages(attempt, frame, plan);
            if (entered === null) {
              return { skipped: true };
            }
            return {
              output: entered.input,
              items: await attempt.items({ input: entered.input }),
            };
          }
        )
      );
      if (record.skipped) {
        return { output: data.input, context: data.context, end: false };
      }
      const { items } = record;
      if (items === undefined) {
        throw new TypeError("A for task's enter step records its items");
      }
      const input = record.output;
      // One after another, each item carries the context the one before
      // left; at once, each starts from the context the loop found.
      let carried = data.context;
      const ran = await scoped({
        id,
        data,
        count: items.length,
        limit,
        settles: limit > 1,
        run: async (index, flowIn) => {
          const context = limit > 1 ? data.context : carried;
          if (plan.while !== undefined) {
            const { while: condition } = plan;
            const checked = readRecord(
              await engine.do(
                stepOf("item", id, itemScope(within, id, index)),
                captured({ input, context }),
                async (attempt) => ({
                  output: holds(
                    await condition(scopeOf(attempt, frameOf(input)))
                  ),
                })
              )
            );
            if (checked.output !== true) {
              return null;
            }
          }
          const done = await body(flowIn, { output: input, context });
          if (limit === 1) {
            carried = done.context;
          }
          return done;
        },
      });
      if (ran.end !== undefined) {
        return {
          output: ran.end.output,
          context: limit > 1 ? data.context : ran.end.context,
          end: true,
        };
      }
      const failed = ran.outcomes.find((outcome) => outcome?.ok === false);
      if (failed !== undefined && !failed.ok) {
        throw failed.error;
      }
      const done = ran.outcomes.flatMap((outcome) =>
        outcome?.ok === true ? [outcome.done] : []
      );
      // One after another: the last item's output, or the input for none.
      // At once: every item's output, in item order (spec 13.5).
      const state: FlowState =
        limit > 1
          ? { output: done.map((one) => one.output), context: data.context }
          : { output: done.at(-1)?.output ?? input, context: carried };
      if (!leaves(plan)) {
        return { ...state, end: false };
      }
      return {
        ...(await flow.leave(
          id,
          { input: data.input, context: state.context },
          input,
          state.output,
          plan
        )),
        end: false,
      };
    },
    fork: async (id, data, plan, branches) => {
      if (
        !isBodyList(branches) ||
        branches.length === 0 ||
        branches.length > maxBranches
      ) {
        throw new TypeError("A fork has its branches, in order");
      }
      const limit = concurrencyOf(plan.concurrency);
      let { input } = data;
      if (enters(plan)) {
        const entered = await flow.enter(id, data, plan);
        if (entered.skipped) {
          return { output: data.input, context: data.context, end: false };
        }
        ({ input } = entered);
      }
      const compete = plan.compete === true;
      const ran = await scoped({
        id,
        data,
        count: branches.length,
        limit,
        settles: compete || limit > 1,
        compete,
        run: async (index, flowIn) => {
          const branch = branches[index];
          if (branch === undefined) {
            throw new TypeError("A fork has its branches, in order");
          }
          // Each branch from the context the fork found: never another
          // branch's exports.
          return await branch(flowIn, { output: input, context: data.context });
        },
      });
      if (ran.end !== undefined) {
        return { output: ran.end.output, context: data.context, end: true };
      }
      let output: FlowValue;
      if (compete) {
        if (ran.won === undefined) {
          // Every branch failed: the fork fails as the last one did.
          const last = ran.outcomes.findLast(
            (outcome) => outcome !== undefined
          );
          throw last?.ok === false
            ? last.error
            : new TypeError("A race ran no branch");
        }
        ({ output } = ran.won);
      } else {
        const failed = ran.outcomes.find((outcome) => outcome?.ok === false);
        if (failed !== undefined && !failed.ok) {
          throw failed.error;
        }
        output = ran.outcomes.map((outcome) =>
          outcome?.ok === true ? outcome.done.output : null
        );
      }
      if (!leaves(plan)) {
        return { output, context: data.context, end: false };
      }
      return {
        ...(await flow.leave(id, data, input, output, plan)),
        end: false,
      };
    },
    wait: async (id, milliseconds) => {
      const step = named("task", id);
      if (
        !isSafeInteger(milliseconds) ||
        milliseconds <= 0 ||
        milliseconds > maxWaitMs
      ) {
        throw new TypeError("A wait is a positive whole number of ms");
      }
      await engine.sleep(step, milliseconds);
    },
    sleepUntil: async (id, timestamp) => {
      const step = named("task", id);
      if (!isSafeInteger(timestamp) || timestamp < 0) {
        throw new TypeError("A deadline is a time in milliseconds");
      }
      await engine.sleepUntil(step, timestamp);
    },
  };
  return freeze(flow);
};

/**
 * A JSON workflow, as its generated code declares it: `body` runs its tasks
 * on the flow, from the run's input to its output.
 */
export const openWorkflow = (
  metadata: { readonly profile: typeof openWorkflowProfile },
  body: (flow: Flow, input: FlowValue) => Promise<FlowValue>
): OpenWorkflowDefinition => {
  // Checked at run time too: the generated code is held to the type, but
  // nothing in an isolate is trusted.
  const profile: string = metadata.profile;
  if (profile !== openWorkflowProfile) {
    throw new TypeError("Only grasp-open-workflow/1 runs here");
  }
  const definition: OpenWorkflowDefinition = {
    metadata: freeze({ profile: openWorkflowProfile }),
    run: async (engine, input) => await body(flowOf(engine), input),
  };
  return freeze(definition);
};

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
   * its items, and their keys where its loop has them
   * (`metadata.grasp.key`), which the step records.
   */
  readonly items: (
    frame: CallFrame
  ) => Promise<{ items: FlowValue[]; keys?: FlowValue[] }>;
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

/** Scope `scope` with the item `index` of `for` task `id` inside it. */
const itemScope = (scope: string, id: string, index: number): string =>
  `${scope === "" ? "" : `${scope}/`}${requireTaskId(id)}.${index}`;

// `Array.isArray` doesn't narrow a readonly array type.
const isStageList = (value: readonly Stage[]): value is readonly Stage[] =>
  isArray(value);

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
  /** Their keys, where its loop has them, which run history shows. */
  readonly keys?: readonly FlowValue[];
}

/** What a `for` task's enter step recorded of its items: them, and their keys. */
const loopRecordOf = (
  value: Record<string, FlowValue>
): Pick<StepRecord, "items" | "keys"> => {
  const { items, keys } = value;
  if (items !== undefined && !isArray(items)) {
    throw new TypeError("A for task's enter step records its items");
  }
  if (keys !== undefined && (!isArray(keys) || items === undefined)) {
    throw new TypeError("A for task's enter step records keys with its items");
  }
  return {
    ...(items === undefined ? {} : { items }),
    ...(keys === undefined ? {} : { keys }),
  };
};

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
  const { branch, until } = value;
  const loop = loopRecordOf(value);
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
    ...loop,
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
            const { items, keys } = await attempt.items({
              input: entered.input,
            });
            return {
              output: entered.input,
              items,
              ...(keys === undefined ? {} : { keys }),
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
      let state: FlowState = { output: input, context: data.context };
      for (const index of items.keys()) {
        const scoped = itemScope(within, id, index);
        const itemData = { input, context: state.context };
        if (plan.while !== undefined) {
          const { while: condition } = plan;
          // One item after another: each item's check, then its list.
          // oxlint-disable-next-line no-await-in-loop -- see above
          const recorded = await engine.do(
            stepOf("item", id, scoped),
            captured(itemData),
            async (attempt) => ({
              output: holds(await condition(scopeOf(attempt, frameOf(input)))),
            })
          );
          const checked = readRecord(recorded);
          if (checked.output !== true) {
            break;
          }
        }
        // oxlint-disable-next-line no-await-in-loop -- one item at a time
        const done = await body(flowOf(engine, scoped), {
          output: input,
          context: state.context,
        });
        state = { output: done.output, context: done.context };
        if (done.end === true) {
          return { ...state, end: true };
        }
      }
      const hasLeave =
        plan.outputAs !== undefined ||
        plan.outputSchema === true ||
        plan.exportAs !== undefined ||
        plan.exportSchema === true;
      if (!hasLeave) {
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

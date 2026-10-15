/**
 * The SDK of JSON workflows (grasp-open-workflow/1): what the code the host
 * generates from a workflow.json imports, and nothing else does. A builder
 * never writes against it: the host lowers each task of a validated
 * definition into a call here, in ordinary TypeScript control flow, and
 * seals that code with the version (core's workflow-builds.ts).
 *
 * ```ts
 * export default openWorkflow({ profile: "grasp-open-workflow/1" }, async (flow, input) => {
 *   const context: FlowValue = {};
 *   let output: FlowValue = input;
 *   output = await flow.task("finish", { input: output, context }, async (task) => ({
 *     ["status"]: await task.evaluate(0),
 *   }));
 *   return output;
 * });
 * ```
 *
 * Each task is one durable step of the run, its output recorded: a replay
 * answers the recorded output and runs nothing of the task again. An
 * expression is evaluated by the host, by its number in the expression
 * table sealed with the code, on the data the task's step captured as it
 * started; the code never holds an expression's source, and nothing it
 * passes becomes one. Parameters, the workflow's own input and the task's
 * descriptor are the host's to supply: they come from what the start froze,
 * never from here.
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

/** What generated code may do inside one task's step. */
export interface TaskScope {
  /**
   * Evaluates expression `slot` of the sealed table, one of this task's,
   * on the data its step captured: its one result.
   */
  readonly evaluate: (slot: number) => Promise<FlowValue>;
}

/** What a task's step works on: its input and the workflow's context. */
export interface TaskData {
  readonly input: FlowValue;
  readonly context: FlowValue;
}

/** The tasks generated code runs, one after the other. */
export interface Flow {
  /**
   * Runs task `id` as a durable step on `data`: its output is what `build`
   * answers, recorded once, so a replay answers the same without calling
   * `build` again.
   */
  readonly task: (
    id: string,
    data: TaskData,
    build: (task: TaskScope) => Promise<FlowValue>
  ) => Promise<FlowValue>;
  /** Durably waits `milliseconds` as task `id`, holding no isolate. */
  readonly wait: (id: string, milliseconds: number) => Promise<void>;
}

/**
 * What core's run module hands a definition: the run's durable steps. Every
 * call goes to the host, which checks it again; nothing here is trusted.
 */
export interface OpenWorkflowEngine {
  /**
   * Runs `fn` as the step `name`, `input` captured as its data; `fn` gets
   * the step's attempt, through which it evaluates.
   */
  readonly do: (
    name: string,
    input: FlowValue,
    fn: (attempt: TaskScope) => Promise<FlowValue>
  ) => Promise<FlowValue>;
  readonly sleep: (name: string, milliseconds: number) => Promise<void>;
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
 * The runtime's own `Object.freeze` and `Number.isSafeInteger`, kept as this
 * module loads: core's run module loads it before the generated module.
 */
const { freeze } = Object;
const { isSafeInteger } = Number;

/** A task's ID as the profile has it: kebab-case, at most 64 characters. */
const taskIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const maxTaskIdLength = 64;

/** The longest a task may wait, as the engine takes it: 365 days. */
const maxWaitMs = 365 * 86_400_000;

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

/** The step a task runs as: its ID under `task:`, as the host checks it. */
const stepOf = (id: string): string => `task:${id}`;

/** The flow generated code runs on, over `engine`. */
const flowOf = (engine: OpenWorkflowEngine): Flow => {
  const flow: Flow = {
    task: async (id, data, build) => {
      const step = stepOf(requireTaskId(id));
      return await engine.do(
        step,
        { input: data.input, context: data.context },
        async (attempt) => {
          const scope: TaskScope = {
            evaluate: async (slot) => {
              if (!isSafeInteger(slot) || slot < 0) {
                throw new TypeError("An expression's slot is its number");
              }
              return await attempt.evaluate(slot);
            },
          };
          return await build(freeze(scope));
        }
      );
    },
    wait: async (id, milliseconds) => {
      const step = stepOf(requireTaskId(id));
      if (
        !isSafeInteger(milliseconds) ||
        milliseconds <= 0 ||
        milliseconds > maxWaitMs
      ) {
        throw new TypeError("A wait is a positive whole number of ms");
      }
      await engine.sleep(step, milliseconds);
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

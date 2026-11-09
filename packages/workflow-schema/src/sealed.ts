import {
  appErrorCodeMaxLength,
  appErrorCodePattern,
  appErrorMessageMaxLength,
  isAppErrorCode,
} from "@grasp-os/shared/function-limits";
import { sealedBuildLimits } from "@grasp-os/shared/sealed-builds";
import { workflowModulePattern } from "@grasp-os/shared/workflow-modules";
import {
  workflowEventTypeSchema,
  workflowStateKeySchema,
} from "@grasp-os/shared/workflow-resources";
import { z } from "zod";

import {
  brainActions,
  filesActions,
  formatLimits,
  stepIdPattern,
} from "./format.ts";
import type { Json } from "./format.ts";

// The sealed table: what the generator (generate.ts) writes beside the
// module it generates, and all the run host (core's workflows/sealed-run.ts)
// trusts of a run's build. Its one home, so the generator's types and the
// host's reading are the same thing. It holds exactly what the generator
// writes, nothing more: a table that holds anything else, a construct the
// format doesn't have included, doesn't load (`workflow.version_corrupt`),
// so the host never meets a step it has no rule for.

/** A task's ID: its step's, as the format has it. */
const taskIdSchema = z
  .string()
  .max(formatLimits.idLength)
  .regex(new RegExp(stepIdPattern, "u"));

/** The most `forEach` loops one inside another a task runs in. */
const maxTaskScopes = formatLimits.depth;

/**
 * A value the host builds or checks a call by: a literal, an expression's
 * slot (any JSON the isolate computed), a sensitive parameter the host
 * fills in, or an object (its entries, in order) or array of those.
 */
export type Template =
  | { literal: Json }
  | { slot: number }
  | { param: string }
  | { object: [string, Template][] }
  | { array: Template[] };

const templateSchema: z.ZodType<Template> = z.lazy(() =>
  z.union([
    z.strictObject({ literal: z.json() }),
    z.strictObject({ slot: z.int().min(0) }),
    z.strictObject({ param: z.string().min(1).max(64) }),
    z.strictObject({
      object: z
        .array(
          z.tuple([
            z.string().max(sealedBuildLimits.templateKeyLength),
            templateSchema,
          ])
        )
        .max(sealedBuildLimits.templateItems),
    }),
    z.strictObject({
      array: z.array(templateSchema).max(sealedBuildLimits.templateItems),
    }),
  ])
);

/** Whether `template` names a sensitive parameter anywhere in it. */
const namesParam = (template: Template): boolean => {
  if ("param" in template) {
    return true;
  }
  if ("object" in template) {
    return template.object.some(([, item]) => namesParam(item));
  }
  return "array" in template && template.array.some(namesParam);
};

/** The most keys one task keeps in its workflow's state. */
const maxStateKeys = 64;

const aliasSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u);

/** One of the workflow's own modules' exports, as its binding names it. */
const ownExport = {
  module: z.string().regex(workflowModulePattern).max(256),
  export: z
    .string()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u)
    .max(256),
};

/** A call task's call, as the host checks and makes it. */
const sealedCallSchema = z.discriminatedUnion("name", [
  z.strictObject({
    name: z.literal("grasp.connector"),
    binding: aliasSchema,
    operation: z.string().min(1).max(256),
    arguments: templateSchema,
    /**
     * The files permission a read that answers a file keeps it in, as a
     * file of the run, and the one a write's attachments are run files of:
     * the build's choice alone, which the call's code must name the same.
     */
    into: aliasSchema.optional(),
    from: aliasSchema.optional(),
  }),
  z.strictObject({
    /** One call on the run's own files, through a files permission. */
    name: z.literal("grasp.files"),
    binding: aliasSchema,
    operation: z.enum(filesActions),
    arguments: templateSchema,
  }),
  z.strictObject({
    /** One read of a Brain collection, through a brain permission. */
    name: z.literal("grasp.brain"),
    binding: aliasSchema,
    operation: z.enum(brainActions),
    arguments: templateSchema,
  }),
  z.strictObject({
    name: z.literal("grasp.model"),
    binding: aliasSchema,
    instructions: templateSchema,
    input: templateSchema,
    /** Its output's descriptor: the SDK's native validator reads it. */
    outputSchema: z.json(),
  }),
  z.strictObject({
    name: z.literal("grasp.sleepUntil"),
    timestamp: templateSchema,
  }),
  z.strictObject({
    name: z.literal("grasp.decision"),
    binding: aliasSchema,
    recipients: templateSchema,
    prompt: templateSchema,
    input: templateSchema,
    /**
     * How long it takes answers, sealed only when its step names a
     * timeout: without one, the host waits as long as the run may.
     */
    timeoutMs: z.int().positive().optional(),
  }),
  z.strictObject({
    name: z.literal("grasp.compute"),
    binding: aliasSchema,
    ...ownExport,
    arguments: templateSchema,
  }),
  z.strictObject({
    name: z.literal("grasp.action"),
    binding: aliasSchema,
    ...ownExport,
    arguments: templateSchema,
  }),
]);

export type SealedCall = z.infer<typeof sealedCallSchema>;

/**
 * An event wait's events, as the host takes them: the first of any of its
 * types sent through its event binding, matched by type alone, or with
 * `match` by the value its task's enter step records (`{ key }`, held to
 * `equals`) at JSON Pointer `field` of the data of an event source's
 * event (core's workflows/event-waits.ts); its output is that event's
 * envelope as the host minted it.
 */
const sealedListenSchema = z.strictObject({
  binding: aliasSchema,
  strategy: z.literal("any"),
  filters: z
    .array(
      z.strictObject({
        type: workflowEventTypeSchema,
        attributes: z.tuple([]),
      })
    )
    .min(1)
    .max(sealedBuildLimits.eventTypes),
  match: z
    .strictObject({
      field: z
        .string()
        .min(2)
        .max(256)
        .regex(/^(?:\/(?:[^~/]|~[01])*)+$/u),
      equals: templateSchema,
    })
    .optional(),
});

/** An `AppError` code, as a catch takes one and a raise fails with one. */
const errorCodeSchema = z
  .string()
  .max(appErrorCodeMaxLength)
  .regex(appErrorCodePattern);

/**
 * A try task's catch, as the host decides it: the code a failure must
 * have for it to take it (any, without one), the slot of its `when`,
 * which its code decides, and its retry policy, in milliseconds, which
 * the host runs for a failure of a call in its list (a call's `retry`
 * says whether its `when` holds).
 */
const sealedCatchSchema = z.strictObject({
  variable: z.string().min(1).max(64),
  code: errorCodeSchema.optional(),
  when: z.int().min(0).optional(),
  retry: z
    .strictObject({
      attempts: z.int().min(1).max(5),
      delayMs: z.int().min(0),
      backoff: z.enum(["constant", "linear", "exponential"]),
    })
    .optional(),
});

export type SealedCatch = z.infer<typeof sealedCatchSchema>;

const taskBase = {
  id: taskIdSchema,
  pointer: z.string().max(sealedBuildLimits.pointerLength),
  /**
   * Its engine steps, `<id>:<step>` (from its second run in a loop's
   * items on, `<id>:<step>@<count>`), besides a decision's parts: none
   * for an `if`, a loop, a `try` or a raise, whose flow is the code's.
   */
  steps: z.array(z.enum(["enter", "task"])).max(2),
  /**
   * The `for` tasks around it, outermost first: a task in none runs at
   * most once.
   */
  scope: z.array(taskIdSchema).max(maxTaskScopes),
  /** The most an attempt of its steps may take, from its `timeout`. */
  timeoutMs: z.int().positive().optional(),
  /**
   * What it keeps in its workflow's state once it succeeded, by key: each
   * value's template, as a call's (its expressions' slots, its literals
   * exact), which never names a sensitive parameter, as every later run
   * of the workflow reads it; and the descriptor of the value it takes,
   * which the host holds it to. Only a call that doesn't wait keeps any
   * (`keepsState`), on its task step, its record with `state` beside.
   */
  state: z
    .record(
      workflowStateKeySchema,
      z.strictObject({ template: templateSchema, value: z.json() })
    )
    .refine(
      (state) =>
        Object.keys(state).length <= maxStateKeys &&
        !Object.values(state).some(({ template }) => namesParam(template))
    )
    .optional(),
};

/** One task of the module, as the host checks its steps. */
const sealedTaskSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...taskBase,
    kind: z.literal("raise"),
    /**
     * The workflow's own `AppError` its code throws, literal: a run that
     * fails with an `AppError` of a code no raise seals fails as the
     * platform's, never with that code.
     */
    error: z.strictObject({
      // Never in a platform namespace: a raise is the workflow's own.
      code: errorCodeSchema.refine((code) => isAppErrorCode(code)),
      message: z.string().min(1).max(appErrorMessageMaxLength),
      details: z.json().optional(),
    }),
  }),
  z.strictObject({
    ...taskBase,
    kind: z.literal("try"),
    catch: sealedCatchSchema,
  }),
  z.strictObject({ ...taskBase, kind: z.literal("switch") }),
  z.strictObject({
    ...taskBase,
    kind: z.literal("for"),
    /**
     * Its items, for review: the slot of the list its code goes over, the
     * name its items' code reads each by, and the slot of its `while`.
     */
    loop: z.strictObject({
      in: templateSchema,
      each: z.string().min(1).max(64),
      while: z.int().min(0).optional(),
    }),
  }),
  z.strictObject({
    ...taskBase,
    kind: z.literal("wait"),
    /** How long its task step sleeps. */
    milliseconds: z.int().positive(),
  }),
  z.strictObject({
    ...taskBase,
    kind: z.literal("call"),
    call: sealedCallSchema,
  }),
  z.strictObject({
    ...taskBase,
    kind: z.literal("listen"),
    /** Its deadline: an event wait never waits without one. */
    timeoutMs: z.int().positive(),
    listen: sealedListenSchema,
  }),
]);

export type SealedTask = z.infer<typeof sealedTaskSchema>;

/**
 * Whether `task` may keep state (`SealedTask.state`): a call whose task
 * step records its result, never a sleep or a decision, whose steps record
 * their wait, nor any other kind, whose task step, if any, isn't its
 * result. Its task step is its state step.
 */
export const keepsState = (task: SealedTask): boolean =>
  task.kind === "call" &&
  task.call.name !== "grasp.sleepUntil" &&
  task.call.name !== "grasp.decision";

/** One expression of the module, for review: where it is, what it says. */
const sealedExpressionSchema = z.strictObject({
  slot: z.int().min(0),
  pointer: z.string().max(sealedBuildLimits.pointerLength),
  /** Its task; null for the workflow's output. */
  taskId: taskIdSchema.nullable(),
  stage: z.enum(["taskIf", "taskDefinition", "taskState", "workflowOutputAs"]),
  /** What it must answer: a condition a boolean. */
  result: z.enum(["boolean", "json"]),
  source: z.string().max(sealedBuildLimits.expressionLength),
  /** The variables of the loops around its task, outermost first. */
  loopVariables: z.array(z.string().min(1).max(64)).max(2 * maxTaskScopes),
  /** The caught errors it may read, innermost last. */
  caught: z
    .array(
      z.strictObject({
        variable: z.string().min(1).max(64),
        taskId: taskIdSchema,
      })
    )
    .max(16)
    .optional(),
});

export type SealedExpression = z.infer<typeof sealedExpressionSchema>;

/** The table, as a build seals it (`tasks.json`). */
export const sealedTableSchema = z.strictObject({
  tasks: z
    .array(sealedTaskSchema)
    .max(sealedBuildLimits.tasks)
    .refine((tasks) =>
      tasks.every(
        (task) =>
          task.state === undefined ||
          Object.keys(task.state).length === 0 ||
          keepsState(task)
      )
    ),
  expressions: z
    .array(sealedExpressionSchema)
    .max(sealedBuildLimits.expressions),
  /** Whether the workflow returns a result, recorded in `workflow:output`. */
  workflow: z.strictObject({ output: z.boolean() }),
  /** The parameters its code reads: those that aren't sensitive. */
  params: z.array(z.string().min(1).max(64)).max(64),
});

export type SealedTable = z.infer<typeof sealedTableSchema>;

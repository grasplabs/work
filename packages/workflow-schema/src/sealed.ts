import { sealedBuildLimits } from "@grasp-os/shared/sealed-builds";
import { workflowModulePattern } from "@grasp-os/shared/workflow-modules";
import {
  workflowEventTypeSchema,
  workflowStateKeySchema,
} from "@grasp-os/shared/workflow-resources";
import { z } from "zod";

import { formatLimits, stepIdPattern } from "./format.ts";
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

/** A try task's catch, as the host decides it. */
const sealedCatchSchema = z.strictObject({
  variable: z.string().min(1).max(64),
  /** The properties a failure must have for it to take it. */
  errors: z
    .strictObject({
      type: z.string().max(2048).optional(),
      status: z.int().optional(),
    })
    .optional(),
  /** The slot of its `when`, which its code decides. */
  when: z.int().min(0).optional(),
  /** Its retry policy, in milliseconds. */
  retry: z
    .strictObject({
      attempts: z.int().min(1).max(5),
      delayMs: z.int().min(0),
      backoff: z.enum(["constant", "linear", "exponential"]),
      when: z.int().min(0).optional(),
    })
    .optional(),
});

export type SealedCatch = z.infer<typeof sealedCatchSchema>;

const taskBase = {
  id: taskIdSchema,
  pointer: z.string().max(sealedBuildLimits.pointerLength),
  /** Its engine steps, `<id>:<step>`, besides a decision's parts. */
  steps: z.array(z.enum(["task", "enter", "leave", "item", "catch"])).max(4),
  /**
   * The `for` tasks around it, outermost first: each of its steps runs in
   * an item of each.
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
    /** The workflow's own error its step fails with, literal. */
    error: z.strictObject({
      type: z.string().min(1).max(2048),
      status: z.int().min(400).max(599),
      title: z.string().max(2000).optional(),
      detail: z.string().max(2000).optional(),
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
     * Its items, one at a time, in order: the collection its enter step
     * records (`in`, which the host reads from that record, not from
     * here), the names its items' code reads them by, and the slot of its
     * `while`, which each item's `item` step records.
     */
    loop: z.strictObject({
      in: templateSchema,
      each: z.string().min(1).max(64),
      at: z.string().min(1).max(64),
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
  /** Whether the workflow has an output, evaluated in `workflow:output`. */
  workflow: z.strictObject({ output: z.boolean() }),
  /** The parameters its code reads: those that aren't sensitive. */
  params: z.array(z.string().min(1).max(64)).max(64),
});

export type SealedTable = z.infer<typeof sealedTableSchema>;

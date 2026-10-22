import type { ValueDescriptor } from "@grasp-os/sdk";
import type { Stage } from "@grasp-os/workflow-expressions/evaluate";
import { parseSlot } from "@grasp-os/workflow-expressions/source";

import { pointerJoin } from "./diagnostics.ts";
import { isObject } from "./json-text.ts";
import type { JsonObject, JsonValue } from "./json-text.ts";
import type { CheckedWorkflow } from "./validate.ts";
import { literalDurationMs } from "./values.ts";

/**
 * Code generation: a validated definition lowered, deterministically, into
 * ordinary TypeScript against `@grasp-os/sdk/open-workflow`, which the
 * host type-checks, compiles and seals with the version. The generated
 * module runs the tasks itself, one statement each, in the definition's
 * order, nested `do` lists as nested blocks and transitions as `break`s:
 * it doesn't hand the definition to an interpreter.
 *
 * Threat model, and how each is closed:
 *
 * - Text from the definition escaping into code. No value of the
 *   definition is ever spliced into source as written: every string,
 *   number and key becomes a literal through `JSON.stringify`, whose output
 *   is a JavaScript literal of exactly that value (quotes, backslashes,
 *   line separators, `${`, backticks and `*\/` included), and every key a
 *   computed property, so not even `__proto__` can mean anything but a key.
 *   The module's only comment is a fixed header: no definition text.
 * - Task IDs and case names becoming code. A transition's target is
 *   resolved here, against its own list, to a label the generator makes
 *   from counters (`t3_5`, `s3`, `workflow`); no ID or case name is ever
 *   a label, a variable or a runtime lookup. A switch's outcome is the
 *   index of its case.
 * - Control flow that loops. Generated code has no loop statement: a
 *   transition is a `break` out of a labelled block, which can only move
 *   forward, to a later sibling (a block that closes before it), out of
 *   its list (`exit`) or out of the workflow (`end`, or, inside a loop's
 *   item, a return that tells the loop so). A target that isn't strictly
 *   later in the same list is never emitted, whatever validation said
 *   (`resolveTarget` throws). A `for` task is a call of the SDK's loop
 *   (`flow.for`), its list a function the SDK runs once per item of the
 *   collection its enter step recorded (sequentially; items at once and
 *   items' own keys aren't lowered yet), so every task runs at most once
 *   per item of the loops around it, and a run's steps are bounded by its
 *   tasks and its loops' recorded items; core refuses any step run twice,
 *   and any item no loop recorded, all the same (resource-host.ts).
 * - Expressions becoming code. An expression's source never enters the
 *   module: the module names it by its number in the expression table
 *   sealed beside it, and the host evaluates that table's entry with the
 *   pinned jq, at the stage, of the task and step, sealed with it. A
 *   string that isn't wholly `${ … }` stays a literal.
 * - Generated code reaching past the SDK. The module imports
 *   `@grasp-os/sdk/open-workflow` and nothing else; the compiler refuses
 *   any other import of generated code all the same.
 * - Lowering something it doesn't implement. Every construct is checked
 *   against what this generator lowers: anything else (other task kinds
 *   and named calls, a workflow's own timeout, a nested list's or a wait's
 *   timeout, reusable definitions) is reported
 *   as unsupported, with its pointer, and nothing is generated. Nothing is
 *   approximated, skipped or left to run time.
 * - A task that makes core spend without bound. A run evaluates each
 *   expression in core, so no stage of a task holds more than
 *   {@link maxTaskExpressions} of them, and no step (what one attempt
 *   evaluates) more than {@link maxStepExpressions}; one with more isn't
 *   lowered.
 * - Sensitive parameters leaving through a run's output. No expression may
 *   read one (`sensitiveReads`): publication refuses it. A sensitive
 *   parameter reaches a call only as a binding argument: a value of a
 *   connector call's `arguments` that is exactly `${ $params.<name> }`
 *   becomes a `param` node of the call's template (`templateOf`), never an
 *   expression, so no jq sees it and no isolate holds it: the host puts
 *   the value in as it sends the call to connect. The build seals the
 *   names of the others (`params`), and a run's host gives expressions
 *   only those, so a gap in that analysis reads nothing.
 * - A named call reaching what its source didn't name. A call's binding
 *   and operation are literals the generator seals in the task table
 *   (`GeneratedCall`), never values of the generated code, and its
 *   arguments a template of literals, sealed expressions and binding
 *   arguments (`CallTemplate`) that the host builds itself: the generated
 *   code only asks for the task's call, by its task, and can't change what
 *   is called or with what. The host refuses a binding the run's start
 *   didn't freeze, and checks each call's authority again as it makes it
 *   (core's workflows/resource-calls.ts).
 * - A listen taking events its source didn't name. Its binding, each
 *   filter's type and the attribute names it requires are literals the
 *   generator seals in the task table (`GeneratedListen`); an attribute's
 *   value is a literal or a sealed expression the host evaluates in the
 *   task's enter step. The generated code only asks the host to listen,
 *   by its task: the host matches events in the run's own inbox by what
 *   it recorded, never by anything the code passes. A filter's
 *   `correlate`, which would evaluate expressions over each event's own
 *   content, is reported as unsupported.
 * - Limits raising the host's ceilings. `document.metadata.grasp.limits`
 *   and a task's `timeout` (inline or from `use.timeouts`) are sealed as
 *   numbers, which the host only ever applies as the lower of them and its
 *   own ceiling; validation refuses a limit above the host's ceilings
 *   besides. A limit nothing would hold (`maxActiveMs`, until GRA-567)
 *   is reported as unsupported, never sealed and ignored.
 */

/**
 * The most expressions one stage of a lowered task holds (its `if`, its
 * `input.from`, its own value or cases, its `output.as`, its `export.as`).
 * Each is evaluated in core within the evaluator's fuel (about 100 ms of
 * CPU at most), and an attempt has a fuel budget of its own across all its
 * task's stages (core's resource-host.ts), so the count bounds the table,
 * not the CPU. 64 is many times what a stage's data needs, and lets every
 * case of the profile's largest switch (64 cases) have its condition.
 */
export const maxTaskExpressions = 64;

/**
 * The most expressions one step evaluates, its stages together: a switch's
 * conditions and its data flow, a set's value and its. Core charges each
 * evaluation a fixed cost against the attempt's fuel budget (core's
 * resource-host.ts), so this many trivial ones take half of it.
 */
export const maxStepExpressions = 128;

/** The generator's identity: part of every build it makes. */
export const generatorVersion = "grasp-open-workflow-ts/7";

/** Where the generated module is among a version's files. */
export const generatedPath = ".grasp/workflow.ts";

/** The module generated code imports, and the only one. */
export const generatedImport = "@grasp-os/sdk/open-workflow";

/**
 * The type an expression's result must have where it sits: a condition a
 * boolean, a wait's duration whole milliseconds or a fixed ISO 8601
 * duration (the evaluator's `duration`), anything else one JSON value.
 */
export type ExpressionResult = "boolean" | "duration" | "json";

/** One expression of the sealed table, by its number (`slot`). */
export interface SealedExpression {
  readonly slot: number;
  readonly pointer: string;
  /** Its task; `null` for the workflow's own `input.from` and `output.as`. */
  readonly taskId: string | null;
  readonly stage: Stage;
  /** A condition (`if`, a case's `when`) must answer a boolean. */
  readonly result: ExpressionResult;
  readonly source: string;
  /**
   * The variables of the loops around it, as it was compiled: its `for`
   * tasks' `each` and `at`, outermost first. Empty outside any loop.
   */
  readonly loopVariables: readonly string[];
}

/** The task kinds this generator lowers. */
export type LoweredKind =
  | "call"
  | "do"
  | "for"
  | "listen"
  | "set"
  | "switch"
  | "wait";

/**
 * A `listen` task's events, as the build seals them: the event binding
 * its `metadata.grasp.binding` names, how many of its filters it waits
 * for (`one` and `any` an event, `all` one per filter, in their order),
 * what of each event its output holds, and its filters: each a literal
 * type the binding admits and the attributes it requires, each a literal
 * or an expression the host evaluates, once, in the task's enter step.
 */
export interface GeneratedListen {
  readonly binding: string;
  readonly strategy: "one" | "any" | "all";
  readonly read: "data" | "envelope";
  readonly filters: readonly GeneratedFilter[];
}

/** One filter of a `listen` task (`GeneratedListen`). */
export interface GeneratedFilter {
  readonly type: string;
  readonly attributes: readonly (readonly [string, CallTemplate])[];
}

/**
 * A value the host builds itself when a task's call is made, or its
 * deadline resolved: a literal, the result of a sealed expression (by its
 * slot, of the task's own `taskDefinition` stage), a sensitive parameter's
 * value as a binding argument (only in a connector call's `arguments`), or
 * an object or array of those. An object is its entries in order, so no
 * key, not even `__proto__`, is ever a property of the template itself.
 */
export type CallTemplate =
  | { readonly literal: JsonValue }
  | { readonly slot: number }
  | { readonly param: string }
  | { readonly object: readonly (readonly [string, CallTemplate])[] }
  | { readonly array: readonly CallTemplate[] };

/** A task's named call, as the build seals it and the host makes it. */
export type GeneratedCall =
  | { readonly name: "grasp.now" }
  | { readonly name: "grasp.random" }
  | {
      readonly name: "grasp.operation";
      readonly binding: string;
      readonly arguments: CallTemplate;
    }
  | {
      readonly name: "grasp.connector";
      readonly binding: string;
      readonly operation: string;
      readonly arguments: CallTemplate;
    }
  | {
      readonly name: "grasp.model";
      readonly binding: string;
      readonly instructions: CallTemplate;
      readonly input: CallTemplate;
      /** The descriptor of `outputSchema`: the model's answer must match. */
      readonly outputSchema: ValueDescriptor;
      readonly model?: CallTemplate;
      readonly maxOutputTokens?: CallTemplate;
    }
  | { readonly name: "grasp.sleepUntil"; readonly timestamp: CallTemplate }
  | {
      readonly name: "grasp.compute";
      readonly binding: string;
      /** The workflow's own module its binding names: `code/<file>.ts`. */
      readonly module: string;
      /** The module's export the binding names. */
      readonly export: string;
      readonly arguments: CallTemplate;
    }
  | {
      /**
       * A `grasp.operation` call of a binding to one of the workflow's own
       * actions (`local:code/<file>.ts#<export>`): run by the host in the
       * modules' sandbox, never through the catalog.
       */
      readonly name: "grasp.action";
      readonly binding: string;
      readonly module: string;
      readonly export: string;
      readonly arguments: CallTemplate;
    };

/** The named calls this generator lowers. */
export type LoweredCall = GeneratedCall["name"];

/** A workflow's own limits, as its metadata lowers the host's ceilings. */
export interface WorkflowLimits {
  readonly maxSteps?: number;
  readonly maxModelCalls?: number;
}

/**
 * A step a task runs as, besides a `wait`'s sleep: an `item` step is a
 * `for` task's check of its `while`, before each item.
 */
export type TaskStep = "task" | "enter" | "leave" | "item";

/** A task's data the host checks against the task's own schema. */
export type TaskSchemas = Readonly<
  Partial<Record<"input" | "output" | "export", ValueDescriptor>>
>;

/** One task of the generated module, and the steps it runs as. */
/**
 * The lines a task's code takes in the generated module, from 1, both
 * ends included: where a diagnostic of the module is, in the definition's
 * terms (`taskAtLine`).
 */
export interface TaskSpan {
  readonly taskId: string;
  readonly pointer: string;
  readonly from: number;
  readonly to: number;
}

/**
 * The task whose generated code `line` falls in: the innermost, the one
 * of the shortest span that holds it; undefined for a line of no task's
 * (the module's own frame).
 */
export const taskAtLine = (
  spans: readonly TaskSpan[],
  line: number
): TaskSpan | undefined => {
  let inner: TaskSpan | undefined;
  for (const span of spans) {
    const holds = span.from <= line && line <= span.to;
    if (
      holds &&
      (inner === undefined || span.to - span.from < inner.to - inner.from)
    ) {
      inner = span;
    }
  }
  return inner;
};

export interface GeneratedTask {
  readonly id: string;
  readonly kind: LoweredKind;
  readonly pointer: string;
  /** Its first line in the generated module, from 1. */
  readonly line: number;
  /** How long a `wait` task of a literal duration waits, as its statement says. */
  readonly milliseconds?: number;
  /**
   * The duration of a `wait` task whose duration is an expression: the
   * host resolves it once, in the task's enter step, to an absolute
   * deadline, which the step records.
   */
  readonly duration?: CallTemplate;
  /** A `call` task's named call. */
  readonly call?: GeneratedCall;
  /** A `listen` task's events. */
  readonly listen?: GeneratedListen;
  /**
   * A `call` or `wait` task's `input.from`, as a template of the
   * expressions its module evaluates for it (their slots) and its
   * literals: the host builds the transformed input from its own
   * evaluations, and makes the call or resolves the deadline only on that
   * (resource-host.ts).
   */
  readonly inputFrom?: CallTemplate;
  /**
   * A `call` task's `output.as` and `export.as`, sealed as its `input.from`
   * is: the host holds what its step records to its call's answer as they
   * transform it.
   */
  readonly outputAs?: CallTemplate;
  readonly exportAs?: CallTemplate;
  /**
   * The most each attempt of its steps may take, in milliseconds, from its
   * `timeout`: the host applies the lower of this and its own ceiling.
   */
  readonly timeoutMs?: number;
  /**
   * The `for` tasks around it, outermost first: each of its steps runs in
   * the scope of an item of each (`task:<id>@<for>.<index>/…`). Empty for
   * a task of the workflow's own list.
   */
  readonly scope: readonly string[];
  /**
   * A `for` task's loop: its collection (`for.in`), which the host
   * resolves in its enter step, and its items' keys
   * (`metadata.grasp.key`), each built by the host on the item; the names
   * its items' variables have; and the slot of its `while`, which each
   * item's `item` step evaluates.
   */
  readonly loop?: {
    readonly in: CallTemplate;
    readonly key?: CallTemplate;
    readonly each: string;
    readonly at: string;
    readonly while?: number;
  };
  /**
   * Its durable steps (`task:<id>` for a `set`, `switch` or call; `enter:<id>`
   * and `leave:<id>` around a wait's sleep or a `do`'s list, when it has
   * stages there, and always an `enter:<id>` that resolves a deadline).
   */
  readonly steps: readonly TaskStep[];
  /** The descriptors of its input, output and export schemas. */
  readonly schemas: TaskSchemas;
}

/** The workflow's own data flow, each a step when present. */
export interface WorkflowFlow {
  readonly input: boolean;
  readonly output: boolean;
}

/** A construct the generator doesn't lower (yet). */
export interface Unsupported {
  readonly pointer: string;
  readonly taskId?: string;
  /** What it is: a task kind (`call:grasp.model`), or a property. */
  readonly feature: string;
}

export type Generation =
  | {
      readonly ok: true;
      readonly source: string;
      readonly expressions: readonly SealedExpression[];
      readonly tasks: readonly GeneratedTask[];
      /** The lines each task's code takes in `source`. */
      readonly spans: readonly TaskSpan[];
      readonly workflow: WorkflowFlow;
      /** The parameters expressions may read: those not sensitive. */
      readonly params: readonly string[];
      /** The workflow's own limits, which may only lower the host's. */
      readonly limits: WorkflowLimits;
    }
  | { readonly ok: false; readonly unsupported: readonly Unsupported[] };

/** Most unsupported constructs reported: the rest are the same kind of news. */
const maxUnsupported = 20;

/**
 * What the top level may hold: upstream's, less `timeout` (a workflow's
 * own timeout: the host's age limits hold its runs), and `use` only for
 * its `timeouts`.
 */
const supportedRoot = new Set([
  "document",
  "evaluate",
  "input",
  "output",
  "use",
  "do",
]);

/** What `use` may hold: reusable timeouts, which tasks name. */
const supportedUse = new Set(["timeouts"]);

/** What a lowered task may hold besides its kind (`with`: a call's). */
const supportedTaskKeys = new Set([
  "with",
  "if",
  "input",
  "output",
  "export",
  "timeout",
  "then",
  "metadata",
]);

/** Task kinds lowered here; the profile's others come later. */
const loweredKinds = new Set<string>([
  "call",
  "do",
  "for",
  "listen",
  "set",
  "switch",
  "wait",
]);

/**
 * The longest a listen may wait for its events, as the engine takes a
 * deadline: 365 days. A host's own ceiling (a test run's) may be lower.
 */
export const maxListenMs = 365 * 86_400_000;

/** Named calls lowered here; decisions come later. */
const loweredCalls = new Set<string>([
  "grasp.compute",
  "grasp.operation",
  "grasp.connector",
  "grasp.model",
  "grasp.now",
  "grasp.random",
  "grasp.sleepUntil",
]);

/**
 * The task kinds a `timeout` bounds: those whose own work runs as one
 * attempt of a step. A wait has no attempt to bound while it waits, and a
 * nested list's tasks have timeouts of their own.
 */
const timedKinds = new Set<string>(["call", "set", "switch"]);

/** Transitions that don't name a task. */
const directives = new Set(["continue", "exit", "end"]);

/** The label of the workflow's own list: `end` leaves it. */
const workflowLabel = "workflow";

/** The single entry of a one-key object: a task list's item, a task's kind. */
const onlyEntry = (object: JsonObject): [string, JsonValue] | undefined => {
  const entries = Object.entries(object);
  const [entry] = entries;
  return entries.length === 1 ? entry : undefined;
};

/**
 * The profile's task kinds, as the validator knows them: `do` last, since
 * a `for` task has a `do` of its own.
 */
const taskKinds = [
  "call",
  "emit",
  "for",
  "fork",
  "listen",
  "raise",
  "run",
  "set",
  "switch",
  "try",
  "wait",
  "do",
];

const kindOf = (task: JsonObject): string | undefined =>
  taskKinds.find((kind) => Object.hasOwn(task, kind));

/** A JavaScript literal of exactly `value`: never source written as-is. */
const literal = (value: string | number | boolean | null): string =>
  JSON.stringify(value);

/** Collects what can't be lowered, bounded. */
/**
 * The longest JSON Pointer a build seals (the task and expression tables,
 * and what it reports unsupported). A definition may hold longer ones, its
 * keys being as long as it likes: a construct at one isn't lowered
 * (`pointer:too_long`), so nothing sealed fails to load.
 */
export const maxSealedPointerLength = 2048;

/**
 * `pointer`, or its longest prefix of whole segments within
 * `maxSealedPointerLength`: where a too-long one is reported.
 */
const sealablePointer = (pointer: string): string => {
  if (pointer.length <= maxSealedPointerLength) {
    return pointer;
  }
  const cut = pointer.lastIndexOf("/", maxSealedPointerLength);
  return cut <= 0 ? "" : pointer.slice(0, cut);
};

class Refusals {
  readonly list: Unsupported[] = [];

  add(pointer: string, feature: string, taskId?: string): void {
    if (this.list.length < maxUnsupported) {
      const shown = sealablePointer(pointer);
      this.list.push(
        taskId === undefined
          ? { pointer: shown, feature }
          : { pointer: shown, feature, taskId }
      );
    }
  }
}

/** The definition's `document.metadata.grasp`, as validation left it. */
const graspOf = (definition: JsonObject): JsonObject | undefined => {
  const { document } = definition;
  const metadata = isObject(document) ? document.metadata : undefined;
  const grasp = isObject(metadata) ? metadata.grasp : undefined;
  return isObject(grasp) ? grasp : undefined;
};

/** Refuses what the definition's own parts hold beyond what is lowered. */
const checkRoot = (definition: JsonObject, refusals: Refusals): void => {
  for (const key of Object.keys(definition)) {
    if (!supportedRoot.has(key)) {
      refusals.add(pointerJoin("", key), key);
    }
  }
  // Nothing holds these runs to an active time yet (GRA-567): a limit of
  // it would be sealed and ignored, so it isn't lowered.
  const limits = graspOf(definition)?.limits;
  if (isObject(limits) && Object.hasOwn(limits, "maxActiveMs")) {
    refusals.add(
      "/document/metadata/grasp/limits/maxActiveMs",
      "limits.maxActiveMs"
    );
  }
  const { use } = definition;
  if (isObject(use)) {
    for (const key of Object.keys(use)) {
      if (!supportedUse.has(key)) {
        refusals.add(pointerJoin("/use", key), `use.${key}`);
      }
    }
  }
};

/** The workflow's own limits, each a positive safe integer validation checked. */
const limitsOf = (definition: JsonObject): WorkflowLimits => {
  const limits = graspOf(definition)?.limits;
  const own: Record<string, number> = {};
  for (const key of ["maxSteps", "maxModelCalls"] as const) {
    const limit = isObject(limits) ? limits[key] : undefined;
    if (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0) {
      own[key] = limit;
    }
  }
  return Object.freeze(own);
};

/**
 * The parameters of `definition` that are sensitive: every one that
 * doesn't say `sensitive: false`, as a parameter's contract has it.
 */
const sensitiveParams = (definition: JsonValue): ReadonlySet<string> => {
  const params = isObject(definition) ? graspOf(definition)?.params : undefined;
  return new Set(
    Object.entries(isObject(params) ? params : {}).flatMap(([name, entry]) =>
      isObject(entry) && entry.sensitive === false ? [] : [name]
    )
  );
};

/**
 * The parameters of `definition` whose schema allows anything but a
 * string, or doesn't say: a connector's answer is checked for a binding
 * argument anywhere in its text only for a string one; a number, a
 * boolean or a part of an object could come back as text unseen. Only a
 * string may be one.
 */
const unsendableParams = (definition: JsonValue): ReadonlySet<string> => {
  const params = isObject(definition) ? graspOf(definition)?.params : undefined;
  return new Set(
    Object.entries(isObject(params) ? params : {}).flatMap(([name, entry]) => {
      const schema = isObject(entry) ? entry.schema : undefined;
      const type = isObject(schema) ? schema.type : undefined;
      return type === "string" ? [] : [name];
    })
  );
};

/** A value that is exactly one parameter's read, and nothing more. */
const bareParam = /^\$\{\s*\$params\.(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*\}$/u;

/**
 * The sensitive parameter `value` is a binding argument of, if it is one:
 * exactly `${ $params.<name> }`, of a parameter in `sensitive`.
 */
const bindingArgumentOf = (
  value: JsonValue,
  sensitive: ReadonlySet<string>
): string | undefined => {
  const name =
    typeof value === "string" ? bareParam.exec(value)?.groups?.name : undefined;
  return name !== undefined && sensitive.has(name) ? name : undefined;
};

/** The value of `root` at JSON Pointer `pointer`, if there is one. */
const valueAt = (root: JsonValue, pointer: string): JsonValue | undefined => {
  let value: JsonValue | undefined = root;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(value)) {
      value = /^(?:0|[1-9]\d*)$/u.test(key) ? value[Number(key)] : undefined;
    } else if (isObject(value) && Object.hasOwn(value, key)) {
      value = value[key];
    } else {
      return undefined;
    }
  }
  return value;
};

/**
 * The pointers of every binding argument of `checked`: each value of a
 * `grasp.connector` task's `with.arguments`, at any depth in its literal
 * objects and arrays, that reads exactly one sensitive parameter. Only
 * tasks the validator found, at their own pointers: never data that looks
 * like a call. Those values are never expressions (`templateOf`), so
 * `sensitiveReads` lets them be.
 */
const bindingArguments = (checked: CheckedWorkflow): ReadonlySet<string> => {
  const sensitive = sensitiveParams(checked.definition);
  const found = new Set<string>();
  if (sensitive.size === 0) {
    return found;
  }
  const inArguments = (value: JsonValue, pointer: string): void => {
    if (bindingArgumentOf(value, sensitive) !== undefined) {
      found.add(pointer);
    } else if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        inArguments(item, pointerJoin(pointer, index));
      }
    } else if (isObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        inArguments(item, pointerJoin(pointer, key));
      }
    }
  };
  for (const { kind, pointer } of checked.tasks) {
    const task = kind === "call" ? valueAt(checked.definition, pointer) : null;
    if (
      isObject(task) &&
      task.call === "grasp.connector" &&
      isObject(task.with) &&
      Object.hasOwn(task.with, "arguments")
    ) {
      inArguments(
        task.with.arguments ?? null,
        pointerJoin(pointerJoin(pointer, "with"), "arguments")
      );
    }
  }
  return found;
};

/** What one generation builds as it walks. */
interface Emitter {
  readonly checked: CheckedWorkflow;
  readonly refusals: Refusals;
  /** The definition's sensitive parameters, for binding arguments. */
  readonly sensitive: ReadonlySet<string>;
  readonly lines: string[];
  readonly expressions: SealedExpression[];
  readonly tasks: GeneratedTask[];
  /** The lines each task's code takes in the module (`TaskSpan`). */
  readonly spans: TaskSpan[];
  /** Labels some `break` leaves: only those are written. */
  readonly usedLabels: Set<string>;
  /** Counts lists and tasks, for labels and variables of their own. */
  counter: number;
  /** The flow the code being written runs its tasks on: its variable. */
  flow: string;
  /** The `for` tasks around the code being written, outermost first. */
  scope: string[];
}

/**
 * `value` at `pointer` as a TypeScript expression: its literals as
 * literals, each `${ … }` string an evaluation of its sealed slot.
 */
const valueCode = (
  emitter: Emitter,
  value: JsonValue,
  pointer: string,
  taskId: string | null,
  result: ExpressionResult
): string => {
  if (typeof value === "string") {
    if (parseSlot(value).kind !== "expression") {
      return literal(value);
    }
    const compiled = emitter.checked.expressions.get(pointer);
    if (compiled === undefined) {
      throw new Error(`The checked workflow has no expression at ${pointer}`);
    }
    const slot = emitter.expressions.length;
    emitter.expressions.push({
      slot,
      pointer,
      taskId,
      stage: compiled.stage,
      result,
      source: compiled.source,
      loopVariables: Object.freeze([...compiled.loopVariables]),
    });
    return `await task.evaluate(${slot})`;
  }
  if (value === null || typeof value !== "object") {
    return literal(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item, index) =>
      valueCode(emitter, item, pointerJoin(pointer, index), taskId, result)
    );
    return `[${items.join(", ")}]`;
  }
  const members = Object.entries(value).map(
    ([key, member]) =>
      `[${literal(key)}]: ${valueCode(emitter, member, pointerJoin(pointer, key), taskId, result)}`
  );
  return `{ ${members.join(", ")} }`;
};

/**
 * One stage as the SDK takes it: a function evaluating `value`'s
 * expressions. `undefined`, and refused as `<feature>:expressions`, when
 * it holds more than a stage may.
 */
const stageCode = (
  emitter: Emitter,
  value: JsonValue,
  pointer: string,
  taskId: string | null,
  feature: string,
  result: ExpressionResult = "json"
): string | undefined => {
  const before = emitter.expressions.length;
  const code = valueCode(emitter, value, pointer, taskId, result);
  const count = emitter.expressions.length - before;
  if (count > maxTaskExpressions) {
    emitter.refusals.add(
      pointer,
      `${feature}:expressions`,
      taskId ?? undefined
    );
    return undefined;
  }
  // An object literal as an arrow's body needs parentheses.
  const body = code.startsWith("{") ? `(${code})` : code;
  return `async (${count > 0 ? "task" : ""}) => ${body}`;
};

/** Whether `template` is a literal: nothing of it is built at call time. */
const isLiteral = (
  template: CallTemplate
): template is { readonly literal: JsonValue } => "literal" in template;

/**
 * The most entries one array or object of a call's template holds, where
 * anything in it is built at call time, and the longest key of such an
 * object: what the sealed build's schema reads back (workflow-builds.ts).
 * A literal part, sealed as one value, isn't bound by them.
 */
export const maxTemplateItems = 1024;
export const maxTemplateKeyLength = 1024;

/**
 * Whether a template's array or object at `pointer`, of `items` entries
 * and keys at most `keyLength` long, fits what a build seals; refused as
 * `with:too_large` otherwise, so publication reports what a run could
 * never load.
 */
const withinTemplateBounds = (
  emitter: Emitter,
  pointer: string,
  taskId: string,
  items: number,
  keyLength = 0
): boolean => {
  if (items <= maxTemplateItems && keyLength <= maxTemplateKeyLength) {
    return true;
  }
  emitter.refusals.add(pointer, "with:too_large", taskId);
  return false;
};

/**
 * `value` at `pointer`, a part of task `taskId`'s call, as a template the
 * host builds at call time (`CallTemplate`): literals as they are, each
 * `${ … }` string its sealed expression's slot, of result `result`, and,
 * with `sensitive`, each binding argument its parameter. A part whose
 * every value is literal is one literal.
 */
const templateOf = (
  emitter: Emitter,
  value: JsonValue,
  pointer: string,
  taskId: string,
  result: ExpressionResult,
  sensitive?: ReadonlySet<string>
): CallTemplate => {
  if (typeof value === "string") {
    if (parseSlot(value).kind !== "expression") {
      return { literal: value };
    }
    const param =
      sensitive === undefined ? undefined : bindingArgumentOf(value, sensitive);
    if (param !== undefined) {
      return { param };
    }
    const compiled = emitter.checked.expressions.get(pointer);
    if (compiled === undefined) {
      throw new Error(`The checked workflow has no expression at ${pointer}`);
    }
    const slot = emitter.expressions.length;
    emitter.expressions.push({
      slot,
      pointer,
      taskId,
      stage: compiled.stage,
      result,
      source: compiled.source,
      loopVariables: Object.freeze([...compiled.loopVariables]),
    });
    return { slot };
  }
  if (value === null || typeof value !== "object") {
    return { literal: value };
  }
  if (Array.isArray(value)) {
    const items = value.map((item, index) =>
      templateOf(
        emitter,
        item,
        pointerJoin(pointer, index),
        taskId,
        result,
        sensitive
      )
    );
    if (items.every((item) => isLiteral(item))) {
      return { literal: value };
    }
    return withinTemplateBounds(emitter, pointer, taskId, items.length)
      ? { array: items }
      : { literal: null };
  }
  const entries = Object.entries(value).map(
    ([key, item]) =>
      [
        key,
        templateOf(
          emitter,
          item,
          pointerJoin(pointer, key),
          taskId,
          result,
          sensitive
        ),
      ] as const
  );
  if (entries.every(([, item]) => isLiteral(item))) {
    return { literal: value };
  }
  let longest = 0;
  for (const [key] of entries) {
    longest = Math.max(longest, key.length);
  }
  return withinTemplateBounds(emitter, pointer, taskId, entries.length, longest)
    ? { object: entries }
    : { literal: null };
};

/** The stages whose transformation the build seals as a template. */
type SealedStage = "taskInputFrom" | "taskOutputAs" | "taskExportAs";

/**
 * `value` at `pointer`, task `taskId`'s transformation at `stage`, as a
 * template of the slots its stage already evaluates (`stagesOf`, by
 * pointer) and its literals: no new expression, so what the host builds
 * from it is what the module's own evaluations make.
 */
const slotTemplateOf = (
  emitter: Emitter,
  value: JsonValue,
  pointer: string,
  taskId: string,
  stage: SealedStage
): CallTemplate => {
  if (typeof value === "string") {
    if (parseSlot(value).kind !== "expression") {
      return { literal: value };
    }
    const evaluated = emitter.expressions.find(
      (expression) =>
        expression.taskId === taskId &&
        expression.stage === stage &&
        expression.pointer === pointer
    );
    if (evaluated === undefined) {
      throw new Error(`The task's ${stage} has no expression at ${pointer}`);
    }
    return { slot: evaluated.slot };
  }
  if (value === null || typeof value !== "object") {
    return { literal: value };
  }
  if (Array.isArray(value)) {
    const items = value.map((item, index) =>
      slotTemplateOf(emitter, item, pointerJoin(pointer, index), taskId, stage)
    );
    if (items.every((item) => isLiteral(item))) {
      return { literal: value };
    }
    return withinTemplateBounds(emitter, pointer, taskId, items.length)
      ? { array: items }
      : { literal: null };
  }
  const entries = Object.entries(value).map(
    ([key, item]) =>
      [
        key,
        slotTemplateOf(emitter, item, pointerJoin(pointer, key), taskId, stage),
      ] as const
  );
  if (entries.every(([, item]) => isLiteral(item))) {
    return { literal: value };
  }
  let longest = 0;
  for (const [key] of entries) {
    longest = Math.max(longest, key.length);
  }
  return withinTemplateBounds(emitter, pointer, taskId, entries.length, longest)
    ? { object: entries }
    : { literal: null };
};

/** A task's `input`, `output` or `export`, as the validator left it. */
const flowPart = (
  task: JsonObject,
  key: "input" | "output" | "export"
): JsonObject | undefined => {
  const part = task[key];
  return isObject(part) ? part : undefined;
};

/** What a task does around its own work: the SDK's plan members. */
interface Stages {
  readonly enter: string[];
  readonly leave: string[];
  readonly schemas: Partial<
    Record<"input" | "output" | "export", ValueDescriptor>
  >;
}

/** The descriptor of the schema at `pointer`, as plain JSON. */
const descriptorAt = (emitter: Emitter, pointer: string): ValueDescriptor => {
  const schema = emitter.checked.schemas.get(pointer);
  if (schema === undefined) {
    throw new Error(`The checked workflow has no schema at ${pointer}`);
  }
  return schema.descriptor;
};

/** Adds plan member `name`, unless its stage was refused. */
const member = (
  into: string[],
  name: string,
  code: string | undefined
): void => {
  if (code !== undefined) {
    into.push(`${name}: ${code}`);
  }
};

/** The plan members of a task's data flow, in upstream's order. */
const stagesOf = (
  emitter: Emitter,
  id: string,
  task: JsonObject,
  pointer: string
): Stages => {
  const stages: Stages = { enter: [], leave: [], schemas: {} };
  if (Object.hasOwn(task, "if")) {
    member(
      stages.enter,
      "if",
      stageCode(
        emitter,
        task.if ?? null,
        pointerJoin(pointer, "if"),
        id,
        "if",
        "boolean"
      )
    );
  }
  const parts = [
    ["input", "from", "inputSchema", "inputFrom", stages.enter],
    ["output", "as", "outputSchema", "outputAs", stages.leave],
    ["export", "as", "exportSchema", "exportAs", stages.leave],
  ] as const;
  for (const [key, transform, schemaName, transformName, into] of parts) {
    const part = flowPart(task, key);
    if (part === undefined) {
      continue;
    }
    const partPointer = pointerJoin(pointer, key);
    const transformation = part[transform];
    // Upstream's order inside the part: the input's schema checks the raw
    // input before input.from; output and export check what as made.
    if (key === "input" && Object.hasOwn(part, "schema")) {
      into.push(`${schemaName}: true`);
    }
    if (transformation !== undefined) {
      member(
        into,
        transformName,
        stageCode(
          emitter,
          transformation,
          pointerJoin(partPointer, transform),
          id,
          `${key}.${transform}`
        )
      );
    }
    if (Object.hasOwn(part, "schema")) {
      stages.schemas[key] = descriptorAt(
        emitter,
        pointerJoin(partPointer, "schema")
      );
      if (key !== "input") {
        into.push(`${schemaName}: true`);
      }
    }
  }
  return stages;
};

/** A plan object literal of `members`. */
const planCode = (members: readonly string[]): string =>
  members.length === 0 ? "{}" : `{ ${members.join(", ")} }`;

/** Where a transition goes, as the statement that takes it there. */
type Jump = (target: string) => string | null;

/** What a task's statements need of the list they are in. */
interface ListPlace {
  readonly indent: string;
  readonly jump: Jump;
}

/**
 * Every transition a task names: its `then` and its cases' (validation
 * refuses a `then` on a switch).
 */
const transitionsOf = (task: JsonObject): string[] => {
  const targets: string[] = [];
  if (typeof task.then === "string") {
    targets.push(task.then);
  }
  if (Array.isArray(task.switch)) {
    for (const item of task.switch) {
      const entry = isObject(item) ? onlyEntry(item) : undefined;
      const body = entry === undefined ? undefined : entry[1];
      if (isObject(body) && typeof body.then === "string") {
        targets.push(body.then);
      }
    }
  }
  return targets;
};

/** One task of a list, as the walk reads it. */
interface ListTask {
  readonly id: string;
  readonly task: JsonObject;
  readonly pointer: string;
}

/**
 * The position `target` leads to from `position`: strictly later in the
 * same list, or nothing is emitted. Validation refuses anything else
 * first; this holds the generated code to it whatever validation said.
 */
const resolveTarget = (
  positions: ReadonlyMap<string, number>,
  target: string,
  position: number
): number => {
  const found = positions.get(target);
  if (found === undefined || found <= position) {
    throw new Error(
      "The checked workflow has a transition that isn't to a later sibling"
    );
  }
  return found;
};

/** The statements of a `set` task. */
const lowerSet = (
  emitter: Emitter,
  item: ListTask,
  stages: Stages,
  place: ListPlace
): void => {
  const value = stageCode(
    emitter,
    item.task.set ?? null,
    pointerJoin(item.pointer, "set"),
    item.id,
    "set"
  );
  if (value === undefined) {
    return;
  }
  const plan = planCode([...stages.enter, `set: ${value}`, ...stages.leave]);
  emitter.lines.push(
    `${place.indent}({ output, context } = await ${emitter.flow}.set(${literal(item.id)}, { input: output, context }, ${plan}));`
  );
};

/** The statements of a `switch` task: its step, then its case's jump. */
const lowerSwitch = (
  emitter: Emitter,
  item: ListTask,
  stages: Stages,
  place: ListPlace
): void => {
  const cases = Array.isArray(item.task.switch) ? item.task.switch : [];
  const conditions: string[] = [];
  const jumps: string[] = [];
  for (const [index, entryValue] of cases.entries()) {
    const entry = isObject(entryValue) ? onlyEntry(entryValue) : undefined;
    const body = entry === undefined ? undefined : entry[1];
    if (entry === undefined || !isObject(body)) {
      throw new Error(`The checked workflow has no case at ${item.pointer}`);
    }
    const casePointer = pointerJoin(
      pointerJoin(pointerJoin(item.pointer, "switch"), index),
      entry[0]
    );
    // Validation leaves exactly one case without `when`: the last.
    if (Object.hasOwn(body, "when") !== index < cases.length - 1) {
      throw new Error(
        `The checked workflow's switch at ${item.pointer} has no last default`
      );
    }
    if (Object.hasOwn(body, "when")) {
      const condition = stageCode(
        emitter,
        body.when ?? null,
        pointerJoin(casePointer, "when"),
        item.id,
        "when",
        "boolean"
      );
      if (condition === undefined) {
        return;
      }
      conditions.push(condition);
    }
    const jump = typeof body.then === "string" ? place.jump(body.then) : null;
    if (jump !== null) {
      jumps.push(
        `${place.indent}  if (chosen.branch === ${literal(index)}) {`,
        `${place.indent}    ${jump}`,
        `${place.indent}  }`
      );
    }
  }
  const plan = planCode([
    ...stages.enter,
    `cases: [${conditions.join(", ")}]`,
    ...stages.leave,
  ]);
  emitter.lines.push(
    `${place.indent}{`,
    `${place.indent}  const chosen = await ${emitter.flow}.switch(${literal(item.id)}, { input: output, context }, ${plan});`,
    `${place.indent}  ({ output, context } = chosen);`,
    ...jumps,
    `${place.indent}}`
  );
};

/**
 * The statements of a task with a durable body (a `wait`'s sleep, a
 * `do`'s list): its enter step, if it has stages before or after the
 * body, then the body, then its leave step, if it has stages after.
 */
const lowerDurable = (
  emitter: Emitter,
  item: ListTask,
  stages: Stages,
  place: ListPlace,
  body: (indent: string, entered: string) => void,
  until = false
): TaskStep[] => {
  const steps: TaskStep[] = [];
  const hasLeave = stages.leave.length > 0;
  // A deadline is resolved, once, in the enter step, which records it; and
  // a leave step's `$task.startedAt` is the time its enter step recorded,
  // so a task with stages after its body always enters, with nothing to
  // evaluate if it has nothing before it.
  const hasEnter = until || stages.enter.length > 0 || hasLeave;
  emitter.counter += 1;
  // Of this task alone: a nested task's are numbered after it.
  const raw = `raw${emitter.counter}`;
  const entered = `entered${emitter.counter}`;
  if (!hasEnter && !hasLeave) {
    body(place.indent, entered);
    return steps;
  }
  const { indent } = place;
  const id = literal(item.id);
  emitter.lines.push(`${indent}{`);
  if (hasLeave) {
    emitter.lines.push(`${indent}  const ${raw} = output;`);
  }
  let inner = `${indent}  `;
  if (hasEnter) {
    steps.push("enter");
    const plan = planCode([...stages.enter, ...(until ? ["until: true"] : [])]);
    emitter.lines.push(
      `${inner}const ${entered} = await ${emitter.flow}.enter(${id}, { input: output, context }, ${plan});`,
      `${inner}if (!${entered}.skipped) {`,
      `${inner}  output = ${entered}.input;`
    );
    inner += "  ";
  }
  body(inner, entered);
  if (hasLeave) {
    steps.push("leave");
    const enteredInput = hasEnter ? `${entered}.input` : raw;
    emitter.lines.push(
      `${inner}({ output, context } = await ${emitter.flow}.leave(${id}, { input: ${raw}, context }, ${enteredInput}, output, ${planCode(stages.leave)}));`
    );
  }
  if (hasEnter) {
    emitter.lines.push(`${indent}  }`);
  }
  emitter.lines.push(`${indent}}`);
  return steps;
};

/** What every task the generator seals has, whatever its kind. */
type TaskBase = Pick<
  GeneratedTask,
  "id" | "pointer" | "line" | "schemas" | "timeoutMs" | "scope"
>;

/**
 * The milliseconds of a task's `timeout`, as validation left it: its own
 * `{ after }`, or the one of `use.timeouts` it names; `undefined` for none.
 */
const timeoutOf = (
  definition: JsonValue,
  timeout: JsonValue | undefined
): number | undefined => {
  let resolved = timeout;
  if (typeof timeout === "string") {
    const use = isObject(definition) ? definition.use : undefined;
    const timeouts = isObject(use) ? use.timeouts : undefined;
    resolved =
      isObject(timeouts) && Object.hasOwn(timeouts, timeout)
        ? timeouts[timeout]
        : undefined;
  }
  if (resolved === undefined) {
    return undefined;
  }
  const ms = isObject(resolved) ? literalDurationMs(resolved.after) : undefined;
  if (ms === undefined) {
    throw new Error("The checked workflow has a timeout of no duration");
  }
  return ms;
};

/**
 * The template of a part of a call's `with`, refused as
 * `with:expressions` (and `undefined`) when it holds more expressions than
 * a stage may. Binding arguments only where `sensitive` is given.
 */
const callPart = (
  emitter: Emitter,
  item: ListTask,
  key: string,
  result: ExpressionResult = "json",
  sensitive?: ReadonlySet<string>
): CallTemplate | undefined => {
  const args = isObject(item.task.with) ? item.task.with : {};
  const before = emitter.expressions.length;
  const template = templateOf(
    emitter,
    args[key] ?? null,
    pointerJoin(pointerJoin(item.pointer, "with"), key),
    item.id,
    result,
    sensitive
  );
  if (emitter.expressions.length - before > maxTaskExpressions) {
    emitter.refusals.add(
      pointerJoin(pointerJoin(item.pointer, "with"), key),
      "with:expressions",
      item.id
    );
    return undefined;
  }
  return template;
};

/** `local:code/<file>.ts#<export>`: a binding of the workflow's own modules. */
const localContract =
  /^local:(?<module>code\/[^#]+\.ts)#(?<export>[A-Za-z_$][A-Za-z0-9_$]*)$/u;

/**
 * A `grasp.compute` task's call: the module and export its binding names,
 * sealed as the literals validation resolved against the workflow's own
 * module manifest. A compute binding of the host catalog is refused as
 * `compute:catalog`: the catalog has no calculations to run.
 */
const computeCallOf = (
  emitter: Emitter,
  item: ListTask,
  binding: string,
  computeArguments: CallTemplate | undefined
): GeneratedCall | undefined => {
  const contract = emitter.checked.bindings.get(binding)?.contract ?? "";
  const local = localContract.exec(contract)?.groups;
  if (local?.module === undefined || local.export === undefined) {
    emitter.refusals.add(
      pointerJoin(pointerJoin(item.pointer, "with"), "binding"),
      "compute:catalog",
      item.id
    );
    return undefined;
  }
  return computeArguments === undefined
    ? undefined
    : {
        name: "grasp.compute",
        binding,
        module: local.module,
        export: local.export,
        arguments: computeArguments,
      };
};

/**
 * A `grasp.model` task's call: its parts' templates (`part`), and the
 * descriptor of its output schema, which the model's answer must match.
 */
const modelCallOf = (
  emitter: Emitter,
  item: ListTask,
  binding: string,
  part: (key: string) => CallTemplate | undefined
): GeneratedCall | undefined => {
  const args = isObject(item.task.with) ? item.task.with : {};
  const instructions = part("instructions");
  const input = part("input");
  const model = Object.hasOwn(args, "model") ? part("model") : null;
  const tokens = Object.hasOwn(args, "maxOutputTokens")
    ? part("maxOutputTokens")
    : null;
  if (
    instructions === undefined ||
    input === undefined ||
    model === undefined ||
    tokens === undefined
  ) {
    return undefined;
  }
  return {
    name: "grasp.model",
    binding,
    instructions,
    input,
    outputSchema: descriptorAt(
      emitter,
      pointerJoin(pointerJoin(item.pointer, "with"), "outputSchema")
    ),
    ...(model === null ? {} : { model }),
    ...(tokens === null ? {} : { maxOutputTokens: tokens }),
  };
};

/**
 * Task `item`'s named call, as the build seals it: its binding and
 * operation as the literals validation checked, its arguments templates
 * the host builds. `undefined` once a part was refused.
 */
const callOf = (
  emitter: Emitter,
  item: ListTask
): GeneratedCall | undefined => {
  const args = isObject(item.task.with) ? item.task.with : {};
  const binding = typeof args.binding === "string" ? args.binding : "";
  const part = (
    key: string,
    result?: ExpressionResult,
    sensitive?: ReadonlySet<string>
  ): CallTemplate | undefined =>
    callPart(emitter, item, key, result, sensitive);
  const name = typeof item.task.call === "string" ? item.task.call : "";
  switch (name) {
    case "grasp.now":
    case "grasp.random": {
      return { name };
    }
    case "grasp.operation": {
      const operationArguments = part("arguments");
      const local = localContract.exec(
        emitter.checked.bindings.get(binding)?.contract ?? ""
      )?.groups;
      if (operationArguments === undefined) {
        return undefined;
      }
      // One of the workflow's own actions, sealed as the module and export
      // validation resolved against its module manifest.
      return local?.module === undefined || local.export === undefined
        ? { name: "grasp.operation", binding, arguments: operationArguments }
        : {
            name: "grasp.action",
            binding,
            module: local.module,
            export: local.export,
            arguments: operationArguments,
          };
    }
    case "grasp.connector": {
      // The only call a sensitive parameter may reach, as a binding
      // argument the host gives connect.
      const connectorArguments = part("arguments", "json", emitter.sensitive);
      return connectorArguments === undefined ||
        typeof args.operation !== "string"
        ? undefined
        : {
            name: "grasp.connector",
            binding,
            operation: args.operation,
            arguments: connectorArguments,
          };
    }
    case "grasp.compute": {
      return computeCallOf(emitter, item, binding, part("arguments"));
    }
    case "grasp.model": {
      return modelCallOf(emitter, item, binding, part);
    }
    default: {
      throw new Error(
        `The checked workflow has no named call at ${item.pointer}`
      );
    }
  }
};

/**
 * `item`'s transformation `transform` of its `key` (its `input.from`, its
 * `output.as` or its `export.as`), as a template of the slots its module
 * evaluates for it at `stage`, if it has one: sealed so the host can
 * build what it makes itself.
 */
const sealedPartOf = (
  emitter: Emitter,
  item: ListTask,
  key: "input" | "output" | "export",
  transform: "from" | "as",
  stage: SealedStage
): CallTemplate | undefined => {
  const part = flowPart(item.task, key);
  return part !== undefined && Object.hasOwn(part, transform)
    ? slotTemplateOf(
        emitter,
        part[transform] ?? null,
        pointerJoin(pointerJoin(item.pointer, key), transform),
        item.id,
        stage
      )
    : undefined;
};

/** `item`'s `input.from`, sealed (`sealedPartOf`), if it has one. */
const inputFromOf = (
  emitter: Emitter,
  item: ListTask
): CallTemplate | undefined =>
  sealedPartOf(emitter, item, "input", "from", "taskInputFrom");

/**
 * The statement of a call task that makes its call within its step (every
 * named call but `grasp.sleepUntil`): the host makes the call, from what
 * the build sealed, as the step's own work.
 */
const lowerCall = (
  emitter: Emitter,
  item: ListTask,
  stages: Stages,
  place: ListPlace,
  sealed: TaskBase
): void => {
  const call = callOf(emitter, item);
  if (call === undefined) {
    return;
  }
  const inputFrom = inputFromOf(emitter, item);
  const outputAs = sealedPartOf(emitter, item, "output", "as", "taskOutputAs");
  const exportAs = sealedPartOf(emitter, item, "export", "as", "taskExportAs");
  emitter.tasks.push({
    ...sealed,
    kind: "call",
    call,
    steps: ["task"],
    ...(inputFrom === undefined ? {} : { inputFrom }),
    ...(outputAs === undefined ? {} : { outputAs }),
    ...(exportAs === undefined ? {} : { exportAs }),
  });
  const plan = planCode([...stages.enter, ...stages.leave]);
  emitter.lines.push(
    `${place.indent}({ output, context } = await ${emitter.flow}.call(${literal(item.id)}, { input: output, context }, ${plan}));`
  );
};

/**
 * The statements of a task that sleeps: a `wait` of a literal duration,
 * its sleep exactly that long; a `wait` whose duration is an expression,
 * or a `grasp.sleepUntil` call, its deadline resolved once, by the host,
 * in its enter step, which records it, and its sleep until then.
 */
const lowerSleep = (
  emitter: Emitter,
  item: ListTask,
  stages: Stages,
  place: ListPlace,
  sealed: TaskBase,
  /** Where the task's expressions start, before its stages were compiled. */
  taskBefore: number
): void => {
  const { id, task, pointer } = item;
  const steps: TaskStep[] = ["task"];
  const ms = task.call === undefined ? literalDurationMs(task.wait) : undefined;
  if (ms !== undefined) {
    emitter.tasks.push({ ...sealed, kind: "wait", milliseconds: ms, steps });
    steps.push(
      ...lowerDurable(emitter, item, stages, place, (indent) => {
        emitter.lines.push(
          `${indent}await ${emitter.flow}.wait(${literal(id)}, ${literal(ms)});`
        );
      })
    );
    return;
  }
  const inputFrom = inputFromOf(emitter, item);
  const transformed = inputFrom === undefined ? {} : { inputFrom };
  let sleeping: GeneratedTask;
  if (task.call === undefined) {
    const duration = templateOf(
      emitter,
      task.wait ?? null,
      pointerJoin(pointer, "wait"),
      id,
      "duration"
    );
    sleeping = { ...sealed, kind: "wait", duration, steps, ...transformed };
  } else {
    const timestamp = callPart(emitter, item, "timestamp");
    if (timestamp === undefined) {
      return;
    }
    sleeping = {
      ...sealed,
      kind: "call",
      call: { name: "grasp.sleepUntil", timestamp },
      steps,
      ...transformed,
    };
  }
  // The enter step evaluates everything of the task but its leave stages:
  // its if, its input.from (as stage code and as the sealed template) and
  // the deadline's expressions, all within what one attempt evaluates.
  const entering = emitter.expressions
    .slice(taskBefore)
    .filter(
      ({ stage }) => stage !== "taskOutputAs" && stage !== "taskExportAs"
    ).length;
  if (entering > maxStepExpressions) {
    emitter.refusals.add(pointer, "step:expressions", id);
  }
  emitter.tasks.push(sleeping);
  steps.push(
    ...lowerDurable(
      emitter,
      item,
      stages,
      place,
      (indent, entered) => {
        emitter.lines.push(
          `${indent}await ${emitter.flow}.sleepUntil(${literal(id)}, ${entered}.until);`
        );
      },
      true
    )
  );
};

/** The event attributes a run's inbox keeps, which a listen's filter may match. */
const matchableAttributes = new Set([
  "id",
  "source",
  "subject",
  "datacontenttype",
]);

/**
 * The filters of listen task `item`, sealed: `undefined` once one was
 * refused. A filter's `correlate` (an expression over each event's own
 * content) isn't lowered: a filter matches by attribute equality alone.
 */
const filtersOf = (
  emitter: Emitter,
  item: ListTask,
  strategy: "one" | "any" | "all",
  to: JsonObject
): GeneratedFilter[] | undefined => {
  const strategyPointer = pointerJoin(
    pointerJoin(pointerJoin(item.pointer, "listen"), "to"),
    strategy
  );
  const listed = strategy === "one" ? [to.one] : to[strategy];
  if (!Array.isArray(listed)) {
    throw new TypeError(
      `The checked workflow has no filters at ${item.pointer}`
    );
  }
  const filters: GeneratedFilter[] = [];
  let refused = false;
  for (const [index, filter] of listed.entries()) {
    const pointer =
      strategy === "one"
        ? strategyPointer
        : pointerJoin(strategyPointer, index);
    if (!isObject(filter) || !isObject(filter.with)) {
      throw new Error(`The checked workflow has no filter at ${pointer}`);
    }
    if (Object.hasOwn(filter, "correlate")) {
      emitter.refusals.add(
        pointerJoin(pointer, "correlate"),
        "listen:correlate",
        item.id
      );
      refused = true;
      continue;
    }
    const withPointer = pointerJoin(pointer, "with");
    const { type, ...rest } = filter.with;
    if (typeof type !== "string") {
      throw new TypeError(
        `The checked workflow's filter at ${pointer} has no type`
      );
    }
    // Only what the run's inbox keeps of each event can match: its id,
    // source, subject and content type (core's run-events.ts). A filter on
    // anything else (`dataschema`) would never match, so isn't lowered.
    const unmatchable = Object.keys(rest).filter(
      (name) => !matchableAttributes.has(name)
    );
    if (unmatchable.length > 0) {
      for (const name of unmatchable) {
        emitter.refusals.add(
          pointerJoin(withPointer, name),
          `listen:${name}`,
          item.id
        );
      }
      refused = true;
      continue;
    }
    const attributes = Object.entries(rest).map(
      ([name, value]) =>
        [
          name,
          templateOf(
            emitter,
            value ?? null,
            pointerJoin(withPointer, name),
            item.id,
            "json"
          ),
        ] as const
    );
    filters.push({ type, attributes });
  }
  return refused ? undefined : filters;
};

/**
 * The statements of a `listen` task: its enter step resolves its deadline
 * (its timeout from then) and its filters' attributes, once, and records
 * them; then the host takes its events, durably, holding no isolate; then
 * its leave step, if it has stages after.
 */
const lowerListen = (
  emitter: Emitter,
  item: ListTask,
  stages: Stages,
  place: ListPlace,
  sealed: TaskBase,
  /** Where the task's expressions start, before its stages were compiled. */
  taskBefore: number
): void => {
  const { id, task, pointer } = item;
  const listen = isObject(task.listen) ? task.listen : {};
  const to = isObject(listen.to) ? listen.to : {};
  const strategy = (["one", "any", "all"] as const).find((key) =>
    Object.hasOwn(to, key)
  );
  const metadata = isObject(task.metadata) ? task.metadata.grasp : undefined;
  const binding = isObject(metadata) ? metadata.binding : undefined;
  if (strategy === undefined || typeof binding !== "string") {
    throw new Error(
      `The checked workflow's listen at ${pointer} is incomplete`
    );
  }
  if (sealed.timeoutMs === undefined || sealed.timeoutMs > maxListenMs) {
    emitter.refusals.add(pointerJoin(pointer, "timeout"), "listen:timeout", id);
    return;
  }
  const filters = filtersOf(emitter, item, strategy, to);
  if (filters === undefined) {
    return;
  }
  // The enter step evaluates everything of the task but its leave stages:
  // its if, its input.from and its filters' expressions.
  const entering = emitter.expressions
    .slice(taskBefore)
    .filter(
      ({ stage }) => stage !== "taskOutputAs" && stage !== "taskExportAs"
    ).length;
  if (entering > maxStepExpressions) {
    emitter.refusals.add(pointer, "step:expressions", id);
  }
  const inputFrom = inputFromOf(emitter, item);
  const outputAs = sealedPartOf(emitter, item, "output", "as", "taskOutputAs");
  const exportAs = sealedPartOf(emitter, item, "export", "as", "taskExportAs");
  // Its `task:` step is the host's waits for its events.
  const steps: TaskStep[] = ["task"];
  emitter.tasks.push({
    ...sealed,
    kind: "listen",
    listen: {
      binding,
      strategy,
      read: listen.read === "envelope" ? "envelope" : "data",
      filters,
    },
    steps,
    ...(inputFrom === undefined ? {} : { inputFrom }),
    ...(outputAs === undefined ? {} : { outputAs }),
    ...(exportAs === undefined ? {} : { exportAs }),
  });
  steps.push(
    ...lowerDurable(
      emitter,
      item,
      stages,
      place,
      (indent) => {
        emitter.lines.push(
          `${indent}output = await ${emitter.flow}.listen(${literal(id)});`
        );
      },
      true
    )
  );
};

/** Lowers a task list: `lowerList`, passed to the tasks it lowers. */
type ListLowerer = (
  emitter: Emitter,
  items: readonly JsonValue[],
  pointer: string,
  indent: string,
  list: { label: string; number: number }
) => void;

/** Whether task `item` sleeps: a wait, or a `grasp.sleepUntil` call. */
const sleepsOf = (task: JsonObject, kind: string): boolean =>
  kind === "wait" || (kind === "call" && task.call === "grasp.sleepUntil");

/** The most `for` tasks one inside another (spec 18: eight levels). */
export const maxLoopDepth = 8;

/**
 * The longest a step's name may be (`task:<id>@<for>.<index>/…`): the
 * engine's 256 characters (workerflow's `maxStepNameLength`), less what
 * core adds to it for the steps of a call it waits on (`:held:<round>:
 * <check>:check`, resource-host.ts).
 */
export const maxStepNameLength = 200;

/** The most digits an item's index has: a collection holds at most 1,000. */
const maxIndexDigits = 3;

/**
 * The longest name of a step of task `id` in scope `scope` (the `for`
 * tasks around it), its index at its widest: `item:` steps of a `for`
 * task in its own item's scope too.
 */
const longestStepName = (
  id: string,
  scope: readonly string[],
  ownItem: boolean
): number => {
  const segments = ownItem ? [...scope, id] : scope;
  const suffix =
    segments.length === 0
      ? 0
      : 1 +
        segments.reduce(
          (length, segment) => length + segment.length + 1 + maxIndexDigits,
          segments.length - 1
        );
  return "enter:".length + id.length + suffix;
};

/** Task `task`'s `metadata.grasp`, if it has one. */
const graspMetadataOf = (task: JsonObject): JsonObject | undefined =>
  isObject(task.metadata) && isObject(task.metadata.grasp)
    ? task.metadata.grasp
    : undefined;

/**
 * Refuses what of `for` task `item` isn't lowered yet: items at once
 * (`metadata.grasp.concurrency` above 1, GRA-276's next slice) and items'
 * own keys (`metadata.grasp.key`): its items are identified by their
 * index in the collection its enter step records. Whether anything was.
 */
const refusedLoop = (emitter: Emitter, item: ListTask): boolean => {
  const grasp = graspMetadataOf(item.task);
  const graspPointer = pointerJoin(
    pointerJoin(item.pointer, "metadata"),
    "grasp"
  );
  let refused = false;
  if (
    grasp !== undefined &&
    typeof grasp.concurrency === "number" &&
    grasp.concurrency > 1
  ) {
    emitter.refusals.add(
      pointerJoin(graspPointer, "concurrency"),
      "for:concurrency",
      item.id
    );
    refused = true;
  }
  if (grasp !== undefined && Object.hasOwn(grasp, "key")) {
    emitter.refusals.add(pointerJoin(graspPointer, "key"), "for:key", item.id);
    refused = true;
  }
  // Loops inside one another, at most spec 18's eight levels: what the
  // host reads of a step's name.
  if (emitter.scope.length >= maxLoopDepth) {
    emitter.refusals.add(item.pointer, "for:depth", item.id);
    refused = true;
  }
  return refused;
};

/**
 * Refuses, by pointer, what of task `item` (of `kind`) isn't lowered: its
 * kind or named call, a property, a timeout where none bounds anything.
 * Whether anything was.
 */
const refusedOf = (emitter: Emitter, item: ListTask, kind: string): boolean => {
  const { id, task, pointer } = item;
  const callName = typeof task.call === "string" ? task.call : "";
  let refused = false;
  if (
    !loweredKinds.has(kind) ||
    (kind === "call" && !loweredCalls.has(callName))
  ) {
    emitter.refusals.add(
      pointer,
      kind === "call" ? `call:${callName}` : kind,
      id
    );
    refused = true;
  }
  for (const key of Object.keys(task)) {
    const own = kind === "for" && (key === "while" || key === "do");
    if (key !== kind && !own && !supportedTaskKeys.has(key)) {
      emitter.refusals.add(pointerJoin(pointer, key), key, id);
      refused = true;
    }
  }
  if (kind === "for") {
    refused = refusedLoop(emitter, item) || refused;
  }
  // A listen's timeout is its deadline: required, and what it waits until.
  const timed =
    (timedKinds.has(kind) && !sleepsOf(task, kind)) || kind === "listen";
  if (Object.hasOwn(task, "timeout") && !timed) {
    emitter.refusals.add(
      pointerJoin(pointer, "timeout"),
      `timeout:${kind}`,
      id
    );
    refused = true;
  }
  return refused;
};

/**
 * The statement `end` is where code is being written: a `break` out of
 * the workflow's list, or, inside an item's list, a return that tells its
 * loop the workflow ended.
 */
const endJump = (emitter: Emitter): string => {
  if (emitter.scope.length > 0) {
    return "return { output, context, end: true };";
  }
  emitter.usedLabels.add(workflowLabel);
  return `break ${workflowLabel};`;
};

/**
 * The statements of a `for` task: one call of the SDK's loop, whose enter
 * step records the items the host resolves from the sealed collection,
 * with its list as a function of the item's own flow and data, in which
 * `exit` ends the item and `end` the workflow (`end: true`, which the loop
 * passes on). Its items run one after another; generated code has still
 * no loop statement: the SDK runs the list once per recorded item, and
 * the host refuses any item the record doesn't have.
 */
const lowerFor = (
  emitter: Emitter,
  item: ListTask,
  stages: Stages,
  place: ListPlace,
  sealed: TaskBase,
  lowerList: ListLowerer
): void => {
  const { id, task, pointer } = item;
  const loop = isObject(task.for) ? task.for : {};
  const forPointer = pointerJoin(pointer, "for");
  const each = typeof loop.each === "string" ? loop.each : "item";
  const at = typeof loop.at === "string" ? loop.at : "index";
  const steps: TaskStep[] = ["enter"];
  const collection = templateOf(
    emitter,
    loop.in ?? null,
    pointerJoin(forPointer, "in"),
    id,
    "json"
  );
  const members = [...stages.enter];
  let whileSlot: number | undefined;
  if (Object.hasOwn(task, "while")) {
    const condition = stageCode(
      emitter,
      task.while ?? null,
      pointerJoin(pointer, "while"),
      id,
      "while",
      "boolean"
    );
    if (condition === undefined) {
      return;
    }
    whileSlot = emitter.expressions.length - 1;
    members.push(`while: ${condition}`);
    steps.push("item");
  }
  if (stages.leave.length > 0) {
    steps.push("leave");
  }
  members.push(...stages.leave);
  const inputFrom = inputFromOf(emitter, item);
  emitter.tasks.push({
    ...sealed,
    kind: "for",
    steps,
    loop: {
      in: collection,
      each,
      at,
      ...(whileSlot === undefined ? {} : { while: whileSlot }),
    },
    ...(inputFrom === undefined ? {} : { inputFrom }),
  });
  emitter.counter += 1;
  const number = emitter.counter;
  const looped = `looped${number}`;
  const flow = `flow${number}`;
  const state = `state${number}`;
  const { indent } = place;
  emitter.lines.push(
    `${indent}{`,
    `${indent}  const ${looped} = await ${emitter.flow}.for(${literal(id)}, { input: output, context }, ${planCode(members)}, async (${flow}, ${state}) => {`,
    `${indent}    let { output, context } = ${state};`
  );
  const outer = { flow: emitter.flow, scope: emitter.scope };
  emitter.flow = flow;
  emitter.scope = [...emitter.scope, id];
  emitter.counter += 1;
  lowerList(
    emitter,
    Array.isArray(task.do) ? task.do : [],
    pointerJoin(pointer, "do"),
    `${indent}    `,
    { label: `s${emitter.counter}`, number: emitter.counter }
  );
  emitter.flow = outer.flow;
  emitter.scope = outer.scope;
  emitter.lines.push(
    `${indent}    return { output, context };`,
    `${indent}  });`,
    `${indent}  ({ output, context } = ${looped});`,
    `${indent}  if (${looped}.end) {`,
    `${indent}    ${endJump(emitter)}`,
    `${indent}  }`,
    `${indent}}`
  );
};

/** Lowers one task, or says why it can't be. */
const lowerTask = (
  emitter: Emitter,
  item: ListTask,
  place: ListPlace,
  lowerList: ListLowerer
): void => {
  const { id, task, pointer } = item;
  const kind = kindOf(task);
  if (kind === undefined) {
    throw new Error(`The checked workflow has a task of no kind at ${pointer}`);
  }
  if (refusedOf(emitter, item, kind)) {
    return;
  }
  // A step's name names every loop around its task: one past what the
  // engine takes is refused here, never at run time.
  if (longestStepName(id, emitter.scope, kind === "for") > maxStepNameLength) {
    emitter.refusals.add(pointer, "step:name_too_long", id);
    return;
  }
  const sleeps = sleepsOf(task, kind);
  const line = emitter.lines.length + 1;
  const before = emitter.expressions.length;
  const stages = stagesOf(emitter, id, task, pointer);
  const timeoutMs = timeoutOf(emitter.checked.definition, task.timeout);
  const sealed = {
    id,
    pointer,
    line,
    schemas: Object.freeze({ ...stages.schemas }),
    scope: Object.freeze([...emitter.scope]),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  if (kind === "set" || kind === "switch" || (kind === "call" && !sleeps)) {
    if (kind === "set") {
      emitter.tasks.push({ ...sealed, kind, steps: ["task"] });
      lowerSet(emitter, item, stages, place);
    } else if (kind === "switch") {
      emitter.tasks.push({ ...sealed, kind, steps: ["task"] });
      lowerSwitch(emitter, item, stages, place);
    } else {
      lowerCall(emitter, item, stages, place, sealed);
    }
    // One step evaluates all of these. A durable task's enter and leave
    // steps hold two stages each, so never more than this.
    if (emitter.expressions.length - before > maxStepExpressions) {
      emitter.refusals.add(pointer, "step:expressions", id);
    }
  } else if (sleeps) {
    lowerSleep(emitter, item, stages, place, sealed, before);
  } else if (kind === "for") {
    lowerFor(emitter, item, stages, place, sealed, lowerList);
  } else if (kind === "listen") {
    lowerListen(emitter, item, stages, place, sealed, before);
  } else {
    const steps: TaskStep[] = [];
    emitter.tasks.push({ ...sealed, kind: "do", steps });
    const list = Array.isArray(task.do) ? task.do : [];
    steps.push(
      ...lowerDurable(emitter, item, stages, place, (indent) => {
        emitter.counter += 1;
        lowerList(emitter, list, pointerJoin(pointer, "do"), indent, {
          label: `s${emitter.counter}`,
          number: emitter.counter,
        });
      })
    );
  }
  // A switch moves on through its cases; any other task, skipped or not,
  // through its own then: "A skipped task still applies its declared
  // transition" (spec 13.5). `end` leaves the workflow at once, past the
  // leave steps of the tasks around it: spec 13.5's `end` "completes the
  // workflow", with the current output, which the workflow's own
  // output.as and required output schema still take.
  if (kind !== "switch" && typeof task.then === "string") {
    const jump = place.jump(task.then);
    if (jump !== null) {
      emitter.lines.push(`${place.indent}${jump}`);
    }
  }
  // Its transition's jump included: a diagnostic there is still its own.
  emitter.spans.push(
    Object.freeze({ taskId: id, pointer, from: line, to: emitter.lines.length })
  );
};

/**
 * Lowers a task list as one block labelled `label`, which an `exit` in it
 * leaves; `number` is the list's own, for its targets' labels. Each task
 * a transition names gets a block of its own that closes just before it.
 * The blocks open at the list's start, nested, the latest target
 * outermost, so a `break` out of one lands on its task, and only ever
 * forward.
 */
const lowerList: ListLowerer = (
  emitter,
  items,
  pointer,
  indent,
  { label, number }
) => {
  const tasks: ListTask[] = items.map((item, index) => {
    const itemPointer = pointerJoin(pointer, index);
    const entry = isObject(item) ? onlyEntry(item) : undefined;
    if (entry === undefined || !isObject(entry[1])) {
      throw new Error(`The checked workflow has no task at ${itemPointer}`);
    }
    const [id, task] = entry;
    return { id, task, pointer: pointerJoin(itemPointer, id) };
  });
  const positions = new Map(tasks.map(({ id }, index) => [id, index]));
  const targetLabels = new Map<number, string>();
  for (const [position, { task }] of tasks.entries()) {
    for (const target of transitionsOf(task)) {
      if (!directives.has(target)) {
        const found = resolveTarget(positions, target, position);
        targetLabels.set(found, `t${number}_${found}`);
      }
    }
  }
  const opened = emitter.lines.length;
  emitter.lines.push(`${indent}{`);
  let inner = `${indent}  `;
  const targets = [...targetLabels.keys()].toSorted((a, b) => a - b);
  for (const position of targets.toReversed()) {
    emitter.lines.push(`${inner}${targetLabels.get(position) ?? ""}: {`);
    inner += "  ";
  }
  for (const [position, item] of tasks.entries()) {
    const targetLabel = targetLabels.get(position);
    if (targetLabel !== undefined) {
      inner = inner.slice(2);
      emitter.lines.push(`${inner}}`);
    }
    const jump: Jump = (target) => {
      if (target === "continue") {
        return null;
      }
      if (target === "end") {
        return endJump(emitter);
      }
      let to: string | undefined = label;
      if (target !== "exit") {
        to = targetLabels.get(resolveTarget(positions, target, position));
      }
      if (to === undefined) {
        throw new Error("A transition's target has no label");
      }
      emitter.usedLabels.add(to);
      return `break ${to};`;
    };
    lowerTask(emitter, item, { indent: inner, jump }, lowerList);
  }
  emitter.lines.push(`${indent}}`);
  // Labelled only if a `break` leaves it: a label nothing uses is noise.
  if (emitter.usedLabels.has(label)) {
    emitter.lines[opened] = `${indent}${label}: {`;
  }
};
/**
 * The expressions of `checked` that read a sensitive parameter: by name,
 * or `$params` as a whole (with a computed key, say), which could reach
 * any. A parameter that doesn't say counts as sensitive, as its contract
 * does. A run's output goes back to whoever started it, who needn't build
 * the workflow, so no expression may read one: a sensitive parameter
 * reaches a call only as a binding argument (`bindingArguments`), which is
 * never an expression.
 */
export const sensitiveReads = (
  checked: CheckedWorkflow
): readonly Unsupported[] => {
  const sensitive = sensitiveParams(checked.definition);
  if (sensitive.size === 0) {
    return [];
  }
  const passed = bindingArguments(checked);
  const unsendable = unsendableParams(checked.definition);
  const reads: Unsupported[] = [];
  for (const [pointer, compiled] of checked.expressions) {
    const argument = passed.has(pointer)
      ? bindingArgumentOf(
          valueAt(checked.definition, pointer) ?? null,
          sensitive
        )
      : undefined;
    if (argument !== undefined && !unsendable.has(argument)) {
      continue;
    }
    if (argument !== undefined) {
      const { taskId } = compiled.site;
      reads.push({
        pointer,
        feature: `params.${argument}`,
        ...(taskId === undefined ? {} : { taskId }),
      });
      continue;
    }
    const paths = compiled.paths.filter(
      ({ variable }) => variable === "params"
    );
    // Every read of `$params` is a path of the parsed source: a string
    // literal reads nothing (the profile has no interpolation), so the
    // source's text is never searched.
    const whole = paths.some(({ fields }) => fields.length === 0);
    const named = paths
      .map(({ fields }) => fields[0])
      .find((name) => name !== undefined && sensitive.has(name));
    if (whole || named !== undefined) {
      const { taskId } = compiled.site;
      reads.push({
        pointer,
        feature: named === undefined ? "params" : `params.${named}`,
        ...(taskId === undefined ? {} : { taskId }),
      });
    }
  }
  return reads.slice(0, maxUnsupported);
};

/**
 * The parameters an expression may read, by name, sorted: those declared
 * `sensitive: false`. A parameter that doesn't say counts as sensitive.
 */
const readableParams = (definition: JsonObject): string[] => {
  const params = graspOf(definition)?.params;
  return Object.entries(isObject(params) ? params : {})
    .flatMap(([name, entry]) =>
      isObject(entry) && entry.sensitive === false ? [name] : []
    )
    .toSorted();
};

/** The workflow's own `input.from` or `output.as`, as a stage, if any. */
const workflowStage = (
  emitter: Emitter,
  definition: JsonObject,
  key: "input" | "output",
  transform: "from" | "as"
): string | undefined => {
  const part = definition[key];
  if (!isObject(part) || !Object.hasOwn(part, transform)) {
    return undefined;
  }
  return stageCode(
    emitter,
    part[transform] ?? null,
    pointerJoin(pointerJoin("", key), transform),
    null,
    `${key}.${transform}`
  );
};

/**
 * Generates the module of `checked`, a definition that passed validation:
 * the same definition always makes the same module and table, and labels
 * or layout never reach either.
 */
export const generateWorkflow = (checked: CheckedWorkflow): Generation => {
  const { definition } = checked;
  if (!isObject(definition) || !Array.isArray(definition.do)) {
    throw new Error("A checked workflow is an object with a task list");
  }
  const refusals = new Refusals();
  checkRoot(definition, refusals);
  const emitter: Emitter = {
    checked,
    refusals,
    sensitive: sensitiveParams(definition),
    lines: [],
    expressions: [],
    tasks: [],
    spans: [],
    usedLabels: new Set(),
    counter: 0,
    flow: "flow",
    scope: [],
  };
  emitter.lines.push(
    "// Generated by Grasp from workflow.json: read-only, rebuilt from it.",
    `import { openWorkflow } from ${literal(generatedImport)};`,
    `import type { FlowValue } from ${literal(generatedImport)};`,
    "",
    `export default openWorkflow({ profile: ${literal(checked.profile)} }, async (flow, input) => {`,
    // Upstream's context starts empty; exports replace it.
    "  let context: FlowValue = {};"
  );
  const inputFrom = workflowStage(emitter, definition, "input", "from");
  emitter.lines.push(
    inputFrom === undefined
      ? "  let output: FlowValue = input;"
      : `  let output: FlowValue = await flow.input(input, ${inputFrom});`
  );
  lowerList(emitter, definition.do, "/do", "  ", {
    label: workflowLabel,
    number: 0,
  });
  const outputAs = workflowStage(emitter, definition, "output", "as");
  if (outputAs !== undefined) {
    emitter.lines.push(
      `  output = await flow.output({ output, context }, ${outputAs});`
    );
  }
  emitter.lines.push("  return output;", "});", "");
  const sealed = [
    ...emitter.tasks.map(({ id, pointer }) => ({ taskId: id, pointer })),
    ...emitter.expressions.map(({ taskId, pointer }) => ({ taskId, pointer })),
  ];
  for (const { pointer, taskId } of sealed) {
    if (pointer.length > maxSealedPointerLength) {
      refusals.add(pointer, "pointer:too_long", taskId ?? undefined);
    }
  }
  if (refusals.list.length > 0) {
    return { ok: false, unsupported: Object.freeze([...refusals.list]) };
  }
  return {
    ok: true,
    source: emitter.lines.join("\n"),
    expressions: Object.freeze(
      emitter.expressions.map((e) => Object.freeze(e))
    ),
    tasks: Object.freeze(
      emitter.tasks.map((task) =>
        Object.freeze({ ...task, steps: Object.freeze([...task.steps]) })
      )
    ),
    spans: Object.freeze([...emitter.spans]),
    workflow: Object.freeze({
      input: inputFrom !== undefined,
      output: outputAs !== undefined,
    }),
    params: Object.freeze(readableParams(definition)),
    limits: limitsOf(definition),
  };
};

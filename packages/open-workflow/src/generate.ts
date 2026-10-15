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
 *   its list (`exit`) or out of the workflow (`end`). A target that isn't
 *   strictly later in the same list is never emitted, whatever validation
 *   said (`resolveTarget` throws), so every task runs at most once, and a
 *   run's steps are bounded by its tasks; core refuses any step run twice
 *   all the same (resource-host.ts).
 * - Expressions becoming code. An expression's source never enters the
 *   module: the module names it by its number in the expression table
 *   sealed beside it, and the host evaluates that table's entry with the
 *   pinned jq, at the stage, of the task and step, sealed with it. A
 *   string that isn't wholly `${ … }` stays a literal.
 * - Generated code reaching past the SDK. The module imports
 *   `@grasp-os/sdk/open-workflow` and nothing else; the compiler refuses
 *   any other import of generated code all the same.
 * - Lowering something it doesn't implement. Every construct is checked
 *   against what this generator lowers: anything else (other task kinds,
 *   timeouts, expression waits, limits, reusable definitions) is reported
 *   as unsupported, with its pointer, and nothing is generated. Nothing is
 *   approximated, skipped or left to run time.
 * - A task that makes core spend without bound. A run evaluates each
 *   expression in core, so no stage of a task holds more than
 *   {@link maxTaskExpressions} of them, and no step (what one attempt
 *   evaluates) more than {@link maxStepExpressions}; one with more isn't
 *   lowered.
 * - Sensitive parameters leaving through a run's output. No expression may
 *   read one (`sensitiveReads`): publication refuses it. They are for the
 *   bindings that need them, which named calls bring later (GRA-566). The
 *   build seals the names of the others (`params`), and a run's host gives
 *   expressions only those, so a gap in that analysis reads nothing.
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
export const generatorVersion = "grasp-open-workflow-ts/2";

/** Where the generated module is among a version's files. */
export const generatedPath = ".grasp/workflow.ts";

/** The module generated code imports, and the only one. */
export const generatedImport = "@grasp-os/sdk/open-workflow";

/** The type an expression's result must have where it sits. */
export type ExpressionResult = "boolean" | "json";

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
}

/** The task kinds this generator lowers. */
export type LoweredKind = "do" | "set" | "switch" | "wait";

/** A step a task runs as, besides a `wait`'s sleep. */
export type TaskStep = "task" | "enter" | "leave";

/** A task's data the host checks against the task's own schema. */
export type TaskSchemas = Readonly<
  Partial<Record<"input" | "output" | "export", ValueDescriptor>>
>;

/** One task of the generated module, and the steps it runs as. */
export interface GeneratedTask {
  readonly id: string;
  readonly kind: LoweredKind;
  readonly pointer: string;
  /** Its first line in the generated module, from 1. */
  readonly line: number;
  /** How long a `wait` task waits, as its statement says. */
  readonly milliseconds?: number;
  /**
   * Its durable steps (`task:<id>` for a `set` or `switch`; `enter:<id>`
   * and `leave:<id>` around a `wait`'s sleep or a `do`'s list, when it has
   * stages there).
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
      readonly workflow: WorkflowFlow;
      /** The parameters expressions may read: those not sensitive. */
      readonly params: readonly string[];
    }
  | { readonly ok: false; readonly unsupported: readonly Unsupported[] };

/** Most unsupported constructs reported: the rest are the same kind of news. */
const maxUnsupported = 20;

/** What the top level may hold: upstream's, less `use` and `timeout`. */
const supportedRoot = new Set([
  "document",
  "evaluate",
  "input",
  "output",
  "do",
]);

/** What a lowered task may hold besides its kind. */
const supportedTaskKeys = new Set([
  "if",
  "input",
  "output",
  "export",
  "then",
  "metadata",
]);

/** Task kinds lowered here; the profile's others come later. */
const loweredKinds = new Set<string>(["do", "set", "switch", "wait"]);

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

/** Refuses what the definition's own parts hold beyond what is lowered. */
const checkRoot = (definition: JsonObject, refusals: Refusals): void => {
  for (const key of Object.keys(definition)) {
    if (!supportedRoot.has(key)) {
      refusals.add(pointerJoin("", key), key);
    }
  }
  const { document } = definition;
  const grasp =
    isObject(document) && isObject(document.metadata)
      ? document.metadata.grasp
      : undefined;
  if (isObject(grasp) && Object.hasOwn(grasp, "limits")) {
    refusals.add("/document/metadata/grasp/limits", "limits");
  }
};

/** What one generation builds as it walks. */
interface Emitter {
  readonly checked: CheckedWorkflow;
  readonly refusals: Refusals;
  readonly lines: string[];
  readonly expressions: SealedExpression[];
  readonly tasks: GeneratedTask[];
  /** Labels some `break` leaves: only those are written. */
  readonly usedLabels: Set<string>;
  /** Counts lists and tasks, for labels and variables of their own. */
  counter: number;
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
    `${place.indent}({ output, context } = await flow.set(${literal(item.id)}, { input: output, context }, ${plan}));`
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
    `${place.indent}  const chosen = await flow.switch(${literal(item.id)}, { input: output, context }, ${plan});`,
    `${place.indent}  ({ output, context } = chosen);`,
    ...jumps,
    `${place.indent}}`
  );
};

/**
 * The statements of a task with a durable body (a `wait`'s sleep, a
 * `do`'s list): its enter step, if it has stages before the body, then
 * the body, then its leave step, if it has stages after.
 */
const lowerDurable = (
  emitter: Emitter,
  item: ListTask,
  stages: Stages,
  place: ListPlace,
  body: (indent: string) => void
): TaskStep[] => {
  const steps: TaskStep[] = [];
  const hasEnter = stages.enter.length > 0;
  const hasLeave = stages.leave.length > 0;
  if (!hasEnter && !hasLeave) {
    body(place.indent);
    return steps;
  }
  emitter.counter += 1;
  // Of this task alone: a nested task's are numbered after it.
  const raw = `raw${emitter.counter}`;
  const entered = `entered${emitter.counter}`;
  const { indent } = place;
  const id = literal(item.id);
  emitter.lines.push(`${indent}{`);
  if (hasLeave) {
    emitter.lines.push(`${indent}  const ${raw} = output;`);
  }
  let inner = `${indent}  `;
  if (hasEnter) {
    steps.push("enter");
    emitter.lines.push(
      `${inner}const ${entered} = await flow.enter(${id}, { input: output, context }, ${planCode(stages.enter)});`,
      `${inner}if (!${entered}.skipped) {`,
      `${inner}  output = ${entered}.input;`
    );
    inner += "  ";
  }
  body(inner);
  if (hasLeave) {
    steps.push("leave");
    const enteredInput = hasEnter ? `${entered}.input` : raw;
    emitter.lines.push(
      `${inner}({ output, context } = await flow.leave(${id}, { input: ${raw}, context }, ${enteredInput}, output, ${planCode(stages.leave)}));`
    );
  }
  if (hasEnter) {
    emitter.lines.push(`${indent}  }`);
  }
  emitter.lines.push(`${indent}}`);
  return steps;
};

/** Lowers a task list: `lowerList`, passed to the tasks it lowers. */
type ListLowerer = (
  emitter: Emitter,
  items: readonly JsonValue[],
  pointer: string,
  indent: string,
  list: { label: string; number: number }
) => void;

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
  let refused = false;
  if (!loweredKinds.has(kind)) {
    const { call } = task;
    emitter.refusals.add(
      pointer,
      kind === "call" && typeof call === "string" ? `call:${call}` : kind,
      id
    );
    refused = true;
  }
  for (const key of Object.keys(task)) {
    if (key !== kind && !supportedTaskKeys.has(key)) {
      emitter.refusals.add(pointerJoin(pointer, key), key, id);
      refused = true;
    }
  }
  if (refused) {
    return;
  }
  const line = emitter.lines.length + 1;
  const before = emitter.expressions.length;
  const stages = stagesOf(emitter, id, task, pointer);
  const sealed = {
    id,
    pointer,
    line,
    schemas: Object.freeze({ ...stages.schemas }),
  };
  if (kind === "set" || kind === "switch") {
    emitter.tasks.push({ ...sealed, kind, steps: ["task"] });
    if (kind === "set") {
      lowerSet(emitter, item, stages, place);
    } else {
      lowerSwitch(emitter, item, stages, place);
    }
    // One step evaluates all of these. A durable task's enter and leave
    // steps hold two stages each, so never more than this.
    if (emitter.expressions.length - before > maxStepExpressions) {
      emitter.refusals.add(pointer, "step:expressions", id);
    }
  } else if (kind === "wait") {
    const ms = literalDurationMs(task.wait);
    if (ms === undefined) {
      emitter.refusals.add(pointerJoin(pointer, "wait"), "wait:expression", id);
      return;
    }
    const steps: TaskStep[] = ["task"];
    emitter.tasks.push({ ...sealed, kind, milliseconds: ms, steps });
    steps.push(
      ...lowerDurable(emitter, item, stages, place, (indent) => {
        emitter.lines.push(
          `${indent}await flow.wait(${literal(id)}, ${literal(ms)});`
        );
      })
    );
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
      let to: string | undefined = label;
      if (target === "end") {
        to = workflowLabel;
      } else if (target !== "exit") {
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
 * the workflow, so no expression may read one until bindings use them.
 */
export const sensitiveReads = (
  checked: CheckedWorkflow
): readonly Unsupported[] => {
  const { definition } = checked;
  const document = isObject(definition) ? definition.document : undefined;
  const metadata = isObject(document) ? document.metadata : undefined;
  const grasp = isObject(metadata) ? metadata.grasp : undefined;
  const params = isObject(grasp) ? grasp.params : undefined;
  const sensitive = new Set(
    Object.entries(isObject(params) ? params : {}).flatMap(([name, entry]) =>
      isObject(entry) && entry.sensitive === false ? [] : [name]
    )
  );
  if (sensitive.size === 0) {
    return [];
  }
  const reads: Unsupported[] = [];
  for (const [pointer, compiled] of checked.expressions) {
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
  const { document } = definition;
  const metadata = isObject(document) ? document.metadata : undefined;
  const grasp = isObject(metadata) ? metadata.grasp : undefined;
  const params = isObject(grasp) ? grasp.params : undefined;
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
    lines: [],
    expressions: [],
    tasks: [],
    usedLabels: new Set(),
    counter: 0,
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
    workflow: Object.freeze({
      input: inputFrom !== undefined,
      output: outputAs !== undefined,
    }),
    params: Object.freeze(readableParams(definition)),
  };
};

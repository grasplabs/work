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
 * order: it doesn't hand the definition to an interpreter.
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
 * - Expressions becoming code. An expression's source never enters the
 *   module: the module names it by its number in the expression table
 *   sealed beside it, and the host evaluates that table's entry with the
 *   pinned jq. A string that isn't wholly `${ … }` stays a literal.
 * - Generated code reaching past the SDK. The module imports
 *   `@grasp-os/sdk/open-workflow` and nothing else; the compiler refuses
 *   any other import of generated code all the same.
 * - Lowering something it doesn't implement. Every construct is checked
 *   against what this generator lowers: anything else (other task kinds,
 *   transitions, transformations, limits, reusable definitions) is
 *   reported as unsupported, with its pointer, and nothing is generated.
 *   Nothing is approximated, skipped or left to run time.
 * - A task that makes core spend without bound. A run evaluates each
 *   expression in core, so a `set` task holds at most
 *   {@link maxTaskExpressions} of them; one with more isn't lowered.
 * - Sensitive parameters leaving through a run's output. No expression may
 *   read one (`sensitiveReads`): publication refuses it. They are for the
 *   bindings that need them, which named calls bring later (GRA-566).
 */

/**
 * The most expressions one lowered task holds. Each is evaluated in core
 * within the evaluator's fuel (about 100 ms of CPU at most), and an
 * attempt has a fuel budget of its own across them (core's
 * resource-host.ts); 64 is many times what a task's data needs, and keeps
 * a task's table small enough to check at a glance.
 */
export const maxTaskExpressions = 64;

/** The generator's identity: part of every build it makes. */
export const generatorVersion = "grasp-open-workflow-ts/1";

/** Where the generated module is among a version's files. */
export const generatedPath = ".grasp/workflow.ts";

/** The module generated code imports, and the only one. */
export const generatedImport = "@grasp-os/sdk/open-workflow";

/** One expression of the sealed table, by its number (`slot`). */
export interface SealedExpression {
  readonly slot: number;
  readonly pointer: string;
  readonly taskId: string;
  readonly stage: Stage;
  readonly source: string;
}

/** One task of the generated module, and the step it runs as. */
export interface GeneratedTask {
  readonly id: string;
  readonly kind: "set" | "wait";
  readonly pointer: string;
  /** Its line in the generated module, from 1. */
  readonly line: number;
  /** How long a `wait` task waits, as its statement says. */
  readonly milliseconds?: number;
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

/** What a lowered task may hold besides its kind: display metadata only. */
const supportedTaskKeys = new Set(["metadata"]);

/** Task kinds lowered here; the profile's others come later. */
const loweredKinds = new Set(["set", "wait"]);

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
  for (const [part, transform] of [
    ["input", "from"],
    ["output", "as"],
  ] as const) {
    const flow = definition[part];
    if (isObject(flow) && Object.hasOwn(flow, transform)) {
      refusals.add(
        pointerJoin(pointerJoin("", part), transform),
        `${part}.${transform}`
      );
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
  readonly lines: string[];
  readonly expressions: SealedExpression[];
  readonly tasks: GeneratedTask[];
}

/**
 * `value` at `pointer` as a TypeScript expression: its literals as
 * literals, each `${ … }` string an evaluation of its sealed slot.
 */
const valueCode = (
  emitter: Emitter,
  value: JsonValue,
  pointer: string,
  taskId: string
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
      source: compiled.source,
    });
    return `await task.evaluate(${slot})`;
  }
  if (value === null || typeof value !== "object") {
    return literal(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item, index) =>
      valueCode(emitter, item, pointerJoin(pointer, index), taskId)
    );
    return `[${items.join(", ")}]`;
  }
  const members = Object.entries(value).map(
    ([key, member]) =>
      `[${literal(key)}]: ${valueCode(emitter, member, pointerJoin(pointer, key), taskId)}`
  );
  return `{ ${members.join(", ")} }`;
};

/** Lowers one task, or says why it can't be. */
const lowerTask = (
  emitter: Emitter,
  refusals: Refusals,
  id: string,
  task: JsonObject,
  pointer: string
): void => {
  const kind = kindOf(task);
  if (kind === undefined) {
    throw new Error(`The checked workflow has a task of no kind at ${pointer}`);
  }
  let refused = false;
  if (!loweredKinds.has(kind)) {
    const { call } = task;
    refusals.add(
      pointer,
      kind === "call" && typeof call === "string" ? `call:${call}` : kind,
      id
    );
    refused = true;
  }
  for (const key of Object.keys(task)) {
    if (key !== kind && !supportedTaskKeys.has(key)) {
      refusals.add(pointerJoin(pointer, key), key, id);
      refused = true;
    }
  }
  if (refused) {
    return;
  }
  const line = emitter.lines.length + 1;
  if (kind === "wait") {
    const ms = literalDurationMs(task.wait);
    if (ms === undefined) {
      refusals.add(pointerJoin(pointer, "wait"), "wait:expression", id);
      return;
    }
    emitter.tasks.push({ id, kind, pointer, line, milliseconds: ms });
    emitter.lines.push(`  await flow.wait(${literal(id)}, ${literal(ms)});`);
    return;
  }
  const setPointer = pointerJoin(pointer, "set");
  const before = emitter.expressions.length;
  const value = valueCode(emitter, task.set ?? null, setPointer, id);
  if (emitter.expressions.length - before > maxTaskExpressions) {
    refusals.add(setPointer, "set:expressions", id);
    return;
  }
  const scope = emitter.expressions.length > before ? "task" : "";
  // An object literal as an arrow's body needs parentheses.
  const body = value.startsWith("{") ? `(${value})` : value;
  emitter.tasks.push({ id, kind: "set", pointer, line });
  emitter.lines.push(
    `  output = await flow.task(${literal(id)}, { input: output, context }, async (${scope}) => ${body});`
  );
};

/**
 * Generates the module of `checked`, a definition that passed validation:
 * the same definition always makes the same module and table, and labels
 * or layout never reach either.
 */
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

export const generateWorkflow = (checked: CheckedWorkflow): Generation => {
  const { definition } = checked;
  if (!isObject(definition) || !Array.isArray(definition.do)) {
    throw new Error("A checked workflow is an object with a task list");
  }
  const refusals = new Refusals();
  checkRoot(definition, refusals);
  const emitter: Emitter = { checked, lines: [], expressions: [], tasks: [] };
  emitter.lines.push(
    "// Generated by Grasp from workflow.json: read-only, rebuilt from it.",
    `import { openWorkflow } from ${literal(generatedImport)};`,
    `import type { FlowValue } from ${literal(generatedImport)};`,
    "",
    `export default openWorkflow({ profile: ${literal(checked.profile)} }, async (flow, input) => {`,
    // Upstream's context starts empty; nothing lowered here changes it.
    "  const context: FlowValue = {};",
    "  let output: FlowValue = input;"
  );
  for (const [index, item] of definition.do.entries()) {
    const pointer = pointerJoin("/do", index);
    const entry = isObject(item) ? onlyEntry(item) : undefined;
    if (entry === undefined || !isObject(entry[1])) {
      throw new Error(`The checked workflow has no task at ${pointer}`);
    }
    const [id, task] = entry;
    lowerTask(emitter, refusals, id, task, pointerJoin(pointer, id));
  }
  emitter.lines.push("  return output;", "});", "");
  const sealed = [
    ...emitter.tasks.map(({ id, pointer }) => ({ taskId: id, pointer })),
    ...emitter.expressions.map(({ taskId, pointer }) => ({ taskId, pointer })),
  ];
  for (const { pointer, taskId } of sealed) {
    if (pointer.length > maxSealedPointerLength) {
      refusals.add(pointer, "pointer:too_long", taskId);
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
    tasks: Object.freeze(emitter.tasks.map((task) => Object.freeze(task))),
  };
};

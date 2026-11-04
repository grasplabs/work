import { Validator } from "@cfworker/json-schema";
import { compileDataSchema } from "@grasp-os/open-workflow/data-schema";
import type { ValueDescriptor } from "@grasp-os/sdk";
import { checkExpression } from "@grasp-os/sdk/expression-check";
import type { ExpressionRead } from "@grasp-os/sdk/expression-check";
import { currencySchema, paramValueSchemas } from "@grasp-os/sdk/params";

import {
  formatLimits,
  isSensitive,
  isValueList,
  localContractPattern,
} from "./format.ts";
import type {
  Binding,
  Json,
  Param,
  Step,
  Value,
  WorkflowDocument,
} from "./format.ts";
import { workflowSchema } from "./schema.ts";

// Checking a workflow in grasp-workflow/1: first against its JSON Schema
// with a standard validator (@cfworker/json-schema), then for what no
// schema says, and nothing more:
//
// - step IDs unique in the workflow, each step's engine names its own;
// - every expression checked where it stands (`@grasp-os/sdk/expression-check`): it reads
//   only steps that ran before it, declared parameters that aren't
//   sensitive, and `error` only in a catch;
// - a sensitive parameter only as a whole argument of a connector call,
//   which the host fills in and the run's code never sees;
// - each step's binding declared, of a kind the step calls;
// - parameter defaults the SDK takes, and schemas the SDK compiles;
// - lists nested at most `formatLimits.depth` deep, and at most
//   `formatLimits.steps` steps in all.
//
// What it answers is what the generator needs (generate.ts): the document,
// each expression's code, each sensitive placeholder and each agent's
// answer descriptor, by JSON Pointer.

/** A problem with a workflow, where it is. */
export interface Problem {
  readonly pointer: string;
  readonly message: string;
}

/** A workflow that passed every check, and what generating it takes. */
export interface CheckedWorkflow {
  readonly document: WorkflowDocument;
  /** Each expression's code to emit, by the pointer of its `{ $expr }`. */
  readonly code: ReadonlyMap<string, string>;
  /** Each sensitive parameter a connector call passes, by its pointer. */
  readonly placeholders: ReadonlyMap<string, string>;
  /** Each agent step's answer, as an SDK descriptor, by its step's pointer. */
  readonly answers: ReadonlyMap<string, ValueDescriptor>;
}

export type CheckResult =
  | { readonly ok: true; readonly workflow: CheckedWorkflow }
  | { readonly ok: false; readonly problems: readonly Problem[] };

/** Most problems reported: the rest are the same kind of news. */
const maxProblems = 50;

const validator = new Validator(workflowSchema, "2020-12", false);

/** A JSON Pointer token, escaped (RFC 6901). */
const token = (part: string | number): string =>
  String(part).replaceAll("~", "~0").replaceAll("/", "~1");

const join = (pointer: string, ...parts: (string | number)[]): string => {
  let joined = pointer;
  for (const part of parts) {
    joined = `${joined}/${token(part)}`;
  }
  return joined;
};

/** The validator's instance location (`#/steps/0`) as a JSON Pointer. */
const pointerOf = (location: string): string =>
  location.startsWith("#") ? location.slice(1) : location;

const isExpression = (value: unknown): value is { $expr: string } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.hasOwn(value, "$expr");

const sensitivePattern = /^\s*params\.(?<name>[a-z][A-Za-z0-9]*)\s*$/u;

const localPattern = new RegExp(localContractPattern, "u");

interface Walk {
  readonly document: WorkflowDocument;
  readonly params: ReadonlySet<string>;
  readonly sensitive: ReadonlySet<string>;
  readonly ids: Set<string>;
  readonly problems: Problem[];
  readonly code: Map<string, string>;
  readonly placeholders: Map<string, string>;
  readonly answers: Map<string, ValueDescriptor>;
  count: number;
}

/** Where an expression stands: the steps that ran, and a catch's error. */
interface Place {
  readonly steps: ReadonlySet<string>;
  readonly error: boolean;
}

const problem = (walk: Walk, pointer: string, message: string): void => {
  walk.problems.push({ pointer, message });
};

/**
 * Why `read` may not be read where it stands, if it may not: a step that
 * didn't run before it, or read otherwise than as `steps.<id>.output`, or
 * a parameter not declared or sensitive. (Once GRA-1536's type check
 * lands, a read the steps' schemas don't have is refused there.)
 */
const refusalOf = (
  walk: Walk,
  read: ExpressionRead,
  place: Place
): string | undefined => {
  const [first, second] = read.path;
  if (read.root === "steps") {
    if (typeof first !== "string" || !place.steps.has(first)) {
      return "`steps.<id>` reads only a step that has run before it.";
    }
    if (second !== "output") {
      return "A step is read as `steps.<id>.output`.";
    }
  }
  if (
    read.root === "params" &&
    (typeof first !== "string" || !walk.params.has(first))
  ) {
    return "`params.<name>` reads a declared parameter that isn't sensitive.";
  }
  return undefined;
};

const checkExpressionAt = (
  walk: Walk,
  expression: { $expr: string },
  pointer: string,
  place: Place
): void => {
  const at = join(pointer, "$expr");
  const checked = checkExpression(
    expression.$expr,
    place.error ? { roots: ["error"] } : {}
  );
  if (!checked.ok) {
    for (const { message, fix } of checked.errors) {
      problem(walk, at, `${message} ${fix}`);
    }
    return;
  }
  const refusals = checked.reads.flatMap((read) => {
    const refusal = refusalOf(walk, read, place);
    return refusal === undefined ? [] : [refusal];
  });
  for (const refusal of new Set(refusals)) {
    problem(walk, at, refusal);
  }
  if (refusals.length === 0) {
    walk.code.set(pointer, checked.code);
  }
};

/**
 * Checks the expressions in `value`; a sensitive parameter is allowed as a
 * whole value only where `sensitive` says (a connector call's arguments).
 */
const checkValue = (
  walk: Walk,
  value: Value | undefined,
  pointer: string,
  place: Place,
  sensitive: boolean
): void => {
  if (value === undefined || value === null || typeof value !== "object") {
    return;
  }
  if (isExpression(value)) {
    const named = sensitivePattern.exec(value.$expr)?.groups?.name;
    if (named !== undefined && walk.sensitive.has(named)) {
      if (sensitive) {
        walk.placeholders.set(pointer, named);
      } else {
        problem(
          walk,
          join(pointer, "$expr"),
          `\`params.${named}\` is sensitive: only a connector call's argument may pass it, as a whole value.`
        );
      }
      return;
    }
    checkExpressionAt(walk, value, pointer, place);
    return;
  }
  if (isValueList(value)) {
    for (const [index, item] of value.entries()) {
      checkValue(walk, item, join(pointer, index), place, sensitive);
    }
    return;
  }
  const fields: Readonly<Record<string, Value>> = value;
  for (const [key, item] of Object.entries(fields)) {
    checkValue(walk, item, join(pointer, key), place, sensitive);
  }
};

/** The binding `alias` names, if it is of one of `kinds`. */
const bindingFor = (
  walk: Walk,
  alias: string,
  kinds: readonly Binding["kind"][],
  pointer: string
): Binding | undefined => {
  const bindings = walk.document.bindings ?? {};
  const binding = Object.hasOwn(bindings, alias) ? bindings[alias] : undefined;
  if (binding === undefined) {
    problem(
      walk,
      join(pointer, "binding"),
      `No binding is named \`${alias}\`.`
    );
    return undefined;
  }
  if (!kinds.includes(binding.kind)) {
    problem(
      walk,
      join(pointer, "binding"),
      `\`${alias}\` is a ${binding.kind} binding; this step calls ${kinds.join(" or ")}.`
    );
    return undefined;
  }
  return binding;
};

const checkSchema = (
  walk: Walk,
  schema: Json,
  pointer: string
): ValueDescriptor | undefined => {
  // SAFETY: JSON either way; compileDataSchema's type is only mutable.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const document = schema as Parameters<typeof compileDataSchema>[0];
  const compiled = compileDataSchema(document, pointer);
  if (!compiled.ok) {
    for (const each of compiled.problems) {
      problem(walk, each.pointer, each.remedy);
    }
    return undefined;
  }
  return compiled.schema.descriptor;
};

const checkDo = (
  walk: Walk,
  step: Extract<Step, { type: "do" }>,
  pointer: string,
  place: Place
): void => {
  const binding = bindingFor(
    walk,
    step.binding,
    ["connector", "operation", "compute", "action"],
    pointer
  );
  if (binding?.kind === "connector" && step.operation === undefined) {
    problem(walk, pointer, "A connector call names its `operation`.");
  }
  if (
    binding !== undefined &&
    binding.kind !== "connector" &&
    step.operation !== undefined
  ) {
    problem(
      walk,
      join(pointer, "operation"),
      "Only a connector call names an `operation`."
    );
  }
  checkValue(
    walk,
    step.arguments,
    join(pointer, "arguments"),
    place,
    binding?.kind === "connector"
  );
};

const checkAgent = (
  walk: Walk,
  step: Extract<Step, { type: "agent" }>,
  pointer: string,
  place: Place
): void => {
  bindingFor(walk, step.binding, ["model"], pointer);
  checkValue(
    walk,
    step.instructions,
    join(pointer, "instructions"),
    place,
    false
  );
  checkValue(walk, step.input, join(pointer, "input"), place, false);
  const answer = checkSchema(walk, step.output, join(pointer, "output"));
  if (answer !== undefined) {
    walk.answers.set(pointer, answer);
  }
};

/** A list of steps' checks, as `checkSteps` makes them (lists nest). */
type ListCheck = (
  steps: readonly Step[],
  pointer: string,
  place: Place
) => void;

const checkTry = (
  walk: Walk,
  step: Extract<Step, { type: "try" }>,
  pointer: string,
  place: Place,
  list: ListCheck
): void => {
  list(step.try, join(pointer, "try"), place);
  const caught: Place = { steps: place.steps, error: true };
  const at = join(pointer, "catch");
  if (step.catch.when !== undefined) {
    checkExpressionAt(walk, step.catch.when, join(at, "when"), caught);
  }
  if (step.catch.retry?.when !== undefined) {
    checkExpressionAt(
      walk,
      step.catch.retry.when,
      join(at, "retry", "when"),
      caught
    );
  }
  if (step.catch.do !== undefined) {
    list(step.catch.do, join(at, "do"), caught);
  }
};

const checkStep = (
  walk: Walk,
  step: Step,
  pointer: string,
  place: Place,
  list: ListCheck
): void => {
  if (walk.ids.has(step.id)) {
    problem(walk, join(pointer, "id"), `Two steps are \`${step.id}\`.`);
  }
  walk.ids.add(step.id);
  if (step.if !== undefined) {
    checkExpressionAt(walk, step.if, join(pointer, "if"), place);
  }
  switch (step.type) {
    case "do": {
      checkDo(walk, step, pointer, place);
      break;
    }
    case "agent": {
      checkAgent(walk, step, pointer, place);
      break;
    }
    case "wait": {
      if ("until" in step) {
        checkExpressionAt(walk, step.until, join(pointer, "until"), place);
      }
      break;
    }
    case "if": {
      checkExpressionAt(
        walk,
        step.condition,
        join(pointer, "condition"),
        place
      );
      list(step.then, join(pointer, "then"), place);
      if (step.else !== undefined) {
        list(step.else, join(pointer, "else"), place);
      }
      break;
    }
    case "try": {
      checkTry(walk, step, pointer, place, list);
      break;
    }
    case "raise": {
      break;
    }
    default: {
      step satisfies never;
    }
  }
};

/**
 * Checks a list of steps: each sees the steps of the lists around it that
 * ran before it, and its own list's before it; never one nested in an
 * earlier step's lists, which may not have run.
 */
const checkSteps = (
  walk: Walk,
  steps: readonly Step[],
  pointer: string,
  place: Place,
  depth: number
): void => {
  if (depth > formatLimits.depth) {
    problem(walk, pointer, `Lists nest at most ${formatLimits.depth} deep.`);
    return;
  }
  const ran = new Set(place.steps);
  for (const [index, step] of steps.entries()) {
    walk.count += 1;
    checkStep(
      walk,
      step,
      join(pointer, index),
      { ...place, steps: new Set(ran) },
      (inner, at, around) => {
        checkSteps(walk, inner, at, around, depth + 1);
      }
    );
    ran.add(step.id);
  }
};

const checkParams = (
  walk: Walk,
  params: Readonly<Record<string, Param>>
): void => {
  for (const [name, param] of Object.entries(params)) {
    const at = join("/params", name);
    if (
      !isSensitive(param) &&
      !paramValueSchemas[param.kind].safeParse(param.default).success
    ) {
      problem(
        walk,
        join(at, "default"),
        `Not a default a ${param.kind} parameter takes.`
      );
    }
    if (
      param.currency !== undefined &&
      !currencySchema.safeParse(param.currency).success
    ) {
      problem(walk, join(at, "currency"), "Not an ISO 4217 currency code.");
    }
  }
};

const checkBindings = (
  walk: Walk,
  bindings: Readonly<Record<string, Binding>>
): void => {
  for (const [alias, binding] of Object.entries(bindings)) {
    if (
      (binding.kind === "compute" || binding.kind === "action") &&
      !localPattern.test(binding.contract)
    ) {
      problem(
        walk,
        join("/bindings", alias, "contract"),
        "A compute or action binding names `local:code/<file>.ts#<export>`."
      );
    }
  }
};

/** Checks `json`, a workflow's document as parsed JSON. */
export const checkWorkflow = (json: unknown): CheckResult => {
  const validated = validator.validate(json);
  if (!validated.valid) {
    const errors = validated.errors.map(({ instanceLocation, error }) => ({
      pointer: pointerOf(instanceLocation),
      message: error,
    }));
    // Only the innermost, once each: an error at a place that holds another
    // one's is a branch reporting on its way out, which says nothing more.
    const innermost = new Map<string, Problem>();
    for (const each of errors) {
      const holdsAnother = errors.some(({ pointer }) =>
        pointer.startsWith(`${each.pointer}/`)
      );
      if (!holdsAnother && !innermost.has(each.pointer)) {
        innermost.set(each.pointer, each);
      }
    }
    return {
      ok: false,
      problems: [...innermost.values()].slice(0, maxProblems),
    };
  }
  // SAFETY: the format's JSON Schema, which describes WorkflowDocument,
  // accepted it whole.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const document = json as WorkflowDocument;
  const params = document.params ?? {};
  const walk: Walk = {
    document,
    params: new Set(
      Object.entries(params)
        .filter(([, param]) => !isSensitive(param))
        .map(([name]) => name)
    ),
    sensitive: new Set(
      Object.entries(params)
        .filter(([, param]) => isSensitive(param))
        .map(([name]) => name)
    ),
    ids: new Set(),
    problems: [],
    code: new Map(),
    placeholders: new Map(),
    answers: new Map(),
    count: 0,
  };
  checkParams(walk, params);
  checkBindings(walk, document.bindings ?? {});
  if (document.input !== undefined) {
    checkSchema(walk, document.input, "/input");
  }
  const top: Place = { steps: new Set(), error: false };
  checkSteps(walk, document.steps, "/steps", top, 1);
  if (walk.count > formatLimits.steps) {
    problem(
      walk,
      "/steps",
      `A workflow has at most ${formatLimits.steps} steps in all.`
    );
  }
  if (document.output !== undefined) {
    checkSchema(walk, document.output.schema, "/output/schema");
    checkValue(
      walk,
      document.output.value,
      "/output/value",
      { steps: new Set(document.steps.map(({ id }) => id)), error: false },
      false
    );
  }
  if (walk.problems.length > 0) {
    return { ok: false, problems: walk.problems.slice(0, maxProblems) };
  }
  return {
    ok: true,
    workflow: {
      document,
      code: walk.code,
      placeholders: walk.placeholders,
      answers: walk.answers,
    },
  };
};

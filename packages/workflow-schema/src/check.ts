import { Validator } from "@cfworker/json-schema";
import type { OutputUnit } from "@cfworker/json-schema";
import type { ValueDescriptor, ValueSchema } from "@grasp-os/sdk";
import { checkExpression } from "@grasp-os/sdk/expression-check";
import type {
  ExpressionErrorCode,
  ExpressionRead,
} from "@grasp-os/sdk/expression-check";
import {
  CompactDescriptorError,
  descriptorFromCompact,
  schemaFromDescriptor,
  memberName,
} from "@grasp-os/sdk/host";
import {
  appErrorDetailsMaxBytes,
  isAppErrorCode,
} from "@grasp-os/shared/function-limits";
import { sealedBuildLimits } from "@grasp-os/shared/sealed-builds";
import { passedBound, plainDataBounds } from "@grasp-os/shared/value-bounds";

import {
  aiAlias,
  aliasedPermissions,
  bindingsOf,
  durationMs,
  eachStep,
  expressionRoots,
  formatLimits,
  inboxRoot,
  isSensitive,
  isValueList,
  pointerJoin,
  resultStepTypes,
  stateStepTypes,
} from "./format.ts";
import type {
  Binding,
  Descriptor,
  Duration,
  ExpressionRoot,
  Json,
  StateWrites,
  Step,
  Value,
  WorkflowDocument,
} from "./format.ts";
import { stepTypes, workflowSchema } from "./schema.ts";

// Checking a workflow in grasp-workflow/2: first its depth, without
// recursion, then against its JSON Schema with a standard validator
// (@cfworker/json-schema), then for what no schema says, and nothing more:
//
// - step IDs unique in the workflow, each step's engine names its own;
// - every expression checked where it stands (`@grasp-os/sdk/expression-check`): it reads
//   only the results of steps that ran before it, in its own list or a
//   list around it (exactly what JavaScript's block scope gives the
//   generated `const`s) and that have one (`resultStepTypes`), declared
//   parameters that aren't sensitive, `error` only in a catch,
//   `inbox.<alias>` only of a declared event permission (whether its
//   contract takes email replies is publication's to check, against the
//   catalog), and `output` (the step's own result) only in a step's
//   `state`; `state` it reads anywhere, a key no run kept yet
//   `undefined`;
// - each permission's alias once, whatever its kind, and never `ai` but
//   for the workflow's one model;
// - at most one `try` whose catch retries around any step, so the host
//   knows which policy a failure is retried by;
// - `state` only on a step that keeps it (`stateStepTypes`), writing only
//   keys the workflow declares, a literal value of its key's schema (an
//   expression's value the generated code checks as the step records
//   it); what the state holds in all is the run host's cap (64 KB), which
//   only a run can reach;
// - a sensitive parameter only as a whole argument of a connector call,
//   which the host fills in and the run's code never sees;
// - each step's permission declared, of the kind the step calls;
// - a raise's code the workflow's own, never in a platform namespace;
// - every value's schema (args, returns, answers, state, parameters) a
//   compact descriptor the SDK reads (`descriptorFromCompact`), defaults
//   included;
// - lists nested at most `formatLimits.depth` deep, and at most
//   `formatLimits.steps` steps in all;
// - what it generates within what a sealed build holds
//   (`sealedBuildLimits`): each expression's code and pointer, their
//   number, and every duration at most a year.
//
// What it answers is what the generator needs (generate.ts): the document,
// each expression's code, each sensitive placeholder and each generate
// step's answer descriptor, by JSON Pointer.

/** Why a value's schema was refused. */
type SchemaProblemCode =
  | "schema.invalid"
  | "schema.invalid_default"
  | "schema.too_large";

/** Why a workflow was refused, stable for whoever fixes it. */
export type ProblemCode =
  | ExpressionErrorCode
  | SchemaProblemCode
  | "workflow.too_deep"
  | "workflow.too_large"
  | "workflow.version"
  | "workflow.unknown_property"
  | "workflow.missing_property"
  | "workflow.wrong_type"
  | "workflow.unknown_step_type"
  | "workflow.not_allowed"
  | "workflow.out_of_bounds"
  | "workflow.invalid_id"
  | "workflow.reserved_id"
  | "workflow.invalid_name"
  | "workflow.invalid_alias"
  | "workflow.invalid_event_type"
  | "workflow.invalid_duration"
  | "workflow.invalid_contract"
  | "workflow.wait_kind"
  | "workflow.call_kind"
  | "workflow.state_not_allowed"
  | "workflow.invalid_state_key"
  | "workflow.undeclared_state_key"
  | "workflow.state_type"
  | "workflow.invalid"
  | "workflow.duplicate_id"
  | "workflow.duplicate"
  | "workflow.too_many_steps"
  | "workflow.lists_too_deep"
  | "workflow.unknown_permission"
  | "workflow.permission_kind"
  | "workflow.duplicate_alias"
  | "workflow.no_result"
  | "workflow.retry_nested"
  | "workflow.unreadable"
  | "workflow.sensitive"
  | "workflow.expression_too_long"
  | "workflow.pointer_too_long"
  | "workflow.arguments_too_deep"
  | "workflow.too_many_expressions"
  | "workflow.duration_too_long"
  | "workflow.reserved_error_code"
  | "workflow.details_too_large";

/** A problem with a workflow: what, where it is, and how to fix it. */
export interface Problem {
  readonly code: ProblemCode;
  readonly pointer: string;
  readonly message: string;
  readonly remedy: string;
}

/** A workflow that passed every check, and what generating it takes. */
export interface CheckedWorkflow {
  readonly document: WorkflowDocument;
  /** Each expression's code to emit, by the pointer of its `{ $expr }`. */
  readonly code: ReadonlyMap<string, string>;
  /** Each sensitive parameter a connector call passes, by its pointer. */
  readonly placeholders: ReadonlyMap<string, string>;
  /** Each generate step's answer, as an SDK descriptor, by its step's pointer. */
  readonly answers: ReadonlyMap<string, ValueDescriptor>;
  /**
   * What a caller relies on, as SDK descriptors: what starts a run (an
   * empty object when the document declares no `args`), what it ends
   * with (null when it declares no `returns`), and each parameter's value,
   * its default in it.
   */
  readonly contract: {
    readonly args: ValueDescriptor;
    readonly returns: ValueDescriptor;
    readonly params: ReadonlyMap<string, ValueDescriptor>;
  };
  /**
   * Each declared key of the state, as an SDK descriptor: what the
   * generated code and the host hold a kept value to, as this check holds
   * a literal one.
   */
  readonly state: ReadonlyMap<string, ValueDescriptor>;
  /** Every root its expressions read: what the generated handler binds. */
  readonly roots: ReadonlySet<string>;
}

export type CheckResult =
  | { readonly ok: true; readonly workflow: CheckedWorkflow }
  | { readonly ok: false; readonly problems: readonly Problem[] };

/** Most problems reported: the rest are the same kind of news. */
const maxProblems = 50;

const validator = new Validator(workflowSchema, "2020-12", false);

const join = (pointer: string, ...parts: (string | number)[]): string => {
  let joined = pointer;
  for (const part of parts) {
    joined = pointerJoin(joined, part);
  }
  return joined;
};

/** The validator's instance location (`#/steps/0`) as a JSON Pointer. */
const pointerOf = (location: string): string =>
  location.startsWith("#") ? location.slice(1) : location;

/** The last token of `pointer`, unescaped (RFC 6901). */
const lastOf = (pointer: string): string =>
  (pointer.split("/").at(-1) ?? "").replaceAll("~1", "/").replaceAll("~0", "~");

/** The pointer of what holds `pointer`. */
const parentOf = (pointer: string): string =>
  pointer.slice(0, pointer.lastIndexOf("/"));

/**
 * An event wait's `events` or `eventType` (or one of its types), as a
 * step in any list of steps has it: never a property of that name
 * elsewhere, such as a call's args.
 */
const eventFilterAt =
  /^\/steps\/\d+(?:\/(?:then|else|try|do|catch\/do)\/\d+)*\/(?<part>events|eventType)(?:\/\d+)?$/u;

/** Which part of an event wait's filter `pointer` is, if it is one. */
const eventFilterPart = (pointer: string): string | undefined =>
  eventFilterAt.exec(pointer)?.groups?.part;

const isExpression = (value: unknown): value is { $expr: string } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.hasOwn(value, "$expr");

const sensitivePattern = /^\s*params\.(?<name>[a-z][A-Za-z0-9]*)\s*$/u;

// The validator's errors that only say a subschema had errors: the ones
// that hold them say what is wrong.
const branchKeywords = new Set([
  "$ref",
  "properties",
  "items",
  "allOf",
  "anyOf",
  "if",
  "then",
  "else",
  "additionalProperties",
  "propertyNames",
]);

/** A schema error the validator reported, where it is. */
type SchemaError = OutputUnit & {
  readonly pointer: string;
  /** Whether it is about a `call` step. */
  readonly calls?: boolean;
};

/** The `type` of the value at `pointer` of `json`, if it has a string one. */
const stepTypeAt = (json: unknown, pointer: string): string | undefined => {
  let value = json;
  for (const token of pointer.split("/").slice(1)) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    value =
      typeof value === "object" && value !== null && Object.hasOwn(value, key)
        ? Reflect.get(value, key)
        : undefined;
  }
  return typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
    ? value.type
    : undefined;
};

/** An `anyOf` branch, as its errors' keyword locations start. */
const anyOfBranch =
  /^(?<branch>.*\/anyOf\/\d+)(?:\/\$ref)*\/(?:type|required|not)$/u;

/**
 * The errors of `errors` that say what is wrong. Of an `anyOf` (a value:
 * an expression, a scalar, a list or an object), only the branches of the
 * value's own kind: a branch whose type, required key or `not` the value
 * fails at the `anyOf`'s own place isn't the one meant. And a property
 * named unknown (`false`) only where nothing else is wrong with it or
 * with what holds it: the validator names so a property whose own schema
 * failed, and every member of an object a branch not meant refused.
 */
const meantErrors = (errors: readonly OutputUnit[]): SchemaError[] => {
  const leaves = errors
    .filter(({ keyword }) => !branchKeywords.has(keyword))
    .map((each) => ({ ...each, pointer: pointerOf(each.instanceLocation) }));
  const unmeant = leaves.flatMap(({ keywordLocation, pointer }) => {
    const branch = anyOfBranch.exec(keywordLocation)?.groups?.branch;
    return branch === undefined ? [] : [{ branch, pointer }];
  });
  const meant = leaves.filter(
    ({ keywordLocation, pointer }) =>
      !unmeant.some(
        (each) =>
          keywordLocation.startsWith(`${each.branch}/`) &&
          (pointer === each.pointer || pointer.startsWith(`${each.pointer}/`))
      )
  );
  const kept = meant.length > 0 ? meant : leaves;
  const said = kept.filter(({ keyword }) => keyword !== "false");
  return kept.filter(
    ({ keyword, pointer }) =>
      keyword !== "false" ||
      !(
        kept.some((other) => other.pointer.startsWith(`${pointer}/`)) ||
        said.some(
          (other) =>
            other.pointer === pointer || other.pointer === parentOf(pointer)
        )
      )
  );
};

const durationProperties = new Set(["for", "timeout", "delay"]);

/** The properties of a step that name a permission by its alias. */
const aliasProperties = new Set(["connection", "module", "decision"]);

/** What a bound error's remedy says, by the keyword it failed. */
const boundRemedies: Readonly<Record<string, string>> = {
  maxLength: "Shorten it to the length the message gives.",
  minLength: "Give it some text.",
  maxItems: "Keep it to the number of items the message gives.",
  minItems: "Give at least the number of items the message gives.",
  maxProperties: "Keep it to the number of entries the message gives.",
  minimum: "Give a number in the range the message gives.",
  maximum: "Give a number in the range the message gives.",
};

/** A pattern or `not` error's problem, by what it is about. */
const patternProblem = ({
  keyword,
  pointer,
}: SchemaError): Omit<Problem, "pointer"> | undefined => {
  const last = lastOf(pointer);
  const parent = parentOf(pointer);
  if (last === "id") {
    return keyword === "not"
      ? {
          code: "workflow.reserved_id",
          message:
            "A step can't take this ID: it is a JavaScript reserved word, or a name the workflow's code reads already (`args`, `params`, `run`, `state`, `inbox`, `error`, `item`, `output`, `ctx`).",
          remedy: "Choose another ID, e.g. `sendInvoice`.",
        }
      : {
          code: "workflow.invalid_id",
          message: "Not a step ID.",
          remedy:
            "Write an identifier of letters and digits, starting with a lower-case letter, e.g. `sendInvoice`.",
        };
  }
  if (last === "contract") {
    return {
      code: "workflow.invalid_contract",
      message: "Not a contract this permission's kind takes.",
      remedy:
        "Name a module's file and export, `local:code/<file>.ts#<export>`; any other permission names a catalog contract, never `local:`.",
    };
  }
  if (parent.endsWith("/state")) {
    return {
      code: "workflow.invalid_state_key",
      message: "Not a key of the workflow's state.",
      remedy:
        "Start with a letter, then letters, digits and `_` only, e.g. `lastSeen`; never `constructor` or `prototype`.",
    };
  }
  if (parent === "/params") {
    return {
      code: "workflow.invalid_name",
      message: "Not a parameter's name.",
      remedy:
        "Start with a lower-case letter, then letters and digits only, e.g. `apiKey`.",
    };
  }
  const filterPart = eventFilterPart(pointer);
  if (
    parent.startsWith("/permissions/") ||
    aliasProperties.has(last) ||
    filterPart === "events"
  ) {
    return {
      code: "workflow.invalid_alias",
      message: "Not a permission's alias.",
      remedy: "Start with a letter, then letters, digits and `_` only.",
    };
  }
  if (last === "action") {
    return {
      code: "workflow.invalid_name",
      message: "Not a connection's action.",
      remedy:
        "Name the action as its connection does: dotted names of letters, digits, `_` and `-`, e.g. `mail.send`.",
    };
  }
  if (last === "code") {
    return {
      code: "workflow.invalid_name",
      message: "Not an error code.",
      remedy:
        "Write two or more dotted lower-case segments, e.g. `invoice.rejected`.",
    };
  }
  if (filterPart === "eventType") {
    return {
      code: "workflow.invalid_event_type",
      message: "Not an event type.",
      remedy:
        "Name a type the permission's contract admits, on one line, with no space before or after it, e.g. `invoice.approved`.",
    };
  }
  if (durationProperties.has(last)) {
    return {
      code: "workflow.invalid_duration",
      message: "Not a duration.",
      remedy:
        "Write a whole count and a unit (second, minute, hour, day or week), e.g. `30 minutes`.",
    };
  }
  return undefined;
};

/** A problem of the document's own properties: unknown, missing, its kind. */
const propertyProblem = (
  error: SchemaError
): Omit<Problem, "pointer"> | undefined => {
  const { keyword, pointer } = error;
  const name = lastOf(pointer);
  if (keyword === "false" && name === "state") {
    return {
      code: "workflow.state_not_allowed",
      message: `Only a ${stateStepTypes.map((type) => `\`${type}\``).join(" or ")} step keeps state: no other records a result of its own to write it with.`,
      remedy:
        "Move `state` to the `call` or `generate` step whose result it keeps.",
    };
  }
  if (keyword === "false") {
    return {
      code: "workflow.unknown_property",
      message: `\`${name}\` isn't a property here.`,
      remedy: "Remove it, or name it as the format does.",
    };
  }
  if (keyword === "required") {
    const missing = /"(?<key>[^"]*)"/u.exec(error.error)?.groups?.key ?? "";
    return {
      code: "workflow.missing_property",
      message: `\`${missing}\` is missing.`,
      remedy: `Add \`${missing}\`.`,
    };
  }
  if (keyword === "const" && pointer === "/$schema") {
    return {
      code: "workflow.version",
      message: "Not a grasp-workflow/2 document.",
      remedy: `Set \`$schema\` to "${String(workflowSchema.$id)}".`,
    };
  }
  if (keyword === "enum" && name === "type" && pointer.startsWith("/steps/")) {
    return {
      code: "workflow.unknown_step_type",
      message: "Not a kind of step.",
      remedy: `Use one of: ${stepTypes.join(", ")}.`,
    };
  }
  if (keyword === "pattern" || keyword === "not") {
    return patternProblem(error);
  }
  return undefined;
};

/** The problem a schema error is, with a code and a remedy. */
const schemaProblem = (error: SchemaError): Problem => {
  const { keyword, pointer } = error;
  const as = (problem: Omit<Problem, "pointer">): Problem => ({
    pointer,
    ...problem,
  });
  const named = propertyProblem(error);
  if (named !== undefined) {
    return as(named);
  }
  if (keyword === "oneOf" && error.calls === true) {
    return as({
      code: "workflow.call_kind",
      message:
        "A call calls a connection's action, or one of the workflow's own modules.",
      remedy: "Give it `connection` and `action`, or `module`.",
    });
  }
  if (keyword === "oneOf") {
    return as({
      code: "workflow.wait_kind",
      message: "A wait waits for a time span or until a deadline.",
      remedy:
        "Give it one of `for` and `until`; to wait for an event, write a `waitForEvent` step.",
    });
  }
  if (keyword === "uniqueItems" && eventFilterPart(pointer) === "eventType") {
    return as({
      code: "workflow.duplicate",
      message: "It names the same type twice.",
      remedy: "Name each type once.",
    });
  }
  if (keyword === "type") {
    return as({
      code: "workflow.wrong_type",
      message: error.error,
      remedy: "Give a value of the type the message names.",
    });
  }
  const bound = boundRemedies[keyword];
  if (bound !== undefined) {
    return as({
      code: "workflow.out_of_bounds",
      message: error.error,
      remedy: bound,
    });
  }
  if (keyword === "enum" || keyword === "const" || keyword === "not") {
    return as({
      code: "workflow.not_allowed",
      message: error.error,
      remedy: "Use one of the values the format allows here.",
    });
  }
  return as({
    code: "workflow.invalid",
    message: error.error,
    remedy: "Write it as the format's schema describes it.",
  });
};

/**
 * What is wrong with `json`'s shape: too deep or too large to be applied
 * a schema to (the validator recurses), or what its schema refuses.
 */
const shapeProblems = (json: unknown): Problem[] => {
  const passed = passedBound([json], {
    depth: formatLimits.documentDepth,
    size: plainDataBounds.size,
  });
  if (passed === "depth") {
    return [
      {
        code: "workflow.too_deep",
        pointer: "",
        message: `A workflow nests at most ${formatLimits.documentDepth} levels deep.`,
        remedy:
          "Flatten its values, or move a deep value into the run's input.",
      },
    ];
  }
  if (passed !== undefined) {
    return [
      {
        code: "workflow.too_large",
        pointer: "",
        message: "Not a workflow document: too large, or not JSON.",
        remedy: "Send the workflow as parsed JSON.",
      },
    ];
  }
  const validated = validator.validate(json);
  if (validated.valid) {
    return [];
  }
  const problems = new Map<string, Problem>();
  for (const error of meantErrors(validated.errors)) {
    if (!problems.has(error.pointer)) {
      problems.set(
        error.pointer,
        schemaProblem({
          ...error,
          // Which step's `oneOf` it is, by the step's own type.
          calls: stepTypeAt(json, error.pointer) === "call",
        })
      );
    }
  }
  return [...problems.values()];
};

interface Walk {
  readonly document: WorkflowDocument;
  /** Every permission, by alias, as the host binds it. */
  readonly bindings: Readonly<Record<string, Binding>>;
  /** Every step's ID, nested ones included: an expression's roots. */
  readonly stepIds: readonly string[];
  /** The steps with a result, by ID. */
  readonly resultSteps: ReadonlySet<string>;
  readonly params: ReadonlySet<string>;
  readonly sensitive: ReadonlySet<string>;
  readonly ids: Set<string>;
  /**
   * Each raise's error by its code, as JSON: a run fails with the raise
   * its code names, so one code is one error.
   */
  readonly raises: Map<string, string>;
  /**
   * Each connection's actions by the member a call reads them by
   * (`memberName` of each dotted part), so no two read alike.
   */
  readonly members: Map<string, Map<string, string>>;
  readonly problems: Problem[];
  readonly code: Map<string, string>;
  readonly placeholders: Map<string, string>;
  readonly answers: Map<string, ValueDescriptor>;
  /** How many array and object literals each expression nests, by pointer. */
  readonly literals: Map<string, number>;
  /** Every root an expression reads, anywhere. */
  readonly roots: Set<string>;
  /** Each declared key of the state, by its compiled schema. */
  readonly state: Map<string, ValueSchema<unknown, unknown>>;
  count: number;
}

/**
 * Where an expression stands: the steps that ran, a catch's error, a
 * loop's item, a step's own result in its `state`, and whether a `try`
 * around it retries.
 */
interface Place {
  readonly steps: ReadonlySet<string>;
  readonly error: boolean;
  readonly item: boolean;
  readonly output: boolean;
  readonly retrying: boolean;
}

const problem = (
  walk: Walk,
  pointer: string,
  code: ProblemCode,
  message: string,
  remedy: string
): void => {
  walk.problems.push({ code, pointer, message, remedy });
};

/**
 * Why `read` may not be read where it stands, if it may not: a step that
 * has no result, or didn't run before it in its list or a list around it,
 * or a parameter not declared or sensitive, or an inbox of no event
 * permission.
 */
const refusalOf = (
  walk: Walk,
  read: ExpressionRead,
  place: Place
): { message: string; remedy: string } | undefined => {
  const [first] = read.path;
  if (walk.stepIds.includes(read.root)) {
    if (!walk.resultSteps.has(read.root)) {
      return {
        message: `\`${read.root}\` has no result to read: only a call, generate, decide or waitForEvent step has one.`,
        remedy: "Read the result of a step that has one.",
      };
    }
    if (!place.steps.has(read.root)) {
      return {
        message: `\`${read.root}\` reads only a step that ran before it, in its own list or a list around it.`,
        remedy: "Read a step earlier in its list, or in a list around it.",
      };
    }
  }
  if (read.root === inboxRoot) {
    const binding =
      typeof first === "string" && Object.hasOwn(walk.bindings, first)
        ? walk.bindings[first]
        : undefined;
    if (binding?.kind !== "event") {
      return {
        message:
          "`inbox.<alias>` reads the reply address of a declared event permission.",
        remedy: "Name an event permission the workflow declares.",
      };
    }
  }
  if (
    read.root === "params" &&
    (typeof first !== "string" || !walk.params.has(first))
  ) {
    return {
      message:
        "`params.<name>` reads a declared parameter that isn't sensitive.",
      remedy:
        "Declare the parameter with `sensitive: false`, or pass a sensitive one whole as a connection call's argument.",
    };
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
  // Its pointer, as the host seals it: long keys around it make it long.
  if (pointer.length > sealedBuildLimits.pointerLength) {
    problem(
      walk,
      at,
      "workflow.pointer_too_long",
      `Its place is further in than the ${sealedBuildLimits.pointerLength} characters of pointer a sealed expression has.`,
      "Shorten the keys of the objects around it."
    );
    return;
  }
  const inScope: Readonly<Record<ExpressionRoot, boolean>> = {
    inbox: true,
    state: true,
    error: place.error,
    item: place.item,
    output: place.output,
  };
  const checked = checkExpression(expression.$expr, {
    roots: [
      ...expressionRoots.filter((root) => inScope[root]),
      ...walk.stepIds,
    ],
  });
  if (!checked.ok) {
    for (const { code, message, fix } of checked.errors) {
      problem(walk, at, code, message, fix);
    }
    return;
  }
  walk.literals.set(pointer, checked.literalDepth);
  for (const read of checked.reads) {
    walk.roots.add(read.root);
  }
  const refusals = new Map(
    checked.reads.flatMap((read) => {
      const refusal = refusalOf(walk, read, place);
      return refusal === undefined ? [] : [[refusal.message, refusal]];
    })
  );
  for (const { message, remedy } of refusals.values()) {
    problem(walk, at, "workflow.unreadable", message, remedy);
  }
  // Its code as the host seals it: the source of a long chain of reads
  // lowers to code several times as long.
  if (checked.code.length > sealedBuildLimits.expressionLength) {
    problem(
      walk,
      at,
      "workflow.expression_too_long",
      `Its code would be longer than the ${sealedBuildLimits.expressionLength} characters a sealed expression has.`,
      "Shorten it, or split it across steps."
    );
    return;
  }
  if (refusals.size === 0) {
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
          "workflow.sensitive",
          `\`params.${named}\` is sensitive: only a connection call's argument may pass it, as a whole value.`,
          "Pass it whole as a connection call's argument, or declare the parameter with `sensitive: false`."
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

/**
 * How many objects and arrays `value`, at `pointer`, nests at least: an
 * expression as many as its own literals nest (what it reads may nest
 * more, which only the run knows). Measured without recursion.
 */
const nestingOf = (walk: Walk, value: Value, pointer: string): number => {
  let deepest = 0;
  const pending: [Value, number, string][] = [[value, 0, pointer]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [held, level, at] = next;
    if (isExpression(held)) {
      deepest = Math.max(deepest, level + (walk.literals.get(at) ?? 0));
    } else if (held !== null && typeof held === "object") {
      deepest = Math.max(deepest, level + 1);
      for (const [key, item] of Object.entries(held)) {
        pending.push([item, level + 1, join(at, key)]);
      }
    }
  }
  return deepest;
};

/**
 * Refuses a call's part `value` at `pointer`, inside `around` objects
 * of the call, nested deeper than the host takes a call's arguments.
 * After its expressions are checked, whose literals it counts.
 */
const checkCallDepth = (
  walk: Walk,
  value: Value | undefined,
  pointer: string,
  around: number
): void => {
  const most = sealedBuildLimits.callDepth - around;
  if (value !== undefined && nestingOf(walk, value, pointer) > most) {
    problem(
      walk,
      pointer,
      "workflow.arguments_too_deep",
      `Nests deeper than the ${most} objects and lists a call takes here.`,
      "Flatten it: its lists and objects, and those its expressions write."
    );
  }
};

/** Refuses `duration` at `pointer` past what the engine sleeps. */
const checkDuration = (
  walk: Walk,
  duration: Duration | undefined,
  pointer: string
): void => {
  if (
    duration !== undefined &&
    durationMs(duration) > sealedBuildLimits.deadlineMs
  ) {
    problem(
      walk,
      pointer,
      "workflow.duration_too_long",
      "Longer than a year.",
      "Give a duration of at most 365 days (52 weeks)."
    );
  }
};

/**
 * The permission `alias`, at `pointer`, names, if it is of one of
 * `kinds`; `under` says where the step's kind is declared.
 */
const permissionFor = (
  walk: Walk,
  alias: string,
  kinds: readonly Binding["kind"][],
  under: string,
  pointer: string
): Binding | undefined => {
  const binding = Object.hasOwn(walk.bindings, alias)
    ? walk.bindings[alias]
    : undefined;
  if (binding === undefined) {
    problem(
      walk,
      pointer,
      "workflow.unknown_permission",
      `No permission is named \`${alias}\`.`,
      `Declare it under \`permissions.${under}\`, or name one that is.`
    );
    return undefined;
  }
  if (!kinds.includes(binding.kind)) {
    problem(
      walk,
      pointer,
      "workflow.permission_kind",
      `\`${alias}\` is a ${binding.kind} permission; this step calls ${kinds.join(" or ")}.`,
      `Name a permission under \`permissions.${under}\`.`
    );
    return undefined;
  }
  return binding;
};

/** What a workflow that declares no `args` takes: an object of no fields. */
const noArgs: Descriptor = { kind: "object", fields: {} };

/** What a workflow that declares no `returns` ends with: null. */
const noReturns: Descriptor = { kind: "null" };

/** Why a descriptor was refused, as `descriptorFromCompact` said it. */
const schemaProblemOf = (
  error: CompactDescriptorError
): { code: SchemaProblemCode; remedy: string } => {
  if (
    error.code === "definition.invalid_default" ||
    error.code === "definition.default_with_optional"
  ) {
    return {
      code: "schema.invalid_default",
      remedy: "Give a default the schema itself accepts.",
    };
  }
  if (error.code === "definition.too_large") {
    return {
      code: "schema.too_large",
      remedy: "Nest it less deep, or declare less: split it up.",
    };
  }
  return {
    code: "schema.invalid",
    remedy:
      'Write it as `v` declares it, e.g. `{ "kind": "string", "max": 200 }` for `v.string().max(200)`.',
  };
};

/** `descriptor` at `pointer` as the SDK's schema, or its problem reported. */
const compiledSchema = (
  walk: Walk,
  descriptor: Descriptor,
  pointer: string
): ValueSchema<unknown, unknown> | undefined => {
  try {
    return schemaFromDescriptor(
      JSON.stringify(descriptorFromCompact(descriptor))
    );
  } catch (error) {
    if (!(error instanceof CompactDescriptorError)) {
      throw error;
    }
    const { code, remedy } = schemaProblemOf(error);
    problem(walk, join(pointer, ...error.path), code, error.message, remedy);
    return undefined;
  }
};

const checkSchema = (
  walk: Walk,
  descriptor: Descriptor,
  pointer: string
): ValueDescriptor | undefined =>
  compiledSchema(walk, descriptor, pointer)?.descriptor;

/** Whether `value` holds no expression anywhere: JSON as written. */
const isLiteral = (value: Value): value is Json => {
  if (value === null || typeof value !== "object") {
    return true;
  }
  if (isExpression(value)) {
    return false;
  }
  const items: readonly Value[] = isValueList(value)
    ? value
    : Object.values(value);
  return items.every(isLiteral);
};

/**
 * Why `value`, a literal, isn't of `schema`, if it isn't: the first issue
 * the SDK's validator finds, where in the value it is.
 */
const unfitOf = (
  schema: ValueSchema<unknown, unknown>,
  value: Json
): string | undefined => {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise || result.issues === undefined) {
    return undefined;
  }
  const [issue] = result.issues;
  const path = (issue?.path ?? []).join(".");
  return `${path === "" ? "" : `\`${path}\`: `}${issue?.message ?? "not of its schema"}`;
};

/**
 * Checks what a step keeps in its state: each value where the step
 * stands, its own result in scope as `output`.
 */
const checkState = (
  walk: Walk,
  state: StateWrites | undefined,
  pointer: string,
  place: Place
): void => {
  for (const [key, value] of Object.entries(state ?? {})) {
    const at = join(pointer, "state", key);
    const schema = walk.state.get(key);
    const declared = Object.hasOwn(walk.document.state ?? {}, key);
    if (!declared) {
      problem(
        walk,
        at,
        "workflow.undeclared_state_key",
        `The workflow keeps no \`${key}\` in its state.`,
        "Declare it under the workflow's `state`, with its schema, or write a key that is."
      );
      continue;
    }
    const unfit =
      schema !== undefined && isLiteral(value)
        ? unfitOf(schema, value)
        : undefined;
    if (unfit !== undefined) {
      problem(
        walk,
        at,
        "workflow.state_type",
        `Not of \`${key}\`'s schema: ${unfit}`,
        `Write a value of the schema the workflow's \`state\` declares for \`${key}\`, or change that schema.`
      );
      continue;
    }
    checkValue(walk, value, at, { ...place, output: true }, false);
  }
};

/**
 * A raise's error must be the workflow's own `AppError`: its code in no
 * platform namespace (`connect.*`, `workflow.*`, ...), which a catch reads
 * as the platform's, and its details as large as an `AppError`'s.
 */
const checkRaise = (
  walk: Walk,
  step: Extract<Step, { type: "raise" }>,
  pointer: string
): void => {
  if (!isAppErrorCode(step.error.code)) {
    problem(
      walk,
      join(pointer, "error", "code"),
      "workflow.reserved_error_code",
      "A raise names an error code in one of the platform's namespaces.",
      "Name the workflow's own code, such as `invoice.rejected`."
    );
  }
  const { code, message, details } = step.error;
  const error = JSON.stringify({ message, details });
  const raised = walk.raises.get(code);
  if (raised !== undefined && raised !== error) {
    problem(
      walk,
      join(pointer, "error"),
      "workflow.duplicate",
      `Another raise names \`${code}\` with another message or details: a run that fails with \`${code}\` could be either.`,
      "Give each error its own code, or raise this one with the same message and details."
    );
  }
  walk.raises.set(code, error);
  if (
    details !== undefined &&
    new TextEncoder().encode(JSON.stringify(details)).byteLength >
      appErrorDetailsMaxBytes
  ) {
    problem(
      walk,
      join(pointer, "error", "details"),
      "workflow.details_too_large",
      `An error's details are at most ${appErrorDetailsMaxBytes} bytes.`,
      "Keep only what a catch needs to decide."
    );
  }
};

const checkCall = (
  walk: Walk,
  step: Extract<Step, { type: "call" }>,
  pointer: string,
  place: Place
): void => {
  const connection = "connection" in step;
  if (connection) {
    permissionFor(
      walk,
      step.connection,
      ["connector"],
      "connections",
      join(pointer, "connection")
    );
    const member = step.action
      .split(".")
      .map((part) => memberName(part))
      .join(".");
    const actions =
      walk.members.get(step.connection) ?? new Map<string, string>();
    const other = actions.get(member);
    if (other !== undefined && other !== step.action) {
      problem(
        walk,
        join(pointer, "action"),
        "workflow.duplicate",
        `\`${step.action}\` and \`${other}\` read as the same member of \`${step.connection}\`.`,
        "Call one of them only, or through a connection of its own."
      );
    }
    actions.set(member, step.action);
    walk.members.set(step.connection, actions);
  } else {
    permissionFor(
      walk,
      step.module,
      ["compute", "action"],
      "modules",
      join(pointer, "module")
    );
  }
  checkDuration(walk, step.timeout, join(pointer, "timeout"));
  checkValue(walk, step.args, join(pointer, "args"), place, connection);
  checkCallDepth(walk, step.args, join(pointer, "args"), 0);
  checkState(walk, step.state, pointer, place);
};

const checkGenerate = (
  walk: Walk,
  step: Extract<Step, { type: "generate" }>,
  pointer: string,
  place: Place
): void => {
  if (walk.document.permissions?.ai === undefined) {
    problem(
      walk,
      pointer,
      "workflow.unknown_permission",
      "A generate step asks the workflow's model, and it declares none.",
      "Declare its model under `permissions.ai`."
    );
  }
  checkDuration(walk, step.timeout, join(pointer, "timeout"));
  checkValue(
    walk,
    step.instructions,
    join(pointer, "instructions"),
    place,
    false
  );
  checkValue(walk, step.input, join(pointer, "input"), place, false);
  // A model call sends `{ instructions, input }`: one object around each.
  checkCallDepth(walk, step.instructions, join(pointer, "instructions"), 1);
  checkCallDepth(walk, step.input, join(pointer, "input"), 1);
  const answer = checkSchema(walk, step.returns, join(pointer, "returns"));
  if (answer !== undefined) {
    walk.answers.set(pointer, answer);
  }
  checkState(walk, step.state, pointer, place);
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
  const retries = step.catch.retry !== undefined;
  if (retries && place.retrying) {
    problem(
      walk,
      join(pointer, "catch", "retry"),
      "workflow.retry_nested",
      "A try that retries stands inside another that retries: a failure would have two policies.",
      "Retry in one of them only, the inner or the outer."
    );
  }
  list(step.try, join(pointer, "try"), {
    ...place,
    retrying: place.retrying || retries,
  });
  const caught: Place = { ...place, error: true };
  const at = join(pointer, "catch");
  if (step.catch.when !== undefined) {
    checkExpressionAt(walk, step.catch.when, join(at, "when"), caught);
  }
  if (step.catch.retry !== undefined) {
    checkDuration(walk, step.catch.retry.delay, join(at, "retry", "delay"));
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
    problem(
      walk,
      join(pointer, "id"),
      "workflow.duplicate_id",
      `Two steps are \`${step.id}\`.`,
      "Give each step an ID of its own."
    );
  }
  walk.ids.add(step.id);
  if (step.if !== undefined) {
    checkExpressionAt(walk, step.if, join(pointer, "if"), place);
  }
  switch (step.type) {
    case "call": {
      checkCall(walk, step, pointer, place);
      break;
    }
    case "generate": {
      checkGenerate(walk, step, pointer, place);
      break;
    }
    case "decide": {
      // The schema holds the recipients' and prompt's literals to their
      // shapes; what an expression gives the host holds as it decides.
      permissionFor(
        walk,
        step.decision,
        ["decision"],
        "decisions",
        join(pointer, "decision")
      );
      for (const field of ["recipients", "prompt", "input"] as const) {
        checkValue(walk, step[field], join(pointer, field), place, false);
      }
      checkDuration(walk, step.timeout, join(pointer, "timeout"));
      break;
    }
    case "wait": {
      if ("until" in step) {
        checkExpressionAt(walk, step.until, join(pointer, "until"), place);
      } else {
        checkDuration(walk, step.for, join(pointer, "for"));
      }
      break;
    }
    case "waitForEvent": {
      // Whether its contract admits each type is publication's to check,
      // against the catalog, as every permission's contract is.
      permissionFor(
        walk,
        step.events,
        ["event"],
        "events",
        join(pointer, "events")
      );
      if (step.match !== undefined) {
        checkValue(
          walk,
          step.match.equals,
          join(pointer, "match", "equals"),
          place,
          false
        );
      }
      checkDuration(walk, step.timeout, join(pointer, "timeout"));
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
    case "forEach": {
      checkExpressionAt(walk, step.items, join(pointer, "items"), place);
      const inItem: Place = { ...place, item: true };
      if (step.while !== undefined) {
        checkExpressionAt(walk, step.while, join(pointer, "while"), inItem);
      }
      list(step.do, join(pointer, "do"), inItem);
      break;
    }
    case "raise": {
      checkRaise(walk, step, pointer);
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
    problem(
      walk,
      pointer,
      "workflow.lists_too_deep",
      `Lists nest at most ${formatLimits.depth} deep.`,
      "Move the inner steps out to a list further out."
    );
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
    if (resultStepTypes.has(step.type)) {
      ran.add(step.id);
    }
  }
};

/**
 * Refuses a step whose ID is the name the generated code gives a retrying
 * try's `when` (`<try>Retries`, generate.ts's `retriesOf`): the two would
 * be one name in one scope.
 */
const checkRetryNames = (walk: Walk): void => {
  const taken = new Set(
    eachStep(walk.document.steps).flatMap(({ step }) =>
      step.type === "try" && step.catch.retry?.when !== undefined
        ? [`${step.id}Retries`]
        : []
    )
  );
  for (const { step, pointer } of eachStep(walk.document.steps)) {
    if (taken.has(step.id)) {
      problem(
        walk,
        join(pointer, "id"),
        "workflow.duplicate_id",
        `\`${step.id}\` is the name of a retrying try's \`when\`.`,
        "Give the step another ID."
      );
    }
  }
};

/**
 * Refuses an alias declared under two kinds, and `ai` under any kind but
 * the workflow's one model: each alias is one member of `ctx` and one
 * binding of the run.
 */
const checkAliases = (walk: Walk): void => {
  const permissions = walk.document.permissions ?? {};
  const seen = new Set<string>(permissions.ai === undefined ? [] : [aiAlias]);
  for (const { kind, alias } of aliasedPermissions(permissions)) {
    if (seen.has(alias) || alias === aiAlias) {
      problem(
        walk,
        join("/permissions", kind, alias),
        "workflow.duplicate_alias",
        `\`${alias}\` names another permission already${alias === aiAlias ? ": `ai` is the workflow's model" : ""}.`,
        "Give each permission an alias of its own."
      );
    }
    seen.add(alias);
  }
};

/**
 * Whether `descriptor` holds a value anywhere in it: a default, a literal,
 * an enum's values or a number its bounds pin (`min` equal to `max`), any
 * of which would put a value in the document.
 */
const holdsValue = (descriptor: ValueDescriptor): boolean => {
  const pending = [descriptor];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const pinned =
      next.kind === "number" && next.min !== undefined && next.min === next.max;
    if (
      next.presence === "default" ||
      next.kind === "literal" ||
      next.kind === "enum" ||
      pinned
    ) {
      return true;
    }
    if (next.kind === "object") {
      pending.push(...Object.values(next.fields));
    } else if (next.kind === "array") {
      pending.push(next.item);
    } else if (next.kind === "record") {
      pending.push(next.value);
    } else if (next.kind === "union") {
      pending.push(...next.members);
    }
  }
  return false;
};

/** Checks `json`, a workflow's document as parsed JSON. */
export const checkWorkflow = (json: unknown): CheckResult => {
  const shape = shapeProblems(json);
  if (shape.length > 0) {
    return { ok: false, problems: shape.slice(0, maxProblems) };
  }
  // SAFETY: the format's JSON Schema, which describes WorkflowDocument,
  // accepted it whole.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const document = json as WorkflowDocument;
  const params = document.params ?? {};
  const ids = eachStep(document.steps).map(({ step }) => step.id);
  const walk: Walk = {
    document,
    bindings: bindingsOf(document),
    stepIds: [...new Set(ids)],
    resultSteps: new Set(
      eachStep(document.steps).flatMap(({ step }) =>
        resultStepTypes.has(step.type) ? [step.id] : []
      )
    ),
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
    raises: new Map(),
    members: new Map(),
    problems: [],
    code: new Map(),
    placeholders: new Map(),
    answers: new Map(),
    literals: new Map(),
    roots: new Set(),
    state: new Map(),
    count: 0,
  };
  const paramDescriptors = new Map<string, ValueDescriptor>();
  for (const [name, param] of Object.entries(params)) {
    const descriptor = checkSchema(
      walk,
      param.type,
      join("/params", name, "type")
    );
    if (
      descriptor !== undefined &&
      isSensitive(param) &&
      holdsValue(descriptor)
    ) {
      problem(
        walk,
        join("/params", name, "type"),
        "workflow.sensitive",
        "A sensitive parameter's type holds a value: a default, a literal or an enum's values.",
        "Leave its type without a default, a literal or an enum, so its value is set only where parameter values are kept; or declare it with `sensitive: false`."
      );
    } else if (descriptor !== undefined) {
      paramDescriptors.set(name, descriptor);
    }
  }
  checkAliases(walk);
  checkRetryNames(walk);
  const args = checkSchema(walk, document.args ?? noArgs, "/args");
  for (const [key, schema] of Object.entries(document.state ?? {})) {
    const compiled = compiledSchema(walk, schema, join("/state", key));
    if (compiled !== undefined) {
      walk.state.set(key, compiled);
    }
  }
  const top: Place = {
    steps: new Set(),
    error: false,
    item: false,
    output: false,
    retrying: false,
  };
  checkSteps(walk, document.steps, "/steps", top, 1);
  if (walk.count > formatLimits.steps) {
    problem(
      walk,
      "/steps",
      "workflow.too_many_steps",
      `A workflow has at most ${formatLimits.steps} steps in all.`,
      "Split it into workflows of their own."
    );
  }
  const returns = checkSchema(
    walk,
    document.returns ?? noReturns,
    document.returns === undefined ? "" : "/returns"
  );
  if (document.result !== undefined) {
    checkValue(
      walk,
      document.result,
      "/result",
      {
        steps: new Set(
          document.steps.flatMap(({ id, type }) =>
            resultStepTypes.has(type) ? [id] : []
          )
        ),
        error: false,
        item: false,
        output: false,
        retrying: false,
      },
      false
    );
  }
  if (walk.code.size > sealedBuildLimits.expressions) {
    problem(
      walk,
      "",
      "workflow.too_many_expressions",
      `A workflow has at most ${sealedBuildLimits.expressions} expressions in all.`,
      "Compute a list in one expression rather than each of its items."
    );
  }
  if (walk.problems.length > 0 || args === undefined || returns === undefined) {
    return { ok: false, problems: walk.problems.slice(0, maxProblems) };
  }
  return {
    ok: true,
    workflow: {
      document,
      code: walk.code,
      placeholders: walk.placeholders,
      answers: walk.answers,
      contract: { args, returns, params: paramDescriptors },
      state: new Map(
        [...walk.state].map(([key, schema]) => [key, schema.descriptor])
      ),
      roots: walk.roots,
    },
  };
};

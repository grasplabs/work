/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { ValueSchema } from "@grasp-os/sdk";
import type { Stage } from "@grasp-os/workflow-expressions/evaluate";
import { parseSlot } from "@grasp-os/workflow-expressions/source";

import type { BindingKind } from "./catalog.ts";
import { member, taskIdOf } from "./checker.ts";
import type {
  Binding,
  Checker,
  ListRecord,
  Site,
  TaskRecord,
  Transition,
} from "./checker.ts";
import { compileSchemaEnvelope } from "./data-schema.ts";
import { pointerJoin } from "./diagnostics.ts";
import { isObject } from "./json-text.ts";
import type { JsonObject, JsonValue } from "./json-text.ts";
import { profileLimits } from "./limits.ts";
import {
  allowKeys,
  at,
  dataValue,
  durationAt,
  expressionOnly,
  literalText,
  objectAt,
  requireKey,
  textAt,
} from "./values.ts";

/**
 * The task kinds of the profile and the walk over a task list. Each task
 * is checked against its upstream shape narrowed to the profile; what it
 * holds that runs (expressions) is recorded for compilation, and what it
 * names (bindings, functions, errors, transitions) for the checks that
 * need the whole definition.
 */

const baseKeys = [
  "if",
  "input",
  "output",
  "export",
  "timeout",
  "then",
  "metadata",
];
const kindKeys: Readonly<Record<string, readonly string[]>> = {
  call: ["call", "with"],
  do: ["do"],
  emit: ["emit"],
  for: ["for", "while", "do"],
  fork: ["fork"],
  listen: ["listen"],
  raise: ["raise"],
  run: ["run"],
  set: ["set"],
  switch: ["switch"],
  try: ["try", "catch"],
  wait: ["wait"],
};
const kinds = Object.keys(kindKeys);

const taskIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const maxTaskIdLength = 64;
/** IDs a `then` can't name: they are flow directives. */
const directives = new Set(["continue", "exit", "end"]);

/** Names a loop or a catch binds: jq identifiers, never a workflow variable. */
const variablePattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const reservedVariables = new Set([
  "context",
  "input",
  "output",
  "task",
  "workflow",
  "runtime",
  "params",
  "secrets",
  "authorization",
  "ENV",
  "ARGS",
]);

/** Named calls of the profile and the `with` fields each takes. */
const namedCalls: Readonly<
  Record<string, { required: readonly string[]; optional: readonly string[] }>
> = {
  "grasp.operation": { required: ["binding", "arguments"], optional: [] },
  "grasp.connector": {
    required: ["binding", "operation", "arguments"],
    optional: [],
  },
  "grasp.model": {
    required: ["binding", "instructions", "input", "outputSchema"],
    optional: ["model", "maxOutputTokens"],
  },
  "grasp.compute": { required: ["binding", "arguments"], optional: [] },
  "grasp.decision": {
    required: ["binding", "recipients", "prompt", "input"],
    optional: [],
  },
  "grasp.now": { required: [], optional: [] },
  "grasp.random": { required: [], optional: [] },
  "grasp.sleepUntil": { required: ["timestamp"], optional: [] },
};
/** Upstream's protocol calls, none of which the profile has. */
const protocolCalls = new Set([
  "http",
  "grpc",
  "openapi",
  "asyncapi",
  "a2a",
  "mcp",
]);

/** CloudEvents attributes an emit sets; the host sets id and time. */
const emitAttributes = [
  "type",
  "source",
  "subject",
  "data",
  "datacontenttype",
  "dataschema",
];
/** CloudEvents attributes a listen filters on. */
const filterAttributes = [
  "type",
  "source",
  "subject",
  "id",
  "datacontenttype",
  "dataschema",
];
const maxEventFilters = 16;
const maxCorrelations = 16;

/** Upstream error types are the host's categories: a raise can't claim one. */
const hostErrorPrefixes = [
  "https://open-workflow-specification.org/spec/",
  "https://serverlessworkflow.io/spec/",
];
const uriPattern = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u;
const maxUriLength = 512;
/** Authentication and authorization are the host's to decide. */
const hostStatuses = new Set([401, 403]);

export const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+(?:[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/u;
export const namePattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u;

const taskDefinition: Stage = "taskDefinition";

const schemaAt = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): ValueSchema<unknown, unknown> | undefined => {
  const compiled = compileSchemaEnvelope(value, pointer);
  if (!compiled.ok) {
    for (const problem of compiled.problems) {
      checker.report.error(
        problem.code,
        at(site, problem.pointer),
        problem.remedy,
        {
          ...(problem.expected === undefined
            ? {}
            : { expected: problem.expected }),
          ...(problem.reason === undefined ? {} : { reason: problem.reason }),
        }
      );
    }
    return undefined;
  }
  checker.schemas.set(pointer, compiled.schema);
  return compiled.schema;
};

/** Upstream `input`, `output` or `export`: a schema and a transformation. */
export const checkDataFlow = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  transform: "from" | "as",
  stage: Stage,
  schemaRequired = false
): ValueSchema<unknown, unknown> | undefined => {
  const object = objectAt(checker, value, pointer, site, "it");
  if (object === undefined) {
    return undefined;
  }
  allowKeys(checker, object, ["schema", transform], pointer, site);
  let schema: ValueSchema<unknown, unknown> | undefined;
  if (Object.hasOwn(object, "schema")) {
    schema = schemaAt(
      checker,
      object.schema,
      pointerJoin(pointer, "schema"),
      site
    );
  } else if (schemaRequired) {
    requireKey(checker, object, "schema", pointer, site);
  }
  const transformation = member(object, transform);
  const transformPointer = pointerJoin(pointer, transform);
  if (typeof transformation === "string") {
    expressionOnly(checker, transformation, transformPointer, stage, site);
  } else if (isObject(transformation)) {
    dataValue(checker, transformation, transformPointer, stage, site);
  } else if (transformation !== undefined) {
    checker.report.error(
      "profile.invalid_value",
      at(site, transformPointer),
      "Write the transformation as ${ … } or an object of values.",
      { expected: "expression or object" }
    );
  }
  return schema;
};

const recordTransition = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): Transition | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      "Write the transition as continue, exit, end or the ID of a later task.",
      { expected: "flow directive" }
    );
    return undefined;
  }
  return { target: value, pointer };
};

/** A timeout: `{ after: duration }`, literal, or a reusable timeout's name. */
export const checkTimeout = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): void => {
  if (typeof value === "string") {
    if (!checker.reusableTimeouts.has(value)) {
      checker.report.error(
        "profile.invalid_value",
        at(site, pointer),
        "Name a timeout declared in use.timeouts.",
        { reason: "unknown timeout" }
      );
    }
    return;
  }
  const object = objectAt(checker, value, pointer, site, "a timeout");
  if (object === undefined) {
    return;
  }
  allowKeys(checker, object, ["after"], pointer, site);
  if (requireKey(checker, object, "after", pointer, site)) {
    durationAt(checker, object.after, pointerJoin(pointer, "after"), site);
  }
};

const variableAt = (
  checker: Checker,
  value: JsonValue | undefined,
  fallback: string,
  pointer: string,
  site: Site,
  taken: readonly string[],
  owner: { pointer: string; keys: string }
): string => {
  if (value === undefined && taken.includes(fallback)) {
    // The default clashes: point at the loop or catch, where the name goes.
    checker.report.error(
      "profile.invalid_value",
      at(site, owner.pointer),
      `Name this one's variables with ${owner.keys}: the default ${fallback} is already used by an enclosing loop or catch.`
    );
    return fallback;
  }
  const name = value === undefined ? fallback : value;
  const valid =
    typeof name === "string" &&
    variablePattern.test(name) &&
    !reservedVariables.has(name) &&
    !name.startsWith("__") &&
    !taken.includes(name);
  if (!valid) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      "Name the variable as a plain identifier that no enclosing loop or catch uses and that isn't a workflow variable."
    );
  }
  return typeof name === "string" ? name : fallback;
};

const bindingFor = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  kind: BindingKind
): Binding | undefined => {
  const alias = literalText(checker, value, pointer, site, 64);
  if (alias === undefined) {
    return undefined;
  }
  const binding = checker.bindings.get(alias);
  if (binding === undefined) {
    checker.report.error(
      "binding.unknown",
      at(site, pointer),
      "Use an alias declared in document.metadata.grasp.bindings.",
      { expected: `a ${kind} binding` }
    );
    return undefined;
  }
  binding.referenced = true;
  if (binding.kind !== kind) {
    checker.report.error(
      "binding.wrong_kind",
      at(site, pointer),
      `Use a binding of kind ${kind} here.`,
      { expected: kind }
    );
    return undefined;
  }
  return binding;
};

const maxArgumentIssues = 5;

/**
 * What can be proven about arguments before a run: wholly literal ones are
 * checked by the contract's own schema; an object with expressions in it
 * still has to name the contract's fields and every required one.
 */
const checkArguments = (
  checker: Checker,
  value: JsonValue | undefined,
  hasExpression: boolean,
  schema: ValueSchema<unknown, unknown> | undefined,
  pointer: string,
  site: Site
): void => {
  if (schema === undefined) {
    return;
  }
  if (!hasExpression) {
    const result = schema["~standard"].validate(value);
    for (const issue of result.issues?.slice(0, maxArgumentIssues) ?? []) {
      let issuePointer = pointer;
      for (const step of issue.path) {
        issuePointer = pointerJoin(issuePointer, step);
      }
      checker.report.error(
        "call.invalid_arguments",
        at(site, issuePointer),
        "Pass what the binding's contract accepts.",
        { reason: issue.code }
      );
    }
    return;
  }
  const { descriptor } = schema;
  if (!isObject(value) || descriptor.kind !== "object") {
    return;
  }
  const { fields } = descriptor;
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) {
      checker.report.error(
        "call.invalid_arguments",
        at(site, pointerJoin(pointer, key)),
        "Pass only the fields the binding's contract declares.",
        { reason: "value.unknown_key" }
      );
    }
  }
  for (const [key, field] of Object.entries(fields)) {
    if (field.presence === "required" && !Object.hasOwn(value, key)) {
      checker.report.error(
        "call.invalid_arguments",
        at(site, pointer),
        `Pass ${key}: the binding's contract requires it.`,
        { reason: "value.required" }
      );
    }
  }
};

/** A string place that may also be `${ … }`. */
const textOrExpression = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  limit: number
): void => {
  if (typeof value === "string" && parseSlot(value).kind === "expression") {
    dataValue(checker, value, pointer, taskDefinition, site);
    return;
  }
  textAt(checker, value, pointer, site, limit);
};

/** A whole-number place that may also be `${ … }`. */
const integerOrExpression = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  minimum: number
): void => {
  if (typeof value === "string") {
    expressionOnly(checker, value, pointer, taskDefinition, site, "number");
    return;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      `Give a whole number of at least ${minimum}, or an expression.`,
      { expected: "safe integer" }
    );
  }
};

/** A named call's `with`, as its handler reads it. */
interface CallArgs {
  checker: Checker;
  site: Site;
  /** A field's value and its pointer. */
  field: (key: string) => [JsonValue | undefined, string];
  /** Walks a field as data; whether it held an expression. */
  data: (key: string) => boolean;
}

const callBinding = (
  args: CallArgs,
  kind: BindingKind
): Binding | undefined => {
  const [value, pointer] = args.field("binding");
  return bindingFor(args.checker, value, pointer, args.site, kind);
};

/** `arguments` (or `input`), checked against `schema` where provable. */
const callData = (
  args: CallArgs,
  key: string,
  schema: ValueSchema<unknown, unknown> | undefined
): void => {
  const [value, pointer] = args.field(key);
  const hasExpression = args.data(key);
  checkArguments(
    args.checker,
    value,
    hasExpression,
    schema,
    pointer,
    args.site
  );
};

const checkConnectorCall = (args: CallArgs): void => {
  const { checker, site } = args;
  const binding = callBinding(args, "connector");
  const [operationValue, operationPointer] = args.field("operation");
  const operation = literalText(
    checker,
    operationValue,
    operationPointer,
    site,
    256
  );
  const operations = binding?.contract?.operations;
  const contract =
    operation === undefined ? undefined : operations?.get(operation);
  if (
    operation !== undefined &&
    operations !== undefined &&
    contract === undefined
  ) {
    checker.report.error(
      "binding.contract_mismatch",
      at(site, operationPointer),
      "Name an operation the connector binding allows.",
      { expected: [...operations.keys()].slice(0, 20).join(", ") }
    );
  }
  callData(args, "arguments", contract?.input);
};

const checkModelCall = (args: CallArgs): void => {
  const { checker, site } = args;
  callBinding(args, "model");
  const [instructions, instructionsPointer] = args.field("instructions");
  textOrExpression(checker, instructions, instructionsPointer, site, 100_000);
  args.data("input");
  // Literal: the model's structured output is never chosen by an expression.
  const [outputSchema, outputSchemaPointer] = args.field("outputSchema");
  schemaAt(checker, outputSchema, outputSchemaPointer, site);
  const [model, modelPointer] = args.field("model");
  if (model !== undefined) {
    textOrExpression(checker, model, modelPointer, site, 256);
  }
  const [tokens, tokensPointer] = args.field("maxOutputTokens");
  if (tokens !== undefined) {
    integerOrExpression(checker, tokens, tokensPointer, site, 1);
  }
};

const checkDecisionCall = (args: CallArgs): void => {
  const { checker, site } = args;
  const binding = callBinding(args, "decision");
  const [recipients, recipientsPointer] = args.field("recipients");
  if (typeof recipients === "string") {
    expressionOnly(
      checker,
      recipients,
      recipientsPointer,
      taskDefinition,
      site,
      "array"
    );
  } else if (Array.isArray(recipients) && recipients.length > 0) {
    args.data("recipients");
  } else {
    checker.report.error(
      "profile.invalid_value",
      at(site, recipientsPointer),
      "List at least one recipient, or select them with an expression.",
      { expected: "array" }
    );
  }
  const [prompt, promptPointer] = args.field("prompt");
  textOrExpression(checker, prompt, promptPointer, site, 10_000);
  callData(args, "input", binding?.contract?.input);
};

/** What each named call checks in its `with`. */
const callHandlers: Readonly<Record<string, (args: CallArgs) => void>> = {
  "grasp.operation": (args) => {
    callData(
      args,
      "arguments",
      callBinding(args, "operation")?.contract?.input
    );
  },
  "grasp.compute": (args) => {
    callData(args, "arguments", callBinding(args, "compute")?.contract?.input);
  },
  "grasp.connector": checkConnectorCall,
  "grasp.model": checkModelCall,
  "grasp.decision": checkDecisionCall,
  // An absolute time in milliseconds.
  "grasp.sleepUntil": (args) => {
    const [timestamp, pointer] = args.field("timestamp");
    integerOrExpression(args.checker, timestamp, pointer, args.site, 0);
  },
};

const callWith = (
  checker: Checker,
  task: JsonObject,
  call: string,
  pointer: string,
  site: Site
): void => {
  const fields = namedCalls[call];
  const withPointer = pointerJoin(pointer, "with");
  if (fields === undefined) {
    return;
  }
  const withValue = member(task, "with");
  if (fields.required.length === 0) {
    const empty = isObject(withValue) && Object.keys(withValue).length === 0;
    if (withValue !== undefined && !empty) {
      checker.report.error(
        "profile.invalid_value",
        at(site, withPointer),
        `${call} takes no arguments: leave with out, or {}.`
      );
    }
    return;
  }
  if (!requireKey(checker, task, "with", pointer, site)) {
    return;
  }
  const args = objectAt(checker, withValue, withPointer, site, "with");
  if (args === undefined) {
    return;
  }
  allowKeys(
    checker,
    args,
    [...fields.required, ...fields.optional],
    withPointer,
    site
  );
  for (const key of fields.required) {
    requireKey(checker, args, key, withPointer, site);
  }
  const field = (key: string): [JsonValue | undefined, string] => [
    member(args, key),
    pointerJoin(withPointer, key),
  ];
  callHandlers[call]?.({
    checker,
    site,
    field,
    data: (key) => {
      const [value, valuePointer] = field(key);
      return dataValue(checker, value, valuePointer, taskDefinition, site);
    },
  });
};

const checkCall = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site
): void => {
  const callPointer = pointerJoin(pointer, "call");
  const call = literalText(
    checker,
    member(task, "call"),
    callPointer,
    site,
    128
  );
  if (call === undefined) {
    return;
  }
  if (checker.functions.has(call)) {
    if (Object.hasOwn(task, "with")) {
      checker.report.error(
        "profile.unknown_property",
        at(site, pointerJoin(pointer, "with")),
        "A reusable function takes its input from the task's input: shape it with input.from."
      );
    }
    checker.functionCalls.push({
      from: site.inFunction,
      to: call,
      pointer: callPointer,
      taskId: taskIdOf(site) ?? "",
      depth: site.scope.length,
    });
    return;
  }
  if (!Object.hasOwn(namedCalls, call)) {
    checker.report.error(
      "call.unsupported",
      at(site, callPointer),
      protocolCalls.has(call)
        ? "Raw protocol calls aren't available: call an approved connector with grasp.connector."
        : "Use a named Grasp call (grasp.operation, grasp.connector, grasp.model, grasp.compute, grasp.decision, grasp.now, grasp.random, grasp.sleepUntil) or a function in use.functions.",
      { reason: protocolCalls.has(call) ? "protocol call" : "unknown call" }
    );
    return;
  }
  callWith(checker, task, call, pointer, site);
};

/** A reusable or raised error: literal throughout, host types refused. */
export const checkErrorDefinition = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): void => {
  const error = objectAt(checker, value, pointer, site, "the error");
  if (error === undefined) {
    return;
  }
  allowKeys(
    checker,
    error,
    ["type", "status", "title", "detail"],
    pointer,
    site,
    {
      instance: "Leave instance out: the host sets it to the raising task.",
    }
  );
  if (requireKey(checker, error, "type", pointer, site)) {
    const typePointer = pointerJoin(pointer, "type");
    const type = literalText(
      checker,
      error.type,
      typePointer,
      site,
      maxUriLength
    );
    if (type !== undefined && !uriPattern.test(type)) {
      checker.report.error(
        "profile.invalid_value",
        at(site, typePointer),
        "Give the error type as a URI.",
        {
          expected: "URI",
        }
      );
    } else if (
      type !== undefined &&
      hostErrorPrefixes.some((prefix) => type.startsWith(prefix))
    ) {
      checker.report.error(
        "profile.invalid_value",
        at(site, typePointer),
        "Use a domain error type: the standard error types are the host's to raise.",
        { reason: "host error type" }
      );
    }
  }
  if (requireKey(checker, error, "status", pointer, site)) {
    const { status } = error;
    const statusPointer = pointerJoin(pointer, "status");
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 400 ||
      status > 599
    ) {
      checker.report.error(
        "profile.invalid_value",
        at(site, statusPointer),
        "Give the status as a literal whole number from 400 to 599.",
        { expected: "400-599" }
      );
    } else if (hostStatuses.has(status)) {
      checker.report.error(
        "profile.invalid_value",
        at(site, statusPointer),
        "Authentication and authorization failures are the host's to raise.",
        { reason: "host status" }
      );
    }
  }
  for (const key of ["title", "detail"]) {
    const text = member(error, key);
    if (text === undefined) {
      continue;
    }
    // Literal, inline or reusable: an error is never built from data.
    literalText(checker, text, pointerJoin(pointer, key), site, 2000);
  }
};

const backoffStrategies = new Set(["constant", "linear", "exponential"]);

const checkBackoff = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): void => {
  const backoff = objectAt(checker, value, pointer, site, "the backoff");
  if (backoff === undefined) {
    return;
  }
  const strategies = Object.keys(backoff);
  const [strategy] = strategies;
  const settings = strategy === undefined ? undefined : backoff[strategy];
  const valid =
    strategies.length === 1 &&
    strategy !== undefined &&
    backoffStrategies.has(strategy) &&
    isObject(settings) &&
    Object.keys(settings).length === 0;
  if (!valid) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      "Choose one backoff: { constant: {} }, { linear: {} } or { exponential: {} }.",
      { expected: "constant, linear or exponential" }
    );
  }
};

/** `limit.attempt.count` (1 to 5, the first attempt included), durations. */
const checkRetryLimit = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): void => {
  const limit = objectAt(checker, value, pointer, site, "the retry limit");
  if (limit === undefined) {
    return;
  }
  allowKeys(checker, limit, ["attempt", "duration"], pointer, site);
  if (Object.hasOwn(limit, "duration")) {
    durationAt(checker, limit.duration, pointerJoin(pointer, "duration"), site);
  }
  if (!requireKey(checker, limit, "attempt", pointer, site)) {
    return;
  }
  const attemptPointer = pointerJoin(pointer, "attempt");
  const attempt = objectAt(
    checker,
    limit.attempt,
    attemptPointer,
    site,
    "the attempt limit"
  );
  if (attempt === undefined) {
    return;
  }
  allowKeys(checker, attempt, ["count", "duration"], attemptPointer, site);
  if (Object.hasOwn(attempt, "duration")) {
    durationAt(
      checker,
      attempt.duration,
      pointerJoin(attemptPointer, "duration"),
      site
    );
  }
  const { count } = attempt;
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > profileLimits.maxRetryAttempts
  ) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointerJoin(attemptPointer, "count")),
      "Allow 1 to 5 attempts, the first included.",
      { expected: "1-5" }
    );
  }
};

const checkJitter = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): void => {
  const jitter = objectAt(checker, value, pointer, site, "the jitter");
  if (jitter === undefined) {
    return;
  }
  allowKeys(checker, jitter, ["from", "to"], pointer, site);
  const bound = (key: "from" | "to"): number | undefined =>
    requireKey(checker, jitter, key, pointer, site)
      ? durationAt(checker, jitter[key], pointerJoin(pointer, key), site)
      : undefined;
  const from = bound("from");
  const to = bound("to");
  if (
    from !== undefined &&
    to !== undefined &&
    (from > to || to > profileLimits.maxJitterMs)
  ) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      "Keep jitter from at most to, and to at most a minute.",
      { expected: "from <= to <= 60s" }
    );
  }
};

/** A retry policy: 1 to 5 attempts, literal durations, checked backoff. */
export const checkRetryPolicy = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): void => {
  const policy = objectAt(checker, value, pointer, site, "the retry policy");
  if (policy === undefined) {
    return;
  }
  allowKeys(
    checker,
    policy,
    ["when", "exceptWhen", "delay", "backoff", "limit", "jitter"],
    pointer,
    site
  );
  for (const key of ["when", "exceptWhen"]) {
    if (Object.hasOwn(policy, key)) {
      expressionOnly(
        checker,
        policy[key],
        pointerJoin(pointer, key),
        taskDefinition,
        site,
        "boolean"
      );
    }
  }
  if (Object.hasOwn(policy, "delay")) {
    durationAt(checker, policy.delay, pointerJoin(pointer, "delay"), site);
  }
  if (Object.hasOwn(policy, "backoff")) {
    checkBackoff(
      checker,
      policy.backoff,
      pointerJoin(pointer, "backoff"),
      site
    );
  }
  if (requireKey(checker, policy, "limit", pointer, site)) {
    checkRetryLimit(checker, policy.limit, pointerJoin(pointer, "limit"), site);
  }
  if (Object.hasOwn(policy, "jitter")) {
    checkJitter(checker, policy.jitter, pointerJoin(pointer, "jitter"), site);
  }
};

interface TaskMetadata {
  binding?: { value: JsonValue | undefined; pointer: string };
}

const metadataUses: Readonly<Record<string, readonly string[]>> = {
  binding: ["emit", "listen", "run"],
  key: ["for"],
  concurrency: ["for", "fork"],
};

const checkMetadata = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  kind: string
): TaskMetadata => {
  const metadata: TaskMetadata = {};
  if (value === undefined) {
    return metadata;
  }
  const object = objectAt(checker, value, pointer, site, "metadata");
  if (object === undefined) {
    return metadata;
  }
  allowKeys(checker, object, ["grasp"], pointer, site);
  const graspPointer = pointerJoin(pointer, "grasp");
  if (!Object.hasOwn(object, "grasp")) {
    return metadata;
  }
  const grasp = objectAt(
    checker,
    object.grasp,
    graspPointer,
    site,
    "metadata.grasp"
  );
  if (grasp === undefined) {
    return metadata;
  }
  const applicable = ["label", "position"];
  for (const [key, uses] of Object.entries(metadataUses)) {
    if (uses.includes(kind)) {
      applicable.push(key);
    }
  }
  allowKeys(checker, grasp, applicable, graspPointer, site);
  if (Object.hasOwn(grasp, "label")) {
    textAt(
      checker,
      grasp.label,
      pointerJoin(graspPointer, "label"),
      site,
      profileLimits.maxTitleLength
    );
  }
  if (Object.hasOwn(grasp, "position")) {
    const positionPointer = pointerJoin(graspPointer, "position");
    const position = objectAt(
      checker,
      grasp.position,
      positionPointer,
      site,
      "position"
    );
    if (position !== undefined) {
      allowKeys(checker, position, ["x", "y"], positionPointer, site);
      for (const axis of ["x", "y"]) {
        const coordinate = member(position, axis);
        if (typeof coordinate !== "number") {
          checker.report.error(
            "profile.invalid_value",
            at(site, pointerJoin(positionPointer, axis)),
            "Give x and y as finite numbers.",
            { expected: "number" }
          );
        }
      }
    }
  }
  if (Object.hasOwn(grasp, "binding") && applicable.includes("binding")) {
    metadata.binding = {
      value: grasp.binding,
      pointer: pointerJoin(graspPointer, "binding"),
    };
  }
  if (
    Object.hasOwn(grasp, "concurrency") &&
    applicable.includes("concurrency")
  ) {
    const { concurrency } = grasp;
    if (
      typeof concurrency !== "number" ||
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > profileLimits.maxConcurrency
    ) {
      checker.report.error(
        "profile.invalid_value",
        at(site, pointerJoin(graspPointer, "concurrency")),
        "Set concurrency to a whole number from 1 to 8.",
        { expected: "1-8" }
      );
    }
  }
  return metadata;
};

const requireBinding = (
  checker: Checker,
  metadata: TaskMetadata,
  pointer: string,
  site: Site,
  kind: BindingKind
): Binding | undefined => {
  if (metadata.binding === undefined) {
    checker.report.error(
      "profile.missing_property",
      at(
        site,
        pointerJoin(
          pointerJoin(pointerJoin(pointer, "metadata"), "grasp"),
          "binding"
        )
      ),
      `Name the ${kind} binding in metadata.grasp.binding.`,
      { expected: `a ${kind} binding` }
    );
    return undefined;
  }
  return bindingFor(
    checker,
    metadata.binding.value,
    metadata.binding.pointer,
    site,
    kind
  );
};

/** An event attribute: literal text or `${ … }`. */
const attributeValue = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): void => {
  textOrExpression(checker, value, pointer, site, 1024);
};

const checkEventType = (
  checker: Checker,
  attributes: JsonObject,
  pointer: string,
  site: Site,
  binding: Binding | undefined
): void => {
  if (!requireKey(checker, attributes, "type", pointer, site)) {
    return;
  }
  const typePointer = pointerJoin(pointer, "type");
  const type = literalText(checker, attributes.type, typePointer, site, 256);
  const admitted = binding?.contract?.eventTypes;
  if (type !== undefined && admitted !== undefined && !admitted.has(type)) {
    checker.report.error(
      "binding.contract_mismatch",
      at(site, typePointer),
      "Use an event type the event binding admits.",
      { expected: [...admitted].slice(0, 20).join(", ") }
    );
  }
};

const checkEmit = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  metadata: TaskMetadata
): void => {
  const binding = requireBinding(checker, metadata, pointer, site, "event");
  const emitPointer = pointerJoin(pointer, "emit");
  const emit = objectAt(checker, task.emit, emitPointer, site, "emit");
  if (emit === undefined) {
    return;
  }
  allowKeys(checker, emit, ["event"], emitPointer, site);
  const eventPointer = pointerJoin(emitPointer, "event");
  if (!requireKey(checker, emit, "event", emitPointer, site)) {
    return;
  }
  const event = objectAt(checker, emit.event, eventPointer, site, "the event");
  if (event === undefined) {
    return;
  }
  allowKeys(checker, event, ["with"], eventPointer, site);
  const withPointer = pointerJoin(eventPointer, "with");
  if (!requireKey(checker, event, "with", eventPointer, site)) {
    return;
  }
  const attributes = objectAt(
    checker,
    event.with,
    withPointer,
    site,
    "the event's attributes"
  );
  if (attributes === undefined) {
    return;
  }
  allowKeys(checker, attributes, emitAttributes, withPointer, site, {
    id: "Leave id out: the host sets it.",
    time: "Leave time out: the host records it.",
  });
  checkEventType(checker, attributes, withPointer, site, binding);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "data") {
      dataValue(
        checker,
        value,
        pointerJoin(withPointer, key),
        taskDefinition,
        site
      );
    } else if (key !== "type" && emitAttributes.includes(key)) {
      attributeValue(checker, value, pointerJoin(withPointer, key), site);
    }
  }
};

const checkEventFilter = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  binding: Binding | undefined
): void => {
  const filter = objectAt(checker, value, pointer, site, "the event filter");
  if (filter === undefined) {
    return;
  }
  allowKeys(checker, filter, ["with", "correlate"], pointer, site);
  const withPointer = pointerJoin(pointer, "with");
  if (requireKey(checker, filter, "with", pointer, site)) {
    const attributes = objectAt(
      checker,
      filter.with,
      withPointer,
      site,
      "the filter's attributes"
    );
    if (attributes !== undefined) {
      allowKeys(checker, attributes, filterAttributes, withPointer, site);
      checkEventType(checker, attributes, withPointer, site, binding);
      for (const [key, attribute] of Object.entries(attributes)) {
        if (key !== "type" && filterAttributes.includes(key)) {
          attributeValue(
            checker,
            attribute,
            pointerJoin(withPointer, key),
            site
          );
        }
      }
    }
  }
  if (!Object.hasOwn(filter, "correlate")) {
    return;
  }
  const correlatePointer = pointerJoin(pointer, "correlate");
  const correlate = objectAt(
    checker,
    filter.correlate,
    correlatePointer,
    site,
    "correlate"
  );
  if (correlate === undefined) {
    return;
  }
  const entries = Object.entries(correlate);
  if (entries.length === 0 || entries.length > maxCorrelations) {
    checker.report.error(
      "profile.invalid_value",
      at(site, correlatePointer),
      `Correlate on 1 to ${maxCorrelations} values.`
    );
  }
  for (const [name, entry] of entries.slice(0, maxCorrelations)) {
    const entryPointer = pointerJoin(correlatePointer, name);
    const correlation = objectAt(
      checker,
      entry,
      entryPointer,
      site,
      "a correlation"
    );
    if (correlation === undefined) {
      continue;
    }
    allowKeys(checker, correlation, ["from", "expect"], entryPointer, site);
    if (requireKey(checker, correlation, "from", entryPointer, site)) {
      expressionOnly(
        checker,
        correlation.from,
        pointerJoin(entryPointer, "from"),
        taskDefinition,
        site
      );
    }
    if (Object.hasOwn(correlation, "expect")) {
      attributeValue(
        checker,
        correlation.expect,
        pointerJoin(entryPointer, "expect"),
        site
      );
    }
  }
};

const checkListen = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  metadata: TaskMetadata
): void => {
  const binding = requireBinding(checker, metadata, pointer, site, "event");
  if (!Object.hasOwn(task, "timeout")) {
    checker.report.error(
      "profile.missing_property",
      at(site, pointerJoin(pointer, "timeout")),
      "Give the listen a timeout: no listener waits forever.",
      { expected: "timeout" }
    );
  }
  const listenPointer = pointerJoin(pointer, "listen");
  const listen = objectAt(checker, task.listen, listenPointer, site, "listen");
  if (listen === undefined) {
    return;
  }
  allowKeys(checker, listen, ["to", "read"], listenPointer, site);
  if (
    Object.hasOwn(listen, "read") &&
    listen.read !== "data" &&
    listen.read !== "envelope"
  ) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointerJoin(listenPointer, "read")),
      "Read the event's data or its envelope; raw transport bytes aren't available.",
      { expected: "data or envelope" }
    );
  }
  const toPointer = pointerJoin(listenPointer, "to");
  if (!requireKey(checker, listen, "to", listenPointer, site)) {
    return;
  }
  const to = objectAt(checker, listen.to, toPointer, site, "to");
  if (to === undefined) {
    return;
  }
  const strategies = Object.keys(to).filter((key) =>
    ["one", "any", "all"].includes(key)
  );
  allowKeys(checker, to, ["one", "any", "all"], toPointer, site, {
    until:
      "Wait for a bounded set of events: until isn't available; use a bounded loop of listens.",
  });
  const [strategy] = strategies;
  if (strategies.length !== 1 || strategy === undefined) {
    checker.report.error(
      "profile.invalid_value",
      at(site, toPointer),
      "Listen to exactly one of one, any or all.",
      { expected: "one, any or all" }
    );
    return;
  }
  const strategyPointer = pointerJoin(toPointer, strategy);
  if (strategy === "one") {
    checkEventFilter(checker, to.one, strategyPointer, site, binding);
    return;
  }
  const filters = member(to, strategy);
  if (
    !Array.isArray(filters) ||
    filters.length === 0 ||
    filters.length > maxEventFilters
  ) {
    checker.report.error(
      "profile.invalid_value",
      at(site, strategyPointer),
      `List 1 to ${maxEventFilters} event filters.`,
      { expected: "nonempty list" }
    );
    return;
  }
  for (const [index, filter] of filters.entries()) {
    checkEventFilter(
      checker,
      filter,
      pointerJoin(strategyPointer, index),
      site,
      binding
    );
  }
};

type WorkflowRef = Partial<Record<"namespace" | "name" | "version", string>>;

/** The literal namespace, name and exact version a run names. */
const workflowRef = (
  checker: Checker,
  workflow: JsonObject,
  pointer: string,
  site: Site
): WorkflowRef => {
  const named: WorkflowRef = {};
  for (const key of ["namespace", "name", "version"] as const) {
    if (!requireKey(checker, workflow, key, pointer, site)) {
      continue;
    }
    const keyPointer = pointerJoin(pointer, key);
    const value = literalText(checker, workflow[key], keyPointer, site, 256);
    const isVersion = key === "version";
    if (
      value !== undefined &&
      !(isVersion ? semverPattern : namePattern).test(value)
    ) {
      checker.report.error(
        "profile.invalid_value",
        at(site, keyPointer),
        isVersion
          ? "Pin an exact semantic version: latest is never selected."
          : "Use the workflow's exact name.",
        { expected: isVersion ? "semantic version" : "name" }
      );
    }
    if (value !== undefined) {
      named[key] = value;
    }
  }
  return named;
};

/** The run names exactly what its binding pins, and not this workflow. */
const checkPinned = (
  checker: Checker,
  named: WorkflowRef,
  pinned: { namespace: string; name: string; version: string },
  pointer: string,
  site: Site
): void => {
  for (const key of ["namespace", "name", "version"] as const) {
    const value = named[key];
    if (value !== undefined && value !== pinned[key]) {
      checker.report.error(
        "binding.contract_mismatch",
        at(site, pointerJoin(pointer, key)),
        "Run exactly the workflow the binding pins.",
        { expected: `${pinned.namespace}/${pinned.name}/${pinned.version}` }
      );
    }
  }
  const { identity } = checker;
  const self =
    identity !== undefined &&
    pinned.namespace === identity.namespace &&
    pinned.name === identity.name &&
    pinned.version === identity.version;
  if (self) {
    checker.report.error(
      "flow.cycle",
      at(site, pointer),
      "A workflow can't run itself as its own child."
    );
  }
};

const runProcesses =
  "Only run.workflow is available: containers, scripts and shells aren't.";

const checkRun = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  metadata: TaskMetadata
): void => {
  const binding = requireBinding(checker, metadata, pointer, site, "workflow");
  const runPointer = pointerJoin(pointer, "run");
  const run = objectAt(checker, task.run, runPointer, site, "run");
  if (run === undefined) {
    return;
  }
  allowKeys(checker, run, ["workflow", "await"], runPointer, site, {
    container: runProcesses,
    script: runProcesses,
    shell: runProcesses,
    return: "Leave return out: a child workflow returns its output.",
  });
  if (Object.hasOwn(run, "await") && run.await !== true) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointerJoin(runPointer, "await")),
      "A child workflow is always awaited: no detached children.",
      { expected: "true" }
    );
  }
  if (!requireKey(checker, run, "workflow", runPointer, site)) {
    return;
  }
  const workflowPointer = pointerJoin(runPointer, "workflow");
  const workflow = objectAt(
    checker,
    run.workflow,
    workflowPointer,
    site,
    "the workflow"
  );
  if (workflow === undefined) {
    return;
  }
  allowKeys(
    checker,
    workflow,
    ["namespace", "name", "version", "input"],
    workflowPointer,
    site
  );
  const named = workflowRef(checker, workflow, workflowPointer, site);
  const pinned = binding?.contract?.workflow;
  if (pinned !== undefined) {
    checkPinned(checker, named, pinned, workflowPointer, site);
  }
  if (!Object.hasOwn(workflow, "input")) {
    return;
  }
  const inputPointer = pointerJoin(workflowPointer, "input");
  const input = objectAt(
    checker,
    workflow.input,
    inputPointer,
    site,
    "the child's input"
  );
  if (input !== undefined) {
    const hasExpression = dataValue(
      checker,
      input,
      inputPointer,
      taskDefinition,
      site
    );
    checkArguments(
      checker,
      input,
      hasExpression,
      binding?.contract?.input,
      inputPointer,
      site
    );
  }
};

const checkSet = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site
): void => {
  const setPointer = pointerJoin(pointer, "set");
  const { set } = task;
  if (typeof set === "string") {
    expressionOnly(checker, set, setPointer, taskDefinition, site);
    return;
  }
  if (!isObject(set) || Object.keys(set).length === 0) {
    checker.report.error(
      "profile.invalid_value",
      at(site, setPointer),
      "Set an object with at least one member, or ${ … }.",
      { expected: "object or expression" }
    );
    return;
  }
  dataValue(checker, set, setPointer, taskDefinition, site);
};

const checkSwitch = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  record: TaskRecord
): void => {
  const switchPointer = pointerJoin(pointer, "switch");
  const cases = task.switch;
  // A skipped switch would fall into its next sibling, usually one of its
  // own branches: the condition belongs in a case.
  if (Object.hasOwn(task, "if")) {
    checker.report.error(
      "flow.not_allowed",
      at(site, pointerJoin(pointer, "if")),
      "Put the condition in a case's when; a switch has no if."
    );
  }
  if (Object.hasOwn(task, "then")) {
    checker.report.error(
      "flow.not_allowed",
      at(site, pointerJoin(pointer, "then")),
      "A switch moves on through its cases' then; leave then off the switch."
    );
  }
  if (
    !Array.isArray(cases) ||
    cases.length === 0 ||
    cases.length > profileLimits.maxSwitchCases
  ) {
    checker.report.error(
      "profile.invalid_value",
      at(site, switchPointer),
      `List 1 to ${profileLimits.maxSwitchCases} cases.`,
      { expected: "nonempty list" }
    );
    return;
  }
  record.cases = [];
  const names = new Set<string>();
  for (const [index, item] of cases.entries()) {
    const itemPointer = pointerJoin(switchPointer, index);
    const entries = isObject(item) ? Object.entries(item) : [];
    const [entry] = entries;
    if (entries.length !== 1 || entry === undefined) {
      checker.report.error(
        "task.not_single_key",
        at(site, itemPointer),
        "Write each case as { name: { when, then } }."
      );
      continue;
    }
    const [name, body] = entry;
    const casePointer = pointerJoin(itemPointer, name);
    if (name.length === 0 || name.length > maxTaskIdLength || names.has(name)) {
      checker.report.error(
        "profile.invalid_value",
        at(site, casePointer),
        "Give each case a distinct name of 1 to 64 characters."
      );
    }
    names.add(name);
    const caseObject = objectAt(checker, body, casePointer, site, "the case");
    if (caseObject === undefined) {
      continue;
    }
    allowKeys(checker, caseObject, ["when", "then"], casePointer, site);
    const hasWhen = Object.hasOwn(caseObject, "when");
    if (hasWhen) {
      expressionOnly(
        checker,
        caseObject.when,
        pointerJoin(casePointer, "when"),
        taskDefinition,
        site,
        "boolean"
      );
    }
    if (!requireKey(checker, caseObject, "then", casePointer, site)) {
      continue;
    }
    const then = recordTransition(
      checker,
      caseObject.then,
      pointerJoin(casePointer, "then"),
      site
    );
    if (then !== undefined) {
      record.cases.push({
        name,
        when: hasWhen,
        next: then,
        pointer: casePointer,
      });
    }
  }
  const defaults = record.cases.filter((switchCase) => !switchCase.when);
  const last = record.cases.at(-1);
  if (defaults.length !== 1 || last === undefined || last.when) {
    checker.report.error(
      "flow.switch_default",
      at(site, switchPointer),
      "End the switch with exactly one case that has no when.",
      { expected: "one last default case" }
    );
  }
};

/** Everything a task's walk needs to recurse into its task lists. */
type ListWalker = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  namedTransitions: boolean
) => void;

const checkFor = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  walkList: ListWalker
): void => {
  const forPointer = pointerJoin(pointer, "for");
  const loop = objectAt(checker, task.for, forPointer, site, "for");
  const taken = [...site.loopVariables, ...site.errorVariables];
  let each = "item";
  let index = "index";
  if (loop !== undefined) {
    allowKeys(checker, loop, ["each", "in", "at"], forPointer, site);
    each = variableAt(
      checker,
      member(loop, "each"),
      "item",
      pointerJoin(forPointer, "each"),
      site,
      taken,
      { pointer: forPointer, keys: "for.each and for.at" }
    );
    index = variableAt(
      checker,
      member(loop, "at"),
      "index",
      pointerJoin(forPointer, "at"),
      site,
      [...taken, each],
      { pointer: forPointer, keys: "for.each and for.at" }
    );
    const inPointer = pointerJoin(forPointer, "in");
    if (requireKey(checker, loop, "in", forPointer, site)) {
      const collection = loop.in;
      if (Array.isArray(collection)) {
        if (collection.length > profileLimits.maxInlineItems) {
          checker.report.error(
            "profile.too_many",
            at(site, inPointer),
            `List at most ${profileLimits.maxInlineItems} items inline.`
          );
        }
        dataValue(checker, collection, inPointer, taskDefinition, site);
      } else {
        expressionOnly(
          checker,
          collection,
          inPointer,
          taskDefinition,
          site,
          "array"
        );
      }
    }
  }
  const inner: Site = {
    ...site,
    loopVariables: [...site.loopVariables, each, index],
  };
  if (Object.hasOwn(task, "while")) {
    expressionOnly(
      checker,
      task.while,
      pointerJoin(pointer, "while"),
      taskDefinition,
      inner,
      "boolean"
    );
  }
  const grasp =
    isObject(task.metadata) && isObject(task.metadata.grasp)
      ? task.metadata.grasp
      : undefined;
  if (grasp !== undefined && Object.hasOwn(grasp, "key")) {
    expressionOnly(
      checker,
      grasp.key,
      pointerJoin(
        pointerJoin(pointerJoin(pointer, "metadata"), "grasp"),
        "key"
      ),
      taskDefinition,
      inner
    );
  }
  if (requireKey(checker, task, "do", pointer, site)) {
    walkList(checker, task.do, pointerJoin(pointer, "do"), inner, true);
  }
};

const checkFork = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  walkList: ListWalker
): void => {
  const forkPointer = pointerJoin(pointer, "fork");
  const fork = objectAt(checker, task.fork, forkPointer, site, "fork");
  if (fork === undefined) {
    return;
  }
  allowKeys(checker, fork, ["branches", "compete"], forkPointer, site);
  if (Object.hasOwn(fork, "compete") && typeof fork.compete !== "boolean") {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointerJoin(forkPointer, "compete")),
      "Set compete to true or false.",
      { expected: "boolean" }
    );
  }
  if (!requireKey(checker, fork, "branches", forkPointer, site)) {
    return;
  }
  const { branches } = fork;
  if (
    Array.isArray(branches) &&
    branches.length > profileLimits.maxForkBranches
  ) {
    checker.report.error(
      "profile.too_many",
      at(site, pointerJoin(forkPointer, "branches")),
      `Fork at most ${profileLimits.maxForkBranches} branches.`
    );
    return;
  }
  walkList(
    checker,
    branches,
    pointerJoin(forkPointer, "branches"),
    site,
    false
  );
};

const checkTry = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  record: TaskRecord,
  walkList: ListWalker
): void => {
  walkList(checker, task.try, pointerJoin(pointer, "try"), site, true);
  const catchPointer = pointerJoin(pointer, "catch");
  if (!requireKey(checker, task, "catch", pointer, site)) {
    return;
  }
  const handler = objectAt(checker, task.catch, catchPointer, site, "catch");
  if (handler === undefined) {
    return;
  }
  allowKeys(
    checker,
    handler,
    ["errors", "as", "when", "exceptWhen", "retry", "do", "then"],
    catchPointer,
    site
  );
  const name = variableAt(
    checker,
    member(handler, "as"),
    "error",
    pointerJoin(catchPointer, "as"),
    site,
    [...site.loopVariables, ...site.errorVariables],
    { pointer: catchPointer, keys: "catch.as" }
  );
  const inner: Site = {
    ...site,
    errorVariables: [...site.errorVariables, name],
  };
  if (Object.hasOwn(handler, "errors")) {
    const errorsPointer = pointerJoin(catchPointer, "errors");
    const errors = objectAt(
      checker,
      handler.errors,
      errorsPointer,
      site,
      "errors"
    );
    if (errors !== undefined) {
      allowKeys(checker, errors, ["with"], errorsPointer, site);
      const filterPointer = pointerJoin(errorsPointer, "with");
      if (requireKey(checker, errors, "with", errorsPointer, site)) {
        const filter = objectAt(
          checker,
          errors.with,
          filterPointer,
          site,
          "the error filter"
        );
        if (filter !== undefined) {
          allowKeys(
            checker,
            filter,
            ["type", "status", "instance", "title", "detail"],
            filterPointer,
            site
          );
          if (Object.keys(filter).length === 0) {
            checker.report.error(
              "profile.invalid_value",
              at(site, filterPointer),
              "Filter on at least one property."
            );
          }
          for (const [key, value] of Object.entries(filter)) {
            const valid =
              key === "status"
                ? typeof value === "number" && Number.isInteger(value)
                : typeof value === "string" &&
                  parseSlot(value).kind === "literal";
            if (!valid) {
              checker.report.error(
                "profile.invalid_value",
                at(site, pointerJoin(filterPointer, key)),
                "Filter on literal values: a whole-number status, text for the rest."
              );
            }
          }
        }
      }
    }
  }
  for (const key of ["when", "exceptWhen"]) {
    if (Object.hasOwn(handler, key)) {
      expressionOnly(
        checker,
        handler[key],
        pointerJoin(catchPointer, key),
        taskDefinition,
        inner,
        "boolean"
      );
    }
  }
  if (Object.hasOwn(handler, "retry")) {
    const retryPointer = pointerJoin(catchPointer, "retry");
    const { retry } = handler;
    if (typeof retry === "string") {
      if (!checker.reusableRetries.has(retry)) {
        checker.report.error(
          "profile.invalid_value",
          at(site, retryPointer),
          "Name a retry policy declared in use.retries.",
          { reason: "unknown retry policy" }
        );
      }
    } else {
      checkRetryPolicy(checker, retry, retryPointer, inner);
    }
  }
  if (Object.hasOwn(handler, "do")) {
    walkList(checker, handler.do, pointerJoin(catchPointer, "do"), inner, true);
  }
  const then = recordTransition(
    checker,
    member(handler, "then"),
    pointerJoin(catchPointer, "then"),
    site
  );
  if (then !== undefined) {
    record.catchNext = then;
  }
};

const checkRaise = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site
): void => {
  const raisePointer = pointerJoin(pointer, "raise");
  const raise = objectAt(checker, task.raise, raisePointer, site, "raise");
  if (raise === undefined) {
    return;
  }
  allowKeys(checker, raise, ["error"], raisePointer, site);
  if (!requireKey(checker, raise, "error", raisePointer, site)) {
    return;
  }
  const errorPointer = pointerJoin(raisePointer, "error");
  const { error } = raise;
  if (typeof error === "string") {
    if (!checker.reusableErrors.has(error)) {
      checker.report.error(
        "profile.invalid_value",
        at(site, errorPointer),
        "Name an error declared in use.errors.",
        { reason: "unknown error" }
      );
    }
    return;
  }
  checkErrorDefinition(checker, error, errorPointer, site);
};

const kindOf = (task: JsonObject): string[] => {
  const present = kinds.filter((kind) => Object.hasOwn(task, kind));
  // A for loop and a try have a list (`do`, `catch`) of their own.
  return present.includes("for")
    ? present.filter((kind) => kind !== "do")
    : present;
};

/** What every task kind's own check is given. */
interface KindCheck {
  checker: Checker;
  task: JsonObject;
  pointer: string;
  site: Site;
  record: TaskRecord;
  metadata: TaskMetadata;
  walkList: ListWalker;
}

const kindChecks: Readonly<Record<string, (check: KindCheck) => void>> = {
  call: ({ checker, task, pointer, site }) => {
    checkCall(checker, task, pointer, site);
  },
  do: ({ checker, task, pointer, site, walkList }) => {
    walkList(checker, task.do, pointerJoin(pointer, "do"), site, true);
  },
  emit: ({ checker, task, pointer, site, metadata }) => {
    checkEmit(checker, task, pointer, site, metadata);
  },
  for: ({ checker, task, pointer, site, walkList }) => {
    checkFor(checker, task, pointer, site, walkList);
  },
  fork: ({ checker, task, pointer, site, walkList }) => {
    checkFork(checker, task, pointer, site, walkList);
  },
  listen: ({ checker, task, pointer, site, metadata }) => {
    checkListen(checker, task, pointer, site, metadata);
  },
  raise: ({ checker, task, pointer, site }) => {
    checkRaise(checker, task, pointer, site);
  },
  run: ({ checker, task, pointer, site, metadata }) => {
    checkRun(checker, task, pointer, site, metadata);
  },
  set: ({ checker, task, pointer, site }) => {
    checkSet(checker, task, pointer, site);
  },
  switch: ({ checker, task, pointer, site, record }) => {
    checkSwitch(checker, task, pointer, site, record);
  },
  try: ({ checker, task, pointer, site, record, walkList }) => {
    checkTry(checker, task, pointer, site, record, walkList);
  },
  wait: ({ checker, task, pointer, site }) => {
    durationAt(checker, task.wait, pointerJoin(pointer, "wait"), site, {
      stage: taskDefinition,
    });
  },
};

/** The properties every task has: if, input, output, export, timeout, then. */
const checkBase = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  record: TaskRecord
): void => {
  if (record.hasIf) {
    expressionOnly(
      checker,
      task.if,
      pointerJoin(pointer, "if"),
      "taskIf",
      site,
      "boolean"
    );
  }
  const flows = [
    ["input", "from", "taskInputFrom"],
    ["output", "as", "taskOutputAs"],
    ["export", "as", "taskExportAs"],
  ] as const;
  for (const [key, transform, stage] of flows) {
    if (Object.hasOwn(task, key)) {
      checkDataFlow(
        checker,
        task[key],
        pointerJoin(pointer, key),
        site,
        transform,
        stage
      );
    }
  }
  if (Object.hasOwn(task, "timeout")) {
    checkTimeout(checker, task.timeout, pointerJoin(pointer, "timeout"), site);
  }
  // A switch moves on through its cases (checkSwitch refuses its then).
  if (record.kind !== "switch") {
    const next = recordTransition(
      checker,
      member(task, "then"),
      pointerJoin(pointer, "then"),
      site
    );
    if (next !== undefined) {
      record.next = next;
    }
  }
};

/**
 * Checks one task: its kind, its own shape and its base properties; walks
 * its task lists through `walkList`. The record it returns is the task as
 * the flow checks see it.
 */
export const checkTask = (
  checker: Checker,
  id: string,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  walkList: ListWalker
): TaskRecord | undefined => {
  const task = objectAt(checker, value, pointer, site, "the task");
  if (task === undefined) {
    return undefined;
  }
  const present = kindOf(task);
  const [kind] = present;
  if (kind === undefined || present.length > 1) {
    checker.report.error(
      present.length > 1 ? "task.ambiguous_kind" : "task.unknown_kind",
      at(site, pointer),
      `Give the task exactly one of: ${kinds.join(", ")}.`,
      { expected: "one task kind" }
    );
    return undefined;
  }
  const record: TaskRecord = {
    id,
    kind,
    pointer,
    scope: site.scope,
    hasIf: Object.hasOwn(task, "if"),
  };
  allowKeys(
    checker,
    task,
    [...baseKeys, ...(kindKeys[kind] ?? [])],
    pointer,
    site,
    {
      foreach:
        "Listener foreach isn't available: use a bounded for loop of listens.",
    }
  );
  checkBase(checker, task, pointer, site, record);
  const metadata = checkMetadata(
    checker,
    member(task, "metadata"),
    pointerJoin(pointer, "metadata"),
    site,
    kind
  );
  kindChecks[kind]?.({
    checker,
    task,
    pointer,
    site,
    record,
    metadata,
    walkList,
  });
  return record;
};

/** Whether `id` can be a task's ID; reports why not. */
export const checkTaskId = (
  checker: Checker,
  id: string,
  pointer: string,
  site: Site
): boolean => {
  if (
    id.length > maxTaskIdLength ||
    !taskIdPattern.test(id) ||
    directives.has(id)
  ) {
    checker.report.error(
      "task.invalid_id",
      at(site, pointer),
      "Use 1 to 64 characters of kebab-case starting with a letter, other than continue, exit or end.",
      { expected: "kebab-case" }
    );
    return false;
  }
  if (checker.taskIds.has(id)) {
    checker.report.error(
      "task.duplicate_id",
      at(site, pointer),
      "Give every task, in reusable functions too, its own ID."
    );
    return false;
  }
  checker.taskIds.add(id);
  return true;
};

/**
 * Walks a task list: an ordered, nonempty list of single-key tasks, a scope
 * of its own. Records the list for the flow checks.
 */
export const checkTaskList: ListWalker = (
  checker,
  value,
  pointer,
  site,
  namedTransitions
) => {
  if (!Array.isArray(value)) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      "Write the tasks as a list.",
      {
        expected: "array",
      }
    );
    return;
  }
  if (value.length === 0) {
    checker.report.error(
      "task.empty_list",
      at(site, pointer),
      "Add at least one task."
    );
    return;
  }
  const list: ListRecord = { pointer, tasks: [], namedTransitions };
  const owner = taskIdOf(site);
  if (owner !== undefined) {
    list.taskId = owner;
  }
  checker.lists.push(list);
  for (const [index, item] of value.entries()) {
    const itemPointer = pointerJoin(pointer, index);
    const entries = isObject(item) ? Object.entries(item) : [];
    const [entry] = entries;
    if (entries.length !== 1 || entry === undefined) {
      checker.report.error(
        "task.not_single_key",
        at(site, itemPointer),
        'Write the task as { "task-id": { … } }.'
      );
      continue;
    }
    const [id, body] = entry;
    const taskPointer = pointerJoin(itemPointer, id);
    if (checker.tasks.length >= profileLimits.maxTasks) {
      // Past this, checking more tasks only costs: the walk stops here.
      checker.report.fatal(
        "task.too_many",
        at(site, taskPointer),
        `Keep the definition to ${profileLimits.maxTasks} tasks, or split it into child workflows.`
      );
    }
    if (site.scope.length + 1 > profileLimits.maxScopes) {
      checker.report.error(
        "task.scope_too_deep",
        at(site, taskPointer),
        "Nest task lists at most 16 deep: move tasks up, or into a child workflow."
      );
      return;
    }
    const inner: Site = { ...site, scope: [...site.scope, id] };
    const valid = checkTaskId(checker, id, taskPointer, inner);
    const record = checkTask(
      checker,
      id,
      body,
      taskPointer,
      inner,
      checkTaskList
    );
    if (record !== undefined) {
      checker.tasks.push(record);
      if (valid) {
        list.tasks.push(record);
      }
    }
  }
};

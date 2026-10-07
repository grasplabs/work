import type { ValueSchema } from "@grasp-os/sdk";

import type { BindingKind } from "./catalog.ts";
import { member, taskIdOf } from "./checker.ts";
import type { Binding, Checker, Site } from "./checker.ts";
import { pointerJoin } from "./diagnostics.ts";
import { isObject } from "./json-text.ts";
import type { JsonObject, JsonValue } from "./json-text.ts";
import {
  bindingFor,
  checkArguments,
  schemaAt,
  taskDefinition,
  textOrExpression,
} from "./task-parts.ts";
import {
  allowKeys,
  at,
  dataValue,
  expressionOnly,
  literalText,
  objectAt,
  requireKey,
} from "./values.ts";

/**
 * The `call` task: the profile's named calls, each with the `with` fields
 * of the 13.6 table, and calls to reusable functions. Raw protocol calls
 * aren't available.
 */

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

export const checkCall = (
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

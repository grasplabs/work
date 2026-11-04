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
  durationAt,
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

/** A named call of the profile. */
export interface ProfileCall {
  /** The `with` fields it can't do without. */
  readonly required: readonly string[];
  /** The `with` fields it may take besides. */
  readonly optional: readonly string[];
  /** The kind of binding its `with.binding` names, if it takes one. */
  readonly binding?: BindingKind;
  /** What a step calls it for, in a sentence. */
  readonly purpose: string;
}

/**
 * Named calls of the profile: the `with` fields each takes, the binding
 * kind it calls and what it is for. Whoever writes a definition (a person
 * or the chat's agent) picks a step's call by its purpose, so a step that
 * judges, reaches an outside system or asks a person isn't written as code.
 */
export const profileCalls: Readonly<Record<string, ProfileCall>> = {
  "grasp.model": {
    required: ["binding", "instructions", "input", "outputSchema"],
    optional: ["model", "maxOutputTokens"],
    binding: "model",
    purpose:
      "A model's judgement: read, classify, extract, summarise or draft from `input` by `instructions`, answering in `outputSchema`.",
  },
  "grasp.decision": {
    required: ["binding", "recipients", "prompt", "input"],
    optional: ["ask", "remindAfter"],
    binding: "decision",
    purpose:
      "A person's check or approval: asks `recipients` (`person:<id>`, `team:<id>` or `role:<name>`) the `prompt` and waits for their answer (`approved`, and the contract's response). `remindAfter` asks once more when nobody answered that long after asking; `ask` names one of the workflow's own actions (an operation binding of `local:code/…`) that tells them, with `{ recipients, reminder }`, in place of Grasp's own notice.",
  },
  "grasp.connector": {
    required: ["binding", "operation", "arguments"],
    optional: [],
    binding: "connector",
    purpose:
      "An outside system (mail, calendar, CRM, files and the like): one `operation` its connector contract allows, served through connect.",
  },
  "grasp.operation": {
    required: ["binding", "arguments"],
    optional: [],
    binding: "operation",
    purpose:
      "An action with effects: a host operation from the catalog, or the workflow's own (`local:code/<file>.ts#<export>`) using its other bindings.",
  },
  "grasp.compute": {
    required: ["binding", "arguments"],
    optional: [],
    binding: "compute",
    purpose:
      "A pure calculation in the workflow's own code (`local:code/<file>.ts#<export>`): no judgement, no outside system, no person; only what an expression can't compute.",
  },
  "grasp.now": {
    required: [],
    optional: [],
    purpose: "The current time, recorded so a replay sees the same.",
  },
  "grasp.random": {
    required: [],
    optional: [],
    purpose: "A random number, recorded so a replay sees the same.",
  },
  "grasp.sleepUntil": {
    required: ["timestamp"],
    optional: [],
    purpose: "Waits until `timestamp`, in milliseconds since the epoch.",
  },
};

/** The longest prompt a decision takes, as its description. */
export const maxDecisionPrompt = 500;

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
  // Expressions in it are recorded for compilation.
  args.data(key);
  checkArguments(args.checker, value, schema, pointer, args.site);
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

/** Someone a decision asks, as the host passes them to its ask action. */
const sampleRecipient = {
  userId: "user",
  name: "Ada",
  email: "ada@example.com",
  link: "https://example.com/decisions/decision",
};

/**
 * What the host passes a decision's ask action: a first ask, which may
 * find nobody to ask, and a reminder, which never goes to nobody.
 */
const askSamples = [
  { recipients: [sampleRecipient], reminder: false },
  { recipients: [], reminder: false },
  { recipients: [sampleRecipient], reminder: true },
];

/**
 * A decision's `ask`: an operation binding to one of the workflow's own
 * actions, which the host runs, in a step of its own, with the people it
 * asks and whether it reminds them. A catalog operation is refused: what
 * the host passes it is no contract's input.
 */
const checkDecisionAsk = (
  args: CallArgs,
  value: JsonValue,
  pointer: string
): void => {
  const binding = bindingFor(
    args.checker,
    value,
    pointer,
    args.site,
    "operation"
  );
  if (binding === undefined) {
    return;
  }
  if (!binding.contractKey.startsWith("local:")) {
    args.checker.report.error(
      "binding.contract_mismatch",
      at(args.site, pointer),
      "Name an operation binding of one of the workflow's own actions (local:code/<file>.ts#<export>).",
      { expected: "local action" }
    );
    return;
  }
  // What the host passes it, a first ask and a reminder alike: an action
  // that takes neither would fail only once it is asked to tell someone.
  const input = binding.contract?.input;
  const takes = askSamples.every(
    (sample) => input?.["~standard"].validate(sample).issues === undefined
  );
  if (input !== undefined && !takes) {
    args.checker.report.error(
      "binding.contract_mismatch",
      at(args.site, pointer),
      "Name an action that takes { recipients: [{ userId, name, email, link }], reminder }, as the host passes it.",
      { expected: "{ recipients, reminder }" }
    );
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
  // What the decision service shows as the decision's description, which
  // it never cuts short: a longer prompt is refused, here and at run time.
  textOrExpression(checker, prompt, promptPointer, site, maxDecisionPrompt);
  callData(args, "input", binding?.contract?.input);
  const [ask, askPointer] = args.field("ask");
  if (ask !== undefined) {
    checkDecisionAsk(args, ask, askPointer);
  }
  const [remindAfter, remindPointer] = args.field("remindAfter");
  if (remindAfter !== undefined) {
    // Literal, as the task's timeout is: the build seals both as numbers,
    // and refuses a reminder that wouldn't come before the deadline.
    durationAt(checker, remindAfter, remindPointer, site);
  }
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
  const fields = profileCalls[call];
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
  if (!Object.hasOwn(profileCalls, call)) {
    checker.report.error(
      "call.unsupported",
      at(site, callPointer),
      protocolCalls.has(call)
        ? "Raw protocol calls aren't available: call an approved connector with grasp.connector."
        : `Use a named Grasp call (${Object.keys(profileCalls).join(", ")}) or a function in use.functions.`,
      { reason: protocolCalls.has(call) ? "protocol call" : "unknown call" }
    );
    return;
  }
  callWith(checker, task, call, pointer, site);
};

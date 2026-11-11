import type { Schema } from "@cfworker/json-schema";
import { compactDescriptorSchema } from "@grasp-os/runtime/host";
import { decisionLimits } from "@grasp-os/shared/decisions";
import {
  appErrorCodeMaxLength,
  appErrorCodePattern,
  appErrorMessageMaxLength,
  functionPathMaxLength,
} from "@grasp-os/shared/function-limits";
import { identifierMaxLength } from "@grasp-os/shared/identifier";
import {
  eventTypePattern,
  sealedBuildLimits,
} from "@grasp-os/shared/sealed-builds";
import { stableIdPattern } from "@grasp-os/shared/store-limits";

import {
  actionPattern,
  aliasPattern,
  forEachDescription,
  formatLimits,
  functionPathPattern,
  paramNamePattern,
  recipientPattern,
  reservedStepIds,
  stateDeclarationDescription,
  stateDescription,
  stateKeyPattern,
  stepIdPattern,
  waitForEventDescription,
  workflowSchemaUrl,
} from "./format.ts";

// grasp-workflow/2's JSON Schema (draft 2020-12): the format's definition,
// published as is and checked with a standard validator (check.ts), never
// with checks of our own. What a schema can't say (IDs unique, references
// to steps that ran, a permission of the step's kind) check.ts adds after
// it.
//
// Steps are told apart by `type` (`if`/`then` on its constant), so a
// problem names the step's own properties rather than every kind's, and a
// step kind joins the format as one more `$defs` entry and `allOf` branch.

const durationPattern = `^[1-9][0-9]{0,8} (?:second|minute|hour|day|week)s?$`;

const ref = (name: string) => ({ $ref: `#/$defs/${name}` });

/** A step of kind `type`: its own properties, besides every step's. */
const stepOf = (
  type: string,
  properties: Record<string, unknown>,
  required: readonly string[]
) => ({
  type: "object",
  required: ["id", "type", ...required],
  properties: {
    id: true,
    type: { const: type },
    title: true,
    if: true,
    ...properties,
  },
  additionalProperties: false,
});

/** An `AppError` code, as `AppError` takes one. */
const errorCode = {
  type: "string",
  maxLength: appErrorCodeMaxLength,
  pattern: appErrorCodePattern.source,
};

/** The keys that name what a `call` step calls. */
const callTargets = [
  "connection",
  "files",
  "brain",
  "app",
  "action",
  "function",
  "into",
  "from",
] as const;

/** A schema a `call` step matches when it has any of `callTargets` but `allowed`. */
const callTargetsBut = (...allowed: readonly string[]) => ({
  anyOf: callTargets
    .filter((key) => !allowed.includes(key))
    .map((key) => ({ required: [key] })),
});

const stepKinds = {
  call: {
    ...stepOf(
      "call",
      {
        connection: ref("alias"),
        files: ref("alias"),
        brain: ref("alias"),
        action: { type: "string", pattern: actionPattern, maxLength: 256 },
        into: ref("alias"),
        from: ref("alias"),
        app: ref("alias"),
        function: ref("functionId"),
        args: ref("value"),
        timeout: ref("duration"),
        state: ref("state"),
      },
      []
    ),
    // One member: a connection's action (which alone keeps a file `into`
    // or attaches files `from` a files permission), an action on the run's
    // files, an action on a Brain collection, or an App's function.
    oneOf: [
      {
        required: ["connection", "action"],
        not: callTargetsBut("connection", "action", "into", "from"),
      },
      {
        required: ["files", "action"],
        not: callTargetsBut("files", "action"),
      },
      {
        required: ["brain", "action"],
        not: callTargetsBut("brain", "action"),
      },
      {
        required: ["app", "function"],
        not: callTargetsBut("app", "function"),
      },
    ],
  },
  generate: stepOf(
    "generate",
    {
      instructions: ref("value"),
      input: ref("value"),
      returns: ref("descriptor"),
      timeout: ref("duration"),
      state: ref("state"),
    },
    ["instructions", "input", "returns"]
  ),
  decide: stepOf(
    "decide",
    {
      decision: ref("alias"),
      recipients: {
        anyOf: [
          ref("expression"),
          {
            type: "array",
            minItems: 1,
            maxItems: decisionLimits.recipients,
            items: {
              anyOf: [
                ref("expression"),
                { type: "string", pattern: recipientPattern },
              ],
            },
          },
        ],
      },
      prompt: {
        anyOf: [
          ref("expression"),
          {
            type: "string",
            // As the host takes one (`decisionPromptSchema`): not blank,
            // and `maxLength` counts code points, as it does.
            pattern: "\\S",
            maxLength: decisionLimits.promptLength,
          },
        ],
      },
      input: ref("value"),
      timeout: ref("duration"),
    },
    ["decision", "recipients", "prompt", "input"]
  ),
  forEach: {
    description: forEachDescription,
    ...stepOf(
      "forEach",
      {
        items: ref("expression"),
        while: ref("expression"),
        do: ref("steps"),
      },
      ["items", "do"]
    ),
  },
  wait: {
    ...stepOf(
      "wait",
      {
        for: ref("duration"),
        until: ref("expression"),
      },
      []
    ),
    oneOf: [{ required: ["for"] }, { required: ["until"] }],
  },
  waitForEvent: {
    description: waitForEventDescription,
    ...stepOf(
      "waitForEvent",
      {
        events: ref("alias"),
        eventType: {
          anyOf: [
            ref("eventType"),
            {
              type: "array",
              minItems: 1,
              maxItems: sealedBuildLimits.eventTypes,
              uniqueItems: true,
              items: ref("eventType"),
            },
          ],
        },
        match: {
          type: "object",
          required: ["field", "equals"],
          properties: {
            // A JSON Pointer into the event's data, never its root.
            field: {
              type: "string",
              minLength: 2,
              maxLength: formatLimits.matchFieldLength,
              pattern: "^(?:/(?:[^~/]|~[01])*)+$",
            },
            equals: ref("value"),
          },
          additionalProperties: false,
        },
        // An event wait always ends.
        timeout: ref("duration"),
      },
      ["events", "eventType", "timeout"]
    ),
  },
  if: stepOf(
    "if",
    {
      condition: ref("expression"),
      // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
      then: ref("steps"),
      else: ref("steps"),
    },
    ["condition", "then"]
  ),
  try: stepOf(
    "try",
    {
      try: ref("steps"),
      catch: {
        type: "object",
        properties: {
          code: errorCode,
          when: ref("expression"),
          retry: {
            type: "object",
            required: ["attempts", "delay", "backoff"],
            properties: {
              attempts: { type: "integer", minimum: 1, maximum: 5 },
              delay: ref("duration"),
              backoff: { enum: ["constant", "linear", "exponential"] },
              when: ref("expression"),
            },
            additionalProperties: false,
          },
          do: ref("steps"),
        },
        additionalProperties: false,
      },
    },
    ["try", "catch"]
  ),
  raise: stepOf(
    "raise",
    {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: errorCode,
          message: {
            type: "string",
            minLength: 1,
            maxLength: appErrorMessageMaxLength,
          },
          details: true,
        },
        additionalProperties: false,
      },
    },
    ["error"]
  ),
};

/** The step kinds of grasp-workflow/2. */
export const stepTypes = Object.keys(stepKinds);

/** Permissions of one kind, by alias. */
const byAlias = (permission: Schema): Schema => ({
  type: "object",
  maxProperties: formatLimits.bindings,
  propertyNames: { pattern: aliasPattern },
  additionalProperties: permission,
});

export const workflowSchema: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: workflowSchemaUrl,
  title: "grasp-workflow/2",
  type: "object",
  required: ["$schema", "steps"],
  properties: {
    // Exactly this format's URL: a document of another is never read as one.
    $schema: { const: workflowSchemaUrl },
    args: ref("descriptor"),
    returns: ref("descriptor"),
    result: ref("value"),
    params: {
      type: "object",
      maxProperties: formatLimits.params,
      propertyNames: { pattern: paramNamePattern },
      additionalProperties: ref("param"),
    },
    permissions: {
      type: "object",
      properties: {
        ai: ref("permission"),
        apps: byAlias(ref("appPermission")),
        connections: byAlias(ref("permission")),
        decisions: byAlias(ref("permission")),
        events: byAlias(ref("permission")),
        files: byAlias(ref("permission")),
        brain: byAlias(ref("permission")),
      },
      additionalProperties: false,
    },
    state: {
      description: stateDeclarationDescription,
      type: "object",
      maxProperties: formatLimits.stateKeys,
      propertyNames: ref("stateKey"),
      additionalProperties: ref("descriptor"),
    },
    steps: ref("steps"),
  },
  // What it returns, and its value: both, or neither.
  dependentRequired: { result: ["returns"], returns: ["result"] },
  additionalProperties: false,
  $defs: {
    steps: { type: "array", maxItems: formatLimits.steps, items: ref("step") },
    step: {
      type: "object",
      required: ["id", "type"],
      properties: {
        id: {
          type: "string",
          maxLength: formatLimits.idLength,
          pattern: stepIdPattern,
          not: { enum: [...reservedStepIds] },
        },
        type: { enum: stepTypes },
        title: {
          type: "string",
          minLength: 1,
          maxLength: formatLimits.titleLength,
        },
        if: ref("expression"),
      },
      allOf: Object.keys(stepKinds).map((type) => ({
        if: { properties: { type: { const: type } }, required: ["type"] },
        // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema's if/then
        then: ref(`${type}Step`),
      })),
    },
    ...Object.fromEntries(
      Object.entries(stepKinds).map(([type, schema]) => [`${type}Step`, schema])
    ),
    alias: { type: "string", pattern: aliasPattern },
    // A type a run's inbox takes; whether the permission's contract admits
    // it is publication's to check.
    eventType: {
      type: "string",
      pattern: eventTypePattern,
      maxLength: sealedBuildLimits.eventTypeLength,
    },
    duration: { type: "string", pattern: durationPattern },
    // Only a `call` or a `generate` step has one (`stateStepTypes`): any
    // other's refuses it as a property it doesn't have, which check.ts
    // names for what it is.
    state: {
      description: stateDescription,
      type: "object",
      maxProperties: formatLimits.stateKeys,
      propertyNames: ref("stateKey"),
      additionalProperties: ref("value"),
    },
    // Never a name an expression can't read: `state.<key>` reads every key.
    stateKey: {
      type: "string",
      pattern: stateKeyPattern,
      not: { enum: ["constructor", "prototype", "__proto__"] },
    },
    expression: {
      type: "object",
      required: ["$expr"],
      properties: {
        $expr: {
          type: "string",
          minLength: 1,
          maxLength: formatLimits.expressionLength,
        },
      },
      additionalProperties: false,
    },
    // JSON in which any part may be an expression; an object with `$expr`
    // is always one, so no literal object holds that key. Its lists and
    // objects are as large as a sealed call's template takes one.
    value: {
      anyOf: [
        ref("expression"),
        { type: ["null", "boolean", "number", "string"] },
        {
          type: "array",
          maxItems: sealedBuildLimits.templateItems,
          items: ref("value"),
        },
        {
          type: "object",
          not: { required: ["$expr"] },
          maxProperties: sealedBuildLimits.templateItems,
          propertyNames: { maxLength: sealedBuildLimits.templateKeyLength },
          additionalProperties: ref("value"),
        },
      ],
    },
    // A value's schema, in the SDK descriptor's compact form, as `v`
    // declares it: what check.ts reads with `descriptorFromCompact`.
    ...compactDescriptorSchema,
    // Sensitive unless `sensitive: false` (format.ts, `Param`): only a
    // parameter that isn't sensitive has a default, so no secret's value
    // is ever in the document.
    param: {
      type: "object",
      required: ["label", "type"],
      properties: {
        label: { type: "string", minLength: 1, maxLength: 200 },
        type: ref("descriptor"),
        sensitive: { type: "boolean" },
      },
      additionalProperties: false,
      if: {
        properties: { sensitive: { const: false } },
        required: ["sensitive"],
      },
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema's if/then
      then: { properties: { type: { required: ["default"] } } },
      else: { properties: { type: { not: { required: ["default"] } } } },
    },
    // A contract of the host's catalog.
    permission: {
      type: "object",
      required: ["contract"],
      properties: {
        contract: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          not: { pattern: "^local:" },
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: formatLimits.titleLength,
        },
      },
      additionalProperties: false,
    },
    // A function's stable ID, as an App's definition gives it.
    functionId: {
      type: "string",
      pattern: stableIdPattern.source,
      not: { enum: ["__proto__", "constructor", "prototype"] },
    },
    // An App whose functions the workflow calls: by the App's ID, each
    // function by its stable ID with its path as a hint.
    appPermission: {
      type: "object",
      required: ["app", "functions"],
      properties: {
        app: { type: "string", minLength: 1, maxLength: identifierMaxLength },
        functions: {
          type: "object",
          minProperties: 1,
          maxProperties: formatLimits.bindings,
          propertyNames: ref("functionId"),
          additionalProperties: {
            type: "string",
            maxLength: functionPathMaxLength,
            pattern: functionPathPattern,
          },
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: formatLimits.titleLength,
        },
      },
      additionalProperties: false,
    },
  },
};

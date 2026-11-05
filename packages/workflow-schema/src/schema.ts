import type { Schema } from "@cfworker/json-schema";
import { blockedProperties } from "@grasp-os/sdk/expression-check";
import { decisionLimits } from "@grasp-os/shared/decisions";
import { sealedBuildLimits } from "@grasp-os/shared/sealed-builds";

import {
  aliasPattern,
  bindingKinds,
  forEachDescription,
  formatLimits,
  localContractPattern,
  paramKinds,
  paramNamePattern,
  recipientPattern,
  stepIdPattern,
  workflowSchemaUrl,
} from "./format.ts";

// grasp-workflow/1's JSON Schema (draft 2020-12): the format's definition,
// published as is and checked with a standard validator (check.ts), never
// with checks of our own. What a schema can't say (IDs unique, references
// to steps that ran, a binding of the step's kind) check.ts adds after it.
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

const stepKinds = {
  do: stepOf(
    "do",
    {
      binding: ref("alias"),
      operation: { type: "string", minLength: 1, maxLength: 256 },
      arguments: ref("value"),
      timeout: ref("duration"),
    },
    ["binding"]
  ),
  agent: stepOf(
    "agent",
    {
      binding: ref("alias"),
      instructions: ref("value"),
      input: ref("value"),
      output: { type: "object" },
      timeout: ref("duration"),
    },
    ["binding", "instructions", "input", "output"]
  ),
  decision: stepOf(
    "decision",
    {
      binding: ref("alias"),
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
    ["binding", "recipients", "prompt", "input"]
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
    ...stepOf("wait", { for: ref("duration"), until: ref("expression") }, []),
    oneOf: [{ required: ["for"] }, { required: ["until"] }],
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
          errors: {
            type: "object",
            properties: {
              type: { type: "string", minLength: 1, maxLength: 2048 },
              status: { type: "integer", minimum: 400, maximum: 599 },
            },
            additionalProperties: false,
          },
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
        required: ["type", "status"],
        properties: {
          type: { type: "string", format: "uri", maxLength: 2048 },
          status: { type: "integer", minimum: 400, maximum: 599 },
          title: { type: "string", maxLength: 2000 },
          detail: { type: "string", maxLength: 2000 },
        },
        additionalProperties: false,
      },
    },
    ["error"]
  ),
};

/** The step kinds of grasp-workflow/1. */
export const stepTypes = Object.keys(stepKinds);

export const workflowSchema: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: workflowSchemaUrl,
  title: "grasp-workflow/1",
  type: "object",
  required: ["$schema", "steps"],
  properties: {
    // Exactly this format's URL: a document of another is never read as one.
    $schema: { const: workflowSchemaUrl },
    input: { type: "object" },
    output: {
      type: "object",
      required: ["schema", "value"],
      properties: { schema: { type: "object" }, value: ref("value") },
      additionalProperties: false,
    },
    params: {
      type: "object",
      maxProperties: formatLimits.params,
      propertyNames: { pattern: paramNamePattern },
      additionalProperties: ref("param"),
    },
    bindings: {
      type: "object",
      maxProperties: formatLimits.bindings,
      propertyNames: { pattern: aliasPattern },
      additionalProperties: ref("binding"),
    },
    steps: ref("steps"),
  },
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
          not: { enum: [...blockedProperties] },
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
    duration: { type: "string", pattern: durationPattern },
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
    // Sensitive unless `sensitive: false` (format.ts, `Param`): only a
    // parameter that isn't sensitive has a default, so no secret's value
    // is ever in the document.
    param: {
      type: "object",
      required: ["kind", "label"],
      properties: {
        kind: { enum: [...paramKinds] },
        label: { type: "string", minLength: 1, maxLength: 200 },
        default: true,
        sensitive: { type: "boolean" },
        currency: { type: "string", pattern: "^[A-Z]{3}$" },
      },
      additionalProperties: false,
      allOf: [
        {
          if: { properties: { kind: { const: "money" } } },
          // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema's if/then
          then: { required: ["currency"] },
          else: { not: { required: ["currency"] } },
        },
        {
          if: {
            properties: { sensitive: { const: false } },
            required: ["sensitive"],
          },
          // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema's if/then
          then: { required: ["default"] },
          else: { not: { required: ["default"] } },
        },
      ],
    },
    binding: {
      type: "object",
      required: ["kind", "contract"],
      properties: {
        kind: { enum: [...bindingKinds] },
        contract: { type: "string", minLength: 1, maxLength: 256 },
        title: {
          type: "string",
          minLength: 1,
          maxLength: formatLimits.titleLength,
        },
      },
      additionalProperties: false,
      if: { properties: { kind: { enum: ["compute", "action"] } } },
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema's if/then
      then: { properties: { contract: { pattern: localContractPattern } } },
      else: { properties: { contract: { not: { pattern: "^local:" } } } },
    },
  },
};

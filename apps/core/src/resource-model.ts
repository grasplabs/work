import type { ValueDescriptor } from "@grasp-os/sdk";
import { jsonSchemaOf, schemaFromDescriptor } from "@grasp-os/sdk/host";
import { delegateActorOf } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { modelErrors } from "@grasp-os/shared/models";
import { jsonOf, operationErrors } from "@grasp-os/shared/operations";
import { z } from "zod";

import { gatewaySettings, models } from "./models.ts";
import type { ResourceAdapter } from "./resource-adapter.ts";

// A model resource (spec 12, 32.3): one answer per request, from the model
// its binding names, through the model gateway, never straight to a
// provider and with no key anywhere near App code. The gateway applies the
// deployment's allowlist and data rules, reserves and settles the call
// against every budget it counts against (the deployment's, the person's
// it acts for), and audits it as metadata only. The declaration bounds the
// answer's tokens, and a structured output is the descriptor's: the model
// is told its JSON Schema, asked once more when an answer doesn't fit, and
// the operation host checks the answer against the descriptor again.

/** What every model binding serves: a prompt in, text or the declared value out. */
const modelContract = {
  contractId: "grasp.model@1",
  request: {
    prompt: "string, 1 to 100000 code units",
    instructions: "string, at most 20000 code units, optional",
  },
  answer: "text, or a value of the declaration's structured output",
} as const;

/** The model contract's fingerprint, computed once. */
const modelFingerprint = sha256Hex(canonicalJson(modelContract));

/** The longest one request may wait, as the gateway allows. */
const maxTimeoutMs = 15 * 60_000;

/** What the request schema of the operation host lets through (operations.ts). */
const requestSchema = z.strictObject({
  prompt: z.string(),
  instructions: z.string().optional(),
});

/**
 * The gateway's schema for answers of `descriptor`: told to the model as
 * the descriptor's JSON Schema, and checked by the descriptor itself, which
 * must also leave the answer as it is (its normalized form), as every
 * return is checked. An answer that doesn't fit is asked again.
 */
const answerSchema = (descriptor: ValueDescriptor) => {
  const schema = schemaFromDescriptor(JSON.stringify(descriptor));
  return z
    .unknown()
    .superRefine((value, context) => {
      const checked = schema["~standard"].validate(value);
      if ("then" in checked) {
        context.addIssue({ code: "custom", message: "Not checkable." });
        return;
      }
      if (checked.issues !== undefined) {
        for (const issue of checked.issues) {
          const at = (issue.path ?? []).map(String).join(".");
          context.addIssue({
            code: "custom",
            message: at === "" ? issue.message : `${at}: ${issue.message}`,
          });
        }
        return;
      }
      const normalized = jsonOf(checked.value);
      const given = jsonOf(value);
      if (
        normalized === undefined ||
        given === undefined ||
        canonicalJson(normalized) !== canonicalJson(given)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "It isn't in its exact form: trim strings and leave nothing to fill in.",
        });
      }
    })
    .meta(jsonSchemaOf(descriptor));
};

/**
 * What a gateway refusal means to App code, from an allow-list: a model the
 * deployment no longer lets this call use is a binding that can't serve,
 * a budget used up is that, an answer that never fit is a contract the
 * provider broke. Anything else stays the gateway's, for the operation host
 * to redact.
 */
const refusalOf = (error: unknown): unknown => {
  const code = modelErrors.codeOf(error);
  if (
    code === "model.not_allowed" ||
    code === "model.unconfigured" ||
    code === "model.eu_only" ||
    code === "model.sensitive_data" ||
    code === "model.unpriced"
  ) {
    return operationErrors.create("resource.unavailable");
  }
  if (code === "model.over_budget" || code === "model.run_limit") {
    return operationErrors.create("resource.budget_exhausted");
  }
  if (code === "model.invalid_output") {
    return operationErrors.create("contract.invalid_resource_result");
  }
  return error;
};

export const modelAdapter: ResourceAdapter<"model"> = {
  served: async (env, _app, _declaration, target) =>
    gatewaySettings(env).models.includes(target.model)
      ? {
          contractId: modelContract.contractId,
          fingerprint: await modelFingerprint,
        }
      : undefined,
  call: async (env, caller, declaration, target, { args }, context) => {
    const { prompt, instructions } = requestSchema.parse(args[0]);
    const { structuredOutput } = declaration;
    try {
      const answer = await models(env).call({
        model: target.model,
        ...(instructions === undefined ? {} : { system: instructions }),
        input: prompt,
        maxTokens: declaration.maxOutputTokens,
        timeoutMs: Math.min(
          maxTimeoutMs,
          Math.max(1, Math.floor(context.deadline - Date.now()))
        ),
        purpose: "app.resource",
        trigger: delegateActorOf(caller.authority),
        provenance: [...caller.sources.snapshot().collectionIds],
        work: { authority: caller.authority, context: caller.context },
        requestId: context.requestId,
        ...(structuredOutput === null
          ? {}
          : { schema: answerSchema(structuredOutput) }),
      });
      return structuredOutput === null ? answer.text : answer.output;
    } catch (error) {
      throw refusalOf(error);
    }
  },
};

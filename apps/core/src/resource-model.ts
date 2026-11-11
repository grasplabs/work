import type { ValueDescriptor } from "@grasp-os/runtime/app";
import {
  descriptorFromText,
  jsonSchemaOf,
  schemaFromDescriptor,
} from "@grasp-os/runtime/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { jsonOf, functionErrors } from "@grasp-os/shared/functions";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { modelErrors } from "@grasp-os/shared/models";
import { z } from "zod";

import type { ResourceContext } from "./function-host.ts";
import { modelSettings, models, usableAnswerTokens } from "./models.ts";
import type {
  BindingCaller,
  BindingRecord,
  DeclarationOf,
  ResourceAdapter,
  TargetOf,
} from "./resource-adapter.ts";

// An App's `ai` permission (spec 12, 32.3): one answer per request, from
// the model its binding names, through the model gateway, never straight
// to a provider and with no key anywhere near App code. The gateway
// applies the organization's models, counts the call's spend (the
// deployment's, the person's it acts for, the binding's, and for a
// workflow run's call its workflow's and its run lineage's,
// model-spend.ts), and audits it as metadata only. The declaration bounds
// the answer's tokens. A request that asks for a value sends its
// descriptor: the model is told its JSON Schema, asked once more when an
// answer doesn't fit, and the function host checks the answer against
// the descriptor again.

/** What every model binding serves: a prompt in, text or the declared value out. */
const modelContract = {
  contractId: "grasp.model@1",
  request: {
    prompt: "string, 1 to 100000 code units",
    instructions: "string, at most 20000 code units, optional",
  },
  answer: "text, or a value of the request's output descriptor",
} as const;

/** The model contract's fingerprint, computed once. */
const modelFingerprint = sha256Hex(canonicalJson(modelContract));

/** The longest one request may wait, as the gateway allows. */
const maxTimeoutMs = 15 * 60_000;

/** What the request schema of the function host lets through (function-host.ts). */
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
  return (
    z
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
      // The exact form: a defaulted field must be given, as the
      // check below requires it.
      .meta(jsonSchemaOf(descriptor, { exact: true }))
  );
};

/**
 * What a gateway refusal means to App code, from an allow-list: a model the
 * deployment no longer lets this call use is a binding that can't serve,
 * a provider's rate limit is rate-limited (worth asking again, after the
 * wait core computed), an answer that never fit is a contract the
 * provider broke. Anything else stays the
 * gateway's, for the function host to redact.
 */
const refusalOf = (error: unknown): unknown => {
  const code = modelErrors.codeOf(error);
  if (
    code === "model.not_allowed" ||
    code === "model.unconfigured" ||
    code === "model.answer_too_long"
  ) {
    return functionErrors.create("resource.unavailable");
  }
  const wait = isExpectedError(error)
    ? error.details?.retryAfterSeconds
    : undefined;
  const after =
    typeof wait === "number" ? { retryAfterSeconds: wait } : undefined;
  // The provider's rate: throttling, worth asking again after the wait
  // core computed.
  if (code === "model.rate_limited") {
    return functionErrors.create("resource.rate_limited", after);
  }
  if (code === "model.invalid_output") {
    return functionErrors.create("contract.invalid_resource_result");
  }
  return error;
};

/**
 * How a declaration's token bound is spent: it bounds a request of the
 * App's (or a workflow's AI step) as a whole, never each provider request.
 * One that may ask once more for an answer that doesn't fit gives each ask
 * half; a bound too small to halve allows one ask only. An App's request
 * may ask again for a structured output; a workflow's AI step always may
 * (workflows/host.ts).
 */
export const tokensOfBound = (
  maxOutputTokens: number,
  mayAskAgain: boolean
): { maxTokens: number; askAgain: boolean } =>
  !mayAskAgain || maxOutputTokens < 2
    ? { maxTokens: maxOutputTokens, askAgain: false }
    : { maxTokens: Math.floor(maxOutputTokens / 2), askAgain: true };

/**
 * Whether `model` can give the longest ask `maxTokens` of a request
 * through a binding, by the gateway's own measure (`usableAnswerTokens`),
 * which refuses any call through a binding that asks for more.
 */
export const modelAnswers = (model: string, maxTokens: number): boolean =>
  maxTokens <= (usableAnswerTokens(model) ?? 0);

/** One request of a model resource, through the gateway. */
const generate = async (
  env: Env,
  caller: BindingCaller,
  record: BindingRecord,
  declaration: DeclarationOf<"model">,
  target: TargetOf<"model">,
  args: readonly Json[],
  context: ResourceContext
): Promise<unknown> => {
  const { prompt, instructions } = requestSchema.parse(args[0]);
  // The value asked for, as the function host read it already.
  const output =
    args[1] === undefined
      ? undefined
      : descriptorFromText(JSON.stringify(args[1]));
  try {
    const answer = await models(env).call({
      model: target.model,
      ...(instructions === undefined ? {} : { system: instructions }),
      input: prompt,
      // A request that may ask once more gives each ask half.
      ...tokensOfBound(declaration.maxOutputTokens, output !== undefined),
      timeoutMs: Math.min(
        maxTimeoutMs,
        Math.max(1, Math.floor(context.deadline - Date.now()))
      ),
      purpose: "app.resource",
      // The App for a page's call; the run for a workflow's, whose
      // workflow and run lineage then count it too.
      trigger: caller.actor,
      provenance: [...caller.sources.snapshot().collectionIds],
      work: { authority: caller.authority, context: caller.context },
      requestId: context.requestId,
      binding: { app: caller.app, alias: record.alias },
      // A run's attempt let go of while the gateway admitted the request
      // sends nothing to the provider.
      ...(caller.requireHolds === undefined
        ? {}
        : { beforeSend: caller.requireHolds }),
      ...(output === undefined ? {} : { schema: answerSchema(output) }),
    });
    return output === undefined ? answer.text : answer.output;
  } catch (error) {
    // Stopped before it was sent, as a run's attempt was let go of: said
    // so, whatever the gateway made of the stop.
    caller.requireHolds?.();
    throw refusalOf(error);
  }
};

export const modelAdapter: ResourceAdapter<"model"> = {
  bind: async (env, _app, declaration, target) => {
    const { models: allowed } = await modelSettings(env);
    return allowed.includes(target.model)
      ? {
          contractId: modelContract.contractId,
          fingerprint: await modelFingerprint,
          call: async (caller, { args }, context, _pin, record) =>
            await generate(
              env,
              caller,
              record,
              declaration,
              target,
              args,
              context
            ),
        }
      : undefined;
  },
};

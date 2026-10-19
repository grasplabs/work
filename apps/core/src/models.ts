import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  FetchFunction,
  Message,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
  StreamFunction,
  ThinkingLevel,
  TranscriptContext,
  Usage,
} from "@earendil-works/pi-ai";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import { streamSimple as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createAiBindingFetch,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { streamSimple as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  auditActorSchema,
  auditEventSchema,
  auditIdentifierMaxLength,
  auditProvenanceMaxItems,
  createAuditEvent,
} from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { jsonVar } from "@grasp-os/shared/config";
import { deadline } from "@grasp-os/shared/deadline";
import type { Deadline, Stopped } from "@grasp-os/shared/deadline";
import {
  defaultGatewayModels,
  modelGatewayConfigSchema as gatewayConfigSchema,
  modelRulesConfigSchema as rulesConfigSchema,
} from "@grasp-os/shared/deployment-config";
import type { ModelRules } from "@grasp-os/shared/deployment-config";
import {
  appIdSchema,
  connectionIdSchema,
  identifierSchema,
} from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  defaultModelEffort,
  modelEfforts,
  modelErrors,
  overBudgetMessage,
} from "@grasp-os/shared/models";
import type { ModelEffort, ModelEfforts } from "@grasp-os/shared/models";
import {
  authoritySchema,
  permissionErrors,
  workContextSchema,
} from "@grasp-os/shared/permissions";
import { quotaPolicyOf } from "@grasp-os/shared/quota-policy";
import type { QuotaPolicy } from "@grasp-os/shared/quota-policy";
import { modelBindingBudgetSchema } from "@grasp-os/shared/resource-bindings";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { keepAuditEvent } from "./audit-outbox.ts";
import {
  maxAskAgainSeconds,
  modelSharesOf,
  shareIdentity,
} from "./model-admission.ts";
import type { Fairness, ModelShare, ShareIdentity } from "./model-admission.ts";
import {
  bindingRequestMicros,
  bindingScopes,
  budgetPeriods,
  hasBudget,
  lineageModelRequests,
  scopesFor,
} from "./model-budgets.ts";
import { modelLedger } from "./model-ledger.ts";
import type {
  Admitted as LedgerAdmitted,
  LedgerScope,
  LedgerScopeName,
  Settled,
  Settlement,
} from "./model-ledger.ts";
import {
  boundMicros,
  costDollars,
  listPricesOf,
  microsPerDollar,
  pinnedPrice,
} from "./model-prices.ts";
import type { PinnedPrice, TokenCounts } from "./model-prices.ts";
import { bodyBytes, outputCapOf, unboundedBy } from "./model-requests.ts";
import { judgeCall } from "./model-rules.ts";
import type { Judged, Refusal } from "./model-rules.ts";
import { askAgainMs } from "./workflows/admission.ts";
import { quotaPolicy } from "./workflows/quotas.ts";

// The model gateway: every model call in a deployment goes through here, and
// from here through the deployment's AI Gateway, never straight to a
// provider. Core holds no provider key: AI Gateway pays with Workers AI,
// Unified Billing (Cloudflare credits) or the client's own keys stored in
// the gateway, and core reaches it over the AI binding, which needs no token
// either. Every request is audited as metadata only: who or what asked, why,
// the model, tokens and cost, never the prompt or the answer. The event goes
// through the audit outbox, so a request that was answered (and paid for)
// is recorded even when the audit log can't take it for a moment.
//
// Before anything is sent, a call is checked against the deployment's
// allowlist and its other rules (model-rules.ts). A refused call is
// audited too, with the reason, and nothing is sent.
//
// Only providers whose pi adapter takes a custom fetch can ride the binding.
// Google's refuses one, so Google models would need a gateway token over
// HTTPS, and aren't offered.

/**
 * The providers the gateway offers, by their AI Gateway path: the pi adapter
 * for the API their native endpoint speaks, and pi's catalog of their
 * models, which gives each model's limits and prices.
 */
const providers = {
  anthropic: {
    stream: anthropicMessages,
    catalog: ANTHROPIC_MODELS,
    path: "anthropic",
  },
  openai: {
    stream: openaiResponses,
    catalog: OPENAI_MODELS,
    path: "openai",
  },
  // Workers AI's own OpenAI-compatible endpoint, not the gateway's
  // cross-provider /compat layer, which drops provider features.
  "workers-ai": {
    stream: openaiCompletions,
    catalog: CLOUDFLARE_WORKERS_AI_MODELS,
    path: "workers-ai/v1",
  },
} as const;
type Provider = keyof typeof providers;

const isProvider = (value: string): value is Provider =>
  Object.hasOwn(providers, value);

/**
 * Workers AI counts the answer's cap against the model's window and refuses
 * a request whose total is over it, so answers are capped well below.
 */
const workersAiMaxTokens = 32_768;

/**
 * How long an answer may be when the call doesn't say: enough for a long
 * answer, well below what most models could write (and bill) in one go.
 */
const defaultMaxTokens = 16_384;

/**
 * An answer takes at most one in this many of the model's window.
 * Providers such as Workers AI count the answer's cap against the window
 * and refuse a request whose total is over it, so on a small one (Llama
 * 3.3's 24,000 tokens) an answer of the whole window would leave nothing
 * for the request itself.
 */
const windowPerAnswer = 4;

/**
 * The longest answer `model` can usefully give one request: its own
 * maximum, and no more than its share of the window. The one measure both
 * a model binding's approval and every call go by.
 */
const usableAnswer = (model: Model<Api>): number =>
  model.contextWindow > 0
    ? Math.min(
        model.maxTokens,
        Math.floor(model.contextWindow / windowPerAnswer)
      )
    : model.maxTokens;

/** The most tokens a request's answer may take, as the request says it. */
const answerTokens = (
  call: { maxTokens?: number },
  model: Model<Api>
): number => Math.min(call.maxTokens ?? defaultMaxTokens, usableAnswer(model));

/**
 * How long a call may take, retries included, when it doesn't say; and the
 * most it may ask for.
 */
const defaultTimeoutMs = 3 * 60_000;
const maxTimeoutMs = 15 * 60_000;

/**
 * Retries for a request the provider refused for a moment (429 or 5xx) or
 * that didn't connect; the provider SDKs back off in between.
 */
const maxRetries = 2;

interface ModelRef {
  provider: Provider;
  id: string;
  /** pi's descriptor, which points at the provider's own endpoint. */
  catalog: Model<Api>;
}

/**
 * A model as the gateway names it: `<provider>/<model>`, such as
 * `anthropic/claude-sonnet-5` or
 * `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Only models in pi's
 * catalog, so every call has a price.
 */
const parseModelRef = (ref: string): ModelRef | undefined => {
  const slash = ref.indexOf("/");
  const provider = ref.slice(0, slash);
  const id = ref.slice(slash + 1);
  if (slash === -1 || !isProvider(provider)) {
    return undefined;
  }
  const catalog: Readonly<Record<string, Model<Api>>> =
    providers[provider].catalog;
  // Own keys only, so `constructor` and the like are no model.
  const model = Object.hasOwn(catalog, id) ? catalog[id] : undefined;
  return model === undefined ? undefined : { provider, id, catalog: model };
};

const modelRefSchema = z
  .string()
  .refine((ref) => parseModelRef(ref) !== undefined, {
    message: "A <provider>/<model> the gateway offers",
  });

/** The allowlist in the `MODEL_GATEWAY` var, by the models pi offers. */
const modelGatewayConfigSchema = gatewayConfigSchema(modelRefSchema);
type ModelGatewayConfig = z.infer<typeof modelGatewayConfigSchema>;

/**
 * The client's other rules, in the same var (model-rules.ts). Parsed apart
 * from the allowlist: a rule that doesn't parse refuses every call.
 */
const modelRulesConfigSchema = rulesConfigSchema(modelRefSchema);

/**
 * Core's env, with the AI binding as pi describes it. It is absent on plain
 * workerd (on-prem), where no call can be made.
 */
export type ModelsEnv = Omit<Env, "AI"> & { AI?: AiBinding };

/**
 * The gateway config of a deployment whose `MODEL_GATEWAY` isn't set: the
 * account's default AI Gateway, which Cloudflare creates on its first use,
 * and Workers AI's models, which run on the account with no provider key.
 * So chat works on a new deployment, and in local development, where the
 * AI binding reaches Cloudflare with the developer's Wrangler login. The
 * var replaces all of it, to narrow the models or name another gateway.
 */
const defaultGatewayConfig = {
  gateway: "default",
  models: [...defaultGatewayModels],
};

/** The `MODEL_GATEWAY` var as set, or the default config without one. */
const gatewayVar = (env: ModelsEnv): unknown =>
  env.MODEL_GATEWAY === undefined
    ? defaultGatewayConfig
    : jsonVar(env.MODEL_GATEWAY);

/**
 * The deployment's model gateway config: deployment config, set by the
 * console as the `MODEL_GATEWAY` var, never an in-product setting, so an
 * admin session can't allow a model the client didn't agree to; the
 * default config while none is set. One that doesn't parse counts as none
 * at all: `undefined`, and every call fails closed.
 */
const modelGatewayConfig = (env: ModelsEnv): ModelGatewayConfig | undefined => {
  const parsed = modelGatewayConfigSchema.safeParse(gatewayVar(env));
  if (!parsed.success) {
    log.error("model.config_invalid", {
      paths: parsed.error.issues.map(({ path }) => path.join(".")).join(" "),
    });
    return undefined;
  }
  return parsed.data;
};

/**
 * The deployment's rules. `undefined` for rules that don't parse: every
 * call then fails closed.
 */
const modelRules = (env: ModelsEnv): ModelRules | undefined => {
  const parsed = modelRulesConfigSchema.safeParse(gatewayVar(env));
  if (!parsed.success) {
    log.error("model.rules_invalid", {
      paths: parsed.error.issues.map(({ path }) => path.join(".")).join(" "),
    });
    return undefined;
  }
  return parsed.data;
};

/**
 * The allowlist and the rules as they apply now, for admins to read
 * (models-rpc.ts): the allowed models, none while the config doesn't parse;
 * and the rules, `undefined` when they don't parse.
 */
export const gatewaySettings = (
  env: ModelsEnv
): { models: string[]; rules: ModelRules | undefined } => ({
  models: modelGatewayConfig(env)?.models ?? [],
  rules: modelRules(env),
});

/**
 * The thinking level a request asks `model` for: the call's effort, or
 * {@link defaultModelEffort}, as the model takes it. A level it lacks
 * becomes the next one up that it has, or its highest when it has none
 * above: pi's rule, which its OpenAI adapters apply anyway, applied here
 * for every provider (Anthropic's falls back its own way). So a call that
 * names none asks what it did before efforts. `undefined` for a model
 * that doesn't think, which pi then asks for none.
 */
const thinkingOf = (
  model: Model<Api>,
  effort?: ModelEffort
): ThinkingLevel | undefined => {
  if (!model.reasoning) {
    return undefined;
  }
  const level = clampThinkingLevel(model, effort ?? defaultModelEffort);
  return level === "off" ? undefined : level;
};

/**
 * The efforts `ref` takes, least first (those of {@link modelEfforts} its
 * catalog entry supports), and the one a call that names none gets
 * ({@link thinkingOf}). None for a model that doesn't think or isn't one
 * the gateway offers.
 */
export const modelEffortsOf = (ref: string): ModelEfforts => {
  const model = parseModelRef(ref)?.catalog;
  if (model === undefined) {
    return { levels: [], default: null };
  }
  const supported = new Set<string>(getSupportedThinkingLevels(model));
  const levels = modelEfforts.filter((effort) => supported.has(effort));
  const fallback = thinkingOf(model);
  return {
    levels,
    default: levels.find((effort) => effort === fallback) ?? null,
  };
};

/**
 * Whether the deployment's config keeps every call in the EU
 * (`eu.deployment`): for what sends data out of the Worker without being a model call,
 * such as Workers AI's document conversion (knowledge/extract.ts), which
 * then stays in the Worker. A config whose rules don't parse keeps it
 * there too: it fails closed. The default config has no EU rule.
 */
export const deploymentStaysInEu = (env: ModelsEnv): boolean => {
  const parsed = modelRulesConfigSchema.safeParse(gatewayVar(env));
  return !parsed.success || parsed.data.eu?.deployment === true;
};

/** What a call is for, such as `workflow.step` or `chat.turn`. */
const purposePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u;

/**
 * What every request says about itself: its model and limits, and what the
 * rules and the audit log go by. A call adds its conversation; an agent
 * loop's requests carry the loop's (`models(env).agent`).
 */
const sessionShape = {
  /** `<provider>/<model>`, one the deployment allows. */
  model: z.string().min(1),
  /**
   * The most tokens the answer may take: capped at what the model can
   * usefully give (`usableAnswer`), or refused for a call through a binding.
   */
  maxTokens: z.int().positive().optional(),
  /** How long a request may take, in milliseconds, retries included. */
  timeoutMs: z.int().positive().max(maxTimeoutMs).optional(),
  /**
   * How hard a model that thinks does so before it answers
   * ({@link thinkingOf}); {@link defaultModelEffort} without one.
   */
  effort: z.enum(modelEfforts).optional(),
  /** Why the call is made, for the audit log. */
  purpose: z.string().max(64).regex(purposePattern),
  /** Who or what asked: a person, an agent, an App or a workflow run. */
  trigger: auditActorSchema,
  /**
   * IDs of the resources that fed the prompt: all of them, however many,
   * as the rules judge by every one. The audit log records as many as its
   * event holds (`keepingProvenance`).
   */
  provenance: z.array(identifierSchema).default([]),
  /**
   * Connections whose data may have fed the prompt, such as a run's: for
   * the deployment's rules only, never recorded.
   */
  connections: z.array(connectionIdSchema).default([]),
  /**
   * Where the call works, and for whom: its restricted mode decides which
   * models it may use (model-rules.ts). Set by the host, like the
   * trigger. Required of every caller (`ModelCall`, `AgentSession`); while
   * the rules apply, a call without one is refused, as its restricted mode
   * can't be known.
   */
  work: z
    .union([
      z.strictObject({
        authority: authoritySchema,
        context: workContextSchema,
      }),
      /**
       * Core's own onboarding (onboarding/): reading the kickoff, Stephen's
       * turns. It carries what the company told Grasp, so the rules always
       * judge it as carrying sensitive data (model-rules.ts). Only core's
       * own code makes such a call: no App or client names a `work` here.
       */
      z.strictObject({ onboarding: z.literal(true) }),
    ])
    .optional(),
  requestId: auditEventSchema.shape.requestId,
  /**
   * For a workflow run's call: whose person share of the model requests in
   * flight it takes (model-admission.ts), from the run's row: who started
   * it, or its App's triggers' for a run nobody started. Set by core's host
   * only, never by App code; without it, a run's call takes its App's.
   */
  shareSubject: z.string().min(1).max(512).optional(),
  /**
   * The App's model binding the call is made through, with its own caps
   * (model-budgets.ts): set by core's model resource only, from the
   * binding's row, never by App code.
   */
  binding: z
    .strictObject({
      app: appIdSchema,
      alias: z.string().min(1).max(64),
      budget: modelBindingBudgetSchema.nullable(),
    })
    .optional(),
};

const sessionSchema = z.strictObject(sessionShape);
type Session = z.output<typeof sessionSchema>;

const callSchema = z
  .strictObject({
    ...sessionShape,
    /** Instructions: the system prompt. */
    system: z.string().optional(),
    /** One message to answer: text, or JSON sent as its text. */
    input: z.json().optional(),
    /** A conversation to continue, ending with the person's turn. */
    messages: z
      .array(
        z.strictObject({
          role: z.enum(["user", "assistant"]),
          content: z.string().min(1),
        })
      )
      .min(1)
      .optional(),
  })
  .refine(({ input, messages }) => (input === undefined) !== !messages, {
    message: "Either input or messages",
  })
  .refine(({ messages }) => messages?.at(-1)?.role !== "assistant", {
    message: "Messages end with the person's turn",
  });
type Call = z.output<typeof callSchema>;

/** One model call. */
export type ModelCall<Output> = z.input<typeof callSchema> & {
  /** Where the call works: required, so no caller can leave it out. */
  work: NonNullable<z.input<typeof callSchema>["work"]>;
  /**
   * The answer must be JSON that matches this schema: it is validated, and
   * the model asked once more when it doesn't match.
   */
  schema?: z.ZodType<Output>;
  /**
   * Whether an answer that doesn't fit `schema` is asked for once more
   * (the default). False when the call's token bound must hold for the
   * call as a whole rather than for each request (resource-model.ts).
   */
  askAgain?: boolean;
  /**
   * The caller's last check before each provider request is sent, after
   * the ledger admitted it, with nothing awaited between: it throws to
   * stop the request, which is then never sent (a workflow run's attempt
   * let go of meanwhile, resource-model.ts).
   */
  beforeSend?: () => void;
  /**
   * The caller's own authority, decided again once the ledger admitted
   * each provider request, before `beforeSend`: it throws to stop the
   * request, which is then never sent (a workflow run's call whose
   * approval or grant went while it waited, resource-calls.ts).
   */
  reauthorize?: () => Promise<void>;
  /**
   * Told while the call waits in the queue for a share of the model
   * requests in flight, each time it asks again: the share and when it
   * asks again at the latest (ms since the epoch); and `null` once it
   * stops waiting, admitted or not. For a workflow run to show it queued
   * (workflows/model-waits.ts). A failure of it never fails the call.
   */
  onQueued?: QueuedHook;
  /**
   * Cancels the call when its caller goes away: a request waiting for a
   * share stops waiting, and one under way is cut off.
   */
  signal?: AbortSignal;
  /**
   * Whether a request the provider refused for a moment (429 or 5xx), or
   * that didn't connect, is sent again (the default, `maxRetries`). False
   * where one call must be one request: a workflow run's model call, which
   * its run's limit of calls counts (resource-calls.ts).
   */
  providerRetries?: boolean;
};

/** Where a call waiting for a share stands, or `null` once it stopped waiting. */
export type QueuedHook = (
  queued: { waitingFor: ModelShare; retryAt: number } | null
) => Promise<void>;

/** What a call answered. */
export interface ModelAnswer<Output> {
  /** The answer's text. */
  text: string;
  /** The answer parsed with the call's schema; `undefined` without one. */
  output: Output;
  /** The model hit its output limit, so the text may stop short. */
  truncated: boolean;
  /** Across every request the call made. */
  usage: { inputTokens: number; outputTokens: number };
  /** In US dollars, at the provider's list prices. */
  cost: number;
}

/** The most tokens `ref`'s answers may take, as the gateway sends them. */
const maxTokensOf = (ref: ModelRef): number =>
  ref.provider === "workers-ai"
    ? Math.min(ref.catalog.maxTokens, workersAiMaxTokens)
    : ref.catalog.maxTokens;

/**
 * The model, pointed at the deployment's gateway over the AI binding: the
 * gateway's route for the provider's native API, the same path as over
 * HTTPS minus the account, which the binding carries.
 */
const gatewayModel = (gateway: string, ref: ModelRef): Model<Api> => ({
  ...ref.catalog,
  baseUrl: `https://workers-binding.ai/ai-gateway/gateways/${gateway}/${providers[ref.provider].path}`,
  maxTokens: maxTokensOf(ref),
});

/**
 * The longest answer model `<provider>/<model>` can usefully give one
 * request (`usableAnswer`); undefined for a model the gateway doesn't
 * offer. A model binding is approved only when its declaration's longest
 * request fits (resource-model.ts), and a call through a binding that asks
 * for more is refused, never cut short.
 */
export const usableAnswerTokens = (model: string): number | undefined => {
  const ref = parseModelRef(model);
  return ref === undefined
    ? undefined
    : usableAnswer({ ...ref.catalog, maxTokens: maxTokensOf(ref) });
};

const gatewayHeaders = (call: Session): ProviderHeaders => ({
  // The binding authenticates the request. pi still wants auth before it
  // sends, and the gateway strips this placeholder. The nulls drop the
  // SDKs' own auth headers, which the gateway would take for a caller's
  // provider key instead of using its stored ones.
  "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
  Authorization: null,
  "x-api-key": null,
  // The gateway logs metadata, never prompts or answers.
  "cf-aig-collect-log-payload": "false",
  // Never an answer from the gateway's cache, whatever the gateway is set
  // to (one the console adopted keeps its settings): a cached answer is
  // one person's, and would be served to another.
  "cf-aig-skip-cache": "true",
  // So the gateway's log can be searched by why and for what kind of
  // caller; identifiers only, like the audit event.
  "cf-aig-metadata": JSON.stringify({
    purpose: call.purpose,
    actor: call.trigger.type,
    ...(call.requestId === undefined ? {} : { requestId: call.requestId }),
  }),
});

const noUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The call's messages in pi's shape. */
const toMessages = (call: Call, model: Model<Api>): Message[] => {
  const timestamp = Date.now();
  if (call.messages === undefined) {
    const { input } = call;
    const content = typeof input === "string" ? input : JSON.stringify(input);
    return [{ role: "user", content, timestamp }];
  }
  return call.messages.map(({ role, content }): Message =>
    role === "user"
      ? { role, content, timestamp }
      : {
          role,
          content: [{ type: "text", text: content }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: noUsage,
          stopReason: "stop",
          timestamp,
        }
  );
};

const structuredInstructions = (schema: z.ZodType): string =>
  [
    "Answer with only a JSON value that matches this JSON Schema, and no other text:",
    JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" })),
  ].join("\n");

const answerText = (answer: AssistantMessage): string =>
  answer.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

const jsonFencePattern = /^```(?:json)?\s*(?<body>[\s\S]*?)\s*```$/u;

/** The answer's JSON parsed with the schema, or why it doesn't fit. */
const parseOutput = <Output>(
  text: string,
  schema: z.ZodType<Output>
): { ok: true; output: Output } | { ok: false; problem: string } => {
  const trimmed = text.trim();
  let value: unknown = undefined;
  try {
    value = JSON.parse(jsonFencePattern.exec(trimmed)?.groups?.body ?? trimmed);
  } catch {
    return { ok: false, problem: "it isn't JSON." };
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, output: parsed.data }
    : { ok: false, problem: z.prettifyError(parsed.error) };
};

/** Tokens the prompt took, cached or not. */
const inputTokens = ({ input, cacheRead, cacheWrite }: Usage): number =>
  input + cacheRead + cacheWrite;

const costOf = ({ cost }: Usage): number =>
  Number.isFinite(cost.total) && cost.total > 0 ? cost.total : 0;

/**
 * What a provider's count cost at the request's pinned prices, in the
 * tier its prompt is in, as the model ledger charges it; pi's own cost
 * where the model has no pinned prices or the count isn't one.
 */
const pricedCost = (price: PinnedPrice | undefined, usage: Usage): number => {
  const { input, output, cacheRead, cacheWrite } = usage;
  const tokens = { input, output, cacheRead, cacheWrite };
  return price !== undefined &&
    Object.values(tokens).every(
      (count) => Number.isSafeInteger(count) && count >= 0
    )
    ? costDollars(price, tokens)
    : costOf(usage);
};

const hasFailed = ({ stopReason }: AssistantMessage): boolean =>
  stopReason === "error" || stopReason === "aborted";

/**
 * Characters taken for one token where the provider gave no count: the
 * usual rule of thumb for text, not a tokenizer's count.
 */
const estimatedCharsPerToken = 4;

const estimatedTokens = (chars: number): number =>
  Math.ceil(chars / estimatedCharsPerToken);

/** The answer as far as it came: its text, reasoning and tool calls. */
const receivedChars = ({ content }: AssistantMessage): number => {
  let chars = 0;
  for (const block of content) {
    if (block.type === "text") {
      chars += block.text.length;
    } else if (block.type === "thinking") {
      chars += block.thinking.length;
    } else {
      chars += block.name.length + JSON.stringify(block.arguments).length;
    }
  }
  return chars;
};

/** A call the gateway took: its model, and what the rules made of it. */
interface Admitted {
  call: Session;
  ref: ModelRef;
  judged: Judged;
}

/** An admitted request's way to the model at the deployment's gateway. */
interface Route extends Admitted {
  model: Model<Api>;
  /** The AI binding's fetch, which reaches the gateway. */
  transport: FetchFunction;
  /** The prices its provider requests are pinned to; none for a model with none. */
  price: PinnedPrice | undefined;
  /**
   * The scopes a provider request sent now counts against, in this month,
   * its run lineage's limited by the quota policy in force now, and that
   * policy's generation (none for a call with no lineage). Throws when the
   * policy can't be read.
   */
  scopesNow: () => Promise<{
    period: string;
    scopes: LedgerScope[];
    policyGeneration: number | undefined;
    /** Whose shares of the requests in flight it takes, under the policy now. */
    fair: Fairness;
  }>;
  /**
   * What the call's provider requests may reserve together, under its
   * binding's cap per request, and what they hold of it now: each one's
   * reservation, less what settled below it. Its requests go one at a
   * time, so nothing races it. None without a cap.
   */
  perRequest: { limitMicros: number; heldMicros: number } | undefined;
  /** Core's env, for the model ledger. */
  env: ModelsEnv;
  /** The call's ID: its place in the queue while it waits for a share. */
  place: string;
  /** What its refusals may tell it of others' calls (model-admission.ts). */
  disclose: ShareIdentity["disclose"];
  /** The caller's last check before each provider request (`ModelCall.beforeSend`). */
  beforeSend?: () => void;
  /** The caller's authority, decided again (`ModelCall.reauthorize`). */
  reauthorize?: () => Promise<void>;
  /** Told while the call waits for a share (`ModelCall.onQueued`). */
  onQueued?: QueuedHook;
  /** The call's notes of its wait, one after another (`told`). */
  notes: Promise<void>;
  /** Whether a refused request is sent again (`ModelCall.providerRetries`). */
  providerRetries?: boolean;
}

interface Request extends Route {
  /** Ends the call when it takes too long, retries included. */
  signal: AbortSignal;
  /** When `signal` cuts the call off at the latest, in ms since the epoch. */
  endsAt: number;
  system: string | undefined;
  messages: Message[];
}

/** What the gateway said about a request, once it answered. */
interface GatewayResponse {
  status: number | undefined;
  logId: string | undefined;
  /** Characters of the request's body as sent; 0 before it was. */
  sentChars: number;
  /** What the log keeps of a response that refused the request. */
  refusal: ProviderRefusal | undefined;
  /**
   * Why the model ledger held a provider request back, unsent: no room in
   * a budget, or no ledger to account for it.
   */
  held: Refusal | undefined;
  /**
   * The provider request whose answer streams, admitted by the ledger and
   * waiting to be settled with what it used, and what it reserved.
   */
  pending: Admission | undefined;
  /** The provider requests already settled, in order: refused, failed or superseded. */
  settled: RequestSettled[];
  /**
   * The wait the last refusal for the provider's rate limit (429) calls
   * for, in seconds, as core bounds it (`rateLimitedSeconds`); none when
   * the last refusal was something else.
   */
  rateLimited: number | undefined;
}

/** A provider request the ledger admitted: its ID, and what it reserved. */
interface Admission {
  id: string;
  reservedMicros: number;
}

interface Sent extends GatewayResponse {
  answer: AssistantMessage;
}

/**
 * What the log keeps of a provider's refusal: the fields that name what
 * went wrong and can carry no content, never its message, which may quote
 * the prompt or a credential. Workers AI's `internalCode` and the JSON
 * pointers its message names, such as `/messages/2/content`, say which
 * part of the request it refused.
 */
interface ProviderRefusal {
  name: string | undefined;
  type: string | undefined;
  code: string | number | undefined;
  internalCode: number | undefined;
  /** The JSON pointers the message names, space-separated. */
  paths: string | undefined;
}

/** An identifier or a number, as a provider names its errors. */
const errorCodeSchema = z.union([
  z.string().regex(/^[A-Za-z][\w.-]{0,63}$/u),
  z.int(),
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A field of a refusal, if it is an identifier or a number. */
const codeOf = (value: unknown): string | number | undefined =>
  errorCodeSchema.safeParse(value).data;

/** A field of a refusal, if it is an identifier. */
const identifierOf = (value: unknown): string | undefined => {
  const code = codeOf(value);
  return typeof code === "string" ? code : undefined;
};

/** A field of the `error` in a refusal, as OpenAI and Anthropic nest it. */
const nestedOf = (error: unknown, field: "type" | "code"): unknown =>
  isRecord(error) ? error[field] : undefined;

/**
 * A JSON pointer in quotes, as Workers AI's schema errors name the part
 * of the request they refuse: lowercase names and indexes only, so it
 * can't carry a prompt's words or a key.
 */
const quotedPointerPattern = /'(?<path>(?:\/(?:[a-z_]{1,32}|\d{1,6})){1,8})'/gu;

/** The most JSON pointers the log keeps of one refusal. */
const maxLoggedPaths = 5;

/** The most of a refusal's body that is read. */
const maxRefusalChars = 64 * 1024;

/** What the log keeps of a refusal's body (`ProviderRefusal`). */
const refusalOf = (text: string): ProviderRefusal => {
  const body = text.slice(0, maxRefusalChars);
  let parsed: Record<string, unknown> | undefined = undefined;
  try {
    const value: unknown = JSON.parse(body);
    parsed = isRecord(value) ? value : undefined;
  } catch {
    // Not JSON: only its pointers are kept.
  }
  const paths = [
    ...new Set(
      Array.from(body.matchAll(quotedPointerPattern), (match) => match[1])
    ),
  ].slice(0, maxLoggedPaths);
  const internalCode = codeOf(parsed?.internalCode);
  return {
    name: identifierOf(parsed?.name),
    type:
      identifierOf(parsed?.type) ??
      identifierOf(nestedOf(parsed?.error, "type")),
    code: codeOf(parsed?.code) ?? codeOf(nestedOf(parsed?.error, "code")),
    internalCode: typeof internalCode === "number" ? internalCode : undefined,
    paths: paths.length === 0 ? undefined : paths.join(" "),
  };
};

/**
 * The request as Workers AI takes it. pi sends an assistant message that
 * only calls tools with `null` content, as OpenAI's API allows, but Workers
 * AI's models take text only and refuse the request (400, "Type mismatch
 * of '/messages/2/content', 'string' not in 'null'"): every request after
 * an agent's first tool call failed. Such content goes as empty text.
 */
const workersAiPayload = (payload: unknown): unknown => {
  if (!(isRecord(payload) && Array.isArray(payload.messages))) {
    return undefined;
  }
  return {
    ...payload,
    messages: payload.messages.map((message: unknown) =>
      isRecord(message) &&
      message.role === "assistant" &&
      message.content === null
        ? { ...message, content: "" }
        : message
    ),
  };
};

/**
 * Tokens a provider may add to a prompt beyond what its request body
 * holds, such as the instructions Anthropic adds for tools, and each
 * message's role markers beyond what its JSON takes. The rest of the
 * prompt is bounded by the body's size: a token is at least one byte of
 * the text it stands for.
 */
const promptAllowanceTokens = 1024;

/**
 * How long after a call's deadline a provider request still unsettled is
 * charged its whole reservation (model-ledger.ts).
 */
const reconcileGraceMs = 5 * 60_000;

/**
 * The wait a refusal for a budget held by calls under way suggests. An
 * advisory hint: asking again sooner is only refused again.
 *
 * Where every full scope is the caller's own (their user scope, their
 * run), the calls holding it are theirs: the wait runs until the soonest
 * call under way in each scope reaches its deadline (the ledger's
 * `heldUntil`), rounded up to a whole step, and no longer than the most.
 * Optimistic, as that call may not free enough on its own; bounded, so a
 * caller asks again and is told afresh rather than wait out a long call.
 *
 * A shared scope (the deployment, a workflow) is held by other people's
 * calls too. A derived wait would give away when they were sent: polling
 * would show the second it drops a step. Such a refusal suggests a fixed
 * wait. That removes only the timing of when they were sent: being told
 * the budget is busy at all still says other calls are under way, and its
 * turning into an admission (or out of budget) says when they finished.
 */
const busyRetry = { stepSeconds: 15, mostSeconds: 300, sharedSeconds: 60 };

/** The scopes a caller's own calls alone count against. */
const ownScopes: ReadonlySet<LedgerScopeName> = new Set(["user", "run"]);

/** The seconds to wait before asking again, for a budget held until `heldUntil`. */
const retryAfterSeconds = (
  heldBy: readonly LedgerScopeName[],
  heldUntil: number
): number => {
  if (!heldBy.every((scope) => ownScopes.has(scope))) {
    return busyRetry.sharedSeconds;
  }
  const waitMs = heldUntil - Date.now();
  const steps = Math.max(1, Math.ceil(waitMs / 1000 / busyRetry.stepSeconds));
  return Math.min(steps * busyRetry.stepSeconds, busyRetry.mostSeconds);
};

/**
 * The longest a call waits in the gateway for a share of the requests in
 * flight, asking again as it goes, before it is refused as `model.queued`:
 * never more than half of what is left of its own time either, so a
 * request admitted at the end of it still has time to answer.
 */
const queueWaitMs = 30_000;

/** A `retry-after` in whole seconds, as opposed to a date. */
const wholeSecondsPattern = /^\d+$/u;

/** A `retry-after-ms`: a number of milliseconds, perhaps with a fraction. */
const decimalPattern = /^\d+(?:\.\d+)?$/u;

/** The least, the most and the default wait a provider's rate limit is held to. */
const rateLimitBounds = {
  leastSeconds: 1,
  mostSeconds: 60,
  defaultSeconds: 30,
};

/**
 * The wait a provider's rate limit calls for, in seconds, read from its
 * refusal's `retry-after-ms` or `retry-after` (seconds, or a date) as a
 * hint, never trusted: held between {@link rateLimitBounds}, its default
 * where it names none that can be read. Core sets the bounds, so no
 * provider, or anything between, makes a caller wait for ever or hammer
 * it.
 */
const rateLimitedSeconds = (headers: Headers, now = Date.now()): number => {
  const { leastSeconds, mostSeconds, defaultSeconds } = rateLimitBounds;
  // A blank or unreadable `retry-after-ms` is none: it never stands in
  // for a readable `retry-after`.
  const msTold = headers.get("retry-after-ms")?.trim() ?? "";
  const ms = decimalPattern.test(msTold) ? Number(msTold) : Number.NaN;
  const told = headers.get("retry-after");
  let seconds = Number.NaN;
  if (Number.isFinite(ms)) {
    seconds = ms / 1000;
  } else if (told !== null && wholeSecondsPattern.test(told.trim())) {
    seconds = Number(told.trim());
  } else if (told !== null) {
    seconds = (Date.parse(told) - now) / 1000;
  }
  if (!Number.isFinite(seconds)) {
    return defaultSeconds;
  }
  return Math.min(mostSeconds, Math.max(leastSeconds, Math.ceil(seconds)));
};

/** The longest a used-up budget's refusal says to wait: a month. */
const mostResetSeconds = 31 * 24 * 60 * 60;

/**
 * The seconds until a budget of `scope` used up at `now` resets: the next
 * UTC day for a binding's day, the next UTC month for any other, as the
 * ledger counts them (model-budgets.ts); none for a run lineage, which
 * never resets, nor a binding's cap per request, which no wait helps.
 */
const resetSeconds = (scope: string, now = new Date()): number | undefined => {
  if (scope === "run" || scope === "binding_request") {
    return undefined;
  }
  const resetsAt =
    scope === "binding_day"
      ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
      : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.min(
    mostResetSeconds,
    Math.max(1, Math.ceil((resetsAt - now.getTime()) / 1000))
  );
};

/** Waits `ms`, or until `signal` aborts, whichever comes first. */
const pause = async (ms: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) {
    return;
  }
  // Cut short when the call is: the loop then sees it aborted.
  await scheduler.wait(ms, { signal }).catch(() => null);
};

/**
 * The longest the gateway waits for a caller's `onQueued` before going on
 * without it: a best-effort note, which never holds up an admission, a
 * place given up or a request admitted.
 */
const queuedHookMs = 2000;

/**
 * Tells `route`'s caller where its wait stands; never fails, nor holds up,
 * the call. Its notes run one after another, each once the one before
 * it is done, even one the gateway stopped waiting for: a slow note never
 * lands after a newer one, so the last a caller records is the latest.
 */
const told = async (
  route: Route,
  queued: Parameters<QueuedHook>[0]
): Promise<void> => {
  const { onQueued } = route;
  if (onQueued === undefined) {
    return;
  }
  const before = route.notes;
  const note = async (): Promise<void> => {
    await before;
    try {
      await onQueued(queued);
    } catch (error) {
      log.error("model.queued_hook_failed", errorFields(error));
    }
  };
  const noted = note();
  route.notes = noted;
  const timer = new AbortController();
  try {
    await Promise.race([
      noted,
      scheduler
        .wait(queuedHookMs, { signal: timer.signal })
        .then(() => {
          log.warn("model.queued_hook_slow", { waitedMs: queuedHookMs });
        })
        // Stopped once the hook answered first.
        .catch(() => null),
    ]);
  } finally {
    timer.abort();
  }
};

/** Gives up `route`'s call's place in the queue; its place lapses should this fail. */
const leaveQueue = async (route: Route): Promise<void> => {
  try {
    await modelLedger(route.env).leaveQueue(route.place);
  } catch (error) {
    log.warn("model.leave_queue_failed", errorFields(error));
  }
};

/** The prices of a model that has none, which no budget admits. */
const unpriced: PinnedPrice = {
  version: "unpriced",
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  tiers: [],
};

/**
 * The response a provider request held back by the ledger gets instead
 * of being sent: a refusal the provider SDKs don't retry.
 */
const heldResponse = (): Response =>
  Response.json({ error: { type: "grasp_held" } }, { status: 400 });

/**
 * Settles provider request `id` in the model ledger. Never throws: a
 * request the ledger doesn't hear about stays reserved, and is charged
 * its whole reservation when it comes due.
 */
const settleRequest = async (
  env: ModelsEnv,
  id: string,
  settlement: Settlement
): Promise<Settled | undefined> => {
  try {
    return await modelLedger(env).settle(id, settlement);
  } catch (error) {
    log.error("model.settle_failed", {
      ...errorFields(error),
      by: settlement.by,
    });
    return undefined;
  }
};

/**
 * Settles provider request `admission` of `route`'s call, as
 * `settleRequest` does, and gives back to its cap per request what it
 * settled below its reservation: everything, for one the ledger has no
 * record of. One whose outcome is unknown keeps holding all of it.
 */
const settleAdmitted = async (
  route: Route,
  admission: Admission,
  settlement: Settlement
): Promise<RequestSettled> => {
  const settled = await settleRequest(route.env, admission.id, settlement);
  // Charged what it used, never clamped: that is what the provider bills.
  // Above its reservation it means the bound was wrong, which budgets
  // rely on.
  if (
    settled?.state === "settled" &&
    settled.chargedMicros > admission.reservedMicros
  ) {
    log.warn("model.charge_over_reservation", {
      model: route.call.model,
      reservedMicros: admission.reservedMicros,
      chargedMicros: settled.chargedMicros,
    });
  }
  const { perRequest } = route;
  if (perRequest !== undefined && settled?.state === "settled") {
    perRequest.heldMicros -= admission.reservedMicros - settled.chargedMicros;
  } else if (perRequest !== undefined && settled?.state === "missing") {
    perRequest.heldMicros -= admission.reservedMicros;
  }
  return { reservedMicros: admission.reservedMicros, settled };
};

/** `route`'s scopes now, or held back when the quota policy can't be read. */
const scopesRead = async (
  route: Route
): Promise<Awaited<ReturnType<Route["scopesNow"]>> | { held: Refusal }> => {
  try {
    return await route.scopesNow();
  } catch (error) {
    // No lineage's request limit, so nothing is admitted.
    log.error("model.quota_policy_failed", errorFields(error));
    return { held: { code: "model.quota_policy_unavailable" } };
  }
};

/**
 * Why the ledger's refusal `admitted` holds back a request of `call`, as
 * its share identity may be told (`disclose`, model-admission.ts).
 */
const heldBecause = (
  call: Session,
  admitted: Exclude<
    LedgerAdmitted,
    { ok: true } | { policyBehind: true; highest: number }
  >,
  disclose: ShareIdentity["disclose"]
): Refusal => {
  // A guest is told nothing shaped by anyone else's calls.
  const fixed = disclose === "fixed";
  if ("queued" in admitted) {
    const { queued } = admitted;
    // Never which person's share is full, nor a wait from leases.
    const waitingFor =
      fixed && queued.waitingFor === "person" ? "client" : queued.waitingFor;
    return {
      code: "model.queued",
      because: waitingFor,
      waitingFor,
      retryAfterSeconds: fixed ? maxAskAgainSeconds : queued.retryAfterSeconds,
      placed: queued.placed,
    };
  }
  if ("unpriced" in admitted) {
    return { code: "model.unpriced" };
  }
  // The run lineage's own limits: no wait helps a lineage out of
  // requests, nor one whose spend leaves no room.
  if ("requests" in admitted) {
    return { code: "model.run_limit", because: "requests" };
  }
  if ("reused" in admitted) {
    // Never expected: every ID is a new UUID.
    log.error("model.request_id_reused", { model: call.model });
    return { code: "model.ledger_unavailable" };
  }
  // A guest spends the budgets of the member who invited them: whether
  // that member has calls under way is theirs to know. Held or used up,
  // in any scope, a guest hears the same: used up, with no wait.
  if (fixed) {
    return {
      code: "model.over_budget",
      because: admitted.scope,
      capUntold: true,
    };
  }
  if ("heldUntil" in admitted) {
    return {
      code: "model.budget_busy",
      because: admitted.scope,
      retryAfterSeconds: retryAfterSeconds(admitted.heldBy, admitted.heldUntil),
    };
  }
  if (admitted.scope === "run") {
    return { code: "model.run_limit", because: "spend" };
  }
  // Used up until it resets: when, which says nothing of anyone's calls.
  const resets = resetSeconds(admitted.scope);
  return {
    code: "model.over_budget",
    because: admitted.scope,
    ...(resets === undefined ? {} : { retryAfterSeconds: resets }),
  };
};

/**
 * Asks the model ledger to admit one provider request, with the body it
 * will send: reserves the most it can cost, its prompt bounded by the
 * body's size and its answer by the cap the body sets (or the model's,
 * where it sets none), at the model's pinned prices. Its ID, or why it
 * is held back. Asked once more, under the quota policy read again, when
 * the ledger already admitted under a newer one (`retried`).
 */
const admitRequest = async (
  route: Route,
  body: unknown,
  endsAt: number,
  retried = false
): Promise<Admission | { held: Refusal }> => {
  const { env, call, model, price, perRequest } = route;
  const now = await scopesRead(route);
  if ("held" in now) {
    return now;
  }
  const { period, scopes, policyGeneration, fair } = now;
  const budgeted = hasBudget(scopes) || perRequest !== undefined;
  if (price === undefined && budgeted) {
    return { held: { code: "model.unpriced" } };
  }
  // Never expected: the gateway sends text only, at list prices.
  const unbounded = unboundedBy(body);
  if (unbounded !== undefined) {
    log.error("model.unbounded_request", { model: call.model, unbounded });
    return { held: { code: "model.unpriced" } };
  }
  const bytes = bodyBytes(body);
  const outputTokens = outputCapOf(body) ?? model.maxTokens;
  if (bytes === undefined || !(outputTokens > 0)) {
    // Never expected: the provider SDKs send JSON, with a cap.
    log.error("model.unbounded_request", { model: call.model });
    return { held: { code: "model.ledger_unavailable" } };
  }
  // Priced at the dearest tier the prompt may reach: Anthropic's
  // long-context premium too, a tier of its own (model-prices.ts).
  const promptBound = bytes + promptAllowanceTokens;
  const pinned = price ?? unpriced;
  const id = crypto.randomUUID();
  // The call's own cut-off, which a retry or a second ask shares: never a
  // whole timeout from now.
  const callDeadline = endsAt;
  const reservedMicros = boundMicros(pinned, {
    inputTokens: promptBound,
    outputTokens,
  });
  // The binding's cap per request holds the App's request as a whole: a
  // second attempt or a retry needs room beside what the earlier ones
  // still hold, an unknown outcome all of its reservation.
  if (
    perRequest !== undefined &&
    perRequest.heldMicros + reservedMicros > perRequest.limitMicros
  ) {
    return { held: { code: "model.over_budget", because: "binding_request" } };
  }
  try {
    const admitted = await modelLedger(env).admit({
      id,
      period,
      scopes,
      model: call.model,
      price: pinned,
      reservedMicros,
      actor: call.trigger,
      deadline: callDeadline,
      reconcileAt: callDeadline + reconcileGraceMs,
      ...(policyGeneration === undefined ? {} : { policyGeneration }),
      fair,
    });
    if ("policyBehind" in admitted) {
      if (!retried) {
        return await admitRequest(route, body, endsAt, true);
      }
      // Never expected: core records a generation before any admission
      // carries it, and reads the highest it recorded. A ledger ahead of
      // core (core's database restored, say) holds back every workflow's
      // call until core's policy passes it: logged with both generations,
      // and refused for what it is, never as a ledger outage.
      log.error("model.quota_policy_behind", {
        model: call.model,
        generation: policyGeneration,
        ledgerGeneration: admitted.highest,
      });
      return { held: { code: "model.quota_policy_behind" } };
    }
    if (admitted.ok) {
      if (perRequest !== undefined) {
        perRequest.heldMicros += reservedMicros;
      }
      return { id, reservedMicros };
    }
    return { held: heldBecause(call, admitted, route.disclose) };
  } catch (error) {
    log.error("model.ledger_failed", errorFields(error));
    // The admission may have committed with its answer lost: nothing was
    // sent, so it is released, or charged in full if even that fails.
    await settleRequest(env, id, { by: "unsent" });
    return { held: { code: "model.ledger_unavailable" } };
  }
};

/** How a call's wait for a share went, for its one way out (`admitWaiting`). */
interface Waiting {
  /** The rounds it waited. */
  rounds: number;
  /** Whether the ledger ever gave it a place in the queue. */
  placed: boolean;
}

/**
 * The rounds of `admitWaiting`: asks the ledger, and while a share is full
 * and its call may wait, waits and asks again. Cancellation is checked
 * before every ask after the first, right after each wait too, so a call
 * cancelled while it waits asks nothing more.
 */
const askUntilServed = async (
  route: Route,
  body: unknown,
  {
    endsAt,
    signal,
    maxWaitMs,
  }: { endsAt: number; signal: AbortSignal; maxWaitMs: number },
  waiting: Waiting
): Promise<Admission | { held: Refusal }> => {
  const startedAt = Date.now();
  // Every moment since it began counts, its asks and notes too, not only
  // its sleeps. A call waits in memory, journaling nothing, so it asks
  // again as soon as the ledger says a share comes free, its backoff at
  // most.
  const msLeft = (hintSeconds: number): number =>
    Math.min(
      askAgainMs({
        waited: waiting.rounds,
        waitedMs: Date.now() - startedAt,
        maxWaitMs,
      }),
      hintSeconds * 1000
    );
  let last: { held: Refusal } | undefined = undefined;
  for (;;) {
    // Cancelled since it last asked: it asks no more, and stops as
    // cancelled, not as queued (its place given up on the way out).
    if (last !== undefined) {
      signal.throwIfAborted();
    }
    // Out of time since it last asked: told it is queued.
    if (last !== undefined && Date.now() - startedAt >= maxWaitMs) {
      return last;
    }
    // oxlint-disable-next-line no-await-in-loop -- asked again after each wait
    const admitted = await admitRequest(route, body, endsAt);
    // A ledger whose answer was lost may have kept a place for it all the
    // same: given up on the way out, as one it was told of.
    waiting.placed ||=
      "held" in admitted && admitted.held.code === "model.ledger_unavailable";
    if (!("held" in admitted) || admitted.held.code !== "model.queued") {
      return admitted;
    }
    last = admitted;
    waiting.placed ||= admitted.held.placed === true;
    const retryAfter = admitted.held.retryAfterSeconds ?? maxAskAgainSeconds;
    // The caller's word: a workflow attempt let go of stops waiting (it
    // throws).
    route.beforeSend?.();
    // Cancelled: it stops as cancelled.
    signal.throwIfAborted();
    // Out of time, or given no place (its person's, its App's or the
    // client's places all taken): told so at once, and the ledger asked
    // nothing more for it.
    if (msLeft(retryAfter) <= 0 || admitted.held.placed === false) {
      return admitted;
    }
    const { waitingFor = "client" } = admitted.held;
    // When it asks again at the latest, as others who see it waiting (a
    // run's viewers) are told: the fixed wait, never one taken from its
    // person's leases, which would tell when their other calls were sent.
    // oxlint-disable-next-line no-await-in-loop -- each round
    await told(route, {
      waitingFor,
      retryAt: Date.now() + maxAskAgainSeconds * 1000,
    });
    // Its sleep, worked out after the note, which takes time too: never
    // past the time it may wait.
    // oxlint-disable-next-line no-await-in-loop -- each round
    await pause(Math.max(0, msLeft(retryAfter)), signal);
    waiting.rounds += 1;
  }
};

/**
 * `admitRequest`, waiting in the queue while a share of the requests in
 * flight is full: the call keeps its place and asks again, as soon as the
 * ledger says (`askAgainMs`), until admitted, refused for anything else, or
 * out of the time it may wait (`queueWaitMs`); then refused as
 * `model.queued`. It stops early when its caller says so (`beforeSend`,
 * which throws) or it is cancelled. Its caller is told where it stands each
 * round (`onQueued`).
 *
 * One way out, however the wait ends (admitted, refused for anything, out
 * of time, cancelled, stopped by its caller, a policy that can't be read,
 * a ledger that throws): a call that held a place and wasn't admitted
 * gives it up, so no abandoned place holds others back while it lapses,
 * and a caller told it waited is told it stopped.
 */
const admitWaiting = async (
  route: Route,
  body: unknown,
  { endsAt, signal }: { endsAt: number; signal: AbortSignal }
): Promise<Admission | { held: Refusal }> => {
  const maxWaitMs = Math.min(
    queueWaitMs,
    Math.max(0, Math.floor((endsAt - Date.now()) / 2))
  );
  const waiting: Waiting = { rounds: 0, placed: false };
  let admission: Admission | undefined = undefined;
  try {
    const answered = await askUntilServed(
      route,
      body,
      { endsAt, signal, maxWaitMs },
      waiting
    );
    if (!("held" in answered)) {
      admission = answered;
    }
    return answered;
  } finally {
    // An admission took its place out of the queue itself.
    if (admission === undefined && waiting.placed) {
      await leaveQueue(route);
    }
    if (waiting.rounds > 0) {
      await told(route, null);
    }
  }
};

/** `init` with the provider request's ID in the gateway log's metadata. */
const withRequestId = (
  init: RequestInit | undefined,
  id: string
): RequestInit => {
  const headers = new Headers(init?.headers);
  let metadata: unknown = undefined;
  try {
    metadata = JSON.parse(headers.get("cf-aig-metadata") ?? "{}");
  } catch {
    metadata = {};
  }
  headers.set(
    "cf-aig-metadata",
    JSON.stringify({
      ...(isRecord(metadata) ? metadata : {}),
      providerRequest: id,
    })
  );
  return { ...init, headers };
};

/**
 * Opens one request through the gateway: the model's answer as it streams
 * in, and the gateway's response once it came. pi reports a failed request
 * as a final error event instead of throwing.
 */
const open = (
  route: Route,
  context: TranscriptContext,
  { signal, endsAt }: { signal: AbortSignal; endsAt: number }
) => {
  const { model, ref, call, transport } = route;
  const response: GatewayResponse = {
    status: undefined,
    logId: undefined,
    sentChars: 0,
    refusal: undefined,
    held: undefined,
    pending: undefined,
    settled: [],
    rateLimited: undefined,
  };
  // Each provider request, the SDK's retries too, is admitted by the
  // model ledger before it is sent, and held back unsent when it isn't.
  // One the provider refused is settled at nothing; one whose fate can't
  // be known keeps its reservation; the one whose answer streams is
  // settled once the answer ends (`record`). Besides, the request's size
  // as sent, should what it used have to be estimated (`usedBy`); and
  // what a refusal's body says went wrong, which the provider SDKs drop
  // when it isn't in their provider's shape (Workers AI's has no `error`,
  // so OpenAI's SDK reports "400 status code (no body)").
  const measured: FetchFunction = async (input, init) => {
    const admitted = await admitWaiting(route, init?.body, { endsAt, signal });
    if ("held" in admitted) {
      response.held = admitted.held;
      return heldResponse();
    }
    // The caller's last word, after the ledger's admission, with nothing
    // awaited before the request is sent: refused, it is never sent, and
    // its reservation goes back.
    try {
      await route.reauthorize?.();
      route.beforeSend?.();
      // Cancelled while it was admitted, or while its wait was cleared: it
      // is never sent, and its reservation goes back whole.
      signal.throwIfAborted();
    } catch (error) {
      response.settled.push(
        await settleAdmitted(route, admitted, { by: "unsent" })
      );
      throw error;
    }
    response.sentChars = typeof init?.body === "string" ? init.body.length : 0;
    let answered;
    try {
      // Only this request's own answer says whether it was rate-limited.
      response.rateLimited = undefined;
      answered = await transport(input, withRequestId(init, admitted.id));
    } catch (error) {
      response.settled.push(
        await settleAdmitted(route, admitted, { by: "unknown" })
      );
      throw error;
    }
    response.refusal = undefined;
    response.rateLimited =
      answered.status === 429
        ? rateLimitedSeconds(answered.headers)
        : undefined;
    if (!answered.ok) {
      // A refusal before the provider took the request on costs nothing;
      // a server error may have come after it did.
      response.settled.push(
        await settleAdmitted(route, admitted, {
          by: answered.status < 500 ? "refused" : "unknown",
        })
      );
      response.refusal = refusalOf(await answered.clone().text());
      return answered;
    }
    if (response.pending !== undefined) {
      response.settled.push(
        await settleAdmitted(route, response.pending, { by: "unknown" })
      );
    }
    response.pending = admitted;
    return answered;
  };
  // SAFETY: the provider picks both the adapter and the catalog the model
  // comes from, so the model always speaks the adapter's API.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const adapter = providers[ref.provider].stream as StreamFunction<
    Api,
    SimpleStreamOptions
  >;
  const events = adapter(model, context, {
    fetch: measured,
    headers: gatewayHeaders(call),
    maxTokens: answerTokens(call, model),
    maxRetries: route.providerRetries === false ? 0 : maxRetries,
    // Without a level pi turns reasoning off.
    reasoning: thinkingOf(model, call.effort),
    signal,
    onPayload: ref.provider === "workers-ai" ? workersAiPayload : undefined,
    onResponse: ({ status, headers }) => {
      response.status = status;
      response.logId = headers["cf-aig-log-id"];
    },
  });
  return { events, response };
};

/** Sends one request through the gateway and waits for the whole answer. */
const send = async (request: Request): Promise<Sent> => {
  const { system, messages, signal, endsAt } = request;
  const { events, response } = open(
    request,
    normalizeContext({ systemPrompt: system, messages }),
    { signal, endsAt }
  );
  const answer = await events.result();
  return { answer, ...response };
};

/**
 * The HTTP status at the start of pi's text for a refused request, in each
 * adapter's form: `429 {…}`, `429: {…}` or `OpenAI API error (429): {…}`.
 * pi fails such a request before `onResponse`, so this is the only place
 * the status is.
 */
const failedStatusPattern =
  /^(?:OpenAI API error \()?(?<status>[1-5]\d{2})(?:\):|:)?\s/u;

const errorTypeSchema = z.string().regex(/^[A-Za-z][\w.-]{0,63}$/u);

/**
 * The provider's error body, as pi quotes it after the status: Anthropic's
 * `{ error: { type } }`, or the `{ type }` pi takes from OpenAI's.
 */
const providerErrorSchema = z.union([
  z.object({ error: z.object({ type: errorTypeSchema }) }),
  z.object({ type: errorTypeSchema }),
]);

/** Why a request failed, as far as can be told without its message. */
interface Failure {
  status: number | undefined;
  /**
   * The provider's error type, such as `rate_limit_error`, or `timeout` or
   * `cancelled` when it was stopped here.
   */
  errorType: string | undefined;
}

const providerErrorType = (text: string): string | undefined => {
  const start = text.indexOf("{");
  if (start === -1) {
    return undefined;
  }
  let body: unknown = undefined;
  try {
    body = JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
  const parsed = providerErrorSchema.safeParse(body);
  if (!parsed.success) {
    return undefined;
  }
  return "error" in parsed.data ? parsed.data.error.type : parsed.data.type;
};

/**
 * What failed: the status and the provider's error type, never the error's
 * message, which may quote the prompt.
 */
const failureOf = (
  { answer, status }: Sent,
  stopped: Stopped | undefined
): Failure => {
  if (stopped !== undefined) {
    return { status, errorType: stopped };
  }
  const text = answer.errorMessage?.trim() ?? "";
  const quoted = failedStatusPattern.exec(text)?.groups?.status;
  return {
    status: quoted === undefined ? status : Number(quoted),
    errorType: providerErrorType(text),
  };
};

/**
 * A failed request as the log records it: the status and error type, and
 * what the provider's refusal says went wrong, where there was one
 * (`ProviderRefusal`). Never free text from the provider or pi: their
 * messages may quote the prompt or a credential.
 */
const failureFields = (
  model: string,
  { answer, refusal }: Sent,
  { status, errorType }: Failure
) => ({
  model,
  status,
  errorType,
  stopReason: answer.stopReason,
  providerErrorName: refusal?.name,
  providerErrorType: refusal?.type,
  providerErrorCode: refusal?.code,
  providerInternalCode: refusal?.internalCode,
  providerErrorPaths: refusal?.paths,
});

/** A failure in our own words, for whoever reads the answer. */
const failureMessage = ({ status, errorType }: Failure): string => {
  if (errorType === "cancelled") {
    return "The model call was cancelled.";
  }
  const cause = [status, errorType].filter((part) => part !== undefined);
  return cause.length === 0
    ? "The model call failed."
    : `The model call failed (${cause.join(" ")}).`;
};

/** How one request ended, as the audit log records it. */
type Outcome =
  | "answered"
  | "truncated"
  | "invalid_output"
  | "failed"
  | "cancelled";

/** What one request used, and cost in US dollars. */
interface Used {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** Whether any of it is an estimate, not the provider's count. */
  estimated: boolean;
}

/**
 * What a request used, as the provider counted it, and where it didn't,
 * an estimate. A request the provider began to answer and that then
 * failed, timed out or was cancelled comes without a full count: chat
 * completions and OpenAI's responses count in their last event only, and
 * Anthropic counts the answer at its end. Counted as nothing, someone at
 * their budget could start answers and cancel them for free. So the
 * prompt, if it wasn't counted, is taken from the request's size as sent,
 * and the answer from what came of it, if that is more than was counted,
 * at {@link estimatedCharsPerToken} characters a token and the model's
 * list prices. A request that got no response is charged nothing: the
 * provider may not have taken it.
 */
const usedBy = (
  { ref, price }: Pick<Route, "ref" | "price">,
  sent: Sent
): Used => {
  const { answer, status } = sent;
  const counted = {
    inputTokens: inputTokens(answer.usage),
    outputTokens: answer.usage.output,
    cost: pricedCost(price, answer.usage),
  };
  const responded = status !== undefined && status >= 200 && status < 300;
  if (!(responded && hasFailed(answer))) {
    return { ...counted, estimated: false };
  }
  const input = counted.inputTokens > 0 ? 0 : estimatedTokens(sent.sentChars);
  const output = Math.max(
    0,
    estimatedTokens(receivedChars(answer)) - counted.outputTokens
  );
  const { usage } = answer;
  const { cost: rates } = ref.catalog;
  return {
    inputTokens: counted.inputTokens + input,
    outputTokens: counted.outputTokens + output,
    // At the pinned prices, in the tier the count and the estimate reach
    // together; the catalog's (per million tokens) for a model with none.
    cost:
      price === undefined
        ? counted.cost +
          (input * rates.input + output * rates.output) / 1_000_000
        : pricedCost(price, {
            ...usage,
            input: usage.input + input,
            output: usage.output + output,
          }),
    estimated: input + output > 0,
  };
};

/** What the audit log records of one request. */
interface Recorded extends Used {
  logId: string | undefined;
  attempt: number;
  outcome: Outcome;
  status: number | undefined;
  errorType: string | undefined;
  /** How the model ledger settled its provider request (`ledgerOf`). */
  ledger: Ledgered;
}

/**
 * How the model ledger settled a request's provider request, as its audit
 * event records it, so the event and the ledger agree: `settled` at what
 * it charged; `unknown`, holding its whole reservation until it is charged
 * that in full; `quarantined`, held for a person; `missing` or `failed`
 * when the ledger had none or couldn't be reached (the reservation, if
 * any, is charged in full when it comes due); `none` when nothing was
 * sent.
 */
interface Ledgered {
  /** How the last of them settled. */
  state: "settled" | "unknown" | "quarantined" | "missing" | "failed" | "none";
  /** How many provider requests were sent, retries included. */
  requests: number;
  /** What they were charged, in US dollars; null when none were sent. */
  charged: number | null;
  /**
   * What their reservations still hold, in US dollars, to be charged in
   * full or settled by a person; null when none were sent.
   */
  held: number | null;
}

/** One provider request's settlement, with what it reserved. */
interface RequestSettled {
  reservedMicros: number;
  /** `undefined` when the ledger couldn't be reached to settle it. */
  settled: Settled | undefined;
}

/** What a settlement holds still: all its reservation, unless settled or missing. */
const heldBy = ({ reservedMicros, settled }: RequestSettled): number =>
  settled?.state === "settled" || settled?.state === "missing"
    ? 0
    : reservedMicros;

/**
 * What the audit event records of how the ledger settled every provider
 * request a call's attempt sent: a retry the SDK made after a server error
 * too, whose reservation stays held, so the event accounts for all of it.
 */
const ledgerOf = (settlements: readonly RequestSettled[]): Ledgered => {
  const last = settlements.at(-1);
  if (last === undefined) {
    return { state: "none", requests: 0, charged: null, held: null };
  }
  const charged = settlements.reduce(
    (sum, { settled }) =>
      sum + (settled?.state === "settled" ? settled.chargedMicros : 0),
    0
  );
  const held = settlements.reduce((sum, one) => sum + heldBy(one), 0);
  return {
    state: last.settled?.state ?? "failed",
    requests: settlements.length,
    charged: charged / microsPerDollar,
    held: held / microsPerDollar,
  };
};

/**
 * The chat a call works in, if it works in one: its actor is the
 * organization's agent, in everyone's chats.
 */
const chatOf = ({ work }: Session): string | null =>
  work !== undefined && "context" in work && work.context.type === "chat"
    ? work.context.chatId
    : null;

/**
 * The run of an independent workflow a call works for, if it does: its
 * actor is the system (`delegateActorOf`), so its workflow, run and
 * person are named here.
 */
const workflowRunOf = ({
  work,
}: Session): { workflow: string; run: string; person: string } | object =>
  work !== undefined && "context" in work && work.context.type === "workflowRun"
    ? {
        workflow: work.context.workflowId,
        run: work.context.runId,
        person: work.authority.onBehalfOf,
      }
    : {};

/** Whether `entry` makes an event the audit log takes. */
const fitsAuditLog = (entry: AuditEntry): boolean => {
  try {
    createAuditEvent(entry, "core");
    return true;
  } catch {
    return false;
  }
};

/**
 * A call's audit entry with as much of its provenance as the audit log
 * holds, each ID once: at most {@link auditProvenanceMaxItems}, halved
 * until the event fits (the rest of it is identifiers and small values,
 * well within the limit), and how many it left out. The rules judged the
 * call by all of it; the log names what fits, so a call that read a lot is
 * still recorded, never refused for it.
 */
const keepingProvenance = (
  provenance: readonly string[],
  entryWith: (kept: string[], dropped: number) => AuditEntry
): AuditEntry => {
  const unique = [...new Set(provenance)];
  const entryKeeping = (kept: number): AuditEntry =>
    entryWith(unique.slice(0, kept), unique.length - kept);
  let kept = Math.min(unique.length, auditProvenanceMaxItems);
  while (kept > 0 && !fitsAuditLog(entryKeeping(kept))) {
    kept = Math.floor(kept / 2);
  }
  return entryKeeping(kept);
};

/**
 * The App's model binding a call is made through, for its audit events:
 * its alias and its App, which a call made, through other Apps, from a
 * workflow run's doesn't name otherwise (its trigger is the run, of the
 * first App: resource-model.ts).
 */
const bindingOf = ({
  binding,
}: Session): { binding?: string; bindingApp?: string } =>
  binding === undefined
    ? {}
    : { binding: binding.alias, bindingApp: binding.app };

const auditEntry = (
  { call, ref, judged }: Admitted,
  recorded: Recorded
): AuditEntry => {
  const { logId } = recorded;
  return keepingProvenance(call.provenance, (provenance, dropped) => ({
    actor: call.trigger,
    action: "model.call",
    requestId: call.requestId,
    provenance,
    model: {
      provider: ref.provider,
      model: ref.id,
      inputTokens: recorded.inputTokens,
      outputTokens: recorded.outputTokens,
    },
    cost: { amount: recorded.cost, currency: "USD" },
    detail: {
      purpose: call.purpose,
      outcome: recorded.outcome,
      attempt: recorded.attempt,
      status: recorded.status ?? null,
      errorType: recorded.errorType ?? null,
      // Whether its tokens and cost are partly an estimate (`usedBy`).
      estimated: recorded.estimated,
      // How the model ledger settled it: what it charged, or holds.
      ledger: recorded.ledger.state,
      ledgerRequests: recorded.ledger.requests,
      ledgerCharged: recorded.ledger.charged,
      ledgerHeld: recorded.ledger.held,
      // Never an ID so long that the event would be refused.
      gatewayLogId:
        logId !== undefined && logId.length <= auditIdentifierMaxLength
          ? logId
          : null,
      // How hard the model was asked to think: a cost the person chose.
      effort: thinkingOf(ref.catalog, call.effort) ?? null,
      // Which rule kept the call in the EU, if one did.
      euOnly: judged.euOnly ?? null,
      // Why it carried sensitive data, if a data rule asked and it did.
      sensitive: judged.sensitive ?? null,
      provenanceDropped: dropped,
      chat: chatOf(call),
      ...bindingOf(call),
      ...workflowRunOf(call),
    },
  }));
};

/**
 * The most any request can add to its call's audit event: a call whose
 * event wouldn't fit the audit log with it is refused before anything is
 * sent and paid for, rather than left unrecorded after.
 */
const largestRecord: Recorded = {
  inputTokens: Number.MAX_SAFE_INTEGER,
  outputTokens: Number.MAX_SAFE_INTEGER,
  cost: Number.MAX_VALUE,
  estimated: true,
  logId: "x".repeat(auditIdentifierMaxLength),
  attempt: 2,
  outcome: "invalid_output",
  status: 599,
  errorType: "x".repeat(64),
  ledger: {
    state: "quarantined",
    requests: Number.MAX_SAFE_INTEGER,
    charged: Number.MAX_VALUE,
    held: Number.MAX_VALUE,
  },
};

/** The most the rules can add to a call's audit event. */
const largestJudged: Judged = {
  euOnly: "connection",
  sensitive: "collection",
};

/** A whole number of tokens, as a provider counted them. */
const isCount = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

/**
 * The provider's whole count of what a request used; none if it isn't
 * one. A count with no prompt tokens at all is none: every request sends
 * a prompt, so the provider never sent its count (pi's chat completions
 * end a stream with no usage chunk as answered, counting nothing). Nor is
 * one with one-hour cache writes, which the catalog doesn't price.
 */
const countedTokens = ({
  input,
  output,
  cacheRead,
  cacheWrite,
  cacheWrite1h,
}: Usage): TokenCounts | undefined =>
  [input, output, cacheRead, cacheWrite].every(isCount) &&
  input + cacheRead + cacheWrite > 0 &&
  (cacheWrite1h ?? 0) === 0
    ? { input, output, cacheRead, cacheWrite }
    : undefined;

/**
 * Records one request in the audit log, however it ended, with what it
 * used as the provider counted it, or an estimate where a request that
 * failed mid-answer has no count (`usedBy`); and settles its provider
 * request in the model ledger. Never throws: a caller that lost a paid
 * answer to a bookkeeping failure would ask (and pay) again.
 */
const record = async (
  env: ModelsEnv,
  admitted: Route,
  sent: Sent,
  attempt: number,
  outcome: Outcome,
  failure?: Failure
): Promise<void> => {
  // Settled first, so nothing that goes wrong with the audit event keeps
  // the provider request from being charged what it used. The one whose
  // answer streamed is charged the provider's count; one that ended
  // without a whole count (failed, timed out or cancelled once accepted,
  // or answered with no usage at all) keeps its whole reservation, never
  // an estimate below what the provider may bill.
  const { pending, logId, status } = sent;
  let settled: Settled | undefined = undefined;
  if (pending !== undefined) {
    const tokens = hasFailed(sent.answer)
      ? undefined
      : countedTokens(sent.answer.usage);
    ({ settled } = await settleAdmitted(
      admitted,
      pending,
      tokens === undefined ? { by: "unknown" } : { by: "usage", tokens }
    ));
  }
  const used = usedBy(admitted, sent);
  await keepAuditEvent(
    env,
    drizzle(env.DB),
    auditEntry(admitted, {
      ...used,
      logId,
      attempt,
      outcome,
      status: failure?.status ?? status,
      errorType: failure?.errorType,
      ledger: ledgerOf([
        ...sent.settled,
        ...(pending === undefined
          ? []
          : [{ reservedMicros: pending.reservedMicros, settled }]),
      ]),
    })
  );
};

/**
 * The audit entry of a refused call, with as much of its provenance as
 * fits the audit log (`provenanceDropped` says how much didn't), so a
 * refusal is always recorded.
 */
const refusedEntry = (
  call: Session,
  { code, because, retryAfterSeconds: retryAfter }: Refusal
): AuditEntry => {
  // Never a model name so long that the event would be refused.
  const model =
    call.model.length <= auditIdentifierMaxLength ? call.model : null;
  return keepingProvenance(call.provenance, (provenance, dropped) => ({
    actor: call.trigger,
    action: "model.refused",
    requestId: call.requestId,
    provenance,
    detail: {
      purpose: call.purpose,
      reason: code,
      because: because ?? null,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
      model,
      provenanceDropped: dropped,
      chat: chatOf(call),
      ...bindingOf(call),
      ...workflowRunOf(call),
    },
  }));
};

/** Records a call the deployment's rules refused, with the reason, and refuses it. */
const refuse = async (
  env: ModelsEnv,
  call: Session,
  refusal: Refusal
): Promise<never> => {
  const { code, because } = refusal;
  log.warn("model.refused", { reason: code, because });
  await keepAuditEvent(env, drizzle(env.DB), refusedEntry(call, refusal));
  if (code === "permission.context_invalid") {
    throw permissionErrors.create(code);
  }
  const { retryAfterSeconds: retryAfter, waitingFor, capUntold } = refusal;
  const error = modelErrors.create(code, {
    model: call.model,
    ...(because === undefined ? {} : { because }),
    ...(waitingFor === undefined ? {} : { waitingFor }),
    // Worth asking again, after this: a budget held by calls under way, a
    // full share, or one used up until it resets.
    ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
  });
  // Worded after the cap that refused it, so nobody waits for the month
  // when a day's or one request's cap said no; never to a guest, who is
  // told only that a budget is used up.
  if (code === "model.over_budget" && capUntold !== true) {
    error.message = overBudgetMessage(because);
  }
  throw error;
};

/** Records a refusal, as `refuse` does, without throwing it. */
const refuseQuietly = async (
  env: ModelsEnv,
  call: Session,
  refusal: Refusal
): Promise<void> => {
  try {
    await refuse(env, call, refusal);
  } catch (error) {
    if (
      modelErrors.codeOf(error) === undefined &&
      permissionErrors.codeOf(error) === undefined
    ) {
      throw error;
    }
  }
};

/** `fields` parsed with `schema`, or refused as an invalid call. */
const parseCall = <Schema extends z.ZodType>(
  schema: Schema,
  fields: unknown
): z.output<Schema> => {
  const parsed = schema.safeParse(fields);
  if (!parsed.success) {
    throw modelErrors.create("model.invalid_call");
  }
  return parsed.data;
};

/**
 * The last quota policy this isolate read, for a call's shares when the
 * policy can't be read for a moment: closer to what the operator set than
 * the platform's ceilings. Per isolate, never shared or stored: a lowered
 * policy read anywhere else applies here at the next read that works.
 */
let lastPolicyRead: QuotaPolicy | undefined;

/** The deployment's quota policy as it stands, remembered (`lastPolicyRead`). */
const readPolicy = async (env: ModelsEnv): Promise<QuotaPolicy> => {
  const read = await quotaPolicy(env);
  lastPolicyRead = read;
  return read;
};

/**
 * The deployment's quota policy; when it can't be read, the last this
 * isolate read, else the platform's own (its ceilings): for a call's
 * shares, which a policy only lowers, and which bound no spend.
 */
const policyOrPlatform = async (env: ModelsEnv): Promise<QuotaPolicy> => {
  try {
    return await readPolicy(env);
  } catch (error) {
    log.error("model.quota_policy_failed", {
      ...errorFields(error),
      fallback: lastPolicyRead === undefined ? "platform" : "last_read",
    });
    return lastPolicyRead ?? quotaPolicyOf();
  }
};

/**
 * Checks a request against the deployment's config and rules, before
 * anything is sent, and routes it to the model at the gateway.
 */
const admit = async (env: ModelsEnv, call: Session): Promise<Route> => {
  const config = modelGatewayConfig(env);
  // Plain workerd (on-prem) has no AI binding, so no gateway either.
  const rules = modelRules(env);
  if (
    config === undefined ||
    rules === undefined ||
    typeof env.AI?.fetch !== "function"
  ) {
    throw modelErrors.create("model.unconfigured");
  }
  const ref = config.models.includes(call.model)
    ? parseModelRef(call.model)
    : undefined;
  if (ref === undefined) {
    return await refuse(env, call, { code: "model.not_allowed" });
  }
  try {
    createAuditEvent(
      auditEntry({ call, ref, judged: largestJudged }, largestRecord),
      "core"
    );
  } catch {
    // Never expected: its provenance is kept to what fits, and every other
    // field is bounded. Refused, so no request goes unrecorded.
    throw modelErrors.create("model.invalid_call");
  }
  // A binding's bound is the App's to rely on: a request it can't fit is
  // refused, as its approval would be now, never cut short.
  if (
    call.binding !== undefined &&
    call.maxTokens !== undefined &&
    call.maxTokens > usableAnswer(gatewayModel(config.gateway, ref))
  ) {
    return await refuse(env, call, { code: "model.answer_too_long" });
  }
  const verdict = await judgeCall(env, rules, call);
  if (!verdict.ok) {
    return await refuse(env, call, verdict);
  }
  // A model with no safe price can't be bounded, so no budget admits it.
  const price = await pinnedPrice(
    listPricesOf(ref.provider, ref.id, ref.catalog.cost)
  );
  const { binding } = call;
  const scopesOn = (day: string, lineageRequests: number): LedgerScope[] => {
    const scopes = scopesFor(rules.budgets, call, lineageRequests);
    return binding === undefined
      ? scopes
      : [...scopes, ...bindingScopes(binding, day)];
  };
  const requestMicros = bindingRequestMicros(binding);
  // Whether a budget applies: the lineage's request limit limits no spend.
  if (
    price === undefined &&
    (hasBudget(scopesOn(budgetPeriods(env).day, lineageModelRequests)) ||
      requestMicros !== undefined)
  ) {
    return await refuse(env, call, { code: "model.unpriced" });
  }
  // Whose shares of the requests in flight the call takes, from its
  // trigger and work context, which core's host sets: never from App code.
  const { subject, resource, disclose } = shareIdentity(call);
  const place = crypto.randomUUID();
  return {
    call,
    ref,
    judged: verdict.judged,
    model: gatewayModel(config.gateway, ref),
    transport: createAiBindingFetch(env.AI),
    price,
    place,
    disclose,
    notes: Promise.resolve(),
    scopesNow: async () => {
      // A run lineage's request limit, as the policy stands for this
      // request: lowered for runs already under way too (model-budgets.ts).
      const lineage =
        call.trigger.type === "workflow" ? await readPolicy(env) : undefined;
      // The shares, as the policy stands too; for a call with no lineage,
      // the last read or the platform's own should the policy not be read.
      const policy = lineage ?? (await policyOrPlatform(env));
      // One clock for both, so a request at a month's last instant never
      // counts its day in one month and its month in the next.
      const { month, day } = budgetPeriods(env);
      return {
        period: month,
        scopes: scopesOn(
          day,
          lineage?.limits.lineageModelRequests ?? lineageModelRequests
        ),
        // The generation of the policy its shares come from, a fallback's
        // too (the last read's, or the platform's own, 0), so the ledger
        // refuses shares from a policy older than one it saw
        // (`policyBehind`): the request reads it again, and is held back
        // if it still can't. Shares from a fallback apply only while the
        // ledger knows of no newer policy, so an operator's lowered share
        // holds through an outage.
        policyGeneration: policy.generation,
        fair: { place, subject, resource, shares: modelSharesOf(policy) },
      };
    },
    perRequest:
      requestMicros === undefined
        ? undefined
        : { limitMicros: requestMicros, heldMicros: 0 },
    env,
  };
};

/** A call's requests: one, or a second when the answer doesn't fit its schema. */
const answerCall = async <Output>(
  env: ModelsEnv,
  request: Request,
  schema: z.ZodType<Output> | undefined,
  limit: Deadline,
  askAgain = true
): Promise<ModelAnswer<Output>> => {
  const { call } = request;
  const usage = { inputTokens: 0, outputTokens: 0 };
  let cost = 0;
  // A call with a schema asks once more when the answer doesn't fit it.
  const attempts = schema === undefined || !askAgain ? 1 : 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Each attempt follows up on the answer before it, and each of its
    // provider requests is admitted by the ledger, in the month it is
    // sent in: one the ledger held back was never sent.
    // oxlint-disable-next-line no-await-in-loop
    const sent = await send(request);
    if (sent.held !== undefined) {
      // oxlint-disable-next-line no-await-in-loop
      await refuse(env, call, sent.held);
    }
    const { answer } = sent;
    usage.inputTokens += inputTokens(answer.usage);
    usage.outputTokens += answer.usage.output;
    cost += pricedCost(request.price, answer.usage);
    const text = answerText(answer);
    const truncated = answer.stopReason === "length";

    if (hasFailed(answer)) {
      const failure = failureOf(sent, limit.stopped());
      log.warn("model.failed", failureFields(call.model, sent, failure));
      // oxlint-disable-next-line no-await-in-loop
      await record(env, request, sent, attempt, "failed", failure);
      // Turned away by the provider's rate limit, retries and all: it
      // took nothing on, and asking again after the wait may get through.
      // Not one cut off meanwhile, by its deadline or its caller: that is
      // what it failed of then.
      if (sent.rateLimited !== undefined && limit.stopped() === undefined) {
        throw modelErrors.create("model.rate_limited", {
          model: call.model,
          retryAfterSeconds: sent.rateLimited,
        });
      }
      throw modelErrors.create("model.failed");
    }
    if (schema === undefined) {
      // oxlint-disable-next-line no-await-in-loop
      await record(
        env,
        request,
        sent,
        attempt,
        truncated ? "truncated" : "answered"
      );
      // SAFETY: without a schema `Output` can't be inferred, so it is its
      // default, `undefined`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return { text, output: undefined as Output, truncated, usage, cost };
    }
    // An answer cut short is judged like any other: JSON that stops short
    // doesn't parse, so the model is asked again.
    const result = parseOutput(text, schema);
    // oxlint-disable-next-line no-await-in-loop
    await record(
      env,
      request,
      sent,
      attempt,
      result.ok ? "answered" : "invalid_output"
    );
    if (result.ok) {
      return { text, output: result.output, truncated, usage, cost };
    }
    request.messages.push(answer, {
      role: "user",
      content: `That answer doesn't fit: ${result.problem}\nAnswer again, with only the JSON.`,
      timestamp: Date.now(),
    });
  }
  throw modelErrors.create("model.invalid_output");
};

const callModel = async <Output>(
  env: ModelsEnv,
  {
    schema,
    askAgain,
    beforeSend,
    reauthorize,
    onQueued,
    signal,
    providerRetries = true,
    ...fields
  }: ModelCall<Output>
): Promise<ModelAnswer<Output>> => {
  const call = parseCall(callSchema, fields);
  const route: Route = {
    ...(await admit(env, call)),
    ...(beforeSend === undefined ? {} : { beforeSend }),
    ...(reauthorize === undefined ? {} : { reauthorize }),
    ...(onQueued === undefined ? {} : { onQueued }),
    providerRetries,
  };
  const { model } = route;
  const limit = deadline(call.timeoutMs ?? defaultTimeoutMs, signal);
  try {
    return await answerCall(
      env,
      {
        ...route,
        signal: limit.signal,
        endsAt: limit.endsAt,
        system:
          schema === undefined
            ? call.system
            : [call.system, structuredInstructions(schema)]
                .filter((part) => part !== undefined)
                .join("\n\n"),
        messages: toMessages(call, model),
      },
      schema,
      limit,
      askAgain
    );
  } finally {
    limit.clear();
  }
};

/** A failed answer in our own words, for a request that got none. */
const failedAnswer = (
  model: Model<Api>,
  errorMessage: string,
  stopReason: "error" | "aborted" = "error"
): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: noUsage,
  stopReason,
  errorMessage,
  timestamp: Date.now(),
});

/**
 * Streams one admitted request to `out`, event by event, and records it
 * before its last event: the loop sees an answer only once its audit event
 * is safe. A failure reaches the loop in our own words.
 */
const relayEvents = async (
  env: ModelsEnv,
  route: Route,
  { events, response }: ReturnType<typeof open>,
  out: AssistantMessageEventStream,
  limit: Deadline
): Promise<void> => {
  // The answer as far as it came, as the adapter's last event had it.
  let partial: AssistantMessage | undefined = undefined;
  for await (const event of events) {
    if (event.type === "error" && response.held !== undefined) {
      // Never sent: the ledger held it back. Audited as a refusal.
      const { code, retryAfterSeconds: retryAfter } = response.held;
      await refuseQuietly(env, route.call, response.held);
      out.push({
        ...event,
        error: {
          ...event.error,
          errorMessage:
            retryAfter === undefined
              ? `The model call was refused (${code}).`
              : `The model call was refused (${code}). Try again in ${retryAfter} seconds.`,
        },
      });
      return;
    }
    if (event.type === "error") {
      const sent: Sent = { answer: event.error, ...response };
      const stopped = limit.stopped();
      const failure = failureOf(sent, stopped);
      log.warn("model.failed", failureFields(route.call.model, sent, failure));
      await record(
        env,
        route,
        sent,
        1,
        stopped === "cancelled" ? "cancelled" : "failed",
        failure
      );
      const rateLimited =
        response.rateLimited === undefined || stopped !== undefined
          ? undefined
          : `The model's provider is taking no more requests for now. Try again in ${response.rateLimited} seconds.`;
      out.push({
        ...event,
        error: {
          ...event.error,
          errorMessage: rateLimited ?? failureMessage(failure),
        },
      });
      return;
    }
    if (event.type === "done") {
      await record(
        env,
        route,
        { answer: event.message, ...response },
        1,
        event.reason === "length" ? "truncated" : "answered"
      );
      out.push(event);
      return;
    }
    ({ partial } = event);
    out.push(event);
  }
  // The adapter ended without a last event: a failure, recorded as one,
  // with what came of the answer, and was streamed on, so it is counted
  // (`usedBy`).
  const answer: AssistantMessage = {
    ...failedAnswer(route.model, "The model call failed."),
    content: partial?.content ?? [],
    usage: partial?.usage ?? noUsage,
  };
  await record(env, route, { answer, ...response }, 1, "failed");
  out.push({ type: "error", reason: "error", error: answer });
};

/**
 * One request of an agent loop: admitted by the deployment's rules as they
 * stand now (a refusal is audited, and reaches the loop in our words),
 * then sent and streamed to `out`.
 */
const relay = async (
  env: ModelsEnv,
  session: Session,
  model: Model<Api>,
  context: TranscriptContext,
  out: AssistantMessageEventStream,
  caller: AbortSignal | undefined
): Promise<void> => {
  if (caller?.aborted === true) {
    // Cancelled before it was sent: nothing to record.
    out.push({
      type: "error",
      reason: "aborted",
      error: failedAnswer(model, "The model call was cancelled.", "aborted"),
    });
    return;
  }
  let route: Route | undefined = undefined;
  try {
    route = await admit(env, session);
  } catch (error) {
    const code = modelErrors.codeOf(error) ?? permissionErrors.codeOf(error);
    if (code === undefined) {
      throw error;
    }
    out.push({
      type: "error",
      reason: "error",
      error: failedAnswer(model, `The model call was refused (${code}).`),
    });
    return;
  }
  const limit = deadline(session.timeoutMs ?? defaultTimeoutMs, caller);
  try {
    await relayEvents(env, route, open(route, context, limit), out, limit);
  } finally {
    limit.clear();
  }
};

/**
 * {@link relay}, but never failing: if the request can't be recorded, say,
 * the loop gets a failure instead of waiting for an answer forever.
 */
const relayOrFail = async (
  env: ModelsEnv,
  session: Session,
  model: Model<Api>,
  context: TranscriptContext,
  out: AssistantMessageEventStream,
  caller: AbortSignal | undefined
): Promise<void> => {
  try {
    await relay(env, session, model, context, out, caller);
  } catch (error) {
    log.error("model.stream_failed", errorFields(error));
    // Ignored if the loop already has the request's last event.
    out.push({
      type: "error",
      reason: "error",
      error: failedAnswer(model, "The model call failed."),
    });
  }
};

/** A model for an agent loop: pi's stream function, bound to one model. */
export interface AgentModel {
  /** The model at the deployment's gateway, as the loop names it. */
  model: Model<Api>;
  /**
   * The tokens a request may send: the model's context window, as pi's
   * catalog gives it, less what each request keeps for the answer.
   * `undefined` when the catalog gives the model no window.
   */
  inputTokens: number | undefined;
  /**
   * Streams one request, with the tools its transcript declares. Whatever
   * model the loop passes, the request goes to this one, through the
   * gateway. Never throws: a failure is the stream's last event.
   */
  stream: (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions
  ) => AssistantMessageEventStream;
}

/** An agent loop's session: everything of a call but the conversation. */
export type AgentSession = z.input<typeof sessionSchema> & {
  /** Where the loop works: required, as of a call. */
  work: NonNullable<z.input<typeof sessionSchema>["work"]>;
};

const agentModel = async (
  env: ModelsEnv,
  fields: AgentSession,
  provenance: () => readonly string[]
): Promise<AgentModel> => {
  const session = parseCall(sessionSchema, fields);
  // Refused up front, before the loop keeps or sends anything.
  const { model } = await admit(env, session);
  return {
    model,
    inputTokens:
      model.contextWindow > 0
        ? Math.max(model.contextWindow - answerTokens(session, model), 0)
        : undefined,
    stream: (_model, context, options) => {
      const out = createAssistantMessageEventStream();
      // What fed this request: whatever the loop has read by now.
      const request: Session = {
        ...session,
        provenance: [...new Set([...session.provenance, ...provenance()])],
      };
      // The loop reads the answer from `out` as it streams in.
      void relayOrFail(env, request, model, context, out, options?.signal);
      return out;
    },
  };
};

/**
 * The model gateway for core: `await models(env).call({ model, input,
 * purpose, trigger })`. Refuses a model the deployment doesn't allow or
 * its rules don't let the call use, sends the call through AI Gateway, and
 * records every request it makes, and every refusal, in the audit log. With a `schema`, the answer is JSON that matches it.
 *
 * `await models(env).agent({ model, purpose, trigger, work }, provenance)`
 * is the same for an agent loop: a model that streams and calls tools.
 * The session is refused up front, before the loop keeps or sends
 * anything, and each request is admitted again by the rules as they stand
 * then (the context's restricted mode, what `provenance` says it has read
 * by then, the budgets), sent and audited like a call's.
 */
export const models = (env: ModelsEnv) => ({
  call: async <Output = undefined>(
    call: ModelCall<Output>
  ): Promise<ModelAnswer<Output>> => await callModel(env, call),
  agent: async (
    session: AgentSession,
    provenance: () => readonly string[] = () => []
  ): Promise<AgentModel> => await agentModel(env, session, provenance),
});

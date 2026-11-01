import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  FetchFunction,
  Message,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
  TranscriptContext,
  Usage,
} from "@earendil-works/pi-ai";
// From Pi's `models` entry, not its index: the index brings TypeBox and
// every other part of Pi, which core would otherwise load as it starts.
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  aiProviderIdSchema,
  aiProviders,
  platformRouteOf,
} from "@grasp-os/shared/ai-providers";
import type {
  AiProviderRoutes,
  PlatformRoute,
  ProviderTrouble,
} from "@grasp-os/shared/ai-providers";
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
import { modelRulesConfigSchema as rulesConfigSchema } from "@grasp-os/shared/deployment-config";
import type { ModelRole, ModelRules } from "@grasp-os/shared/deployment-config";
import {
  appIdSchema,
  connectionIdSchema,
  identifierSchema,
} from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  defaultModelEffort,
  modelEfforts,
  busyBudgetMessage,
  modelErrors,
  overBudgetMessage,
} from "@grasp-os/shared/models";
import type {
  ModelEffort,
  ModelEfforts,
  ModelErrorCode,
} from "@grasp-os/shared/models";
import {
  authoritySchema,
  permissionErrors,
  workContextSchema,
} from "@grasp-os/shared/permissions";
import type { PlatformAiFeature } from "@grasp-os/shared/platform-ai";
import { modelBindingBudgetSchema } from "@grasp-os/shared/resource-bindings";
import { maxSpeechChars } from "@grasp-os/shared/voice";
import type { Speech } from "@grasp-os/shared/voice";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  aiRoutesOf,
  chosenModels,
  readModelChoice,
} from "./ai-model-choice.ts";
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
  budgetPersonOf,
  hasBudget,
  limitedPersonOf,
  lineageModelRequests,
  platformScopes,
  scopesFor,
} from "./model-budgets.ts";
import { catalogWindowOf, parseModelRef } from "./model-catalog.ts";
import type { ModelRef } from "./model-catalog.ts";
import {
  documentPartTypes,
  takesDocuments,
  withDocument,
} from "./model-documents.ts";
import type { ModelDocument } from "./model-documents.ts";
import { modelLedger } from "./model-ledger.ts";
import type {
  Admitted as LedgerAdmitted,
  LedgerRoute,
  LedgerScope,
  LedgerScopeName,
  LimitedPerson,
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
import {
  connectRequest,
  connectSocket,
  connectRoute,
} from "./model-transport-connect.ts";
import type { ConnectTarget } from "./model-transport-connect.ts";
import { failureOfResponse, streamRoute } from "./model-transport.ts";
import type { TransportFailure, TransportRoute } from "./model-transport.ts";
import {
  charactersOf,
  hearingPricesOf,
  parseHearingRef,
  parseVoiceRef,
  voicePricesOf,
  wordsOf,
} from "./voice-models.ts";
import type { HearingRef, VoiceRef } from "./voice-models.ts";
import { askAgainMs } from "./workflows/admission.ts";
import { quotaLimits } from "./workflows/quotas.ts";

// The model gateway: every model call in a deployment goes through here,
// and from here through a model transport (model-transport.ts), never
// straight to a provider: the provider's own API through connect, which
// holds every key (model-transport-connect.ts). An organization's calls
// go with its own key, once it connected an AI provider
// (ai-model-choice.ts), and may use only the models its admins chose: its
// default, then its fallbacks, tried in turn when a provider refuses a
// call before anything could be billed. Until it connected one, and chose
// a model of it, every call fails as `model.no_provider`. Platform
// features go the same way with Grasp's own key
// (`models(env).platformCall`). Core holds no provider key. Every request
// is audited as metadata only: who or what asked, why, the model, tokens
// and cost, never the prompt or the answer. The event goes through the
// audit outbox, so a request that was answered (and paid for) is recorded
// even when the audit log can't take it for a moment.
//
// Before anything is sent, a call is checked against the deployment's
// rules (model-rules.ts). A refused call is audited too, with the reason,
// and nothing is sent. The transport only says where an admitted request
// goes: the rules, the budgets, the ledger's admission of every provider
// request and the audit log are the gateway's, the same whatever the
// transport.

/**
 * How long an answer may be when the call doesn't say: enough for a long
 * answer, well below what most models could write (and bill) in one go.
 */
const defaultMaxTokens = 16_384;

/**
 * An answer takes at most one in this many of the model's window. Some
 * providers count the answer's cap against the window and refuse a request
 * whose total is over it, so on a small one an answer of the whole window
 * would leave nothing for the request itself.
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
 * Retries for a request the provider refused for its rate (429), after
 * the wait it asked for.
 */
const maxRetries = 2;

/**
 * A model the gateway offers: a text model of pi's catalog, a speech model
 * of our own (voice-models.ts), which only speech takes
 * (`models(env).speak`), or a transcription model of our own, which only
 * listening takes (`models(env).listen`), so the rules can name each.
 * Each check stays its own, so no call of one kind can name a model of
 * another.
 */
const modelRefSchema = z
  .string()
  .refine(
    (ref) =>
      parseModelRef(ref) !== undefined ||
      parseVoiceRef(ref) !== undefined ||
      parseHearingRef(ref) !== undefined,
    { message: "A <provider>/<model> the gateway offers" }
  );

/** The client's rules, in the `MODEL_GATEWAY` var (model-rules.ts). */
const modelRulesConfigSchema = rulesConfigSchema(modelRefSchema);

/** The `MODEL_GATEWAY` var as set: no rules while it isn't. */
const rulesVar = (env: Env): unknown =>
  env.MODEL_GATEWAY === undefined ? {} : jsonVar(env.MODEL_GATEWAY);

/**
 * The deployment's rules: deployment config, set by the admin as the
 * `MODEL_GATEWAY` var, never an in-product setting, so an admin session
 * can't loosen what the client agreed to; none while it isn't set.
 * `undefined` for rules that don't parse: every call then fails closed.
 */
export const modelRules = (env: Env): ModelRules | undefined => {
  const parsed = modelRulesConfigSchema.safeParse(rulesVar(env));
  if (!parsed.success) {
    log.error("model.rules_invalid", {
      paths: parsed.error.issues.map(({ path }) => path.join(".")).join(" "),
    });
    return undefined;
  }
  return parsed.data;
};

/** The models the organization's calls may use now, and the rules. */
export interface ModelsNow {
  /**
   * The models its admins chose, its default first, each of a provider it
   * still has connected: none until it connected one and chose.
   */
  models: string[];
  /** The deployment's rules; `undefined` when they don't parse. */
  rules: ModelRules | undefined;
}

/**
 * The models the organization's calls may use now, for whatever picks one
 * (a role's model, a chat's choices, a binding's approval), and the
 * deployment's rules.
 */
export const modelSettings = async (env: Env): Promise<ModelsNow> => {
  const routes = await aiRoutesOf(env);
  return {
    models: chosenModels(routes, await readModelChoice(env)),
    rules: modelRules(env),
  };
};

/**
 * The model for `role`, for a call that carries sensitive data when
 * `sensitive` is set: the organization's default, else the first of its
 * fallbacks, that the rules let the call use. Both roles resolve alike:
 * an organization chooses its models, not one for each role. Throws
 * `model.no_provider` while it has no model to use (no provider
 * connected, or no model chosen), as every call would; `undefined` when
 * the rules let the call use none of them. The gateway checks the rules
 * again either way.
 */
export const modelForRole = (
  { models: chosen, rules }: ModelsNow,
  role: ModelRole,
  { sensitive }: { sensitive: boolean }
): string | undefined => {
  if (chosen.length === 0) {
    throw modelErrors.create("model.no_provider");
  }
  const fits = (model: string) =>
    (!sensitive ||
      rules?.sensitive === undefined ||
      rules.sensitive.models.includes(model)) &&
    (rules?.eu?.deployment !== true || rules.eu.models.includes(model));
  const model = chosen.find(fits);
  if (model === undefined) {
    log.error("model.role_refused", { role, sensitive: String(sensitive) });
  }
  return model;
};

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
      /**
       * Core's own upkeep of the Brain (knowledge/entities.ts): reading a
       * source's text for the entities it names. Judged as onboarding's
       * is, as carrying sensitive data, for no one in particular, but
       * kept apart from it in spend and audit (`platform` in its events).
       * Only core's own code makes such a call.
       */
      z.strictObject({ platform: z.literal("brain_upkeep") }),
      /**
       * Core's own making of a person's dashboard widget
       * (dashboard-widgets.ts): it carries the names of their engines and
       * workflows, judged as onboarding's is, and is made for them, on
       * their budget, by the trigger that names them. Only core's own code
       * makes such a call.
       */
      z.strictObject({ platform: z.literal("dashboard_widgets") }),
      /**
       * Core's own reranking of a person's recall (knowledge/rerank.ts),
       * only when the recall asks for it: it carries the company's own
       * words, judged as onboarding's is, and is made for them, on their
       * budget, by the trigger that names them. A delegate's recall reranks
       * under its own authority and context instead. Only core's own code
       * makes such a call.
       */
      z.strictObject({ platform: z.literal("brain_recall") }),
      /**
       * Core's own sorting of a request someone made of Stephen in a chat
       * app (channels/request-sorting.ts), from their words and his
       * answer, into the company's topics; and its proposals for what an
       * owner could fix (stephen-requests.ts). Judged as onboarding's is,
       * as carrying sensitive data, on the budget of the person it is
       * for. Only core's own code makes such a call.
       */
      z.strictObject({ platform: z.literal("stephen_requests") }),
      /**
       * An admin's test of an AI provider the organization connected
       * (ai-providers.ts): one fixed line of no one's data, judged as
       * onboarding's is all the same, made for the admin, on their budget.
       * Only core's own code makes such a call.
       */
      z.strictObject({ platform: z.literal("provider_test") }),
      /**
       * Core's own conversion of a PDF uploaded to the Brain into its text
       * (knowledge/extract.ts), on Grasp's key: the company's own words,
       * judged as onboarding's are, made for the person who uploaded it,
       * on their budget. Only core's own code makes such a call.
       */
      z.strictObject({ platform: z.literal("document_conversion") }),
    ])
    .optional(),
  requestId: auditEventSchema.shape.requestId,
  /**
   * For a call of an independent workflow's run, whose trigger names no
   * App's run (`system`): the run lineage its requests count against, by
   * its root, with every other run of the lineage's (model-budgets.ts,
   * `scopesFor`), so children never start the lineage's requests afresh;
   * and the workflow the run is of, whose budget it counts against too.
   * From the run's row; set by core's host only, never by App code.
   */
  lineage: z
    .strictObject({
      rootRunId: z.string().min(1).max(128),
      workflowId: z.string().min(1).max(128),
    })
    .optional(),
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
   * Told the answer's text so far each time it grows, as it streams in:
   * for a caller that shows it being written (dashboard-widgets.ts). An
   * answer asked for again starts afresh. A failure of it never fails the
   * call.
   */
  onText?: (text: string) => void;
  /**
   * A document the model reads as it is, beside `input`: a PDF, sent as
   * its provider's own document part (model-documents.ts). Only for a
   * platform feature (`platformCall`): Grasp's own conversion of uploads.
   */
  document?: ModelDocument;
  /**
   * Whether a request the provider refused for its rate (429) is sent
   * again, after the wait it asked for (the default, `maxRetries`). False
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
  /**
   * Across every request the call made. `inputTokens` counts the whole
   * prompt, cached or not; `cacheRead` and `cacheWrite` say how much of it
   * was read from the provider's prompt cache, and written to it.
   */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** In US dollars, at the provider's list prices. */
  cost: number;
}

/**
 * The longest answer model `<provider>/<model>` can usefully give one
 * request (`usableAnswer`); undefined for a model the gateway doesn't
 * offer. A model binding is approved only when its declaration's longest
 * request fits (resource-model.ts), and a call through a binding that asks
 * for more is refused, never cut short.
 */
export const usableAnswerTokens = (model: string): number | undefined => {
  const ref = parseModelRef(model);
  return ref === undefined ? undefined : usableAnswer(ref.catalog);
};

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
  /** The way it goes, as the ledger and the audit log record it. */
  way: LedgerRoute;
}

/** An admitted request's way to the model, through the deployment's transport. */
interface Route extends Admitted {
  model: Model<Api>;
  /** The way to the model: its endpoint, headers and fetch (model-transport.ts). */
  endpoint: TransportRoute;
  /**
   * How the call was let through (`Via`), which a fallback's admission
   * keeps.
   */
  via: Via;
  /**
   * The organization's models to try, in order, should the provider refuse
   * this one before anything could be billed (`fallbackOf`); none for a
   * call that may not fall back.
   */
  fallbacks: readonly string[];
  /**
   * Whether a provider request of this call may already have been billed
   * (an answer came, or a request's fate is unknown): from then on the
   * call never falls back (`fallbackOf`). Set as its requests end.
   */
  billed?: boolean;
  /** The prices its provider requests are pinned to; none for a model with none. */
  price: PinnedPrice | undefined;
  /**
   * The scopes a provider request sent now counts against, in this month,
   * its run lineage's limited by the quota limits. Throws when the teams
   * of the person it is made for can't be read: nothing is admitted
   * without the limits they give.
   */
  scopesNow: () => Promise<{
    period: string;
    scopes: LedgerScope[];
    /** Whose shares of the requests in flight it takes, under the quota limits. */
    fair: Fairness;
    /**
     * The person it is made for, and their teams, whose limit the ledger
     * reserves it against; none for a call made for nobody.
     */
    person: LimitedPerson | undefined;
  }>;
  /**
   * What the call's provider requests may reserve together, under its
   * binding's cap per request, and what they hold of it now: each one's
   * reservation, less what settled below it. Its requests go one at a
   * time, so nothing races it. None without a cap.
   */
  perRequest: { limitMicros: number; heldMicros: number } | undefined;
  /** Core's env, for the model ledger. */
  env: Env;
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
  /** Told the answer's text as it streams (`ModelCall.onText`). */
  onText?: (text: string) => void;
  /** The call's notes of its wait, one after another (`told`). */
  notes: Promise<void>;
  /** Whether a refused request is sent again (`ModelCall.providerRetries`). */
  providerRetries?: boolean;
  /**
   * The most a provider request with `body` may use, as its prices count
   * it, or why it can't be bounded (`textBound`).
   */
  bound: (body: unknown) => RequestBound | { held: Refusal };
  /**
   * How long a provider request holds its shares of the requests in
   * flight once admitted, below the ledger's most: a live
   * transcription's not at all (`listen`).
   */
  leaseMs?: number;
}

/** The most one provider request may use: its prompt, and its answer. */
interface RequestBound {
  inputTokens: number;
  outputTokens: number;
}

/**
 * What admitting a provider request takes of its route: a text model's
 * (`Route`), or a voice model's (`speak`).
 */
type Admitting = Partial<Pick<Route, "way">> &
  Pick<
    Route,
    | "env"
    | "call"
    | "price"
    | "perRequest"
    | "scopesNow"
    | "disclose"
    | "beforeSend"
    | "onQueued"
    | "notes"
    | "place"
    | "bound"
    | "leaseMs"
  >;

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
  /** How the last provider request failed, if it did (model-transport.ts). */
  failure: TransportFailure | undefined;
}

/** A provider request the ledger admitted: its ID, and what it reserved. */
interface Admission {
  id: string;
  reservedMicros: number;
  /** The most tokens its prompt can be, as reserved: its body's bytes and more. */
  promptTokens: number;
  /** The most tokens its answer can be: the cap its body sets. */
  answerCap: number;
}

interface Sent extends GatewayResponse {
  answer: AssistantMessage;
}

/**
 * What the log keeps of a provider's refusal: the fields that name what
 * went wrong and can carry no content, never its message, which may quote
 * the prompt or a credential.
 */
interface ProviderRefusal {
  name: string | undefined;
  type: string | undefined;
  code: string | number | undefined;
  /**
   * Whether it says the key's account has no credit or quota left
   * (`outOfCreditOf`): read off its type, its code or its message, and
   * kept as this flag alone, never the message.
   */
  outOfCredit: boolean;
}

/**
 * The types and codes providers name a refusal for an account with no
 * credit or quota left by: OpenAI's (and OpenAI-compatible endpoints')
 * `insufficient_quota` and `billing_hard_limit_reached`, Anthropic's
 * `billing_error`, and OpenRouter's and Mistral's payment refusals.
 */
const outOfCreditCodes: ReadonlySet<string> = new Set([
  "insufficient_quota",
  "billing_hard_limit_reached",
  "billing_not_active",
  "billing_error",
  "payment_required",
  "insufficient_credits",
]);

/**
 * What a refusal's message says when the account ran out, where its type
 * doesn't: Anthropic answers a 400 `invalid_request_error` saying "Your
 * credit balance is too low". Matched, never kept.
 */
const outOfCreditMessage =
  /\b(?:credit balance is too low|insufficient (?:credits?|funds|balance|quota)|exceeded your current quota)\b/iu;

/**
 * Whether a refusal's body says its account has no credit or quota left:
 * by one of its types or codes (`names`), or by its message.
 */
const outOfCreditOf = (names: readonly unknown[], message: unknown): boolean =>
  names.some(
    (name) => typeof name === "string" && outOfCreditCodes.has(name)
  ) ||
  (typeof message === "string" && outOfCreditMessage.test(message));

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
    // Not JSON: nothing of it is kept.
  }
  const type =
    identifierOf(parsed?.type) ?? identifierOf(nestedOf(parsed?.error, "type"));
  const code = codeOf(parsed?.code) ?? codeOf(nestedOf(parsed?.error, "code"));
  const { error } = parsed ?? {};
  return {
    name: identifierOf(parsed?.name),
    type,
    code,
    // Anthropic nests its own type under a top-level `error` type.
    outOfCredit: outOfCreditOf(
      [type, code, nestedOf(error, "type"), nestedOf(error, "code")],
      isRecord(error) ? error.message : parsed?.message
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
 * Where the caller is the person themselves (their own request, or their
 * chat's agent) and every full scope is their user scope, the calls
 * holding it are made for them: the wait runs until the soonest call
 * under way reaches its deadline (the ledger's `heldUntil`), rounded up
 * to a whole step, and no longer than the most. Optimistic, as that call
 * may not free enough on its own; bounded, so a caller asks again and is
 * told afresh rather than wait out a long call.
 *
 * Any other scope, or any other caller, is shared: the deployment and a
 * workflow hold other people's calls; a run lineage holds its runs' calls,
 * which may be other Apps' (a run's own mail starts other Apps' runs under
 * it, connector-events.ts); and to an App's code, a run's or a server's,
 * the person's user scope holds their chats' calls and other Apps'. A
 * derived wait would give away when those were sent: polling would show
 * the second it drops a step. Such a refusal suggests a fixed wait. That
 * removes only the timing of when they were sent: being told the budget
 * is busy at all still says other calls are under way, and its turning
 * into an admission (or out of budget) says when they finished.
 */
const busyRetry = { stepSeconds: 15, mostSeconds: 300, sharedSeconds: 60 };

/** Whether `trigger` is the person themselves, whose user scope is theirs to watch. */
const isThePerson = (trigger: Session["trigger"]): boolean =>
  trigger.type === "person" || trigger.type === "agent";

/** The seconds `trigger` waits before asking again, for a budget held until `heldUntil`. */
const retryAfterSeconds = (
  trigger: Session["trigger"],
  heldBy: readonly LedgerScopeName[],
  heldUntil: number
): number => {
  // The limit admins set for the person counts their own calls, as their
  // user scope does.
  const own = heldBy.every((scope) => scope === "user" || scope === "person");
  if (!(isThePerson(trigger) && own)) {
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
  route: Admitting,
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
const leaveQueue = async (route: Admitting): Promise<void> => {
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
  env: Env,
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
  route: Admitting,
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

/** `route`'s scopes now, or held back when they can't be read. */
const scopesRead = async (
  route: Admitting
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
      retryAfterSeconds: retryAfterSeconds(
        call.trigger,
        admitted.heldBy,
        admitted.heldUntil
      ),
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
 * The most a text model's request with `body` may use: its prompt bounded
 * by the body's size, its answer by the cap the body sets (or the
 * model's, where it sets none). Priced at the dearest tier the prompt may
 * reach: Anthropic's long-context premium too, a tier of its own
 * (model-prices.ts).
 */
const textBound = (
  call: Session,
  model: Model<Api>,
  body: unknown
): RequestBound | { held: Refusal } => {
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
  return { inputTokens: bytes + promptAllowanceTokens, outputTokens };
};

/**
 * The most a request carrying a document may use: its prompt bounded by
 * the model's whole context window, as a document's pages are billed by
 * what they hold rather than their bytes, and the provider refuses a
 * prompt beyond the window unbilled; its answer as a text request's.
 * Anything else the bound can't cover is refused as for any request.
 */
const documentBound = (
  call: Session,
  model: Model<Api>,
  body: unknown,
  part: string
): RequestBound | { held: Refusal } => {
  const unbounded = unboundedBy(body, new Set([part]));
  if (unbounded !== undefined) {
    log.error("model.unbounded_request", { model: call.model, unbounded });
    return { held: { code: "model.unpriced" } };
  }
  const outputTokens = outputCapOf(body) ?? model.maxTokens;
  if (!(model.contextWindow > 0 && outputTokens > 0)) {
    // A model without a window can't be bounded with a document.
    return { held: { code: "model.unpriced" } };
  }
  return { inputTokens: model.contextWindow, outputTokens };
};

/**
 * Asks the model ledger to admit one provider request, with the body it
 * will send: reserves the most it can cost (`Route.bound`), at the
 * model's pinned prices. Its ID, or why it is held back.
 */
const admitRequest = async (
  route: Admitting,
  body: unknown,
  endsAt: number
): Promise<Admission | { held: Refusal }> => {
  const { env, call, price, perRequest } = route;
  const now = await scopesRead(route);
  if ("held" in now) {
    return now;
  }
  const { period, scopes, fair, person } = now;
  const budgeted = hasBudget(scopes) || perRequest !== undefined;
  if (price === undefined && budgeted) {
    return { held: { code: "model.unpriced" } };
  }
  const bound = route.bound(body);
  if ("held" in bound) {
    return bound;
  }
  const pinned = price ?? unpriced;
  const id = crypto.randomUUID();
  // The call's own cut-off, which a retry or a second ask shares: never a
  // whole timeout from now.
  const callDeadline = endsAt;
  const reservedMicros = boundMicros(pinned, bound);
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
      ...(route.leaseMs === undefined ? {} : { leaseMs: route.leaseMs }),
      fair,
      ...(person === undefined ? {} : { person }),
      ...(route.way === undefined ? {} : { route: route.way }),
    });
    if ("policyBehind" in admitted) {
      // Never expected: the ledger refuses this only for an admission that
      // carries a policy generation, which none does. Logged, and refused
      // for what it is, never as a ledger outage.
      log.error("model.quota_policy_behind", {
        model: call.model,
        ledgerGeneration: admitted.highest,
      });
      return { held: { code: "model.quota_policy_behind" } };
    }
    if (admitted.ok) {
      if (perRequest !== undefined) {
        perRequest.heldMicros += reservedMicros;
      }
      return {
        id,
        reservedMicros,
        promptTokens: bound.inputTokens,
        answerCap: bound.outputTokens,
      };
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
  route: Admitting,
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
 * of time, cancelled, stopped by its caller, scopes that can't be read,
 * a ledger that throws): a call that held a place and wasn't admitted
 * gives it up, so no abandoned place holds others back while it lapses,
 * and a caller told it waited is told it stopped.
 */
const admitWaiting = async (
  route: Admitting,
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

/** The host a fetch is asked for, lowercase; none for a URL that isn't one. */
const hostOf = (input: Parameters<FetchFunction>[0]): string | undefined => {
  let href = "";
  if (typeof input === "string") {
    href = input;
  } else {
    href = input instanceof URL ? input.href : input.url;
  }
  return URL.parse(href)?.hostname.toLowerCase();
};

/** A failure as the ledger notes it for the provider's status. */
const notedFailure = (
  failure: TransportFailure
):
  | { kind: Exclude<TransportFailure["kind"], "budget">; status?: number }
  | undefined => {
  if (failure.kind === "budget") {
    return undefined;
  }
  return failure.status === undefined
    ? { kind: failure.kind }
    : { kind: failure.kind, status: failure.status };
};

/**
 * Opens one request through the gateway: the model's answer as it streams
 * in, and the gateway's response once it came. pi reports a failed request
 * as a final error event instead of throwing.
 */
const open = async (
  route: Route,
  context: TranscriptContext,
  { signal, endsAt }: { signal: AbortSignal; endsAt: number }
) => {
  const { endpoint, call } = route;
  const response: GatewayResponse = {
    status: undefined,
    logId: undefined,
    sentChars: 0,
    refusal: undefined,
    held: undefined,
    pending: undefined,
    settled: [],
    rateLimited: undefined,
    failure: undefined,
  };
  // Each provider request, the SDK's retries too, is admitted by the
  // model ledger before it is sent, and held back unsent when it isn't.
  // One the provider refused is settled at nothing; one whose fate can't
  // be known keeps its reservation; the one whose answer streams is
  // settled once the answer ends (`record`). Besides, the request's size
  // as sent, should what it used have to be estimated (`usedBy`); and
  // what a refusal's body says went wrong, which the provider SDKs drop
  // when it isn't in their provider's shape.
  const sendOnce: FetchFunction = async (input, init) => {
    // Only to the route's own host, whatever asks: a request anywhere
    // else, after a redirect an SDK took or a base URL gone wrong, is
    // never admitted or sent (a key's one destination).
    if (hostOf(input) !== endpoint.host) {
      log.error("model.route_host_mismatch", {
        model: call.model,
        transport: endpoint.transport,
      });
      throw new Error("The model request's host isn't its route's");
    }
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
      answered = await endpoint.fetch(
        input,
        endpoint.tagged(init, admitted.id, endsAt)
      );
    } catch (error) {
      // Not answered at all: down, unless its caller cut it off.
      const failure: TransportFailure = {
        kind: "provider_down",
        status: undefined,
      };
      response.failure = signal.aborted ? undefined : failure;
      // Its deadline passed with no answer: the provider isn't answering,
      // as its status says. Not one its caller cancelled.
      const unanswered = !signal.aborted || Date.now() >= endsAt;
      response.settled.push(
        await settleAdmitted(route, admitted, {
          by: "unknown",
          ...(unanswered ? { failure: { kind: failure.kind } } : {}),
        })
      );
      throw error;
    }
    response.refusal = undefined;
    response.rateLimited = undefined;
    if (!answered.ok) {
      const refusal = refusalOf(await answered.clone().text());
      const failure = failureOfResponse(
        answered.status,
        answered.status === 429 ? rateLimitedSeconds(answered.headers) : 0,
        refusal.outOfCredit
      );
      response.failure = failure;
      // Only a rate limit is waited out: an account out of credit (a 429
      // too, at OpenAI) fails the same way however long it waits.
      response.rateLimited =
        failure.kind === "rate_limited" ? failure.retryAfterSeconds : undefined;
      const noted = notedFailure(failure);
      // A refusal before the provider took the request on costs nothing;
      // a server error may have come after it did.
      response.settled.push(
        await settleAdmitted(route, admitted, {
          by: answered.status < 500 ? "refused" : "unknown",
          ...(noted === undefined ? {} : { failure: noted }),
        })
      );
      response.refusal = refusal;
      return answered;
    }
    response.failure = undefined;
    if (response.pending !== undefined) {
      response.settled.push(
        await settleAdmitted(route, response.pending, { by: "unknown" })
      );
    }
    response.pending = admitted;
    return answered;
  };
  // The gateway retries only a rate limit's refusal, which the provider made before
  // taking anything on, after the wait it asked for, and only while that
  // wait ends before the call's deadline. Never a server error or a
  // request that got no answer: those may have been taken on, and billed.
  // Each retry is admitted by the ledger on its own.
  const measured: FetchFunction = async (input, init) => {
    let answered = await sendOnce(input, init);
    for (
      let retry = 0;
      retry < maxRetries &&
      route.providerRetries !== false &&
      answered.status === 429 &&
      response.rateLimited !== undefined &&
      Date.now() + response.rateLimited * 1000 < endsAt;
      retry += 1
    ) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, as asked
      await answered.body?.cancel();
      // oxlint-disable-next-line no-await-in-loop -- the wait the provider asked for
      await pause(response.rateLimited * 1000, signal);
      // oxlint-disable-next-line no-await-in-loop -- one after another
      answered = await sendOnce(input, init);
    }
    return answered;
  };
  const { model } = route;
  const events = await streamRoute(endpoint, context, {
    fetch: measured,
    maxTokens: answerTokens(call, model),
    // Without a level pi turns reasoning off.
    reasoning: thinkingOf(model, call.effort),
    signal,
    onResponse: ({ status, headers }) => {
      response.status = status;
      response.logId = endpoint.logIdOf(headers);
    },
  });
  return { events, response };
};

/** Sends one request through the gateway and waits for the whole answer. */
const send = async (request: Request): Promise<Sent> => {
  const { system, messages, signal, endsAt } = request;
  const { events, response } = await open(
    request,
    normalizeContext({ systemPrompt: system, messages }),
    { signal, endsAt }
  );
  const { onText } = request;
  if (onText !== undefined) {
    for await (const event of events) {
      if (event.type === "text_delta") {
        try {
          onText(answerText(event.partial));
        } catch (error) {
          log.warn("model.on_text_failed", errorFields(error));
        }
      }
    }
  }
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
  /** Why it was stopped here, if it was: cut off before it ended. */
  stopped: Stopped | undefined;
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
    return { status, errorType: stopped, stopped };
  }
  const text = answer.errorMessage?.trim() ?? "";
  const quoted = failedStatusPattern.exec(text)?.groups?.status;
  return {
    status: quoted === undefined ? status : Number(quoted),
    errorType: providerErrorType(text),
    stopped: undefined,
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

/** The model error code a failed answer's message names, as "(model.over_budget)". */
const namedFailure = /\((?<code>model\.[a-z_]+)\)/u;

/**
 * Why a model call failed, from the message the gateway put on its failed
 * answer: the code of {@link modelErrors} it names, or `model.failed` for
 * one that names none (the provider failed it). Never the message itself,
 * which may hold a provider's status and error type.
 */
export const modelFailureOf = (
  errorMessage: string | undefined
): ModelErrorCode =>
  modelErrors.codeOf({
    code: namedFailure.exec(errorMessage ?? "")?.groups?.code,
  }) ?? "model.failed";

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

/**
 * The platform upkeep a call is core's own for, if it is one: named in
 * its audit events, so its spend is told apart from everyone else's.
 */
const platformOf = ({ work }: Session): { platform: string } | object =>
  work !== undefined && "platform" in work ? { platform: work.platform } : {};

/**
 * Which of Grasp's own features a text call on Grasp's key is for, as the
 * ledger records it, so what each costs Grasp is told apart: converting a
 * document is the only one today.
 */
const platformFeatureOf = ({
  work,
}: Session): { feature: PlatformAiFeature } | object =>
  work !== undefined &&
  "platform" in work &&
  work.platform === "document_conversion"
    ? { feature: "conversion" }
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
  { call, ref, judged, way }: Admitted,
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
      // The way it went: its transport, the provider's region, and whose
      // key (the organization's own, or Grasp's for a platform feature).
      transport: way.transport,
      region: way.region,
      credential: way.credential ?? null,
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
      ...platformOf(call),
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

/** The longest way a call's audit event can name. */
const largestWay: LedgerRoute = {
  transport: "x".repeat(64),
  provider: "x".repeat(32),
  region: "x".repeat(32),
  credential: "organization",
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
 * What a request cut off mid-answer, by its caller or its deadline, is
 * known to have used by then. The prompt as the provider counted it at
 * the start (Anthropic's `message_start`); where it sent no count yet
 * (chat completions count in their last chunk), the prompt's bound, as
 * its admission reserved it: never an estimate below what it may bill.
 * The answer as far as it was relayed, at {@link estimatedCharsPerToken}
 * characters a token where that is more than was counted, but never an
 * estimate past the answer's cap, which the provider stops at. None where
 * the counts that came aren't counts, or hold one-hour cache writes,
 * which the catalog doesn't price.
 */
const cutTokens = (
  { promptTokens, answerCap }: Admission,
  answer: AssistantMessage
): TokenCounts | undefined => {
  const { input, output, cacheRead, cacheWrite, cacheWrite1h } = answer.usage;
  if (
    ![input, output, cacheRead, cacheWrite].every(isCount) ||
    (cacheWrite1h ?? 0) !== 0
  ) {
    return undefined;
  }
  const relayed = Math.max(
    output,
    Math.min(estimatedTokens(receivedChars(answer)), answerCap)
  );
  return input + cacheRead + cacheWrite > 0
    ? { input, output: relayed, cacheRead, cacheWrite }
    : { input: promptTokens, output: relayed, cacheRead: 0, cacheWrite: 0 };
};

/**
 * How the ledger settles the provider request whose answer streamed: at
 * the provider's count once it ended whole; at what it is known to have
 * used once it was cut off here (`cutTokens`), so a caller who talks on
 * pays for what it used, and its reservation goes back at once; and
 * otherwise (it failed, or answered with no usage at all) not at all:
 * it keeps its whole reservation, never an estimate below what the
 * provider may bill.
 */
const settlementOf = (
  pending: Admission,
  answer: AssistantMessage,
  failure: Failure | undefined,
  shows: ProviderTrouble | undefined
): Settlement => {
  // What it showed of its provider goes with it, for the provider's
  // status alone: never what it is charged.
  const seen = shows === undefined ? {} : { shows };
  if (failure?.stopped !== undefined) {
    const tokens = cutTokens(pending, answer);
    return tokens === undefined
      ? { by: "unknown", ...seen }
      : { by: "cut", tokens, ...seen };
  }
  const tokens = hasFailed(answer) ? undefined : countedTokens(answer.usage);
  return tokens === undefined
    ? { by: "unknown", ...seen }
    : { by: "usage", tokens };
};

/** What each way a request fails shows of its provider; none for the request's own fault. */
const failureTroubles: Readonly<
  Record<TransportFailure["kind"], ProviderTrouble | undefined>
> = {
  auth: "refused",
  quota: "limiting",
  rate_limited: "limiting",
  provider_down: "not_answering",
  refused: undefined,
  budget: undefined,
};

/**
 * What a failed request on the organization's own key showed of its
 * provider, by the HTTP class seen, never a guess at why
 * (`ProviderTrouble`): it refused the key (401, 403); it limited the
 * request (429, an account's rate or spending limit); or it didn't answer
 * (5xx, no answer, an answer that broke off, or the call's deadline
 * passed with a request out).
 * None for a call its caller cancelled, a refusal of the request itself,
 * or one on Grasp's key, whose features say so in their own words.
 */
const troubleOf = (
  route: Route,
  { failure, settled, pending }: GatewayResponse,
  stopped: Stopped | undefined
): ProviderTrouble | undefined => {
  if (route.way.credential !== "organization" || stopped === "cancelled") {
    return undefined;
  }
  if (stopped === "timeout") {
    // Only once a request went out: a call held back by the ledger till
    // its deadline never reached the provider.
    return settled.length > 0 || pending !== undefined
      ? "not_answering"
      : undefined;
  }
  if (failure === undefined) {
    // An answer begun that broke off: the provider stopped answering.
    return pending === undefined ? undefined : "not_answering";
  }
  return failureTroubles[failure.kind];
};

/**
 * Records one request in the audit log, however it ended, with what it
 * used as the provider counted it, or an estimate where a request that
 * failed mid-answer has no count (`usedBy`); and settles its provider
 * request in the model ledger. Never throws: a caller that lost a paid
 * answer to a bookkeeping failure would ask (and pay) again.
 */
const record = async (
  env: Env,
  admitted: Route,
  sent: Sent,
  attempt: number,
  outcome: Outcome,
  failure?: Failure
): Promise<void> => {
  // Settled first, so nothing that goes wrong with the audit event keeps
  // the provider request from being charged what it used (`settlementOf`).
  const { pending, logId, status } = sent;
  let settled: Settled | undefined = undefined;
  if (pending !== undefined) {
    // A request that broke off or ran out of time with its answer out
    // shows its provider stopped answering (`troubleOf`): noted in the
    // provider's status, so its admins are told, whatever it is charged.
    // A refusal of the provider's own (a key refused, a limit) is noted
    // where it is settled as refused, with what it said.
    const trouble =
      outcome === "failed"
        ? troubleOf(admitted, sent, failure?.stopped)
        : undefined;
    const shows = trouble === "not_answering" ? trouble : undefined;
    ({ settled } = await settleAdmitted(
      admitted,
      pending,
      settlementOf(pending, sent.answer, failure, shows)
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
      ...platformOf(call),
    },
  }));
};

/** Records a call the deployment's rules refused, with the reason, and refuses it. */
const refuse = async (
  env: Env,
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
  // Which budget calls under way hold, and nothing of those calls.
  if (code === "model.budget_busy" && capUntold !== true) {
    error.message = busyBudgetMessage(because);
  }
  throw error;
};

/** Records a refusal, as `refuse` does, without throwing it. */
const refuseQuietly = async (
  env: Env,
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
 * The scopes a provider request of `call` counts against once it is sent
 * (`Route.scopesNow`), by `scopesOn` for its day and its lineage's limit
 * of requests, and whose shares of the requests in flight it takes: from
 * its trigger and work context, which core's host sets, never from App
 * code.
 */
const scopesNowOf = (
  env: Env,
  call: Session,
  place: string,
  scopesOn:
    | ((day: string, lineageRequests: number) => LedgerScope[])
    | "platform"
): Route["scopesNow"] => {
  const { subject, resource } = shareIdentity(call);
  return async () => {
    const limits = quotaLimits(env);
    const lineageRequests = limits.lineageModelRequests;
    // One clock for both, so a request at a month's last instant never
    // counts its day in one month and its month in the next.
    const { month, day } = budgetPeriods(env);
    // The person's teams as core's records have them now, so a person
    // moved between teams is held to the right limit from their next
    // request.
    // A call on Grasp's own key counts against none of the organization's
    // budgets, a person's limit included (`platformScopes`).
    const person =
      scopesOn === "platform"
        ? undefined
        : await limitedPersonOf(env, budgetPersonOf(call));
    return {
      period: month,
      scopes:
        scopesOn === "platform"
          ? platformScopes(call, lineageRequests)
          : scopesOn(day, lineageRequests),
      fair: { place, subject, resource, shares: modelSharesOf(limits) },
      person,
    };
  };
};

/**
 * How a call is let through to a model:
 * - `chosen`: an ordinary call, to one of the models the organization's
 *   admins chose, of an AI provider it connected, with its key.
 * - `test`: an admin's test of a provider the organization connected
 *   (ai-providers.ts): any of that provider's models, with its key.
 * - `platform`: a platform feature of core's own: any model of a provider
 *   Grasp has a key for, with Grasp's key (`models(env).platformCall`).
 */
type Via =
  | { kind: "chosen" }
  | { kind: "test"; provider: ConnectTarget["provider"] }
  | { kind: "platform" };

const chosenVia: Via = { kind: "chosen" };

/** Where an admitted call goes, and how. */
interface Routing {
  endpoint: TransportRoute;
  way: LedgerRoute;
  /** The models to fall back to, in order (`Route.fallbacks`). */
  fallbacks: readonly string[];
}

/**
 * The route to `ref` through connect, on `target`'s key; refused as not
 * allowed when the provider's API isn't one a route may speak.
 */
const connectRouting = async (
  env: Env,
  call: Session,
  ref: ModelRef,
  target: ConnectTarget,
  fallbacks: readonly string[]
): Promise<Routing> => {
  const endpoint = connectRoute(env, target, ref);
  if (endpoint === undefined) {
    return await refuse(env, call, { code: "model.not_allowed" });
  }
  return {
    endpoint,
    way: {
      transport: endpoint.transport,
      provider: target.provider,
      region: target.platform?.region ?? aiProviders[target.provider].region,
      credential: target.credential,
      ...(target.credential === "platform" ? platformFeatureOf(call) : {}),
    },
    fallbacks,
  };
};

/**
 * Whether `call` may fall back to the organization's other models: only a
 * call that names no model of its own approval, the organization's own
 * chats, agents and core's features, which use whichever of its chosen
 * models answers. A call through an App's model binding, or an App's or a
 * workflow's own, goes to the model it was approved for, and to no other:
 * its prompt never reaches a provider its approval didn't name.
 */
const mayFallBack = ({ binding, trigger }: Session): boolean =>
  binding === undefined &&
  trigger.type !== "app" &&
  trigger.type !== "workflow";

/** The organization's providers and Grasp's, from connect; failed when unread. */
const routesOrFailed = async (env: Env): Promise<AiProviderRoutes> => {
  try {
    return await aiRoutesOf(env);
  } catch (error) {
    // Never a guess: without connect's word, no key is known to use.
    log.error("model.routes_unreadable", errorFields(error));
    throw modelErrors.create("model.failed");
  }
};

/**
 * Where `call` goes, as `via` lets it through (`Via`), or its refusal,
 * audited: a model of a provider with no key for it is never routed.
 */
const routingOf = async (
  env: Env,
  call: Session,
  via: Via
): Promise<{ ref: ModelRef; routing: Routing }> => {
  const routes = await routesOrFailed(env);
  const ref = parseModelRef(call.model);
  const provider = aiProviderIdSchema.safeParse(ref?.provider).data;
  if (via.kind === "platform") {
    if (
      ref === undefined ||
      provider === undefined ||
      !routes.platform.includes(provider)
    ) {
      return await refuse(env, call, {
        code: "model.not_allowed",
        because: "platform",
      });
    }
    const platform = platformRouteOf(provider);
    if (platform === undefined) {
      throw modelErrors.create("model.unconfigured");
    }
    const target = {
      credential: "platform",
      provider,
      baseUrl: null,
      platform,
    } as const;
    return { ref, routing: await connectRouting(env, call, ref, target, []) };
  }
  const connected = routes.organization.find(
    (route) => route.provider === provider
  );
  if (via.kind === "test") {
    if (
      ref === undefined ||
      connected === undefined ||
      connected.provider !== via.provider
    ) {
      return await refuse(env, call, { code: "model.not_allowed" });
    }
    const target = { credential: "organization" as const, ...connected };
    return { ref, routing: await connectRouting(env, call, ref, target, []) };
  }
  const chosen = chosenModels(routes, await readModelChoice(env));
  if (chosen.length === 0) {
    return await refuse(env, call, {
      code: "model.no_provider",
      because: "model",
    });
  }
  const at = chosen.indexOf(call.model);
  if (at === -1 || ref === undefined || connected === undefined) {
    return await refuse(env, call, { code: "model.not_allowed" });
  }
  const target = { credential: "organization" as const, ...connected };
  return {
    ref,
    routing: await connectRouting(
      env,
      call,
      ref,
      target,
      mayFallBack(call) ? chosen.slice(at + 1) : []
    ),
  };
};

/**
 * Checks a request against the deployment's rules and the organization's
 * providers, before anything is sent, and routes it to the model.
 */
const admit = async (
  env: Env,
  call: Session,
  via: Via = chosenVia
): Promise<Route> => {
  const rules = modelRules(env);
  if (rules === undefined) {
    throw modelErrors.create("model.unconfigured");
  }
  const { ref, routing } = await routingOf(env, call, via);
  const { endpoint } = routing;
  try {
    createAuditEvent(
      auditEntry(
        { call, ref, judged: largestJudged, way: largestWay },
        largestRecord
      ),
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
    call.maxTokens > usableAnswer(endpoint.model)
  ) {
    return await refuse(env, call, { code: "model.answer_too_long" });
  }
  // Grasp's own features go to their provider's EU host (`judgeCall`).
  const verdict = await judgeCall(
    env,
    rules,
    call,
    routing.way.credential === "platform"
  );
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
  const { disclose } = shareIdentity(call);
  const place = crypto.randomUUID();
  const { model } = endpoint;
  return {
    call,
    ref,
    judged: verdict.judged,
    way: routing.way,
    model,
    endpoint,
    via,
    fallbacks: routing.fallbacks,
    bound: (body) => textBound(call, model, body),
    price,
    place,
    disclose,
    notes: Promise.resolve(),
    // Grasp's own key: none of the organization's budgets (`platformScopes`).
    scopesNow: scopesNowOf(
      env,
      call,
      place,
      routing.way.credential === "platform" ? "platform" : scopesOn
    ),
    perRequest:
      requestMicros === undefined
        ? undefined
        : { limitMicros: requestMicros, heldMicros: 0 },
    env,
  };
};

/**
 * Whether any provider request `response` covers may have been billed: one
 * whose answer streams, or one settled at a charge or of unknown fate.
 * Refusals and requests never sent can't have been.
 */
const mayHaveBilled = ({ pending, settled }: GatewayResponse): boolean =>
  pending !== undefined ||
  settled.some(
    ({ settled: state }) =>
      state?.state === "unknown" ||
      state?.state === "quarantined" ||
      (state?.state === "settled" && state.chargedMicros > 0)
  );

/**
 * The route of the organization's next model for a call the provider
 * refused (`Route.fallbacks`), admitted afresh by the rules, or none:
 * only once the provider refused it before anything could be billed (its
 * credentials, an account out of credit, or a rate limit its retries
 * didn't outlast), never after a
 * server error, no answer or an answer begun, never past its deadline or
 * once its caller cancelled it, never once a request of the call may have
 * been billed, never for a call that allows one provider request only
 * (`providerRetries: false`), and never for a call bound to the model it
 * was approved for (`mayFallBack`). A fallback model the rules refuse is
 * audited as refused, and the call fails as the first did.
 */
const fallbackOf = async (
  env: Env,
  route: Route,
  response: GatewayResponse,
  stopped: Stopped | undefined
): Promise<Route | undefined> => {
  const { failure } = response;
  const [next] = route.fallbacks;
  if (
    next === undefined ||
    // A caller that allows no request beyond its first (a workflow step:
    // one step, one provider request) gets no other model either.
    route.providerRetries === false ||
    !mayFallBack(route.call) ||
    route.billed === true ||
    mayHaveBilled(response) ||
    failure === undefined ||
    stopped !== undefined ||
    response.held !== undefined ||
    response.pending !== undefined ||
    (failure.kind !== "auth" &&
      failure.kind !== "quota" &&
      failure.kind !== "rate_limited")
  ) {
    return undefined;
  }
  let admitted: Route;
  try {
    admitted = await admit(env, { ...route.call, model: next }, route.via);
  } catch (error) {
    if (
      modelErrors.codeOf(error) === undefined &&
      permissionErrors.codeOf(error) === undefined
    ) {
      throw error;
    }
    return undefined;
  }
  // The same call, on another model: it keeps what its requests already
  // hold under its binding's cap per request, never a fresh count.
  return { ...route, ...admitted, perRequest: route.perRequest };
};

/** The code a call fails with for what its provider showed. */
const troubleCodes = {
  refused: "model.provider_key_failed",
  not_answering: "model.provider_unavailable",
  limiting: "model.rate_limited",
} as const satisfies Record<ProviderTrouble, ModelErrorCode>;

/**
 * Whether the call failed provably before anything of it could be billed,
 * from what the gateway saw of its requests, never a guess: the provider
 * answered its last request with an error and no part of an answer (a
 * refusal: the key, a rate or spending limit; or a 5xx, which streams
 * nothing), and every request before it was refused or never sent. Not a
 * request that got no answer at all (connect couldn't reach the provider,
 * or the deadline passed with it out: it may have been taken on), not an
 * answer begun, and not a call cut off here or with a request of it
 * already billed. The ledger still holds a 5xx's reservation charged
 * (`settleAdmitted`, "unknown"), as a bound on spend; whether running the
 * call again is safe is this rule's, which an exactly-once caller keeps to
 * (workflows/resource-host.ts).
 */
const provablyUnbilled = (
  route: Route,
  response: GatewayResponse,
  stopped: Stopped | undefined
): boolean => {
  const { failure, pending, settled } = response;
  if (
    stopped !== undefined ||
    route.billed === true ||
    pending !== undefined ||
    failure === undefined
  ) {
    return false;
  }
  const answeredAnError =
    failure.kind !== "provider_down" || failure.status !== undefined;
  return (
    answeredAnError &&
    !mayHaveBilled({ ...response, settled: settled.slice(0, -1) })
  );
};

/**
 * The failure of a call whose provider showed `trouble`, naming it and
 * the provider, so a workflow run can wait for it (workflows/host.ts),
 * with the wait a rate limit asked for, where it did, and whether it
 * provably billed nothing (`provablyUnbilled`), so a call tried once may
 * be run again.
 */
const troubleError = (
  route: Route,
  trouble: ProviderTrouble,
  waitSeconds: number | undefined,
  unbilled: boolean
) =>
  modelErrors.create(troubleCodes[trouble], {
    model: route.call.model,
    provider: route.way.provider,
    trouble,
    ...(waitSeconds === undefined ? {} : { retryAfterSeconds: waitSeconds }),
    ...(unbilled ? { unbilled: true } : {}),
  });

/** What a stream ends with for what its provider showed. */
const troubleMessages: Readonly<Record<ProviderTrouble, string>> = {
  refused: "Your AI provider is refusing your key (model.provider_key_failed).",
  not_answering:
    "Your AI provider isn't answering (model.provider_unavailable).",
  limiting: "Your AI provider is limiting requests (model.rate_limited).",
};

/** Records that `from` fell back to `to`'s model, and why. Metadata only. */
const auditFallback = async (
  env: Env,
  from: Route,
  to: Route,
  failure: TransportFailure | undefined
): Promise<void> => {
  const why = failure?.kind ?? "failed";
  log.warn("model.fallback", {
    from: from.call.model,
    to: to.call.model,
    why,
  });
  await keepAuditEvent(env, drizzle(env.DB), {
    actor: from.call.trigger,
    action: "model.fallback",
    requestId: from.call.requestId,
    detail: {
      purpose: from.call.purpose,
      from:
        from.call.model.length <= auditIdentifierMaxLength
          ? from.call.model
          : null,
      to:
        to.call.model.length <= auditIdentifierMaxLength ? to.call.model : null,
      why,
      status:
        failure !== undefined && "status" in failure
          ? (failure.status ?? null)
          : null,
      chat: chatOf(from.call),
      ...workflowRunOf(from.call),
      ...platformOf(from.call),
    },
  });
};

/**
 * Sends `request`, and again to each of the organization's fallback
 * models while the provider refuses it before anything could be billed
 * (`fallbackOf`), each refused request recorded as `attempt`.
 */
const sendFallingBack = async (
  env: Env,
  request: Request,
  limit: Deadline,
  attempt: number
): Promise<Sent> => {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one model after another
    const sent = await send(request);
    if (!hasFailed(sent.answer) || sent.held !== undefined) {
      // Answered: whatever the call asks next (a second try at its
      // schema) comes after a request that was billed.
      request.billed = request.billed === true || mayHaveBilled(sent);
      return sent;
    }
    const stopped = limit.stopped();
    // oxlint-disable-next-line no-await-in-loop -- one model after another
    const next = await fallbackOf(env, request, sent, stopped);
    if (next === undefined) {
      return sent;
    }
    const failure = failureOf(sent, stopped);
    log.warn("model.failed", failureFields(request.call.model, sent, failure));
    // oxlint-disable-next-line no-await-in-loop -- in order
    await record(env, request, sent, attempt, "failed", failure);
    // oxlint-disable-next-line no-await-in-loop -- in order
    await auditFallback(env, request, next, sent.failure);
    Object.assign(request, next);
  }
};

/** A call's requests: one, or a second when the answer doesn't fit its schema. */
const answerCall = async <Output>(
  env: Env,
  request: Request,
  schema: z.ZodType<Output> | undefined,
  limit: Deadline,
  askAgain = true
): Promise<ModelAnswer<Output>> => {
  const { call } = request;
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let cost = 0;
  // A call with a schema asks once more when the answer doesn't fit it.
  const attempts = schema === undefined || !askAgain ? 1 : 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Each attempt follows up on the answer before it, and each of its
    // provider requests is admitted by the ledger, in the month it is
    // sent in: one the ledger held back was never sent.
    // oxlint-disable-next-line no-await-in-loop
    const sent = await sendFallingBack(env, request, limit, attempt);
    if (sent.held !== undefined) {
      // oxlint-disable-next-line no-await-in-loop
      await refuse(env, call, sent.held);
    }
    const { answer } = sent;
    usage.inputTokens += inputTokens(answer.usage);
    usage.outputTokens += answer.usage.output;
    usage.cacheRead += answer.usage.cacheRead;
    usage.cacheWrite += answer.usage.cacheWrite;
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
      const stopped = limit.stopped();
      const trouble = troubleOf(request, sent, stopped);
      if (trouble !== undefined) {
        throw troubleError(
          request,
          trouble,
          stopped === undefined ? sent.rateLimited : undefined,
          provablyUnbilled(request, sent, stopped)
        );
      }
      if (sent.rateLimited !== undefined && stopped === undefined) {
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

/**
 * A platform call's route with its document (model-documents.ts): added
 * to each request's body as its API takes one, and bounded by the
 * model's window. Refused, and audited, for a model whose API takes none.
 */
const withDocumentRoute = async (
  route: Route,
  document: ModelDocument
): Promise<Pick<Route, "endpoint" | "bound">> => {
  const { endpoint, env, call, model } = route;
  const { api } = endpoint;
  if (!takesDocuments(api)) {
    return await refuse(env, call, {
      code: "model.not_allowed",
      because: "document",
    });
  }
  return {
    endpoint: {
      ...endpoint,
      onPayload: (payload) => {
        const shaped = endpoint.onPayload?.(payload) ?? payload;
        const attached = withDocument(api, shaped, document);
        if (attached === undefined) {
          // Never expected: pi's body always has the user's message.
          throw new Error("The document couldn't be added to the request");
        }
        return attached;
      },
    },
    bound: (body) => documentBound(call, model, body, documentPartTypes[api]),
  };
};

const callModel = async <Output>(
  env: Env,
  {
    schema,
    askAgain,
    beforeSend,
    reauthorize,
    onQueued,
    onText,
    signal,
    providerRetries = true,
    document,
    ...fields
  }: ModelCall<Output>,
  via: Via = chosenVia
): Promise<ModelAnswer<Output>> => {
  const call = parseCall(callSchema, fields);
  // Grasp's own key only for core's own platform features, never for work
  // of an App's, a person's or an agent's; and a document only for one.
  if (
    (via.kind === "platform" || document !== undefined) &&
    (via.kind !== "platform" ||
      call.work === undefined ||
      !("platform" in call.work))
  ) {
    throw modelErrors.create("model.invalid_call");
  }
  const admitted = await admit(env, call, via);
  const route: Route = {
    ...admitted,
    ...(document === undefined
      ? {}
      : await withDocumentRoute(admitted, document)),
    ...(beforeSend === undefined ? {} : { beforeSend }),
    ...(reauthorize === undefined ? {} : { reauthorize }),
    ...(onQueued === undefined ? {} : { onQueued }),
    ...(onText === undefined ? {} : { onText }),
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
 * `sent`'s answer with its usage as the gateway recorded it (`usedBy`):
 * the provider's counts, with an estimate on top where a failed request's
 * count fell short of what came of it, priced at the request's pinned
 * prices, in place of pi's own. So what a chat shows of a reply, answered
 * or failed, is what its `model.call` audit event says it used and cost.
 */
const chargedAnswer = (
  route: Pick<Route, "ref" | "price">,
  sent: Sent
): AssistantMessage => {
  const { answer } = sent;
  const used = usedBy(route, sent);
  const { usage } = answer;
  return {
    ...answer,
    usage: {
      ...usage,
      // The estimate goes to the prompt's own tokens, beside the cache's.
      input: usage.input + used.inputTokens - inputTokens(usage),
      output: used.outputTokens,
      totalTokens: used.inputTokens + used.outputTokens,
      cost: { ...usage.cost, total: used.cost },
    },
  };
};

/**
 * The context window of the model pi named `model` answered with, in
 * tokens, from the catalog of the providers the gateway offers; none for
 * a model it doesn't offer (core's own words, `grasp`).
 */
export const contextWindowOf = (model: string): number | undefined =>
  catalogWindowOf(model);

/**
 * Streams one admitted request to `out`, event by event, and records it
 * before its last event: the loop sees an answer only once its audit event
 * is safe. A failure reaches the loop in our own words.
 */
const relayEvents = async (
  env: Env,
  route: Route,
  { events, response }: Awaited<ReturnType<typeof open>>,
  out: AssistantMessageEventStream,
  limit: Deadline
): Promise<Route | undefined> => {
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
      return undefined;
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
      // Refused before anything streamed: the loop never saw it, so it
      // may go to the organization's next model.
      const next =
        partial === undefined
          ? await fallbackOf(env, route, response, stopped)
          : undefined;
      if (next !== undefined) {
        await auditFallback(env, route, next, response.failure);
        return next;
      }
      const trouble = troubleOf(route, response, stopped);
      let errorMessage =
        trouble === undefined
          ? failureMessage(failure)
          : troubleMessages[trouble];
      if (response.rateLimited !== undefined && stopped === undefined) {
        errorMessage = `The model's provider is limiting requests for now (model.rate_limited). Try again in ${response.rateLimited} seconds.`;
      }
      out.push({
        ...event,
        error: { ...chargedAnswer(route, sent), errorMessage },
      });
      return undefined;
    }
    if (event.type === "done") {
      const sent: Sent = { answer: event.message, ...response };
      await record(
        env,
        route,
        sent,
        1,
        event.reason === "length" ? "truncated" : "answered"
      );
      out.push({ ...event, message: chargedAnswer(route, sent) });
      return undefined;
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
  const sent: Sent = { answer, ...response };
  await record(env, route, sent, 1, "failed");
  out.push({
    type: "error",
    reason: "error",
    error: chargedAnswer(route, sent),
  });
  return undefined;
};

/**
 * One request of an agent loop: admitted by the deployment's rules as they
 * stand now (a refusal is audited, and reaches the loop in our words),
 * then sent and streamed to `out`.
 */
const relay = async (
  env: Env,
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
    let current: Route | undefined = route;
    while (current !== undefined) {
      // One model after another, as the call falls back.
      // oxlint-disable-next-line no-await-in-loop
      current = await relayEvents(
        env,
        current,
        // oxlint-disable-next-line no-await-in-loop
        await open(current, context, limit),
        out,
        limit
      );
    }
  } finally {
    limit.clear();
  }
};

/**
 * {@link relay}, but never failing: if the request can't be recorded, say,
 * the loop gets a failure instead of waiting for an answer forever.
 */
const relayOrFail = async (
  env: Env,
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

// Speech and listening: Grasp's own voice features, which Grasp pays for
// (src/platform-ai.ts). A speech model says a line, and a
// transcription model writes down what someone says (voice-models.ts),
// each fixed in code at its provider's EU host. They go through the gateway
// like any model call, as what is said and heard is interview content:
// the rules judge it, the ledger admits each provider request against the
// budgets, at its price per character or per second, and the audit log
// records it, never anything said or heard. They go to the provider's own
// API through connect, with Grasp's own key for it, which connect holds
// (`platformSecret` in @grasp-os/shared/ai-providers): core holds no key,
// and a provider Grasp has no key for is refused (`model.not_allowed`,
// because `platform`), never served by another.

/** Text without anything a URL's path would read apart: a voice's ID. */
const voiceIdPattern = /^[A-Za-z0-9]{1,64}$/u;

/** An ISO 639-1 language code. */
const languagePattern = /^[a-z]{2}$/u;

const speechSchema = z.strictObject({
  model: sessionShape.model,
  timeoutMs: sessionShape.timeoutMs,
  purpose: sessionShape.purpose,
  trigger: sessionShape.trigger,
  provenance: sessionShape.provenance,
  connections: sessionShape.connections,
  work: sessionShape.work,
  requestId: sessionShape.requestId,
  /** The line to say: at most `maxSpeechChars`, which bounds what it costs. */
  text: z.string().trim().min(1).max(maxSpeechChars),
  voice: z.string().regex(voiceIdPattern),
  language: z.string().regex(languagePattern),
});
type SpeechSession = z.output<typeof speechSchema>;

/** One line for a speech model to say. */
export type SpeechCall = z.input<typeof speechSchema> & {
  /** Where the call works: required, so no caller can leave it out. */
  work: NonNullable<z.input<typeof speechSchema>["work"]>;
};

/** How long a line may take to say when the call doesn't say, retry included. */
const speechTimeoutMs = 60_000;

/**
 * Retries for a line the provider refused for a moment (429 or 5xx):
 * ElevenLabs says a few lines at a time and turns the rest away, which is
 * over in a moment.
 */
const speechRetries = 1;

/** The wait before a line turned away is asked for again. */
const speechRetryMs = 500;

/** The audio asked for: MP3 at 44.1 kHz, 128 kbit/s, ElevenLabs's default. */
const speechFormat = { query: "mp3_44100_128", mime: "audio/mpeg" } as const;

/**
 * Steadier than the model's default: a voice says many separate lines, so
 * one line should sound like the next more than it should surprise.
 */
const voiceSettings = { stability: 0.7, similarity_boost: 0.8 };

/** The same seed for every line, so the same words sound the same. */
const voiceSeed = 7;

/** ElevenLabs's answer: the audio, and when each character is said. */
const spokenSchema = z.object({
  audio_base64: z.string().min(1),
  alignment: z.object({
    characters: z.array(z.string()),
    character_start_times_seconds: z.array(z.number().nonnegative()),
    character_end_times_seconds: z.array(z.number().nonnegative()),
  }),
});

/** Base64 as bytes; `undefined` for text that isn't base64. */
const bytesOf = (base64: string): Uint8Array | undefined => {
  try {
    return Uint8Array.from(atob(base64), (char) => char.codePointAt(0) ?? 0);
  } catch {
    return undefined;
  }
};

/** What the audit log records of one line, however it ended. */
interface SpeechRecord {
  /** Characters charged; 0 when the provider said nothing. */
  characters: number;
  /** Where its route went (`platformRouteOf`). */
  region: LedgerRoute["region"];
  cost: number;
  logId: string | undefined;
  outcome: Outcome;
  status: number | undefined;
  errorType: string | undefined;
  ledger: Ledgered;
}

/** The way a platform voice feature goes, as the ledger and the audit log record it. */
const platformWay = (
  provider: ConnectTarget["provider"],
  platform: PlatformRoute,
  feature: PlatformAiFeature
): LedgerRoute => ({
  transport: "connect",
  provider,
  region: platform.region,
  credential: "platform",
  feature,
});

/** A line's audit entry: a `model.call`, as any model call's. */
const speechEntry = (
  call: SpeechSession,
  ref: VoiceRef,
  judged: Judged,
  recorded: SpeechRecord
): AuditEntry => {
  const { logId } = recorded;
  return keepingProvenance(call.provenance, (provenance, dropped) => ({
    actor: call.trigger,
    action: "model.call",
    requestId: call.requestId,
    provenance,
    // A speech model counts characters, not tokens (`characters`).
    model: {
      provider: ref.provider,
      model: ref.id,
      inputTokens: 0,
      outputTokens: 0,
    },
    cost: { amount: recorded.cost, currency: "USD" },
    detail: {
      purpose: call.purpose,
      outcome: recorded.outcome,
      attempt: 1,
      status: recorded.status ?? null,
      errorType: recorded.errorType ?? null,
      characters: recorded.characters,
      voice: call.voice,
      language: call.language,
      ledger: recorded.ledger.state,
      ledgerRequests: recorded.ledger.requests,
      ledgerCharged: recorded.ledger.charged,
      ledgerHeld: recorded.ledger.held,
      transport: "connect",
      region: recorded.region,
      credential: "platform",
      gatewayLogId:
        logId !== undefined && logId.length <= auditIdentifierMaxLength
          ? logId
          : null,
      euOnly: judged.euOnly ?? null,
      sensitive: judged.sensitive ?? null,
      provenanceDropped: dropped,
      chat: chatOf(call),
      ...workflowRunOf(call),
    },
  }));
};

/** The most a line can add to its audit event (`largestRecord`). */
const largestSpeech: SpeechRecord = {
  characters: maxSpeechChars,
  region: "custom",
  cost: Number.MAX_VALUE,
  logId: "x".repeat(auditIdentifierMaxLength),
  outcome: "invalid_output",
  status: 599,
  errorType: "x".repeat(64),
  ledger: largestRecord.ledger,
};

/** A line's way to the speech model, through connect. */
interface SpeechRoute extends Admitting {
  call: SpeechSession;
  ref: VoiceRef;
  judged: Judged;
  price: PinnedPrice;
  /** Sends the line once, as the ledger admitted it (`id`). */
  send: (id: string, limit: Deadline) => Promise<Response>;
  /** What the line's text is charged as (`charactersOf`). */
  characters: number;
  /** Where its requests go on Grasp's own key (`platformRouteOf`). */
  platform: PlatformRoute;
}

/**
 * Where a platform voice feature goes: Grasp's own key for `provider`,
 * through connect; refused, and audited, when Grasp has no key for it.
 */
const platformTarget = async (
  env: Env,
  call: Session,
  provider: ConnectTarget["provider"]
): Promise<ConnectTarget & { platform: PlatformRoute }> => {
  const routes = await routesOrFailed(env);
  if (!routes.platform.includes(provider)) {
    return await refuse(env, call, {
      code: "model.not_allowed",
      because: "platform",
    });
  }
  const platform = platformRouteOf(provider);
  if (platform === undefined) {
    throw modelErrors.create("model.unconfigured");
  }
  return { credential: "platform", provider, baseUrl: null, platform };
};

/**
 * Checks a line against the deployment's rules, as `admit` does a text
 * model's call, before anything is sent: a model that isn't a speech
 * model of the gateway's, one the rules don't let it use, or one whose
 * provider Grasp has no key for is refused, and audited.
 */
const admitSpeech = async (
  env: Env,
  call: SpeechSession
): Promise<SpeechRoute> => {
  const rules = modelRules(env);
  if (rules === undefined) {
    throw modelErrors.create("model.unconfigured");
  }
  const ref = parseVoiceRef(call.model);
  if (ref === undefined) {
    return await refuse(env, call, { code: "model.not_allowed" });
  }
  try {
    createAuditEvent(
      speechEntry(call, ref, largestJudged, largestSpeech),
      "core"
    );
  } catch {
    // Never expected, as for a text model's call (`admit`).
    throw modelErrors.create("model.invalid_call");
  }
  const target = await platformTarget(env, call, ref.provider);
  // Said at ElevenLabs's EU host, as Grasp's own feature (`judgeCall`).
  const verdict = await judgeCall(env, rules, call, true);
  if (!verdict.ok) {
    return await refuse(env, call, verdict);
  }
  const price = await pinnedPrice(voicePricesOf(ref));
  if (price === undefined) {
    // Never expected: the voice catalog's prices are ours.
    return await refuse(env, call, { code: "model.unpriced" });
  }
  const place = crypto.randomUUID();
  const characters = charactersOf(call.text);
  const query = new URLSearchParams({
    // ElevenLabs keeps neither the line nor the audio.
    enable_logging: "false",
    output_format: speechFormat.query,
  });
  const path = `/v1/text-to-speech/${call.voice}/with-timestamps?${query.toString()}`;
  const body = JSON.stringify({
    text: call.text,
    model_id: ref.id,
    language_code: call.language,
    seed: voiceSeed,
    voice_settings: voiceSettings,
  });
  return {
    env,
    call,
    ref,
    judged: verdict.judged,
    price,
    way: platformWay(ref.provider, target.platform, "speech"),
    send: async (id, limit) =>
      await connectRequest(
        env,
        target,
        path,
        {
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body,
        },
        { ledgerRequest: id, endsAt: limit.endsAt, signal: limit.signal }
      ),
    characters,
    platform: target.platform,
    // The line's characters are all it is billed for, known before it is
    // sent: what the ledger reserves is what it charges.
    bound: () => ({ inputTokens: characters, outputTokens: 0 }),
    perRequest: undefined,
    // Grasp's own key: none of the organization's budgets (`platformScopes`).
    scopesNow: scopesNowOf(env, call, place, "platform"),
    disclose: shareIdentity(call).disclose,
    notes: Promise.resolve(),
    place,
  };
};

/** What one line's provider requests came to. */
interface SpeechSent {
  /** The provider's last response, if one came. */
  answered: Response | undefined;
  settled: RequestSettled[];
  /** The request the provider answered, to settle once its answer is read. */
  pending: Admission | undefined;
  /** Why the ledger held a request back, unsent. */
  held: Refusal | undefined;
}

/**
 * Sends one provider request for a line, admitted by the ledger first:
 * `again` when the provider refused it for a moment (429 or 5xx), which
 * may be asked once more; `done` once it ended any other way.
 */
const sendSpeechOnce = async (
  route: SpeechRoute,
  limit: Deadline,
  sent: SpeechSent
): Promise<"again" | "done"> => {
  const admitted = await admitWaiting(route, null, limit);
  if ("held" in admitted) {
    sent.held = admitted.held;
    return "done";
  }
  // Cancelled while it was admitted: never sent, its reservation back.
  if (limit.signal.aborted) {
    sent.settled.push(await settleAdmitted(route, admitted, { by: "unsent" }));
    return "done";
  }
  let answered: Response | undefined = undefined;
  try {
    answered = await route.send(admitted.id, limit);
  } catch {
    sent.settled.push(await settleAdmitted(route, admitted, { by: "unknown" }));
    return "done";
  }
  sent.answered = answered;
  if (answered.ok) {
    sent.pending = admitted;
    return "done";
  }
  // A refusal before the provider took the line on costs nothing; a
  // server error may have come after it did.
  sent.settled.push(
    await settleAdmitted(route, admitted, {
      by: answered.status < 500 ? "refused" : "unknown",
    })
  );
  return answered.status === 429 || answered.status >= 500 ? "again" : "done";
};

/**
 * Sends a line, and once more when the provider refused it for a moment,
 * as the model gateway does a text model's request. One that didn't
 * connect is not sent again: it may have been said, and billed.
 */
const sendSpeech = async (
  route: SpeechRoute,
  limit: Deadline
): Promise<SpeechSent> => {
  const sent: SpeechSent = {
    answered: undefined,
    settled: [],
    pending: undefined,
    held: undefined,
  };
  for (let request = 0; request <= speechRetries; request += 1) {
    if (request > 0) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      await sent.answered?.body?.cancel();
      // Only the last request's response says how the line ended.
      sent.answered = undefined;
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      await pause(speechRetryMs, limit.signal);
    }
    // oxlint-disable-next-line no-await-in-loop -- one request at a time
    const ended = await sendSpeechOnce(route, limit, sent);
    if (ended === "done") {
      break;
    }
  }
  return sent;
};

/** What a line's answer holds, read; `undefined` when it isn't a line. */
const readSpeech = async (answered: Response): Promise<Speech | undefined> => {
  const parsed = spokenSchema.safeParse(
    await answered.json().catch(() => null)
  );
  if (!parsed.success) {
    return undefined;
  }
  const audio = bytesOf(parsed.data.audio_base64);
  const words = wordsOf(parsed.data.alignment);
  return audio === undefined || words === undefined
    ? undefined
    : { audio, mime: speechFormat.mime, words };
};

/** A line's characters as the ledger counts them: all of them input. */
const characterCounts = (characters: number): TokenCounts => ({
  input: characters,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

/**
 * The line the provider answered with, read, and its provider request
 * settled: charged the line's characters, which the provider bills once
 * it answered, whether its answer could be read or not.
 */
const heardSpeech = async (
  route: SpeechRoute,
  { answered, pending }: SpeechSent
): Promise<{ speech: Speech | undefined; settled: RequestSettled[] }> => {
  if (answered === undefined || pending === undefined) {
    return { speech: undefined, settled: [] };
  }
  let speech: Speech | undefined = undefined;
  try {
    speech = await readSpeech(answered);
  } catch {
    // Cut off while its answer came in: said and billed all the same.
  }
  const settled = await settleAdmitted(route, pending, {
    by: "usage",
    tokens: characterCounts(route.characters),
  });
  return { speech, settled: [settled] };
};

/** How a line ended, as the audit log records it. */
const speechOutcome = (
  speech: Speech | undefined,
  said: boolean,
  stopped: Stopped | undefined
): Outcome => {
  if (speech !== undefined) {
    return "answered";
  }
  if (stopped === "cancelled") {
    return "cancelled";
  }
  // Said, but not as a line can be read.
  return said && stopped === undefined ? "invalid_output" : "failed";
};

/** The provider's own ID for a request, as its log names it. */
const providerLogIdOf = (headers: Headers | undefined): string | undefined =>
  headers?.get("x-request-id") ?? headers?.get("request-id") ?? undefined;

/** Records a line that was sent in the audit log, however it ended. */
const recordSpeech = async (
  route: SpeechRoute,
  sent: SpeechSent,
  {
    outcome,
    stopped,
    ledger,
  }: {
    outcome: Outcome;
    stopped: Stopped | undefined;
    ledger: Ledgered;
  }
): Promise<void> => {
  const { env, call } = route;
  const said = sent.pending !== undefined;
  const status = sent.answered?.status;
  const refusal =
    sent.answered !== undefined && !sent.answered.ok
      ? refusalOf(await sent.answered.text().catch(() => ""))
      : undefined;
  const errorType = stopped ?? refusal?.type;
  if (outcome !== "answered") {
    log.warn("model.failed", {
      model: call.model,
      status,
      errorType,
      providerErrorCode: refusal?.code,
      held: sent.held?.code,
    });
  }
  const characters = said ? route.characters : 0;
  await keepAuditEvent(
    env,
    drizzle(env.DB),
    speechEntry(call, route.ref, route.judged, {
      characters,
      region: route.platform.region,
      cost: costDollars(route.price, characterCounts(characters)),
      logId: providerLogIdOf(sent.answered?.headers),
      outcome,
      status,
      errorType,
      ledger,
    })
  );
};

// Listening: a transcription model writes down what someone says
// (voice-models.ts), live over the provider's realtime socket
// (transcription.ts), or from a recording (onboarding/hear.ts). The rules
// judge it before anything is sent, failing closed; the ledger admits it
// against the budgets at its price per second, for the most it may hear,
// before anything is opened; and the audit log records it once it ended,
// with the seconds heard and what they cost, never anything heard. The
// caller reaches the provider only through what its admission hands it
// (`Listening.send`, `Listening.socket`), each through connect with
// Grasp's key, and is held to the seconds admitted.
//
// One provider request a listening, whatever its length: its reservation
// is all it may hear, charged what it heard once it ended (`heard`), or
// in full should it never say so (the ledger's reconciliation). Unlike a
// text model's request it holds no share of the requests in flight while
// it is open (`listeningLeaseMs`): a socket open for minutes would
// otherwise keep Stephen's own turns, and every chat, from the client's
// share. The provider's own limit on sockets at once, the relay's per
// link, and the router's per address bound how many are open.

/** The most seconds one listening may hear: above any socket's or recording's. */
const maxListeningSeconds = 60 * 60;

/** The longest one listening may stay open. */
const maxListeningOpenMs = 60 * 60 * 1000;

/**
 * How long a listening holds its shares of the requests in flight once
 * admitted: not at all. It waits for one to be admitted, as any request
 * does, and gives it back at once.
 */
const listeningLeaseMs = 0;

const listeningSchema = z.strictObject({
  model: sessionShape.model,
  purpose: sessionShape.purpose,
  trigger: sessionShape.trigger,
  provenance: sessionShape.provenance,
  connections: sessionShape.connections,
  work: sessionShape.work,
  requestId: sessionShape.requestId,
  /**
   * The most seconds of audio it may hear: what the ledger reserves, and
   * what the caller holds the upstream to.
   */
  seconds: z.int().positive().max(maxListeningSeconds),
  /** How long it may stay open, in ms: when it is charged in full, if never settled. */
  openMs: z.int().positive().max(maxListeningOpenMs),
});
type ListeningSession = z.output<typeof listeningSchema>;

/** A transcription model asked to listen. */
export type ListeningCall = z.input<typeof listeningSchema> & {
  /** Where the call works: required, so no caller can leave it out. */
  work: NonNullable<z.input<typeof listeningSchema>["work"]>;
};

/** How a listening ended, as the audit log records it. */
export type ListeningOutcome = "answered" | "failed" | "cancelled";

/** A listening the gateway admitted: the way to the provider, and how it is charged. */
export interface Listening {
  /** The model as its provider's API names it, such as `gpt-4o-transcribe`. */
  modelId: string;
  /**
   * Sends one request of it to `path` at the provider (a recording to
   * write down), through connect with Grasp's key, until it may no longer
   * be open. Throws when no answer came.
   */
  send: (
    path: string,
    init: { headers: Record<string, string>; body: BodyInit },
    signal?: AbortSignal
  ) => Promise<Response>;
  /**
   * Opens its realtime socket to `pathAndQuery` at the provider, through
   * connect, which relays it with Grasp's key until it may no longer be
   * open. Throws when it won't open.
   */
  socket: (pathAndQuery: string, signal?: AbortSignal) => Promise<WebSocket>;
  /** The seconds admitted: the most it may hear. */
  seconds: number;
  /**
   * Charges the seconds it heard (whole seconds, rounded up, and never
   * more than admitted), gives the rest of its reservation back, and
   * audits it as a model call. Once: a second call does nothing. Never
   * throws.
   */
  heard: (seconds: number, outcome: ListeningOutcome) => Promise<void>;
}

/** What the audit log records of one listening, however it ended. */
interface HeardRecord {
  /** Seconds charged. */
  seconds: number;
  /** Where its route went (`platformRouteOf`). */
  region: LedgerRoute["region"];
  cost: number;
  outcome: Outcome;
  ledger: Ledgered;
}

/** A listening's audit entry: a `model.call`, as any model call's. */
const listeningEntry = (
  call: ListeningSession,
  ref: HearingRef,
  judged: Judged,
  recorded: HeardRecord
): AuditEntry =>
  keepingProvenance(call.provenance, (provenance, dropped) => ({
    actor: call.trigger,
    action: "model.call",
    requestId: call.requestId,
    provenance,
    // A transcription model counts seconds heard, not tokens (`seconds`).
    model: {
      provider: ref.provider,
      model: ref.id,
      inputTokens: 0,
      outputTokens: 0,
    },
    cost: { amount: recorded.cost, currency: "USD" },
    detail: {
      purpose: call.purpose,
      outcome: recorded.outcome,
      attempt: 1,
      seconds: recorded.seconds,
      ledger: recorded.ledger.state,
      ledgerRequests: recorded.ledger.requests,
      ledgerCharged: recorded.ledger.charged,
      ledgerHeld: recorded.ledger.held,
      transport: "connect",
      region: recorded.region,
      credential: "platform",
      euOnly: judged.euOnly ?? null,
      sensitive: judged.sensitive ?? null,
      provenanceDropped: dropped,
      chat: chatOf(call),
      ...workflowRunOf(call),
    },
  }));

/** The most a listening can add to its audit event (`largestRecord`). */
const largestHeard: HeardRecord = {
  seconds: maxListeningSeconds,
  region: "custom",
  cost: Number.MAX_VALUE,
  outcome: "invalid_output",
  ledger: largestRecord.ledger,
};

/** Seconds heard as the ledger counts them: all of them input. */
const secondCounts = (seconds: number): TokenCounts => ({
  input: seconds,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

/** The seconds a listening is charged: whole, rounded up, at most `most`. */
const chargedSeconds = (heard: number, most: number): number =>
  Number.isFinite(heard) ? Math.min(most, Math.ceil(Math.max(0, heard))) : most;

/**
 * Checks a listening against the deployment's rules, as `admitSpeech`
 * does a line, and has the ledger admit it for the most it may hear,
 * before anything is sent. A model that isn't a transcription model of
 * the gateway's (a speech model, or a text model), one the rules don't
 * let it use, one whose provider Grasp has no key for, or a budget with
 * no room refuses it, audited as a refused model call. Fails closed:
 * rules that don't parse send nothing.
 */
const listenThrough = async (
  env: Env,
  fields: ListeningCall,
  signal: AbortSignal | undefined
): Promise<Listening> => {
  const call = parseCall(listeningSchema, fields);
  const rules = modelRules(env);
  if (rules === undefined) {
    throw modelErrors.create("model.unconfigured");
  }
  const ref = parseHearingRef(call.model);
  if (ref === undefined) {
    return await refuse(env, call, { code: "model.not_allowed" });
  }
  try {
    createAuditEvent(
      listeningEntry(call, ref, largestJudged, largestHeard),
      "core"
    );
  } catch {
    // Never expected, as for a text model's call (`admit`).
    throw modelErrors.create("model.invalid_call");
  }
  const target = await platformTarget(env, call, ref.provider);
  // Heard at OpenAI's EU host, as Grasp's own feature (`judgeCall`).
  const verdict = await judgeCall(env, rules, call, true);
  if (!verdict.ok) {
    return await refuse(env, call, verdict);
  }
  const price = await pinnedPrice(hearingPricesOf(ref));
  if (price === undefined) {
    // Never expected: the transcription catalog's prices are ours.
    return await refuse(env, call, { code: "model.unpriced" });
  }
  const place = crypto.randomUUID();
  const admitting: Admitting = {
    env,
    call,
    price,
    way: platformWay(ref.provider, target.platform, "transcription"),
    perRequest: undefined,
    // What it may hear is all it is billed for, known before it opens.
    bound: () => ({ inputTokens: call.seconds, outputTokens: 0 }),
    // Grasp's own key: none of the organization's budgets (`platformScopes`).
    scopesNow: scopesNowOf(env, call, place, "platform"),
    disclose: shareIdentity(call).disclose,
    notes: Promise.resolve(),
    place,
    leaseMs: listeningLeaseMs,
  };
  const endsAt = Date.now() + call.openMs;
  const admitted = await admitWaiting(admitting, null, {
    endsAt,
    signal: signal ?? new AbortController().signal,
  });
  if ("held" in admitted) {
    return await refuse(env, call, admitted.held);
  }
  const sentBy = (stop: AbortSignal | undefined) => ({
    ledgerRequest: admitted.id,
    endsAt,
    ...(stop === undefined ? {} : { signal: stop }),
  });
  let ended = false;
  return {
    modelId: ref.id,
    send: async (path, init, stop) =>
      await connectRequest(env, target, path, init, sentBy(stop)),
    socket: async (pathAndQuery, stop) =>
      await connectSocket(env, target, pathAndQuery, sentBy(stop)),
    seconds: call.seconds,
    heard: async (heard, outcome) => {
      if (ended) {
        return;
      }
      ended = true;
      const seconds = chargedSeconds(heard, call.seconds);
      const settled = await settleAdmitted(admitting, admitted, {
        by: "usage",
        tokens: secondCounts(seconds),
      });
      try {
        await keepAuditEvent(
          env,
          drizzle(env.DB),
          listeningEntry(call, ref, verdict.judged, {
            seconds,
            region: target.platform.region,
            cost: costDollars(price, secondCounts(seconds)),
            outcome,
            ledger: ledgerOf([settled]),
          })
        );
      } catch (error) {
        log.error("model.listening_unaudited", errorFields(error));
      }
    },
  };
};

/**
 * Says a line through the gateway: refused, audited, before anything is
 * sent when the rules, Grasp's keys or a budget don't let it through;
 * otherwise sent, charged its characters and audited, however it ended.
 */
const speakLine = async (
  env: Env,
  fields: SpeechCall,
  signal: AbortSignal | undefined
): Promise<Speech> => {
  const call = parseCall(speechSchema, fields);
  const route = await admitSpeech(env, call);
  const limit = deadline(call.timeoutMs ?? speechTimeoutMs, signal);
  try {
    const sent = await sendSpeech(route, limit);
    const { speech, settled } = await heardSpeech(route, sent);
    const ledger = ledgerOf([...sent.settled, ...settled]);
    const { held } = sent;
    // Held back before any request was sent: a refusal, and nothing else;
    // after one was, that one is recorded first.
    if (held !== undefined && ledger.requests === 0) {
      return await refuse(env, call, held);
    }
    const stopped = limit.stopped();
    const outcome = speechOutcome(speech, sent.pending !== undefined, stopped);
    await recordSpeech(route, sent, { outcome, stopped, ledger });
    if (held !== undefined) {
      return await refuse(env, call, held);
    }
    if (speech !== undefined) {
      return speech;
    }
    if (sent.answered?.status === 429 && stopped === undefined) {
      throw modelErrors.create("model.rate_limited", {
        model: call.model,
        retryAfterSeconds: rateLimitedSeconds(sent.answered.headers),
      });
    }
    throw modelErrors.create("model.failed");
  } finally {
    limit.clear();
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
  env: Env,
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
 * purpose, trigger })`. Refuses a model the organization didn't choose
 * or its rules don't let the call use, sends the call to the provider
 * through connect, falling back to the organization's next model
 * when the provider refuses it before anything could be billed, and
 * records every request it makes, and every refusal, in the audit log. With a `schema`, the answer is JSON that matches it.
 *
 * `await models(env).agent({ model, purpose, trigger, work }, provenance)`
 * is the same for an agent loop: a model that streams and calls tools.
 * The session is refused up front, before the loop keeps or sends
 * anything, and each request is admitted again by the rules as they stand
 * then (the context's restricted mode, what `provenance` says it has read
 * by then, the budgets), sent and audited like a call's.
 *
 * `await models(env).speak({ model, text, voice, language, purpose,
 * trigger, work }, signal)` has a speech model say a line, with Grasp's
 * key for its provider: judged by the same rules, charged per character
 * against the same budgets, and audited like a call. It returns the audio
 * and when each word is said.
 *
 * `await models(env).listen({ model, seconds, openMs, purpose, trigger,
 * work }, signal)` admits a transcription model to hear at most `seconds`
 * of audio, with Grasp's key for its provider: judged by the same rules,
 * reserved per second against the same budgets, refused and audited like
 * a call when they don't let it through. It returns the way to the
 * provider, and `heard`, which charges what was heard and audits it once
 * it ended.
 */
export const models = (env: Env) => ({
  call: async <Output = undefined>(
    call: ModelCall<Output>
  ): Promise<ModelAnswer<Output>> => await callModel(env, call),
  /**
   * A call of one of core's own platform features (its `work` names the
   * feature), to `<provider>/<model>` with Grasp's own key for the
   * provider, which connect holds (`OPENAI_API_KEY` and the like): judged
   * by the rules, admitted against the budgets and audited like any call,
   * never falling back. Refused as `model.not_allowed` when Grasp has no
   * key for the provider. Only a platform call may carry a `document`.
   */
  platformCall: async <Output = undefined>(
    call: ModelCall<Output>
  ): Promise<ModelAnswer<Output>> =>
    await callModel(env, call, { kind: "platform" }),
  /**
   * An admin's test of a provider the organization connected: a call to
   * any of its models with the organization's key, whether or not chosen,
   * metered and audited like any (ai-providers.ts).
   */
  providerTest: async (
    call: ModelCall<undefined>,
    provider: ConnectTarget["provider"]
  ): Promise<ModelAnswer<undefined>> =>
    await callModel(env, call, { kind: "test", provider }),
  agent: async (
    session: AgentSession,
    provenance: () => readonly string[] = () => []
  ): Promise<AgentModel> => await agentModel(env, session, provenance),
  speak: async (call: SpeechCall, signal?: AbortSignal): Promise<Speech> =>
    await speakLine(env, call, signal),
  listen: async (
    call: ListeningCall,
    signal?: AbortSignal
  ): Promise<Listening> => await listenThrough(env, call, signal),
});

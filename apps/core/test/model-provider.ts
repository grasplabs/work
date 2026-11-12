/**
 * The model provider behind connect, as core's tests script it: the
 * organization connects a provider with a key of the test's own, and
 * chooses its models (`answeringProvider`); every request core's gateway
 * sends through connect with that key reaches the providers fake
 * (test/ai-providers-fake.ts), which hands it to the test (its bridge).
 * The test answers each with the next scripted reply, in the wire format
 * of the provider's API the request went to, and keeps every request it
 * got. Core, connect, the ledger and the audit log are real; only the
 * provider is faked.
 */
import { aiProviderIdSchema } from "@grasp-os/shared/ai-providers";
import type { AiProviderId } from "@grasp-os/shared/ai-providers";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { aiModelsKind } from "../src/ai-model-choice.ts";
import { orgSettings } from "../src/db/core/schema.ts";
import { bridgeUrl, compatibleHost } from "./ai-providers-fake.ts";
import type { BridgeCommand, BridgedRequest } from "./ai-providers-fake.ts";
import { relabelled } from "./drawing-labels.ts";
import { eventsFor, sse } from "./provider-streams.ts";
import type { ProviderReply } from "./provider-streams.ts";
import { testBinding } from "./test-env.ts";

export type {
  Answer,
  ProviderReply,
  ScriptedToolCall,
} from "./provider-streams.ts";

/** One request that reached the provider, as the test read it. */
export interface SentRequest {
  url: string;
  headers: Headers;
  body: unknown;
  /** Its signal: aborted once its caller went away. */
  signal: AbortSignal;
}

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The Worker standing in for the internet behind connect. */
const internet = (): Fetcher => {
  const binding = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(binding)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return binding;
};

/** Tells the fake how to answer the bridged request `id`. */
const command = async (
  id: string,
  commands: BridgeCommand[]
): Promise<void> => {
  const response = await internet().fetch(bridgeUrl, {
    method: "POST",
    body: JSON.stringify({ id, commands }),
  });
  await response.body?.cancel();
};

/** Answers the bridged request `id`, which asked at `path`, with `reply`. */
const answerWith = async (
  id: string,
  path: string,
  reply: ProviderReply
): Promise<void> => {
  if ("hang" in reply) {
    // No answer: the request waits until its caller goes away.
    return;
  }
  if ("status" in reply) {
    // As Anthropic words it; pi quotes OpenAI's inner `error` the same way.
    await command(id, [
      {
        status: reply.status,
        headers: reply.headers ?? {},
        body: reply.body ?? {
          type: "error",
          error: {
            type: reply.errorType ?? "api_error",
            message: "Refused by the fake provider",
          },
        },
      },
    ]);
    return;
  }
  const events = eventsFor(path, reply);
  if (events === undefined) {
    await command(id, [{ status: 404, body: { error: "No such route" } }]);
    return;
  }
  const decoder = new TextDecoder();
  let pending: BridgeCommand[] = [{ open: {} }];
  let text = "";
  const flush = async () => {
    if (text !== "") {
      pending.push({ write: text });
      text = "";
    }
    if (pending.length > 0) {
      await command(id, pending);
      pending = [];
    }
  };
  for (const item of events) {
    if ("until" in item) {
      // oxlint-disable-next-line no-await-in-loop -- what came before is sent first
      await flush();
      item.reached?.();
      // oxlint-disable-next-line no-await-in-loop -- paused where told
      await item.until;
    } else {
      text += decoder.decode(sse(item));
    }
  }
  pending.push(...(text === "" ? [] : [{ write: text }]), { end: true });
  text = "";
  await flush();
};

/** What a look at the bridge finds: new requests, and those gone. */
const lookSchema = z.object({
  requests: z.array(
    z.object({
      id: z.string(),
      host: z.string(),
      method: z.string(),
      path: z.string(),
      headers: z.record(z.string(), z.string()),
      body: z.string(),
    })
  ),
  gone: z.array(z.string()),
});

/** How often the test looks for requests that reached the provider. */
const pollMs = 10;

/** The bridges still looking, stopped when the next starts or the file ends. */
const running = new Set<() => void>();

/**
 * Replies to the analysis alongside a chat's recall before its question
 * (src/turn-recall.ts), in the order a test queued them once its provider
 * started, apart from every provider's script; once none is left, nothing
 * to look up. Each request of it that reached the provider is kept in
 * `recallAnalysisRequests`. Both start empty with each provider.
 */
export const recallAnalysisReplies: ProviderReply[] = [];

/** Every request of a recall's analysis that reached the provider, oldest first. */
export const recallAnalysisRequests: SentRequest[] = [];

/** Stops every bridge still looking (test/start-each-file.ts, at a file's end). */
export const stopModelProviders = (): void => {
  for (const stop of running) {
    stop();
  }
  running.clear();
  recallAnalysisReplies.length = 0;
  recallAnalysisRequests.length = 0;
};

/** The model the tests use unless they choose others. */
export const testModel = "anthropic/claude-sonnet-4-5";

/** The organization's admin the tests name as changing its keys in connect. */
export const keyChanger = { type: "person", userId: "test-admin" } as const;

/** Where an organization's OpenAI-compatible endpoint is in the tests. */
export const compatibleBaseUrl = `https://${compatibleHost}/v1`;

/**
 * Connects every provider of `models` with `key`, as an organization's
 * admin adds its keys (connect seals them), and chooses `models`: the
 * first the default, the rest its fallbacks, in order.
 */
export const connectModels = async (
  key: string,
  models: readonly string[]
): Promise<void> => {
  const providers = new Set<AiProviderId>(
    models.map((model) =>
      aiProviderIdSchema.parse(model.slice(0, model.indexOf("/")))
    )
  );
  for (const provider of providers) {
    // oxlint-disable-next-line no-await-in-loop -- one key at a time, as an admin adds them
    await env.CONNECT.saveAiProviderKey(
      provider === "openai-compatible"
        ? { provider, key, baseUrl: compatibleBaseUrl }
        : { provider, key },
      keyChanger
    );
  }
  const [defaultModel, ...fallbacks] = models;
  if (defaultModel === undefined) {
    return;
  }
  const value = JSON.stringify({ defaultModel, fallbacks });
  await drizzle(env.DB)
    .insert(orgSettings)
    .values({ kind: aiModelsKind, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: orgSettings.kind,
      set: { value, updatedAt: new Date() },
    });
};

/**
 * Replies to core's own calls about Stephen's requests (sorting one,
 * proposing a fix: src/channels/request-sorting.ts, src/stephen-requests.ts),
 * in the order a test queued them, apart from every provider's script;
 * once none is left, a sorting that sorts nothing.
 */
export const stephenRequestReplies: ProviderReply[] = [];

const sortsNothing: ProviderReply = {
  text: JSON.stringify({
    topic: null,
    newTopic: null,
    question: null,
    newQuestion: null,
    role: null,
    answered: true,
  }),
  inputTokens: 10,
  outputTokens: 10,
};

/**
 * How core's calls about Stephen's requests begin their instructions: the
 * provider sees no purpose, only the request, so the fake knows them by
 * what they ask.
 */
const stephenRequestsOpenings = [
  "You sort one message a person sent to Stephen",
  "You help the owner of a company's Grasp workspace improve Stephen",
];

/** Whether a request's body is one of core's own about Stephen's requests. */
const isStephenRequests = (body: unknown): boolean => {
  const text = JSON.stringify(body) ?? "";
  return stephenRequestsOpenings.some((opening) => text.includes(opening));
};

const nothingToLookUp: ProviderReply = {
  text: JSON.stringify({ query: null }),
  inputTokens: 10,
  outputTokens: 5,
};

/** How the analysis's instructions begin: the provider sees no purpose. */
const recallAnalysisOpening =
  "You prepare a search of a company's knowledge for the latest message of a chat.";

/** Whether a request's body is a recall's analysis. */
const isRecallAnalysis = (body: unknown): boolean =>
  (JSON.stringify(body) ?? "").includes(recallAnalysisOpening);

/** A provider the tests answer for, and what reached it. */
export interface FakeProvider {
  /** The key the organization connected it with. */
  key: string;
  /** The models the organization chose, the default first. */
  models: readonly string[];
  /** Every request that reached it, oldest first, as they come. */
  requests: SentRequest[];
}

/**
 * Connects a provider for `models` (`connectModels`), with a key no other
 * test uses, and answers each request that reaches it with what `respond`
 * makes of it, given the requests so far, this one last: at once, or once
 * whatever it waits for has come. Answers until another starts, or the
 * test file ends.
 */
export const answeringProvider = async (
  respond: (
    requests: readonly SentRequest[]
  ) => ProviderReply | undefined | Promise<ProviderReply | undefined>,
  { models = [testModel] }: { models?: readonly string[] } = {}
): Promise<FakeProvider> => {
  stopModelProviders();
  const key = `test-model-key-${crypto.randomUUID()}`;
  const bridged = await internet().fetch(bridgeUrl, {
    method: "POST",
    body: JSON.stringify({ key }),
  });
  await bridged.body?.cancel();
  await connectModels(key, models);
  const requests: SentRequest[] = [];
  const cutOff = new Map<string, AbortController>();
  const state = { stopped: false };
  const stop = () => {
    state.stopped = true;
  };
  running.add(stop);
  const answer = async (taken: BridgedRequest): Promise<void> => {
    let body: unknown = undefined;
    try {
      body = JSON.parse(taken.body);
    } catch {
      ({ body } = taken);
    }
    // Stephen's request sorting answers apart from the test's script, as
    // it isn't part of the turn the script is written for.
    if (isStephenRequests(body)) {
      await answerWith(
        taken.id,
        taken.path,
        stephenRequestReplies.shift() ?? sortsNothing
      );
      return;
    }
    const controller = new AbortController();
    cutOff.set(taken.id, controller);
    // A chat's recall analysis too, as it runs alongside the turn's script.
    if (isRecallAnalysis(body)) {
      recallAnalysisRequests.push({
        url: `https://${taken.host}${taken.path}`,
        headers: new Headers(taken.headers),
        body,
        signal: controller.signal,
      });
      await answerWith(
        taken.id,
        taken.path,
        recallAnalysisReplies.shift() ?? nothingToLookUp
      );
      return;
    }
    requests.push({
      url: `https://${taken.host}${taken.path}`,
      headers: new Headers(taken.headers),
      body,
      signal: controller.signal,
    });
    const reply = await relabelled(await respond(requests), body);
    // None left: refused, as a provider that failed (the call fails).
    await answerWith(
      taken.id,
      taken.path,
      reply ?? {
        status: 500,
        body: { error: "The fake provider has no reply left" },
      }
    );
  };
  /** Answers `taken`, or refuses it when its scripted reply failed to come. */
  const answerOrRefuse = async (taken: BridgedRequest): Promise<void> => {
    try {
      await answer(taken);
    } catch {
      try {
        await command(taken.id, [{ status: 500 }]);
      } catch {
        // The request is gone already.
      }
    }
  };
  const look = async (): Promise<void> => {
    while (!state.stopped) {
      // oxlint-disable-next-line no-await-in-loop -- one look at a time
      const response = await internet().fetch(
        `${bridgeUrl}?key=${encodeURIComponent(key)}`
      );
      const { requests: fresh, gone } = lookSchema.parse(
        // oxlint-disable-next-line no-await-in-loop -- one look at a time
        await response.json()
      );
      for (const id of gone) {
        cutOff.get(id)?.abort(new Error("The request was aborted"));
      }
      // In order, each answered on its own: a paused answer holds up no other.
      for (const taken of fresh) {
        void answerOrRefuse(taken);
      }
      // oxlint-disable-next-line no-await-in-loop -- between looks
      await scheduler.wait(pollMs);
    }
  };
  void look();
  return { key, models, requests };
};

/**
 * A provider for `models` (`answeringProvider`) that answers with
 * `replies`, in order.
 */
export const fakeProvider = async (
  ...replies: ProviderReply[]
): Promise<FakeProvider> => await answeringProvider(() => replies.shift());

/**
 * A provider for `models` that answers with `replies`, in order: the
 * models chosen first.
 */
export const fakeProviderFor = async (
  models: readonly string[],
  ...replies: ProviderReply[]
): Promise<FakeProvider> =>
  await answeringProvider(() => replies.shift(), { models });

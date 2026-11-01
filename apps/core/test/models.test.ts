import { Type } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { aiModelsKind } from "../src/ai-model-choice.ts";
import { models } from "../src/models.ts";
import type { ModelCall } from "../src/models.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { fakeProviderFor } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// The provider behind connect is the outside system here: a fake that
// answers in each provider's own wire format. Everything else is real,
// connect and the ledger down to the audit log.

/**
 * The most core's own work may add before an answer's first words reach
 * its caller: the rules, the quota policy read from D1, and admission by
 * the model ledger, with the provider answering at once. Stephen's whole
 * turn has 2.3 seconds to his first sound, most of it the
 * model's; core, in workerd, takes a few tens of milliseconds, so this
 * leaves room for a slow CI runner while still failing on a new round
 * trip, or a wait, before the first token.
 */
const firstTokenBudgetMs = 500;

/** A model that doesn't think, on chat completions. */
const mistral = "mistral/mistral-large-latest";
const anthropic = "anthropic/claude-sonnet-4-5";
const openai = "openai/gpt-5.4";

/** The models the organization chose here: its default, then its fallbacks. */
const chosen = [mistral, anthropic, openai];

const answer = (text: string): ProviderReply => ({
  text,
  inputTokens: 1000,
  outputTokens: 100,
});

/**
 * Core's env with the provider answering with `replies` for `models`, the
 * organization's choice, and `rules` as the deployment's, none by
 * default: model-rules.test.ts tests them.
 */
const withProvider = async (
  replies: ProviderReply[],
  {
    rules,
    models: choice = chosen,
  }: { rules?: unknown; models?: string[] } = {}
) => {
  const provider = await fakeProviderFor(choice, ...replies);
  const providerEnv: Env = { ...env, MODEL_GATEWAY: rules };
  return { provider, providerEnv };
};

const idp = mockIdp();

/**
 * Where the calls here work: an App of their own, made before the first
 * test and kept for the rest, as every call's context must exist.
 */
let madeWork: ModelCall<undefined>["work"] | undefined;

/** Makes the calls' App, before the file's first test. */
const makeWork = async (): Promise<void> => {
  if (madeWork !== undefined) {
    return;
  }
  const builder = await signedInApi(idp, "builder");
  const { id } = await builder.api.apps.create({ name: "Models" });
  const appId = appIdSchema.parse(id);
  madeWork = {
    authority: {
      subject: { type: "app", appId },
      onBehalfOf: builder.userId,
      mode: "interactive",
      appVersion: 1,
    },
    context: { type: "app", appId },
  };
};

/** The calls' work context, once made. */
const work = (): ModelCall<undefined>["work"] => {
  if (madeWork === undefined) {
    throw new Error("The tests' App isn't made yet");
  }
  return madeWork;
};

/** A person no other test uses, so their audit events are this test's. */
const newPerson = () =>
  ({ type: "person", userId: `person-${crypto.randomUUID()}` }) as const;

// Efforts: Claude Opus 4.8 and GPT-5.6 Sol take all five levels; GPT-5.4 none
// past xhigh, Claude Sonnet 4.5 none past high, Claude Opus 4.6 all but
// xhigh, and Mistral Small high only. Mistral Large doesn't think.
const opus = "anthropic/claude-opus-4-8";
const opus46 = "anthropic/claude-opus-4-6";
const sol = "openai/gpt-5.6-sol";
const mistralSmall = "mistral/mistral-small-latest";
/** A model whose window is small: GPT-4's 8,192 tokens. */
const smallWindow = "openai/gpt-4";

/** The request body a call to `model` at `effort` sent the provider. */
const sentAt = async (
  model: string,
  effort?: ModelCall<undefined>["effort"]
): Promise<unknown> => {
  const { provider, providerEnv } = await withProvider([answer("Hello.")], {
    models: [model],
  });
  await models(providerEnv).call({
    model,
    input: "Say hello.",
    effort,
    purpose: "chat.turn",
    trigger: newPerson(),
    work: work(),
  });
  return provider.requests[0]?.body;
};

/** The audit events triggered by `userId`, once `count` have arrived. */
const auditedFor = async (
  userId: string,
  count: number
): Promise<AuditEvent[]> => {
  const mine = async () => {
    const events = await allEvents();
    return events.filter(
      ({ actor }) => actor.type === "person" && actor.userId === userId
    );
  };
  await vi.waitFor(
    async () => {
      await expect(mine()).resolves.toHaveLength(count);
    },
    { timeout: 10_000, interval: 50 }
  );
  return await mine();
};

/** A database or audit log that is down. */
const refuse = (): never => {
  throw new Error("Unavailable");
};

// A test waits up to 10 seconds for a call's audit events (`auditedFor`),
// which reach the log through the audit outbox after the answer. Under
// the default five seconds a slow event would fail as a test timeout, not
// as the events that never came. No test waits more than once, so thirty
// seconds holds that wait and the calls around it on a slow runner.
describe("model gateway", { timeout: 30_000 }, () => {
  beforeEach(makeWork);

  it.each([mistral, anthropic, openai])(
    "answers a chat call to %s, sending it the whole conversation",
    async (model) => {
      const { provider, providerEnv } = await withProvider([
        answer("Hello, Ada."),
      ]);

      const result = await models(providerEnv).call({
        model,
        system: "Greet people by name.",
        messages: [
          { role: "user", content: "Hi, I'm Ada." },
          { role: "assistant", content: "Hi! What can I do?" },
          { role: "user", content: "Say hello." },
        ],
        purpose: "chat.turn",
        trigger: newPerson(),
        work: work(),
      });

      expect(result).toMatchObject({
        text: "Hello, Ada.",
        output: undefined,
        usage: { inputTokens: 1000, outputTokens: 100 },
      });
      expect(provider.requests).toHaveLength(1);
      // The whole conversation went along, not only the last turn.
      const body = JSON.stringify(provider.requests[0]?.body);
      for (const text of [
        "Greet people by name.",
        "Hi, I'm Ada.",
        "Say hello.",
      ]) {
        expect(body).toContain(text);
      }
    }
  );

  it("asks a model that thinks for an effort with each provider's own parameter", async () => {
    await expect(sentAt(opus, "max")).resolves.toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
    });
    await expect(sentAt(sol, "max")).resolves.toMatchObject({
      reasoning: { effort: "max" },
    });
    await expect(sentAt(mistralSmall, "high")).resolves.toMatchObject({
      reasoning_effort: "high",
    });
  });

  it("asks a model that lacks the effort asked for the next one up it takes, or its highest", async () => {
    // The next level up it has, or its highest when it has none above.
    expect({
      gpt54: await sentAt(openai, "max"),
      sonnet45: await sentAt(anthropic, "max"),
      opus46: await sentAt(opus46, "xhigh"),
      mistralSmall: await sentAt(mistralSmall, "medium"),
    }).toStrictEqual({
      gpt54: await sentAt(openai, "xhigh"),
      sonnet45: await sentAt(anthropic, "high"),
      opus46: await sentAt(opus46, "max"),
      mistralSmall: await sentAt(mistralSmall, "max"),
    });
  });

  it("asks for medium effort when a call names none, and a model that doesn't think as before", async () => {
    // One request at a time: a provider connected for the next stops
    // answering the last.
    for (const model of [opus, sol, mistralSmall, anthropic]) {
      // oxlint-disable-next-line no-await-in-loop -- one model at a time
      const unnamed = await sentAt(model);
      // oxlint-disable-next-line no-await-in-loop -- one model at a time
      expect(unnamed).toStrictEqual(await sentAt(model, "medium"));
    }
    await expect(sentAt(opus)).resolves.toMatchObject({
      output_config: { effort: "medium" },
    });
    await expect(sentAt(sol)).resolves.toMatchObject({
      reasoning: { effort: "medium" },
    });
    const maxOfNone = await sentAt(mistral, "max");
    expect(maxOfNone).toStrictEqual(await sentAt(mistral));
  });

  it("records in the audit log the effort each request asked its model for", async () => {
    const trigger = newPerson();
    const { providerEnv } = await withProvider(
      [answer("One"), answer("Two"), answer("Three")],
      { models: [opus, openai, mistral] }
    );
    for (const model of [opus, openai, mistral]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await models(providerEnv).call({
        model,
        input: "Think hard.",
        effort: "max",
        purpose: "chat.turn",
        trigger,
        work: work(),
      });
    }

    const events = await auditedFor(trigger.userId, 3);
    // GPT-5.4 has no max; Mistral Large doesn't think.
    expect(
      Object.fromEntries(
        events.map(({ model, detail }) => [model?.model, detail.effort])
      )
    ).toStrictEqual({
      "claude-opus-4-8": "max",
      "gpt-5.4": "xhigh",
      "mistral-large-latest": null,
    });
  });

  it("returns structured output parsed with the call's schema", async () => {
    const { providerEnv } = await withProvider([
      answer('```json\n{ "vendor": "Acme", "total": 42.5 }\n```'),
    ]);

    const result = await models(providerEnv).call({
      model: anthropic,
      system: "Read the invoice.",
      input: { invoice: "Acme, total 42.50" },
      schema: z.object({ vendor: z.string(), total: z.number() }),
      purpose: "workflow.step",
      trigger: newPerson(),
      work: work(),
    });

    expect(result.output).toStrictEqual({ vendor: "Acme", total: 42.5 });
  });

  it("asks once more when the answer doesn't match the schema", async () => {
    const trigger = newPerson();
    const { provider, providerEnv } = await withProvider([
      answer("The total is 42."),
      answer('{ "total": 42 }'),
    ]);

    const result = await models(providerEnv).call({
      model: mistral,
      input: "What's the total?",
      schema: z.object({ total: z.number() }),
      purpose: "workflow.step",
      trigger,
      work: work(),
    });

    // Both requests count.
    expect(result).toMatchObject({
      output: { total: 42 },
      usage: { inputTokens: 2000, outputTokens: 200 },
    });
    // The second request shows the model its answer and why it didn't fit.
    expect(provider.requests).toHaveLength(2);
    expect(JSON.stringify(provider.requests[1]?.body)).toMatch(
      /The total is 42\..*isn't JSON/u
    );
    const events = await auditedFor(trigger.userId, 2);
    expect(events.map(({ detail }) => detail)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ attempt: 1, outcome: "invalid_output" }),
        expect.objectContaining({ attempt: 2, outcome: "answered" }),
      ])
    );
  });

  it("fails when the answer doesn't match the schema the second time either", async () => {
    const trigger = newPerson();
    const { provider, providerEnv } = await withProvider([
      answer('{ "total": "forty-two" }'),
      answer('{ "total": "still forty-two" }'),
    ]);

    await expect(
      outcome(
        models(providerEnv).call({
          model: mistral,
          input: "What's the total?",
          schema: z.object({ total: z.number() }),
          purpose: "workflow.step",
          trigger,
          work: work(),
        })
      )
    ).resolves.toBe("model.invalid_output");
    expect(provider.requests).toHaveLength(2);
    // The feedback names what didn't fit.
    expect(JSON.stringify(provider.requests[1]?.body)).toContain("total");
    await expect(auditedFor(trigger.userId, 2)).resolves.toHaveLength(2);
  });

  it("refuses a model the organization didn't choose, before anything is sent", async () => {
    const { provider, providerEnv } = await withProvider([], {
      models: [mistral],
    });
    const call = async (model: string) =>
      await models(providerEnv).call({
        model,
        input: "Hello.",
        purpose: "chat.turn",
        trigger: newPerson(),
        work: work(),
      });

    // A model the gateway offers, but not one the organization chose.
    await expect(outcome(call(anthropic))).resolves.toBe("model.not_allowed");
    // A provider the gateway doesn't offer at all.
    await expect(outcome(call("google/gemini-3-pro"))).resolves.toBe(
      "model.not_allowed"
    );
    // A model with no provider named.
    await expect(outcome(call("mistral-large-latest"))).resolves.toBe(
      "model.not_allowed"
    );
    await expect(call(anthropic)).rejects.toMatchObject({
      message: "This deployment doesn't allow that model.",
      details: { model: anthropic },
    });
    expect(provider.requests).toStrictEqual([]);
  });

  it("answers the organization's chosen models with no rules while MODEL_GATEWAY isn't set", async () => {
    const { provider, providerEnv } = await withProvider([
      answer("Hello."),
      answer("Hello again."),
    ]);
    providerEnv.MODEL_GATEWAY = undefined;
    const call = async (to: string) =>
      await models(providerEnv).call({
        model: to,
        input: "Say hello.",
        purpose: "chat.turn",
        trigger: newPerson(),
        work: work(),
      });

    await expect(call(mistral)).resolves.toMatchObject({ text: "Hello." });
    await expect(call(openai)).resolves.toMatchObject({
      text: "Hello again.",
    });
    expect(provider.requests).toHaveLength(2);
  });

  it.each([
    ["rules that aren't JSON", "{"],
    ["a budget below nothing", { budgets: { user: { limit: -1 } } }],
  ])(
    "refuses every call with %s: the gateway fails closed",
    async (_, rules) => {
      const { provider, providerEnv } = await withProvider([answer("Hi.")], {
        rules,
      });

      await expect(
        outcome(
          models(providerEnv).call({
            model: mistral,
            input: "Hello.",
            purpose: "chat.turn",
            trigger: newPerson(),
            work: work(),
          })
        )
      ).resolves.toBe("model.unconfigured");
      expect(provider.requests).toStrictEqual([]);
    }
  );

  it("takes its rules as the JSON text a .dev.vars file sets", async () => {
    const call = async (rules: string) => {
      const { providerEnv } = await withProvider([answer("Hi.")], { rules });
      return await outcome(
        models(providerEnv).call({
          model: mistral,
          input: "Hello.",
          purpose: "chat.turn",
          trigger: newPerson(),
          work: work(),
        })
      );
    };

    expect({
      read: await call(JSON.stringify({ budgets: { user: { limit: 1 } } })),
      malformed: await call(
        JSON.stringify({ budgets: { user: { limit: -1 } } })
      ),
    }).toStrictEqual({ read: "ok", malformed: "model.unconfigured" });
  });

  it.each([
    [
      "both input and messages",
      { input: "Hi.", messages: [{ role: "user", content: "Hi." }] },
    ],
    ["neither input nor messages", {}],
    [
      "messages that end with the model's turn",
      { messages: [{ role: "assistant", content: "Hi." }] },
    ],
    [
      "a purpose that isn't a dotted name",
      { input: "Hi.", purpose: "Summarise this invoice" },
    ],
    [
      "a trigger the audit log doesn't know",
      { input: "Hi.", trigger: { type: "admin" } },
    ],
  ])("refuses a call with %s", async (_, fields) => {
    const { provider, providerEnv } = await withProvider([answer("Hi.")]);
    // SAFETY: invalid on purpose: what a caller that isn't type-checked (a
    // workflow isolate, say) could send, which the gateway must refuse.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const call = {
      model: mistral,
      purpose: "chat.turn",
      trigger: newPerson(),
      work: work(),
      ...fields,
    } as ModelCall<undefined>;
    await expect(outcome(models(providerEnv).call(call))).resolves.toBe(
      "model.invalid_call"
    );
    expect(provider.requests).toStrictEqual([]);
  });

  it.each([
    [
      "more IDs than an event names",
      [
        ...Array.from({ length: 150 }, (_, i) => `doc-${i}`),
        // Each ID once.
        "doc-0",
      ],
      { kept: 100, dropped: 50 },
    ],
    [
      // Within the count, but two bytes a character: an event with all of
      // them would be too large for the audit log.
      "IDs too large to record together",
      Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(256, "é")),
      { kept: 50, dropped: 50 },
    ],
  ])(
    "sends a call whose provenance has %s, and records as much of it as fits",
    async (_, provenance, { kept, dropped }) => {
      const trigger = newPerson();
      const { provider, providerEnv } = await withProvider([answer("Hi.")]);

      await expect(
        outcome(
          models(providerEnv).call({
            model: anthropic,
            input: "Hi.",
            purpose: "chat.turn",
            trigger,
            work: work(),
            provenance,
          })
        )
      ).resolves.toBe("ok");

      expect(provider.requests).toHaveLength(1);
      const [event] = await auditedFor(trigger.userId, 1);
      expect({
        provenance: event?.provenance,
        dropped: event?.detail.provenanceDropped,
      }).toStrictEqual({
        provenance: [...new Set(provenance)].slice(0, kept),
        dropped,
      });
    }
  );

  it("audits every call as metadata: who asked, why, model, tokens, cost, provenance", async () => {
    const trigger = newPerson();
    const { providerEnv } = await withProvider([
      {
        text: "It's due on 1 October.",
        inputTokens: 1_000_000,
        outputTokens: 100_000,
      },
    ]);

    await models(providerEnv).call({
      model: anthropic,
      input: "When is the Acme invoice due?",
      purpose: "chat.turn",
      trigger,
      work: work(),
      provenance: ["doc-invoice-1", "mail-2"],
      requestId: "request-1",
    });

    const [event] = await auditedFor(trigger.userId, 1);
    expect(event).toMatchObject({
      source: "core",
      actor: trigger,
      action: "model.call",
      requestId: "request-1",
      provenance: ["doc-invoice-1", "mail-2"],
      model: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputTokens: 1_000_000,
        outputTokens: 100_000,
      },
      cost: { currency: "USD" },
      detail: {
        purpose: "chat.turn",
        outcome: "answered",
        attempt: 1,
      },
    });
    // At Claude Sonnet 4.5's long-context prices, as its prompt is past
    // 200K tokens: $6 per million tokens in, $22.50 out.
    expect(event?.cost?.amount).toBeCloseTo(8.25);
    // Never the prompt or the answer.
    const stored = JSON.stringify(event);
    expect(stored).not.toContain("Acme");
    expect(stored).not.toContain("October");
  });

  it("says when an answer stopped at the model's output limit", async () => {
    const trigger = newPerson();
    const { providerEnv } = await withProvider([
      { ...answer("The first part of a long"), truncated: true },
    ]);

    const result = await models(providerEnv).call({
      model: mistral,
      input: "Write a long essay.",
      purpose: "chat.turn",
      trigger,
      work: work(),
    });

    expect(result).toMatchObject({
      text: "The first part of a long",
      truncated: true,
    });
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event?.detail).toMatchObject({ outcome: "truncated" });
  });

  it.each([
    // Worded by what was seen: the key refused, requests limited.
    [anthropic, 401, "authentication_error", 1, "model.provider_key_failed"],
    [openai, 402, "insufficient_quota", 1, "model.rate_limited"],
    // Refused for a moment: tried twice more, after the wait it asks for,
    // before it is told it is rate-limited, not that it failed.
    [mistral, 429, "rate_limit_error", 3, "model.rate_limited"],
    // Never asked again: the provider may have taken it on, and billed it.
    [anthropic, 503, "overloaded_error", 1, "model.provider_unavailable"],
  ])(
    "audits a call to %s the provider refuses with %i, with the status and error type only",
    async (model, status, errorType, requests, told) => {
      const trigger = newPerson();
      const { provider, providerEnv } = await withProvider(
        Array.from({ length: requests }, () => ({
          status,
          errorType,
          headers: { "retry-after": "1" },
        })),
        // No fallback to try instead.
        { models: [model] }
      );

      await expect(
        outcome(
          models(providerEnv).call({
            model,
            input: "Hello.",
            purpose: "chat.turn",
            trigger,
            work: work(),
          })
        )
      ).resolves.toBe(told);
      expect(provider.requests).toHaveLength(requests);
      const [event] = await auditedFor(trigger.userId, 1);
      expect(event).toMatchObject({
        action: "model.call",
        detail: { outcome: "failed", attempt: 1, status, errorType },
      });
      // Never the provider's message, which may quote the prompt.
      expect(JSON.stringify(event)).not.toContain("Refused");
    }
  );

  it("reads a rate limit's wait from retry-after when retry-after-ms is blank, held to core's most", async () => {
    const { providerEnv } = await withProvider(
      Array.from({ length: 3 }, () => ({
        status: 429,
        errorType: "rate_limit_error",
        headers: { "retry-after-ms": " ", "retry-after": "61" },
      })),
      { models: [mistral] }
    );

    const told = await models(providerEnv)
      .call({
        model: mistral,
        input: "Hello.",
        // Too soon for the wait, so it is told it.
        timeoutMs: 10_000,
        purpose: "chat.turn",
        trigger: newPerson(),
        work: work(),
      })
      .then(
        () => "admitted",
        (error: unknown) => error
      );
    expect(told).toMatchObject({
      code: "model.rate_limited",
      details: { retryAfterSeconds: 60 },
    });
  });

  it("tells a call whose last request was lost that its provider isn't answering, not that it was rate-limited before", async () => {
    const { providerEnv } = await withProvider(
      [
        {
          status: 429,
          errorType: "rate_limit_error",
          headers: { "retry-after": "1" },
        },
        { hang: true },
      ],
      { models: [mistral] }
    );

    await expect(
      outcome(
        models(providerEnv).call({
          model: mistral,
          input: "Hello.",
          timeoutMs: 5000,
          purpose: "chat.turn",
          trigger: newPerson(),
          work: work(),
        })
      )
    ).resolves.toBe("model.provider_unavailable");
  });

  it("fails a call that takes longer than its timeout, saying its provider isn't answering, and audits it", async () => {
    const trigger = newPerson();
    const { providerEnv } = await withProvider([{ hang: true }]);

    await expect(
      outcome(
        models(providerEnv).call({
          model: openai,
          input: "Hello.",
          timeoutMs: 100,
          purpose: "chat.turn",
          trigger,
          work: work(),
        })
      )
    ).resolves.toBe("model.provider_unavailable");
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event?.detail).toMatchObject({
      outcome: "failed",
      errorType: "timeout",
    });
  });

  it("leaves no timer behind once a call has answered", async () => {
    const { providerEnv } = await withProvider([answer("Hello.")]);
    // The call's own deadline, told apart from any other timer the isolate
    // sets meanwhile (an outbox drain, say) by a timeout nothing else uses.
    const timeoutMs = 47_123;
    const set = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    try {
      await models(providerEnv).call({
        model: anthropic,
        input: "Hello.",
        timeoutMs,
        purpose: "chat.turn",
        trigger: newPerson(),
        work: work(),
      });

      // A timer left would keep a Durable Object awake for the timeout.
      const ours = set.mock.calls.flatMap(([, delay], index): unknown[] =>
        delay === timeoutMs ? [set.mock.results[index]?.value] : []
      );
      expect(ours).toHaveLength(1);
      expect(cleared.mock.calls.map(([handle]) => handle)).toStrictEqual(
        expect.arrayContaining(ours)
      );
    } finally {
      set.mockRestore();
      cleared.mockRestore();
    }
  });

  it("caps the answer's length at the call's limit, or a default, never above what the model can answer", async () => {
    const { provider, providerEnv } = await withProvider([
      answer("One"),
      answer("Two"),
      answer("Three"),
    ]);
    for (const maxTokens of [500, undefined, 10_000_000]) {
      // One after another, as a person would.
      // oxlint-disable-next-line no-await-in-loop
      await models(providerEnv).call({
        model: openai,
        input: "Write something.",
        maxTokens,
        purpose: "chat.turn",
        trigger: newPerson(),
        work: work(),
      });
    }

    const sentLimits = provider.requests.map(
      ({ body }) =>
        z.object({ max_output_tokens: z.number() }).parse(body)
          .max_output_tokens
    );
    // GPT-5.4 may write 128,000 tokens, but an answer takes at most a
    // quarter of its 272,000-token window.
    expect(sentLimits).toStrictEqual([500, 16_384, 68_000]);
  });

  it("keeps a small window's default answer to a quarter of it, so the request has room", async () => {
    const { provider, providerEnv } = await withProvider([answer("Hi.")], {
      models: [smallWindow],
    });

    await models(providerEnv).call({
      model: smallWindow,
      input: "Write something.",
      purpose: "chat.turn",
      trigger: newPerson(),
      work: work(),
    });

    // GPT-4's window is 8,192 tokens, which OpenAI counts the answer's
    // cap against.
    expect(provider.requests.map(({ body }) => body)).toMatchObject([
      { max_output_tokens: 2048 },
    ]);
  });

  it("refuses a call through a binding that asks for more than the model can answer, never cutting it short", async () => {
    const { provider, providerEnv } = await withProvider([answer("Hi.")], {
      models: [smallWindow],
    });
    const working = work();
    const appId =
      "context" in working && working.context.type === "app"
        ? working.context.appId
        : undefined;
    const call = async (maxTokens: number) =>
      await models(providerEnv).call({
        model: smallWindow,
        input: "Write something.",
        maxTokens,
        purpose: "app.resource",
        trigger: newPerson(),
        work: work(),
        binding: {
          app: appIdSchema.parse(appId),
          alias: "writer",
          budget: null,
        },
      });

    // A quarter of GPT-4's 8,192-token window, and one token more.
    await expect(call(2049)).rejects.toMatchObject({
      code: "model.answer_too_long",
    });
    expect(provider.requests).toStrictEqual([]);
    await call(2048);
    expect(provider.requests.map(({ body }) => body)).toMatchObject([
      { max_output_tokens: 2048 },
    ]);
  });

  it("keeps a paid answer when the audit log is down, and appends its event later", async () => {
    const trigger = newPerson();
    const { providerEnv } = await withProvider([answer("Hello, Ada.")]);
    const logDown = new Proxy(env.AUDIT_LOG, {
      get: () => refuse,
    });

    const result = await models({ ...providerEnv, AUDIT_LOG: logDown }).call({
      model: anthropic,
      input: "Say hello.",
      purpose: "chat.turn",
      trigger,
      work: work(),
    });

    expect(result.text).toBe("Hello, Ada.");
    // The clock drains what the log couldn't take.
    await runMinuteTasks();
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event).toMatchObject({ action: "model.call", actor: trigger });
  });

  it("keeps a paid answer when the database refuses its audit event, and appends the event straight to the log", async () => {
    const trigger = newPerson();
    const { providerEnv } = await withProvider([answer("Hello, Ada.")]);
    // Reads still work, so the rules can check where the call works; every
    // write, the audit event's among them, is refused.
    const databaseDown = new Proxy(env.DB, {
      get: (target, key) => {
        if (key === "batch") {
          return refuse;
        }
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });

    const result = await models({ ...providerEnv, DB: databaseDown }).call({
      model: anthropic,
      input: "Say hello.",
      purpose: "chat.turn",
      trigger,
      work: work(),
    });

    expect(result.text).toBe("Hello, Ada.");
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event).toMatchObject({ action: "model.call", actor: trigger });
  });
});

/**
 * How long a streamed turn took to bring its first words to the caller,
 * in milliseconds; `release` lets the provider write the rest.
 */
const firstWordsMs = async (
  providerEnv: Env,
  question: string,
  release: () => void
): Promise<number | undefined> => {
  const agent = await models(providerEnv).agent({
    model: anthropic,
    purpose: "chat.turn",
    trigger: newPerson(),
    work: work(),
  });
  const started = performance.now();
  const stream = agent.stream(
    agent.model,
    normalizeContext({
      messages: [{ role: "user", content: question, timestamp: Date.now() }],
    })
  );
  let firstMs: number | undefined = undefined;
  for await (const event of stream) {
    if (firstMs === undefined && event.type === "text_delta") {
      firstMs = performance.now() - started;
      // Only now does the provider go on: an answer core held back until
      // its end would never get here.
      release();
    }
  }
  await stream.result();
  return firstMs;
};

describe("model gateway for agents", () => {
  beforeEach(makeWork);

  const codeTool = {
    name: "executeCode",
    description: "Runs code.",
    parameters: Type.Object({ code: Type.String() }),
  };

  /** A conversation that offers the model the code tool. */
  const withTool = (question: string) =>
    normalizeContext({
      systemPrompt: "Use the tools.",
      messages: [{ role: "user", content: question, timestamp: Date.now() }],
      tools: [codeTool],
    });

  it.each([mistral, anthropic, openai])(
    "streams a tool call from %s through the gateway, and audits the request",
    async (model) => {
      const trigger = newPerson();
      const { provider, providerEnv } = await withProvider([
        {
          text: "Let me check.",
          toolCalls: [
            { id: "call_1", name: "executeCode", arguments: { code: "1 + 1" } },
          ],
          inputTokens: 1000,
          outputTokens: 100,
        },
      ]);
      const agent = await models(providerEnv).agent({
        model,
        purpose: "chat.turn",
        trigger,
        work: work(),
      });

      const stream = agent.stream(agent.model, withTool("What is 1 + 1?"));
      const types = new Set<string>();
      for await (const event of stream) {
        types.add(event.type);
      }
      const final = await stream.result();

      const [request] = provider.requests;
      expect({
        streamed: types.has("toolcall_end"),
        stopReason: final.stopReason,
        toolCalls: final.content.flatMap((block) =>
          block.type === "toolCall" ? [[block.name, block.arguments]] : []
        ),
        // The tool went along.
        offered: JSON.stringify(request?.body).includes("Runs code."),
      }).toStrictEqual({
        streamed: true,
        stopReason: "toolUse",
        toolCalls: [["executeCode", { code: "1 + 1" }]],
        offered: true,
      });
      const [event] = await auditedFor(trigger.userId, 1);
      expect(event).toMatchObject({
        action: "model.call",
        actor: trigger,
        detail: { purpose: "chat.turn", outcome: "answered", attempt: 1 },
      });
    }
  );

  it.each([mistral, anthropic, openai])(
    "goes on after a tool call that came with no text, with its result, on %s",
    async (model) => {
      const { provider, providerEnv } = await withProvider([
        {
          text: "",
          toolCalls: [
            { id: "call_1", name: "executeCode", arguments: { code: "1 + 1" } },
          ],
          inputTokens: 1000,
          outputTokens: 100,
        },
        answer("It is 2."),
      ]);
      const agent = await models(providerEnv).agent({
        model,
        purpose: "chat.turn",
        trigger: newPerson(),
        work: work(),
      });
      const context = withTool("What is 1 + 1?");

      const called = await agent.stream(agent.model, context).result();
      const toolCall = called.content.find(
        (block) => block.type === "toolCall"
      );
      const followUp = normalizeContext({
        ...context,
        messages: [
          ...context.messages,
          called,
          {
            role: "toolResult",
            toolCallId: toolCall?.id ?? "",
            toolName: "executeCode",
            content: [{ type: "text", text: "2" }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
      });
      const answered = await agent.stream(agent.model, followUp).result();

      expect({
        called: called.stopReason,
        answered: answered.stopReason,
        text: answered.content.flatMap((block) =>
          block.type === "text" ? [block.text] : []
        ),
        requests: provider.requests.length,
      }).toStrictEqual({
        called: "toolUse",
        answered: "stop",
        text: ["It is 2."],
        requests: 2,
      });
    }
  );

  it("logs what a refusal says went wrong, and never its message, which may quote the prompt or a key", async () => {
    const prompt = "What is in the merger memo?";
    const key = "sk-live-4f9a8b7c6d5e4f3a";
    const problem = `Invalid 'messages[2].content': near '${prompt}' (key ${key})`;
    const { providerEnv } = await withProvider(
      [
        {
          status: 400,
          body: {
            error: {
              type: "invalid_request_error",
              code: "invalid_value",
              message: problem,
            },
          },
        },
      ],
      { models: [mistral] }
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      // Kept for the test to read.
    });
    try {
      const agent = await models(providerEnv).agent({
        model: mistral,
        purpose: "chat.turn",
        trigger: newPerson(),
        work: work(),
      });
      const failed = await agent.stream(agent.model, withTool(prompt)).result();

      const logged = warn.mock.calls
        .map(([fields]: unknown[]) => fields)
        .find(
          (fields) =>
            z.object({ event: z.literal("model.failed") }).safeParse(fields)
              .success
        );
      expect({ answer: failed.errorMessage, logged }).toMatchObject({
        answer: "The model call failed (400 invalid_request_error).",
        logged: {
          status: 400,
          providerErrorType: "invalid_request_error",
          providerErrorCode: "invalid_value",
        },
      });
      const text = JSON.stringify(logged);
      expect({
        prompt: text.includes(prompt),
        key: text.includes(key),
      }).toStrictEqual({ prompt: false, key: false });
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a model the organization didn't choose before the loop sends anything", async () => {
    const { provider, providerEnv } = await withProvider([], {
      models: [mistral],
    });

    await expect(
      outcome(
        models(providerEnv).agent({
          model: anthropic,
          purpose: "chat.turn",
          trigger: newPerson(),
          work: work(),
        })
      )
    ).resolves.toBe("model.not_allowed");
    expect(provider.requests).toStrictEqual([]);
  });

  it("admits each request by the organization's models as they stand then, and audits a refusal", async () => {
    const trigger = newPerson();
    const { provider, providerEnv } = await withProvider([answer("One.")]);
    const agent = await models(providerEnv).agent({
      model: anthropic,
      purpose: "chat.turn",
      trigger,
      work: work(),
    });

    await agent.stream(agent.model, withTool("First.")).result();
    // The organization stops choosing the model while the loop runs.
    await env.DB.prepare("UPDATE org_settings SET value = ? WHERE kind = ?")
      .bind(
        JSON.stringify({ defaultModel: mistral, fallbacks: [] }),
        aiModelsKind
      )
      .run();
    const second = await agent
      .stream(agent.model, withTool("Second."))
      .result();

    expect(second).toMatchObject({
      stopReason: "error",
      errorMessage: "The model call was refused (model.not_allowed).",
    });
    expect(provider.requests).toHaveLength(1);
    const events = await auditedFor(trigger.userId, 2);
    expect(events.map(({ action }) => action).toSorted()).toStrictEqual([
      "model.call",
      "model.refused",
    ]);
  });

  it("ends a refused request with a failure in its own words, and audits it", async () => {
    const trigger = newPerson();
    const { providerEnv } = await withProvider(
      [{ status: 401, errorType: "authentication_error" }],
      // No fallback to try instead.
      { models: [anthropic] }
    );
    const agent = await models(providerEnv).agent({
      model: anthropic,
      purpose: "chat.turn",
      trigger,
      work: work(),
    });

    const final = await agent.stream(agent.model, withTool("Hello.")).result();

    expect(final).toMatchObject({
      stopReason: "error",
      errorMessage:
        "Your AI provider is refusing your key (model.provider_key_failed).",
    });
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event?.detail).toMatchObject({
      outcome: "failed",
      status: 401,
      errorType: "authentication_error",
    });
  });

  it("records what fed each request, as the loop has read it by then", async () => {
    const trigger = newPerson();
    const { providerEnv } = await withProvider([
      answer("One."),
      answer("Two."),
    ]);
    const read: string[] = [];
    const agent = await models(providerEnv).agent(
      { model: anthropic, purpose: "chat.turn", trigger, work: work() },
      () => read
    );

    await agent.stream(agent.model, withTool("First.")).result();
    read.push("doc-policy");
    await agent.stream(agent.model, withTool("Second.")).result();

    const events = await auditedFor(trigger.userId, 2);
    expect(events.map(({ provenance }) => provenance)).toStrictEqual(
      expect.arrayContaining([[], ["doc-policy"]])
    );
  });

  it("sends nothing for a request cancelled before it starts", async () => {
    const { provider, providerEnv } = await withProvider([answer("Hi.")]);
    const agent = await models(providerEnv).agent({
      model: anthropic,
      purpose: "chat.turn",
      trigger: newPerson(),
      work: work(),
    });

    const final = await agent
      .stream(agent.model, withTool("Hello."), {
        signal: AbortSignal.abort(),
      })
      .result();

    expect(final.stopReason).toBe("aborted");
    expect(provider.requests).toStrictEqual([]);
  });

  it("stops a request its caller cancels, and audits it as cancelled", async () => {
    const trigger = newPerson();
    const { provider, providerEnv } = await withProvider([{ hang: true }]);
    const agent = await models(providerEnv).agent({
      model: openai,
      purpose: "chat.turn",
      trigger,
      work: work(),
    });
    const cancel = new AbortController();

    const stream = agent.stream(agent.model, withTool("Hello."), {
      signal: cancel.signal,
    });
    await vi.waitFor(
      () => {
        expect(provider.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    cancel.abort();

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "aborted",
      errorMessage: "The model call was cancelled.",
    });
    const [event] = await auditedFor(trigger.userId, 1);
    // The gateway never answered, so nothing was used that can be told:
    // no estimate, and no cost.
    expect(event).toMatchObject({
      detail: {
        outcome: "cancelled",
        errorType: "cancelled",
        estimated: false,
      },
      cost: { amount: 0 },
    });
  });

  it("relays an answer's first words while the provider is still writing, with little of core's own work before them", async () => {
    const warm = Promise.withResolvers<boolean>();
    const measured = Promise.withResolvers<boolean>();
    const { providerEnv } = await withProvider([
      {
        ...answer("Warming up the ledger."),
        pause: { at: 7, until: warm.promise },
      },
      {
        ...answer("Good morning. What does your team do first?"),
        pause: { at: 13, until: measured.promise },
      },
    ]);

    // The first turn starts the ledger and the rest; the second is a turn
    // as a conversation has them.
    await firstWordsMs(providerEnv, "Hello.", () => {
      warm.resolve(true);
    });
    const firstMs = await firstWordsMs(providerEnv, "Good morning.", () => {
      measured.resolve(true);
    });

    expect(firstMs).toBeLessThan(firstTokenBudgetMs);
  });
});

import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { runActorOf } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema, runIdSchema } from "@grasp-os/shared/ids";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import type { ModelLedger } from "../src/model-ledger.ts";
import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import type { ModelCall } from "../src/models.ts";
import { allEvents } from "./audit-events.ts";
import { platformOpenAiKey } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider, streamText } from "./model-provider.ts";
import type { FakeProvider, ProviderReply } from "./model-provider.ts";
import { plan } from "./platform-providers.ts";
import { finished } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// Model spend, counted by the model ledger: every provider request is
// admitted before it is sent, counted against all of its scopes at once,
// and charged what it used once it ends, or the most it can cost when
// what it used can't be known. Nothing limits it. The model provider
// behind connect is the outside system (test/model-provider.ts). The
// ledger, the audit log and the runs are real; where a test needs the
// ledger to fail, its binding fails, as an unreachable Durable Object
// would.

const idp = mockIdp();

const mistral = "mistral/mistral-large-latest";
const anthropic = "anthropic/claude-sonnet-4-5";

/** Priced in tiers: twice the input and half again the output past 272K. */
const tiered = "openai/gpt-5.4";
/** The models the organization chose: Mistral Large its default. */
const chosen = [mistral, anthropic, tiered];

/**
 * Costs 650 micros from Mistral Large, at its list prices of $0.50 per
 * million tokens in and $1.50 out, each rounded up to whole micros.
 */
const pricedAnswer = { text: "Hi.", inputTokens: 1000, outputTokens: 100 };
const pricedMicros = 500 + 150;

/** Costs 29,650 micros from Mistral Large. */
const dearAnswer = { text: "Hi.", inputTokens: 59_000, outputTokens: 100 };
const dearMicros = 29_500 + 150;

/** The answer's cap the tests ask for: a request then can cost well under a cent. */
const smallCap = 100;

let monthsUsed = 0;

/** A month no other test counts spend in: from 2300, clear of other files. */
const newMonth = (): string => {
  monthsUsed += 1;
  return `${2300 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/**
 * The test's provider, for the `chosen` models, and the replies it has
 * left, in order: each test connects its own (`beforeEach`).
 */
let provider: FakeProvider | undefined;
let replies: ProviderReply[] = [];

const requireProvider = (): FakeProvider => {
  if (provider === undefined) {
    throw new Error("The test's provider isn't connected yet");
  }
  return provider;
};

/**
 * Core's env with the test's provider answering with `replies` after what
 * it was given to answer before; spend counts in `month`.
 */
const withProvider = (more: ProviderReply[], overrides: Partial<Env> = {}) => {
  replies.push(...more);
  const month = newMonth();
  const rulesEnv: Env = {
    ...env,
    MODEL_BUDGET_MONTH: month,
    ...overrides,
  };
  const { call, agent } = models(rulesEnv);
  return { fake: requireProvider(), call, agent, month };
};

/** `count` of `reply`. */
const times = (count: number, reply: ProviderReply): ProviderReply[] =>
  Array.from({ length: count }, () => reply);

/** A person no other test uses, so their audit events are this test's. */
const newPerson = () =>
  ({ type: "person", userId: `person-${crypto.randomUUID()}` }) as const;

let appWork: ModelCall<undefined>["work"] | undefined;

const requireWork = (): ModelCall<undefined>["work"] => {
  if (appWork === undefined) {
    throw new Error("The tests' App isn't made yet");
  }
  return appWork;
};

/** A capped call to Mistral Large, unless `more` says otherwise. */
const hello = (
  more: Partial<ModelCall<undefined>> = {}
): ModelCall<undefined> => ({
  model: mistral,
  maxTokens: smallCap,
  input: "Hello.",
  purpose: "chat.turn",
  trigger: newPerson(),
  work: requireWork(),
  ...more,
});

/** The person `made` is made by. */
const userOf = (made: ModelCall<undefined>): string => {
  if (made.trigger.type !== "person") {
    throw new Error("A call made by a person");
  }
  return made.trigger.userId;
};

/** Values in order, as their JSON sorts. */
const byJson = (one: unknown, other: unknown): number =>
  JSON.stringify(one).localeCompare(JSON.stringify(other));

/** The outcomes of `calls`, one after another. */
const inTurn = async (
  calls: readonly (() => Promise<unknown>)[]
): Promise<string[]> => {
  const outcomes: string[] = [];
  for (const made of calls) {
    // oxlint-disable-next-line no-await-in-loop -- one after another, as a person would
    outcomes.push(await outcome(made()));
  }
  return outcomes;
};

/**
 * The audit events `actor` triggered, the ledger's alerts included: its
 * alarm delivers what its outbox holds.
 */
const eventsOf = async (actor: unknown): Promise<AuditEvent[]> => {
  await runDurableObjectAlarm(modelLedger(env));
  const events = await allEvents();
  return events.filter(
    (event) => JSON.stringify(event.actor) === JSON.stringify(actor)
  );
};

/** What `userId` spent in `month`, in micros, as the ledger counts it. */
const ledgerOf = async (month: string, userId: string): Promise<number> => {
  const spent = await modelLedger(env).spendOf(month, ["user"], 1000);
  return spent.user?.find(({ key }) => key === userId)?.spentMicros ?? 0;
};

/**
 * The ledger's binding with `method` failing on every object, as an
 * unreachable Durable Object's would; everything else as it is.
 */
const failingLedger = (
  method: "admit" | "settle"
): DurableObjectNamespace<ModelLedger> =>
  new Proxy(env.MODEL_LEDGER, {
    get: (namespace, name): unknown => {
      if (name !== "getByName") {
        return Reflect.get(namespace, name, namespace);
      }
      return (id: string) =>
        new Proxy(namespace.getByName(id), {
          get: (stub, member): unknown =>
            member === method
              ? async () => await Promise.reject(new Error("Unavailable"))
              : Reflect.get(stub, member, stub),
        });
    },
  });

/** Whether `sql` writes to or reads an audit outbox. */
const auditing = (sql: string): boolean => sql.includes("audit_outbox");

/** The audit log's binding, refusing every append, as an unreachable one would. */
const failingAuditLog = (): Env["AUDIT_LOG"] =>
  new Proxy(env.AUDIT_LOG, {
    get: (namespace, name): unknown => {
      if (name !== "getByName" && name !== "get") {
        return Reflect.get(namespace, name, namespace);
      }
      return () =>
        new Proxy(
          {},
          {
            get: () => async () =>
              await Promise.reject(new Error("Unavailable")),
          }
        );
    },
  });

/** What a call's audit event says the ledger did, its amounts in micros. */
const said = (event: AuditEvent | undefined) => [
  event?.detail.ledger,
  event?.detail.ledgerRequests,
  Math.round(Number(event?.detail.ledgerCharged) * 1_000_000),
  Math.round(Number(event?.detail.ledgerHeld) * 1_000_000),
];

/**
 * Brings `userId`'s open requests due now, and runs the ledger's alarm:
 * each is charged the most it can cost, as when it comes due.
 */
const reconcileNow = async (userId: string): Promise<void> => {
  const ledger = modelLedger(env);
  await runInDurableObject(ledger, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE requests SET reconcile_at = ? WHERE subject = ? AND state IN ('dispatched', 'unknown')",
      Date.now() - 1,
      userId
    );
  });
  await runDurableObjectAlarm(ledger);
};

/** The provider requests the ledger admitted for `userId`. */
const requestsOf = async (userId: string): Promise<number> =>
  await runInDurableObject(modelLedger(env), (_instance, state) =>
    Number(
      state.storage.sql
        .exec("SELECT count(*) AS n FROM requests WHERE subject = ?", userId)
        .one().n
    )
  );

describe("model spend", { timeout: 60_000 }, () => {
  beforeEach(async () => {
    const left: ProviderReply[] = [];
    replies = left;
    provider = await answeringProvider(() => left.shift(), { models: chosen });
    if (appWork !== undefined) {
      return;
    }
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Model spend" });
    const appId = appIdSchema.parse(id);
    appWork = {
      authority: {
        subject: { type: "app", appId },
        onBehalfOf: builder.userId,
        mode: "interactive",
        appVersion: 1,
      },
      context: { type: "app", appId },
    };
  });

  it("count a call on Grasp's own key as Grasp's, apart from the organization's spend and the person's", async () => {
    const { call, month } = withProvider([pricedAnswer]);
    const trigger = newPerson();
    const rulesEnv: Env = { ...env, MODEL_BUDGET_MONTH: month };

    await expect(outcome(call(hello({ trigger })))).resolves.toBe("ok");
    await plan(platformOpenAiKey, [
      {
        sse: streamText("openai-responses", {
          text: "# Expense policy",
          inputTokens: 2000,
          outputTokens: 100,
        }),
      },
    ]);
    const converted = await outcome(
      models(rulesEnv).platformCall({
        model: "openai/gpt-5.4-mini",
        purpose: "knowledge.conversion",
        trigger,
        work: { platform: "document_conversion" },
        input: "Write out this document as Markdown.",
        document: {
          name: "policy.pdf",
          mediaType: "application/pdf",
          bytes: new TextEncoder().encode("%PDF-1.4\n%%EOF\n"),
        },
      })
    );
    const deployment = await modelLedger(env).spendOf(
      month,
      ["deployment"],
      10
    );
    const grasp = await modelLedger(env).platformSpend([month]);

    expect({
      converted,
      user: await ledgerOf(month, trigger.userId),
      deployment: deployment.deployment?.[0]?.spentMicros,
      grasp: grasp.map(({ feature, model, micros }) => ({
        feature,
        model,
        charged: micros > 0,
      })),
    }).toStrictEqual({
      converted: "ok",
      // The organization's spend is what its own key cost: the call.
      user: pricedMicros,
      deployment: pricedMicros,
      grasp: [
        { feature: "conversion", model: "openai/gpt-5.4-mini", charged: true },
      ],
    });
  });

  it("count a run's call on Grasp's own key as a request of its lineage, never as money of the run's", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, workflowFiles("idle", "  return null;"));
    const run = await builder.api.workflows.start(app, "idle");
    await finished(run.id);
    const month = newMonth();
    const rulesEnv: Env = { ...env, MODEL_BUDGET_MONTH: month };
    await plan(platformOpenAiKey, [
      {
        sse: streamText("openai-responses", {
          text: "# Expense policy",
          inputTokens: 2000,
          outputTokens: 100,
        }),
      },
    ]);

    // A document the run's step converts, on Grasp's key.
    const converted = await outcome(
      models(rulesEnv).platformCall({
        model: "openai/gpt-5.4-mini",
        purpose: "knowledge.conversion",
        trigger: runActorOf({ runId: run.id, app, workflow: "idle" }),
        work: { platform: "document_conversion" },
        input: "Write out this document as Markdown.",
        document: {
          name: "policy.pdf",
          mediaType: "application/pdf",
          bytes: new TextEncoder().encode("%PDF-1.4\n%%EOF\n"),
        },
      })
    );
    const { run: lineage = [] } = await modelLedger(env).spendOf(
      month,
      ["run"],
      10
    );
    const grasp = await modelLedger(env).platformSpend([month]);

    expect({
      converted,
      // Counted in the lineage, as a request: no money spent there.
      run: lineage
        .filter(({ key }) => key === run.id)
        .map(({ spentMicros }) => spentMicros),
      grasp: grasp.some(({ micros }) => micros > 0),
    }).toStrictEqual({ converted: "ok", run: [0], grasp: true });
  });

  it("count the calls an agent or a run makes for a person as that person's spend", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, workflowFiles("idle", "  return null;"));
    const run = await builder.api.workflows.start(app, "idle");
    await finished(run.id);
    const appId = appIdSchema.parse(app);
    const { call, month } = withProvider(times(3, pricedAnswer));
    const ada = { type: "person", userId: builder.userId } as const;
    const forAda = [
      hello({
        trigger: { type: "agent", agentId: "chat", onBehalfOf: ada.userId },
      }),
      hello({
        purpose: "workflow.step",
        trigger: runActorOf({ runId: run.id, app, workflow: "idle" }),
        work: {
          authority: {
            subject: { type: "app", appId },
            onBehalfOf: ada.userId,
            mode: "workflow",
            appVersion: 1,
          },
          context: { type: "run", appId, runId: runIdSchema.parse(run.id) },
        },
      }),
      hello({ trigger: ada }),
    ];

    await expect(
      inTurn(forAda.map((made) => async () => await call(made)))
    ).resolves.toStrictEqual(["ok", "ok", "ok"]);
    await expect(ledgerOf(month, ada.userId)).resolves.toBe(3 * pricedMicros);
  });

  it("charge what a model thought, as the provider counts it in the answer's output", async () => {
    // 900 tokens of thinking on top of the answer's 100: 1,000 out at
    // Mistral Large's $1.50 a million, beside the 1,000 in.
    const thought = {
      ...pricedAnswer,
      outputTokens: pricedAnswer.outputTokens + 900,
      thinking: { text: "Ada said hello; greet her back.", tokens: 900 },
    };
    const { call, month } = withProvider([thought]);
    const ada = newPerson();

    await expect(outcome(call(hello({ trigger: ada })))).resolves.toBe("ok");
    await expect(ledgerOf(month, ada.userId)).resolves.toBe(500 + 1500);
  });

  it("charge an answer cancelled midway what it used, never nothing, and say on its audit event that it was estimated", async () => {
    // The answer stops after its first 12 characters, until released: the
    // provider's count, which comes with the answer's end, never arrives.
    const rest = Promise.withResolvers<boolean>();
    const cut = {
      text: "Hello there, how are you today?",
      inputTokens: 1000,
      outputTokens: 100,
      pause: { at: 12, until: rest.promise },
    };
    // Some 50,000 tokens at four characters each, and four times as many
    // bytes: its bound, for Mistral Large, is some $0.10, its answer
    // capped at 100 tokens.
    const limited = withProvider([cut]);
    const open = withProvider([cut]);
    const prompt = "word ".repeat(40_000);
    /** A request of `trigger`'s to `model`, cancelled once text came. */
    const cancelled = async (
      agent: typeof limited.agent,
      model: string,
      trigger: ReturnType<typeof newPerson>
    ) => {
      const session = await agent({
        model,
        maxTokens: smallCap,
        purpose: "chat.turn",
        trigger,
        work: requireWork(),
      });
      const cancel = new AbortController();
      const stream = session.stream(
        session.model,
        normalizeContext({
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        }),
        { signal: cancel.signal }
      );
      for await (const event of stream) {
        if (event.type === "text_delta") {
          cancel.abort();
        }
      }
      const { stopReason } = await stream.result();
      return stopReason;
    };
    const ada = newPerson();
    const ben = newPerson();
    try {
      // Chat completions count nothing until their last chunk; Anthropic
      // counts the prompt at the start, and the answer at its end.
      const stopped = [
        await cancelled(limited.agent, mistral, ada),
        await cancelled(open.agent, anthropic, ben),
      ];
      const spent = await ledgerOf(limited.month, ada.userId);
      const adaEvents = await eventsOf(ada);
      const adas = adaEvents.find(({ action }) => action === "model.call");
      const [bens] = await eventsOf(ben);
      const tokens = adas?.model?.inputTokens ?? 0;
      expect({
        stopped,
        charged: spent > 100_000,
        ada: [adas?.action, adas?.detail, adas?.model?.outputTokens],
        prompt: tokens >= prompt.length / 4 && tokens < prompt.length / 4 + 200,
        ben: [bens?.action, bens?.detail, bens?.model],
      }).toMatchObject({
        stopped: ["aborted", "aborted"],
        // Chat completions count nothing before their end: the prompt is
        // charged at its bound, so cancelling is never free.
        charged: true,
        ada: [
          "model.call",
          {
            outcome: "cancelled",
            errorType: "cancelled",
            estimated: true,
            ledger: "settled",
            ledgerHeld: 0,
          },
          // "Hello there," at four characters a token.
          3,
        ],
        prompt: true,
        ben: [
          "model.call",
          { outcome: "cancelled", errorType: "cancelled", estimated: true },
          // The prompt as Anthropic counted it, the answer estimated.
          { inputTokens: 1000, outputTokens: 3 },
        ],
      });
      // At the models' list prices, per million tokens in and out.
      expect(adas?.cost?.amount).toBeCloseTo(
        (tokens * 0.5 + 3 * 1.5) / 1_000_000,
        6
      );
      expect(bens?.cost?.amount).toBeCloseTo(
        (1000 * 3 + 3 * 15) / 1_000_000,
        6
      );
    } finally {
      rest.resolve(true);
    }
  });

  it("charge an answer that breaks off midway, with no end and no count, the most it can cost once it comes due", async () => {
    // The stream closes after the answer's first 12 characters.
    const brokenOff = {
      text: "Hello there, how are you today?",
      inputTokens: 1000,
      outputTokens: 100,
      cut: 12,
    };
    // Its bound, for Mistral Large, is some $0.10, its answer capped at
    // 100 tokens.
    const { agent, month } = withProvider([brokenOff]);
    const prompt = "word ".repeat(40_000);
    const ada = newPerson();
    const session = await agent({
      model: mistral,
      maxTokens: smallCap,
      purpose: "chat.turn",
      trigger: ada,
      work: requireWork(),
    });
    const stream = session.stream(
      session.model,
      normalizeContext({
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      })
    );
    let streamed = "";
    for await (const event of stream) {
      if (event.type === "text_delta") {
        streamed += event.delta;
      }
    }
    const { stopReason } = await stream.result();
    const before = await ledgerOf(month, ada.userId);
    const [event] = await eventsOf(ada);
    await reconcileNow(ada.userId);
    const after = await ledgerOf(month, ada.userId);

    expect({
      ended: [stopReason, streamed],
      event: [event?.action, event?.detail.outcome, event?.detail.ledger],
      before,
      charged: after > 100_000,
    }).toStrictEqual({
      // What came reached the caller, before the failure.
      ended: ["error", "Hello there,"],
      event: ["model.call", "failed", "unknown"],
      // Nothing yet: what it used can't be known until it comes due.
      before: 0,
      charged: true,
    });
  });

  it("count a rate-limited request's retry on its own, and charge a request that failed after it may have been taken on its bound", async () => {
    // A server error may have come after the provider took the request on:
    // it is charged its bound once it comes due, and the call fails, not
    // retried.
    const failedLate = withProvider([{ status: 500 }]);
    // A refusal for the provider's rate before it took the request on
    // costs nothing: the gateway asks again once the wait is over, the
    // retry admitted on its own.
    const refused = withProvider([
      {
        status: 429,
        errorType: "rate_limit_error",
        headers: { "retry-after": "1" },
      },
      pricedAnswer,
    ]);
    const ada = hello();
    const ben = hello();

    await expect(
      inTurn([
        async () => await failedLate.call(ada),
        async () => await refused.call(ben),
      ])
    ).resolves.toStrictEqual(["model.provider_unavailable", "ok"]);
    await reconcileNow(userOf(ada));
    const [adas, bens] = await Promise.all([
      ledgerOf(failedLate.month, userOf(ada)),
      ledgerOf(refused.month, userOf(ben)),
    ]);
    expect({
      ada: adas > 0,
      ben: bens,
      admitted: await Promise.all([
        requestsOf(userOf(ada)),
        requestsOf(userOf(ben)),
      ]),
    }).toStrictEqual({ ada: true, ben: pricedMicros, admitted: [1, 2] });
  });

  it("say on a call's audit event what every one of its provider requests charged or has still to be charged, a refused one's and a failed one's too", async () => {
    const retried = withProvider([
      {
        status: 429,
        errorType: "rate_limit_error",
        headers: { "retry-after": "1" },
      },
      pricedAnswer,
    ]);
    // A server error: neither retried nor fallen back from.
    const failed = withProvider([{ status: 500 }]);
    const ada = hello();
    const ben = hello();

    await expect(
      inTurn([
        async () => await retried.call(ada),
        async () => await failed.call(ben),
      ])
    ).resolves.toStrictEqual(["ok", "model.provider_unavailable"]);
    const [adaEvent] = await eventsOf(ada.trigger);
    const [benEvent] = await eventsOf(ben.trigger);
    const benHeld = said(benEvent).at(-1);
    await reconcileNow(userOf(ben));
    const charged = await ledgerOf(failed.month, userOf(ben));
    expect({ ada: said(adaEvent), ben: said(benEvent) }).toStrictEqual({
      // The answer charged; the refused first try charged nothing.
      ada: ["settled", 2, pricedMicros, 0],
      // The failed try still to be charged its bound.
      ben: ["unknown", 1, 0, benHeld],
    });
    // What the event said is still to be charged is what it is charged.
    expect([Number(benHeld) > 0, charged]).toStrictEqual([true, benHeld]);
  });

  it("charge a prompt past a tier's threshold at that tier's prices, as its audit event counts it", async () => {
    const { call, month } = withProvider([
      { text: "Hi.", inputTokens: 300_000, outputTokens: 100 },
    ]);
    const ada = hello({ model: tiered, maxTokens: undefined });

    await expect(outcome(call(ada))).resolves.toBe("ok");
    const [event] = await eventsOf(ada.trigger);
    // $5 a million in and $22.50 out past 272K, not $2.50 and $15.
    expect({
      ledger: await ledgerOf(month, userOf(ada)),
      // In micros, as the audit event's dollars come out of floats.
      audited: Math.round((event?.cost?.amount ?? 0) * 1_000_000),
      // How the ledger settled it, on the event too.
      settled: [event?.detail.ledger, event?.detail.ledgerCharged],
    }).toStrictEqual({
      ledger: 300_000 * 5 + 2250,
      audited: 300_000 * 5 + 2250,
      settled: ["settled", 1.50225],
    });
  });

  it("charge a cancelled answer at its tier's prices, as its audit event estimates it", async () => {
    const rest = Promise.withResolvers<boolean>();
    const { agent, month } = withProvider([
      {
        text: "Hello there, how are you today?",
        inputTokens: 250_000,
        outputTokens: 100,
        pause: { at: 12, until: rest.promise },
      },
    ]);
    const ada = newPerson();
    try {
      const session = await agent({
        model: anthropic,
        purpose: "chat.turn",
        trigger: ada,
        work: requireWork(),
      });
      const cancel = new AbortController();
      const stream = session.stream(
        session.model,
        normalizeContext({
          messages: [{ role: "user", content: "Hi.", timestamp: Date.now() }],
        }),
        { signal: cancel.signal }
      );
      for await (const event of stream) {
        if (event.type === "text_delta") {
          cancel.abort();
        }
      }
      const held = await ledgerOf(month, ada.userId);
      const [event] = await eventsOf(ada);
      expect({
        // The prompt as Anthropic counted it, past 200K, and "Hello there,"
        // estimated, both at the long-context prices.
        audited:
          Math.abs(
            (event?.cost?.amount ?? 0) - (250_000 * 6 + 3 * 22.5) / 1e6
          ) < 1e-9,
        settled: said(event),
        held,
      }).toStrictEqual({
        audited: true,
        // The ledger rounds each kind up to a micro.
        settled: ["settled", 1, 250_000 * 6 + 68, 0],
        held: 250_000 * 6 + 68,
      });
    } finally {
      rest.resolve(true);
    }
  });

  it("charge an answer whose provider never sent its count the most it can cost once it comes due, never nothing", async () => {
    const { call, month } = withProvider([{ ...pricedAnswer, noUsage: true }]);
    const ada = hello();

    await expect(call(ada)).resolves.toMatchObject({ text: "Hi." });
    const before = await ledgerOf(month, userOf(ada));
    await reconcileNow(userOf(ada));
    const after = await ledgerOf(month, userOf(ada));
    expect([before, after > 0]).toStrictEqual([0, true]);
  });

  it("charge an answer that wrote to a one-hour cache, which the catalog doesn't price, the most it can cost once it comes due", async () => {
    const { call, month } = withProvider([
      { ...pricedAnswer, cacheWrite1h: 2000 },
    ]);
    const ada = hello({ model: anthropic, maxTokens: 1 });

    await expect(call(ada)).resolves.toMatchObject({ text: "Hi." });
    const before = await ledgerOf(month, userOf(ada));
    await reconcileNow(userOf(ada));
    const after = await ledgerOf(month, userOf(ada));
    expect([before, after > 0]).toStrictEqual([0, true]);
  });

  it("settle an answered request at what it used even when its audit event can't be stored", async () => {
    const database: D1Database = env.DB;
    const { call, month } = withProvider([pricedAnswer], {
      // The audit outbox refuses every write; everything else works.
      DB: new Proxy(database, {
        get: (target, name): unknown => {
          if (name === "prepare") {
            return (sql: string) => {
              if (auditing(sql)) {
                throw new Error("Unavailable");
              }
              return target.prepare(sql);
            };
          }
          return Reflect.get(target, name, target);
        },
      }),
      AUDIT_LOG: failingAuditLog(),
    });
    const ada = hello();

    await expect(call(ada)).resolves.toMatchObject({ text: "Hi." });
    await expect(ledgerOf(month, userOf(ada))).resolves.toBe(pricedMicros);
  });

  it("charge a Claude Sonnet 4.5 prompt past 200K tokens at Anthropic's long-context prices, as its audit event counts it", async () => {
    const { call, month } = withProvider([
      { text: "Hi.", inputTokens: 250_000, outputTokens: 100 },
    ]);
    const ada = hello({ model: anthropic, maxTokens: 1 });

    await expect(outcome(call(ada))).resolves.toBe("ok");
    const [event] = await eventsOf(ada.trigger);
    // $6 a million in and $22.50 out past 200K, not $3 and $15.
    expect({
      ledger: await ledgerOf(month, userOf(ada)),
      audited: Math.round((event?.cost?.amount ?? 0) * 1_000_000),
    }).toStrictEqual({
      ledger: 250_000 * 6 + 2250,
      audited: 250_000 * 6 + 2250,
    });
  });

  it("send no request whose content its bytes can't bound, such as an image", async () => {
    const { fake, agent } = withProvider([pricedAnswer]);
    const ada = newPerson();
    const session = await agent({
      model: anthropic,
      purpose: "chat.turn",
      trigger: ada,
      work: requireWork(),
    });
    const stream = session.stream(
      session.model,
      normalizeContext({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What's this?" },
              { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
            ],
            timestamp: Date.now(),
          },
        ],
      })
    );
    const { stopReason, errorMessage } = await stream.result();

    expect({ stopReason, errorMessage, sent: fake.requests }).toStrictEqual({
      stopReason: "error",
      errorMessage: "The model call was refused (model.unpriced).",
      sent: [],
    });
  });

  it("send nothing when the ledger can't admit a request, and say so", async () => {
    const { fake, call } = withProvider([pricedAnswer], {
      MODEL_LEDGER: failingLedger("admit"),
    });
    const ada = hello();

    await expect(call(ada)).rejects.toMatchObject({
      code: "model.ledger_unavailable",
      message:
        "Model spend can't be accounted for right now, so no model call was made. Try again later.",
    });
    expect(fake.requests).toStrictEqual([]);
    await expect(eventsOf(ada.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        detail: { reason: "model.ledger_unavailable" },
      },
    ]);
  });

  it("keep a paid answer when its settlement can't be stored, and charge it the most it can cost once it comes due", async () => {
    const { call, month } = withProvider([pricedAnswer], {
      MODEL_LEDGER: failingLedger("settle"),
    });
    const ada = hello();

    await expect(call(ada)).resolves.toMatchObject({ text: "Hi." });
    const before = await ledgerOf(month, userOf(ada));
    await reconcileNow(userOf(ada));
    const after = await ledgerOf(month, userOf(ada));
    expect([before, after > pricedMicros]).toStrictEqual([0, true]);
  });

  it("admit and count a retry in the month it is sent in, when the month turns between attempts", async () => {
    const [before, after] = [newMonth(), newMonth()];
    const dearer = { ...dearAnswer, inputTokens: 150_000 };
    replies.push(
      dearAnswer,
      dearAnswer,
      { ...dearer, text: "No JSON here." },
      { ...dearer, text: '{ "total": 1 }' }
    );
    const fake = requireProvider();
    const turningEnv: Env = {
      ...env,
      // The month turns once the call's first attempt was sent.
      get MODEL_BUDGET_MONTH() {
        return fake.requests.length < 3 ? before : after;
      },
    };
    const ada = hello();
    const call = async (more: Partial<ModelCall<undefined>> = {}) =>
      await outcome(models(turningEnv).call({ ...ada, ...more }));

    await expect(Promise.all([call(), call()])).resolves.toStrictEqual([
      "ok",
      "ok",
    ]);
    // Its first attempt counts in the old month; its retry in the new one.
    await expect(
      outcome(
        models(turningEnv).call({
          ...ada,
          schema: z.object({ total: z.number() }),
        })
      )
    ).resolves.toBe("ok");
    const dearerMicros = 75_000 + 150;
    await expect(
      Promise.all([ledgerOf(before, userOf(ada)), ledgerOf(after, userOf(ada))])
    ).resolves.toStrictEqual([2 * dearMicros + dearerMicros, dearerMicros]);
  });

  it("give every provider request of a call the call's own cut-off as its deadline, a second ask's too, never a whole timeout from when it is sent", async () => {
    const timeoutMs = 60_000;
    const release = Promise.withResolvers<boolean>();
    const { call } = withProvider([
      // The first answer takes its time, and doesn't fit: asked again.
      {
        ...pricedAnswer,
        text: "No JSON here.",
        pause: { at: 2, until: release.promise },
      },
      { ...pricedAnswer, text: '{ "total": 1 }' },
    ]);
    const ada = hello();
    const started = Date.now();
    const asking = outcome(
      call({ ...ada, schema: z.object({ total: z.number() }), timeoutMs })
    );
    await scheduler.wait(1500);
    release.resolve(true);
    const answered = await asking;
    const deadlines = await runInDurableObject(
      modelLedger(env),
      (_instance, state) =>
        state.storage.sql
          .exec<{ deadline: number }>(
            "SELECT deadline FROM requests WHERE subject = ?",
            userOf(ada)
          )
          .toArray()
          .map(({ deadline }) => deadline)
    );

    expect({
      answered,
      asked: deadlines.length,
      // Both the call's cut-off: the second, sent 1.5 seconds on, too.
      same: new Set(deadlines).size,
      withinTimeout: deadlines.every(
        (at) => at >= started + timeoutMs && at <= started + timeoutMs + 1000
      ),
    }).toStrictEqual({
      answered: "ok",
      asked: 2,
      same: 1,
      withinTimeout: true,
    });
  });

  it("count a workflow's calls apart from other workflows', and the deployment's across every caller", async () => {
    const app = `app-${crypto.randomUUID()}`;
    const { call, month } = withProvider(times(5, pricedAnswer));
    const step = async (workflow: string) =>
      await call(
        hello({
          purpose: "workflow.step",
          trigger: runActorOf({
            runId: `run-${crypto.randomUUID()}`,
            app,
            workflow,
          }),
        })
      );

    // A new run each time: the workflow counts all of its runs.
    await inTurn(
      Array.from({ length: 3 }, () => async () => await step("invoices"))
    );
    await step("orders");
    // A new person: the deployment counts every caller, in this month.
    await call(hello());
    const spent = await modelLedger(env).spendOf(
      month,
      ["workflow", "deployment"],
      10
    );

    expect({
      workflows: (spent.workflow ?? [])
        .map(({ key, spentMicros }) => [key, spentMicros])
        .toSorted(byJson),
      deployment: spent.deployment,
    }).toStrictEqual({
      workflows: [
        [JSON.stringify([app, "invoices"]), 3 * pricedMicros],
        [JSON.stringify([app, "orders"]), pricedMicros],
      ].toSorted(byJson),
      deployment: [{ key: "deployment", spentMicros: 5 * pricedMicros }],
    });
  });
});

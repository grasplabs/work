import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { runActorOf } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { modelUsage } from "../src/db/core/schema.ts";
import { monthSpend } from "../src/model-spend.ts";
import { recordResponse } from "../src/model-usage.ts";
import { models } from "../src/models.ts";
import type { ModelCall } from "../src/models.ts";
import { allEvents } from "./audit-events.ts";
import { platformOpenAiKey } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import {
  askingWorkflow,
  endedRun,
  jsonWorkflowAppsOf,
  startedBy,
} from "./json-workflow-apps.ts";
import { runQuarterHourTasks } from "./maintenance.ts";
import { answeringProvider } from "./model-provider.ts";
import type { FakeProvider, ProviderReply } from "./model-provider.ts";
import {
  providerHealthRows,
  recordedUsage,
  spentMicros,
  usageRows,
} from "./model-usage.ts";
import { plan } from "./platform-providers.ts";
import { streamText } from "./provider-streams.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// Model spend, recorded after each response (src/model-usage.ts): the
// request goes straight to the provider, and once it answered, what it
// used and cost is written in the same D1 batch as its audit event, in
// the background. Nothing is reserved before a request, and nothing in the
// record can fail or hold up a call. The spend overview is a query over
// the rows (src/model-spend.ts). The model provider behind connect is the
// outside system (test/model-provider.ts). The usage rows, the audit log
// and the runs are real; where a test needs the record to fail, core's
// database refuses its writes, as an unreachable one would. A run's calls
// are a JSON workflow's run's real `grasp.model` tasks (resource-calls.ts).

const idp = mockIdp();

const mistral = "mistral/mistral-large-latest";
const anthropic = "anthropic/claude-sonnet-4-5";

/** Priced in tiers: twice the input and half again the output past 272K. */
const tiered = "openai/gpt-5.4";
/** The models the organization chose: Mistral Large its default. */
const chosen = [mistral, anthropic, tiered];

/**
 * Costs 650 micros from Mistral Large, at its list prices of $0.50 per
 * million tokens in and $1.50 out.
 */
const pricedAnswer = { text: "Hi.", inputTokens: 1000, outputTokens: 100 };
const pricedMicros = 500 + 150;

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
    SPEND_MONTH: month,
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

/** The audit events `actor` triggered. */
const eventsOf = async (actor: unknown): Promise<AuditEvent[]> => {
  const events = await allEvents();
  return events.filter(
    (event) => JSON.stringify(event.actor) === JSON.stringify(actor)
  );
};

/** `actor`'s `model.call` events, once there are `count`: recorded after the answer. */
const callEventsOf = async (actor: unknown, count: number) =>
  await vi.waitFor(
    async () => {
      const all = await eventsOf(actor);
      const events = all.filter(({ action }) => action === "model.call");
      expect(events).toHaveLength(count);
      return events;
    },
    { timeout: 5000, interval: 20 }
  );

/** What `userId` spent in `month`, in micros, once `count` responses of theirs are recorded. */
const spentBy = async (
  month: string,
  userId: string,
  count = 1
): Promise<number> => {
  await recordedUsage(month, count, { personId: userId });
  return await spentMicros(month, { personId: userId });
};

/**
 * Core's database, refusing what `refuses` says of a statement's SQL, as
 * an unreachable database would; everything else as it is.
 */
const refusingDatabase = (refuses: (sql: string) => Error | undefined) => {
  const database: D1Database = env.DB;
  return new Proxy(database, {
    get: (target, name): unknown => {
      if (name !== "prepare") {
        return Reflect.get(target, name, target);
      }
      return (sql: string) => {
        const refusal = refuses(sql);
        if (refusal !== undefined) {
          throw refusal;
        }
        return target.prepare(sql);
      };
    },
  });
};

/** Whether `sql` writes a usage row. */
const recordsUsage = (sql: string): boolean =>
  sql.includes('insert into "model_usage"');

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
    const rulesEnv: Env = { ...env, SPEND_MONTH: month };

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
    const [grasp] = await recordedUsage(month, 1, { credential: "platform" });

    expect({
      converted,
      user: await spentBy(month, trigger.userId),
      organization: await spentMicros(month),
      grasp: [grasp?.feature, grasp?.model, (grasp?.cost ?? 0) > 0],
    }).toStrictEqual({
      converted: "ok",
      // The organization's spend is what its own key cost: the call.
      user: pricedMicros,
      organization: pricedMicros,
      grasp: ["conversion", "openai/gpt-5.4-mini", true],
    });
  });

  it("count the calls an agent or a run makes for a person as that person's spend", async () => {
    const { signedIn: signedInPerson } = jsonWorkflowAppsOf(idp);
    const [admin, builder] = await Promise.all([
      signedInPerson("admin"),
      signedInPerson("builder"),
    ]);
    // Counted in the month it is: a run's call counts in it.
    const { call } = withProvider(
      [
        // The run's `grasp.model` task, which answers in its schema.
        { ...pricedAnswer, text: '{"line": "Hi."}' },
        ...times(2, pricedAnswer),
      ],
      { SPEND_MONTH: undefined }
    );
    const month = new Date().toISOString().slice(0, "yyyy-mm".length);
    const ada = { type: "person", userId: builder.userId } as const;
    // A run of an independent workflow Ada started, asking Mistral Large
    // for her.
    const { id } = await askingWorkflow(admin, builder);
    const run = await endedRun(builder, id, await startedBy(builder, id));
    const forAda = [
      hello({
        trigger: { type: "agent", agentId: "chat", onBehalfOf: ada.userId },
      }),
      hello({ trigger: ada }),
    ];

    await expect(
      inTurn(forAda.map((made) => async () => await call(made)))
    ).resolves.toStrictEqual(["ok", "ok"]);
    expect(run.status).toBe("completed");
    await expect(spentBy(month, ada.userId, 3)).resolves.toBe(3 * pricedMicros);
    // The run's call names its workflow and its lineage too.
    const rows = await usageRows(month, { personId: ada.userId });
    expect(
      rows
        .filter(({ workflowId }) => workflowId === id)
        .map(({ runId }) => runId)
    ).toHaveLength(1);
    // Only the agent's call names an agent, so each agent's use can be
    // told from a person's own and a workflow's.
    expect({
      byAgent: rows.filter(({ agentId }) => agentId === "chat").length,
      byNone: rows.filter(({ agentId }) => agentId === null).length,
    }).toStrictEqual({ byAgent: 1, byNone: 2 });
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
    await expect(spentBy(month, ada.userId)).resolves.toBe(500 + 1500);
  });

  it("record an answer cancelled midway at what it used, never nothing, and say that it was estimated", async () => {
    // The answer stops after its first 12 characters, until released: the
    // provider's count, which comes with the answer's end, never arrives.
    const rest = Promise.withResolvers<boolean>();
    const cut = {
      text: "Hello there, how are you today?",
      inputTokens: 1000,
      outputTokens: 100,
      pause: { at: 12, until: rest.promise },
    };
    // Some 50,000 tokens at four characters each.
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
      const [adas] = await callEventsOf(ada, 1);
      const [bens] = await callEventsOf(ben, 1);
      const [adaRow] = await recordedUsage(limited.month, 1, {
        personId: ada.userId,
      });
      const tokens = adas?.model?.inputTokens ?? 0;
      expect({
        stopped,
        recorded: [adaRow?.estimated, adaRow?.inputTokens === tokens],
        ada: [adas?.action, adas?.detail, adas?.model?.outputTokens],
        prompt: tokens >= prompt.length / 4 && tokens < prompt.length / 4 + 200,
        ben: [bens?.action, bens?.detail, bens?.model],
      }).toMatchObject({
        stopped: ["aborted", "aborted"],
        // Chat completions count nothing before their end: the prompt is
        // estimated from what was sent, so cancelling is never free.
        recorded: [true, true],
        ada: [
          "model.call",
          {
            outcome: "cancelled",
            errorType: "cancelled",
            estimated: true,
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

  it("record each answered response once, with its tokens and cost: never a refusal before the provider took it on, nor a request that got no answer", async () => {
    // A refusal for the provider's rate costs nothing: the gateway asks
    // again once the wait is over, and only the answer is recorded.
    const refused = withProvider([
      {
        status: 429,
        errorType: "rate_limit_error",
        headers: { "retry-after": "1" },
      },
      pricedAnswer,
    ]);
    // A server error: no answer, nothing to record, the call failed.
    const failed = withProvider([{ status: 500 }]);
    const ada = hello();
    const ben = hello();

    await expect(
      inTurn([
        async () => await refused.call(ada),
        async () => await failed.call(ben),
      ])
    ).resolves.toStrictEqual(["ok", "model.provider_unavailable"]);
    const [adaEvent] = await callEventsOf(ada.trigger, 1);
    const [benEvent] = await callEventsOf(ben.trigger, 1);
    const rows = await usageRows(refused.month, { personId: userOf(ada) });

    expect({
      // The provider is one: its refusal, its answer, and its server error.
      sent: refused.fake.requests.length,
      ada: rows.map(({ model, inputTokens, outputTokens, estimated }) => ({
        model,
        inputTokens,
        outputTokens,
        estimated,
      })),
      adaSpent: await spentMicros(refused.month, { personId: userOf(ada) }),
      ben: await usageRows(failed.month, { personId: userOf(ben) }),
      events: [adaEvent?.detail.outcome, benEvent?.detail.outcome],
    }).toStrictEqual({
      sent: 3,
      ada: [
        {
          model: mistral,
          inputTokens: 1000,
          outputTokens: 100,
          estimated: false,
        },
      ],
      adaSpent: pricedMicros,
      ben: [],
      events: ["answered", "failed"],
    });
  });

  it("answer a call whose usage can't be recorded, logging it and keeping its audit event", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(JSON.stringify(args));
    });
    const { call, month } = withProvider([pricedAnswer], {
      DB: refusingDatabase((sql) =>
        recordsUsage(sql) ? new Error("Unavailable") : undefined
      ),
    });
    const ada = hello();

    await expect(call(ada)).resolves.toMatchObject({ text: "Hi." });
    const [event] = await callEventsOf(ada.trigger, 1);
    expect({
      event: [event?.detail.outcome, event?.model?.inputTokens],
      logged: errors.some((line) => line.includes("model.usage_unrecorded")),
      recorded: await usageRows(month, { personId: userOf(ada) }),
    }).toStrictEqual({
      event: ["answered", 1000],
      logged: true,
      recorded: [],
    });
  });

  it("record a response once when core's database failed for a moment, trying again", async () => {
    let refusals = 1;
    const { call, month } = withProvider([pricedAnswer], {
      DB: refusingDatabase((sql) => {
        const refused = recordsUsage(sql) && refusals > 0;
        refusals -= refused ? 1 : 0;
        // Worded as D1 words a moment's overload.
        return refused
          ? new Error("D1 DB is overloaded. Requests queued for too long.")
          : undefined;
      }),
    });
    const ada = hello();

    await expect(call(ada)).resolves.toMatchObject({ text: "Hi." });
    await expect(spentBy(month, userOf(ada))).resolves.toBe(pricedMicros);
    await expect(callEventsOf(ada.trigger, 1)).resolves.toHaveLength(1);
    await expect(
      usageRows(month, { personId: userOf(ada) })
    ).resolves.toHaveLength(1);
  });

  it("keep a response's event and usage once when every batch commits but its answer is lost", async () => {
    const database: D1Database = env.DB;
    const { call, month } = withProvider([pricedAnswer], {
      // Each batch is written, then its answer lost on the way back.
      DB: new Proxy(database, {
        get: (target, name): unknown => {
          if (name !== "batch") {
            return Reflect.get(target, name, target);
          }
          return async (statements: D1PreparedStatement[]) => {
            await target.batch(statements);
            throw new Error("Network connection lost.");
          };
        },
      }),
    });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(JSON.stringify(args));
    });
    const ada = hello();

    await expect(call(ada)).resolves.toMatchObject({ text: "Hi." });
    // Past every try of the batch, then drained into the log.
    await vi.waitFor(() => {
      expect(
        errors.some((line) => line.includes("model.usage_unrecorded"))
      ).toBeTruthy();
    });
    const events = await eventsOf(ada.trigger);
    const rows = await usageRows(month, { personId: userOf(ada) });
    expect({
      events: events.filter(({ action }) => action === "model.call").length,
      rows: rows.length,
    }).toStrictEqual({ events: 1, rows: 1 });
  });

  it("never put an older result over a newer one in a provider's health, however late its record lands", async () => {
    const named = `provider-${crypto.randomUUID()}`;
    /** A response of `provider`'s that ended at `at`, failed or not, recorded now. */
    const noted = async (at: number, failed: boolean) => {
      await recordResponse(
        env,
        {
          at,
          entry: {
            actor: { type: "system" },
            action: "model.call",
            detail: { purpose: "test.health" },
          },
          spend: { trigger: { type: "system" } },
          health: {
            provider: named,
            credential: "organization",
            ...(failed
              ? {
                  failed: { failure: "auth", status: 401, trouble: "refused" },
                }
              : {}),
          },
        },
        { awaited: true }
      );
    };
    const now = Date.now();

    // A newer failure lands first; an older success, tried again, after it.
    await noted(now, true);
    await noted(now - 1000, false);
    const rows = await providerHealthRows();

    expect(rows.find((row) => row.provider === named)).toMatchObject({
      lastOkAt: null,
      lastFailedAt: now,
      failingClass: "refused",
    });
  });

  it("keep usage rows 400 days, then sweep them from the clock", async () => {
    const day = 24 * 60 * 60 * 1000;
    const month = newMonth();
    const now = Date.now();
    /** A usage row of `month` written `days` ago. */
    const rowOf = (days: number) => ({
      id: crypto.randomUUID(),
      period: month,
      personId: null,
      triggerType: "person",
      model: mistral,
      credential: "organization",
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: pricedMicros / 1_000_000,
      estimated: false,
      createdAt: new Date(now - days * day),
    });
    const [kept, gone] = [rowOf(399), rowOf(401)];
    await drizzle(env.DB).insert(modelUsage).values(kept);
    await drizzle(env.DB).insert(modelUsage).values(gone);

    await runQuarterHourTasks({}, new Date(now));
    const rows = await usageRows(month);

    expect(rows.map(({ id }) => id)).toStrictEqual([kept.id]);
  });

  it("return what it records of an answer that came with no count: the estimate, never nothing", async () => {
    const { call, month } = withProvider([{ ...pricedAnswer, noUsage: true }]);
    const ada = hello();

    const answer = await call(ada);
    const [event] = await callEventsOf(ada.trigger, 1);
    const [row] = await recordedUsage(month, 1, { personId: userOf(ada) });

    expect({
      returned: [answer.usage.inputTokens, answer.usage.outputTokens],
      audited: [event?.model?.inputTokens, event?.model?.outputTokens],
      recorded: [row?.inputTokens, row?.outputTokens, row?.estimated],
      cost: [answer.cost > 0, answer.cost === event?.cost?.amount],
    }).toStrictEqual({
      returned: [row?.inputTokens, row?.outputTokens],
      audited: [row?.inputTokens, row?.outputTokens],
      recorded: [row?.inputTokens, row?.outputTokens, true],
      cost: [true, true],
    });
  });

  it("charge a Claude Sonnet 4.5 prompt past 200K tokens at Anthropic's long-context prices, as its audit event counts it", async () => {
    const { call, month } = withProvider([
      { text: "Hi.", inputTokens: 250_000, outputTokens: 100 },
    ]);
    const ada = hello({ model: anthropic, maxTokens: 1 });

    await expect(outcome(call(ada))).resolves.toBe("ok");
    const [event] = await callEventsOf(ada.trigger, 1);
    // $6 a million in and $22.50 out past 200K, not $3 and $15.
    expect({
      spent: await spentBy(month, userOf(ada)),
      audited: Math.round((event?.cost?.amount ?? 0) * 1_000_000),
    }).toStrictEqual({
      spent: 250_000 * 6 + 2250,
      audited: 250_000 * 6 + 2250,
    });
  });

  it("answer every request of a long agent turn, recording each once", async () => {
    const steps = 40;
    const { agent, month } = withProvider(times(steps, pricedAnswer));
    const ada = newPerson();
    const session = await agent({
      model: mistral,
      maxTokens: smallCap,
      purpose: "chat.turn",
      trigger: ada,
      work: requireWork(),
    });
    const stopped: string[] = [];
    for (let step = 0; step < steps; step += 1) {
      const stream = session.stream(
        session.model,
        normalizeContext({
          messages: [
            { role: "user", content: `Step ${step}`, timestamp: Date.now() },
          ],
        })
      );
      // oxlint-disable-next-line no-await-in-loop -- one request after another, as a turn makes them
      const answer = await stream.result();
      stopped.push(answer.stopReason);
    }

    expect(new Set(stopped)).toStrictEqual(new Set(["stop"]));
    await expect(spentBy(month, ada.userId, steps)).resolves.toBe(
      steps * pricedMicros
    );
  });

  it("sum a month's spend in the overview: the total across every caller, and each workflow's apart", async () => {
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
    // A new person: the total counts every caller, in this month.
    await call(hello());
    await recordedUsage(month, 5);
    const spend = await monthSpend(env, month);

    expect({
      total: Math.round(spend.total * 1_000_000),
      workflows: spend.workflows.map(({ appId, workflowId, amount }) => [
        appId,
        workflowId,
        Math.round(amount * 1_000_000),
      ]),
      more: spend.more,
    }).toStrictEqual({
      total: 5 * pricedMicros,
      workflows: [
        [app, "invoices", 3 * pricedMicros],
        [app, "orders", pricedMicros],
      ],
      more: false,
    });
  });
});

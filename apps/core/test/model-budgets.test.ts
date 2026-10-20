import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { runActorOf } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema, runIdSchema } from "@grasp-os/shared/ids";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { budgetPeriods } from "../src/model-budgets.ts";
import type { ModelLedger } from "../src/model-ledger.ts";
import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import type { ModelCall, ModelsEnv } from "../src/models.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { finished } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// Model budgets, enforced by the model ledger: every provider request is
// admitted before it is sent, reserving the most it can cost against all
// of its scopes at once, and settled once it ends. AI Gateway is the
// outside system: a fake behind the AI binding. The ledger, the audit log
// and the runs are real; where a test needs the ledger to fail, its
// binding fails, as an unreachable Durable Object would.

const idp = mockIdp();

const workersAi = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const anthropic = "anthropic/claude-sonnet-4-5";

const gateway = "grasp-os-test";
/** Priced in tiers: twice the input and half again the output past 272K. */
const tiered = "openai/gpt-5.4";
const allowed = [workersAi, anthropic, tiered];

/**
 * Costs 519 micros from Llama 3.3, at its list prices of $0.293 per
 * million tokens in and $2.253 out, each rounded up to whole micros.
 */
const pricedAnswer = { text: "Hi.", inputTokens: 1000, outputTokens: 100 };
const pricedMicros = 293 + 226;

/** A prompt of 10,000 bytes, which Llama 3.3 reserves some $0.0035 for. */
const nextPrompt = "word ".repeat(2000);

/** Costs $0.029526 from Llama 3.3: far more than a capped request reserves. */
const dearAnswer = { text: "Hi.", inputTokens: 100_000, outputTokens: 100 };

/**
 * The answer's cap the budget tests ask for: a Llama request then reserves
 * well under a tenth of a cent, so what decides is what was spent.
 */
const smallCap = 100;

let monthsUsed = 0;

/** A month no other test counts budgets in: from 2300, clear of other files. */
const newMonth = (): string => {
  monthsUsed += 1;
  return `${2300 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/**
 * Core's env with the fake gateway answering with `replies`, and the rules
 * `config` adds; budgets count in `month`.
 */
const withRules = (
  config: Record<string, unknown>,
  replies: GatewayReply[],
  more: Partial<ModelsEnv> = {}
) => {
  const fake = fakeGateway(...replies);
  const month = newMonth();
  const rulesEnv: ModelsEnv = {
    ...env,
    AI: fake.binding,
    MODEL_GATEWAY: { gateway, models: allowed, ...config },
    MODEL_BUDGET_MONTH: month,
    ...more,
  };
  const { call, agent } = models(rulesEnv);
  return { fake, call, agent, month };
};

/** `count` of `reply`. */
const times = (count: number, reply: GatewayReply): GatewayReply[] =>
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

/** A capped call to Llama, unless `more` says otherwise. */
const hello = (
  more: Partial<ModelCall<undefined>> = {}
): ModelCall<undefined> => ({
  model: workersAi,
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

/** `"waiting"`, once `ms` went by. */
const waiting = async (ms: number): Promise<string> => {
  await scheduler.wait(ms);
  return "waiting";
};

/** What a refused call was told: its code, message and details. */
const toldBy = async (refused: Promise<unknown>) => {
  const caught = await refused.then(
    () => "admitted",
    (error: unknown) => error
  );
  return z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()),
    })
    .parse(caught);
};

/** The seconds until the next UTC month begins, when a month's budget resets. */
const untilNextMonth = (): number => {
  const now = new Date();
  return Math.ceil(
    (Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime()) /
      1000
  );
};

/** Text in order. */
const byText = (one: string, other: string): number => one.localeCompare(other);

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

/** What `userId` spent and holds in `month`, as the ledger counts it. */
const ledgerOf = async (month: string, userId: string) => {
  const spent = await modelLedger(env).spendOf(month, ["user"], 1000);
  return (
    spent.user?.find(({ key }) => key === userId) ?? {
      spentMicros: 0,
      reservedMicros: 0,
    }
  );
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

/** The provider request IDs the gateway's log was told, in order. */
const requestIds = (fake: ReturnType<typeof fakeGateway>): unknown[] =>
  fake.requests.map(
    ({ headers }) =>
      z
        .object({ providerRequest: z.unknown() })
        .parse(JSON.parse(headers.get("cf-aig-metadata") ?? "{}"))
        .providerRequest
  );

/** The month and day a request at `iso` counts in. */
const periodsAt = (iso: string) => budgetPeriods({}, new Date(iso));

describe("budget periods", () => {
  it("count a request's day and month by one clock, across a month's end", () => {
    expect({
      last: periodsAt("2031-01-31T23:59:59.999Z"),
      first: periodsAt("2031-02-01T00:00:00.000Z"),
    }).toStrictEqual({
      last: { month: "2031-01", day: "2031-01-31" },
      first: { month: "2031-02", day: "2031-02-01" },
    });
  });
});

describe("model budgets", { timeout: 60_000 }, () => {
  beforeEach(async () => {
    if (appWork !== undefined) {
      return;
    }
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Model budgets" });
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

  it("alert admins when a person's spend crosses the alert threshold and the limit, then stop their calls, and no one else's", async () => {
    const { call, month } = withRules(
      { budgets: { user: { limit: 0.1, alertAt: 40 } } },
      times(6, dearAnswer)
    );
    const trigger = newPerson();
    const ada = hello({ trigger });

    // $0.0295 a call: past 40% with the second, past the limit with the fourth.
    await expect(
      inTurn(Array.from({ length: 5 }, () => async () => await call(ada)))
    ).resolves.toStrictEqual(["ok", "ok", "ok", "ok", "model.over_budget"]);
    // Spent, not held: asking again helps only once the month is over,
    // when its budget resets.
    const usedUp = await toldBy(call(ada));
    const resetIn = untilNextMonth();
    expect({
      ...usedUp,
      resetsWithTheMonth:
        Math.abs(Number(usedUp.details.retryAfterSeconds) - resetIn) <= 5,
    }).toStrictEqual({
      code: "model.over_budget",
      message:
        "The model budget for the month of the person this call is made for is used up, so no more model calls can be made for them until it resets at the start of next month (UTC). Ask your admin to have Grasp raise the budget.",
      details: {
        model: workersAi,
        because: "user",
        retryAfterSeconds: usedUp.details.retryAfterSeconds,
      },
      resetsWithTheMonth: true,
    });
    await expect(outcome(call(hello()))).resolves.toBe("ok");
    const events = await eventsOf(trigger);
    expect({
      alerts: events.filter(({ action }) => action.startsWith("model.budget.")),
      refused: events.filter(({ action }) => action === "model.refused"),
      ledger: await ledgerOf(month, trigger.userId),
    }).toMatchObject({
      alerts: [
        {
          action: "model.budget.alert",
          detail: { scope: "user", user: trigger.userId, threshold: 0.04 },
        },
        {
          action: "model.budget.exhausted",
          detail: { scope: "user", limit: 0.1, threshold: 0.1 },
        },
      ],
      refused: [
        { detail: { reason: "model.over_budget", because: "user" } },
        { detail: { reason: "model.over_budget", because: "user" } },
      ],
      // Four answers' cost, and nothing held.
      ledger: { spentMicros: 4 * (29_300 + 226), reservedMicros: 0 },
    });
  });

  it("admit concurrent requests only while their reservations fit the budget together, telling the rest to try again once those finish", async () => {
    // A request to Sonnet 4.5 may write 24,576 tokens (its cap with a
    // thinking budget), reserved at its long-context price of $22.50 a
    // million: some $0.56 each, so $1.50 fits two.
    const release = Promise.withResolvers<boolean>();
    const paused = {
      ...pricedAnswer,
      text: "Hello there.",
      pause: { at: 3, until: release.promise },
    };
    const { fake, call, month } = withRules(
      { budgets: { user: { limit: 1.5 } } },
      [...times(2, paused), pricedAnswer]
    );
    const ada = hello({ model: anthropic, maxTokens: undefined });

    const calls = Array.from(
      { length: 4 },
      async () =>
        await call(ada).then(
          () => "ok",
          (error: unknown) => error
        )
    );
    const busy = {
      code: "model.budget_busy",
      details: { because: "user", retryAfterSeconds: 180 },
    };
    const audited = {
      detail: {
        reason: "model.budget_busy",
        because: "user",
        retryAfterSeconds: 180,
      },
    };
    // Two refused while the two admitted are still answering.
    const settled = await Promise.race([Promise.all(calls), waiting(2000)]);
    const held = await ledgerOf(month, userOf(ada));
    release.resolve(true);

    expect({ settled, sent: fake.requests.length }).toStrictEqual({
      settled: "waiting",
      sent: 2,
    });
    expect(held.reservedMicros).toBeGreaterThan(2 * 368_640);
    const outcomes = await Promise.all(calls);
    // Once they settled at what they cost, there is room again.
    const after = await outcome(call(ada));
    const events = await eventsOf(ada.trigger);
    expect({
      // Nothing is spent: the two answering hold the room, and give it
      // back once they finish, by their three-minute deadline at the latest.
      admitted: outcomes.filter((one) => one === "ok").length,
      refused: outcomes.filter((one) => one !== "ok"),
      audited: events.filter(({ action }) => action === "model.refused"),
      after,
      ledger: await ledgerOf(month, userOf(ada)),
    }).toMatchObject({
      admitted: 2,
      refused: [busy, busy],
      audited: [audited, audited],
      after: "ok",
      ledger: {
        key: userOf(ada),
        // $3 a million in and $15 out: $0.0045 each.
        spentMicros: 3 * 4500,
        reservedMicros: 0,
      },
    });
  });

  it("tell a call to try again only when the calls under way would leave it room once they finish, never when what was spent leaves none", async () => {
    // Sonnet 4.5 reserves some $0.56 while it answers; Llama's answer
    // costs $0.586, far past the little it reserves. With $1 there is room
    // for a small Llama request once Sonnet's answer is in, never for
    // another Sonnet request.
    const release = Promise.withResolvers<boolean>();
    const paused = {
      ...pricedAnswer,
      text: "Hello there.",
      pause: { at: 3, until: release.promise },
    };
    const costly = { text: "Hi.", inputTokens: 2_000_000, outputTokens: 100 };
    const { call, agent, month } = withRules(
      { budgets: { user: { limit: 1 } } },
      [paused, costly, pricedAnswer]
    );
    const trigger = newPerson();
    const sonnet = hello({ trigger, model: anthropic, maxTokens: undefined });
    const llama = hello({ trigger });

    const answering = outcome(call(sonnet));
    let held = await ledgerOf(month, trigger.userId);
    while (held.reservedMicros === 0) {
      // oxlint-disable-next-line no-await-in-loop -- until Sonnet's request is in
      await scheduler.wait(10);
      // oxlint-disable-next-line no-await-in-loop -- until Sonnet's request is in
      held = await ledgerOf(month, trigger.userId);
    }
    const before = await outcome(call(llama));
    const whileAnswering = {
      sonnet: await toldBy(call(sonnet)),
      llama: await toldBy(call(llama)),
    };
    // An agent's turn hears the same, in its stream's error.
    const session = await agent({
      model: workersAi,
      purpose: "chat.turn",
      trigger,
      work: requireWork(),
    });
    const stream = session.stream(
      session.model,
      normalizeContext({
        messages: [{ role: "user", content: "Hello.", timestamp: Date.now() }],
      })
    );
    const turn = await stream.result();
    release.resolve(true);
    const answered = await answering;
    // Sonnet's answer is in, at $0.0045: the room it held is back.
    const after = {
      llama: await outcome(call(llama)),
      sonnet: await outcome(call(sonnet)),
    };

    expect({
      before,
      whileAnswering,
      turn: [turn.stopReason, turn.errorMessage],
      answered,
      after,
    }).toStrictEqual({
      before: "ok",
      whileAnswering: {
        // Out of room even once the calls under way end: used up until
        // the month's budget resets.
        sonnet: {
          code: "model.over_budget",
          message:
            "The model budget for the month of the person this call is made for is used up, so no more model calls can be made for them until it resets at the start of next month (UTC). Ask your admin to have Grasp raise the budget.",
          details: {
            model: anthropic,
            because: "user",
            retryAfterSeconds: whileAnswering.sonnet.details.retryAfterSeconds,
          },
        },
        llama: {
          code: "model.budget_busy",
          message:
            "Model calls still under way hold what's left of the model budget for the month of the person this call is made for. Try again once they finish.",
          details: {
            model: workersAi,
            because: "user",
            retryAfterSeconds: 180,
          },
        },
      },
      turn: [
        "error",
        "The model call was refused (model.budget_busy). Try again in 180 seconds.",
      ],
      answered: "ok",
      after: { llama: "ok", sonnet: "model.over_budget" },
    });
  });

  it("word each used-up budget after the cap that refused it, with when it resets", async () => {
    const app = appIdSchema.parse(crypto.randomUUID());
    // Sonnet 4.5 reserves some $0.56: a cent leaves no room for it.
    const sonnet = (more: Partial<ModelCall<undefined>> = {}) =>
      hello({ model: anthropic, maxTokens: undefined, ...more });
    const through = (budget: Record<string, number>) =>
      sonnet({ binding: { app, alias: "WRITER", budget } });
    const deployment = withRules(
      { budgets: { deployment: { limit: 0.01 } } },
      []
    );
    const open = withRules({}, []);
    const told = async (refused: Promise<unknown>) => {
      const { message, details } = await toldBy(refused);
      return [details.because, message, typeof details.retryAfterSeconds];
    };

    expect([
      await told(deployment.call(sonnet())),
      await told(open.call(through({ perMonth: 0.01 }))),
      await told(open.call(through({ perDay: 0.01 }))),
      await told(open.call(through({ perRequest: 0.01 }))),
    ]).toStrictEqual([
      [
        "deployment",
        "This deployment's model budget for the month is used up, so no more model calls can be made until it resets at the start of next month (UTC). Ask your admin to have Grasp raise the budget.",
        "number",
      ],
      [
        "binding",
        "This model binding's budget for the month is used up, so the App can make no more calls through it until the budget resets at the start of next month (UTC). Ask your admin to raise the binding's monthly budget.",
        "number",
      ],
      [
        "binding_day",
        "This model binding's budget for the day is used up, so the App can make no more calls through it until the budget resets at midnight (UTC). Ask your admin to raise the binding's daily budget.",
        "number",
      ],
      [
        "binding_request",
        "This model call could cost more than this model binding's cap per request has room for, so it was stopped before it went out. Send less, or ask your admin to raise the binding's budget per request.",
        "undefined",
      ],
    ]);
  });

  it("suggest a wait from the calls under way only to the person they are all theirs, a fixed one where others' calls hold the budget, and none to a guest", async () => {
    const release = Promise.withResolvers<boolean>();
    const paused = {
      ...pricedAnswer,
      text: "Hello there.",
      pause: { at: 3, until: release.promise },
    };
    // Sonnet 4.5 reserves some $0.56: $1 has no room for a second beside it.
    const own = withRules({ budgets: { user: { limit: 1 } } }, [paused]);
    const shared = withRules({ budgets: { deployment: { limit: 1 } } }, [
      paused,
    ]);
    const ada = newPerson();
    const sonnet = (
      trigger: ModelCall<undefined>["trigger"],
      more: Partial<ModelCall<undefined>> = {}
    ) => hello({ trigger, model: anthropic, maxTokens: undefined, ...more });
    const guest = {
      type: "guest",
      chatId: `chat-${crypto.randomUUID()}`,
      appId: appIdSchema.parse(crypto.randomUUID()),
      invitedBy: ada.userId,
    } as const;
    // Ada's call may take 15 minutes: the wait is capped at five.
    const answering = [
      outcome(own.call(sonnet(ada, { timeoutMs: 15 * 60_000 }))),
      outcome(shared.call(sonnet(newPerson()))),
    ];
    const heldBoth = async () => {
      const [mine, everyone] = await Promise.all([
        ledgerOf(own.month, ada.userId),
        modelLedger(env).spendOf(shared.month, ["deployment"], 1),
      ]);
      return (
        mine.reservedMicros > 0 &&
        (everyone.deployment?.[0]?.reservedMicros ?? 0) > 0
      );
    };
    // oxlint-disable-next-line no-await-in-loop -- until both are under way
    while (!(await heldBoth())) {
      // oxlint-disable-next-line no-await-in-loop -- until both are under way
      await scheduler.wait(10);
    }
    // A cent leaves no room for Sonnet at all: Ada's budget there is used
    // up, with nothing of hers under way.
    const usedUp = withRules({ budgets: { user: { limit: 0.01 } } }, []);
    const told = {
      ada: await toldBy(own.call(sonnet(ada))),
      guest: await toldBy(own.call(sonnet(guest))),
      ben: await toldBy(shared.call(sonnet(newPerson()))),
    };
    // Held by the member's calls under way, or used up: a guest is told
    // the same, so it learns nothing of what the member has under way.
    const guestWhenUsedUp = await toldBy(usedUp.call(sonnet(guest)));
    release.resolve(true);
    expect(guestWhenUsedUp).toStrictEqual(told.guest);

    expect({ told, answered: await Promise.all(answering) }).toStrictEqual({
      told: {
        ada: {
          code: "model.budget_busy",
          message:
            "Model calls still under way hold what's left of the model budget for the month of the person this call is made for. Try again once they finish.",
          details: {
            model: anthropic,
            because: "user",
            retryAfterSeconds: 300,
          },
        },
        // The member's calls are theirs to know of.
        guest: {
          code: "model.over_budget",
          message:
            "A model budget this call counts against is used up, so this model call can't be made. Ask your admin to have Grasp raise the budget.",
          details: { model: anthropic, because: "user" },
        },
        // Someone else's call holds it: a fixed wait, nothing of its timing.
        ben: {
          code: "model.budget_busy",
          message:
            "Model calls still under way hold what's left of this deployment's model budget for the month. Try again once they finish.",
          details: {
            model: anthropic,
            because: "deployment",
            retryAfterSeconds: 60,
          },
        },
      },
      answered: ["ok", "ok"],
    });
  });

  it("suggest a run of an App a fixed wait where its person's own calls hold their budget, and their chat the wait those calls leave", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, workflowFiles("idle", "  return null;"));
    const run = await builder.api.workflows.start(app, "idle");
    await finished(run.id);
    const appId = appIdSchema.parse(app);
    const release = Promise.withResolvers<boolean>();
    const paused = {
      ...pricedAnswer,
      text: "Hello there.",
      pause: { at: 3, until: release.promise },
    };
    // Sonnet 4.5 reserves some $0.56: $1 has no room for a second beside it.
    const { call, month } = withRules({ budgets: { user: { limit: 1 } } }, [
      paused,
    ]);
    const ada = { type: "person", userId: builder.userId } as const;
    const sonnet = (more: Partial<ModelCall<undefined>>) =>
      hello({ model: anthropic, maxTokens: undefined, ...more });
    // Ada's own call may take 15 minutes: her wait is capped at five.
    const answering = outcome(
      call(sonnet({ trigger: ada, timeoutMs: 15 * 60_000 }))
    );
    // Released however the checks go, so no call is left open.
    const told: Record<string, unknown[]> = {};
    try {
      let mine = await ledgerOf(month, ada.userId);
      while (mine.reservedMicros === 0) {
        // oxlint-disable-next-line no-await-in-loop -- until Ada's call is under way
        await scheduler.wait(10);
        // oxlint-disable-next-line no-await-in-loop -- until Ada's call is under way
        mine = await ledgerOf(month, ada.userId);
      }
      const retryAfter = async (more: Partial<ModelCall<undefined>>) => {
        const { code, details } = await toldBy(call(sonnet(more)));
        return [code, details.because, details.retryAfterSeconds];
      };
      Object.assign(told, {
        // Her chat: the calls holding her budget are made for her.
        chat: await retryAfter({
          trigger: { type: "agent", agentId: "chat", onBehalfOf: ada.userId },
        }),
        // A run of an App: its code is told nothing of when her chats' (or
        // other Apps') calls were sent.
        run: await retryAfter({
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
      });
    } finally {
      release.resolve(true);
    }

    expect({ told, answered: await answering }).toStrictEqual({
      told: {
        chat: ["model.budget_busy", "user", 300],
        run: ["model.budget_busy", "user", 60],
      },
      answered: "ok",
    });
  });

  it("count the calls an agent or a run makes for a person against that person's budget", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, workflowFiles("idle", "  return null;"));
    const run = await builder.api.workflows.start(app, "idle");
    await finished(run.id);
    const appId = appIdSchema.parse(app);
    const { call } = withRules(
      { budgets: { user: { limit: 0.07 } } },
      times(4, dearAnswer)
    );
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
      hello({ trigger: ada }),
    ];

    await expect(
      inTurn(forAda.map((made) => async () => await call(made)))
    ).resolves.toStrictEqual(["ok", "ok", "ok", "model.over_budget"]);
  });

  it("charge what a model thought, as the provider counts it in the answer's output", async () => {
    // 900 tokens of thinking on top of the answer's 100: 1,000 out at
    // Llama 3.3's $2.253 a million, beside the 1,000 in.
    const thought = {
      ...pricedAnswer,
      outputTokens: pricedAnswer.outputTokens + 900,
      thinking: { text: "Ada said hello; greet her back.", tokens: 900 },
    };
    const { call, month } = withRules({ budgets: { user: { limit: 1 } } }, [
      thought,
    ]);
    const ada = newPerson();

    await expect(outcome(call(hello({ trigger: ada })))).resolves.toBe("ok");
    await expect(ledgerOf(month, ada.userId)).resolves.toMatchObject({
      spentMicros: 293 + 2253,
      reservedMicros: 0,
    });
  });

  it("keep an answer cancelled midway reserved in full, so cancelling is never free, and its audit event says what it used was estimated", async () => {
    // The answer stops after its first 12 characters, until released: the
    // provider's count, which comes with the answer's end, never arrives.
    const rest = Promise.withResolvers<boolean>();
    const cut = {
      text: "Hello there, how are you today?",
      inputTokens: 1000,
      outputTokens: 100,
      pause: { at: 12, until: rest.promise },
    };
    // Some 50,000 tokens at four characters each, and as many bytes: Llama
    // 3.3 reserves some $0.059 for it (pi caps its answer at a token, as
    // the prompt leaves no room in its window), so a budget of $0.06 has
    // no room left beside it for a request of 10,000 bytes.
    const limited = withRules({ budgets: { user: { limit: 0.06 } } }, [
      cut,
      pricedAnswer,
    ]);
    const open = withRules({}, [cut]);
    const prompt = "word ".repeat(40_000);
    /** A request of `trigger`'s to `model`, cancelled once text came. */
    const cancelled = async (
      agent: typeof limited.agent,
      model: string,
      trigger: ReturnType<typeof newPerson>
    ) => {
      const session = await agent({
        model,
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
        await cancelled(limited.agent, workersAi, ada),
        await cancelled(open.agent, anthropic, ben),
      ];
      const held = await ledgerOf(limited.month, ada.userId);
      const after = await outcome(
        limited.call(hello({ trigger: ada, input: nextPrompt }))
      );
      const [[adas], [bens]] = [await eventsOf(ada), await eventsOf(ben)];
      const tokens = adas?.model?.inputTokens ?? 0;
      expect({
        stopped,
        held: held.spentMicros === 0 && held.reservedMicros > 58_000,
        after,
        ada: [adas?.action, adas?.detail, adas?.model?.outputTokens],
        prompt: tokens >= prompt.length / 4 && tokens < prompt.length / 4 + 200,
        ben: [bens?.action, bens?.detail, bens?.model],
      }).toMatchObject({
        stopped: ["aborted", "aborted"],
        // Its whole reservation stays held: no room for another request.
        held: true,
        after: "model.over_budget",
        ada: [
          "model.call",
          { outcome: "cancelled", errorType: "cancelled", estimated: true },
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
        (tokens * 0.293 + 3 * 2.253) / 1_000_000,
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

  it("keep an answer that breaks off midway, with no end and no count, reserved in full", async () => {
    // The stream closes after the answer's first 12 characters.
    const brokenOff = {
      text: "Hello there, how are you today?",
      inputTokens: 1000,
      outputTokens: 100,
      cut: 12,
    };
    const { agent, call, month } = withRules(
      { budgets: { user: { limit: 0.06 } } },
      [brokenOff, pricedAnswer]
    );
    const prompt = "word ".repeat(40_000);
    const ada = newPerson();
    const session = await agent({
      model: workersAi,
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
    const held = await ledgerOf(month, ada.userId);
    const after = await outcome(
      call(hello({ trigger: ada, input: nextPrompt }))
    );
    const events = await eventsOf(ada);

    expect({
      ended: [stopReason, streamed],
      held: held.spentMicros === 0 && held.reservedMicros > 58_000,
      after,
      events: events.map(({ action, detail }) => [
        action,
        detail.outcome ?? detail.reason,
      ]),
    }).toStrictEqual({
      // What came reached the caller, before the failure.
      ended: ["error", "Hello there,"],
      held: true,
      after: "model.over_budget",
      events: [
        ["model.call", "failed"],
        ["model.refused", "model.over_budget"],
      ],
    });
  });

  it("reserve a provider's retry anew, keeping the reservation of a request that failed after it may have been taken on", async () => {
    // A server error may have come after the provider took the request on:
    // its reservation stays held, and the SDK's retry reserves its own.
    const failedLate = withRules({ budgets: { user: { limit: 1 } } }, [
      { status: 500 },
      pricedAnswer,
    ]);
    // A refusal before the provider took it on costs nothing.
    const refused = withRules({ budgets: { user: { limit: 1 } } }, [
      { status: 429, errorType: "rate_limit_error" },
      pricedAnswer,
    ]);
    const ada = hello();
    const ben = hello();

    await expect(
      Promise.all([outcome(failedLate.call(ada)), outcome(refused.call(ben))])
    ).resolves.toStrictEqual(["ok", "ok"]);
    const [adas, bens] = await Promise.all([
      ledgerOf(failedLate.month, userOf(ada)),
      ledgerOf(refused.month, userOf(ben)),
    ]);
    const ids = [...requestIds(failedLate.fake), ...requestIds(refused.fake)];
    expect({
      ada: [adas.spentMicros, adas.reservedMicros > 0],
      ben: [bens.spentMicros, bens.reservedMicros],
      // Each provider request has its own ID, which the gateway's log keeps.
      ids: [
        ids.length,
        new Set(ids).size,
        ids.every((id) => z.uuid().safeParse(id).success),
      ],
    }).toStrictEqual({
      ada: [pricedMicros, true],
      ben: [pricedMicros, 0],
      ids: [4, 4, true],
    });
  });

  it("say on a call's audit event what every one of its provider requests charged or holds, a failed retry's too", async () => {
    const retried = withRules({ budgets: { user: { limit: 1 } } }, [
      { status: 500 },
      pricedAnswer,
    ]);
    // Three server errors: the SDK's two retries fail too.
    const failed = withRules({ budgets: { user: { limit: 1 } } }, [
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ]);
    const ada = hello();
    const ben = hello();

    await expect(
      Promise.all([outcome(retried.call(ada)), outcome(failed.call(ben))])
    ).resolves.toStrictEqual(["ok", "model.failed"]);
    const [adas, bens] = await Promise.all([
      ledgerOf(retried.month, userOf(ada)),
      ledgerOf(failed.month, userOf(ben)),
    ]);
    const [adaEvent] = await eventsOf(ada.trigger);
    const [benEvent] = await eventsOf(ben.trigger);
    expect({ ada: said(adaEvent), ben: said(benEvent) }).toStrictEqual({
      // The answer charged; the failed first try's reservation still held.
      ada: ["settled", 2, pricedMicros, adas.reservedMicros],
      ben: ["unknown", 3, 0, bens.reservedMicros],
    });
    expect(adas.reservedMicros > 0 && bens.reservedMicros > 0).toBeTruthy();
  });

  it("charge a prompt past a tier's threshold at that tier's prices, as its audit event counts it", async () => {
    const { call, month } = withRules({ budgets: { user: { limit: 10 } } }, [
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
      ledger: {
        key: userOf(ada),
        spentMicros: 300_000 * 5 + 2250,
        reservedMicros: 0,
      },
      audited: 300_000 * 5 + 2250,
      settled: ["settled", 1.50225],
    });
  });

  it("estimate a cancelled answer at its tier's prices, and say on its event what the ledger holds for it", async () => {
    const rest = Promise.withResolvers<boolean>();
    const { agent, month } = withRules({ budgets: { user: { limit: 10 } } }, [
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
        settled: [
          event?.detail.ledger,
          Math.round(Number(event?.detail.ledgerHeld) * 1_000_000),
        ],
      }).toStrictEqual({
        audited: true,
        settled: ["unknown", held.reservedMicros],
      });
    } finally {
      rest.resolve(true);
    }
  });

  it("hold an answer whose provider never sent its count, rather than charge it nothing", async () => {
    const { call, month } = withRules({ budgets: { user: { limit: 1 } } }, [
      { ...pricedAnswer, noUsage: true },
    ]);
    const ada = hello();

    await expect(call(ada)).resolves.toMatchObject({ text: "Hi." });
    const held = await ledgerOf(month, userOf(ada));
    expect([held.spentMicros, held.reservedMicros > 0]).toStrictEqual([
      0,
      true,
    ]);
  });

  it("hold an answer that wrote to a one-hour cache, which the catalog doesn't price", async () => {
    const { call, month } = withRules({ budgets: { user: { limit: 1 } } }, [
      { ...pricedAnswer, cacheWrite1h: 2000 },
    ]);
    const ada = hello({ model: anthropic, maxTokens: 1 });

    await expect(call(ada)).resolves.toMatchObject({ text: "Hi." });
    const held = await ledgerOf(month, userOf(ada));
    expect([held.spentMicros, held.reservedMicros > 0]).toStrictEqual([
      0,
      true,
    ]);
  });

  it("settle an answered request at what it used even when its audit event can't be stored", async () => {
    const database: D1Database = env.DB;
    const { call, month } = withRules(
      { budgets: { user: { limit: 1 } } },
      [pricedAnswer],
      {
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
      }
    );
    const ada = hello();

    await expect(call(ada)).resolves.toMatchObject({ text: "Hi." });
    await expect(ledgerOf(month, userOf(ada))).resolves.toStrictEqual({
      key: userOf(ada),
      spentMicros: pricedMicros,
      reservedMicros: 0,
    });
  });

  it("admit a long Claude transcript under a budget, its bytes far past 200K but its tokens not", async () => {
    // 250 KB of short words: some 62,500 tokens, so well within standard
    // prices, though its bytes bound it past the long-context threshold.
    const { call } = withRules({ budgets: { user: { limit: 10 } } }, [
      pricedAnswer,
    ]);
    const ada = hello({
      model: anthropic,
      maxTokens: undefined,
      input: "Hi. ".repeat(62_500),
    });

    await expect(outcome(call(ada))).resolves.toBe("ok");
  });

  it("charge a Claude Sonnet 4.5 prompt past 200K tokens at Anthropic's long-context prices, as its audit event counts it", async () => {
    const { call, month } = withRules({ budgets: { user: { limit: 10 } } }, [
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
      ledger: {
        key: userOf(ada),
        spentMicros: 250_000 * 6 + 2250,
        reservedMicros: 0,
      },
      audited: 250_000 * 6 + 2250,
    });
  });

  it("send no request whose content its bytes can't bound, such as an image", async () => {
    const { fake, agent } = withRules({}, [pricedAnswer]);
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
    const { fake, call } = withRules(
      { budgets: { user: { limit: 1 } } },
      [pricedAnswer],
      { MODEL_LEDGER: failingLedger("admit") }
    );
    // Without a budget too: no request goes unaccounted for.
    const unbudgeted = withRules({}, [pricedAnswer], {
      MODEL_LEDGER: failingLedger("admit"),
    });
    const ada = hello();

    await expect(call(ada)).rejects.toMatchObject({
      code: "model.ledger_unavailable",
      message:
        "Model spend can't be accounted for right now, so no model call was made. Try again later.",
    });
    await expect(outcome(unbudgeted.call(hello()))).resolves.toBe(
      "model.ledger_unavailable"
    );
    expect([...fake.requests, ...unbudgeted.fake.requests]).toStrictEqual([]);
    await expect(eventsOf(ada.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        detail: { reason: "model.ledger_unavailable" },
      },
    ]);
  });

  it("keep a paid answer when its settlement can't be stored, and its reservation held in full", async () => {
    const { call, month } = withRules(
      { budgets: { user: { limit: 1 } } },
      [pricedAnswer],
      { MODEL_LEDGER: failingLedger("settle") }
    );
    const ada = hello();

    await expect(call(ada)).resolves.toMatchObject({ text: "Hi." });
    const held = await ledgerOf(month, userOf(ada));
    expect([
      held.spentMicros,
      held.reservedMicros > pricedMicros,
    ]).toStrictEqual([0, true]);
  });

  it("alert admins once for every limit lowered below what was spent, and count each month on its own", async () => {
    const spend = withRules(
      { budgets: { user: { limit: 0.2 }, deployment: { limit: 1000 } } },
      times(3, dearAnswer)
    );
    const ada = hello();
    const lowered = withRules(
      { budgets: { user: { limit: 0.05 }, deployment: { limit: 0.05 } } },
      [],
      { MODEL_BUDGET_MONTH: spend.month }
    );
    const nextMonth = withRules({ budgets: { user: { limit: 0.05 } } }, [
      dearAnswer,
    ]);

    // $0.0886: under the first limit, over the lowered one.
    await expect(
      inTurn([
        async () => await spend.call(ada),
        async () => await spend.call(ada),
        async () => await spend.call(ada),
        async () => await lowered.call(ada),
        async () => await lowered.call(ada),
        async () => await nextMonth.call(ada),
      ])
    ).resolves.toStrictEqual([
      "ok",
      "ok",
      "ok",
      "model.over_budget",
      "model.over_budget",
      "ok",
    ]);
    const events = await eventsOf(ada.trigger);
    // The deployment's spend counts every test's calls this month, so only
    // the person's is certain; both alerted, once each.
    expect(
      events
        .filter(({ action }) => action === "model.budget.exhausted")
        .map(({ detail }) => [detail.scope, detail.period, detail.threshold])
        .toSorted((one, other) => byText(String(one[0]), String(other[0])))
    ).toStrictEqual([
      ["deployment", spend.month, 0.05],
      ["user", spend.month, 0.05],
    ]);
  });

  it("alert admins once when the alert threshold is lowered below what was spent", async () => {
    const early = withRules(
      { budgets: { user: { limit: 0.2, alertAt: 90 } } },
      times(3, dearAnswer)
    );
    const lowered = withRules(
      { budgets: { user: { limit: 0.2, alertAt: 40 } } },
      times(2, dearAnswer),
      { MODEL_BUDGET_MONTH: early.month }
    );
    const ada = hello();

    // $0.0886 spent, under 90% of $0.20; then 40% is $0.08, already passed.
    await expect(
      inTurn([
        async () => await early.call(ada),
        async () => await early.call(ada),
        async () => await early.call(ada),
        async () => await lowered.call(ada),
        async () => await lowered.call(ada),
      ])
    ).resolves.toStrictEqual(["ok", "ok", "ok", "ok", "ok"]);
    const events = await eventsOf(ada.trigger);
    expect(
      events.filter(({ action }) => action === "model.budget.alert")
    ).toMatchObject([
      {
        detail: { scope: "user", period: early.month, threshold: 0.08 },
      },
    ]);
  });

  it("admit a call's retry on its own: an attempt that used the budget up stops the call before anything more is sent", async () => {
    const { fake, call } = withRules(
      { budgets: { user: { limit: 0.04 } } },
      // An answer that doesn't fit, and costs $0.0442: past the limit, so
      // the retry has no room left, however little it may cost.
      [{ text: "No JSON here.", inputTokens: 150_000, outputTokens: 100 }]
    );
    const ada = hello({ maxTokens: undefined });

    await expect(
      outcome(call({ ...ada, schema: z.object({ total: z.number() }) }))
    ).resolves.toBe("model.over_budget");
    expect(fake.requests).toHaveLength(1);
    const events = await eventsOf(ada.trigger);
    // The ledger's alerts and the gateway's events reach the log apart.
    expect(events.map(({ action }) => action).toSorted()).toStrictEqual([
      "model.budget.alert",
      "model.budget.exhausted",
      "model.call",
      "model.refused",
    ]);
  });

  it("alert once per limit value a month, however the limit changes back and forth", async () => {
    const month = newMonth();
    const withLimit = (limit: number, replies: GatewayReply[] = []) =>
      withRules({ budgets: { user: { limit } } }, replies, {
        MODEL_BUDGET_MONTH: month,
      }).call;
    const ada = hello();
    const spend = withLimit(0.3, times(3, dearAnswer));

    // $0.0886 spent under $0.30; then $0.07, $0.06 and $0.07 again.
    await expect(
      inTurn([
        async () => await spend(ada),
        async () => await spend(ada),
        async () => await spend(ada),
        async () => await withLimit(0.07)(ada),
        async () => await withLimit(0.06)(ada),
        async () => await withLimit(0.07)(ada),
      ])
    ).resolves.toStrictEqual([
      "ok",
      "ok",
      "ok",
      "model.over_budget",
      "model.over_budget",
      "model.over_budget",
    ]);
    const events = await eventsOf(ada.trigger);
    expect(
      events
        .filter(({ action }) => action === "model.budget.exhausted")
        .map(({ detail }) => detail.threshold)
    ).toStrictEqual([0.07, 0.06]);
  });

  it("admit and count a retry in the month it is sent in, when the month turns between attempts", async () => {
    const [before, after] = [newMonth(), newMonth()];
    const dearer = { ...dearAnswer, inputTokens: 150_000 };
    const fake = fakeGateway(
      dearAnswer,
      dearAnswer,
      { ...dearer, text: "No JSON here." },
      { ...dearer, text: '{ "total": 1 }' }
    );
    const turningEnv: ModelsEnv = {
      ...env,
      AI: fake.binding,
      MODEL_GATEWAY: {
        gateway,
        models: allowed,
        budgets: { user: { limit: 0.1, alertAt: 40 } },
      },
      // The month turns once the call's first attempt was sent.
      get MODEL_BUDGET_MONTH() {
        return fake.requests.length < 3 ? before : after;
      },
    };
    const ada = hello();
    const call = async (more: Partial<ModelCall<undefined>> = {}) =>
      await outcome(models(turningEnv).call({ ...ada, ...more }));

    // $0.059 of the old month's $0.10.
    await expect(Promise.all([call(), call()])).resolves.toStrictEqual([
      "ok",
      "ok",
    ]);
    // Its first attempt uses the old month up; its retry is in the new one.
    await expect(
      outcome(
        models(turningEnv).call({
          ...ada,
          schema: z.object({ total: z.number() }),
        })
      )
    ).resolves.toBe("ok");
    const events = await eventsOf(ada.trigger);
    expect(
      events
        .filter(({ action }) => action.startsWith("model.budget."))
        .map(({ action, detail }) => [action, detail.period])
    ).toStrictEqual([
      ["model.budget.alert", before],
      ["model.budget.exhausted", before],
      ["model.budget.alert", after],
    ]);
  });

  it("give every provider request of a call the call's own cut-off as its deadline, a second ask's too, never a whole timeout from when it is sent", async () => {
    const timeoutMs = 60_000;
    const release = Promise.withResolvers<boolean>();
    const { fake, call } = withRules({}, [
      // The first answer takes its time, and doesn't fit: asked again.
      {
        ...pricedAnswer,
        text: "No JSON here.",
        pause: { at: 2, until: release.promise },
      },
      { ...pricedAnswer, text: '{ "total": 1 }' },
    ]);
    const started = Date.now();
    const asking = outcome(
      call({ ...hello(), schema: z.object({ total: z.number() }), timeoutMs })
    );
    await scheduler.wait(1500);
    release.resolve(true);
    const answered = await asking;
    const ids = requestIds(fake).map(String);
    const deadlines = await runInDurableObject(
      modelLedger(env),
      (_instance, state) =>
        ids.map(
          (id) =>
            state.storage.sql
              .exec<{ deadline: number }>(
                "SELECT deadline FROM requests WHERE id = ?",
                id
              )
              .one().deadline
        )
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
    const { call } = withRules(
      { budgets: { workflow: { limit: 0.07 } } },
      times(5, dearAnswer)
    );
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
    const { call: anyone } = withRules(
      { budgets: { deployment: { limit: 0.07 } } },
      times(3, dearAnswer)
    );

    // A new run each time: the workflow's budget counts all of its runs.
    const steps = await inTurn(
      Array.from({ length: 4 }, () => async () => await step("invoices"))
    );
    // A new person each time: the deployment's budget counts them all, in
    // this test's month.
    const people = await inTurn(
      Array.from({ length: 4 }, () => async () => await anyone(hello()))
    );

    expect({
      steps,
      people,
      orders: await outcome(step("orders")),
    }).toStrictEqual({
      steps: ["ok", "ok", "ok", "model.over_budget"],
      people: ["ok", "ok", "ok", "model.over_budget"],
      orders: "ok",
    });
  });
});

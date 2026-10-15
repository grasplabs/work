import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { appIdSchema } from "@grasp-os/shared/ids";
import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import type { ModelShares } from "../src/model-admission.ts";
import { modelLedger } from "../src/model-ledger.ts";
import type { Admission } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import type { ModelCall, ModelsEnv } from "../src/models.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import { finished } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import {
  appWith as serverAppWith,
  bindModel,
  modelRegistration,
  workflowFiles,
} from "./workflow-apps.ts";

// Fair admission of model requests (model-admission.ts): the client's
// provider requests in flight at once, in all, for one person and of one
// App, each held to its share in the deployment's quota policy, in the
// model ledger's one transaction with every budget; the calls waiting for
// a share keep places in its queue, served by turn and first come, first
// served, never behind a share that is full. AI Gateway is the outside
// system: a fake behind the AI binding. The ledger, the policy and the
// audit log are real. Where a test needs a request in flight that nobody
// will settle (its isolate died), it admits one in the ledger as the
// gateway would and walks away.

const idp = mockIdp();

const workersAi = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const sonnet = "anthropic/claude-sonnet-4-5";
const gateway = "grasp-os-test";

/**
 * The tests' policy: three requests in flight for the whole client, and
 * three asked for each person and each App, which the gateway holds to two
 * each, one less than the client's, so one person or one App always leaves
 * room (`modelSharesOf`); and two places in the queue for each person.
 */
const policy = {
  generation: 2,
  limits: {
    ...quotaLimitsSchema.parse(env.QUOTA_LIMITS).limits,
    modelClientRequests: 3,
    modelPersonRequests: 3,
    modelAppRequests: 3,
    modelQueuedPerPerson: 2,
  },
};

/** An answer that streams its first characters, then waits for `until`. */
const paused = (until: Promise<unknown>): GatewayReply => ({
  text: "Hello there.",
  inputTokens: 10,
  outputTokens: 5,
  pause: { at: 3, until },
});

const answered: GatewayReply = {
  text: "Hi.",
  inputTokens: 10,
  outputTokens: 5,
};

/** Core's env with the fake gateway answering with `replies`, under the tests' policy. */
const gatewayWith = (
  replies: GatewayReply[],
  more: Partial<ModelsEnv> = {}
) => {
  const fake = fakeGateway(...replies);
  const coreEnv: ModelsEnv = {
    ...env,
    AI: fake.binding,
    MODEL_GATEWAY: { gateway, models: [workersAi] },
    QUOTA_LIMITS: policy,
    ...more,
  };
  return { fake, call: models(coreEnv).call, agent: models(coreEnv).agent };
};

/** Apps the tests' calls are made in, each by its own builder. */
const apps: { appId: string; userId: string }[] = [];

/** A person no other test uses. */
const newPerson = () =>
  ({ type: "person", userId: `person-${crypto.randomUUID()}` }) as const;

/** A call by `userId` in App `app` (an index of `apps`). */
const callBy = (
  userId: string,
  app: number,
  more: Partial<ModelCall<undefined>> = {}
): ModelCall<undefined> => {
  const made = apps[app];
  if (made === undefined) {
    throw new Error("The tests' Apps aren't made yet");
  }
  const appId = appIdSchema.parse(made.appId);
  return {
    model: workersAi,
    maxTokens: 100,
    input: "Hello.",
    purpose: "chat.turn",
    trigger: { type: "person", userId },
    work: {
      authority: {
        subject: { type: "app", appId },
        onBehalfOf: userId,
        mode: "interactive",
        appVersion: 1,
      },
      context: { type: "app", appId },
    },
    ...more,
  };
};

/** Waits until `ready` holds, looking again every few milliseconds. */
const until = async (ready: () => boolean | Promise<boolean>) => {
  // oxlint-disable-next-line no-await-in-loop -- until it holds
  while (!(await ready())) {
    // oxlint-disable-next-line no-await-in-loop -- until it holds
    await scheduler.wait(10);
  }
};

/** `"waiting"` once `ms` went by: what a call still under way is then. */
const stillWaiting = async (ms: number): Promise<string> => {
  await scheduler.wait(ms);
  return "waiting";
};

/** What a refused call was told: its code and details. */
const toldBy = async (refused: Promise<unknown>) => {
  const caught = await refused.then(
    () => "admitted",
    (error: unknown) => error
  );
  return z
    .object({
      code: z.string(),
      details: z.record(z.string(), z.unknown()).default({}),
    })
    .parse(caught);
};

/** Where a call stands each time the gateway tells it, in order. */
const queueOf = () => {
  const seen: (string | null)[] = [];
  return {
    seen,
    onQueued: async (queued: { waitingFor: string } | null) => {
      seen.push(queued?.waitingFor ?? null);
      await Promise.resolve();
    },
  };
};

/** A ledger no other test uses. */
const newLedger = () => env.MODEL_LEDGER.getByName(crypto.randomUUID());

/** Shares of three in all and two for a person and an App. */
const shares: ModelShares = {
  client: 3,
  person: 2,
  app: 2,
  queuedPerPerson: 2,
  queuedPerApp: 3,
};

/** A request of `subject` in App `resource`, its call's place `place`. */
const request = (
  subject: string,
  resource: string | null,
  place: string = crypto.randomUUID()
): Admission => {
  const deadline = Date.now() + 60_000;
  return {
    id: crypto.randomUUID(),
    period: "2400-01",
    scopes: [
      {
        scope: "deployment",
        key: "deployment",
        limitMicros: null,
        alertMicros: null,
        names: {},
      },
    ],
    model: workersAi,
    price: {
      version: "test",
      input: 1,
      output: 1,
      cacheRead: 1,
      cacheWrite: 1,
    },
    reservedMicros: 1,
    actor: { type: "person", userId: subject },
    deadline,
    reconcileAt: deadline + 60_000,
    fair: { place, subject, resource, shares },
  };
};

/** What the ledger answered: admitted, or the share a refusal waits for. */
const answer = async (
  ledger: ReturnType<typeof newLedger>,
  admission: Admission
): Promise<string> => {
  const admitted = await ledger.admit(admission);
  if (admitted.ok) {
    return "admitted";
  }
  return "queued" in admitted
    ? `queued:${admitted.queued.waitingFor}:${admitted.queued.placed ? "placed" : "unplaced"}`
    : JSON.stringify(admitted);
};

/**
 * One request in flight for the whole client, and places enough for a
 * person and an App that only the client's cap binds: eight backlog
 * places (`placesPerClientShare`).
 */
const tightShares: ModelShares = {
  client: 1,
  person: 1,
  app: 1,
  queuedPerPerson: 10,
  queuedPerApp: 5,
};

/** A request of `subject` in App `resource` under {@link tightShares}. */
const tight = (subject: string, resource: string): Admission => {
  const made = request(subject, resource);
  return { ...made, fair: { ...made.fair, shares: tightShares } };
};

/**
 * A ledger whose one share Zed holds, while Ada in one App and Ben in
 * another each keep five places waiting: their first and four backlog
 * places each, all eight of the client's backlog places.
 */
const saturated = async () => {
  const ledger = newLedger();
  const zed = tight("zed", "app-z");
  await answer(ledger, zed);
  const placed: Record<string, Admission[]> = { ada: [], ben: [] };
  for (const [subject, app] of [
    ["ada", "app-a"],
    ["ben", "app-b"],
  ] as const) {
    for (const _ of [1, 2, 3, 4, 5]) {
      const waiting = tight(subject, app);
      // oxlint-disable-next-line no-await-in-loop -- in order
      await scheduler.wait(2);
      // oxlint-disable-next-line no-await-in-loop -- in order
      await answer(ledger, waiting);
      placed[subject]?.push(waiting);
    }
  }
  const [ada, adaSecond] = placed.ada ?? [];
  const [ben] = placed.ben ?? [];
  if (ada === undefined || adaSecond === undefined || ben === undefined) {
    throw new Error("The places weren't kept");
  }
  return { ledger, firstOf: { zed, ada, adaSecond, ben } };
};

describe("fair model admission", { timeout: 60_000 }, () => {
  // After the identity provider's mock is in place, which each test sets.
  beforeEach(async () => {
    if (apps.length > 0) {
      return;
    }
    for (const name of ["Inbox", "Reports", "Planner"]) {
      // oxlint-disable-next-line no-await-in-loop -- one App after another
      const builder = await signedInApi(idp, "builder");
      // oxlint-disable-next-line no-await-in-loop -- one App after another
      const { id } = await builder.api.apps.create({ name });
      apps.push({ appId: id, userId: builder.userId });
    }
  });

  it("leaves room for another App and another person while one App's burst waits its turn", async () => {
    const release = Promise.withResolvers<boolean>();
    const { fake, call } = gatewayWith([
      paused(release.promise),
      paused(release.promise),
      answered,
      answered,
    ]);
    const ada = newPerson().userId;
    const ben = newPerson().userId;
    const queue = queueOf();
    // Three of Ada's calls in the Inbox at once: its share is two.
    const burst = [
      outcome(call(callBy(ada, 0))),
      outcome(call(callBy(ada, 0))),
    ];
    await until(() => fake.requests.length === 2);
    const third = outcome(call(callBy(ada, 0, { onQueued: queue.onQueued })));
    await until(() => queue.seen.length > 0);
    // Ben, in another App, goes ahead at once: the Inbox left room.
    const other = await outcome(call(callBy(ben, 1)));
    const whileBursting = {
      other,
      third: await Promise.race([third, stillWaiting(50)]),
      sent: fake.requests.length,
    };
    release.resolve(true);

    expect({
      whileBursting,
      waitedFor: queue.seen[0],
      burst: await Promise.all([...burst, third]),
      lastTold: queue.seen.at(-1),
    }).toStrictEqual({
      whileBursting: { other: "ok", third: "waiting", sent: 3 },
      waitedFor: "app",
      burst: ["ok", "ok", "ok"],
      // Told it stopped waiting once its turn came.
      lastTold: null,
    });
  });

  it("holds one person to their share across Apps, and leaves room for someone else", async () => {
    const release = Promise.withResolvers<boolean>();
    const { fake, call } = gatewayWith([
      paused(release.promise),
      paused(release.promise),
      answered,
      answered,
    ]);
    const ada = newPerson().userId;
    const ben = newPerson().userId;
    const queue = queueOf();
    const two = [outcome(call(callBy(ada, 0))), outcome(call(callBy(ada, 1)))];
    await until(() => fake.requests.length === 2);
    const third = outcome(call(callBy(ada, 2, { onQueued: queue.onQueued })));
    await until(() => queue.seen.length > 0);
    const someoneElse = await outcome(call(callBy(ben, 0)));
    const waiting = await Promise.race([third, stillWaiting(50)]);
    release.resolve(true);

    expect({
      someoneElse,
      waiting,
      waitedFor: queue.seen[0],
      all: await Promise.all([...two, third]),
    }).toStrictEqual({
      someoneElse: "ok",
      waiting: "waiting",
      waitedFor: "person",
      all: ["ok", "ok", "ok"],
    });
  });

  it("tells queued, rate-limited and budget-exhausted apart, each with a wait core computed", async () => {
    const release = Promise.withResolvers<boolean>();
    const { fake, call } = gatewayWith([
      paused(release.promise),
      paused(release.promise),
      // Refused for its rate, retries and all, the provider asking for two
      // hours: core holds it to its own bound.
      ...Array.from({ length: 3 }, () => ({
        status: 429,
        errorType: "rate_limit_error",
        headers: { "retry-after": "7200" },
      })),
    ]);
    const ada = newPerson().userId;
    const busy = [outcome(call(callBy(ada, 0))), outcome(call(callBy(ada, 0)))];
    await until(() => fake.requests.length === 2);
    // The Inbox's share is full: a call with two seconds waits one, then
    // is told so.
    const queued = await toldBy(call(callBy(ada, 0, { timeoutMs: 2000 })));
    // Ben's call reaches the provider, which turns it away for its rate.
    const rateLimited = await toldBy(call(callBy(newPerson().userId, 1)));
    // A budget used up for good is told so even while Ada's share is
    // full: no wait for a share helps it, so it takes no place.
    // Sonnet 4.5 reserves some $0.56: past a cent, for good this month.
    const exhausted = gatewayWith([], {
      MODEL_GATEWAY: {
        gateway,
        models: [workersAi, sonnet],
        budgets: { user: { limit: 0.01 } },
      },
      MODEL_BUDGET_MONTH: "2310-01",
    });
    const usedUp = await toldBy(
      exhausted.call(callBy(ada, 0, { model: sonnet, maxTokens: undefined }))
    );
    release.resolve(true);
    await Promise.all(busy);

    expect({ queued, rateLimited, usedUp }).toStrictEqual({
      queued: {
        code: "model.queued",
        details: {
          model: workersAi,
          because: "app",
          waitingFor: "app",
          retryAfterSeconds: queued.details.retryAfterSeconds,
        },
      },
      rateLimited: {
        code: "model.rate_limited",
        details: { model: workersAi, retryAfterSeconds: 60 },
      },
      usedUp: {
        code: "model.over_budget",
        details: {
          model: sonnet,
          because: "user",
          retryAfterSeconds: usedUp.details.retryAfterSeconds,
        },
      },
    });
    expect(Number(queued.details.retryAfterSeconds)).toBeLessThanOrEqual(5);
    expect(Number(usedUp.details.retryAfterSeconds)).toBeGreaterThan(0);
  });

  it("gives a cancelled request's share back at once, not at its deadline", async () => {
    const release = Promise.withResolvers<boolean>();
    const { fake, call, agent } = gatewayWith([
      paused(release.promise),
      paused(release.promise),
      answered,
    ]);
    const ada = newPerson().userId;
    const made = callBy(ada, 0);
    // An agent turn whose person goes away mid-answer: its deadline is
    // three minutes off.
    const session = await agent({
      model: made.model,
      purpose: "chat.turn",
      trigger: made.trigger,
      work: made.work,
    });
    const cancel = new AbortController();
    const turn = session
      .stream(
        session.model,
        normalizeContext({
          messages: [{ role: "user", content: "Hi.", timestamp: Date.now() }],
        }),
        { signal: cancel.signal }
      )
      .result();
    await until(() => fake.requests.length === 1);
    const other = outcome(call(made));
    await until(() => fake.requests.length === 2);
    const queue = queueOf();
    const third = outcome(call(callBy(ada, 0, { onQueued: queue.onQueued })));
    await until(() => queue.seen.length > 0);
    cancel.abort();
    // Admitted on its next ask, seconds away, not three minutes.
    const admittedSoon = await Promise.race([third, stillWaiting(10_000)]);
    release.resolve(true);
    const ended = await turn;

    expect({
      admittedSoon,
      turn: ended.stopReason,
      other: await other,
    }).toStrictEqual({ admittedSoon: "ok", turn: "aborted", other: "ok" });
  });

  it("gives a request's share back once its lease ends, when nobody settles it", async () => {
    const { call } = gatewayWith([answered]);
    const ada = newPerson().userId;
    const appId = apps[0]?.appId ?? "";
    // Two requests in flight whose isolate died: nobody settles them, and
    // their call's deadline is two seconds off.
    const deadline = Date.now() + 2000;
    const leaked = (): Admission => ({
      id: crypto.randomUUID(),
      period: "2311-01",
      scopes: [
        {
          scope: "deployment",
          key: "deployment",
          limitMicros: null,
          alertMicros: null,
          names: {},
        },
      ],
      model: workersAi,
      price: {
        version: "test",
        input: 1,
        output: 1,
        cacheRead: 1,
        cacheWrite: 1,
      },
      reservedMicros: 1,
      actor: { type: "person", userId: ada },
      deadline,
      reconcileAt: deadline + 60_000,
      fair: {
        place: crypto.randomUUID(),
        subject: ada,
        resource: appId,
        shares: {
          client: 3,
          person: 2,
          app: 2,
          queuedPerPerson: 32,
          queuedPerApp: 64,
        },
      },
    });
    const ledger = modelLedger(env);
    await ledger.admit(leaked());
    await ledger.admit(leaked());
    const queue = queueOf();

    const admitted = await outcome(
      call(callBy(ada, 0, { onQueued: queue.onQueued, timeoutMs: 20_000 }))
    );

    expect({
      admitted,
      waited: queue.seen[0],
      afterTheLease: Date.now() >= deadline,
    }).toStrictEqual({ admitted: "ok", waited: "app", afterTheLease: true });
  });

  it("tells a call given no place that it is queued at once, without waiting", async () => {
    const release = Promise.withResolvers<boolean>();
    const { fake, call } = gatewayWith([
      paused(release.promise),
      paused(release.promise),
      ...Array.from({ length: 2 }, () => answered),
    ]);
    const ada = newPerson().userId;
    const running = [
      outcome(call(callBy(ada, 0))),
      outcome(call(callBy(ada, 0))),
    ];
    await until(() => fake.requests.length === 2);
    // Ada's two places taken by calls that wait.
    const placed = [queueOf(), queueOf()];
    const waiting = placed.map(
      async ({ onQueued }) => await outcome(call(callBy(ada, 0, { onQueued })))
    );
    await until(() => placed.every(({ seen }) => seen.length > 0));
    const unplaced = queueOf();
    const told = await Promise.race([
      outcome(call(callBy(ada, 0, { onQueued: unplaced.onQueued }))),
      stillWaiting(3000),
    ]);
    release.resolve(true);

    expect({
      told,
      waitedAtAll: unplaced.seen,
      others: await Promise.all([...running, ...waiting]),
    }).toStrictEqual({
      told: "model.queued",
      waitedAtAll: [],
      others: ["ok", "ok", "ok", "ok"],
    });
  });

  it("stops a cancelled call's wait at once, asking for a share no more", async () => {
    const release = Promise.withResolvers<boolean>();
    const { fake, call } = gatewayWith([
      paused(release.promise),
      paused(release.promise),
    ]);
    const ada = newPerson().userId;
    const busy = [outcome(call(callBy(ada, 0))), outcome(call(callBy(ada, 0)))];
    await until(() => fake.requests.length === 2);
    const queue = queueOf();
    const cancel = new AbortController();
    const waiting = outcome(
      call(callBy(ada, 0, { onQueued: queue.onQueued, signal: cancel.signal }))
    );
    await until(() => queue.seen.length > 0);
    const before = queue.seen.length;
    cancel.abort();
    const told = await Promise.race([waiting, stillWaiting(3000)]);
    release.resolve(true);
    await Promise.all(busy);

    // Told once that it stopped waiting, and nothing else after.
    expect({ told, after: queue.seen.slice(before) }).toStrictEqual({
      told: "model.queued",
      after: [null],
    });
  });

  it("gives a guest a share and places of its own, never the member's who invited them", async () => {
    const release = Promise.withResolvers<boolean>();
    const { fake, call } = gatewayWith([
      paused(release.promise),
      paused(release.promise),
      ...Array.from({ length: 4 }, () => answered),
    ]);
    const ada = newPerson().userId;
    const chatId = `chat-${crypto.randomUUID()}`;
    const asGuest = (more: Partial<ModelCall<undefined>> = {}) =>
      callBy(ada, 0, {
        trigger: {
          type: "guest",
          chatId,
          appId: appIdSchema.parse(apps[0]?.appId),
          invitedBy: ada,
        },
        ...more,
      });
    // The guest's chat runs two at once, and keeps two more waiting: all
    // its share, and all the places a person may have.
    const guestRunning = [outcome(call(asGuest())), outcome(call(asGuest()))];
    await until(() => fake.requests.length === 2);
    const guestQueues = [queueOf(), queueOf()];
    const guestWaiting = guestQueues.map(
      async ({ onQueued }) => await outcome(call(asGuest({ onQueued })))
    );
    await until(() => guestQueues.every(({ seen }) => seen.length > 0));
    // Ada's own call in another App goes ahead at once: her share is hers.
    const adaElsewhere = await outcome(call(callBy(ada, 1)));
    // Her call in the guest's App waits for that App, with a place of her
    // own: the guest's places aren't hers.
    const adaQueue = queueOf();
    const adaWaiting = outcome(
      call(callBy(ada, 0, { onQueued: adaQueue.onQueued }))
    );
    await until(() => adaQueue.seen.length > 0);
    release.resolve(true);

    expect({
      adaElsewhere,
      adaWaitedFor: adaQueue.seen[0],
      guestWaitedFor: guestQueues.map(({ seen }) => seen[0]),
      all: await Promise.all([...guestRunning, ...guestWaiting, adaWaiting]),
    }).toStrictEqual({
      adaElsewhere: "ok",
      adaWaitedFor: "app",
      guestWaitedFor: ["app", "app"],
      all: ["ok", "ok", "ok", "ok", "ok"],
    });
  });

  it("tells a guest neither whose share is full nor a wait from its leases", async () => {
    const { call } = gatewayWith([]);
    const ada = newPerson().userId;
    const chatId = `chat-${crypto.randomUUID()}`;
    // Two requests of the guest's chat in flight elsewhere, ending in
    // three seconds: its own share is full, the App's isn't.
    const deadline = Date.now() + 3000;
    const ledger = modelLedger(env);
    for (const _ of [1, 2]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await ledger.admit({
        ...request(`guest:${chatId}`, "elsewhere"),
        deadline,
        reconcileAt: deadline + 60_000,
        fair: {
          place: crypto.randomUUID(),
          subject: `guest:${chatId}`,
          resource: "elsewhere",
          shares: { ...shares, queuedPerPerson: 32, queuedPerApp: 64 },
        },
      });
    }
    const told = await toldBy(
      call(
        callBy(ada, 0, {
          timeoutMs: 2000,
          trigger: {
            type: "guest",
            chatId,
            appId: appIdSchema.parse(apps[0]?.appId),
            invitedBy: ada,
          },
        })
      )
    );

    expect(told).toStrictEqual({
      code: "model.queued",
      details: {
        model: workersAi,
        because: "client",
        waitingFor: "client",
        retryAfterSeconds: 5,
      },
    });
  });

  it("shows a run queued while its step's model call waits for its App's share, and goes on once it has one", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await serverAppWith(builder, {
      ...modelRegistration({ reader: 6000 }),
      ...workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    binding: "reader",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
  });`,
        { extract: { total: 1234 } }
      ),
    });
    await bindModel(app, "reader", workersAi);
    const release = Promise.withResolvers<boolean>();
    const fake = fakeGateway(paused(release.promise), paused(release.promise), {
      text: '{ "total": 1234 }',
      inputTokens: 10,
      outputTokens: 5,
    });
    // The runs the dispatcher runs use core's own env.
    const ai: AiBinding = env.AI;
    const sending = vi
      .spyOn(ai, "fetch")
      .mockImplementation(fake.binding.fetch);
    const before = { gateway: env.MODEL_GATEWAY, quotas: env.QUOTA_LIMITS };
    env.MODEL_GATEWAY = { gateway, models: [workersAi] };
    env.QUOTA_LIMITS = policy;
    try {
      // Two calls of the App, for others, fill its share.
      const appId = appIdSchema.parse(app);
      const holding = [newPerson(), newPerson()].map(
        async (trigger) =>
          await outcome(
            models(env).call({
              model: workersAi,
              maxTokens: 100,
              input: "Hello.",
              purpose: "chat.turn",
              trigger,
              work: {
                authority: {
                  subject: { type: "app", appId },
                  onBehalfOf: trigger.userId,
                  mode: "interactive",
                  appVersion: 1,
                },
                context: { type: "app", appId },
              },
            })
          )
      );
      await until(() => fake.requests.length === 2);
      const run = await builder.api.workflows.start(app, "reader");
      const summary = async () =>
        await builder.api.screens.summary(app, run.id);
      await until(async () => {
        const now = await summary();
        return now.status === "queued";
      });
      const queued = await summary();
      release.resolve(true);
      await finished(run.id);
      const done = await summary();

      expect({
        queued: [queued.status, queued.queued?.waitingFor],
        retryAt: (queued.queued?.retryAt ?? 0) > Date.now() - 60_000,
        done: [done.status, done.queued],
        holding: await Promise.all(holding),
      }).toStrictEqual({
        queued: ["queued", "app"],
        retryAt: true,
        done: ["completed", undefined],
        holding: ["ok", "ok"],
      });
    } finally {
      release.resolve(true);
      env.MODEL_GATEWAY = before.gateway;
      env.QUOTA_LIMITS = before.quotas;
      sending.mockRestore();
    }
  });
});

describe("the model ledger's queue", () => {
  it("takes one lease for a request admitted twice under the same ID", async () => {
    const ledger = newLedger();
    const once = request("ada", "inbox");
    const outcomes = [
      await answer(ledger, once),
      // The same admission again, its answer lost: no second lease.
      await answer(ledger, once),
      await answer(ledger, request("ada", "reports")),
      await answer(ledger, request("ada", "planner")),
    ];

    expect(outcomes).toStrictEqual([
      "admitted",
      "admitted",
      "admitted",
      "queued:person:placed",
    ]);
  });

  it("serves the waiting in order, passing over one whose App is full, and lets no newcomer jump it", async () => {
    const ledger = newLedger();
    const inbox = [request("ada", "inbox"), request("ben", "inbox")];
    const held = await Promise.all(
      inbox.map(async (admission) => await answer(ledger, admission))
    );
    // Cid waits for the Inbox; Dan, behind him in another App, isn't held
    // up by it.
    const cid = request("cid", "inbox");
    const cidWaits = await answer(ledger, cid);
    const reports = request("dan", "reports");
    const dan = await answer(ledger, reports);
    // The client's three are taken: Eve waits, then Fay behind her.
    const eve = request("eve", "planner");
    const fay = request("fay", "planner-2");
    await scheduler.wait(5);
    const eveWaits = await answer(ledger, eve);
    await scheduler.wait(5);
    const fayWaits = await answer(ledger, fay);
    // Dan's request ends: one share comes free, which Cid, still held by
    // the full Inbox, can't take. Fay asks first, and is still behind Eve;
    // Eve takes it.
    await ledger.settle(reports.id, { by: "refused" });
    const fayFirst = await answer(ledger, { ...fay, id: crypto.randomUUID() });
    const eveNext = await answer(ledger, { ...eve, id: crypto.randomUUID() });

    expect({
      held,
      cidWaits,
      dan,
      eveWaits,
      fayWaits,
      fayFirst,
      eveNext,
    }).toStrictEqual({
      held: ["admitted", "admitted"],
      cidWaits: "queued:app:placed",
      dan: "admitted",
      eveWaits: "queued:client:placed",
      fayWaits: "queued:client:placed",
      fayFirst: "queued:client:placed",
      eveNext: "admitted",
    });
  });

  it("drops the place of a call that stopped asking, so it holds no one back", async () => {
    const ledger = newLedger();
    for (const subject of ["ada", "ben", "cid"]) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await answer(ledger, request(subject, `app-${subject}`));
    }
    const gone = request("dan", "app-dan");
    const waits = await answer(ledger, gone);
    const next = request("eve", "app-eve");
    await scheduler.wait(5);
    await answer(ledger, next);
    // A share comes free (Ada's request's usage lost: it ended); Dan's call
    // died, and asked no more for longer than a place lasts.
    await runInDurableObject(ledger, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE requests SET state = 'unknown' WHERE subject = 'ada'"
      );
      state.storage.sql.exec(
        "UPDATE queue SET seen_at = seen_at - 91000 WHERE place = ?",
        gone.fair.place
      );
    });
    const eve = await answer(ledger, { ...next, id: crypto.randomUUID() });

    expect({ waits, eve }).toStrictEqual({
      waits: "queued:client:placed",
      eve: "admitted",
    });
  });

  it("lets a newcomer to an App take its turn before one person's backlog there", async () => {
    const ledger = newLedger();
    const adaRunning = request("ada", "inbox");
    const zedRunning = request("zed", "inbox");
    await answer(ledger, adaRunning);
    await answer(ledger, zedRunning);
    // The Inbox is full. Ada queues two more, then Ben one.
    const adaFirst = request("ada", "inbox");
    const adaSecond = request("ada", "inbox");
    const ben = request("ben", "inbox");
    for (const waiting of [adaFirst, adaSecond, ben]) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await scheduler.wait(5);
      // oxlint-disable-next-line no-await-in-loop -- in order
      await answer(ledger, waiting);
    }
    // Zed's request ends: Ada's first, first in line, takes the room.
    await ledger.settle(zedRunning.id, { by: "refused" });
    const first = await answer(ledger, {
      ...adaFirst,
      id: crypto.randomUUID(),
    });
    // Ada's running one ends: Ben's turn comes before Ada's second, though
    // he joined after it.
    await ledger.settle(adaRunning.id, { by: "refused" });
    const second = await answer(ledger, {
      ...adaSecond,
      id: crypto.randomUUID(),
    });
    const bens = await answer(ledger, { ...ben, id: crypto.randomUUID() });

    expect({ first, second, bens }).toStrictEqual({
      first: "admitted",
      second: "queued:app:placed",
      bens: "admitted",
    });
  });

  it("gives a third App a place, and its turn, however full two Apps' backlogs keep the client's queue", async () => {
    const { ledger, firstOf } = await saturated();
    // The client's eight backlog places are taken: Cid's first place in
    // a third App is his all the same.
    const cid = tight("cid", "app-c");
    const cidWaits = await answer(ledger, cid);
    // The running request ends, then each one served after it: the first
    // places of each App are served first, Cid's among them, before any
    // backlog.
    const served: string[] = [];
    let running = firstOf.zed;
    for (const next of [firstOf.ada, firstOf.ben]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await ledger.settle(running.id, { by: "refused" });
      running = { ...next, id: crypto.randomUUID() };
      // oxlint-disable-next-line no-await-in-loop -- one after another
      served.push(await answer(ledger, running));
    }
    await ledger.settle(running.id, { by: "refused" });
    const adaBacklog = await answer(ledger, {
      ...firstOf.adaSecond,
      id: crypto.randomUUID(),
    });
    const cidServed = await answer(ledger, { ...cid, id: crypto.randomUUID() });

    expect({ cidWaits, served, adaBacklog, cidServed }).toStrictEqual({
      cidWaits: "queued:client:placed",
      served: ["admitted", "admitted"],
      adaBacklog: "queued:client:placed",
      cidServed: "admitted",
    });
  });

  it("keeps the client's backlog places to its cap", async () => {
    const { ledger } = await saturated();
    const outcomes = [
      await answer(ledger, tight("cid", "app-c")),
      // A backlog place of Cid's: past the client's cap, though his and
      // his App's have room.
      await answer(ledger, tight("cid", "app-c")),
    ];

    expect(outcomes).toStrictEqual([
      "queued:client:placed",
      "queued:client:unplaced",
    ]);
  });

  it("keeps no more places for an App than it may, whoever waits", async () => {
    const ledger = newLedger();
    for (const subject of ["ada", "ben", "cid"]) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await answer(ledger, request(subject, `app-${subject}`));
    }
    const outcomes = [];
    for (const subject of ["dan", "eve", "fay", "gus"]) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      outcomes.push(await answer(ledger, request(subject, "inbox")));
    }

    // Three places an App: the fourth asks again from the back.
    expect(outcomes).toStrictEqual([
      "queued:client:placed",
      "queued:client:placed",
      "queued:client:placed",
      "queued:client:unplaced",
    ]);
  });

  it("keeps no more places for a person or an App than it may, and refuses the rest unplaced", async () => {
    const ledger = newLedger();
    for (const subject of ["ada", "ben", "cid"]) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await answer(ledger, request(subject, `app-${subject}`));
    }
    const outcomes = [];
    for (const app of ["one", "two", "three"]) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      outcomes.push(await answer(ledger, request("dan", app)));
    }

    expect(outcomes).toStrictEqual([
      "queued:client:placed",
      "queued:client:placed",
      "queued:client:unplaced",
    ]);
  });

  it("refuses a used-up budget as that, holding no place, whatever the shares", async () => {
    const ledger = newLedger();
    for (const subject of ["ada", "ben", "cid"]) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await answer(ledger, request(subject, `app-${subject}`));
    }
    const broke = request("dan", "app-dan");
    const refused = await ledger.admit({
      ...broke,
      scopes: [
        {
          scope: "user",
          key: "dan",
          limitMicros: 0,
          alertMicros: null,
          names: { user: "dan" },
        },
      ],
    });
    const places = await runInDurableObject(
      ledger,
      (_instance, state) =>
        state.storage.sql.exec("SELECT place FROM queue").toArray().length
    );

    expect({ refused, places }).toStrictEqual({
      refused: { ok: false, scope: "user" },
      places: 0,
    });
  });
});

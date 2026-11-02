import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import type { ModelShares } from "../src/model-admission.ts";
import { modelLedger } from "../src/model-ledger.ts";
import type { Admission } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import type { ModelCall } from "../src/models.ts";
import { queuedRuns } from "../src/workflows/admission.ts";
import { modelWaitRecorded } from "../src/workflows/model-waits.ts";
import { startRun } from "../src/workflows/runs.ts";
import { mockIdp } from "./idp.ts";
import { fakeProviderFor } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { configuredLimits } from "./quota-limits.ts";
import { finished } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import {
  appWith as serverAppWith,
  bindModel,
  modelRegistration,
  workflowFiles,
} from "./workflow-apps.ts";

// The client's model requests in flight at once (model-admission.ts),
// held to fixed limits in the model ledger's one transaction: in all
// (`modelClientRequests`) and for one person (`modelPersonRequests`). A
// call that finds a limit full waits in the gateway, asking again, then is
// refused as `model.queued`. The model provider behind connect is the
// outside system (test/model-provider.ts); the ledger and the gateway are
// real. Where a test needs a request in flight that nobody will settle (its
// isolate died), it admits one in the ledger as the gateway would and
// walks away.

const idp = mockIdp();

const mistral = "mistral/mistral-large-latest";

/** The tests' quota limits: two requests in flight in all, one for a person. */
const policy = {
  ...configuredLimits,
  modelClientRequests: 2,
  modelPersonRequests: 1,
};

/** An answer that streams its first characters, then waits for `until`. */
const paused = (until: Promise<unknown>): ProviderReply => ({
  text: "Hello there.",
  inputTokens: 10,
  outputTokens: 5,
  pause: { at: 3, until },
});

const answered: ProviderReply = {
  text: "Hi.",
  inputTokens: 10,
  outputTokens: 5,
};

/** Core's gateway under the tests' quota limits. */
const coreWith = () => {
  const coreEnv: Env = { ...env, TEST_QUOTA_LIMITS: policy };
  return { call: models(coreEnv).call, agent: models(coreEnv).agent };
};

/**
 * Core's gateway as `coreWith` makes it, with a provider answering with
 * `replies`, in the order requests reach it, for Mistral Large.
 */
const gatewayWith = async (replies: ProviderReply[]) => ({
  fake: await fakeProviderFor([mistral], ...replies),
  ...coreWith(),
});

/** The App the tests' calls are made in, and its builder. */
const apps: { appId: string; userId: string }[] = [];

/** A person no other test uses. */
const newPerson = () => `person-${crypto.randomUUID()}`;

/** A call by `userId` in the tests' App. */
const callBy = (
  userId: string,
  more: Partial<ModelCall<undefined>> = {}
): ModelCall<undefined> => {
  const [made] = apps;
  if (made === undefined) {
    throw new Error("The tests' App isn't made yet");
  }
  const appId = appIdSchema.parse(made.appId);
  return {
    model: mistral,
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

/** The requests the deployment's ledger ever admitted for `subject`. */
const requestsOf = async (subject: string): Promise<number> =>
  await runInDurableObject(modelLedger(env), (_instance, state) =>
    Number(
      state.storage.sql
        .exec("SELECT count(*) AS n FROM requests WHERE subject = ?", subject)
        .one().n
    )
  );

/** A ledger no other test uses. */
const newLedger = () => env.MODEL_LEDGER.getByName(crypto.randomUUID());

/**
 * A provider request of `subject` as the gateway admits it, held to
 * `shares`, its deadline `deadline`.
 */
const request = (
  subject: string,
  shares: ModelShares,
  deadline = Date.now() + 60_000
): Admission => ({
  id: crypto.randomUUID(),
  period: "2400-01",
  scopes: [{ scope: "deployment", key: "deployment" }],
  model: mistral,
  price: { version: "test", input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  reservedMicros: 1,
  actor: { type: "person", userId: subject },
  deadline,
  reconcileAt: deadline + 60_000,
  fair: { subject, shares },
});

/** What the ledger answered: admitted, or the limit a refusal waits for. */
const answer = async (
  ledger: ReturnType<typeof newLedger>,
  admission: Admission
): Promise<string> => {
  const admitted = await ledger.admit(admission);
  if (admitted.ok) {
    return "admitted";
  }
  return "queued" in admitted
    ? `queued:${admitted.queued.waitingFor}`
    : JSON.stringify(admitted);
};

/** A workflow whose one step asks Mistral Large through its `reader` binding. */
const readerApp = async (builder: Awaited<ReturnType<typeof signedInApi>>) => {
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
  await bindModel(app, "reader", mistral);
  return app;
};

/** What `run` returns with core's own env under the tests' limits. */
const underPolicy = async <Result>(
  run: () => Promise<Result>
): Promise<Result> => {
  const before = env.TEST_QUOTA_LIMITS;
  env.TEST_QUOTA_LIMITS = policy;
  try {
    return await run();
  } finally {
    env.TEST_QUOTA_LIMITS = before;
  }
};

describe("model request slots", { timeout: 60_000 }, () => {
  // After the identity provider's mock is in place, which each test sets.
  beforeEach(async () => {
    if (apps.length > 0) {
      return;
    }
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Inbox" });
    apps.push({ appId: id, userId: builder.userId });
  });

  it("holds a call while the client's requests in flight are full, and admits it once one ends", async () => {
    const release = Promise.withResolvers<boolean>();
    const { fake, call } = await gatewayWith([
      paused(release.promise),
      paused(release.promise),
      answered,
    ]);
    // Two people's calls take both of the client's slots.
    const running = [outcome(call(callBy(newPerson())))];
    await until(() => fake.requests.length === 1);
    running.push(outcome(call(callBy(newPerson()))));
    await until(() => fake.requests.length === 2);
    const queue = queueOf();
    const third = outcome(
      call(callBy(newPerson(), { onQueued: queue.onQueued }))
    );
    await until(() => queue.seen.length > 0);
    const whileFull = {
      third: await Promise.race([third, stillWaiting(50)]),
      sent: fake.requests.length,
    };
    release.resolve(true);

    expect({
      whileFull,
      waitedFor: queue.seen[0],
      all: await Promise.all([...running, third]),
      sent: fake.requests.length,
      lastTold: queue.seen.at(-1),
    }).toStrictEqual({
      whileFull: { third: "waiting", sent: 2 },
      waitedFor: "client",
      all: ["ok", "ok", "ok"],
      sent: 3,
      // Told it stopped waiting once it was admitted.
      lastTold: null,
    });
  });

  it("holds one person to their limit and leaves room for someone else", async () => {
    const release = Promise.withResolvers<boolean>();
    const { fake, call } = await gatewayWith([
      paused(release.promise),
      answered,
      answered,
    ]);
    const ada = newPerson();
    const first = outcome(call(callBy(ada)));
    await until(() => fake.requests.length === 1);
    const queue = queueOf();
    const second = outcome(call(callBy(ada, { onQueued: queue.onQueued })));
    await until(() => queue.seen.length > 0);
    // Ben goes ahead at once: Ada's limit left the client's last slot.
    const ben = await outcome(call(callBy(newPerson())));
    const waiting = await Promise.race([second, stillWaiting(50)]);
    release.resolve(true);

    expect({
      ben,
      waiting,
      waitedFor: queue.seen[0],
      ada: await Promise.all([first, second]),
    }).toStrictEqual({
      ben: "ok",
      waiting: "waiting",
      waitedFor: "person",
      ada: ["ok", "ok"],
    });
  });

  it("refuses a call that waited out its time as queued, with nothing sent", async () => {
    const release = Promise.withResolvers<boolean>();
    const { fake, call } = await gatewayWith([paused(release.promise)]);
    const ada = newPerson();
    const running = outcome(call(callBy(ada)));
    await until(() => fake.requests.length === 1);
    const queue = queueOf();
    // Two seconds for the call: it waits one, half of them, then is told.
    const told = await toldBy(
      call(callBy(ada, { timeoutMs: 2000, onQueued: queue.onQueued }))
    );
    const sent = fake.requests.length;
    release.resolve(true);

    expect({
      told,
      sent,
      lastTold: queue.seen.at(-1),
      running: await running,
    }).toStrictEqual({
      told: {
        code: "model.queued",
        details: {
          model: mistral,
          because: "person",
          waitingFor: "person",
          retryAfterSeconds: 5,
        },
      },
      sent: 1,
      lastTold: null,
      running: "ok",
    });
  });

  it("stops counting a request nobody settles once its lease ends", async () => {
    const { call } = await gatewayWith([answered]);
    // Two requests in flight whose isolate died: nobody settles them, and
    // their calls' deadline, so their lease, ends in two seconds.
    const deadline = Date.now() + 2000;
    const ledger = modelLedger(env);
    for (const ghost of [newPerson(), newPerson()]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await ledger.admit(request(ghost, { client: 2, person: 1 }, deadline));
    }
    const queue = queueOf();

    const admitted = await outcome(
      call(callBy(newPerson(), { onQueued: queue.onQueued, timeoutMs: 20_000 }))
    );

    expect({
      admitted,
      waited: queue.seen[0],
      afterTheLease: Date.now() >= deadline,
    }).toStrictEqual({ admitted: "ok", waited: "client", afterTheLease: true });
  });

  it("gives a cancelled request's slot back at once, not at its deadline", async () => {
    const release = Promise.withResolvers<boolean>();
    const { fake, call, agent } = await gatewayWith([
      paused(release.promise),
      answered,
    ]);
    const ada = newPerson();
    const made = callBy(ada);
    // An agent turn whose person goes away mid-answer: its deadline is
    // minutes off.
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
    const queue = queueOf();
    const next = outcome(call(callBy(ada, { onQueued: queue.onQueued })));
    await until(() => queue.seen.length > 0);
    cancel.abort();
    // Admitted on its next ask, seconds away.
    const admittedSoon = await Promise.race([next, stillWaiting(10_000)]);
    release.resolve(true);
    const ended = await turn;

    expect({
      waitedFor: queue.seen[0],
      admittedSoon,
      turn: ended.stopReason,
    }).toStrictEqual({
      waitedFor: "person",
      admittedSoon: "ok",
      turn: "aborted",
    });
  });

  it("asks nothing more for a call cancelled while it waits", async () => {
    const release = Promise.withResolvers<boolean>();
    const { fake, call } = await gatewayWith([paused(release.promise)]);
    const ada = newPerson();
    const running = outcome(call(callBy(ada)));
    await until(() => fake.requests.length === 1);
    const queue = queueOf();
    const cancel = new AbortController();
    const waiting = outcome(
      call(callBy(ada, { onQueued: queue.onQueued, signal: cancel.signal }))
    );
    await until(() => queue.seen.length > 0);
    // Room comes back while it waits, then its caller goes away.
    release.resolve(true);
    await running;
    cancel.abort();
    const told = await waiting;

    expect({
      // Stopped as cancelled, not queued: nothing to retry.
      told,
      // Admitted nothing after it was cancelled: only Ada's first request.
      admitted: await requestsOf(ada),
      sent: fake.requests.length,
      lastTold: queue.seen.at(-1),
    }).toStrictEqual({
      told: "model.failed",
      admitted: 1,
      sent: 1,
      lastTold: null,
    });
  });

  it("holds no slot while a transcription is open, so calls go on beside it", async () => {
    const { call } = await gatewayWith([answered]);
    const coreEnv: Env = { ...env, TEST_QUOTA_LIMITS: policy };
    // As many sockets open as the client has slots in all.
    const open = await Promise.all(
      Array.from(
        { length: policy.modelClientRequests },
        async () =>
          await models(coreEnv).listen({
            model: "openai/gpt-4o-transcribe",
            seconds: 900,
            openMs: 30 * 60_000,
            purpose: "onboarding.transcription",
            trigger: { type: "system" },
            work: { onboarding: true },
          })
      )
    );

    const beside = await outcome(call(callBy(newPerson())));
    await Promise.all(
      open.map(async (listening) => {
        await listening.heard(0, "cancelled");
      })
    );

    expect([open.length, beside]).toStrictEqual([2, "ok"]);
  });

  it("goes on without a caller's note of its wait that never answers", async () => {
    const release = Promise.withResolvers<boolean>();
    const { fake, call } = await gatewayWith([
      paused(release.promise),
      answered,
    ]);
    const ada = newPerson();
    const running = outcome(call(callBy(ada)));
    await until(() => fake.requests.length === 1);
    let noted = 0;
    const waiting = outcome(
      call(
        callBy(ada, {
          onQueued: async () => {
            noted += 1;
            // Never answers, as a stalled database wouldn't.
            await Promise.withResolvers<null>().promise;
          },
        })
      )
    );
    await until(() => noted > 0);
    release.resolve(true);

    expect({
      waiting: await Promise.race([waiting, stillWaiting(20_000)]),
      running: await running,
    }).toStrictEqual({ waiting: "ok", running: "ok" });
  });

  it("lands a caller's notes of its wait in order, a slow one before the last", async () => {
    const release = Promise.withResolvers<boolean>();
    const { fake, call } = await gatewayWith([
      paused(release.promise),
      answered,
    ]);
    const ada = newPerson();
    const running = outcome(call(callBy(ada)));
    await until(() => fake.requests.length === 1);
    // Where the caller's record stands, as each note lands: the first
    // takes ten seconds, as a stalled write might.
    const landed: (string | null)[] = [];
    let noted = 0;
    const waiting = outcome(
      call(
        callBy(ada, {
          onQueued: async (queued) => {
            noted += 1;
            if (noted === 1) {
              await scheduler.wait(10_000);
            }
            landed.push(queued?.waitingFor ?? null);
          },
        })
      )
    );
    await until(() => noted > 0);
    release.resolve(true);
    await running;
    await until(() => landed.includes(null));

    expect({ landed, waiting: await waiting }).toStrictEqual({
      landed: ["person", null],
      waiting: "ok",
    });
  });

  it("keeps a step's newer call's wait whatever an older call's late notes say", async () => {
    const db = drizzle(env.DB);
    const runId = `run-${crypto.randomUUID()}`;
    const shown = async () => {
      const waits = await queuedRuns(db, [runId], Date.now());
      const wait = waits.get(runId);
      return wait !== undefined && "queued" in wait ? wait.queued : undefined;
    };
    const now = Date.now();
    // The newer call of the step waits, asking again in five seconds.
    await modelWaitRecorded(db, runId, "extract", "newer", {
      waitingFor: "client",
      retryAt: now + 5000,
    });
    // The older call's notes land late: one it wrote before, and its last.
    await modelWaitRecorded(db, runId, "extract", "older", {
      waitingFor: "person",
      retryAt: now + 1000,
    });
    await modelWaitRecorded(db, runId, "extract", "older", null);
    const whileNewerWaits = await shown();
    await modelWaitRecorded(db, runId, "extract", "newer", null);
    // Another note the older call wrote before, landing later still.
    await modelWaitRecorded(db, runId, "extract", "older", {
      waitingFor: "person",
      retryAt: now + 1000,
    });

    expect({ whileNewerWaits, after: await shown() }).toStrictEqual({
      whileNewerWaits: {
        waitingFor: "client",
        retryAt: new Date(now + 5000).toISOString(),
      },
      after: undefined,
    });
  });

  it("gives a run nobody started its App's slot, never its owner's who it acts for", async () => {
    const owner = await signedInApi(idp, "builder");
    const app = await readerApp(owner);
    const release = Promise.withResolvers<boolean>();
    const fake = await fakeProviderFor([mistral], paused(release.promise), {
      text: '{ "total": 1234 }',
      inputTokens: 10,
      outputTokens: 5,
    });
    try {
      await underPolicy(async () => {
        // The owner's own call, elsewhere, fills the owner's limit.
        const holding = outcome(models(env).call(callBy(owner.userId)));
        await until(() => fake.requests.length === 1);
        // Mail, say: a run of the App nobody started, acting for its owner.
        const run = await startRun(env, {
          app: appIdSchema.parse(app),
          workflow: workflowIdSchema.parse("reader"),
          input: null,
          startedBy: null,
          actor: { type: "system" },
        });
        // It goes on while the owner's call still holds the owner's slot.
        const ran = await Promise.race([
          finished(run.id).then(() => "finished"),
          stillWaiting(20_000),
        ]);
        release.resolve(true);

        expect({ ran, holding: await holding }).toStrictEqual({
          ran: "finished",
          holding: "ok",
        });
      });
    } finally {
      release.resolve(true);
    }
  });

  it("shows a run queued while its step's model call waits for a slot, and goes on once it has one", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await readerApp(builder);
    const release = Promise.withResolvers<boolean>();
    const fake = await fakeProviderFor(
      [mistral],
      paused(release.promise),
      paused(release.promise),
      { text: '{ "total": 1234 }', inputTokens: 10, outputTokens: 5 }
    );
    try {
      // The runs the dispatcher runs use core's own env.
      await underPolicy(async () => {
        // Two others' calls fill the client's slots.
        const holding = [outcome(models(env).call(callBy(newPerson())))];
        await until(() => fake.requests.length === 1);
        holding.push(outcome(models(env).call(callBy(newPerson()))));
        await until(() => fake.requests.length === 2);
        const run = await builder.api.workflows.start(app, "reader");
        const summary = async () =>
          await builder.api.screens.frame(app, "").summary(run.id);
        // A run still starting reads as queued too, with no limit to wait
        // for (summary.ts): the step's wait shows once its call waits, in
        // the revision that carries the limit and the time.
        let queued = await summary();
        while (queued.queued === undefined) {
          // oxlint-disable-next-line no-await-in-loop -- until it shows
          await scheduler.wait(10);
          // oxlint-disable-next-line no-await-in-loop -- until it shows
          queued = await summary();
        }
        release.resolve(true);
        await finished(run.id);
        const done = await summary();

        expect({
          queued: [queued.status, queued.queued?.waitingFor],
          retryAt: (queued.queued?.retryAt ?? 0) > Date.now() - 60_000,
          done: [done.status, done.queued],
          holding: await Promise.all(holding),
        }).toStrictEqual({
          queued: ["queued", "client"],
          retryAt: true,
          done: ["completed", undefined],
          holding: ["ok", "ok"],
        });
      });
    } finally {
      release.resolve(true);
    }
  });
});

describe("the model ledger's slots", () => {
  /** Two requests in flight in all, two for a person. */
  const shares: ModelShares = { client: 2, person: 2 };

  it("takes one lease for a request admitted twice under the same ID", async () => {
    const ledger = newLedger();
    const once = request("ada", shares);
    const outcomes = [
      await answer(ledger, once),
      // The same admission again, its answer lost: no second lease.
      await answer(ledger, once),
      await answer(ledger, request("ben", shares)),
      await answer(ledger, request("cy", shares)),
    ];

    expect(outcomes).toStrictEqual([
      "admitted",
      "admitted",
      "admitted",
      "queued:client",
    ]);
  });

  it("gives the last slot to one of the admissions racing for it", async () => {
    const ledger = newLedger();
    const first = await answer(ledger, request("ada", shares));
    const racing = await Promise.all(
      ["ben", "cy", "dee", "eve", "fay"].map(
        async (subject) => await answer(ledger, request(subject, shares))
      )
    );

    expect({ first, racing: racing.toSorted() }).toStrictEqual({
      first: "admitted",
      racing: [
        "admitted",
        "queued:client",
        "queued:client",
        "queued:client",
        "queued:client",
      ],
    });
  });
});

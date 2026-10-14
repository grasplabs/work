import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import { appHost } from "../src/durable-objects.ts";
import { admitAttempt } from "../src/workflows/quotas.ts";
import type {
  AttemptAdmission,
  AttemptOwner,
} from "../src/workflows/quotas.ts";
import { projectStatus, runActor, startRun } from "../src/workflows/runs.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import {
  finished,
  liveStatus,
  resumed,
  runObject,
  sleeping,
  stopped,
} from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith, invoiceMail, workflowFiles } from "./workflow-apps.ts";

// Fair admission of the client's workflow attempts (admission.ts): how
// many run at once, in all, for one person and of one App, each held to
// its share in the deployment's quota policy (`QUOTA_LIMITS`, which a
// test sets as an operator would), and in what order those waiting get
// a share: first come, first served, never behind an App or a person
// whose own share is full. Runs, the engine, the dispatcher and core's
// database are real; attempts are admitted as a run's host admits them
// (quotas.ts, `admitAttempt`), from owners core read from the runs' rows.

const idp = mockIdp();

/** Someone signed in, with their API. */
type Builder = Awaited<ReturnType<typeof signedInApi>>;

/** The generation of the next policy a test sets: each higher than before. */
let generations = 100;

/** The limits the tests' deployment sets (vite.config.ts). */
const configuredLimits = quotaLimitsSchema.parse(env.QUOTA_LIMITS).limits;

/** Sets the operator's policy to the deployment's, with `limits` lowered. */
const policyWith = (limits: Record<string, number>): void => {
  generations += 1;
  env.QUOTA_LIMITS = {
    generation: generations,
    limits: { ...configuredLimits, ...limits },
  };
};

/** The admissions a test made: settled once it is over (`withShares`). */
const admitted: AttemptAdmission[] = [];

/**
 * What `run` returns, with the operator's quota policy `limits` in force;
 * the deployment's own limits again after it, under a newer generation.
 * The client's shares are the whole deployment's: once it is over, what
 * the test admitted settles and what it queued stops waiting, as its runs
 * would, so the next test starts with every share free.
 */
const withShares = async <Result>(
  limits: Record<string, number>,
  run: () => Promise<Result>
): Promise<Result> => {
  policyWith(limits);
  try {
    return await run();
  } finally {
    policyWith({});
    await Promise.all(
      admitted.splice(0).map(async (admission) => {
        await admission.settle();
      })
    );
    await env.DB.prepare("DELETE FROM workflow_admission_queue").run();
  }
};

/** An App of `builder`'s with a workflow that does nothing, and a run of it. */
/**
 * A workflow whose runs wait a day: runs still going, whose attempts a
 * test admits as their host would.
 */
const idle = workflowFiles(
  "idle",
  `  await step.sleep("idle", { description: "Wait", duration: "1 day" });
  return 1;`
);

/** A run of `app`'s idle workflow, waiting. */
const idleRun = async (builder: Builder, app: string): Promise<string> => {
  const run = await builder.api.workflows.start(app, "idle");
  await sleeping(run.id, "idle");
  return run.id;
};

const ownerOf = async (builder: Builder): Promise<AttemptOwner> => {
  const app = await appWith(builder, {
    ...workflowFiles("noop", "  return 1;"),
    ...idle,
  });
  const run = await idleRun(builder, app);
  return { run, root: run, subject: builder.userId, resource: app };
};

/** Another run of `owner`'s App, for the same person. */
const anotherRun = async (
  builder: Builder,
  owner: AttemptOwner
): Promise<AttemptOwner> => {
  const run = await idleRun(builder, owner.resource);
  return { ...owner, run, root: run };
};

/** A first attempt at step `step`, holding until `ms` from now. */
const attemptOf = (step: string, ms = 60_000) => ({
  key: `key-${step}`,
  step,
  number: 1,
  generation: 1,
  deadline: Date.now() + ms,
});

const queuedSchema = z.object({
  code: z.literal("workflow.queued"),
  details: z.object({
    waitingFor: z.enum(["client", "person", "app"]),
    retryAfterSeconds: z.number(),
  }),
});

/** The code of a refusal, or what else was thrown. */
const codeOf = (error: unknown): string =>
  z.object({ code: z.string() }).safeParse(error).data?.code ?? String(error);

/** Admits `step` of `owner`'s, answering its admission or its refusal. */
const admit = async (
  owner: AttemptOwner,
  step: string,
  ms?: number
): Promise<
  | { admitted: AttemptAdmission }
  | { refused: string; waitingFor?: string; retryAfterSeconds?: number }
> => {
  try {
    const admission = await admitAttempt(env, owner, attemptOf(step, ms));
    admitted.push(admission);
    return { admitted: admission };
  } catch (error) {
    const queued = queuedSchema.safeParse(error).data;
    return queued === undefined
      ? { refused: codeOf(error) }
      : { refused: queued.code, ...queued.details };
  }
};

/** What `admit` answered, as a word: `ok`, or the refusal's code and share. */
const shown = (answer: Awaited<ReturnType<typeof admit>>): string =>
  "admitted" in answer
    ? "ok"
    : [answer.refused, answer.waitingFor].filter(Boolean).join(":");

/** A step that takes about `ms`, then returns 1. */
const working = (name: string, ms: number) =>
  `  await step.do("${name}", { description: "Work" }, async () => {
    await scheduler.wait(${ms});
    return 1;
  });`;

/** Admits `attempt` of `owner`'s as its host would, answering as `shown`. */
const admitExactly = async (
  owner: AttemptOwner,
  attempt: ReturnType<typeof attemptOf>
): Promise<string> => {
  try {
    const admission = await admitAttempt(env, owner, attempt);
    admitted.push(admission);
    return "ok";
  } catch (error) {
    const queued = queuedSchema.safeParse(error).data;
    return queued === undefined
      ? codeOf(error)
      : `${queued.code}:${queued.details.waitingFor}`;
  }
};

/** `owner`'s attempt as another person's: whose person share it takes. */
const asPerson = (owner: AttemptOwner, subject: string): AttemptOwner => ({
  ...owner,
  subject,
});

/**
 * Moves what core's database recorded `ms` into the past, for `table`'s
 * rows `where` picks: time passing for them, as it would.
 */
const aged = async (
  table: string,
  column: string,
  where: string,
  ms: number
): Promise<void> => {
  await env.DB.prepare(
    `UPDATE ${table} SET ${column} = ${column} - ${ms} WHERE ${where}`
  ).run();
};

/** How many times `run` recorded that it waits, in its audit log. */
const waitsOf = async (run: string): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    ({ action, target }) =>
      action === "workflow.run.waiting" && target?.id === run
  ).length;
};

/** How long each of `run`'s rounds waiting for load slept, in order. */
const loadWaitsOf = async (run: string): Promise<number[]> =>
  await runInDurableObject(runObject(run), (_object, state) =>
    state.storage.sql
      .exec<{ ms: number }>(
        "SELECT duration_ms AS ms FROM steps WHERE type = 'sleep' AND name LIKE '%:busy:%' ORDER BY ordinal"
      )
      .toArray()
      .map(({ ms }) => ms)
  );

/** How `run` failed, as its `workflow.run.failed` event names it; none yet. */
const failedWith = async (run: string): Promise<unknown> => {
  const events = await allEvents();
  return events.find(
    ({ action, target }) =>
      action === "workflow.run.failed" && target?.id === run
  )?.detail.error;
};

/** How many times the App's server counted `name` (its `hits`). */
const hitsOf = async (app: string, userId: string, name: string) =>
  await callApp(
    env,
    appIdSchema.parse(app),
    { userId, mode: "interactive" },
    "hits",
    [name]
  );

/** The places `run` holds in the client's queue now. */
const placesOf = async (run: string): Promise<number> =>
  (await env.DB.prepare(
    "SELECT count(*) AS places FROM workflow_admission_queue WHERE run_id = ?"
  )
    .bind(run)
    .first<number>("places")) ?? 0;

/** Settles what `admit` admitted, if it did. */
const settled = async (answer: Awaited<ReturnType<typeof admit>>) => {
  if ("admitted" in answer) {
    await answer.admitted.settle();
  }
};

/** What `read` answers once it passes, in up to 20 seconds. */
const eventually2 = async <Value>(read: () => Promise<Value>): Promise<Value> =>
  await vi.waitFor(read, { timeout: 20_000, interval: 200 });

/** Once `check` passes, in up to `timeout` ms. */
const eventually = async (
  check: () => Promise<void>,
  timeout = 40_000
): Promise<void> => {
  await vi.waitFor(check, { timeout, interval: 200 });
};

describe("fair workflow admission", { timeout: 120_000 }, () => {
  it("admit no more attempts at once than the client's, a person's or an App's share, however many race, and the same attempt once", async () => {
    const [first, second, third] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    const hot = await ownerOf(first);
    const other = await ownerOf(second);
    const late = await ownerOf(third);

    const result = await withShares(
      {
        workflowClientAttempts: 3,
        workflowPersonAttempts: 2,
        workflowAppAttempts: 2,
      },
      async () => {
        // Six of one App's attempts at once: two fit its share.
        const racing = await Promise.all(
          Array.from(
            { length: 6 },
            async (_, index) => await admit(hot, `hot-${index}`)
          )
        );
        // The first admitted, admitted again: it holds one lease, so it
        // is in, and takes no other share.
        const again = racing.findIndex((answer) => "admitted" in answer);
        const twice = await admit(hot, `hot-${again}`);
        // Another person's App still has room; the client's last share
        // goes to it, and a third person's attempt finds none.
        const otherApp = await admit(other, "other");
        const lastPerson = await admit(late, "late");
        return {
          racing: racing.map(shown).toSorted(),
          twice: shown(twice),
          otherApp: shown(otherApp),
          lastPerson: shown(lastPerson),
        };
      }
    );

    expect(result).toStrictEqual({
      racing: [
        "ok",
        "ok",
        "workflow.queued:app",
        "workflow.queued:app",
        "workflow.queued:app",
        "workflow.queued:app",
      ],
      twice: "ok",
      otherApp: "ok",
      lastPerson: "workflow.queued:client",
    });
  });

  it("serve those waiting first come, first served, before any newcomer, and never keep one waiting behind an App whose share is full", async () => {
    const [first, second] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    const hot = await ownerOf(first);
    const hotAgain = await anotherRun(first, hot);
    const other = await ownerOf(second);

    const result = await withShares(
      {
        workflowClientAttempts: 3,
        workflowPersonAttempts: 2,
        workflowAppAttempts: 2,
      },
      async () => {
        const held = await admit(hot, "a1");
        await admit(hot, "a2");
        // The hot App's share is full: these two wait, the earlier first.
        const waiting = [
          shown(await admit(hot, "a3")),
          shown(await admit(hotAgain, "a4")),
        ];
        // Another App's newcomer isn't kept behind them: they can't run.
        const otherApp = shown(await admit(other, "b1"));
        // One of the hot App's attempts settles: a share comes free, in
        // the client and in the App, for the attempt that waited longest.
        if ("admitted" in held) {
          await held.admitted.settle();
        }
        // A newcomer finds the client's free share taken by those ahead
        // of it, and the later of the two finds the App's taken by the
        // earlier.
        const newcomer = shown(await admit(other, "b2"));
        const later = shown(await admit(hotAgain, "a4"));
        const earlier = shown(await admit(hot, "a3"));
        return { waiting, otherApp, newcomer, later, earlier };
      }
    );

    expect(result).toStrictEqual({
      waiting: ["workflow.queued:app", "workflow.queued:app"],
      otherApp: "ok",
      newcomer: "workflow.queued:client",
      later: "workflow.queued:app",
      earlier: "ok",
    });
  });

  it("give back an attempt's share once its deadline passes, though it never settled, and take none for an admission whose write never landed", async () => {
    const builder = await signedInApi(idp, "builder");
    const owner = await ownerOf(builder);

    const result = await withShares(
      { workflowClientAttempts: 2, workflowAppAttempts: 1 },
      async () => {
        // Admitted, then its activation dies: it never settles.
        await admit(owner, "dies", 1500);
        const whileHeld = await admit(owner, "next");
        await scheduler.wait(1600);
        // An admission that dies before its write lands takes nothing.
        const database = env.DB;
        env.DB = new Proxy(database, {
          get: (target, property) => {
            if (property === "batch") {
              return async () => {
                await Promise.resolve();
                throw new Error("Core stopped mid-admission");
              };
            }
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function"
              ? (...args: unknown[]): unknown =>
                  Reflect.apply(value, target, args)
              : value;
          },
        });
        let crashed: unknown;
        try {
          await admitAttempt(env, owner, attemptOf("crashed"));
        } catch (error) {
          crashed = error;
        } finally {
          env.DB = database;
        }
        const afterDeadline = await admit(owner, "next");
        return {
          whileHeld,
          crashed: crashed instanceof Error,
          afterDeadline: shown(afterDeadline),
        };
      }
    );

    expect(result).toMatchObject({
      whileHeld: { refused: "workflow.queued", waitingFor: "app" },
      crashed: true,
      afterDeadline: "ok",
    });
    // When the attempt that died reaches its deadline: its share comes
    // back then at the latest.
    expect(
      "retryAfterSeconds" in result.whileHeld
        ? result.whileHeld.retryAfterSeconds
        : 0
    ).toBeLessThanOrEqual(2);
  });

  it("apply a share the operator lowers to the next admission, whatever was admitted under the last", async () => {
    const builder = await signedInApi(idp, "builder");
    const owner = await ownerOf(builder);

    const result = await withShares(
      { workflowClientAttempts: 4, workflowAppAttempts: 3 },
      async () => {
        const before = [await admit(owner, "a"), await admit(owner, "b")];
        policyWith({ workflowClientAttempts: 4, workflowAppAttempts: 2 });
        const after = await admit(owner, "c");
        return { before: before.map(shown), after: shown(after) };
      }
    );

    expect(result).toStrictEqual({
      before: ["ok", "ok"],
      after: "workflow.queued:app",
    });
  });

  it("run another App's workflow while a saturated App's runs wait their turn, showing them as queued with when they ask again, and run them all", async () => {
    const [first, second] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    const hot = await appWith(
      first,
      workflowFiles("slow", `${working("work", 1500)}\n  return 1;`, {
        work: 1,
      })
    );
    const other = await appWith(
      second,
      workflowFiles("quick", `${working("work", 10)}\n  return 1;`, {
        work: 1,
      })
    );

    const result = await withShares({ workflowClientAttempts: 2 }, async () => {
      const hotRuns = await Promise.all(
        Array.from(
          { length: 3 },
          async () => await first.api.workflows.start(hot, "slow")
        )
      );
      // One of the hot App's runs waits its turn, and shows it.
      let queued: unknown;
      let seenAt = 0;
      await eventually(async () => {
        const summaries = await Promise.all(
          hotRuns.map(
            async ({ id }) => await first.api.screens.summary(hot, id)
          )
        );
        // Once read: what they show was written by then.
        seenAt = Date.now();
        // Queued for a share, not just starting (also shown as queued).
        queued = summaries.find((summary) => summary.queued !== undefined);
        expect(queued).toBeDefined();
      });
      const quick = await second.api.workflows.start(other, "quick");
      await finished(quick.id);
      const hotWhenQuickDone = await Promise.all(
        hotRuns.map(async ({ id }) => await liveStatus(id))
      );
      // The last of the hot App's runs may wait three rounds, five, ten
      // and twenty seconds long (admission.ts, `askAgainSeconds`), before
      // a share is its: some 35 seconds, and more on a loaded machine.
      await eventually(async () => {
        const statuses = await Promise.all(
          hotRuns.map(async ({ id }) => await liveStatus(id))
        );
        expect(statuses).toStrictEqual(["complete", "complete", "complete"]);
      }, 60_000);
      return {
        queued,
        retryAt: z
          .object({ queued: z.object({ retryAt: z.number() }) })
          .safeParse(queued).data?.queued.retryAt,
        seenAt,
        quick: await liveStatus(quick.id),
        hotStillRunning: hotWhenQuickDone.some(
          (status) => status !== "complete"
        ),
        hotRuns: hotRuns.map(({ id }) => id),
      };
    });

    expect(result).toMatchObject({
      queued: {
        status: "queued",
        // With two at once in all, an App's share is one.
        queued: { waitingFor: "app" },
      },
      quick: "complete",
      hotStillRunning: true,
    });
    // When it asks again at the latest: a time to come as it was shown.
    // No later than a waiting step asks again: five seconds on at most,
    // whatever the first lease's deadline (minutes on).
    expect(result.retryAt).toBeGreaterThan(result.seenAt - 6000);
    expect(result.retryAt).toBeLessThanOrEqual(result.seenAt + 5000);
    // Each run that waited said so once, with the share and the wait, in
    // its audit log; throttling isn't its failure.
    const events = await allEvents();
    const waits = events.filter(
      ({ action, target }) =>
        action === "workflow.run.waiting" &&
        target?.id !== undefined &&
        result.hotRuns.some((id) => id === target.id)
    );
    expect(waits.length).toBeGreaterThan(0);
    expect(
      waits.map(({ detail }) => [
        detail.reason,
        detail.waitingFor,
        typeof detail.retryAfterSeconds,
      ])
    ).toStrictEqual(waits.map(() => ["queued", "app", "number"]));
  });

  it("split two attempts at once in all into one for each App, and leave a person with two Apps no more than a person's share", async () => {
    const [first, second, third] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    const hot = await ownerOf(first);
    const other = await ownerOf(second);
    const late = await ownerOf(third);
    const firstApp = await ownerOf(first);
    const secondApp = await ownerOf(first);

    const split = await withShares({ workflowClientAttempts: 2 }, async () => [
      shown(await admit(hot, "a1")),
      shown(await admit(hot, "a2")),
      shown(await admit(other, "b1")),
      shown(await admit(late, "c1")),
    ]);
    const person = await withShares(
      {
        workflowClientAttempts: 4,
        workflowPersonAttempts: 2,
        workflowAppAttempts: 3,
      },
      async () => [
        shown(await admit(firstApp, "x1")),
        shown(await admit(secondApp, "y1")),
        shown(await admit(secondApp, "y2")),
      ]
    );

    expect({ split, person }).toStrictEqual({
      split: ["ok", "workflow.queued:app", "ok", "workflow.queued:client"],
      person: ["ok", "ok", "workflow.queued:person"],
    });
  });

  it("let people take turns in an App, so another person's newcomer waits behind one of a backlog's attempts at most", async () => {
    const [first, second] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    const backlog = await ownerOf(first);
    const newcomer = asPerson(await anotherRun(first, backlog), second.userId);

    const result = await withShares(
      {
        workflowClientAttempts: 4,
        workflowPersonAttempts: 3,
        workflowAppAttempts: 2,
      },
      async () => {
        const one = await admit(backlog, "a1");
        const two = await admit(backlog, "a2");
        const waiting = [
          shown(await admit(backlog, "a3")),
          shown(await admit(backlog, "a4")),
          shown(await admit(backlog, "a5")),
          shown(await admit(newcomer, "b1")),
        ];
        if ("admitted" in one) {
          await one.admitted.settle();
        }
        // The backlog's first place goes first, its next after the
        // newcomer's.
        const afterFirst = [
          shown(await admit(backlog, "a4")),
          shown(await admit(backlog, "a3")),
        ];
        if ("admitted" in two) {
          await two.admitted.settle();
        }
        const afterSecond = [
          shown(await admit(backlog, "a4")),
          shown(await admit(newcomer, "b1")),
        ];
        return { waiting, afterFirst, afterSecond };
      }
    );

    expect(result).toStrictEqual({
      waiting: [
        "workflow.queued:app",
        "workflow.queued:app",
        "workflow.queued:app",
        "workflow.queued:app",
      ],
      afterFirst: ["workflow.queued:app", "ok"],
      afterSecond: ["workflow.queued:app", "ok"],
    });
  });

  it("hold back for those waiting only the shares they can take together, under a person's and an App's share at once", async () => {
    const builder = await signedInApi(idp, "builder");
    const [kept, first, second, third, fourth] = await Promise.all([
      ownerOf(builder),
      ownerOf(builder),
      ownerOf(builder),
      ownerOf(builder),
      ownerOf(builder),
    ]);

    const result = await withShares(
      {
        workflowClientAttempts: 4,
        workflowPersonAttempts: 1,
        workflowAppAttempts: 1,
      },
      async () => {
        // The client's share full, and the Apps of the next four each
        // hold its own, so they wait their turn.
        const held = await admit(asPerson(kept, "p0"), "h0");
        const freed = [
          await admit(asPerson(first, "q1"), "h1"),
          await admit(asPerson(second, "q2"), "h2"),
          await admit(asPerson(third, "q3"), "h3"),
        ];
        const older = [
          [asPerson(second, "p1"), "w1"],
          [asPerson(third, "p1"), "w2"],
          [asPerson(first, "p2"), "w3"],
          [asPerson(first, "p3"), "w4"],
        ] as const;
        const inOrder = async (): Promise<string[]> => {
          const answers: string[] = [];
          for (const [owner, step] of older) {
            // oxlint-disable-next-line no-await-in-loop -- in queue order
            answers.push(shown(await admit(owner, step)));
          }
          return answers;
        };
        const waiting = await inOrder();
        await Promise.all(freed.map(settled));
        // One lease runs: of those waiting, one person's two places take
        // one lease, and one App's two take one, so a third is free.
        const newcomer = shown(await admit(asPerson(fourth, "p4"), "n1"));
        const after = await inOrder();
        return { held: shown(held), waiting, newcomer, after };
      }
    );

    expect(result).toStrictEqual({
      held: "ok",
      waiting: [
        "workflow.queued:app",
        "workflow.queued:app",
        "workflow.queued:app",
        "workflow.queued:app",
      ],
      newcomer: "ok",
      after: ["ok", "workflow.queued:person", "ok", "workflow.queued:app"],
    });
  });

  it("hold back no share for a step refused for its lineage once its App came free, and queue it again at the back", async () => {
    const builder = await signedInApi(idp, "builder");
    const [hot, other, newcomer] = await Promise.all([
      ownerOf(builder),
      ownerOf(builder),
      ownerOf(builder),
    ]);
    const holder = asPerson(await anotherRun(builder, hot), "p1");
    // A child in the hot App, and its sibling in another App, of one
    // lineage: the sibling's attempt holds all of the lineage's time.
    const child = asPerson(hot, "p2");
    const sibling = {
      ...asPerson(other, "p3"),
      root: child.root,
    };

    const result = await withShares(
      { workflowClientAttempts: 2, workflowActiveMs: 30_000 },
      async () => {
        const held = await admit(holder, "h1");
        const waiting = shown(await admit(child, "c1"));
        const siblingAnswer = shown(await admit(sibling, "s1"));
        await settled(held);
        // The hot App came free, but the child's lineage has no time.
        const lineage = shown(await admit(child, "c1"));
        const places = await placesOf(child.run);
        const late = shown(await admit(asPerson(newcomer, "p4"), "n1"));
        return { waiting, siblingAnswer, lineage, places, late };
      }
    );

    expect(result).toStrictEqual({
      waiting: "workflow.queued:app",
      siblingAnswer: "ok",
      lineage: "workflow.lineage_busy",
      places: 0,
      late: "ok",
    });
  });

  it("leave the place a step's later attempt holds when an earlier attempt's call fails late", async () => {
    const builder = await signedInApi(idp, "builder");
    const hot = await ownerOf(builder);
    const holder = asPerson(await anotherRun(builder, hot), "p1");
    const waiter = asPerson(hot, "p2");
    const first = attemptOf("w1");

    const result = await withShares({ workflowClientAttempts: 2 }, async () => {
      const held = await admit(holder, "h1");
      const waiting = await admitExactly(waiter, first);
      // The engine gave up on the first attempt and retries the step: the
      // retry keeps its place.
      const retried = await admitExactly(waiter, {
        ...attemptOf("w1", 61_000),
        number: 2,
      });
      // The first attempt's call, past its deadline, fails only now.
      const late = await admitExactly(waiter, {
        ...first,
        deadline: Date.now() - 1000,
      });
      const places = await placesOf(waiter.run);
      await settled(held);
      return { waiting, retried, late, places };
    });

    expect(result).toStrictEqual({
      waiting: "workflow.queued:app",
      retried: "workflow.queued:app",
      late: "execution.stale_attempt",
      places: 1,
    });
  });

  it("put back no place for a step whose later attempt took a lease, when an earlier attempt's refusal lands late", async () => {
    const builder = await signedInApi(idp, "builder");
    const hot = await ownerOf(builder);
    const holder = asPerson(await anotherRun(builder, hot), "p1");
    const waiter = asPerson(hot, "p2");
    const first = attemptOf("w1");

    const result = await withShares({ workflowClientAttempts: 2 }, async () => {
      const held = await admit(holder, "h1");
      const waiting = await admitExactly(waiter, first);
      await settled(held);
      // The engine retries the step, and the retry runs: its lease holds
      // the App's share.
      const retried = await admitExactly(waiter, {
        ...attemptOf("w1", 61_000),
        number: 2,
      });
      // The first attempt's call, still within its deadline, is refused
      // for the App's share only now.
      const late = await admitExactly(waiter, first);
      return { waiting, retried, late, places: await placesOf(waiter.run) };
    });

    expect(result).toStrictEqual({
      waiting: "workflow.queued:app",
      retried: "ok",
      late: "execution.stale_attempt",
      places: 0,
    });
  });

  it("put a place that stopped asking at the back when it asks again", async () => {
    const builder = await signedInApi(idp, "builder");
    const owner = await ownerOf(builder);
    const queuedLong = await anotherRun(builder, owner);
    const queuedLater = await anotherRun(builder, owner);

    const result = await withShares(
      { workflowClientAttempts: 2, workflowAppAttempts: 1 },
      async () => {
        const holder = await admit(owner, "holder");
        await admit(queuedLong, "long");
        await admit(queuedLater, "later");
        // The earliest place stops asking for longer than a place lasts.
        await aged(
          "workflow_admission_queue",
          "seen_at",
          `run_id = '${queuedLong.run}'`,
          91_000
        );
        const rejoined = shown(await admit(queuedLong, "long"));
        if ("admitted" in holder) {
          await holder.admitted.settle();
        }
        return {
          rejoined,
          // Behind the later place now.
          long: shown(await admit(queuedLong, "long")),
          later: shown(await admit(queuedLater, "later")),
        };
      }
    );

    expect(result).toStrictEqual({
      rejoined: "workflow.queued:app",
      long: "workflow.queued:app",
      later: "ok",
    });
  });

  it("keep no one waiting behind a waiter that stopped asking", async () => {
    const builder = await signedInApi(idp, "builder");
    const owner = await ownerOf(builder);
    const dead = await anotherRun(builder, owner);
    const newcomer = await anotherRun(builder, owner);

    const result = await withShares(
      { workflowClientAttempts: 2, workflowAppAttempts: 1 },
      async () => {
        const holder = await admit(owner, "holder");
        await admit(dead, "dead");
        if ("admitted" in holder) {
          await holder.admitted.settle();
        }
        const whileAsking = shown(await admit(newcomer, "new"));
        await aged(
          "workflow_admission_queue",
          "seen_at",
          `run_id = '${dead.run}'`,
          91_000
        );
        return { whileAsking, afterLapse: shown(await admit(newcomer, "new")) };
      }
    );

    expect(result).toStrictEqual({
      whileAsking: "workflow.queued:app",
      afterLapse: "ok",
    });
  });

  it("stop counting a lease an attempt's wall time after its admission, whatever its deadline, and let a new activation's attempt in past the one it replaced", async () => {
    const builder = await signedInApi(idp, "builder");
    const owner = await ownerOf(builder);
    const otherLineage = await anotherRun(builder, owner);
    const replaced = await anotherRun(builder, owner);

    const result = await withShares(
      { workflowClientAttempts: 2, workflowAppAttempts: 1 },
      async () => {
        // Its deadline ten minutes on; its activation dies at once.
        await admit(owner, "dies", 10 * 60_000);
        const whileHeld = shown(await admit(otherLineage, "next"));
        await aged(
          "run_lineage_attempts",
          "admitted_at",
          "step_key = 'key-dies'",
          61_000
        );
        const afterWallTime = shown(await admit(otherLineage, "next"));
        await Promise.all(
          admitted.splice(0).map(async (admission) => {
            await admission.settle();
          })
        );
        // The same step's attempt under two activations: the engine fenced
        // the first as it gave the step to the second.
        const step = attemptOf("retried", 10 * 60_000);
        const first = await admitExactly(replaced, step);
        const second = await admitExactly(replaced, { ...step, generation: 2 });
        return { whileHeld, afterWallTime, first, second };
      }
    );

    expect(result).toStrictEqual({
      whileHeld: "workflow.queued:app",
      afterWallTime: "ok",
      first: "ok",
      second: "ok",
    });
  });

  it("queue no more of a person's, or an App's, steps at once than it may, refusing the next", async () => {
    const [first, second] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    const app = await ownerOf(first);
    const runs = await Promise.all(
      Array.from({ length: 3 }, async () => await anotherRun(first, app))
    );
    const personsApp = await ownerOf(second);
    const personsOther = await ownerOf(second);

    const perApp = await withShares(
      {
        workflowClientAttempts: 4,
        workflowAppAttempts: 1,
        workflowQueuedPerApp: 2,
      },
      async () => {
        await admit(app, "holder");
        const answers: string[] = [];
        for (const [index, run] of runs.entries()) {
          // oxlint-disable-next-line no-await-in-loop -- one after another
          answers.push(shown(await admit(run, `w${index}`)));
        }
        return answers;
      }
    );
    const perPerson = await withShares(
      {
        workflowClientAttempts: 4,
        workflowPersonAttempts: 1,
        workflowQueuedPerPerson: 1,
      },
      async () => [
        shown(await admit(personsApp, "holder")),
        shown(await admit(personsApp, "first")),
        shown(await admit(personsOther, "second")),
      ]
    );

    expect({ perApp, perPerson }).toStrictEqual({
      perApp: [
        "workflow.queued:app",
        "workflow.queued:app",
        "workflow.queue_full",
      ],
      perPerson: ["ok", "workflow.queued:person", "workflow.queue_full"],
    });
  });

  it("wait in the queue for more rounds than the run may take steps, longer each round, record that it waits once, and complete", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("noop", "  return 1;"),
      ...workflowFiles("work", `${working("work", 10)}\n  return 1;`, {
        work: 1,
      }),
    });
    const holderRun = await builder.api.workflows.start(app, "noop");
    await finished(holderRun.id);
    const holder = {
      run: holderRun.id,
      root: holderRun.id,
      subject: builder.userId,
      resource: app,
    };

    const result = await withShares(
      { workflowSteps: 2, workflowClientAttempts: 2 },
      async () => {
        const held = await admit(holder, "holder");
        const run = await builder.api.workflows.start(app, "work");
        // Rounds of five, then ten seconds: three, more than its two steps.
        await scheduler.wait(16_000);
        const whileHeld = await liveStatus(run.id);
        const rounds = await loadWaitsOf(run.id);
        if ("admitted" in held) {
          await held.admitted.settle();
        }
        await eventually(async () => {
          await expect(liveStatus(run.id)).resolves.toBe("complete");
        });
        return { whileHeld, rounds, waits: await waitsOf(run.id) };
      }
    );

    // The holder's lease holds a minute: each round waits longer, short
    // of it, five seconds doubling.
    expect(result).toStrictEqual({
      whileHeld: "waiting",
      rounds: [5000, 10_000, 20_000],
      waits: 1,
    });
  });

  it("fail a step that waited for a share as long as a step may wait", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("noop", "  return 1;"),
      ...workflowFiles("work", `${working("work", 10)}\n  return 1;`, {
        work: 1,
      }),
    });
    const holderRun = await builder.api.workflows.start(app, "noop");
    await finished(holderRun.id);
    const holder = {
      run: holderRun.id,
      root: holderRun.id,
      subject: builder.userId,
      resource: app,
    };

    const failed = await withShares(
      { workflowClientAttempts: 2, workflowQueuedStepMs: 8000 },
      async () => {
        await admit(holder, "holder");
        const startedAt = Date.now();
        const run = await builder.api.workflows.start(app, "work");
        // Its second round: ten seconds of backoff, three left of its eight.
        await scheduler.wait(6500);
        const summary = await builder.api.screens.summary(app, run.id);
        await finished(run.id);
        return {
          code: await failedWith(run.id),
          // When it said it asks again, from its start: never past its
          // eight seconds, which began as it first waited.
          asksAgainBy: (summary.queued?.retryAt ?? 0) - startedAt,
        };
      }
    );

    expect(failed.code).toBe("workflow.queue_timeout");
    expect(failed.asksAgainBy).toBeGreaterThan(0);
    expect(failed.asksAgainBy).toBeLessThanOrEqual(9500);
  });

  it("count a run nobody started against its App's triggers' share, never its owner's, and a run started under another against its root's person", async () => {
    const builder = await signedInApi(idp, "builder");
    const quick = `${working("work", 10)}\n  return 1;`;
    const app = await appWith(builder, {
      ...workflowFiles("noop", "  return 1;"),
      ...workflowFiles("quick", quick, { work: 1 }),
    });
    // The owner's own work, in another App, holds their person share.
    const elsewhere = await ownerOf(builder);
    const root = await builder.api.workflows.start(app, "noop");
    await finished(root.id);

    const result = await withShares(
      {
        workflowClientAttempts: 4,
        workflowPersonAttempts: 1,
        workflowAppAttempts: 3,
      },
      async () => {
        const held = await admit(elsewhere, "owner's work");
        // Mail, say: a run of the App nobody started.
        const triggered = await startRun(env, {
          app: appIdSchema.parse(app),
          workflow: workflowIdSchema.parse("quick"),
          input: null,
          startedBy: null,
          actor: { type: "system" },
        });
        await finished(triggered.id);
        // A run the owner's run started, nobody named as its starter.
        const parent = runIdSchema.parse(root.id);
        const child = await startRun(env, {
          app: appIdSchema.parse(app),
          workflow: workflowIdSchema.parse("quick"),
          input: null,
          startedBy: null,
          actor: runActor({ id: parent, appId: app, workflowId: "noop" }),
          parent,
        });
        let childQueued: unknown;
        await eventually(async () => {
          const summary = await builder.api.screens.summary(app, child.id);
          childQueued = summary.queued?.waitingFor;
          expect(childQueued).toBeDefined();
        });
        if ("admitted" in held) {
          await held.admitted.settle();
        }
        await finished(child.id);
        return {
          triggered: await liveStatus(triggered.id),
          childQueued,
          child: await liveStatus(child.id),
        };
      }
    );

    expect(result).toStrictEqual({
      triggered: "complete",
      childQueued: "person",
      child: "complete",
    });
  });

  it("say a queued run asks again within a waiting step's wait, whatever the lease it waits for holds, and give up its place as it pauses, so it keeps no one waiting", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("noop", "  return 1;"),
      ...workflowFiles("work", `${working("work", 10)}\n  return 1;`, {
        work: 1,
      }),
    });
    const holder = await ownerOf(builder);
    const owner = { ...holder, resource: app };
    const holderRun = await builder.api.workflows.start(app, "noop");
    await finished(holderRun.id);
    const newcomer = { ...owner, run: holderRun.id, root: holderRun.id };

    const result = await withShares(
      { workflowClientAttempts: 2, workflowAppAttempts: 1 },
      async () => {
        const held = await admit(
          { ...newcomer, run: holder.run, root: holder.run },
          "holder"
        );
        const run = await builder.api.workflows.start(app, "work");
        // The holder's lease holds a minute; the run asks again sooner.
        let asksAgainIn = Number.POSITIVE_INFINITY;
        await eventually(async () => {
          const summary = await builder.api.screens.summary(app, run.id);
          expect(summary.queued).toBeDefined();
          asksAgainIn = (summary.queued?.retryAt ?? 0) - Date.now();
        });
        await stopped(run.id);
        await eventually(async () => {
          const summary = await builder.api.screens.summary(app, run.id);
          expect(summary.status).toBe("paused");
        });
        if ("admitted" in held) {
          await held.admitted.settle();
        }
        return {
          asksAgainSoon: asksAgainIn <= 5000,
          newcomer: shown(await admit(newcomer, "new")),
        };
      }
    );

    expect(result).toStrictEqual({ asksAgainSoon: true, newcomer: "ok" });
  });

  it("never let a person's newer work in an App pass their older work, however many of their places have gone", async () => {
    const builder = await signedInApi(idp, "builder");
    const owner = await ownerOf(builder);

    const result = await withShares(
      { workflowClientAttempts: 2, workflowAppAttempts: 1 },
      async () => {
        const holder = await admit(owner, "holder");
        await admit(owner, "a1");
        await admit(owner, "a2");
        await admit(owner, "a3");
        // The first two of the three run and finish, in turn.
        await settled(holder);
        await settled(await admit(owner, "a1"));
        await settled(await admit(owner, "a2"));
        // The newest of the person's work waits behind the oldest left.
        return {
          newer: shown(await admit(owner, "a4")),
          older: shown(await admit(owner, "a3")),
        };
      }
    );

    expect(result).toStrictEqual({
      newer: "workflow.queued:app",
      older: "ok",
    });
  });

  it("stop a step that waited as long as a step may, though a share comes free before it asks again, and run none of its code", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("noop", "  return 1;"),
      ...workflowFiles(
        "counted",
        `  await step.do("work", { description: "Work" }, async () => {
    await env.APP.call("hit", "work");
    return 1;
  });
  return 1;`,
        { work: 1 }
      ),
    });
    const holderRun = await builder.api.workflows.start(app, "noop");
    await finished(holderRun.id);
    const holder = {
      run: holderRun.id,
      root: holderRun.id,
      subject: builder.userId,
      resource: app,
    };

    const result = await withShares(
      { workflowClientAttempts: 2, workflowQueuedStepMs: 8000 },
      async () => {
        const held = await admit(holder, "holder");
        const run = await builder.api.workflows.start(app, "counted");
        // Its share comes free at twelve seconds, after its eight are up.
        await scheduler.wait(12_000);
        if ("admitted" in held) {
          await held.admitted.settle();
        }
        await finished(run.id);
        return {
          failed: await failedWith(run.id),
          hits: await hitsOf(app, builder.userId, "work"),
        };
      }
    );

    expect(result).toStrictEqual({ failed: "workflow.queue_timeout", hits: 0 });
  });

  it("keep a queued run's places through a pause notification older than one it already took", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("noop", "  return 1;"),
      ...workflowFiles("work", `${working("work", 10)}\n  return 1;`, {
        work: 1,
      }),
    });
    const holderRun = await builder.api.workflows.start(app, "noop");
    await finished(holderRun.id);
    const holder = {
      run: holderRun.id,
      root: holderRun.id,
      subject: builder.userId,
      resource: app,
    };

    const result = await withShares({ workflowClientAttempts: 2 }, async () => {
      await admit(holder, "holder");
      const run = await builder.api.workflows.start(app, "work");
      await eventually(async () => {
        await expect(placesOf(run.id)).resolves.toBe(1);
      });
      // A pause the engine sent before the notifications the row took.
      await projectStatus(env, run.id, {
        status: "paused",
        at: Date.now(),
        sequence: 0,
      });
      const places = await placesOf(run.id);
      const summary = await builder.api.screens.summary(app, run.id);
      return { places, status: summary.status };
    });

    expect(result).toStrictEqual({ places: 1, status: "queued" });
  });

  it("count a step's wait for a share only while it waits for one, starting over once it was admitted and held for its person", async () => {
    const admin = await signedInApi(idp, "admin");
    const mail = await mailConnection([]);
    // A pause first, so the send is the step that waits for a share.
    const app = await appWith(admin, {
      ...workflowFiles("noop", "  return 1;"),
      ...workflowFiles(
        "mailer",
        `  await step.sleep("pause", { description: "Wait", duration: "3 seconds" });
  return await step.do("send", { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify(invoiceMail)}, retries: { limit: 0 } }, async ({ idempotencyKey, input: mail }) => JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output));`,
        { send: { messageId: "mocked" } }
      ),
    });
    await requestGranted(idp, admin, {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.send"],
      binding: "MAIL",
    });
    await appHost(env, appIdSchema.parse(app)).restrict();
    const holderRun = await admin.api.workflows.start(app, "noop");
    await finished(holderRun.id);
    const holder = {
      run: holderRun.id,
      root: holderRun.id,
      subject: admin.userId,
      resource: app,
    };

    const result = await withShares(
      { workflowClientAttempts: 2, workflowQueuedStepMs: 10_000 },
      async () => {
        const run = await admin.api.workflows.start(app, "mailer");
        // The share is taken as the run pauses: its send waits for it.
        await sleeping(run.id, "pause");
        const first = await admit(holder, "first holder");
        await eventually(async () => {
          await expect(placesOf(run.id)).resolves.toBe(1);
        });
        // It comes free: the send runs, and waits for the person.
        await settled(first);
        const pending = await eventually2(async () => {
          const listed = await admin.api.pendingActions.list();
          const held = listed.find(({ action }) => action === "mail.send");
          expect(held).toBeDefined();
          return held;
        });
        // The person takes longer than a step may wait for a share: none
        // of it is a wait for one.
        await scheduler.wait(12_000);
        // The share is taken again before they confirm: the send waits for
        // it once more, its ten seconds starting over.
        await admit(holder, "second holder");
        if (pending !== undefined) {
          await admin.api.pendingActions.confirm(pending.id, pending.inputHash);
        }
        // Once its next check saw the confirmation, it queues again.
        await eventually(async () => {
          await expect(placesOf(run.id)).resolves.toBe(1);
        });
        const queuedAgainAt = Date.now();
        await finished(run.id);
        return {
          failed: await failedWith(run.id),
          // Its whole ten seconds, not the five its first wait left.
          waitedAfresh: Date.now() - queuedAgainAt >= 8000,
        };
      }
    );

    expect(result).toStrictEqual({
      failed: "workflow.queue_timeout",
      waitedAfresh: true,
    });
  });

  it("count none of a pause as a step's wait for a share, and run the step once resumed, however long the pause", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("noop", "  return 1;"),
      ...workflowFiles("work", `${working("work", 10)}\n  return 1;`, {
        work: 1,
      }),
    });
    const holderRun = await builder.api.workflows.start(app, "noop");
    await finished(holderRun.id);
    const holder = {
      run: holderRun.id,
      root: holderRun.id,
      subject: builder.userId,
      resource: app,
    };

    const result = await withShares(
      { workflowClientAttempts: 2, workflowQueuedStepMs: 8000 },
      async () => {
        const held = await admit(holder, "holder");
        const run = await builder.api.workflows.start(app, "work");
        await eventually(async () => {
          await expect(placesOf(run.id)).resolves.toBe(1);
        });
        // Paused for longer than a step may wait for a share.
        await stopped(run.id);
        await scheduler.wait(10_000);
        await settled(held);
        await resumed(run.id);
        await finished(run.id);
        return {
          failed: (await failedWith(run.id)) ?? null,
          status: await liveStatus(run.id),
        };
      }
    );

    expect(result).toStrictEqual({ failed: null, status: "complete" });
  });

  it("record that a run waits each time it joins the queue, as when it rejoins after a pause", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("noop", "  return 1;"),
      ...workflowFiles("work", `${working("work", 10)}\n  return 1;`, {
        work: 1,
      }),
    });
    const holderRun = await builder.api.workflows.start(app, "noop");
    await finished(holderRun.id);
    const holder = {
      run: holderRun.id,
      root: holderRun.id,
      subject: builder.userId,
      resource: app,
    };

    const waits = await withShares({ workflowClientAttempts: 2 }, async () => {
      const held = await admit(holder, "holder");
      const run = await builder.api.workflows.start(app, "work");
      await eventually(async () => {
        await expect(waitsOf(run.id)).resolves.toBe(1);
      });
      // Paused, it gives up its place; resumed, it joins again.
      await stopped(run.id);
      await eventually(async () => {
        await expect(placesOf(run.id)).resolves.toBe(0);
      });
      await resumed(run.id);
      await eventually(async () => {
        await expect(placesOf(run.id)).resolves.toBe(1);
      });
      await eventually(async () => {
        await expect(waitsOf(run.id)).resolves.toBe(2);
      }, 15_000);
      await settled(held);
      await finished(run.id);
      return await waitsOf(run.id);
    });

    expect(waits).toBe(2);
  });

  it("take no place in the queue for a run cancelled as its attempt was refused", async () => {
    const builder = await signedInApi(idp, "builder");
    const holder = await ownerOf(builder);
    const owner = await anotherRun(builder, holder);
    // The run is cancelled just before its refusal's place is written.
    const database = env.DB;
    let queuing = false;
    const cancelling = new Proxy(database, {
      get: (target, property) => {
        if (property === "prepare") {
          return (query: string) => {
            queuing ||= query.includes(
              'insert into "workflow_admission_queue"'
            );
            return target.prepare(query);
          };
        }
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (queuing) {
              queuing = false;
              await target
                .prepare(
                  "UPDATE workflow_runs SET status = 'cancelled', cancel_requested_at = ? WHERE id = ?"
                )
                .bind(Date.now(), owner.run)
                .run();
            }
            return await target.batch(statements);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });

    const result = await withShares(
      { workflowClientAttempts: 2, workflowAppAttempts: 1 },
      async () => {
        await admit(holder, "holder");
        const refused = codeOf(
          await admitAttempt(
            { ...env, DB: cancelling },
            owner,
            attemptOf("cancelled")
          ).then(
            () => null,
            (error: unknown) => error
          )
        );
        return { refused, places: await placesOf(owner.run) };
      }
    );

    expect(result).toStrictEqual({
      refused: "execution.stale_attempt",
      places: 0,
    });
  });

  it("stop a step that waited longer than the cap the operator lowered meanwhile, before any of its code runs", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("noop", "  return 1;"),
      ...idle,
      ...workflowFiles(
        "counted",
        `  await step.do("work", { description: "Work" }, async () => {
    await env.APP.call("hit", "work");
    return 1;
  });
  return 1;`,
        { work: 1 }
      ),
    });
    const holderRun = await idleRun(builder, app);
    const holder = {
      run: holderRun,
      root: holderRun,
      subject: builder.userId,
      resource: app,
    };

    const result = await withShares({ workflowClientAttempts: 2 }, async () => {
      const held = await admit(holder, "holder");
      const run = await builder.api.workflows.start(app, "counted");
      // Ten seconds into its wait, the operator lowers the cap to eight,
      // and its share comes free before it asks again.
      await scheduler.wait(10_000);
      policyWith({ workflowClientAttempts: 2, workflowQueuedStepMs: 8000 });
      await settled(held);
      await finished(run.id);
      return {
        failed: await failedWith(run.id),
        hits: await hitsOf(app, builder.userId, "work"),
      };
    });

    expect(result).toStrictEqual({ failed: "workflow.queue_timeout", hits: 0 });
  });

  it("keep a step waiting past the cap its last refusal named, once the operator raised it as the step slept", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("noop", "  return 1;"),
      ...idle,
      ...workflowFiles(
        "counted",
        `  await step.do("work", { description: "Work" }, async () => {
    await env.APP.call("hit", "work");
    return 1;
  });
  return 1;`,
        { work: 1 }
      ),
    });
    const holderRun = await idleRun(builder, app);
    const holder = {
      run: holderRun,
      root: holderRun,
      subject: builder.userId,
      resource: app,
    };

    const result = await withShares(
      { workflowClientAttempts: 2, workflowQueuedStepMs: 8000 },
      async () => {
        const held = await admit(holder, "holder");
        const run = await builder.api.workflows.start(app, "counted");
        // Its second round sleeps until its eight seconds are up, as its
        // refusal said; the operator raises the cap as it sleeps, and its
        // share comes free.
        await eventually(async () => {
          await expect(loadWaitsOf(run.id)).resolves.toHaveLength(2);
        });
        policyWith({ workflowClientAttempts: 2 });
        await settled(held);
        await finished(run.id);
        return {
          failed: (await failedWith(run.id)) ?? null,
          status: await liveStatus(run.id),
          hits: await hitsOf(app, builder.userId, "work"),
        };
      }
    );

    expect(result).toStrictEqual({
      failed: null,
      status: "complete",
      hits: 1,
    });
  });
});

import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";
import { z } from "zod";

import { admitAttempt } from "../src/workflows/quotas.ts";
import type {
  AttemptAdmission,
  AttemptOwner,
} from "../src/workflows/quotas.ts";
import { allEvents } from "./audit-events.ts";
import { runObject, sleeping } from "./runs.ts";
import type { signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// What the fair-admission*.test.ts files share: fair admission of the
// client's workflow attempts (admission.ts), its tests split across files
// so a CI run can run them apart. Each file calls `mockIdp()` itself: it
// registers that file's own hooks.

/** Someone signed in, with their API. */
type Builder = Awaited<ReturnType<typeof signedInApi>>;

/** The generation of the next policy a test sets: each higher than before. */
let generations = 100;

/** The limits the tests' deployment sets (vite.config.ts). */
const configuredLimits = quotaLimitsSchema.parse(env.QUOTA_LIMITS).limits;

/** Sets the operator's policy to the deployment's, with `limits` lowered. */
export const policyWith = (limits: Record<string, number>): void => {
  generations += 1;
  env.QUOTA_LIMITS = {
    generation: generations,
    limits: { ...configuredLimits, ...limits },
  };
};

/** The admissions a test made: settled once it is over (`withShares`). */
export const admitted: AttemptAdmission[] = [];

/**
 * What `run` returns, with the operator's quota policy `limits` in force;
 * the deployment's own limits again after it, under a newer generation.
 * The client's shares are the whole deployment's: once it is over, what
 * the test admitted settles and what it queued stops waiting, as its runs
 * would, so the next test starts with every share free.
 */
export const withShares = async <Result>(
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
export const idle = workflowFiles(
  "idle",
  `  await step.sleep("idle", { description: "Wait", duration: "1 day" });
  return 1;`
);

/** A run of `app`'s idle workflow, waiting. */
export const idleRun = async (
  builder: Builder,
  app: string
): Promise<string> => {
  const run = await builder.api.workflows.start(app, "idle");
  await sleeping(run.id, "idle");
  return run.id;
};

export const ownerOf = async (builder: Builder): Promise<AttemptOwner> => {
  const app = await appWith(builder, {
    ...workflowFiles("noop", "  return 1;"),
    ...idle,
  });
  const run = await idleRun(builder, app);
  return { run, root: run, subject: builder.userId, resource: app };
};

/** Another run of `owner`'s App, for the same person. */
export const anotherRun = async (
  builder: Builder,
  owner: AttemptOwner
): Promise<AttemptOwner> => {
  const run = await idleRun(builder, owner.resource);
  return { ...owner, run, root: run };
};

/**
 * The activation generation of the attempts a test admits as a run's host
 * would: past any the engine ran of the runs they are admitted for (a few
 * each), as the run's next activation. An attempt of a generation the
 * engine has fenced takes no share (quotas.ts, `sharesReleased`).
 */
export const testGeneration = 100;

/** A first attempt at step `step`, holding until `ms` from now. */
export const attemptOf = (step: string, ms = 60_000) => ({
  key: `key-${step}`,
  step,
  number: 1,
  generation: testGeneration,
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
export const codeOf = (error: unknown): string =>
  z.object({ code: z.string() }).safeParse(error).data?.code ?? String(error);

/**
 * Admits `step` of `owner`'s, answering its admission or its refusal: as
 * an attempt of an activation `later` generations past the test's.
 */
export const admit = async (
  owner: AttemptOwner,
  step: string,
  ms?: number,
  later = 0
): Promise<
  | { admitted: AttemptAdmission }
  | { refused: string; waitingFor?: string; retryAfterSeconds?: number }
> => {
  try {
    const attempt = attemptOf(step, ms);
    const admission = await admitAttempt(env, owner, {
      ...attempt,
      generation: attempt.generation + later,
    });
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
export const shown = (answer: Awaited<ReturnType<typeof admit>>): string =>
  "admitted" in answer
    ? "ok"
    : [answer.refused, answer.waitingFor].filter(Boolean).join(":");

/** A step that takes about `ms`, then returns 1. */
export const working = (name: string, ms: number) =>
  `  await step.do("${name}", { description: "Work" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, ${ms}));
    return 1;
  });`;

/** Admits `attempt` of `owner`'s as its host would, answering as `shown`. */
export const admitExactly = async (
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
export const asPerson = (
  owner: AttemptOwner,
  subject: string
): AttemptOwner => ({
  ...owner,
  subject,
});

/**
 * Moves what core's database recorded `ms` into the past, for `table`'s
 * rows `where` picks: time passing for them, as it would.
 */
export const aged = async (
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
export const waitsOf = async (run: string): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    ({ action, target }) =>
      action === "workflow.run.waiting" && target?.id === run
  ).length;
};

/** How long each of `run`'s rounds waiting for load slept, in order. */
export const loadWaitsOf = async (run: string): Promise<number[]> =>
  await runInDurableObject(runObject(run), (_object, state) =>
    state.storage.sql
      .exec<{ ms: number }>(
        "SELECT duration_ms AS ms FROM steps WHERE type IN ('sleep', 'waitForEvent') AND name LIKE '%:busy:%' ORDER BY ordinal"
      )
      .toArray()
      .map(({ ms }) => ms)
  );

/**
 * When each of `run`'s rounds waiting for load wakes, in order: its
 * sleep's deadline, as journaled.
 */
export const loadWakesOf = async (run: string): Promise<number[]> =>
  await runInDurableObject(runObject(run), (_object, state) =>
    state.storage.sql
      .exec<{ at: number }>(
        "SELECT deadline AS at FROM steps WHERE type IN ('sleep', 'waitForEvent') AND name LIKE '%:busy:%' ORDER BY ordinal"
      )
      .toArray()
      .map(({ at }) => at)
  );

/**
 * Once `run` waits in round `round` of waiting for load, or a later one:
 * the engine has the run waiting, its latest round's wait under way. With
 * `end`, round `round` then ends now, as its time passing would (`woken`):
 * its deadline, and the run's alarm with it, moved to now; a round that
 * already ended on its own (a runner stalled past it) is left be. Read and
 * moved in one go in the run's object, so the round can't end on its own
 * between the two. A test drives rounds so, round by round, instead of
 * sleeping for as long as it guesses they take on a busy runner.
 */
export const inRound = async (
  run: string,
  round: number,
  { end = false } = {}
): Promise<void> => {
  await vi.waitFor(
    async () => {
      const waiting = await runInDurableObject(
        runObject(run),
        async (_object, state) => {
          const { sql } = state.storage;
          const [current] = sql
            .exec<{ status: string }>("SELECT status FROM run")
            .toArray();
          const rounds = sql
            .exec<{ ordinal: number; state: string }>(
              "SELECT ordinal, state FROM steps WHERE type IN ('sleep', 'waitForEvent') AND name LIKE '%:busy:%' ORDER BY ordinal"
            )
            .toArray();
          const latest = rounds.at(-1);
          if (
            current?.status !== "waiting" ||
            rounds.length < round ||
            latest?.state !== "waiting"
          ) {
            return false;
          }
          if (end && rounds.length === round) {
            const now = Date.now();
            sql.exec(
              "UPDATE steps SET deadline = ? WHERE ordinal = ?",
              now,
              latest.ordinal
            );
            sql.exec("UPDATE run SET wake_at = ?", now);
            await state.storage.setAlarm(now);
          }
          return true;
        }
      );
      expect(waiting).toBeTruthy();
    },
    { timeout: 20_000, interval: 100 }
  );
};

/**
 * Keeps the first lease of `run`'s attempts ending a second from now, again
 * and again, until the returned stop is called: as when those ahead take
 * each lease as it ends, so a step waiting for the share is told, round
 * after round, that it comes free in a second, and never finds it free.
 */
export const endingEverySecond = (run: string): (() => Promise<void>) => {
  const ticking = { going: true };
  const kept = (async () => {
    while (ticking.going) {
      // oxlint-disable-next-line no-await-in-loop -- each tick
      await env.DB.prepare(
        "UPDATE run_lineage_attempts SET admitted_at = ? - reserved_ms WHERE run_id = ? AND settled_at IS NULL"
      )
        .bind(Date.now() + 1000, run)
        .run();
      // oxlint-disable-next-line no-await-in-loop -- each tick
      await scheduler.wait(200);
    }
  })();
  return async () => {
    ticking.going = false;
    await kept;
  };
};

/** How many of `run`'s attempts hold their share now: unsettled. */
export const holdingOf = async (run: string): Promise<number> =>
  (await env.DB.prepare(
    "SELECT count(*) AS held FROM run_lineage_attempts WHERE run_id = ? AND settled_at IS NULL"
  )
    .bind(run)
    .first<number>("held")) ?? 0;

/**
 * Core's environment, its database counting the statements that read the
 * quota policy (`policyReads`), as a settle would make them.
 */
export const countingPolicyReads = (): {
  env: Env;
  policyReads: () => number;
} => {
  const database = env.DB;
  let reads = 0;
  const counted = new Proxy(database, {
    get: (target, property) => {
      if (property === "prepare") {
        return (query: string) => {
          if (query.includes("quota_policies")) {
            reads += 1;
          }
          return target.prepare(query);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  return { env: { ...env, DB: counted }, policyReads: () => reads };
};

/** How `run` failed, as its `workflow.run.failed` event names it; none yet. */
export const failedWith = async (run: string): Promise<unknown> => {
  const events = await allEvents();
  return events.find(
    ({ action, target }) =>
      action === "workflow.run.failed" && target?.id === run
  )?.detail.error;
};

/** The places `run` holds in the client's queue now. */
export const placesOf = async (run: string): Promise<number> =>
  (await env.DB.prepare(
    "SELECT count(*) AS places FROM workflow_admission_queue WHERE run_id = ?"
  )
    .bind(run)
    .first<number>("places")) ?? 0;

/** Settles what `admit` admitted, if it did. */
export const settled = async (answer: Awaited<ReturnType<typeof admit>>) => {
  if ("admitted" in answer) {
    await answer.admitted.settle();
  }
};

/** What `read` answers once it passes, in up to 20 seconds. */
export const eventually2 = async <Value>(
  read: () => Promise<Value>
): Promise<Value> => await vi.waitFor(read, { timeout: 20_000, interval: 200 });

/** Once `check` passes, in up to `timeout` ms. */
export const eventually = async (
  check: () => Promise<void>,
  timeout = 40_000
): Promise<void> => {
  await vi.waitFor(check, { timeout, interval: 200 });
};

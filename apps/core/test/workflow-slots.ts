import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";
import { z } from "zod";

import { admitAttempt } from "../src/workflows/quotas.ts";
import type {
  AttemptAdmission,
  AttemptOwner,
} from "../src/workflows/quotas.ts";
import { allEvents } from "./audit-events.ts";
import { configuredLimits } from "./quota-limits.ts";
import { runObject, sleeping } from "./runs.ts";
import type { signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// What the workflow-slot*.test.ts files share: the limit on workflow
// attempts running at once (admission.ts). Each file calls `mockIdp()`
// itself: it registers that file's own hooks.

/** Someone signed in, with their API. */
type Builder = Awaited<ReturnType<typeof signedInApi>>;

/** Sets the quota limits to the deployment's, with `limits` lowered. */
const policyWith = (limits: Record<string, number>): void => {
  env.TEST_QUOTA_LIMITS = { ...configuredLimits, ...limits };
};

/** The admissions a test made: settled once it is over (`withShares`). */
export const admitted: AttemptAdmission[] = [];

/**
 * What `run` returns, with the quota limits `limits` lowered; the
 * deployment's own limits again after it. The slots are the whole
 * deployment's: once it is over, what the test admitted settles, as its
 * runs would, so the next test starts with every slot free.
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
  }
};

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

/** A new App of `builder`'s, and an idle run of it to admit attempts of. */
export const ownerOf = async (builder: Builder): Promise<AttemptOwner> => {
  const app = await appWith(builder, {
    ...workflowFiles("noop", "  return 1;"),
    ...idle,
  });
  const run = await idleRun(builder, app);
  return { run, root: run, resource: app };
};

/** Another run of `owner`'s App. */
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
 * engine has fenced takes no slot (quotas.ts, `sharesReleased`).
 */
export const testGeneration = 100;

/** A first attempt at step `step`, holding until `ms` from now. */
export const attemptOf = (step: string, ms = 60_000) => ({
  key: `key-${step}`,
  number: 1,
  generation: testGeneration,
  deadline: Date.now() + ms,
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
): Promise<{ admitted: AttemptAdmission } | { refused: string }> => {
  try {
    const attempt = attemptOf(step, ms);
    const admission = await admitAttempt(env, owner, {
      ...attempt,
      generation: attempt.generation + later,
    });
    admitted.push(admission);
    return { admitted: admission };
  } catch (error) {
    return { refused: codeOf(error) };
  }
};

/** What `admit` answered, as a word: `ok`, or the refusal's code. */
export const shown = (answer: Awaited<ReturnType<typeof admit>>): string =>
  "admitted" in answer ? "ok" : answer.refused;

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
    return codeOf(error);
  }
};

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

/** How long each of `run`'s rounds waiting for load slept, in order. */
export const loadWaitsOf = async (run: string): Promise<number[]> =>
  await runInDurableObject(runObject(run), (_object, state) =>
    state.storage.sql
      .exec<{ ms: number }>(
        "SELECT duration_ms AS ms FROM steps WHERE type = 'sleep' AND name LIKE '%:busy:%' ORDER BY ordinal"
      )
      .toArray()
      .map(({ ms }) => ms)
  );

/** How many of `run`'s attempts hold their slot now: unsettled. */
export const holdingOf = async (run: string): Promise<number> =>
  (await env.DB.prepare(
    "SELECT count(*) AS held FROM run_lineage_attempts WHERE run_id = ? AND settled_at IS NULL"
  )
    .bind(run)
    .first<number>("held")) ?? 0;

/** How `run` failed, as its `workflow.run.failed` event names it; none yet. */
export const failedWith = async (run: string): Promise<unknown> => {
  const events = await allEvents();
  return events.find(
    ({ action, target }) =>
      action === "workflow.run.failed" && target?.id === run
  )?.detail.error;
};

/** Settles what `admit` admitted, if it did. */
export const settled = async (answer: Awaited<ReturnType<typeof admit>>) => {
  if ("admitted" in answer) {
    await answer.admitted.settle();
  }
};

/** Once `check` passes, in up to `timeout` ms. */
export const eventually = async (
  check: () => Promise<void>,
  timeout = 40_000
): Promise<void> => {
  await vi.waitFor(check, { timeout, interval: 200 });
};

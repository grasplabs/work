import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import {
  admitAttempt,
  admitChild,
  quotaPolicy,
} from "../src/workflows/quotas.ts";
import { runActor, startRun } from "../src/workflows/runs.ts";
import { serverBuilt } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { racingDb } from "./racing-db.ts";
import { finished, runObject, sleeping, woken } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// A run lineage's quotas: how deep its runs nest, how many runs it starts,
// how often a step is tried and how long its steps run in all, each held
// to the deployment's quota policy (`QUOTA_LIMITS`, which a test sets as
// an operator would) and counted durably, so no retry, restart, child or
// wait starts a count afresh. Runs, the engine, the dispatcher and core's
// database are real. Child runs start the way core starts a run under
// another (`startRun`'s `parent`): no App or run can name a parent.

const idp = mockIdp();

/** Someone signed in, with their API. */
type Builder = Awaited<ReturnType<typeof signedInApi>>;

/**
 * The generation of the next policy a test sets: each a new one, higher
 * than any before, as an operator's must be (core applies none lower than
 * the highest it recorded, `quotaPolicy`).
 */
let generations = 100;

/** The policy core applies with `QUOTA_LIMITS` set to `value` (none: unset). */
const policyUnder = async (value?: unknown) => {
  env.QUOTA_LIMITS = value;
  const { generation, limits } = await quotaPolicy(env);
  return { generation, steps: limits.workflowSteps };
};

/** A policy setting `limits`, under a generation of its own. */
const nextPolicy = (limits: Record<string, number>) => {
  generations += 1;
  return { generation: generations, limits };
};

/** The limits the tests' deployment sets (vite.config.ts). */
const configuredLimits = quotaLimitsSchema.parse(env.QUOTA_LIMITS).limits;

/**
 * What `run` returns, with the operator's quota policy `limits` in force,
 * under a new generation; the deployment's own limits again after it,
 * under a newer one.
 */
const withQuotas = async <Result>(
  limits: Record<string, number>,
  run: () => Promise<Result>
): Promise<Result> => {
  const retryDelay = env.WORKFLOW_RETRY_DELAY_MS;
  env.QUOTA_LIMITS = nextPolicy(limits);
  // A step's retries come at once.
  env.WORKFLOW_RETRY_DELAY_MS = "0";
  try {
    return await run();
  } finally {
    env.QUOTA_LIMITS = nextPolicy(configuredLimits);
    if (retryDelay === undefined) {
      Reflect.deleteProperty(env, "WORKFLOW_RETRY_DELAY_MS");
    } else {
      env.WORKFLOW_RETRY_DELAY_MS = retryDelay;
    }
  }
};

/** Starts a run of `workflow` under `parent`, as core starts a child run. */
const startChild = async (
  app: string,
  workflow: string,
  parent: string,
  startedBy: string
): Promise<string> => {
  const parentRun = runIdSchema.parse(parent);
  const run = await startRun(env, {
    app: appIdSchema.parse(app),
    workflow: workflowIdSchema.parse(workflow),
    input: null,
    startedBy,
    actor: runActor({ id: parentRun, appId: app, workflowId: workflow }),
    parent: parentRun,
  });
  return run.id;
};

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

/** A step that takes about `ms`, then returns 1. */
const working = (name: string, ms: number) =>
  `  await step.do("${name}", { description: "Work" }, async () => {
    await scheduler.wait(${ms});
    return 1;
  });`;

/**
 * A workflow whose one step declares 40 retries, and whose every attempt
 * counts itself, then hangs until it times out.
 */
const hanging = (name: string) =>
  workflowFiles(
    name,
    `  return await step.do("hang", { description: "Hang", timeout: "1 second", retries: { limit: 40, delay: 1, backoff: "constant" } }, async () => {
    await env.APP.call("hit", "${name}");
    await new Promise(() => {});
  });`,
    { hang: null }
  );

/** A first attempt at the step `key`, holding `ms` from now: a minute unless said. */
const attemptOf = (key: string, ms = 60_000) => ({
  key,
  number: 1,
  generation: 1,
  deadline: Date.now() + ms,
});

/** How a refusal that says when to try again, `promise`'s, is coded. */
const refusalSchema = z.object({
  code: z.string(),
  details: z.object({ retryAfterSeconds: z.number() }),
});

/** How many times `run` waited for its busy lineage, as its journal has it. */
const busyWaitsOf = async (run: string): Promise<number> =>
  await runInDurableObject(
    runObject(run),
    (_object, state) =>
      state.storage.sql
        .exec<{ waits: number }>(
          "SELECT count(*) AS waits FROM steps WHERE type = 'sleep' AND name LIKE '%:busy:%'"
        )
        .one().waits
  );

/**
 * What `run` returns, with core's database failing the first read of the
 * quota policy meanwhile, as D1 can for a moment, and whether one failed.
 */
const withPolicyReadFailingOnce = async <Result>(
  run: () => Promise<Result>
): Promise<{ failed: boolean; value: Result }> => {
  const database = env.DB;
  let failed = false;
  env.DB = new Proxy(database, {
    get: (target, property) => {
      if (property === "prepare") {
        return (query: string) => {
          if (!failed && query.includes("quota_policies")) {
            failed = true;
            return target.prepare("SELECT broken_for_the_test()");
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
  try {
    return { value: await run(), failed };
  } finally {
    env.DB = database;
  }
};

/** An App with a workflow that does nothing, `noop`. */
const noopApp = async (builder: Builder): Promise<string> =>
  await appWith(builder, workflowFiles("noop", "  return 1;"));

describe("run lineage quotas", { timeout: 90_000 }, () => {
  it("nest a lineage no deeper than its levels, and start no more runs under its root than it may, however many start at once", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await noopApp(builder);

    const result = await withQuotas(
      { workflowNestingLevels: 3, workflowDescendantRuns: 5 },
      async () => {
        const root = await builder.api.workflows.start(app, "noop");
        const child = await startChild(app, "noop", root.id, builder.userId);
        const grandchild = await startChild(app, "noop", child, builder.userId);
        // A fourth level: refused, taking no slot.
        const tooDeep = await outcome(
          startChild(app, "noop", grandchild, builder.userId)
        );
        // Six more under the root at once: three slots are left.
        const racing = await Promise.all(
          Array.from(
            { length: 6 },
            async () =>
              await outcome(startChild(app, "noop", root.id, builder.userId))
          )
        );
        // Under the child too: the slots are the root's, whoever starts.
        const underChild = await outcome(
          startChild(app, "noop", child, builder.userId)
        );
        return { tooDeep, racing: racing.toSorted(), underChild };
      }
    );

    expect(result).toStrictEqual({
      tooDeep: "workflow.lineage_limit",
      racing: [
        "ok",
        "ok",
        "ok",
        "workflow.lineage_limit",
        "workflow.lineage_limit",
        "workflow.lineage_limit",
      ],
      underChild: "workflow.lineage_limit",
    });
  });

  it("admit a lineage's next child by the quota policy as it is then, counting on from what the lineage already started", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await noopApp(builder);
    const root = await builder.api.workflows.start(app, "noop");
    const start = async () =>
      await outcome(startChild(app, "noop", root.id, builder.userId));

    const atTwo = await withQuotas({ workflowDescendantRuns: 2 }, async () => [
      await start(),
      await start(),
      await start(),
    ]);
    // Raised (within the platform's): one more fits beside the two.
    const atThree = await withQuotas(
      { workflowDescendantRuns: 3 },
      async () => [await start(), await start()]
    );
    // Lowered again: none.
    const atOne = await withQuotas({ workflowDescendantRuns: 1 }, start);

    expect({ atTwo, atThree, atOne }).toStrictEqual({
      atTwo: ["ok", "ok", "workflow.lineage_limit"],
      atThree: ["ok", "workflow.lineage_limit"],
      atOne: "workflow.lineage_limit",
    });
  });

  it("try a step no more often than a step may be tried, however many retries its workflow declares, and fewer once the operator lowers it", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...hanging("declared"),
      ...hanging("lowered"),
    });
    await serverBuilt(app, 1);

    const declared = await withQuotas({}, async () => {
      const run = await builder.api.workflows.start(app, "declared");
      await finished(run.id);
      return run.id;
    });
    const lowered = await withQuotas(
      { workflowAttemptsPerStep: 2 },
      async () => {
        const run = await builder.api.workflows.start(app, "lowered");
        await finished(run.id);
        return run.id;
      }
    );

    const declaredRun = await builder.api.workflows.status(declared);
    expect({
      declared: await hitsOf(app, builder.userId, "declared"),
      lowered: await hitsOf(app, builder.userId, "lowered"),
      loweredWith: await failedWith(lowered),
      declaredStatus: declaredRun.status,
    }).toStrictEqual({
      declared: 5,
      lowered: 2,
      loweredWith: "workflow.too_many_attempts",
      declaredStatus: "failed",
    });
  });

  it("resume a run whose steps the engine journaled with the retries they declared, holding them to the ceiling only as each attempt is admitted", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "resumes",
        `  await step.do("a", { description: "First", retries: { limit: 40, delay: 1 } }, async () => 1);
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return await step.do("b", { description: "Second" }, async () => 2);`,
        { a: 1, b: 2 }
      )
    );
    const run = await builder.api.workflows.start(app, "resumes");
    await sleeping(run.id, "go");
    // The step's config as a release before the quota policy journaled
    // it: its 40 retries as declared. A replay must give the same.
    await runInDurableObject(runObject(run.id), (_object, state) => {
      state.storage.sql.exec(
        `UPDATE steps SET config = json_set(config, '$.limit', 40) WHERE name = 'a'`
      );
    });
    await woken(run.id, "go");
    await finished(run.id);
    const { status, output } = await builder.api.workflows.status(run.id);

    expect({ status, output }).toStrictEqual({
      status: "completed",
      output: 2,
    });
  });

  it("stop a lineage's steps once they have run its active time, across a restart, a long wait and a child, which starts no count of its own", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      // Two seconds of active time: a and b take 1.6, c takes the lineage
      // past it, and d finds none left. The day's wait between a and b
      // takes none, and the run is loaded anew after it.
      ...workflowFiles(
        "busy",
        `${working("a", 800)}
  await step.sleep("pause", { description: "Wait", duration: "1 day" });
${working("b", 800)}
${working("c", 800)}
${working("d", 800)}
  return 1;`,
        { a: 1, b: 1, c: 1, d: 1 }
      ),
      ...workflowFiles("child", `${working("e", 10)}\n  return 1;`, { e: 1 }),
    });

    const result = await withQuotas({ workflowActiveMs: 2000 }, async () => {
      const root = await builder.api.workflows.start(app, "busy");
      await woken(root.id, "pause");
      await finished(root.id);
      const child = await startChild(app, "child", root.id, builder.userId);
      await finished(child);
      return {
        root: await failedWith(root.id),
        child: await failedWith(child),
      };
    });

    expect(result).toStrictEqual({
      root: "workflow.lineage_limit",
      child: "workflow.lineage_limit",
    });
  });

  it("count an attempt that never returned as having used all it held, once its time has passed", async () => {
    const builder = await signedInApi(idp, "builder");
    // The hang's attempt never settles: its second counts once it times
    // out. With it, a and b take the lineage past its 2.5 seconds, and c
    // finds none left; without it, they wouldn't.
    const app = await appWith(
      builder,
      workflowFiles(
        "dies",
        `  try {
    await step.do("hang", { description: "Hang", timeout: "1 second", retries: { limit: 0 } }, async () => {
      await new Promise(() => {});
    });
  } catch {}
${working("a", 800)}
${working("b", 800)}
${working("c", 10)}
  return 1;`,
        { hang: null, a: 1, b: 1, c: 1 }
      )
    );

    const failed = await withQuotas({ workflowActiveMs: 2500 }, async () => {
      const run = await builder.api.workflows.start(app, "dies");
      await finished(run.id);
      return await failedWith(run.id);
    });

    expect(failed).toBe("workflow.lineage_limit");
  });

  it("admit attempts racing for a lineage's active time no further than it has, the same attempt once, and say when the lineage frees up", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await noopApp(builder);
    const root = await builder.api.workflows.start(app, "noop");
    await finished(root.id);
    const lineage = { run: root.id, root: root.id };
    // Each holds a minute: two fit within 150 seconds, a third is admitted
    // on the 30 seconds left, and the rest find it held.

    const result = await withQuotas({ workflowActiveMs: 150_000 }, async () => {
      const racing = await Promise.all(
        Array.from(
          { length: 8 },
          async (_, index) =>
            await outcome(admitAttempt(env, lineage, attemptOf(`k${index}`)))
        )
      );
      const busy = await admitAttempt(env, lineage, attemptOf("late")).then(
        () => null,
        (error: unknown) => refusalSchema.parse(error)
      );
      // The first attempt admitted again: it holds once, so it is in.
      const admitted = racing.indexOf("ok");
      const again = await outcome(
        admitAttempt(env, lineage, attemptOf(`k${admitted}`))
      );
      return { racing: racing.toSorted(), busy, again };
    });

    expect(result).toMatchObject({
      racing: [
        "ok",
        "ok",
        "ok",
        "workflow.lineage_busy",
        "workflow.lineage_busy",
        "workflow.lineage_busy",
        "workflow.lineage_busy",
        "workflow.lineage_busy",
      ],
      busy: { code: "workflow.lineage_busy" },
      again: "ok",
    });
    // When the first of the three gives its minute back.
    const wait = result.busy?.details.retryAfterSeconds ?? 0;
    expect(wait).toBeGreaterThan(50);
    expect(wait).toBeLessThanOrEqual(60);
  });

  it("wait out a lineage whose active time attempts under way hold, then run the step, spending none of its attempts", async () => {
    const builder = await signedInApi(idp, "builder");
    // Each attempt holds a minute (an attempt's default wall time) while it
    // works three seconds: three of them hold the lineage's 150 seconds,
    // so a fourth at once finds it busy, and waits until they are done.
    const app = await appWith(
      builder,
      workflowFiles(
        "slow",
        `  await step.do("work", { description: "Work", timeout: "2 minutes" }, async () => {
    await scheduler.wait(3000);
    return 1;
  });
  return 1;`,
        { work: 1 }
      )
    );

    const result = await withQuotas({ workflowActiveMs: 150_000 }, async () => {
      const root = await builder.api.workflows.start(app, "slow");
      const children = await Promise.all(
        Array.from(
          { length: 3 },
          async () => await startChild(app, "slow", root.id, builder.userId)
        )
      );
      const runs = [root.id, ...children];
      await Promise.all(
        runs.map(async (run) => {
          await finished(run);
        })
      );
      const statuses = await Promise.all(
        runs.map(async (run) => {
          const { status } = await builder.api.workflows.status(run);
          return status;
        })
      );
      const waits = await Promise.all(runs.map(busyWaitsOf));
      return {
        statuses,
        waited: waits.filter((count) => count > 0).length,
      };
    });

    expect(result.statuses).toStrictEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(result.waited).toBeGreaterThan(0);
  });

  it("name the seconds to a hold's deadline when a busy lineage refuses, for an attempt that runs past what it holds", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await noopApp(builder);
    const root = await builder.api.workflows.start(app, "noop");
    await finished(root.id);
    const lineage = { run: root.id, root: root.id };

    const wait = await withQuotas({ workflowActiveMs: 50_000 }, async () => {
      // Its deadline two minutes on: it holds a minute (an attempt's
      // default wall time), and that minute is already over.
      await admitAttempt(env, lineage, attemptOf("long", 120_000));
      await env.DB.prepare(
        "UPDATE run_lineage_attempts SET admitted_at = admitted_at - 61000 WHERE step_key = 'long'"
      ).run();
      const refusal = await admitAttempt(
        env,
        lineage,
        attemptOf("waiting")
      ).then(
        () => null,
        (error: unknown) => refusalSchema.parse(error)
      );
      return refusal?.details.retryAfterSeconds ?? 0;
    });

    // Until its deadline, not a second: its hold goes only as it settles.
    expect(wait).toBeGreaterThan(110);
    expect(wait).toBeLessThanOrEqual(120);
  });

  it("admit no attempt past its deadline, nor one already settled, as it returned or as its time passed", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await noopApp(builder);
    const root = await builder.api.workflows.start(app, "noop");
    await finished(root.id);
    const lineage = { run: root.id, root: root.id };

    const late = await outcome(
      admitAttempt(env, lineage, { ...attemptOf("late"), deadline: Date.now() })
    );
    // Returned and settled.
    const returned = attemptOf("returned");
    const admission = await admitAttempt(env, lineage, returned);
    await admission.settle();
    const afterReturn = await outcome(admitAttempt(env, lineage, returned));
    // Never returned: once its 50 ms have passed, the next admission
    // settles it as used up.
    const died = attemptOf("died", 50);
    await admitAttempt(env, lineage, died);
    const whileHolding = await outcome(admitAttempt(env, lineage, died));
    await scheduler.wait(100);
    const next = await outcome(admitAttempt(env, lineage, attemptOf("next")));
    const afterLapse = await outcome(admitAttempt(env, lineage, died));

    expect({ late, afterReturn, whileHolding, next, afterLapse }).toStrictEqual(
      {
        late: "execution.stale_attempt",
        afterReturn: "execution.stale_attempt",
        whileHolding: "ok",
        next: "ok",
        afterLapse: "execution.stale_attempt",
      }
    );
  });

  it("apply a policy only under a generation higher than any core recorded, or the highest with the limits recorded for it, and keep the last one otherwise", async () => {
    const first = nextPolicy({ workflowSteps: 50 });
    const higher = nextPolicy({ workflowSteps: 40 });

    const result = {
      first: await policyUnder(first),
      // The same generation again, as recorded: it applies.
      again: await policyUnder({ ...first, limits: { workflowSteps: 50 } }),
      // The same generation with other limits: the recorded ones hold.
      changed: await policyUnder({ ...first, limits: { workflowSteps: 10 } }),
      higher: await policyUnder(higher),
      // A lower generation, even as recorded once: ignored.
      lower: await policyUnder(first),
      // Taken away: the last recorded policy holds, not the platform's.
      unset: await policyUnder(),
    };
    env.QUOTA_LIMITS = nextPolicy(configuredLimits);

    expect(result).toStrictEqual({
      first: { generation: first.generation, steps: 50 },
      again: { generation: first.generation, steps: 50 },
      changed: { generation: first.generation, steps: 50 },
      higher: { generation: higher.generation, steps: 40 },
      lower: { generation: higher.generation, steps: 40 },
      unset: { generation: higher.generation, steps: 40 },
    });
  });

  it("go on with a run whose quota policy can't be read for a moment as it loads, and complete it", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "steady",
        `  return await step.do("a", { description: "Work" }, async () => 1);`,
        { a: 1 }
      )
    );
    const result = await withPolicyReadFailingOnce(async () => {
      const run = await builder.api.workflows.start(app, "steady");
      await finished(run.id);
      return await builder.api.workflows.status(run.id);
    });

    expect({
      failed: result.failed,
      status: result.value.status,
      output: result.value.output,
    }).toStrictEqual({ failed: true, status: "completed", output: 1 });
  });

  it("refuse a step past the policy's steps as it is admitted, whatever limit the run loaded with while the policy couldn't be read", async () => {
    const builder = await signedInApi(idp, "builder");
    // Its own steps a to g (the SDK's $params is outside the allowance):
    // f is its sixth.
    const app = await appWith(
      builder,
      workflowFiles(
        "long",
        `${["a", "b", "c", "d", "e", "f", "g"].map((name) => working(name, 1)).join("\n")}
  return 1;`,
        { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 }
      )
    );

    // The policy as the run's attempts are admitted: five steps. Its load
    // can't read it, and counts by the limit it last read.
    const result = await withQuotas(
      { workflowSteps: 5 },
      async () =>
        await withPolicyReadFailingOnce(async () => {
          const run = await builder.api.workflows.start(app, "long");
          await finished(run.id);
          return run.id;
        })
    );
    const events = await allEvents();

    expect({
      failed: result.failed,
      with: await failedWith(result.value),
      completed: events
        .filter(
          ({ action, target }) =>
            action === "workflow.step.completed" && target?.id === result.value
        )
        .map(({ detail }) => detail.step),
    }).toStrictEqual({
      failed: true,
      with: "workflow.lineage_limit",
      completed: ["$params", "a", "b", "c", "d", "e"],
    });
  });

  it("count only a run's own steps against the operator's allowance, so an allowance of one runs a one-step workflow and refuses a second step", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("one", `${working("a", 1)}\n  return 1;`, { a: 1 }),
      ...workflowFiles(
        "two",
        `${working("a", 1)}\n${working("b", 1)}\n  return 2;`,
        {
          a: 1,
          b: 1,
        }
      ),
    });

    const result = await withQuotas({ workflowSteps: 1 }, async () => {
      const one = await builder.api.workflows.start(app, "one");
      const two = await builder.api.workflows.start(app, "two");
      await Promise.all([finished(one.id), finished(two.id)]);
      const { status } = await builder.api.workflows.status(one.id);
      return { one: status, two: await failedWith(two.id) };
    });

    expect(result).toStrictEqual({
      one: "completed",
      two: "workflow.too_many_steps",
    });
  });

  it("admit by a generation recorded between an admission's read of the policy and its write, never by the older one it read", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await noopApp(builder);
    const root = await builder.api.workflows.start(app, "noop");
    await finished(root.id);
    const parent = { id: root.id, rootRunId: null, depth: 0 };
    // Each admission reads the policy under the platform's limits, then a
    // newer generation, allowing one attempt a step and one level, is
    // recorded just before its write.
    const racing = (newer: Record<string, number>) => {
      let recorded = false;
      return {
        ...env,
        DB: racingDb(async () => {
          if (!recorded) {
            recorded = true;
            await quotaPolicy({ ...env, QUOTA_LIMITS: nextPolicy(newer) });
          }
        }),
      };
    };

    const result = await withQuotas({}, async () => ({
      attempt: await outcome(
        admitAttempt(
          racing({ workflowAttemptsPerStep: 1 }),
          { run: root.id, root: root.id },
          { ...attemptOf("raced"), number: 2 }
        )
      ),
      child: await outcome(
        admitChild(racing({ workflowNestingLevels: 1 }), parent)
      ),
    }));

    expect(result).toStrictEqual({
      attempt: "workflow.too_many_attempts",
      child: "workflow.lineage_limit",
    });
  });

  it("measure a run's input in bytes of its UTF-8 JSON, not in characters", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await noopApp(builder);
    // 70,000 characters, 140,000 bytes: past the 128 KiB a run starts
    // with. As many ASCII characters fit.
    const accented = "é".repeat(70_000);
    const plain = "e".repeat(70_000);

    expect({
      accented: await outcome(
        builder.api.workflows.start(app, "noop", accented)
      ),
      plain: await outcome(builder.api.workflows.start(app, "noop", plain)),
    }).toStrictEqual({ accented: "workflow.invalid", plain: "ok" });
  });
});

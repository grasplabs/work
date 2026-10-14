import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { callApp } from "../src/app.ts";
import { admitAttempt, quotaPolicy } from "../src/workflows/quotas.ts";
import { runActor, startRun } from "../src/workflows/runs.ts";
import { serverBuilt } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { racingDb } from "./racing-db.ts";
import { finished, woken } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// A run lineage's host calls: every call its steps' attempts make through
// their hosts, counted durably on the lineage, held to the deployment's
// quota policy (`QUOTA_LIMITS`, which a test lowers as an operator would),
// so no retry, restart, child or attempt that dies mid-step starts the
// count afresh, and calls racing each other never pass it. Runs, the
// engine, the dispatcher and core's database are real.

const idp = mockIdp();

/** The policy generation of the next test's limits: each higher than before. */
let generations = 10_000;

/** A policy setting `limits`, under a generation of its own. */
const nextPolicy = (limits: Record<string, number>) => {
  generations += 1;
  return { generation: generations, limits };
};

/** The limits the tests' deployment sets (vite.config.ts). */
const configuredLimits = quotaLimitsSchema.parse(env.QUOTA_LIMITS).limits;

/**
 * What `run` returns, with the operator's quota policy `limits` in force;
 * the deployment's own limits again after it, under a newer generation.
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

/** The calls of `run` refused past its lineage's host calls, as audited. */
const refusedCalls = async (run: string): Promise<unknown[]> => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target, detail }) =>
        action === "workflow.call.refused" &&
        target?.id === run &&
        detail.errorCode === "workflow.lineage_limit"
    )
    .map(({ detail }) => detail.step);
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

/** A step `name` that calls the App's `hit` of its name `calls` times. */
const calling = (name: string, calls: number) =>
  `  await step.do("${name}", { description: "Call" }, async () => {
${Array.from({ length: calls }, () => `    await env.APP.call("hit", "${name}");`).join("\n")}
    return 1;
  });`;

/** A first attempt at the step `key`, holding `ms` from now: a minute unless said. */
const attemptOf = (key: string, ms = 60_000) => ({
  key,
  number: 1,
  generation: 1,
  deadline: Date.now() + ms,
});

/** Core's environment, with every statement sent to its database counted. */
const countingDb = () => {
  const counted = { statements: 0 };
  const database = new Proxy(env.DB, {
    get: (target, property) => {
      if (property === "prepare") {
        return (query: string) => {
          counted.statements += 1;
          return target.prepare(query);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  return { counted, env: { ...env, DB: database } };
};

/**
 * Core's database, each batch sent once `armed` held a moment: one sent
 * meanwhile goes first, as another isolate's write can land between this
 * one's check and its write.
 */
const reorderingDb = () => {
  const control = { armed: false };
  let held: ((value: null) => void) | undefined;
  const database = new Proxy(env.DB, {
    get: (target, property) => {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (control.armed) {
            const overtaken = held;
            if (overtaken === undefined) {
              const { promise, resolve } = Promise.withResolvers<null>();
              held = resolve;
              await Promise.race([promise, scheduler.wait(300)]);
              held = undefined;
            } else {
              const result = await target.batch(statements);
              overtaken(null);
              return result;
            }
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
  return { control, env: { ...env, DB: database } };
};

/** The host calls `root`'s lineage counts now. */
const lineageHostCalls = async (root: string): Promise<unknown> => {
  const row = await env.DB.prepare(
    "SELECT host_calls AS calls FROM run_lineages WHERE root_run_id = ?"
  )
    .bind(root)
    .first<{ calls: number }>();
  return row?.calls;
};

/** A run of an App's no-op workflow, finished: the root of a lineage. */
const lineageOf = async () => {
  const builder = await signedInApi(idp, "builder");
  const app = await appWith(builder, workflowFiles("noop", "  return 1;"));
  const root = await builder.api.workflows.start(app, "noop");
  await finished(root.id);
  return { run: root.id, root: root.id };
};

/** How a call refused past the lineage's host calls is coded. */
const refusalOf = async (
  call: Promise<void>
): Promise<string | { code?: unknown; details?: unknown }> => {
  try {
    await call;
    return "ok";
  } catch (error) {
    return error instanceof Error
      ? {
          code: Reflect.get(error, "code"),
          details: Reflect.get(error, "details"),
        }
      : String(error);
  }
};

describe("run lineage host calls", { timeout: 90_000 }, () => {
  it("count every host call of a lineage across retries of attempts that died mid-step, a restart and a child, and refuse the first past the limit", async () => {
    const builder = await signedInApi(idp, "builder");
    // Six calls in all: three attempts of `flaky` call once each and die
    // as they time out, never settling; `more` calls twice and `last`
    // once, after the run is loaded anew from a day's wait. `last` tries
    // twice more, catching each refusal, audited once. `over` and the
    // child, on its root's count, aren't admitted at all.
    const app = await appWith(builder, {
      ...workflowFiles(
        "calls",
        `  try {
    await step.do("flaky", { description: "Flaky", timeout: "1 second", retries: { limit: 2, delay: 1, backoff: "constant" } }, async () => {
      await env.APP.call("hit", "flaky");
      await new Promise(() => {});
    });
  } catch {}
  await step.sleep("pause", { description: "Wait", duration: "1 day" });
${calling("more", 2)}
  await step.do("last", { description: "Call" }, async () => {
    for (const _ of [1, 2, 3]) {
      try {
        await env.APP.call("hit", "last");
      } catch {}
    }
    return 1;
  });
${calling("over", 1)}
  return 1;`,
        { flaky: null, more: 1, last: 1, over: 1 }
      ),
      ...workflowFiles("child", `${calling("child", 1)}\n  return 1;`, {
        child: 1,
      }),
    });
    await serverBuilt(app, 1);

    const result = await withQuotas({ lineageHostCalls: 6 }, async () => {
      const root = await builder.api.workflows.start(app, "calls");
      await woken(root.id, "pause");
      await finished(root.id);
      const child = await startChild(app, "child", root.id, builder.userId);
      await finished(child);
      return {
        root: await failedWith(root.id),
        child: await failedWith(child),
        refused: await refusedCalls(root.id),
      };
    });
    const hits = Object.fromEntries(
      await Promise.all(
        ["flaky", "more", "last", "over", "child"].map(
          async (name) =>
            [name, await hitsOf(app, builder.userId, name)] as const
        )
      )
    );

    expect({ ...result, hits }).toStrictEqual({
      root: "workflow.lineage_limit",
      child: "workflow.lineage_limit",
      refused: ["last"],
      hits: { flaky: 3, more: 2, last: 1, over: 0, child: 0 },
    });
  });

  it("admit host calls racing within and across attempts no further than the lineage has, naming the limit, and give back what a settled attempt reserved and didn't make", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, workflowFiles("noop", "  return 1;"));
    const root = await builder.api.workflows.start(app, "noop");
    await finished(root.id);
    const lineage = { run: root.id, root: root.id };

    const result = await withQuotas({ lineageHostCalls: 50 }, async () => {
      // Three calls one after another: blocks of one, one and two, one of
      // which it gives back as it settles.
      const small = await admitAttempt(env, lineage, attemptOf("small"));
      const few = [
        await outcome(small.hostCall()),
        await outcome(small.hostCall()),
        await outcome(small.hostCall()),
      ];
      await small.settle();
      const first = await admitAttempt(env, lineage, attemptOf("first"));
      const second = await admitAttempt(env, lineage, attemptOf("second"));
      // Admitted now: once the lineage has no calls left, none would be.
      const third = await admitAttempt(env, lineage, attemptOf("third"));
      // Forty calls of each at once: eighty asked of fifty.
      const racing = await Promise.all(
        [first, second].flatMap((admission) =>
          Array.from(
            { length: 40 },
            async () => await outcome(admission.hostCall())
          )
        )
      );
      // Settled, each gives back the blocks it reserved and didn't use:
      // a third attempt makes the rest, and not one more.
      await Promise.all([first.settle(), second.settle()]);
      const rest = await Promise.all(
        Array.from({ length: 60 }, async () => await outcome(third.hostCall()))
      );
      // A settled attempt makes no call, though it had calls left.
      const afterSettle = await outcome(first.hostCall());
      const refusal = await refusalOf(third.hostCall());
      return { few, racing, rest, afterSettle, refusal };
    });
    const calls = [...result.few, ...result.racing, ...result.rest];
    const allowed = calls.filter((call) => call === "ok");
    const refused = calls.filter((call) => call !== "ok");

    expect({
      allowed: allowed.length,
      refusedWith: [...new Set(refused)],
      afterSettle: result.afterSettle,
      refusal: result.refusal,
    }).toStrictEqual({
      allowed: 50,
      refusedWith: ["workflow.lineage_limit"],
      afterSettle: "execution.stale_attempt",
      refusal: {
        code: "workflow.lineage_limit",
        details: {
          limit: "hostCalls",
          max: 50,
          generation: generations - 1,
        },
      },
    });
  });

  it("refuse an attempt's calls past the limit without asking the database again, and admit no new attempt of the lineage", async () => {
    const lineage = await lineageOf();
    const result = await withQuotas({ lineageHostCalls: 2 }, async () => {
      // Its environment as the policy is now.
      const { counted, env: counting } = countingDb();
      const admission = await admitAttempt(counting, lineage, attemptOf("a"));
      const allowed = [
        await outcome(admission.hostCall()),
        await outcome(admission.hostCall()),
      ];
      const first = await outcome(admission.hostCall());
      const before = counted.statements;
      const again = await Promise.all(
        Array.from(
          { length: 20 },
          async () => await outcome(admission.hostCall())
        )
      );
      const asked = counted.statements - before;
      const next = await refusalOf(
        admitAttempt(env, lineage, attemptOf("b")).then(() => {})
      );
      return { allowed, first, again: [...new Set(again)], asked, next };
    });

    expect(result).toStrictEqual({
      allowed: ["ok", "ok"],
      first: "workflow.lineage_limit",
      again: ["workflow.lineage_limit"],
      asked: 0,
      next: {
        code: "workflow.lineage_limit",
        details: {
          limit: "hostCalls",
          max: 2,
          generation: generations - 1,
        },
      },
    });
  });

  it("reserve a block by the policy as it is as the block is reserved, never by an older one read just before a newer was recorded", async () => {
    const lineage = await lineageOf();

    const result = await withQuotas({ lineageHostCalls: 50 }, async () => {
      // The first block is reserved under the policy allowing 50; the
      // second reads it too, but a policy allowing one call is recorded
      // just before its write.
      let lowered = false;
      const arm = { armed: false };
      const racing = {
        ...env,
        DB: racingDb(async () => {
          if (arm.armed && !lowered) {
            lowered = true;
            await quotaPolicy({
              ...env,
              QUOTA_LIMITS: nextPolicy({ lineageHostCalls: 1 }),
            });
          }
        }),
      };
      const admission = await admitAttempt(racing, lineage, attemptOf("a"));
      const first = await outcome(admission.hostCall());
      arm.armed = true;
      const second = await refusalOf(admission.hostCall());
      return { first, second, lowered };
    });

    expect(result).toStrictEqual({
      first: "ok",
      second: {
        code: "workflow.lineage_limit",
        details: { limit: "hostCalls", max: 1, generation: generations - 1 },
      },
      lowered: true,
    });
  });

  it("reserve nothing more for an attempt settled as having used up its time, though its code still calls", async () => {
    const lineage = await lineageOf();

    const result = await withQuotas({ lineageHostCalls: 50 }, async () => {
      // Its 200 ms pass, and the next admission settles it as used up.
      const died = await admitAttempt(env, lineage, attemptOf("died", 200));
      const before = await outcome(died.hostCall());
      await scheduler.wait(300);
      await admitAttempt(env, lineage, attemptOf("next"));
      const after = await outcome(died.hostCall());
      return { before, after };
    });

    expect(result).toStrictEqual({
      before: "ok",
      after: "execution.stale_attempt",
    });
  });

  it("give back a block a call was still reserving as its attempt settled, the attempt's function having returned without waiting for the call", async () => {
    const lineage = await lineageOf();

    const result = await withQuotas({ lineageHostCalls: 50 }, async () => {
      const { control, env: reordering } = reorderingDb();
      const admission = await admitAttempt(reordering, lineage, attemptOf("a"));
      // Four calls: blocks of one, one and two, all used.
      for (const _ of [1, 2, 3, 4]) {
        // oxlint-disable-next-line no-await-in-loop -- one call after the other
        await admission.hostCall();
      }
      control.armed = true;
      // A fifth, never awaited, reserves a block of four as the attempt
      // settles: whichever write lands first, the block comes back.
      const unawaited = outcome(admission.hostCall());
      await admission.settle();
      control.armed = false;
      return {
        unawaited: await unawaited,
        calls: await lineageHostCalls(lineage.root),
      };
    });

    expect(result).toStrictEqual({
      unawaited: "execution.stale_attempt",
      calls: 4,
    });
  });
});

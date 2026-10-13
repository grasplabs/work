import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { callApp } from "../src/app.ts";
import { admitAttempt } from "../src/workflows/quotas.ts";
import { runActor, startRun } from "../src/workflows/runs.ts";
import { serverBuilt } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
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

/** A first attempt at the step `key`, holding a minute from now. */
const attemptOf = (key: string) => ({
  key,
  number: 1,
  generation: 1,
  deadline: Date.now() + 60_000,
});

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
    // once, after the run is loaded anew from a day's wait; `over` finds
    // none left, and so does the child, on its root's count.
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
${calling("last", 1)}
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
      refused: ["over"],
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
      const third = await admitAttempt(env, lineage, attemptOf("third"));
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
});

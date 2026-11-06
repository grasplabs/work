import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { admitAttempt, admitInLineage } from "../src/workflows/quotas.ts";
import { mockIdp } from "./idp.ts";
import {
  endedRun,
  greetingTasks,
  jsonWorkflowAppsOf,
  liveLineage,
  publishedWorkflow,
  settles,
  startedBy,
} from "./json-workflow-apps.ts";
import { withQuotas } from "./quota-limits.ts";
import { liveStatus, runObject } from "./runs.ts";
import { outcome } from "./sign-in.ts";

// A run lineage's quotas: how deep its runs nest, how many runs it starts,
// how often a step is tried, how long its steps run in all and how many
// of its own steps a run takes, each held to the quota limits
// (`TEST_QUOTA_LIMITS`, which a test lowers to reach them) and counted
// durably on the lineage of an independent JSON workflow's run. Runs, the
// engine and core's database are real; the admissions a run's
// activations ask for, and the runs started in a run's lineage, are asked
// for here as core asks for them (quotas.ts `admitAttempt` and
// `admitInLineage`), so races and limits changed between them are reached.
//
// Covered elsewhere for JSON runs, and so not tried here:
// - A step tried at most as its attempts that ran allow, and failed once
//   its CPU time runs out in every activation: workflow-resource-runs'
//   "retries a step as often as its attempts that ran allow…" and "fails
//   a step stopped past its CPU time in every activation…".
// - An attempt the Loader cut off retried in a fresh activation:
//   workflow-resource-runs' "admits nothing of an attempt it cuts off…"
//   and "cuts off an attempt the activation's expression fuel can't fund…".
// - A run's own step limit: workflow-calls' "lowers the host's step limit,
//   never raises it".
// - A task's own timeout: workflow-calls' "ends an attempt that runs past
//   its task's timeout…".
// Only App workflows had these, written in TypeScript, and they go with
// them: a step's `timeout` and `retries` options given again on a replay,
// and options wider than the platform's written past the SDK.
// Not yet shown for a JSON run (GRA-1583): a lineage's active time
// counted on across a restart, a long wait and a child, which starts no
// count of its own.

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

/**
 * A first attempt at the step `key`, holding `ms` from now: a minute
 * unless said. Of an activation past any the engine ran of the run it is
 * admitted for, as its next one: an attempt of a generation the engine
 * has fenced is admitted no more (quotas.ts, `sharesReleased`).
 */
const attemptOf = (key: string, ms = 60_000) => ({
  key,
  step: key,
  number: 1,
  generation: 100,
  deadline: Date.now() + ms,
});

/** How a refusal that says when to try again is coded. */
const refusalSchema = z.object({
  code: z.string(),
  details: z.object({ retryAfterSeconds: z.number() }),
});

/** How a refusal at a lineage's limit is coded. */
const limitSchema = z.object({
  code: z.string(),
  details: z.object({ limit: z.string(), max: z.number() }),
});

/** What `promise` was refused with, at a lineage's limit; or "ok". */
const limitOf = async (promise: Promise<unknown>) =>
  await promise.then(
    () => "ok",
    (error: unknown) => {
      const { code, details } = limitSchema.parse(error);
      return { code, ...details };
    }
  );

const receiptSchema = z.object({
  key: z.string(),
  settled: z.number(),
  reserved: z.number(),
  used: z.number().nullable(),
});

/** The receipts of run `run`'s attempts (of step `key`, if given), as admitted. */
const lineageReceipts = async (run: string, key?: string) => {
  const { results } = await env.DB.prepare(
    "SELECT step_key AS key, settled_at IS NOT NULL AS settled, reserved_ms AS reserved, used_ms AS used FROM run_lineage_attempts WHERE run_id = ? AND (?2 IS NULL OR step_key = ?2) ORDER BY admitted_at, attempt"
  )
    .bind(run, key ?? null)
    .all();
  return z.array(receiptSchema).parse(results);
};

/** How many times run `run` waited for load, as its journal has it. */
const waitedForLoad = async (run: string): Promise<number> =>
  await runInDurableObject(
    runObject(run),
    (_object, state) =>
      state.storage.sql
        .exec<{ waits: number }>(
          "SELECT count(*) AS waits FROM steps WHERE type IN ('sleep', 'waitForEvent') AND name LIKE '%:busy:%'"
        )
        .one().waits
  );

/** The parent a child of the lineage of `root` sits under, at `depth`. */
const parentAt = (root: string, depth: number) =>
  depth === 0
    ? { id: root, rootRunId: null, depth }
    : { id: crypto.randomUUID(), rootRunId: root, depth };

describe("run lineage quotas", { timeout: 90_000 }, () => {
  it("nest a lineage no deeper than its levels, and start no more runs under its root than it may, however many start at once", async () => {
    const { run, end } = await liveLineage(await signedIn("builder"));

    const result = await withQuotas(
      { workflowNestingLevels: 3, workflowDescendantRuns: 5 },
      async () => {
        const child = await outcome(admitInLineage(env, parentAt(run, 0)));
        const grandchild = await outcome(admitInLineage(env, parentAt(run, 1)));
        // A fourth level: refused, taking no slot.
        const tooDeep = await limitOf(admitInLineage(env, parentAt(run, 2)));
        // Six more under the root at once: three slots are left.
        const racing = await Promise.all(
          Array.from(
            { length: 6 },
            async () => await outcome(admitInLineage(env, parentAt(run, 0)))
          )
        );
        // Under the child too: the slots are the root's, whoever starts.
        const underChild = await limitOf(admitInLineage(env, parentAt(run, 1)));
        return {
          child,
          grandchild,
          tooDeep,
          racing: racing.toSorted(),
          underChild,
        };
      }
    );
    await end();

    expect(result).toStrictEqual({
      child: "ok",
      grandchild: "ok",
      tooDeep: { code: "workflow.lineage_limit", limit: "nesting", max: 3 },
      racing: [
        "ok",
        "ok",
        "ok",
        "workflow.lineage_limit",
        "workflow.lineage_limit",
        "workflow.lineage_limit",
      ],
      underChild: {
        code: "workflow.lineage_limit",
        limit: "descendants",
        max: 5,
      },
    });
  });

  it("admit a lineage's next child by the quota limits as they are then, counting on from what the lineage already started", async () => {
    const { run, end } = await liveLineage(await signedIn("builder"));
    const start = async () =>
      await outcome(admitInLineage(env, parentAt(run, 0)));

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
    await end();

    expect({ atTwo, atThree, atOne }).toStrictEqual({
      atTwo: ["ok", "ok", "workflow.lineage_limit"],
      atThree: ["ok", "workflow.lineage_limit"],
      atOne: "workflow.lineage_limit",
    });
  });

  it("try a step no more often than its attempts may be tried as the limit is then, counting the attempts that ran", async () => {
    const { owner, end } = await liveLineage(await signedIn("builder"));
    const attempt = (number: number) => ({ ...attemptOf("step"), number });
    /** Attempt `number`, admitted and settled as having run. */
    const ran = async (number: number) => {
      const admission = await admitAttempt(env, owner, attempt(number));
      await admission.settle();
      return "ok";
    };

    const result = await withQuotas(
      { workflowAttemptsPerStep: 2 },
      async () => ({
        first: await ran(1),
        second: await ran(2),
        third: await outcome(admitAttempt(env, owner, attempt(3))),
      })
    );
    // Raised: the step's third may run.
    const raised = await withQuotas(
      { workflowAttemptsPerStep: 3 },
      async () => await outcome(ran(3))
    );
    await end();

    expect({ ...result, raised }).toStrictEqual({
      first: "ok",
      second: "ok",
      third: "workflow.too_many_attempts",
      raised: "ok",
    });
  });

  it("count only a run's own steps against the allowance as it is then", async () => {
    const { owner, end } = await liveLineage(await signedIn("builder"));
    const step = (ordinal: number) => ({
      ...attemptOf(`step-${ordinal}`),
      ordinal,
    });

    const result = await withQuotas({ workflowSteps: 1 }, async () => ({
      first: await outcome(admitAttempt(env, owner, step(1))),
      second: await limitOf(admitAttempt(env, owner, step(2))),
    }));
    await end();

    expect(result).toStrictEqual({
      first: "ok",
      second: { code: "workflow.lineage_limit", limit: "steps", max: 1 },
    });
  });

  it("stop a lineage's steps once its attempts used its active time, counting one that never returned as having used all it held", async () => {
    const { owner, end } = await liveLineage(await signedIn("builder"));

    const result = await withQuotas({ workflowActiveMs: 1000 }, async () => {
      // Never settled: once its time has passed, the next admission
      // settles it as having used all it held, 1.5 seconds of the 1.
      const died = attemptOf("died", 1500);
      await admitAttempt(env, owner, died);
      await scheduler.wait(Math.max(0, died.deadline - Date.now()) + 50);
      return await limitOf(admitAttempt(env, owner, attemptOf("next")));
    });
    const [receipt] = await lineageReceipts(owner.run, "died");
    await end();

    expect({
      next: result,
      usedAllItHeld: receipt?.used === receipt?.reserved,
    }).toStrictEqual({
      next: { code: "workflow.lineage_limit", limit: "activeTime", max: 1000 },
      usedAllItHeld: true,
    });
  });

  it("admit attempts racing for a lineage's active time no further than it has, the same attempt once, and say when the lineage frees up", async () => {
    const { owner, end } = await liveLineage(await signedIn("builder"));
    // Each holds a minute: two fit within 150 seconds, a third is admitted
    // on the 30 seconds left, and the rest find it held.

    const result = await withQuotas({ workflowActiveMs: 150_000 }, async () => {
      const racing = await Promise.all(
        Array.from(
          { length: 8 },
          async (_, index) =>
            await outcome(admitAttempt(env, owner, attemptOf(`k${index}`)))
        )
      );
      const busy = await admitAttempt(env, owner, attemptOf("late")).then(
        () => null,
        (error: unknown) => refusalSchema.parse(error)
      );
      // The first attempt admitted again: it holds once, so it is in.
      const admitted = racing.indexOf("ok");
      const again = await outcome(
        admitAttempt(env, owner, attemptOf(`k${admitted}`))
      );
      return { racing: racing.toSorted(), busy, again };
    });
    await end();

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

  it("wait out a lineage whose active time an attempt under way holds, then run the step", async () => {
    const builder = await signedIn("builder");
    const { id } = await publishedWorkflow(builder, greetingTasks("3 seconds"));
    // The run another attempt in the lineage is of, as a child's would be.
    const other = await liveLineage(builder);

    const result = await withQuotas({ workflowActiveMs: 6000 }, async () => {
      const runId = await startedBy(builder, id);
      // Its wait entered, as the engine journaled it.
      await vi.waitFor(async () => {
        await expect(liveStatus(runId)).resolves.toBe("waiting");
      }, settles);
      // Another attempt in the lineage, holding six and a half seconds,
      // more than the lineage's six: the greeting after the wait finds it
      // busy.
      const holder = await admitAttempt(
        env,
        { ...other.owner, root: runId },
        attemptOf("holder", 6500)
      );
      await vi.waitFor(async () => {
        await expect(waitedForLoad(runId)).resolves.toBeGreaterThan(0);
      }, settles);
      // It returns, having used only the seconds it was out of the
      // lineage's time.
      await holder.settle();
      return await endedRun(builder, id, runId);
    });
    await other.end();

    expect({ status: result.status, output: result.output }).toStrictEqual({
      status: "completed",
      output: { status: "Hello, Ada" },
    });
  });

  it("name the seconds to a hold's deadline when a busy lineage refuses, for an attempt that runs past what it holds", async () => {
    const { owner, end } = await liveLineage(await signedIn("builder"));

    const wait = await withQuotas({ workflowActiveMs: 50_000 }, async () => {
      // Its deadline two minutes on: it holds a minute (an attempt's
      // default wall time), and that minute is already over.
      await admitAttempt(env, owner, attemptOf("long", 120_000));
      await env.DB.prepare(
        "UPDATE run_lineage_attempts SET admitted_at = admitted_at - 61000 WHERE run_id = ? AND step_key = 'long'"
      )
        .bind(owner.run)
        .run();
      const refusal = await admitAttempt(env, owner, attemptOf("waiting")).then(
        () => null,
        (error: unknown) => refusalSchema.parse(error)
      );
      return refusal?.details.retryAfterSeconds ?? 0;
    });
    await end();

    // Until its deadline, not a second: its hold goes only as it settles.
    expect(wait).toBeGreaterThan(110);
    expect(wait).toBeLessThanOrEqual(120);
  });

  it("admit no attempt past its deadline, nor one already settled, as it returned or as its time passed", async () => {
    const { owner, end } = await liveLineage(await signedIn("builder"));

    const late = await outcome(
      admitAttempt(env, owner, { ...attemptOf("late"), deadline: Date.now() })
    );
    // Returned and settled.
    const returned = attemptOf("returned");
    const admission = await admitAttempt(env, owner, returned);
    await admission.settle();
    const afterReturn = await outcome(admitAttempt(env, owner, returned));
    // Never returned: once its time has passed, the next admission
    // settles it as used up. Long enough that asking again while it holds
    // is still within it on a slow runner.
    const died = attemptOf("died", 1500);
    await admitAttempt(env, owner, died);
    const whileHolding = await outcome(admitAttempt(env, owner, died));
    await scheduler.wait(1600);
    const next = await outcome(admitAttempt(env, owner, attemptOf("next")));
    const afterLapse = await outcome(admitAttempt(env, owner, died));
    await end();

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

  it("measure a start's input in bytes of its UTF-8 JSON, not in characters", async () => {
    const builder = await signedIn("builder");
    const { id } = await publishedWorkflow(builder, greetingTasks());
    // 70,000 characters, 140,000 bytes: past the 128 KiB a run starts
    // with. As many ASCII characters fit.
    const start = async (who: string) =>
      await outcome(
        builder.api.workflowResources.start(id, {
          version: 1,
          input: { who },
          key: crypto.randomUUID(),
        })
      );

    expect({
      accented: await start("é".repeat(70_000)),
      plain: await start("e".repeat(70_000)),
    }).toStrictEqual({ accented: "workflow.start_invalid", plain: "ok" });
  });
});

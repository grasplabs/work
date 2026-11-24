import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { admitAttempt } from "../src/workflows/quotas.ts";
import { mockIdp } from "./idp.ts";
import { jsonWorkflowAppsOf, liveLineage } from "./json-workflow-apps.ts";
import { withQuotas } from "./quota-limits.ts";
import { outcome } from "./sign-in.ts";

// A run lineage's host calls: every call its steps' attempts make through
// their hosts, counted durably on the lineage of an independent JSON
// workflow's run, held to the quota limits (`TEST_QUOTA_LIMITS`, which a
// test lowers to reach them), so calls racing each other never pass it
// and a settled attempt makes none. The admissions are asked for here as
// a run's activations ask for them (quotas.ts `admitAttempt`); the run,
// the engine and core's database are real.
//
// That a run's lineage counts its host calls across a CPU kill and the
// retry under the same key, failing the run past them, is
// workflow-resource-runs' "fails a run whose expressions would take its
// lineage past its host calls…"; that a call past them is refused unsent,
// workflow-calls' "refuses a call once its run's lineage has made all the
// host calls it may…". Calls made from code between an App workflow's
// steps went with App workflows.

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

/**
 * A first attempt at the step `key`, holding `ms` from now: a minute
 * unless said. Of an activation past any the engine ran of the run it is
 * admitted for, as its next one: an attempt of a generation the engine
 * has fenced is admitted no more (quotas.ts, `sharesReleased`).
 */
/** How long an attempt meant to run out of time is given to start with. */
const attemptMs = 2000;

const attemptOf = (key: string, ms = 60_000) => ({
  key,
  step: key,
  number: 1,
  generation: 100,
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
  it("admit host calls racing within and across attempts no further than the lineage has, naming the limit, and give back what a settled attempt reserved and didn't make", async () => {
    const { owner: lineage, end } = await liveLineage(
      await signedIn("builder")
    );

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
    await end();
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
        },
      },
    });
  });

  it("refuse an attempt's calls past the limit without asking the database again, and admit no new attempt of the lineage", async () => {
    const { owner: lineage, end } = await liveLineage(
      await signedIn("builder")
    );
    const result = await withQuotas({ lineageHostCalls: 2 }, async () => {
      // Its environment as the limits are now.
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

    await end();

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
        },
      },
    });
  });

  it("reserve nothing more for an attempt settled as having used up its time, though its code still calls", async () => {
    const { owner: lineage, end } = await liveLineage(
      await signedIn("builder")
    );

    const result = await withQuotas({ lineageHostCalls: 50 }, async () => {
      // Its deadline passes, and the next admission settles it as used up.
      // Long enough to be admitted on a loaded runner: an attempt already
      // past its deadline is refused at admission (quotas.ts).
      const attempt = attemptOf("died", attemptMs);
      const died = await admitAttempt(env, lineage, attempt);
      const before = await outcome(died.hostCall());
      await scheduler.wait(Math.max(0, attempt.deadline - Date.now()) + 50);
      await admitAttempt(env, lineage, attemptOf("next"));
      const after = await outcome(died.hostCall());
      return { before, after };
    });

    await end();

    expect(result).toStrictEqual({
      before: "ok",
      after: "execution.stale_attempt",
    });
  });

  it("give back a block a call was still reserving as its attempt settled, the attempt's function having returned without waiting for the call", async () => {
    const { owner: lineage, end } = await liveLineage(
      await signedIn("builder")
    );

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

    await end();

    expect(result).toStrictEqual({
      unawaited: "execution.stale_attempt",
      calls: 4,
    });
  });
});

import type { RunNotification } from "@grasp-os/workerflow/run";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { queueLiveMs } from "../src/workflows/admission.ts";
import { admitAttempt } from "../src/workflows/quotas.ts";
import type { AttemptOwner } from "../src/workflows/quotas.ts";
import { projectStatus } from "../src/workflows/runs.ts";
import {
  withShares,
  idle,
  idleRun,
  ownerOf,
  anotherRun,
  testGeneration,
  attemptOf,
  codeOf,
  admit,
  shown,
  working,
  admitExactly,
  aged,
  waitsOf,
  holdingOf,
  failedWith,
  placesOf,
  settled,
  eventually,
} from "./fair-admission.ts";
import { mockIdp } from "./idp.ts";
import {
  finished,
  liveStatus,
  resumed,
  runInstance,
  runObject,
  stopped,
} from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// A queued run that pauses, resumes or is cancelled, and the shares of
// attempts the engine has fenced.
// The helpers and the rest of fair admission's tests: fair-admission.ts
// and the fair-admission*.test.ts files beside it.

const idp = mockIdp();

describe("fair workflow admission", { timeout: 120_000 }, () => {
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
      const summary = await builder.api.screens.frame(app, "").summary(run.id);
      return { places, status: summary.status };
    });

    expect(result).toStrictEqual({ places: 1, status: "queued" });
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
});

// Giving back the shares of attempts the engine has fenced (quotas.ts,
// `sharesReleased`; run-object.ts, `notify`), each way it could fail,
// deliberate attacks included, first:
//
// - A share kept by an attempt the engine gave up on: its run cancelled
//   while its code still runs, or paused after its activation died
//   mid-attempt, or taken over, keeps a newcomer waiting until the
//   attempt's deadline. It comes back as the run's object tells core, or
//   as the activation that took over is first admitted.
// - A notification late, or handed over again (a replay), freeing a share
//   a newer activation's attempt holds: what comes back is by the run's
//   fence as its object has it now, which only grows, never by what the
//   notification says.
// - A double grant: a fenced attempt's admission landing after its share
//   came back, or retried under the same key, takes another share. A
//   fenced generation, a cancelled run and an activation a newer one took
//   over admit nothing.
// - Releasing someone else's share: only the run's own attempts, of the
//   generations its own object fenced, are given back.

/** A step that takes about `ms` of its minute, then returns 1. */
const slow = (ms: number) =>
  workflowFiles(
    "slow",
    `  await step.do("slow", { description: "Work", timeout: "1 minute" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, ${ms}));
    return 1;
  });
  return 1;`,
    { slow: 1 }
  );

/** The generation of the activation that holds `run` now, in its object. */
const generationOf = async (run: string): Promise<number> =>
  await runInDurableObject(
    runObject(run),
    (_object, state) =>
      state.storage.sql
        .exec<{ generation: number }>("SELECT generation FROM run")
        .one().generation
  );

/** Kills `run`'s object, as a crash does: its activation dies mid-attempt. */
const killed = async (run: string): Promise<void> => {
  await runInDurableObject(runObject(run), (_object, state) => {
    state.abort("Killed by the test");
  }).catch(() => {
    // Aborting fails the call that aborted: that is the crash.
  });
};

/**
 * Hands `run`'s object a notification again, as the engine does when its
 * host didn't take it: `status` at `sequence`, as the run had it then.
 * `named`: the run the notification says it is of, `run` unless forged.
 */
const notifiedAgain = async (
  run: string,
  status: RunNotification["status"],
  sequence: number,
  named = run
): Promise<void> => {
  await runInDurableObject(runObject(run), async (object, state) => {
    const row = state.storage.sql
      .exec<{
        definition: string;
        version: string | null;
        run_uid: string;
        created_at: number;
      }>("SELECT definition, version, run_uid, created_at FROM run")
      .one();
    const notifications: RunNotification[] = [
      {
        workflow: row.definition,
        version: row.version ?? undefined,
        instanceId: named,
        runId: row.run_uid,
        createdAt: row.created_at,
        generation: 1,
        sequence,
        status,
        timestamp: Date.now(),
        firstActivatedAt: null,
      },
    ];
    // The engine's hook, protected: reached as the engine reaches it.
    const notify: unknown = Reflect.get(object, "notify");
    if (typeof notify !== "function") {
      throw new TypeError("A run's object takes its notifications");
    }
    const taken: unknown = await Reflect.apply(notify, object, [notifications]);
    expect(taken).toBeUndefined();
  });
};

/**
 * Whether `run`'s latest attempt, settled, was charged all it could use:
 * its deadline less its admission.
 */
const chargedToDeadline = async (run: string): Promise<boolean> =>
  (await env.DB.prepare(
    "SELECT settled_at IS NOT NULL AND used_ms = deadline - admitted_at AS full FROM run_lineage_attempts WHERE run_id = ? ORDER BY admitted_at DESC LIMIT 1"
  )
    .bind(run)
    .first<number>("full")) === 1;

/** The engine sequence of the latest notification `run`'s row took. */
const sequenceOf = async (run: string): Promise<number> =>
  (await env.DB.prepare(
    "SELECT engine_sequence AS sequence FROM workflow_runs WHERE id = ?"
  )
    .bind(run)
    .first<number>("sequence")) ?? 0;

/** Admits `step` of `owner`'s until it is admitted, in up to ten seconds. */
const admittedSoon = async (
  owner: AttemptOwner,
  step: string
): Promise<Awaited<ReturnType<typeof admit>>> =>
  await vi.waitFor(
    async () => {
      const answer = await admit(owner, step);
      expect(shown(answer)).toBe("ok");
      return answer;
    },
    { timeout: 10_000, interval: 200 }
  );

describe("a fenced workflow attempt's share", { timeout: 120_000 }, () => {
  it("come back within seconds when its run is cancelled while its code still runs, and never again for that run", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, { ...idle, ...slow(45_000) });
    const waiting = await idleRun(builder, app);
    const newcomer = {
      run: waiting,
      root: waiting,
      subject: builder.userId,
      resource: app,
    };

    const result = await withShares(
      { workflowClientAttempts: 2, workflowAppAttempts: 1 },
      async () => {
        const run = await builder.api.workflows.start(app, "slow");
        await eventually(async () => {
          await expect(holdingOf(run.id)).resolves.toBe(1);
        });
        const whileHeld = shown(await admit(newcomer, "new"));
        await builder.api.workflows.cancel(run.id);
        // Within seconds, though its code waits on for most of a minute.
        const newcomerIn = await admittedSoon(newcomer, "new");
        // Its share free again, an attempt of the cancelled run whose
        // admission lands now, of any generation, takes none: only the
        // fence stands in its way.
        await settled(newcomerIn);
        const late = await admitExactly(
          { ...newcomer, run: run.id, root: run.id },
          attemptOf("late")
        );
        return {
          whileHeld,
          afterCancel: shown(newcomerIn),
          late,
          holding: await holdingOf(run.id),
          chargedToDeadline: await chargedToDeadline(run.id),
        };
      }
    );

    expect(result).toStrictEqual({
      whileHeld: "workflow.queued:app",
      afterCancel: "ok",
      late: "execution.stale_attempt",
      holding: 0,
      // Its isolate may compute on, unstopped, until its deadline: its
      // lineage is charged for all of it.
      chargedToDeadline: true,
    });
  });

  it("never come back, nor move a run's record, for a batch handed to another run's object that names the run", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, { ...idle, ...slow(20_000) });
    const other = await idleRun(builder, app);
    const newcomer = {
      run: other,
      root: other,
      subject: builder.userId,
      resource: app,
    };

    const result = await withShares(
      { workflowClientAttempts: 2, workflowAppAttempts: 1 },
      async () => {
        const run = await builder.api.workflows.start(app, "slow");
        await eventually(async () => {
          await expect(holdingOf(run.id)).resolves.toBe(1);
        });
        // Another run's object handed a batch naming this run, paused.
        await notifiedAgain(other, "paused", 1_000_000, run.id);
        const summary = await builder.api.screens
          .frame(app, "")
          .summary(run.id);
        const answer = {
          holding: await holdingOf(run.id),
          newcomer: shown(await admit(newcomer, "new")),
          status: summary.status,
        };
        await builder.api.workflows.cancel(run.id);
        return answer;
      }
    );

    expect(result).toStrictEqual({
      holding: 1,
      newcomer: "workflow.queued:app",
      status: "running",
    });
  });

  it("come back as its run pauses after its activation died mid-attempt, and stay with the resumed activation's attempt through that pause handed over again", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, { ...idle, ...slow(15_000) });
    const waiting = await idleRun(builder, app);
    const newcomer = {
      run: waiting,
      root: waiting,
      subject: builder.userId,
      resource: app,
    };

    const result = await withShares(
      { workflowClientAttempts: 2, workflowAppAttempts: 1 },
      async () => {
        const run = await builder.api.workflows.start(app, "slow");
        await eventually(async () => {
          await expect(holdingOf(run.id)).resolves.toBe(1);
        });
        const dead = await generationOf(run.id);
        await killed(run.id);
        // Paused, the dead activation never lets go: the watchdog pauses
        // the run once its lease is up (now, here).
        await runInstance(run.id).pause();
        await runDurableObjectAlarm(runObject(run.id));
        await eventually(async () => {
          await expect(liveStatus(run.id)).resolves.toBe("paused");
        });
        const newcomerIn = await admittedSoon(newcomer, "new");
        await settled(newcomerIn);
        // An attempt of the dead activation whose admission lands now
        // takes no share: the run's object fenced its generation.
        const lateOfDead = await admitExactly(
          { ...newcomer, run: run.id, root: run.id },
          { ...attemptOf("late"), generation: dead }
        );
        await eventually(async () => {
          await expect(sequenceOf(run.id)).resolves.toBeGreaterThan(0);
        });
        const pausedAt = await sequenceOf(run.id);
        // Resumed, a new activation's attempt holds the share again.
        await resumed(run.id);
        await eventually(async () => {
          await expect(holdingOf(run.id)).resolves.toBe(1);
        });
        const resumedGeneration = await generationOf(run.id);
        // The pause handed over again, late: the share stays where it is.
        await notifiedAgain(run.id, "paused", pausedAt);
        const afterReplay = shown(await admit(newcomer, "newer"));
        const holding = await holdingOf(run.id);
        await finished(run.id);
        return {
          newerActivation: resumedGeneration > dead,
          afterPause: shown(newcomerIn),
          lateOfDead,
          afterReplay,
          holding,
          status: await liveStatus(run.id),
        };
      }
    );

    expect(result).toStrictEqual({
      newerActivation: true,
      afterPause: "ok",
      lateOfDead: "execution.stale_attempt",
      afterReplay: "workflow.queued:app",
      holding: 1,
      status: "complete",
    });
  });

  it("come back to the activation that took its run over, at its first admission of any step, and never to the attempts of the activation it replaced, under the same key or another", async () => {
    const builder = await signedInApi(idp, "builder");
    const owner = await ownerOf(builder);
    const other = await anotherRun(builder, owner);

    const result = await withShares(
      { workflowClientAttempts: 2, workflowAppAttempts: 1 },
      async () => {
        // The activation that dies mid-attempt holds the App's share.
        const dies = attemptOf("dies");
        const first = await admitExactly(owner, dies);
        // The engine took the run over: its next activation runs another
        // step, which finds the share the dead one held.
        const takeover = await admit(owner, "next", undefined, 1);
        // The dead activation's attempt, admitted again under its key,
        // and another of its steps, landing late: neither takes a share.
        const sameKey = await admitExactly(owner, dies);
        const anotherStep = await admitExactly(owner, attemptOf("late"));
        // Once the new activation's attempt settles, the share is free:
        // nothing of the dead one holds it.
        await settled(takeover);
        const otherRun = await admitExactly(other, attemptOf("other"));
        return {
          first,
          takeover: shown(takeover),
          sameKey,
          anotherStep,
          otherRun,
        };
      }
    );

    expect(result).toStrictEqual({
      first: "ok",
      takeover: "ok",
      sameKey: "execution.stale_attempt",
      anotherStep: "execution.stale_attempt",
      otherRun: "ok",
    });
  });
});

describe(
  "a fenced attempt's share and calls, after a takeover",
  { timeout: 120_000 },
  () => {
    it("stay with whoever the takeover gave its share to, though its own attempt queued, never an older activation's admission of another step landing late", async () => {
      const builder = await signedInApi(idp, "builder");
      const owner = await ownerOf(builder);
      const other = await anotherRun(builder, owner);

      const result = await withShares(
        { workflowClientAttempts: 2, workflowAppAttempts: 1 },
        async () => {
          const first = await admitExactly(owner, attemptOf("dies"));
          const otherWaits = await admitExactly(other, attemptOf("other"));
          // The engine took the run over: the new activation's attempt gives
          // back the dead one's share, which the waiter ahead of it is due.
          const takeover = shown(await admit(owner, "next", undefined, 1));
          // Both stop asking, their places lapse: the share is free.
          await aged(
            "workflow_admission_queue",
            "seen_at",
            "1 = 1",
            queueLiveMs + 1000
          );
          // An admission of the dead activation's, of another step, landing
          // now, takes none of it.
          const late = await admitExactly(owner, attemptOf("late"));
          return { first, otherWaits, takeover, late };
        }
      );

      expect(result).toStrictEqual({
        first: "ok",
        otherWaits: "workflow.queued:app",
        takeover: "workflow.queued:app",
        late: "execution.stale_attempt",
      });
    });

    it("give back once the host calls a fenced attempt reserved and didn't make, as its code returns, its time charged as it was", async () => {
      const builder = await signedInApi(idp, "builder");
      const owner = await ownerOf(builder);
      const callsMade = 5;
      const hostCalls = async (): Promise<number> =>
        (await env.DB.prepare(
          "SELECT host_calls AS calls FROM run_lineages WHERE root_run_id = ?"
        )
          .bind(owner.root)
          .first<number>("calls")) ?? 0;
      const usedOf = async (key: string): Promise<number | null> =>
        await env.DB.prepare(
          "SELECT used_ms AS used FROM run_lineage_attempts WHERE run_id = ? AND step_key = ?"
        )
          .bind(owner.run, key)
          .first<number | null>("used");

      const result = await withShares({}, async () => {
        const before = await hostCalls();
        const admission = await admitAttempt(env, owner, attemptOf("calls"));
        for (let call = 0; call < callsMade; call += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one call after another, as an attempt makes them
          await admission.hostCall();
        }
        // The engine took the run over: the new activation's first admission
        // settles the attempt, which still runs.
        const next = await admitAttempt(env, owner, {
          ...attemptOf("next"),
          generation: testGeneration + 1,
        });
        const reservedWhileFenced = (await hostCalls()) - before;
        const usedWhenFenced = await usedOf("key-calls");
        // Its code returns: what it reserved and didn't make comes back,
        // once, however often it settles.
        await admission.settle();
        await admission.settle();
        await next.settle();
        return {
          reservedMore: reservedWhileFenced > callsMade,
          charged: (await hostCalls()) - before,
          timeKept: (await usedOf("key-calls")) === usedWhenFenced,
        };
      });

      expect(result).toStrictEqual({
        reservedMore: true,
        charged: callsMade,
        timeKept: true,
      });
    });
  }
);

import { sha256Hex } from "@grasp-os/shared/encoding";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { runEngine } from "../src/workflows/engine.ts";
import { shareWakeType } from "../src/workflows/share-wakes.ts";
import {
  withShares,
  ownerOf,
  admit,
  shown,
  working,
  loadWaitsOf,
  loadWakesOf,
  endingEverySecond,
  holdingOf,
  settled,
  eventually2,
  eventually,
} from "./fair-admission.ts";
import { mockIdp } from "./idp.ts";
import { finished, liveStatus, stopped } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// A queued step woken as a share comes free (share-wakes.ts), rather than
// at the end of the round it sleeps in, and asking again for a wake no
// share sent.
// The helpers and the rest of fair admission's tests: fair-admission.ts
// and the fair-admission*.test.ts files beside it.

const idp = mockIdp();

describe("fair workflow admission", { timeout: 120_000 }, () => {
  it("ask again at the end of the round it sleeps in once a share comes free, and run", async () => {
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
      { workflowClientAttempts: 2, workflowQueuedStepMs: 60_000 },
      async () => {
        const held = await admit(holder, "holder");
        const stop = endingEverySecond(holderRun.id);
        let run: { id: string };
        let wakesAt: number;
        try {
          run = await builder.api.workflows.start(app, "work");
          // In its second round, ten seconds long, the share comes free.
          // That round begins some five seconds in, as the first ends, but
          // a busy runner can hold the first round's wake back: waited for
          // up to 45 seconds, inside the step's 60 seconds queued, as the
          // third round can only begin ten seconds after the second.
          wakesAt = await vi.waitFor(
            async () => {
              const wakes = await loadWakesOf(run.id);
              expect(wakes).toHaveLength(2);
              return wakes[1] ?? 0;
            },
            { timeout: 45_000, interval: 200 }
          );
        } finally {
          await stop();
        }
        await settled(held);
        await eventually(async () => {
          await expect(liveStatus(run.id)).resolves.toBe("complete");
        });
        const sinceWake = Date.now() - wakesAt;
        return {
          rounds: await loadWaitsOf(run.id),
          // Done within seconds of that round's end: not before it, nor a
          // round later.
          prompt: sinceWake >= 0 && sinceWake < 5000,
        };
      }
    );

    expect(result).toStrictEqual({ rounds: [5000, 10_000], prompt: true });
  });

  it("run a queued step as soon as a run's attempt gives its share back, not at the end of the round it sleeps in", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("slow", `${working("work", 8000)}\n  return 1;`, {
        work: 1,
      }),
      ...workflowFiles("quick", `${working("work", 10)}\n  return 1;`, {
        work: 1,
      }),
    });

    const result = await withShares({ workflowClientAttempts: 2 }, async () => {
      // An App's share is one: the quick run waits for the slow one's.
      const slow = await builder.api.workflows.start(app, "slow");
      await eventually(async () => {
        await expect(holdingOf(slow.id)).resolves.toBe(1);
      });
      const quick = await builder.api.workflows.start(app, "quick");
      await finished(slow.id);
      const freedAt = Date.now();
      await finished(quick.id);
      const wakes = await loadWakesOf(quick.id);
      return {
        status: await liveStatus(quick.id),
        // Its second round sleeps ten seconds from some five on: woken,
        // it runs within seconds of the share coming back.
        prompt: Date.now() - freedAt < 3000,
        rounds: wakes.length,
      };
    });

    expect(result).toStrictEqual({
      status: "complete",
      prompt: true,
      rounds: 2,
    });
  });

  it("ask once more for a wake no share sent, keeping its place and its turn", async () => {
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
      const held = await admit(holder, "holder");
      const run = await builder.api.workflows.start(app, "work");
      await eventually2(async () => {
        await expect(loadWakesOf(run.id)).resolves.toHaveLength(2);
      });
      const joined = await env.DB.prepare(
        "SELECT enqueued_at AS joined FROM workflow_admission_queue WHERE run_id = ?"
      )
        .bind(run.id)
        .first<number>("joined");
      // A forged wake, and the same again: one ask more, as its share is
      // still taken.
      const type = shareWakeType(await sha256Hex("work"));
      await runEngine(env).sendEvent(run.id, type, "forged");
      await runEngine(env).sendEvent(run.id, type, "forged");
      await eventually2(async () => {
        await expect(loadWakesOf(run.id)).resolves.toHaveLength(3);
      });
      const rejoined = await env.DB.prepare(
        "SELECT enqueued_at AS joined FROM workflow_admission_queue WHERE run_id = ?"
      )
        .bind(run.id)
        .first<number>("joined");
      const whileHeld = await liveStatus(run.id);
      await settled(held);
      await finished(run.id, 40_000);
      const wakes = await loadWakesOf(run.id);
      return {
        whileHeld,
        keptPlace: joined !== null && joined === rejoined,
        rounds: wakes.length,
        status: await liveStatus(run.id),
      };
    });

    // Its third round, twenty seconds, ran out: no wake came for it.
    expect(result).toStrictEqual({
      whileHeld: "waiting",
      keptPlace: true,
      rounds: 3,
      status: "complete",
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
          const summary = await builder.api.screens
            .frame(app, "")
            .summary(run.id);
          expect(summary.queued).toBeDefined();
          asksAgainIn = (summary.queued?.retryAt ?? 0) - Date.now();
        });
        await stopped(run.id);
        await eventually(async () => {
          const summary = await builder.api.screens
            .frame(app, "")
            .summary(run.id);
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
});

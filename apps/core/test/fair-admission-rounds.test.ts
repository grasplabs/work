import { describe, expect, it, vi } from "vite-plus/test";

import {
  withShares,
  admit,
  working,
  waitsOf,
  loadWaitsOf,
  loadWakesOf,
  endingEverySecond,
  failedWith,
  eventually,
  inRound,
} from "./fair-admission.ts";
import { mockIdp } from "./idp.ts";
import { finished, liveStatus } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// A step that waits its turn for a share round after round (admission.ts):
// how long each round sleeps, and how many rounds a long wait takes.
// The helpers and the rest of fair admission's tests: fair-admission.ts
// and the fair-admission*.test.ts files beside it.

const idp = mockIdp();

describe("fair workflow admission", { timeout: 120_000 }, () => {
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
        // Three rounds, more than its two steps: the first two ended as
        // their time passing would, each once it is under way.
        await inRound(run.id, 1, { end: true });
        await inRound(run.id, 2, { end: true });
        await inRound(run.id, 3);
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

  it("wait its backoff each round however soon the share's first lease ends, so a long wait takes a bounded number of rounds, each when its summary said", async () => {
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

    const queuedStepMs = 40_000;
    const result = await withShares(
      { workflowClientAttempts: 2, workflowQueuedStepMs: queuedStepMs },
      async () => {
        await admit(holder, "holder");
        const stop = endingEverySecond(holderRun.id);
        try {
          const run = await builder.api.workflows.start(app, "work");
          // Its first round, once its activation asked for a share: a
          // busy runner can take seconds to build and start it, which no
          // round's time is about.
          await vi.waitFor(
            async () => {
              await expect(loadWakesOf(run.id)).resolves.not.toHaveLength(0);
            },
            { timeout: queuedStepMs, interval: 200 }
          );
          // Its third round: when it wakes to, then when its summary says
          // it asks again. Read in that order: the round's refusal wrote
          // the summary's before the round began, so a summary read
          // earlier could still show the round before. It begins fifteen
          // seconds after the first, and before the step's time queued
          // ends its wait, whatever a busy runner holds its wakes back by.
          const { retryAt, wakesAt } = await vi.waitFor(
            async () => {
              const wakes = await loadWakesOf(run.id);
              expect(wakes).toHaveLength(3);
              const summary = await builder.api.screens
                .frame(app, "")
                .summary(run.id);
              return {
                retryAt: summary.queued?.retryAt,
                wakesAt: wakes.at(-1),
              };
            },
            { timeout: queuedStepMs, interval: 200 }
          );
          await finished(run.id, 60_000);
          return {
            failed: await failedWith(run.id),
            rounds: await loadWaitsOf(run.id),
            saidToWake: Math.abs((retryAt ?? 0) - (wakesAt ?? 0)) < 1500,
          };
        } finally {
          await stop();
        }
      }
    );

    // Told a second each round, it waits five seconds doubling, then what
    // is left of its forty: four rounds, not one a second.
    expect(result).toStrictEqual({
      failed: "workflow.queue_timeout",
      rounds: [5000, 10_000, 20_000, 5000],
      saidToWake: true,
    });
  });
});

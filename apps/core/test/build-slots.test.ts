import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildsAtOnce,
  holding,
  maxBuildWaitMs,
  renewEveryMs,
  renewedForMs,
} from "../src/build-admission.ts";
import {
  aJob,
  admit,
  aged,
  checkAt,
  holds,
  leaseOf,
  leasesHeld,
  shown,
} from "./build-slots.ts";

// The limit on build jobs building at once (build-admission.ts): a fixed
// number for the whole deployment, each a lease that lapses once its step
// stops renewing it. Core's database is real; steps are admitted as a
// build job's step admits them (build-jobs.ts). Time passes for a lease by
// moving what the database recorded into the past.

/** Jobs holding every lease but one, the one each test watches. */
const allButOne = async (): Promise<void> => {
  for (let held = 1; held < buildsAtOnce; held += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one lease after another
    leaseOf(await admit(aJob()));
  }
};

describe("build jobs building at once", { timeout: 60_000 }, () => {
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM build_leases").run();
  });

  it("build no more at once than the limit, however many race, one lease for a step admitted again, and the next once one settles", async () => {
    const jobs = Array.from({ length: buildsAtOnce + 3 }, aJob);
    const racing = await Promise.all(jobs.map(async (job) => await admit(job)));
    const first = racing.findIndex((answer) => "lease" in answer);
    const again = shown(await admit(jobs[first] ?? ""));
    const heldWhileFull = await leasesHeld();
    const waiting = jobs.find(
      (_, index) => !("lease" in (racing[index] ?? {}))
    );
    await leaseOf(racing[first] ?? { refused: "none" }).settle();
    const afterSettle = shown(await admit(waiting ?? ""));
    expect({
      racing: racing.map(shown).toSorted(),
      again,
      heldWhileFull,
      afterSettle,
    }).toStrictEqual({
      racing: [
        ...Array.from({ length: buildsAtOnce }, () => "ok"),
        "wait",
        "wait",
        "wait",
      ],
      again: "ok",
      heldWhileFull: buildsAtOnce,
      afterSettle: "ok",
    });
  });

  it("give a dead step's lease back once it stops renewing, and no sooner", async () => {
    await allButOne();
    const dead = aJob();
    const lease = leaseOf(await admit(dead));
    const next = aJob();
    const whileItCouldRenew = shown(await admit(next));
    // Not renewed since, and nearly its whole renewal past: still held.
    await aged("admitted_at", dead, renewedForMs - 5000);
    const beforeItLapses = shown(await admit(next));
    await aged("admitted_at", dead, 5001);
    const once = shown(await admit(next));
    const heldStill = await holds(dead);
    // A renewal after it lapsed doesn't take it back.
    const renewal = await lease.renew();
    expect({
      whileItCouldRenew,
      beforeItLapses,
      once,
      heldStill,
      renewal,
      renewedBack: await holds(dead),
      held: await leasesHeld(),
    }).toStrictEqual({
      whileItCouldRenew: "wait",
      beforeItLapses: "wait",
      once: "ok",
      heldStill: false,
      renewal: "lost",
      renewedBack: false,
      held: buildsAtOnce,
    });
  });

  it("keep a renewed lease while its step renews it, and never past a step's longest run", async () => {
    await allButOne();
    const building = aJob();
    const lease = leaseOf(await admit(building));
    const next = aJob();
    // Renewed every 55 seconds, ten times: taken 550 seconds ago, held
    // still.
    const step = 55_000;
    for (let renewal = 0; renewal < 10; renewal += 1) {
      // oxlint-disable-next-line no-await-in-loop -- time passes in order
      await aged("admitted_at", building, step);
      // oxlint-disable-next-line no-await-in-loop -- time passes in order
      await lease.renew();
    }
    const renewed = shown(await admit(next));
    // Renewed once more, past ten minutes from when it was taken: it holds
    // no further than a step's longest run.
    await aged("admitted_at", building, step);
    await lease.renew();
    const capped = shown(await admit(next));
    expect({ renewed, capped }).toStrictEqual({
      renewed: "wait",
      capped: "ok",
    });
  });

  it("fail a job that waited as long as a job may", async () => {
    const timedOut = shown(await admit(aJob(), checkAt(2), maxBuildWaitMs));
    expect(timedOut).toBe("agent.build_queue_timeout");
  });

  it("never revive a lease once another was taken after it would have ended, by whatever clock", async () => {
    const job = aJob();
    const lease = leaseOf(await admit(job));
    // Another core, its clock ahead, found the lease ended and took a
    // lease after it would have: the lease's own clock hasn't reached its
    // end yet.
    const end = await env.DB.prepare(
      "SELECT admitted_at + reserved_ms AS ends FROM build_leases WHERE job_id = ?"
    )
      .bind(job)
      .first<number>("ends");
    await env.DB.prepare(
      "INSERT INTO build_leases (job_id, seq, admitted_at, reserved_ms, settled_at) VALUES (?, 1, ?, 60000, NULL)"
    )
      .bind(aJob(), end ?? 0)
      .run();
    const renewal = await lease.renew();
    const after = await env.DB.prepare(
      "SELECT admitted_at + reserved_ms AS ends FROM build_leases WHERE job_id = ?"
    )
      .bind(job)
      .first<number>("ends");
    expect({
      renewal,
      renewed: (after ?? 0) > (end ?? 0),
    }).toStrictEqual({ renewal: "lost", renewed: false });
  });

  it("stop a step's build once its lease is lost, and give the lease back", async () => {
    const job = aJob();
    const lease = leaseOf(await admit(job));
    // A build that never ends of its own: the step stops waiting on it
    // once a renewal finds its lease lost (lapsed, here).
    const building = Promise.withResolvers<string>();
    const started = Promise.withResolvers<AbortSignal>();
    const stepping = holding(lease, async (lost) => {
      started.resolve(lost);
      return await building.promise;
    });
    const told = await started.promise;
    await aged("admitted_at", job, renewedForMs + 1);
    let stopped: string;
    try {
      await stepping;
      stopped = "ran to its end";
    } catch (error) {
      stopped = error instanceof Error ? error.message : String(error);
    }
    building.resolve("built");
    const settled = await env.DB.prepare(
      "SELECT settled_at IS NOT NULL AS settled FROM build_leases WHERE job_id = ?"
    )
      .bind(job)
      .first<number>("settled");
    expect({ stopped, settled, told: told.aborted }).toStrictEqual({
      stopped: "The build job's step lost its lease",
      settled: 1,
      // What it builds is told, to start nothing more.
      told: true,
    });
  });

  it("keep a step's build going while its lease holds, and give the lease back once it ends", async () => {
    const job = aJob();
    const lease = leaseOf(await admit(job));
    const built = await holding(lease, async () => {
      // Past a renewal: still held, so it builds to its end.
      await scheduler.wait(renewEveryMs + 2000);
      return await holds(job);
    });
    expect({ built, after: await holds(job) }).toStrictEqual({
      built: true,
      after: false,
    });
  });

  it("build nothing under a lease that ended before its step began", async () => {
    const job = aJob();
    const lease = leaseOf(await admit(job));
    // The admission answered late: the lease it handed back has ended.
    await aged("admitted_at", job, renewedForMs + 1);
    let built = false;
    let stopped: string;
    try {
      await holding(lease, async () => {
        built = true;
        await Promise.resolve();
      });
      stopped = "ran to its end";
    } catch (error) {
      stopped = error instanceof Error ? error.message : String(error);
    }
    expect({ built, stopped }).toStrictEqual({
      built: false,
      stopped: "The build job's step lost its lease",
    });
  });
});

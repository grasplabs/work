import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildQueuedPerPerson,
  holding,
  maxBuildWaitMs,
  queuedJob,
  renewEveryMs,
  renewedForMs,
} from "../src/build-admission.ts";
import { queueLiveMs } from "../src/workflows/admission.ts";
import {
  admit,
  admitEach,
  aged,
  anApp,
  checkAt,
  fenced,
  jobOf,
  leasesHeld,
  policyWith,
  settle,
  shown,
} from "./fair-build-admission.ts";

// Fair admission of the client's build jobs (build-admission.ts): how many
// build at once, in all and of one App, each held to its share in the
// quota limits (`TEST_QUOTA_LIMITS`, which a test lowers to reach them),
// and in what order those waiting get one: first come,
// first served, never behind an App whose own share is full. Core's
// database is real; steps are admitted as a build job's step admits them
// (build-jobs.ts), each test with Apps of its own. Time passes for a lease
// or a place by moving what the database recorded into the past.

describe("fair build admission", { timeout: 60_000 }, () => {
  afterEach(async () => {
    policyWith({});
    await env.DB.batch([
      env.DB.prepare("DELETE FROM build_leases"),
      env.DB.prepare("DELETE FROM build_admission_queue"),
    ]);
  });

  it("builds one job of an App at a time and leaves the client's other build to another App", async () => {
    const [a, b, c] = [anApp(), anApp(), anApp()];
    const answers = await admitEach(
      jobOf(a),
      jobOf(a),
      jobOf(a, "person-2"),
      jobOf(b),
      jobOf(c)
    );
    expect({ answers, held: await leasesHeld() }).toStrictEqual({
      // The App's burst takes its own share, one, and waits; another App
      // takes the client's other; a third waits for the client's.
      answers: ["ok", "wait:key", "wait:key", "ok", "wait:client"],
      held: 2,
    });
  });

  it("holds builds to the client's share as the policy lowers it", async () => {
    policyWith({ tenantBuildJobs: 1 });
    const answers = await admitEach(jobOf(anApp()), jobOf(anApp()));
    expect(answers).toStrictEqual(["ok", "wait:client"]);
  });

  it("passes over a job behind a full App, and never lets a newcomer take a share a job ahead would", async () => {
    const [a, b, c, d, e] = [anApp(), anApp(), anApp(), anApp(), anApp()];
    const first = jobOf(a);
    const other = jobOf(b);
    const sameApp = jobOf(a);
    const waiting = jobOf(c);
    const [firstLease, otherLease] = [await admit(first), await admit(other)];
    const queuedFirst = [
      shown(await admit(sameApp)),
      shown(await admit(waiting)),
    ];
    await settle(otherLease);
    // The App's job ahead can't take the share that came free (its App is
    // full): the job behind it can, and does.
    const behindFullApp = await admit(waiting);
    const later = jobOf(d);
    const queuedLater = shown(await admit(later));
    await settle(behindFullApp);
    // A share free, a newcomer: the job ahead of it takes it first.
    const newcomer = shown(await admit(jobOf(e)));
    const ahead = await admit(later);
    expect({
      queuedFirst,
      behindFullApp: shown(behindFullApp),
      queuedLater,
      newcomer,
      ahead: shown(ahead),
    }).toStrictEqual({
      queuedFirst: ["wait:key", "wait:client"],
      behindFullApp: "ok",
      queuedLater: "wait:client",
      newcomer: "wait:client",
      ahead: "ok",
    });
    await settle(firstLease);
  });

  it("serves an App's waiting jobs a person's turn at a time", async () => {
    const app = anApp();
    const holder = await admit(jobOf(app, "person-1"));
    const older = jobOf(app, "person-1");
    const newer = jobOf(app, "person-1");
    const another = jobOf(app, "person-2");
    const joined = await admitEach(older, newer, another);
    await settle(holder);
    const olderLease = await admit(older);
    await settle(olderLease);
    // The other person's job joined after both, but takes the next turn.
    const next = await admitEach(newer, another);
    expect({ joined, older: shown(olderLease), next }).toStrictEqual({
      joined: ["wait:key", "wait:key", "wait:key"],
      older: "ok",
      next: ["wait:key", "ok"],
    });
  });

  it("holds one lease for a step admitted again", async () => {
    const job = jobOf(anApp());
    const answers = [shown(await admit(job)), shown(await admit(job))];
    expect({ answers, held: await leasesHeld() }).toStrictEqual({
      answers: ["ok", "ok"],
      held: 1,
    });
  });

  it("gives a dead step's lease back once it stops renewing, and no sooner", async () => {
    const app = anApp();
    const dead = jobOf(app);
    const lease = await admit(dead);
    const next = jobOf(app);
    const whileItCouldRenew = shown(await admit(next));
    // Not renewed since, and nearly its whole renewal past: still held.
    await aged("build_leases", "admitted_at", dead.job, renewedForMs - 5000);
    const beforeItLapses = shown(await admit(next));
    await aged("build_leases", "admitted_at", dead.job, 5001);
    const once = await admit(next);
    const heldStill = "lease" in lease ? await lease.lease.held() : null;
    // A renewal after it lapsed doesn't take it back.
    if ("lease" in lease) {
      await lease.lease.renew();
    }
    expect({
      whileItCouldRenew,
      beforeItLapses,
      once: shown(once),
      heldStill,
      renewedBack: "lease" in lease ? await lease.lease.held() : null,
      held: await leasesHeld(),
    }).toStrictEqual({
      whileItCouldRenew: "wait:key",
      beforeItLapses: "wait:key",
      once: "ok",
      heldStill: false,
      renewedBack: false,
      held: 1,
    });
  });

  it("keeps a renewed lease while its step renews it, and never past a step's longest run", async () => {
    const app = anApp();
    const building = jobOf(app);
    const lease = await admit(building);
    if (!("lease" in lease)) {
      throw new Error("Not admitted");
    }
    const next = jobOf(app);
    // Renewed every 55 seconds, ten times: taken 550 seconds ago, held
    // still.
    const step = 55_000;
    for (let renewal = 0; renewal < 10; renewal += 1) {
      // oxlint-disable-next-line no-await-in-loop -- time passes in order
      await aged("build_leases", "admitted_at", building.job, step);
      // oxlint-disable-next-line no-await-in-loop -- time passes in order
      await lease.lease.renew();
    }
    const renewed = shown(await admit(next));
    // Renewed once more, past ten minutes from when it was taken: it holds
    // no further than a step's longest run.
    await aged("build_leases", "admitted_at", building.job, step);
    await lease.lease.renew();
    const capped = shown(await admit(next));
    expect({ renewed, capped }).toStrictEqual({
      renewed: "wait:key",
      capped: "ok",
    });
  });

  it("makes a step tried again wait for the attempt it replaces, and takes nothing for a late older attempt", async () => {
    const app = anApp();
    const job = jobOf(app);
    const firstAttempt = await admit(job, checkAt(1, 1));
    // The engine tries the step again while the first attempt still holds
    // its lease (cut off, its isolate maybe running): it waits.
    const secondWhileHeld = shown(await admit(job, checkAt(1, 2)));
    await settle(firstAttempt);
    const second = shown(await admit(job, checkAt(1, 2)));
    // The first attempt's admission lands again, late: it takes nothing.
    const lateFirst = shown(await admit(job, checkAt(1, 1)));
    // Nor does an older attempt take a lease once a newer one has queued.
    const elsewhere = anApp();
    const holder = await admit(jobOf(elsewhere));
    const queuedJob2 = jobOf(elsewhere);
    const newerQueued = shown(await admit(queuedJob2, checkAt(2, 1)));
    await settle(holder);
    const olderAfterNewerQueued = shown(await admit(queuedJob2, checkAt(1, 3)));
    expect({
      secondWhileHeld,
      second,
      lateFirst,
      newerQueued,
      olderAfterNewerQueued,
    }).toStrictEqual({
      secondWhileHeld: "wait:key",
      second: "ok",
      lateFirst: "execution.stale_attempt",
      newerQueued: "wait:key",
      olderAfterNewerQueued: "execution.stale_attempt",
    });
  });

  it("drops a waiting job's place once it stops asking", async () => {
    const app = anApp();
    const holder = await admit(jobOf(app));
    const gone = jobOf(app);
    await admit(gone);
    await aged("build_admission_queue", "seen_at", gone.job, queueLiveMs + 1);
    await settle(holder);
    const newcomer = await admit(jobOf(app));
    expect({
      newcomer: shown(newcomer),
      goneShows: await queuedJob(env, gone.job),
    }).toStrictEqual({ newcomer: "ok", goneShows: null });
  });

  it("shows a waiting job its own wait, joined once, and nothing once admitted", async () => {
    const app = anApp();
    const holder = await admit(jobOf(app));
    const job = jobOf(app);
    const first = await admit(job);
    const again = await admit(job);
    const shownWaiting = await queuedJob(env, job.job);
    await settle(holder);
    const admitted = shown(await admit(job));
    expect({
      first: "joined" in first ? first.joined : null,
      again: "joined" in again ? again.joined : null,
      waitingFor: shownWaiting?.waitingFor,
      retryAtLater: Date.parse(shownWaiting?.retryAt ?? "") > Date.now(),
      admitted,
      afterwards: await queuedJob(env, job.job),
    }).toStrictEqual({
      first: true,
      again: false,
      waitingFor: "key",
      retryAtLater: true,
      admitted: "ok",
      afterwards: null,
    });
  });

  it("refuses to queue a person's job past the places they may hold", async () => {
    policyWith({ tenantBuildJobs: 1 });
    await admit(jobOf(anApp(), "someone-else"));
    const places: string[] = [];
    for (let place = 0; place < buildQueuedPerPerson; place += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one place after another
      places.push(shown(await admit(jobOf(anApp(), "flooder"))));
    }
    const past = shown(await admit(jobOf(anApp(), "flooder")));
    const another = shown(await admit(jobOf(anApp(), "person-2")));
    expect({
      places: new Set(places),
      past,
      another,
    }).toStrictEqual({
      places: new Set(["wait:client"]),
      past: "agent.build_queue_full",
      another: "wait:client",
    });
  });

  it("fails a job that waited as long as a job may, and gives up its place", async () => {
    const app = anApp();
    await admit(jobOf(app));
    const job = jobOf(app);
    await admit(job);
    const timedOut = shown(await admit(job, checkAt(2), maxBuildWaitMs));
    expect({
      timedOut,
      place: await queuedJob(env, job.job),
    }).toStrictEqual({ timedOut: "agent.build_queue_timeout", place: null });
  });

  it("never revives a lease once another was taken after it would have ended, by whatever clock", async () => {
    const app = anApp();
    const job = jobOf(app);
    const lease = await admit(job);
    if (!("lease" in lease)) {
      throw new Error("Not admitted");
    }
    // Another core, its clock ahead, found the lease ended and took a
    // lease after it would have: the lease's own clock hasn't reached its
    // end yet.
    const end = await env.DB.prepare(
      "SELECT admitted_at + reserved_ms AS ends FROM build_leases WHERE job_id = ?"
    )
      .bind(job.job)
      .first<number>("ends");
    await env.DB.prepare(
      "INSERT INTO build_leases (job_id, seq, subject, resource, admitted_at, reserved_ms, settled_at) VALUES (?, 1, 'person-2', ?, ?, 60000, NULL)"
    )
      .bind(crypto.randomUUID(), anApp(), end ?? 0)
      .run();
    await lease.lease.renew();
    const after = await env.DB.prepare(
      "SELECT admitted_at + reserved_ms AS ends FROM build_leases WHERE job_id = ?"
    )
      .bind(job.job)
      .first<number>("ends");
    expect({
      held: await lease.lease.held(),
      renewed: (after ?? 0) > (end ?? 0),
    }).toStrictEqual({ held: false, renewed: false });
  });

  it("stops a step's build once its lease is lost, and gives the lease back", async () => {
    const app = anApp();
    const job = jobOf(app);
    const lease = await admit(job);
    if (!("lease" in lease)) {
      throw new Error("Not admitted");
    }
    // A build that never ends of its own: the step stops waiting on it
    // once a renewal finds its lease lost (lapsed, here).
    const building = Promise.withResolvers<string>();
    const started = Promise.withResolvers<AbortSignal>();
    const stepping = holding(lease.lease, async (lost) => {
      started.resolve(lost);
      return await building.promise;
    });
    const told = await started.promise;
    await aged("build_leases", "admitted_at", job.job, renewedForMs + 1);
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
      .bind(job.job)
      .first<number>("settled");
    expect({ stopped, settled, told: told.aborted }).toStrictEqual({
      stopped: "The build job's step lost its lease",
      settled: 1,
      // What it builds is told, to start nothing more.
      told: true,
    });
  });

  it("keeps a step's build going while its lease holds, and gives the lease back once it ends", async () => {
    const job = jobOf(anApp());
    const lease = await admit(job);
    if (!("lease" in lease)) {
      throw new Error("Not admitted");
    }
    const built = await holding(lease.lease, async () => {
      // Past a renewal: still held, so it builds to its end.
      await scheduler.wait(renewEveryMs + 2000);
      return await lease.lease.held();
    });
    expect({ built, after: await lease.lease.held() }).toStrictEqual({
      built: true,
      after: false,
    });
  });

  it("builds nothing under a lease that ended before its step began", async () => {
    const job = jobOf(anApp());
    const lease = await admit(job);
    if (!("lease" in lease)) {
      throw new Error("Not admitted");
    }
    // The admission answered late: the lease it handed back has ended.
    await aged("build_leases", "admitted_at", job.job, renewedForMs + 1);
    let built = false;
    let stopped: string;
    try {
      await holding(lease.lease, async () => {
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

  it("leaves another person a build however many Apps one person builds, and serves them before that person's later jobs", async () => {
    // Two builds at once: one person's jobs in three Apps take one.
    const many = "builds-many-apps";
    const own = await admitEach(
      jobOf(anApp(), many),
      jobOf(anApp(), many),
      jobOf(anApp(), many)
    );
    const another = shown(await admit(jobOf(anApp(), "someone-else")));
    // The person holds nothing now and waits in two Apps: the first behind
    // an App another job holds, the second in an App free. Another
    // person's job joins after both; the client is full.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM build_leases"),
      env.DB.prepare("DELETE FROM build_admission_queue"),
    ]);
    const busyApp = anApp();
    const holders = [jobOf(busyApp), jobOf(anApp())];
    const held = await admitEach(...holders);
    const first = jobOf(busyApp, many);
    const later = jobOf(anApp(), many);
    const theirs = jobOf(anApp(), "another-person");
    const waiting = await admitEach(first, later, theirs);
    // One build comes free: not the busy App's.
    await env.DB.prepare(
      "UPDATE build_leases SET settled_at = ? WHERE job_id = ?"
    )
      .bind(Date.now(), holders[1]?.job ?? "")
      .run();
    // The person's first place is passed over (its App is busy); the
    // other person's job takes its turn before the person's later one.
    const served = await admitEach(later, theirs);
    expect({ own, another, held, waiting, served }).toStrictEqual({
      own: ["ok", "wait:person", "wait:person"],
      another: "ok",
      held: ["ok", "ok"],
      waiting: ["wait:key", "wait:client", "wait:client"],
      served: ["wait:client", "ok"],
    });
  });

  it("stops renewing an attempt's lease once a newer attempt of its step went on", async () => {
    const job = jobOf(anApp());
    const older = await admit(job, checkAt(1, 1));
    if (!("lease" in older)) {
      throw new Error("Not admitted");
    }
    // The engine tried the step again: the newer attempt waits for the
    // older one's lease, and the older one can't keep it.
    const newer = shown(await admit(job, checkAt(1, 2)));
    expect({ newer, renewed: await older.lease.renew() }).toStrictEqual({
      newer: "wait:key",
      renewed: "lost",
    });
  });

  it("refuses a commit's fence to a lease a newer attempt of its step superseded", async () => {
    const job = jobOf(anApp());
    await admit(job, checkAt(1, 1));
    const whileCurrent = await fenced(job.job, checkAt(1, 1));
    // The engine tried the step again: the newer attempt queued.
    await admit(job, checkAt(1, 2));
    const superseded = await fenced(job.job, checkAt(1, 1));
    expect({ whileCurrent, superseded }).toStrictEqual({
      whileCurrent: "fenced",
      superseded: "refused",
    });
  });
});

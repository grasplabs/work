import { env } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { adminDatabase } from "../src/db/act.ts";
import {
  alerts,
  apiBudget,
  auditEvents,
  channels,
  clientDeploys,
  clientRuns,
  clients,
  clientWatch,
  clientWorkers,
  leases,
  rollouts,
} from "../src/db/schema.ts";
import { PlacementError, placeAndProvision } from "../src/hosting/placement.ts";
import type { Channel } from "../src/rollout/channel-ids.ts";
import {
  pinClient,
  promoteRelease,
  resumeRollout,
  retryClient,
  setClientChannel,
  toEdge,
} from "../src/rollout/channels.ts";
import { RolloutError } from "../src/rollout/errors.ts";
import { rolloutLimits } from "../src/rollout/plan.ts";
import { rolloutPass } from "../src/rollout/scheduler.ts";
import { channelReleases } from "../src/rollout/targets.ts";
import { adminWorkflow, adminWorkflows } from "../src/workflow-runs.ts";
import type { ApiCall } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { releaseToEdge } from "./edge.ts";
import { db, staff } from "./hosting.ts";
import {
  livePlacedClient,
  placedClientRecord,
  placedRelease,
  scriptsOf,
} from "./placed.ts";
import { racingDb } from "./racing-db.ts";
import { onPi } from "./releases.ts";
import { ended, followAdminRuns } from "./runs.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Release channels, their rollouts and the rollout pass
// (src/rollout/channels.ts, src/rollout/scheduler.ts): actions set the
// desired state and start a channel's rollout, and each pass deploys
// every client whose Workers run something else than its target, in the
// rollout's order. How it can fail, each tried below:
// - a new release never reaching Edge, or reaching clients beyond it;
// - a move of a channel without its rollout, or leaving the one before
//   live; a channel an older admin moved left without one;
// - a promotion deploying a pinned client;
// - a release skipping a channel, or promoted past one where it halted;
// - a channel set back to a release that can't read the chats its
//   clients store;
// - a rollout going on after 3 failed, or more than one first;
//   stopping at fewer, or on a platform fault; never going again once
//   staff resume it, or halting again on what it was resumed past;
// - a halt told twice, or never;
// - a release that reaches Edge while Edge deploys, dropped;
// - a client moved to another channel left on its old channel's release;
// - a new client started on a release its channel doesn't have, or on
//   none while its channel has none;
// - two passes at once deploying one client twice, or more than slow
//   start allows between them, or more than the fleet's slots across
//   channels, an older admin's runs among them;
// - a pass cut off mid-way losing what it didn't start, or starting a
//   client twice once run again;
// - a rollout halted or superseded mid-pass, still claimed for;
// - an older admin's reconciler and run beside the pass: both acting at
//   once, or its run taken over;
// - clients another runner has taking the rollout's slots for good.

const token = "test-deployer-token-channels-3b7f2c";
const cloudflare = mockCloudflareApi(token);

/** A live client on `releaseId`, following `channel`. */
const live = async (channel: Channel, releaseId: string) =>
  await livePlacedClient(cloudflare, releaseId, { channel });

/** The release each of the client's Workers runs, by Worker. */
const releasesOf = async (clientId: string) => {
  const rows = await db
    .select({
      worker: clientWorkers.worker,
      releaseId: clientWorkers.releaseId,
    })
    .from(clientWorkers)
    .where(eq(clientWorkers.clientId, clientId));
  return Object.fromEntries(
    rows.map(({ worker, releaseId }) => [worker, releaseId])
  );
};

/** Both Workers on `releaseId`. */
const on = (releaseId: string) => ({ connect: releaseId, core: releaseId });

/** Client `clientId`'s last deploy: its release, status and error. */
const deployOf = async (clientId: string) =>
  (await db
    .select({
      releaseId: clientDeploys.releaseId,
      status: clientDeploys.status,
      error: clientDeploys.error,
    })
    .from(clientDeploys)
    .where(eq(clientDeploys.clientId, clientId))
    .get()) ?? null;

/**
 * `count` active clients following `channel` that run nothing yet, so
 * each waits for its target; their ids start with `prefix` and sort in
 * the order made.
 */
const waitingClients = async (
  channel: Channel,
  prefix: string,
  count: number
): Promise<string[]> => {
  const run = crypto.randomUUID().slice(0, 8);
  const ids = Array.from(
    { length: count },
    (_, index) => `${prefix}-${run}-${String(index).padStart(2, "0")}`
  );
  await Promise.all(
    ids.map(async (id) => await placedClientRecord(cloudflare, { id, channel }))
  );
  await db
    .update(clients)
    .set({ status: "active" })
    .where(inArray(clients.id, ids));
  return ids;
};

/** How many deploys of clients `clientIds` started, as the audit log keeps them. */
const startedOf = async (clientIds: readonly string[]): Promise<number> =>
  await db.$count(
    auditEvents,
    and(
      inArray(auditEvents.clientId, [...clientIds]),
      eq(auditEvents.action, "deploy.start")
    )
  );

/** Why nothing new deploys on `channel`; null while something may. */
const stoppedByOf = async (channel: Channel): Promise<string | null> => {
  const row = await db
    .select({ stoppedBy: channels.stoppedBy })
    .from(channels)
    .where(eq(channels.id, channel))
    .get();
  return row?.stoppedBy ?? null;
};

/** How many deploys of client `clientId` started, as the audit log keeps them. */
const deploysStarted = async (clientId: string): Promise<number> =>
  await db.$count(
    auditEvents,
    and(
      eq(auditEvents.clientId, clientId),
      eq(auditEvents.action, "deploy.start")
    )
  );

/**
 * The admin's runs as the test starts them, retries and sleeps going at
 * once: `tick` is the cron's rollout pass, `settle` waits for every
 * deploy started so far to end, and `converge` runs passes until nothing
 * is left to do.
 */
const followRuns = () => {
  const runs = followAdminRuns();
  const settle = async (): Promise<void> => {
    await Promise.all(
      runs
        .of(adminWorkflows.deploy)
        .map(async (id) => await ended(adminWorkflows.deploy, id))
    );
  };
  return {
    tick: async (): Promise<void> => {
      await rolloutPass(env);
    },
    settle,
    converge: async (): Promise<void> => {
      for (let round = 0; round < 6; round += 1) {
        const before = runs.of(adminWorkflows.deploy).length;
        // oxlint-disable-next-line no-await-in-loop -- one pass at a time
        await rolloutPass(env);
        // oxlint-disable-next-line no-await-in-loop -- one pass at a time
        await settle();
        if (runs.of(adminWorkflows.deploy).length === before) {
          return;
        }
      }
    },
    [Symbol.asyncDispose]: async () => {
      await runs[Symbol.asyncDispose]();
    },
  };
};

/** Takes `releaseId` to `channel` as staff would: Edge first, then each channel before it. */
const promoteTo = async (channel: Channel, releaseId: string) => {
  await releaseToEdge(env, [releaseId]);
  if (channel === "edge") {
    return;
  }
  await promoteRelease(env, staff, { channel: "beta", releaseId });
  if (channel === "stable") {
    await promoteRelease(env, staff, { channel: "stable", releaseId });
  }
};

/** `channel`'s rollout started last: its status, why it halted, its counts and approver. */
const rolloutOf = async (channel: Channel) =>
  (await db
    .select({
      id: rollouts.id,
      releaseId: rollouts.releaseId,
      status: rollouts.status,
      haltedReason: rollouts.haltedReason,
      startedBy: rollouts.startedBy,
      done: rollouts.done,
      failed: rollouts.failed,
    })
    .from(rollouts)
    .where(eq(rollouts.channel, channel))
    .orderBy(desc(rollouts.startedAt), desc(sql`rowid`))
    .get()) ?? null;

/** `channel`'s rollouts of `releaseIds`, oldest first: each one's release, status and approver. */
const rolloutsOf = async (channel: Channel, releaseIds: readonly string[]) =>
  await db
    .select({
      releaseId: rollouts.releaseId,
      status: rollouts.status,
      startedBy: rollouts.startedBy,
    })
    .from(rollouts)
    .where(
      and(
        eq(rollouts.channel, channel),
        inArray(rollouts.releaseId, [...releaseIds])
      )
    )
    .orderBy(asc(rollouts.startedAt), asc(sql`rowid`));

/** Clients `clientIds` run `releaseId` on both Workers, as a deploy leaves them. */
const runOn = async (
  clientIds: readonly string[],
  releaseId: string
): Promise<void> => {
  await db.insert(clientWorkers).values(
    clientIds.flatMap((clientId) =>
      (["core", "connect"] as const).map((worker) => ({
        clientId,
        worker,
        scriptName: `${clientId}-${worker}`,
        releaseId,
      }))
    )
  );
};

/** Clients `clientIds`' deploys of rollout `rolloutId`'s release, recorded failed with `error`, as a run's end records them. */
const failedOn = async (
  clientIds: readonly string[],
  rollout: { id: string; releaseId: string },
  error = "smoke_check_failed"
): Promise<void> => {
  const now = new Date();
  await db.insert(clientDeploys).values(
    clientIds.map((clientId) => ({
      clientId,
      releaseId: rollout.releaseId,
      runId: `deploy-${crypto.randomUUID().slice(0, 8)}`,
      status: "failed" as const,
      error,
      startedAt: now,
      endedAt: now,
      rolloutId: rollout.id,
    }))
  );
};

/** How many audit events `action` names `target`. */
const eventsOf = async (action: string, target: string): Promise<number> =>
  await db.$count(
    auditEvents,
    and(eq(auditEvents.action, action), eq(auditEvents.target, target))
  );

/** How many alerts the halts of rollout `rolloutId` recorded. */
const haltAlertsOf = async (rolloutId: string): Promise<number> =>
  await db.$count(alerts, like(alerts.key, `halt:${rolloutId}:%`));

/** The rollout a channel has, or a refusal, as an error's code. */
const codeOf = (error: unknown) =>
  error instanceof RolloutError ? error.code : error;

/**
 * What picks out a call to upload client `clientId`'s core. By its script:
 * every placed client's scripts share Grasp's account (test/placed.ts), so
 * the account alone picks out whichever client's core uploads first.
 */
const coreUpload = async (
  clientId: string
): Promise<(call: ApiCall) => boolean> => {
  const { core } = await scriptsOf(clientId);
  return (call) =>
    call.method === "PUT" && call.path.endsWith(`/scripts/${core}`);
};

/**
 * Sets aside what earlier tests left: their clients offboarded, and no
 * release on any channel.
 */
const setAsideEarlierTests = async (): Promise<void> => {
  await db
    .update(clients)
    .set({ status: "offboarded" })
    .where(inArray(clients.status, ["active", "provisioning"]));
  await db.delete(channels);
};

describe("release channels", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(setAsideEarlierTests);

  it("takes a newly imported release to Edge's clients by itself, and no one else's", async () => {
    const before = await placedRelease("feat(core): before");
    const edge = await live("edge", before);
    const stable = await live("stable", before);
    const older = await placedRelease("feat(core): imported first");
    const release = await placedRelease("feat(core): imported");
    await using runs = followRuns();

    // As the cron does after an import that brought both.
    await releaseToEdge(env, [older, release]);
    await runs.converge();
    // An import that brings only an older release leaves Edge alone.
    await releaseToEdge(env, [before]);

    expect({
      edge: await releasesOf(edge.clientId),
      stable: await releasesOf(stable.clientId),
      deploy: await deployOf(edge.clientId),
      rollouts: await rolloutsOf("edge", [before, older, release]),
    }).toStrictEqual({
      edge: on(release),
      stable: on(before),
      deploy: { releaseId: release, status: "done", error: null },
      // One rollout a move, by the admin itself, and none for the
      // releases that never moved Edge.
      rollouts: [{ releaseId: release, status: "done", startedBy: "system" }],
    });
  });

  it("starts a rollout with each move of a channel, approved by who moved it, and gives one to a channel an older admin moved", async () => {
    const first = await placedRelease("feat(core): first");
    const second = await placedRelease("feat(core): second");
    await releaseToEdge(env, [first]);
    await releaseToEdge(env, [second]);
    await promoteRelease(env, staff, { channel: "beta", releaseId: first });
    await promoteRelease(env, staff, { channel: "beta", releaseId: second });
    // Set back by staff: a rollout of its own, approved by them.
    await promoteRelease(env, staff, { channel: "edge", releaseId: first });
    const moved = {
      edge: await rolloutsOf("edge", [first, second]),
      beta: await rolloutsOf("beta", [first, second]),
    };
    // An older admin moves Beta back with no rollout row.
    await db
      .update(channels)
      .set({ releaseId: first })
      .where(eq(channels.id, "beta"));

    await rolloutPass(env);

    expect({
      moved,
      healed: await rolloutsOf("beta", [first, second]),
    }).toStrictEqual({
      moved: {
        edge: [
          { releaseId: first, status: "superseded", startedBy: "system" },
          { releaseId: second, status: "superseded", startedBy: "system" },
          { releaseId: first, status: "running", startedBy: staff.email },
        ],
        beta: [
          { releaseId: first, status: "superseded", startedBy: staff.email },
          { releaseId: second, status: "running", startedBy: staff.email },
        ],
      },
      healed: [
        { releaseId: first, status: "superseded", startedBy: staff.email },
        { releaseId: second, status: "superseded", startedBy: staff.email },
        // No client on Beta: done in the pass that started it.
        { releaseId: first, status: "done", startedBy: "system" },
      ],
    });
  });

  it("deploys a release promoted to Stable to each Stable client, skipping a pinned one", async () => {
    const before = await placedRelease("feat(core): before");
    const first = await live("stable", before);
    const second = await live("stable", before);
    const pinned = await live("stable", before);
    const beta = await live("beta", before);
    await pinClient(env, staff, {
      clientId: pinned.clientId,
      releaseId: before,
    });
    const release = await placedRelease("feat(core): promoted");
    await using runs = followRuns();

    await promoteTo("stable", release);
    await runs.converge();

    expect({
      first: await releasesOf(first.clientId),
      second: await releasesOf(second.clientId),
      pinned: await releasesOf(pinned.clientId),
      // Beta has the release too: its client takes it as well.
      beta: await releasesOf(beta.clientId),
    }).toStrictEqual({
      first: on(release),
      second: on(release),
      pinned: on(before),
      beta: on(release),
    });
  });

  it("refuses a release that skips a channel, and sets a channel back to a release it had", async () => {
    const previous = await placedRelease("feat(core): the one before");
    const client = await live("beta", previous);
    await using runs = followRuns();
    await promoteTo("beta", previous);
    const release = await placedRelease("feat(core): goes wrong");
    await releaseToEdge(env, [release]);

    const skipping = await promoteRelease(env, staff, {
      channel: "stable",
      releaseId: release,
    }).then(
      () => null,
      (error: unknown) => (error instanceof RolloutError ? error.code : error)
    );
    await promoteRelease(env, staff, { channel: "beta", releaseId: release });
    await runs.converge();
    const promoted = await releasesOf(client.clientId);
    await promoteRelease(env, staff, { channel: "beta", releaseId: previous });
    await runs.converge();

    expect({
      skipping,
      promoted,
      rolledBack: await releasesOf(client.clientId),
    }).toStrictEqual({
      skipping: "promotion_not_allowed",
      promoted: on(release),
      rolledBack: on(previous),
    });
  });

  it("refuses to set a channel back to a release that can't read the chats its release stores, leaving its clients where they are", async () => {
    const previous = await placedRelease("feat(core): pi 1.4", onPi("1.4.2"));
    const client = await live("beta", previous);
    await using runs = followRuns();
    await promoteTo("beta", previous);
    const release = await placedRelease("chore(deps): pi 1.6", onPi("1.6.1"));
    await promoteTo("beta", release);
    await runs.converge();

    const back = await promoteRelease(env, staff, {
      channel: "beta",
      releaseId: previous,
    }).then(
      () => null,
      (error: unknown) => (error instanceof RolloutError ? error.code : error)
    );
    await runs.converge();

    const pointing = await channelReleases(db);

    expect({
      back,
      channel: pointing.beta,
      runs: await releasesOf(client.clientId),
    }).toStrictEqual({
      back: "channel_behind_chat_storage",
      channel: release,
      runs: on(release),
    });
  });

  it("deploys the smallest first, alone, halts at the third failure before the rest deploy, tells it once, and goes on once staff resume it", async () => {
    const before = await placedRelease("feat(core): before");
    const failing = await Promise.all(
      [1, 2, 3].map(async () => await live("stable", before))
    );
    const largest = await live("stable", before);
    // Their sizes, as the hourly watch reads them: the failing ones first.
    const sized = [...failing, largest].map(({ clientId }, index) => ({
      clientId,
      readAt: new Date(),
      signals: JSON.stringify({ people: index === 3 ? 50 : index + 1 }),
    }));
    await db.insert(clientWatch).values(sized);
    const release = await placedRelease("feat(core): fails on three");
    await using runs = followRuns();
    await promoteTo("beta", release);
    // Each failing client's core upload is refused once.
    for (const { clientId } of failing) {
      // oxlint-disable-next-line no-await-in-loop -- three matchers
      cloudflare.failNext(await coreUpload(clientId), 400);
    }

    await promoteRelease(env, staff, { channel: "stable", releaseId: release });
    await runs.converge();
    const rollout = await rolloutOf("stable");
    const id = rollout?.id ?? "";
    const halted = {
      rollout,
      failed: await Promise.all(
        failing.map(async ({ clientId }) => {
          const deploy = await deployOf(clientId);
          return deploy?.status;
        })
      ),
      largest: await releasesOf(largest.clientId),
      stoppedBy: await stoppedByOf("stable"),
      halts: await eventsOf("rollout.halt", id),
      told: await haltAlertsOf(id),
    };
    await resumeRollout(env, staff, { channel: "stable" });
    await runs.converge();
    const after = await rolloutOf("stable");

    expect({
      halted,
      after,
      everyone: await Promise.all(
        [...failing, largest].map(
          async ({ clientId }) => await releasesOf(clientId)
        )
      ),
      stoppedBy: await stoppedByOf("stable"),
      resumed: await db
        .select({ actor: auditEvents.actor, detail: auditEvents.detail })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "rollout.resume"),
            eq(auditEvents.target, id)
          )
        ),
      told: await haltAlertsOf(id),
    }).toStrictEqual({
      halted: {
        rollout: {
          id,
          releaseId: release,
          status: "halted",
          haltedReason: "failed",
          startedBy: staff.email,
          done: 0,
          failed: 3,
        },
        failed: ["failed", "failed", "failed"],
        // One at a time while none was done, then halted: the largest
        // never started.
        largest: on(before),
        stoppedBy: "failed",
        halts: 1,
        told: 1,
      },
      after: {
        id,
        releaseId: release,
        status: "done",
        haltedReason: "failed",
        startedBy: staff.email,
        done: 4,
        failed: 0,
      },
      everyone: [on(release), on(release), on(release), on(release)],
      stoppedBy: null,
      resumed: [
        {
          actor: staff.email,
          detail: JSON.stringify({ channel: "stable", release, cleared: 3 }),
        },
      ],
      told: 1,
    });
  });

  it("goes on past two failures, halts at the third, never counts a platform fault, and counts from 0 once resumed", async () => {
    const release = await placedRelease("feat(core): fails on three");
    const [a = "", b = "", c = "", d = "", ...rest] = await waitingClients(
      "edge",
      "k-fails",
      6
    );
    await releaseToEdge(env, [release]);
    const rollout = await rolloutOf("edge");
    if (rollout === null) {
      throw new Error("Edge has no rollout");
    }
    // The rest run the release.
    await runOn(rest, release);
    await failedOn([a, b], rollout);
    await failedOn([c], rollout, "cloudflare_429_10000");
    // C, tried again for its platform fault, and D are held by another
    // runner, so nothing starts here.
    const now = new Date();
    await db.insert(clientRuns).values(
      [c, d].map((clientId) => ({
        clientId,
        runId: `${clientId}-pbusy`,
        kind: "provision_placed" as const,
        claimedAt: now,
      }))
    );

    await rolloutPass(env);
    const atTwo = await rolloutOf("edge");
    await failedOn([d], rollout);
    await rolloutPass(env);
    await rolloutPass(env);
    const atThree = await rolloutOf("edge");
    const told = await haltAlertsOf(rollout.id);
    const halts = await eventsOf("rollout.halt", rollout.id);
    await resumeRollout(env, staff, { channel: "edge" });
    const resumed = await rolloutOf("edge");

    expect({
      atTwo: [atTwo?.status, atTwo?.failed, atTwo?.done],
      started: await startedOf([a, b, c, d]),
      atThree: [atThree?.status, atThree?.haltedReason, atThree?.failed],
      told,
      halts,
      resumed: [resumed?.status, resumed?.failed],
      cleared: await db.$count(
        clientDeploys,
        inArray(clientDeploys.clientId, [a, b, c, d])
      ),
      again: await resumeRollout(env, staff, { channel: "edge" }).then(
        () => null,
        codeOf
      ),
    }).toStrictEqual({
      atTwo: ["running", 2, 2],
      started: 0,
      atThree: ["halted", "failed", 3],
      told: 1,
      halts: 1,
      resumed: ["running", 0],
      cleared: 0,
      again: "not_halted",
    });
  });

  it("refuses to promote a release past a channel where its rollout halted, until staff resume it there", async () => {
    const release = await placedRelease("feat(core): halted on edge");
    await releaseToEdge(env, [release]);
    await db
      .update(rollouts)
      .set({ status: "halted", haltedReason: "failed" })
      .where(and(eq(rollouts.channel, "edge"), eq(rollouts.status, "running")));

    const refused = await promoteRelease(env, staff, {
      channel: "beta",
      releaseId: release,
    }).then(() => null, codeOf);
    await resumeRollout(env, staff, { channel: "edge" });
    await promoteRelease(env, staff, { channel: "beta", releaseId: release });

    const pointing = await channelReleases(db);

    expect({
      refused,
      beta: pointing.beta,
      rollout: await rolloutsOf("beta", [release]),
    }).toStrictEqual({
      refused: "previous_channel_halted",
      beta: release,
      rollout: [
        { releaseId: release, status: "running", startedBy: staff.email },
      ],
    });
  });

  it("retries a pinned client whose deploy failed when staff retry it, its channel going on meanwhile", async () => {
    const before = await placedRelease("feat(core): before");
    await releaseToEdge(env, [before]);
    const pinned = await live("edge", before);
    const other = await live("edge", before);
    const pin = await placedRelease("feat(core): pinned to");
    await using runs = followRuns();
    // The pinned client's core upload is refused once.
    cloudflare.failNext(await coreUpload(pinned.clientId), 400);
    await pinClient(env, staff, { clientId: pinned.clientId, releaseId: pin });
    await runs.converge();
    const failed = await deployOf(pinned.clientId);
    // A pinned client's failure never stops its channel: Edge's next
    // release reaches the other client.
    const next = await placedRelease("feat(core): next on edge");
    await releaseToEdge(env, [next]);
    await runs.converge();
    const otherWhileFailed = await releasesOf(other.clientId);
    const stillFailed = await deployOf(pinned.clientId);

    await retryClient(env, staff, { clientId: pinned.clientId });
    await runs.converge();

    expect({
      failed: failed?.status,
      stillFailed: stillFailed?.status,
      otherWhileFailed,
      pinned: await releasesOf(pinned.clientId),
      deploy: await deployOf(pinned.clientId),
      retried: await db.$count(
        auditEvents,
        and(
          eq(auditEvents.clientId, pinned.clientId),
          eq(auditEvents.action, "client.retry")
        )
      ),
    }).toStrictEqual({
      failed: "failed",
      stillFailed: "failed",
      otherWhileFailed: on(next),
      pinned: on(pin),
      deploy: { releaseId: pin, status: "done", error: null },
      retried: 1,
    });
  });

  it("picks up a release that reaches Edge mid-deploy on the next tick", async () => {
    const before = await placedRelease("feat(core): before");
    const edge = await live("edge", before);
    const first = await placedRelease("feat(core): deploying");
    // The first deploy's core upload is held until released.
    let held = false;
    const released = Promise.withResolvers<unknown>();
    cloudflare.afterAnswering(await coreUpload(edge.clientId), async () => {
      held = true;
      await released.promise;
    });
    await using runs = followRuns();
    await releaseToEdge(env, [first]);
    await runs.tick();
    await vi.waitFor(() => {
      if (!held) {
        throw new Error("The deploy hasn't reached core yet");
      }
    });

    const second = await placedRelease("feat(core): arrives mid-deploy");
    await releaseToEdge(env, [second]);
    // A tick while it deploys starts nothing more for it.
    await runs.tick();
    const whileDeploying = await deploysStarted(edge.clientId);
    released.resolve(true);
    await runs.settle();
    await runs.converge();

    expect({
      whileDeploying,
      edge: await releasesOf(edge.clientId),
    }).toStrictEqual({ whileDeploying: 1, edge: on(second) });
  });

  it("takes a client moved to another channel to that channel's release", async () => {
    const before = await placedRelease("feat(core): before");
    const moved = await live("stable", before);
    await using runs = followRuns();
    await promoteTo("stable", before);
    const release = await placedRelease("feat(core): on beta");
    await promoteTo("beta", release);
    await runs.converge();
    const onStable = await releasesOf(moved.clientId);

    await setClientChannel(env, staff, {
      clientId: moved.clientId,
      channel: "beta",
    });
    await runs.converge();

    expect({
      onStable,
      onBeta: await releasesOf(moved.clientId),
    }).toStrictEqual({ onStable: on(before), onBeta: on(release) });
  });

  it("provisions a new client on its channel's release, and a Stable one waits while Stable has none", async () => {
    const stableRelease = await placedRelease("feat(core): goes to stable");
    const edgeRelease = await placedRelease("feat(core): only on edge");
    const waiting = await placedClientRecord(cloudflare);
    await releaseToEdge(env, [stableRelease]);
    const refused = await placeAndProvision(env, staff, {
      clientId: waiting.clientId,
    }).then(
      () => null,
      (error: unknown) => (error instanceof PlacementError ? error.code : error)
    );
    await promoteTo("stable", stableRelease);
    await releaseToEdge(env, [edgeRelease]);
    await using runs = followRuns();

    const runId = await placeAndProvision(env, staff, {
      clientId: waiting.clientId,
    });
    await ended(adminWorkflows.provisionPlacedClient, runId);
    await runs.converge();

    expect({
      refused,
      provisioned: await releasesOf(waiting.clientId),
    }).toStrictEqual({ refused: "no_release", provisioned: on(stableRelease) });
  });

  it("never deploys one client twice from two ticks at once", async () => {
    const before = await placedRelease("feat(core): before");
    const edge = await live("edge", before);
    const release = await placedRelease("feat(core): two ticks");
    await using runs = followRuns();
    await releaseToEdge(env, [release]);

    await Promise.all([runs.tick(), runs.tick(), runs.tick()]);
    await runs.settle();
    await runs.converge();

    expect({
      started: await deploysStarted(edge.clientId),
      edge: await releasesOf(edge.clientId),
    }).toStrictEqual({ started: 1, edge: on(release) });
  });

  it("starts only what slow start allows when two passes overlap, the second acting not at all", async () => {
    const release = await placedRelease("feat(core): two passes, many clients");
    const waiting = await waitingClients("edge", "a-many", 13);
    await releaseToEdge(env, [release]);
    // The first pass is held right before its first write lands.
    let held = false;
    const released = Promise.withResolvers<unknown>();
    const holding = racingDb(async () => {
      held = true;
      await released.promise;
    });

    const first = rolloutPass({ ...env, DB: holding });
    try {
      await vi.waitFor(() => {
        if (!held) {
          throw new Error("The first pass hasn't reached a write yet");
        }
      });
      await rolloutPass(env);
    } finally {
      released.resolve(true);
    }
    const whileHeld = await startedOf(waiting);
    await first;

    expect({ whileHeld, started: await startedOf(waiting) }).toStrictEqual({
      whileHeld: 0,
      // A rollout with none done yet has 1 out.
      started: 1,
    });
  });

  it(`takes turns across channels, and starts no more than ${rolloutLimits.maxInFlight} out across the fleet, an older admin's runs counted`, async () => {
    const release = await placedRelease("feat(core): two channels at once");
    const edge = await waitingClients("edge", "e-edge", 10);
    const beta = await waitingClients("beta", "f-beta", 10);
    // Each has 10 on the release, so slow start leaves room for 11.
    await runOn(await waitingClients("edge", "e-on", 10), release);
    await runOn(await waitingClients("beta", "f-on", 10), release);
    // 12 deploys out already, as an older admin started them: no rollout's.
    const busy = await waitingClients("stable", "g-busy", 12);
    const now = new Date();
    await db.insert(clientDeploys).values(
      busy.map((clientId) => ({
        clientId,
        releaseId: release,
        runId: `deploy-older-${clientId}`,
        status: "deploying" as const,
        startedAt: now,
      }))
    );
    await promoteTo("beta", release);

    await rolloutPass(env);

    expect({
      edge: await startedOf(edge),
      beta: await startedOf(beta),
    }).toStrictEqual({ edge: 2, beta: 2 });
  });

  it("loses nothing when a pass is cut off mid-way: once its lease runs out, the next starts what it didn't, and no client twice", async () => {
    const release = await placedRelease("feat(core): a pass cut off");
    const waiting = await waitingClients("edge", "m-cut", 4);
    await runOn(await waitingClients("edge", "m-on", 3), release);
    await releaseToEdge(env, [release]);
    // The pass stops dead at its second claim, never landing it, as one
    // whose isolate was killed there: the claims before it stand.
    let claiming = false;
    let claims = 0;
    const killed = Promise.withResolvers<unknown>();
    const dying = new Proxy(env.DB, {
      get: (target, property) => {
        if (property === "prepare") {
          return (query: string) => {
            claiming ||= query.startsWith('insert into "client_runs"');
            return target.prepare(query);
          };
        }
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (claiming) {
              claiming = false;
              claims += 1;
              if (claims === 2) {
                await killed.promise;
                throw new Error("The pass was cut off");
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
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cut = rolloutPass({ ...env, DB: dying });
      await vi.waitFor(() => {
        if (claims < 2) {
          throw new Error("The pass hasn't reached its second claim yet");
        }
      });
      // A pass while it holds the lease does nothing; once the lease has
      // run out, the next goes on.
      await rolloutPass(env);
      const whileLeased = await startedOf(waiting);
      await db
        .update(leases)
        .set({ expiresAt: new Date(0) })
        .where(eq(leases.id, "reconciler"));
      await rolloutPass(env);
      killed.resolve(true);
      await cut;
      const each = await Promise.all(
        waiting.map(async (clientId) => await deploysStarted(clientId))
      );

      expect({ cutShort: whileLeased < waiting.length, each }).toStrictEqual({
        cutShort: true,
        each: waiting.map(() => 1),
      });
    } finally {
      killed.resolve(true);
      errors.mockRestore();
    }
  });

  it("settles claims whose runs were never created as the platform's fault, never halting, and starts them again", async () => {
    const release = await placedRelease("feat(core): runs never created");
    const orphans = await waitingClients("edge", "q-orphan", 3);
    await runOn(await waitingClients("edge", "q-on", 2), release);
    await releaseToEdge(env, [release]);
    const rollout = await rolloutOf("edge");
    // Claimed by a pass cut off before it created their runs, past the
    // time a run counts as starting.
    const claimedAt = new Date(Date.now() - 5 * 60_000);
    await db.batch([
      db.insert(clientRuns).values(
        orphans.map((clientId) => ({
          clientId,
          runId: `deploy-never-${clientId}`,
          kind: "deploy" as const,
          claimedAt,
        }))
      ),
      db.insert(clientDeploys).values(
        orphans.map((clientId) => ({
          clientId,
          releaseId: release,
          runId: `deploy-never-${clientId}`,
          status: "deploying" as const,
          startedAt: claimedAt,
          rolloutId: rollout?.id,
        }))
      ),
    ]);

    await rolloutPass(env);
    const after = await rolloutOf("edge");
    const failures = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "deploy.fail"),
          inArray(auditEvents.clientId, orphans)
        )
      );

    expect({
      status: after?.status,
      failed: after?.failed,
      notCreated: failures.map(({ detail }) =>
        detail?.includes('"error":"run_not_created"')
      ),
      // Tried again: 2 done, so room for 3.
      started: await startedOf(orphans),
    }).toStrictEqual({
      status: "running",
      failed: 0,
      notCreated: [true, true, true],
      started: 3,
    });
  });

  it.each(["halted", "superseded"] as const)(
    "claims nothing for a rollout %s between the pass's read and its claim",
    async (what) => {
      const release = await placedRelease(`feat(core): ${what} mid-pass`);
      const waiting = await waitingClients("edge", `n-${what}`, 3);
      await runOn(await waitingClients("edge", `n-${what}-on`, 3), release);
      await releaseToEdge(env, [release]);
      const newer = await placedRelease(`feat(core): after ${what}`);
      // Right before each write after the pass's first (its self-heal):
      // the rollout halts, or Edge moves on.
      let writes = 0;
      const racing = racingDb(async (database) => {
        writes += 1;
        if (writes < 2) {
          return;
        }
        const raced = adminDatabase(database);
        await (what === "halted"
          ? raced
              .update(rollouts)
              .set({ status: "halted", haltedReason: "failed" })
              .where(eq(rollouts.releaseId, release))
          : raced.batch(toEdge(raced, newer)));
      });

      await rolloutPass({ ...env, DB: racing });

      await expect(startedOf(waiting)).resolves.toBe(0);
    }
  );

  it("waits for an older admin's reconciler to give the lease back, and leaves the deploy run it started to finish, counted done for the rollout", async () => {
    const before = await placedRelease("feat(core): before");
    const older = await live("edge", before);
    const fresh = await live("edge", before);
    const release = await placedRelease("feat(core): deployed across versions");
    await releaseToEdge(env, [release]);
    // An older admin's reconciler holds the lease as it claims `older`:
    // with no rollout, for a `deploy` run of its own.
    await db.insert(leases).values({
      id: "reconciler",
      holder: "older-admin",
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await using runs = followRuns();
    const runId = `deploy-older-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date();
    await db.batch([
      db
        .insert(clientRuns)
        .values({
          clientId: older.clientId,
          runId,
          kind: "deploy",
          claimedAt: now,
        })
        .onConflictDoUpdate({
          target: clientRuns.clientId,
          set: {
            runId,
            kind: "deploy",
            claimedAt: now,
            attempt: 0,
            attemptKey: null,
          },
        }),
      db.insert(clientDeploys).values({
        clientId: older.clientId,
        releaseId: release,
        runId,
        status: "deploying",
        startedAt: now,
      }),
    ]);
    // Its core upload held until released.
    let held = false;
    const released = Promise.withResolvers<unknown>();
    cloudflare.afterAnswering(await coreUpload(older.clientId), async () => {
      held = true;
      await released.promise;
    });
    await adminWorkflow(env, adminWorkflows.deploy).create({
      id: runId,
      params: { clientId: older.clientId, releaseId: release },
    });
    await vi.waitFor(() => {
      if (!held) {
        throw new Error("The older run hasn't reached core yet");
      }
    });

    await rolloutPass(env);
    const whileLeased = await deploysStarted(fresh.clientId);
    // The older reconciler's tick ends: it gives the lease back.
    await db.delete(leases).where(eq(leases.holder, "older-admin"));
    await rolloutPass(env);
    const beside = await deploysStarted(fresh.clientId);
    released.resolve(true);
    await ended(adminWorkflows.deploy, runId);
    await runs.settle();
    await runs.converge();
    const edgeRollout = await rolloutOf("edge");

    expect({
      whileLeased,
      beside,
      older: await releasesOf(older.clientId),
      olderStarted: await deploysStarted(older.clientId),
      fresh: await releasesOf(fresh.clientId),
      olderDeploy: await db
        .select({
          runId: clientDeploys.runId,
          status: clientDeploys.status,
          rolloutId: clientDeploys.rolloutId,
        })
        .from(clientDeploys)
        .where(eq(clientDeploys.clientId, older.clientId))
        .get(),
      rollout: edgeRollout?.status,
    }).toStrictEqual({
      whileLeased: 0,
      // Slow start: the older admin's run is no rollout's, so 1 out.
      beside: 1,
      older: on(release),
      // Its own run's, never the pass's.
      olderStarted: 0,
      fresh: on(release),
      olderDeploy: { runId, status: "done", rolloutId: null },
      rollout: "done",
    });
  });

  it("starts nothing while a 429 blocks the deployer token, telling it once a block, nor past the budget's reserve", async () => {
    const release = await placedRelease("feat(core): over the budget");
    const waiting = await waitingClients("edge", "p-budget", 2);
    await releaseToEdge(env, [release]);
    const now = Date.now();
    const until = new Date(now + 5 * 60_000);
    const budget = {
      token: "DEPLOYER_API_TOKEN",
      remaining: 1000,
      resetAt: until,
      blockedUntil: until,
      updatedAt: new Date(now),
    };
    await db
      .insert(apiBudget)
      .values(budget)
      .onConflictDoUpdate({ target: apiBudget.token, set: budget });

    await rolloutPass(env);
    await rolloutPass(env);
    const whileBlocked = {
      started: await startedOf(waiting),
      audited: await eventsOf("rollout.blocked", until.toISOString()),
      told: await db.$count(
        alerts,
        eq(alerts.key, `blocked:${until.getTime()}`)
      ),
    };
    // The block is over, but the window has under the reserve left.
    await db
      .update(apiBudget)
      .set({ blockedUntil: null, remaining: 199 })
      .where(eq(apiBudget.token, "DEPLOYER_API_TOKEN"));
    await rolloutPass(env);
    const underReserve = await startedOf(waiting);
    await db.delete(apiBudget);

    expect({ whileBlocked, underReserve }).toStrictEqual({
      whileBlocked: { started: 0, audited: 1, told: 1 },
      underReserve: 0,
    });
  });

  it("gives the slot of a client another runner holds to the next in order", async () => {
    const release = await placedRelease("feat(core): past busy clients");
    const busy = await waitingClients("edge", "c-busy", 8);
    const free = await waitingClients("edge", "d-free", 5);
    // Each busy client has a provisioning attempt starting a moment ago.
    await Promise.all(
      busy.map(
        async (clientId) =>
          await db.insert(clientRuns).values({
            clientId,
            runId: `${clientId}-pbusy`,
            kind: "provision_placed",
            claimedAt: new Date(),
          })
      )
    );
    await releaseToEdge(env, [release]);

    await rolloutPass(env);

    expect({
      busy: await startedOf(busy),
      free: await startedOf(free),
    }).toStrictEqual({ busy: 0, free: 1 });
  });
});

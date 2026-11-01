import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  auditEvents,
  channels,
  clientDeploys,
  clients,
  clientWorkers,
} from "../src/db/schema.ts";
import type { Channel } from "../src/db/schema.ts";
import { PlacementError, placeAndProvision } from "../src/hosting/placement.ts";
import {
  pinClient,
  promoteRelease,
  releaseToEdge,
  retryChannel,
  setClientChannel,
} from "../src/rollout/channels.ts";
import { RolloutError } from "../src/rollout/errors.ts";
import { reconcile } from "../src/rollout/reconciler.ts";
import { adminWorkflows } from "../src/workflow-runs.ts";
import type { ApiCall } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, staff } from "./hosting.ts";
import {
  livePlacedClient,
  placedClientRecord,
  placedRelease,
} from "./placed.ts";
import { ended, followAdminRuns } from "./runs.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Release channels and the one reconciler (src/rollout/channels.ts,
// src/rollout/reconciler.ts): actions set the desired state, and each
// tick deploys every client whose Workers run something else than its
// target. How it can fail, each tried below:
// - a new release never reaching Edge, or reaching clients beyond it;
// - a promotion deploying a pinned client;
// - a release skipping a channel;
// - deploys going on in a channel after one failed, or never again once
//   staff retry;
// - a release that reaches Edge while Edge deploys, dropped;
// - a client moved to another channel left on its old channel's release;
// - a new client started on a release its channel doesn't have, or on
//   none while its channel has none;
// - two ticks at once deploying one client twice.

const token = "test-deployer-token-channels-3b7f2c";
const cloudflare = mockCloudflareApi(token);

/** A live client on `releaseId`, following `channel`, its id `id` when given. */
const live = async (channel: Channel, releaseId: string, id?: string) =>
  await livePlacedClient(cloudflare, releaseId, {
    channel,
    ...(id === undefined ? {} : { id }),
  });

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
 * once: `tick` is the cron's reconciler, `settle` waits for every deploy
 * started so far to end, and `converge` ticks until nothing is left to do.
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
      await reconcile(env);
    },
    settle,
    converge: async (): Promise<void> => {
      for (let round = 0; round < 4; round += 1) {
        const before = runs.of(adminWorkflows.deploy).length;
        // oxlint-disable-next-line no-await-in-loop -- one tick at a time
        await reconcile(env);
        // oxlint-disable-next-line no-await-in-loop -- one tick at a time
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

/** Whether `matches` picks out a call to upload client `account`'s core. */
const coreUpload =
  (accountId: string) =>
  (call: ApiCall): boolean =>
    call.method === "PUT" &&
    call.path.startsWith(`/accounts/${accountId}/`) &&
    call.path.endsWith("-core");

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
    }).toStrictEqual({
      edge: on(release),
      stable: on(before),
      deploy: { releaseId: release, status: "done", error: null },
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

  it("starts no new deploy on a channel once one failed, until staff retry", async () => {
    const before = await placedRelease("feat(core): before");
    const failing = await live("stable", before, "client-a-fails");
    const other = await live("stable", before, "client-b-goes");
    const late = await live("stable", before, "client-c-unpinned");
    await pinClient(env, staff, { clientId: late.clientId, releaseId: before });
    const release = await placedRelease("feat(core): fails on one");
    await using runs = followRuns();
    await promoteTo("beta", release);
    // The failing client's core upload is refused.
    cloudflare.failNext(coreUpload(failing.account.id), 400);

    await promoteRelease(env, staff, { channel: "stable", releaseId: release });
    await runs.converge();
    // Unpinned after the failure: it waits with the rest of the channel.
    await pinClient(env, staff, { clientId: late.clientId, releaseId: null });
    await runs.converge();
    const failed = await deployOf(failing.clientId);
    const whileFailed = {
      failing: {
        releaseId: failed?.releaseId,
        status: failed?.status,
        why: typeof failed?.error === "string",
      },
      other: await releasesOf(other.clientId),
      late: await releasesOf(late.clientId),
    };

    await retryChannel(env, staff, { channel: "stable" });
    await runs.converge();

    expect({
      whileFailed,
      failing: await releasesOf(failing.clientId),
      late: await releasesOf(late.clientId),
    }).toStrictEqual({
      whileFailed: {
        failing: { releaseId: release, status: "failed", why: true },
        // Out already when the first failed: it finished.
        other: on(release),
        late: on(before),
      },
      failing: on(release),
      late: on(release),
    });
  });

  it("picks up a release that reaches Edge mid-deploy on the next tick", async () => {
    const before = await placedRelease("feat(core): before");
    const edge = await live("edge", before);
    const first = await placedRelease("feat(core): deploying");
    // The first deploy's core upload is held until released.
    let held = false;
    const released = Promise.withResolvers<unknown>();
    cloudflare.afterAnswering(coreUpload(edge.account.id), async () => {
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
      destinationId: null,
    }).then(
      () => null,
      (error: unknown) => (error instanceof PlacementError ? error.code : error)
    );
    await promoteTo("stable", stableRelease);
    await releaseToEdge(env, [edgeRelease]);
    await using runs = followRuns();

    const runId = await placeAndProvision(env, staff, {
      clientId: waiting.clientId,
      destinationId: null,
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
});

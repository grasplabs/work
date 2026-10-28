import type { WorkerEntry } from "@grasp-os/shared/release";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { applySettings } from "../src/clients/apply.ts";
import { setSignIn } from "../src/clients/settings.ts";
import { cloudflareApi } from "../src/cloudflare/api.ts";
import { deployVersion } from "../src/cloudflare/workers.ts";
import {
  auditEvents,
  clientPlacements,
  clientProvisions,
  clientRuns,
  clients,
  clientWorkers,
  hostingDestinations,
  rollouts,
  rolloutTargets,
} from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { rotateClientSecrets } from "../src/deploy/rotation.ts";
import {
  runClientProvision,
  startClientRelease,
} from "../src/hosting/operation.ts";
import { releasePlacedClient } from "../src/hosting/workflow.ts";
import {
  approveRollout,
  cancelRollout,
  pauseRollout,
  pinClient,
  resumeRollout,
  retryRollout,
  startRollout,
} from "../src/rollout/control.ts";
import type { StartRolloutInput } from "../src/rollout/control.ts";
import { driftOf } from "../src/rollout/drift.ts";
import { rollbackClient, rollbackRing } from "../src/rollout/rollback.ts";
import { checkRevocation } from "../src/rollout/shared-secrets.ts";
import { isConfigPending } from "../src/rollout/targets.ts";
import { clientEndedEvent, fleetConcurrency } from "../src/rollout/workflow.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, staff } from "./hosting.ts";
import { deployPlaced, livePlacedClient, placedRelease } from "./placed.ts";
import type { PlacedClient } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Rolling a release out to placed clients (GRA-388): ring 0 first, one
// staff approval, then the fleet ring by ring, each client's operation
// run for the release (src/hosting/operation.ts). How it can fail, each
// tried below:
// - the fleet reached without approval, or after ring 0 failed;
// - a client deployed twice at once (another runner holds it), or one
//   that's pinned elsewhere, on the release already, or on a newer one;
// - one fleet client's failure stopping the others, or a retry that
//   redeploys clients that are done;
// - a rollback to what a client never ran whole, past a Durable Object
//   migration, of a secrets rollout, or of a client taken elsewhere since;
// - a rollout that goes on while paused or after it's cancelled.

const token = "test-deployer-token-rollout-5d1e7a";
const tenantToken = "test-tenant-admin-token-rollout-9c3f20";
const cloudflare = mockCloudflareApi(token, tenantToken);
/** What staff confirm of a ring before approving the next (src/rollout/control.ts). */
const ringChecked = { evalPassed: true, demoSent: true };

/** A live client in `ring` on release `releaseId`. */
const live = async (ring: number, releaseId: string): Promise<PlacedClient> =>
  await livePlacedClient(cloudflare, ring, releaseId);

/**
 * The rollouts the test starts, as the test pool lets a test follow them,
 * with the children that deploy their fleet clients: pauses and retry
 * delays going at once. Each wait is on the latest rollout started.
 */
const followRollouts = async () => {
  const runs = await introspectWorkflow(env.ROLLOUT);
  const children = await introspectWorkflow(env.ROLLOUT_CLIENT);
  for (const each of [runs, children]) {
    // oxlint-disable-next-line no-await-in-loop -- set up before any run starts
    await each.modifyAll(async (modifier) => {
      await modifier.disableSleeps();
      await modifier.disableRetryDelays();
    });
  }
  const latest = async () => {
    const all = await runs.get();
    const last = all.at(-1);
    if (last === undefined) {
      throw new Error("No rollout was started");
    }
    return last;
  };
  return {
    waitForStepResult: async (step: { name: string }) => {
      const run = await latest();
      return await run.waitForStepResult(step);
    },
    waitForStatus: async (
      status: "complete" | "errored" | "terminated" | "paused"
    ) => {
      const run = await latest();
      await run.waitForStatus(status);
    },
    /** The children started so far: one per fleet client it deployed. */
    childRuns: async () => await children.get(),
    [Symbol.asyncDispose]: async () => {
      await runs.dispose();
      await children.dispose();
    },
  };
};

/** The rollbacks the test starts, retry delays going at once. */
const followRollbacks = async () => {
  const runs = await introspectWorkflow(env.ROLLBACK_CLIENT);
  await runs.modifyAll(async (modifier) => {
    await modifier.disableRetryDelays();
  });
  return {
    /** Waits until every rollback started has ended, done or not. */
    settle: async (): Promise<void> => {
      const all = await runs.get();
      await Promise.all(
        all.map(async (run) => {
          try {
            await run.waitForStatus("complete");
          } catch {
            await run.waitForStatus("errored");
          }
        })
      );
    },
    [Symbol.asyncDispose]: async () => {
      await runs.dispose();
    },
  };
};

/** The rollout running or waiting now: one at a time. */
const openRollout = async (): Promise<string> => {
  const [open] = await db
    .select({ id: rollouts.id })
    .from(rollouts)
    .where(inArray(rollouts.status, ["running", "waiting"]));
  if (open === undefined) {
    throw new Error("No rollout is open");
  }
  return open.id;
};

/** Starts a rollout of `releaseId` for `scope`, as staff. */
const rollOut = async (
  releaseId: string,
  scope: StartRolloutInput["scope"]
): Promise<string> =>
  await startRollout(env, staff, { kind: "release", releaseId, scope });

/** The release each of the client's Workers runs, as the admin recorded it, by Worker. */
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

const rolloutRow = async (id: string) => {
  const [row] = await db
    .select({ status: rollouts.status, ring: rollouts.ring })
    .from(rollouts)
    .where(eq(rollouts.id, id));
  return row;
};

/** The rollout's targets: each client's ring, status and error, by client. */
const targetsOf = async (rolloutId: string) => {
  const rows = await db
    .select({
      clientId: rolloutTargets.clientId,
      ring: rolloutTargets.ring,
      status: rolloutTargets.status,
      error: rolloutTargets.error,
    })
    .from(rolloutTargets)
    .where(eq(rolloutTargets.rolloutId, rolloutId));
  return Object.fromEntries(
    rows.map(({ clientId, ...target }) => [clientId, target])
  );
};

/** Client `clientId`'s target in rollout `rolloutId`. */
const targetOf = async (rolloutId: string, clientId: string) => {
  const targets = await targetsOf(rolloutId);
  return targets[clientId];
};

/** Rollout `id`'s status. */
const statusOf = async (id: string) => {
  const row = await rolloutRow(id);
  return row?.status;
};

/** The runner client `clientId` has, if any. */
const runnerOf = async (clientId: string) => {
  const [row] = await db
    .select({ runId: clientRuns.runId, kind: clientRuns.kind })
    .from(clientRuns)
    .where(eq(clientRuns.clientId, clientId));
  return row ?? null;
};

/** The rollout's own audit actions, oldest first. */
const rolloutActions = async (rolloutId: string): Promise<string[]> => {
  const rows = await db
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.target, rolloutId),
        sql`${auditEvents.action} LIKE 'rollout.%'`
      )
    )
    .orderBy(asc(auditEvents.at), sql`rowid`);
  return rows.map(({ action }) => action);
};

/** How many uploads each of `client`'s scripts has had. */
const uploadsOf = (client: PlacedClient): number =>
  client.account.scriptUploads.length;

/** The code `promise` is refused with, or `resolved` if it isn't. */
const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : "thrown";
  }
  return "resolved";
};

/** Core with a Durable Object class of its own added, by a migration. */
const withExtra = (core: WorkerEntry): WorkerEntry => ({
  ...core,
  durableObjectMigrations: [
    ...core.durableObjectMigrations,
    { tag: "v2", new_sqlite_classes: ["Extra"] },
  ],
});

/**
 * Sets aside what earlier tests left: their clients offboarded and their
 * rollouts cancelled, so each test's rollout reaches only its own clients.
 */
const setAsideEarlierTests = async (): Promise<void> => {
  await db
    .update(clients)
    .set({ status: "offboarded" })
    .where(inArray(clients.status, ["active", "provisioning"]));
  await db
    .update(rollouts)
    .set({ status: "cancelled" })
    .where(inArray(rollouts.status, ["running", "waiting"]));
};

describe("rolling a release out to placed clients", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  beforeEach(setAsideEarlierTests);

  it("runs ring 0's operations, waits for one approval, then the fleet's, ring by ring, audited", async () => {
    const before = await placedRelease("feat(core): the release before");
    const internal = await live(0, before);
    const acme = await live(1, before);
    const beta = await live(2, before);
    const release = await placedRelease("feat(core): roll me out");
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "all" });
    await expect(
      run.waitForStepResult({ name: "ring 1 approved" })
    ).resolves.toBe("waiting");
    const waiting = {
      internal: await releasesOf(internal.clientId),
      acme: await releasesOf(acme.clientId),
      rollout: await rolloutRow(rolloutId),
      another: await codeOf(rollOut(release, { scope: "all" })),
    };
    await approveRollout(env, staff, rolloutId, ringChecked);
    await run.waitForStatus("complete");

    expect({
      waiting,
      internal: await releasesOf(internal.clientId),
      acme: await releasesOf(acme.clientId),
      beta: await releasesOf(beta.clientId),
      rollout: await rolloutRow(rolloutId),
      targets: await targetsOf(rolloutId),
      runners: [
        await runnerOf(internal.clientId),
        await runnerOf(acme.clientId),
        await runnerOf(beta.clientId),
      ],
      actions: await rolloutActions(rolloutId),
      again: await codeOf(approveRollout(env, staff, rolloutId, ringChecked)),
    }).toStrictEqual({
      waiting: {
        internal: on(release),
        acme: on(before),
        rollout: { status: "waiting", ring: 0 },
        another: "rollout_running",
      },
      internal: on(release),
      acme: on(release),
      beta: on(release),
      rollout: { status: "done", ring: 2 },
      targets: {
        [internal.clientId]: { ring: 0, status: "done", error: null },
        [acme.clientId]: { ring: 1, status: "done", error: null },
        [beta.clientId]: { ring: 2, status: "done", error: null },
      },
      runners: [null, null, null],
      actions: [
        "rollout.start",
        "rollout.client_start",
        "rollout.client_done",
        "rollout.wait",
        "rollout.approve",
        "rollout.client_start",
        "rollout.client_done",
        "rollout.ring",
        "rollout.client_start",
        "rollout.client_done",
        "rollout.done",
      ],
      again: "not_waiting",
    });
  });

  it("skips a client on the release already, one pinned to another and one on a newer release", async () => {
    const older = await placedRelease("feat(core): older");
    const release = await placedRelease("feat(core): the one rolled out");
    const newer = await placedRelease("feat(core): newer");
    const internal = await live(0, release);
    const pinned = await live(0, older);
    const ahead = await live(0, newer);
    await pinClient(env, staff, {
      clientId: pinned.clientId,
      releaseId: older,
    });
    const uploads = [uploadsOf(internal), uploadsOf(pinned), uploadsOf(ahead)];
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    expect({
      targets: await targetsOf(rolloutId),
      uploads: [uploadsOf(internal), uploadsOf(pinned), uploadsOf(ahead)],
    }).toStrictEqual({
      targets: {
        [internal.clientId]: {
          ring: 0,
          status: "skipped",
          error: "on_release",
        },
        [pinned.clientId]: { ring: 0, status: "skipped", error: "pinned" },
        [ahead.clientId]: { ring: 0, status: "skipped", error: "newer" },
      },
      uploads,
    });
  });

  it("runs a client on the release again for a rotation or a changed sign-in that waits, and a secrets rollout reaches every client's own release", async () => {
    const release = await placedRelease("feat(core): runs");
    const rotated = await live(0, release);
    const resigned = await live(0, release);
    await rotateClientSecrets(db, staff, rotated.clientId, new Date());
    await setSignIn(env, staff, {
      clientId: resigned.clientId,
      signIn: {
        domains: ["acme.test"],
        admins: ["ada@acme.test", "bo@acme.test"],
        googleHostedDomain: "acme.test",
      },
    });
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    const rotationLive = await db
      .select({ rotationLiveAt: clients.rotationLiveAt })
      .from(clients)
      .where(eq(clients.id, rotated.clientId))
      .get();
    const secrets = await startRollout(env, staff, {
      kind: "secrets",
      scope: { scope: "ring", ring: 0 },
    });
    await run.waitForStatus("complete");

    expect({
      first: await targetsOf(rolloutId),
      rotationLive: rotationLive?.rotationLiveAt instanceof Date,
      secrets: await targetsOf(secrets),
      releases: [
        await releasesOf(rotated.clientId),
        await releasesOf(resigned.clientId),
      ],
    }).toStrictEqual({
      first: {
        [rotated.clientId]: { ring: 0, status: "done", error: null },
        [resigned.clientId]: { ring: 0, status: "done", error: null },
      },
      rotationLive: true,
      secrets: {
        [rotated.clientId]: { ring: 0, status: "done", error: null },
        [resigned.clientId]: { ring: 0, status: "done", error: null },
      },
      releases: [on(release), on(release)],
    });
  });

  it("stops in ring 0 at a failure no retry fixes, and never reaches the fleet", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    const acme = await live(1, before);
    const release = await placedRelease("feat(core): ring 0 refuses");
    // Ring 0's connect upload is refused.
    cloudflare.failNext(
      (call) =>
        call.method === "PUT" &&
        call.path.startsWith(`/accounts/${internal.account.id}/`) &&
        call.path.endsWith("-grasp-os-connect"),
      400
    );
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStatus("errored");

    expect({
      rollout: await rolloutRow(rolloutId),
      internal: await targetOf(rolloutId, internal.clientId),
      acme: await releasesOf(acme.clientId),
      runner: await runnerOf(internal.clientId),
    }).toStrictEqual({
      rollout: { status: "failed", ring: 0 },
      internal: { ring: 0, status: "failed", error: "cloudflare_400_10000" },
      acme: on(before),
      runner: null,
    });
  });

  it("stops in ring 0 when the release fails its probe once live, the client rolled back to the release before", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    const acme = await live(1, before);
    const release = await placedRelease("feat(core): broken once live");
    const isConnectUpload = (call: { method: string; path: string }) =>
      call.method === "PUT" &&
      call.path.startsWith(`/accounts/${internal.account.id}/`) &&
      call.path.endsWith("-grasp-os-connect");
    // The release's core answers the probe as another client; the
    // rollback's connect upload finds it answering as it should again.
    internal.account.coreProbe = { asClient: "someone-else" };
    // oxlint-disable require-await -- the fake waits on these; nothing to wait for
    cloudflare.beforeAnswering(isConnectUpload, async () => {
      cloudflare.beforeAnswering(isConnectUpload, async () => {
        delete internal.account.coreProbe;
      });
    });
    // oxlint-enable require-await
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStatus("errored");

    expect({
      rollout: await rolloutRow(rolloutId),
      internal: {
        target: await targetOf(rolloutId, internal.clientId),
        runs: await releasesOf(internal.clientId),
      },
      acme: await releasesOf(acme.clientId),
    }).toStrictEqual({
      rollout: { status: "failed", ring: 0 },
      internal: {
        target: { ring: 0, status: "failed", error: "release_rolled_back" },
        runs: on(before),
      },
      acme: on(before),
    });
  });

  it("ends only a fleet client that fails, goes on to the others, and retries it in the same rollout, leaving the done ones be", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    const acme = await live(1, before);
    const beta = await live(1, before);
    const release = await placedRelease("feat(core): one client won't take");
    cloudflare.failNext(
      (call) =>
        call.method === "PUT" &&
        call.path.startsWith(`/accounts/${acme.account.id}/`) &&
        call.path.endsWith("-grasp-os-connect"),
      400
    );
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStepResult({ name: "ring 1 approved" });
    await approveRollout(env, staff, rolloutId, ringChecked);
    await run.waitForStepResult({ name: "retry 1 asked" });
    const failed = await targetsOf(rolloutId);
    const betaUploads = uploadsOf(beta);
    await retryRollout(env, staff, rolloutId);
    await run.waitForStatus("complete");

    expect({
      failed: [failed[acme.clientId], failed[beta.clientId]],
      retried: await targetsOf(rolloutId),
      releases: [
        await releasesOf(acme.clientId),
        await releasesOf(beta.clientId),
      ],
      betaUntouched: uploadsOf(beta) === betaUploads,
    }).toStrictEqual({
      failed: [
        { ring: 1, status: "failed", error: "cloudflare_400_10000" },
        { ring: 1, status: "done", error: null },
      ],
      retried: {
        [internal.clientId]: { ring: 0, status: "done", error: null },
        [acme.clientId]: { ring: 1, status: "done", error: null },
        [beta.clientId]: { ring: 1, status: "done", error: null },
      },
      releases: [on(release), on(release)],
      betaUntouched: true,
    });
  });

  it("never runs a client while another runner has it, and takes it once that run has ended", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    const release = await placedRelease("feat(core): wait your turn");
    const runId = `${internal.clientId}-pheld`;
    await db.insert(clientRuns).values({
      clientId: internal.clientId,
      runId,
      kind: "provision_placed",
      claimedAt: new Date(),
    });
    {
      await using run = await followRollouts();
      const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
      await run.waitForStatus("errored");
      expect({
        releases: await releasesOf(internal.clientId),
        target: await targetOf(rolloutId, internal.clientId),
        runner: await runnerOf(internal.clientId),
      }).toStrictEqual({
        releases: on(before),
        target: { ring: 0, status: "failed", error: "client_busy" },
        runner: { runId, kind: "provision_placed" },
      });
    }
    // An hour on, the attempt never started: it has ended.
    await db
      .update(clientRuns)
      .set({ claimedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(clientRuns.clientId, internal.clientId));
    {
      await using run = await followRollouts();
      await rollOut(release, { scope: "ring", ring: 0 });
      await run.waitForStatus("complete");
      await expect(releasesOf(internal.clientId)).resolves.toStrictEqual(
        on(release)
      );
    }
  });

  it("starts no fleet client while paused, and goes on once resumed; a cancelled one goes no further", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    const acme = await live(1, before);
    const release = await placedRelease("feat(core): paused");
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStepResult({ name: "ring 1 approved" });
    await pauseRollout(env, staff, rolloutId);
    await approveRollout(env, staff, rolloutId, ringChecked);
    // The run took the pause: what the fleet runs now is what it left.
    await run.waitForStatus("paused");
    const paused = await releasesOf(acme.clientId);
    await resumeRollout(env, staff, rolloutId);
    await run.waitForStatus("complete");

    const next = await placedRelease("feat(core): cancelled");
    const cancelled = await rollOut(next, { scope: "all" });
    await run.waitForStepResult({ name: "ring 1 approved" });
    await cancelRollout(env, staff, cancelled);

    expect({
      paused,
      resumed: await releasesOf(acme.clientId),
      cancelled: await targetOf(cancelled, acme.clientId),
      stillOn: await releasesOf(acme.clientId),
      internal: await releasesOf(internal.clientId),
    }).toMatchObject({
      paused: on(before),
      resumed: on(release),
      cancelled: { ring: 1, status: "pending" },
      stillOn: on(release),
      internal: on(next),
    });
  });

  it("refuses the next ring's approval without the eval passed and the demo sent, and goes on once both are", async () => {
    const before = await placedRelease("feat(core): before");
    await live(0, before);
    const acme = await live(1, before);
    const release = await placedRelease("feat(core): checked");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStepResult({ name: "ring 1 approved" });

    const refused = await Promise.all(
      [
        { evalPassed: false, demoSent: false },
        { evalPassed: true, demoSent: false },
        { evalPassed: false, demoSent: true },
      ].map(
        async (checks) =>
          await codeOf(approveRollout(env, staff, rolloutId, checks))
      )
    );
    const held = await rolloutRow(rolloutId);
    await approveRollout(env, staff, rolloutId, ringChecked);
    await run.waitForStatus("complete");

    expect({
      refused,
      held,
      acme: await releasesOf(acme.clientId),
    }).toStrictEqual({
      refused: [
        "ring_checks_missing",
        "ring_checks_missing",
        "ring_checks_missing",
      ],
      held: { status: "waiting", ring: 0 },
      acme: on(release),
    });
  });

  it("runs a ring's clients side by side, never more at once than its limit", async () => {
    const before = await placedRelease("feat(core): before");
    await live(0, before);
    const fleet = [];
    for (let index = 0; index < fleetConcurrency + 2; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one provisioning at a time
      fleet.push(await live(1, before));
    }
    const release = await placedRelease("feat(core): side by side");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStepResult({ name: "ring 1 approved" });
    await approveRollout(env, staff, rolloutId, ringChecked);
    await run.waitForStatus("complete");
    // Each client's account its own: how many had a call being answered at
    // once is how many ran side by side (ring 0's alone, before).
    const peak = cloudflare.peakAccounts();
    const children = await run.childRuns();

    expect({
      sideBySide: peak > 1,
      withinLimit: peak <= fleetConcurrency,
      children: children.length,
      releases: await Promise.all(
        fleet.map(async ({ clientId }) => await releasesOf(clientId))
      ),
    }).toStrictEqual({
      sideBySide: true,
      withinLimit: true,
      children: fleet.length,
      releases: fleet.map(() => on(release)),
    });
  });

  it("fails a fleet client whose run was ended outside the admin as run_ended, and retries it in the same rollout", async () => {
    const before = await placedRelease("feat(core): before");
    await live(0, before);
    const acme = await live(1, before);
    const release = await placedRelease("feat(core): ended outside");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStepResult({ name: "ring 1 approved" });
    // Its operation's first call to its account waits, so its run is
    // going when it's terminated from the dashboard.
    const held = Promise.withResolvers<boolean>();
    cloudflare.beforeAnswering(
      (call) => call.path.startsWith(`/accounts/${acme.account.id}/`),
      async () => {
        await held.promise;
      }
    );

    await approveRollout(env, staff, rolloutId, ringChecked);
    await vi.waitUntil(async () => {
      const target = await targetOf(rolloutId, acme.clientId);
      return target?.status === "deploying";
    });
    // Its first round's child, as the rollout names it, ends without
    // telling the run; the run wakes, as its wait's timeout would wake it.
    const child = await env.ROLLOUT_CLIENT.get(
      `${rolloutId}-${acme.clientId}-0`
    );
    await child.terminate();
    held.resolve(true);
    const parent = await env.ROLLOUT.get(rolloutId);
    await parent.sendEvent({ type: clientEndedEvent, payload: {} });
    await run.waitForStepResult({ name: "retry 1 asked" });
    const ended = await targetOf(rolloutId, acme.clientId);
    await retryRollout(env, staff, rolloutId);
    await run.waitForStatus("complete");

    expect({
      ended,
      retried: await targetOf(rolloutId, acme.clientId),
      releases: await releasesOf(acme.clientId),
      runner: await runnerOf(acme.clientId),
    }).toMatchObject({
      ended: { ring: 1, status: "failed", error: "run_ended" },
      retried: { ring: 1, status: "done", error: null },
      releases: on(release),
      runner: null,
    });
  });

  it("stops a rollout whose next client it just claimed when a rollback of another lands then, releasing that client", async () => {
    const before = await placedRelease("feat(core): before");
    // Ring 0 goes in the order of client ids: the first done, then the
    // second claimed.
    const [first, second] = [
      await live(0, before),
      await live(0, before),
    ].toSorted((x, y) => x.clientId.localeCompare(y.clientId));
    if (first === undefined || second === undefined) {
      throw new Error("Two clients were set up");
    }
    const release = await placedRelease("feat(core): two in a ring");
    await using rollbacks = await followRollbacks();
    // The rollout claimed the second client, and its operation's first
    // read reaches its account: the first client's rollback lands then.
    let landed = false;
    cloudflare.beforeAnswering(
      (call) => call.path.startsWith(`/accounts/${second.account.id}/`),
      async () => {
        landed = true;
        await rollbackClient(env, staff, await openRollout(), first.clientId);
        // Landed: done before the second client's call is answered.
        await rollbacks.settle();
      }
    );
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    await rollbacks.settle();
    const targets = await targetsOf(rolloutId);

    expect({
      landed,
      first: targets[first.clientId],
      rollout: await rolloutRow(rolloutId),
      // The second client ends on one release, its runner released.
      secondCoherent: new Set(Object.values(await releasesOf(second.clientId)))
        .size,
      secondRunner: await runnerOf(second.clientId),
      firstRunner: await runnerOf(first.clientId),
    }).toMatchObject({
      landed: true,
      first: { ring: 0, status: "rolled_back" },
      rollout: { status: "cancelled", ring: 0 },
      secondCoherent: 1,
      secondRunner: null,
      firstRunner: null,
    });
  });

  it("stops a paused rollout once a rollback of one of its clients cancels it, releasing every client", async () => {
    const before = await placedRelease("feat(core): before");
    const clientsInRing = [await live(0, before), await live(0, before)];
    // Ring 0 goes in the order of client ids: the first done, the second
    // paused on as its operation starts.
    const [first, second] = clientsInRing.toSorted((x, y) =>
      x.clientId.localeCompare(y.clientId)
    );
    if (first === undefined || second === undefined) {
      throw new Error("Two clients were set up");
    }
    const release = await placedRelease("feat(core): paused, then cancelled");
    cloudflare.beforeAnswering(
      (call) => call.path.startsWith(`/accounts/${second.account.id}/`),
      async () => {
        await pauseRollout(env, staff, await openRollout());
      }
    );
    await using run = await followRollouts();
    await using rollbacks = await followRollbacks();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("paused");

    await rollbackClient(env, staff, rolloutId, first.clientId);
    await rollbacks.settle();
    await vi.waitUntil(async () => {
      const status = await statusOf(rolloutId);
      return status === "cancelled";
    });
    await run.waitForStatus("complete");
    const secondReleases = await releasesOf(second.clientId);

    expect({
      rollout: await rolloutRow(rolloutId),
      first: await targetOf(rolloutId, first.clientId),
      firstOn: await releasesOf(first.clientId),
      secondCoherent: new Set(Object.values(secondReleases)).size,
      runners: [
        await runnerOf(first.clientId),
        await runnerOf(second.clientId),
      ],
    }).toMatchObject({
      rollout: { status: "cancelled" },
      first: { status: "rolled_back" },
      firstOn: on(before),
      secondCoherent: 1,
      runners: [null, null],
    });
  });

  it("keeps what a client ran before a rollout when its claim step runs again after starting its operation", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    const release = await placedRelease("feat(core): runs");
    await deployPlaced(internal.clientId, release);
    // A setting changed since: the rollout of the release it runs already
    // runs it again.
    await db
      .update(clients)
      .set({ configChangedAt: new Date() })
      .where(eq(clients.id, internal.clientId));
    // The claim step dies once, right after it started the operation and
    // before it recorded it: its retry finds the operation running.
    const prepare = env.DB.prepare.bind(env.DB);
    let died = false;
    const dying = vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
      if (!died && query.includes('set "deploy_id"')) {
        died = true;
        throw new Error("the step died");
      }
      return prepare(query);
    });
    await using run = await followRollouts();
    let rolloutId: string;
    try {
      rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
      await run.waitForStatus("complete");
    } finally {
      dying.mockRestore();
    }

    const rolledBack = await codeOf(
      rollbackClient(env, staff, rolloutId, internal.clientId)
    );

    expect({
      died,
      target: await targetOf(rolloutId, internal.clientId),
      // It ran this release before the rollout too: nothing to go back to,
      // never the release before that.
      rolledBack,
      releases: await releasesOf(internal.clientId),
    }).toMatchObject({
      died: true,
      target: { status: "done" },
      rolledBack: "nothing_to_roll_back",
      releases: on(release),
    });
  });

  it("rolls a client back to the release it ran whole before, stops the rollout, and refuses a second", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    const acme = await live(1, before);
    const release = await placedRelease("feat(core): to roll back");
    await using run = await followRollouts();
    await using rollbacks = await followRollbacks();
    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStepResult({ name: "ring 1 approved" });

    await rollbackClient(env, staff, rolloutId, internal.clientId);
    await rollbacks.settle();
    const operation = await db
      .select({
        releaseId: clientProvisions.releaseId,
        status: clientProvisions.status,
      })
      .from(clientProvisions)
      .where(eq(clientProvisions.clientId, internal.clientId))
      .get();

    expect({
      releases: await releasesOf(internal.clientId),
      operation,
      target: await targetOf(rolloutId, internal.clientId),
      rollout: await statusOf(rolloutId),
      runner: await runnerOf(internal.clientId),
      again: await codeOf(
        rollbackClient(env, staff, rolloutId, internal.clientId)
      ),
      fleet: await releasesOf(acme.clientId),
    }).toStrictEqual({
      releases: on(before),
      operation: { releaseId: before, status: "done" },
      target: { ring: 0, status: "rolled_back", error: null },
      rollout: "cancelled",
      runner: null,
      again: "nothing_to_roll_back",
      fleet: on(before),
    });
  });

  it("refuses a rollback past a Durable Object migration, of a secrets rollout, or of a client taken elsewhere since", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    const migrating = await placedRelease(
      "feat(core): a new class",
      {},
      withExtra
    );
    await using run = await followRollouts();
    const first = await rollOut(migrating, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    const past = await codeOf(
      rollbackClient(env, staff, first, internal.clientId)
    );

    const secrets = await startRollout(env, staff, {
      kind: "secrets",
      scope: { scope: "ring", ring: 0 },
    });
    await run.waitForStatus("complete");
    const ofSecrets = await codeOf(
      rollbackClient(env, staff, secrets, internal.clientId)
    );

    // A later release keeps the class: a script never loses a migration.
    const later = await placedRelease("feat(core): later", {}, withExtra);
    await rollOut(later, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    const superseded = await codeOf(
      rollbackClient(env, staff, first, internal.clientId)
    );

    expect({ past, ofSecrets, superseded }).toStrictEqual({
      past: "rollback_past_migration",
      ofSecrets: "nothing_to_roll_back",
      superseded: "superseded",
    });
  });

  it("rolls back every client of a ring the rollout reached", async () => {
    const before = await placedRelease("feat(core): before");
    const one = await live(0, before);
    const two = await live(0, before);
    const release = await placedRelease("feat(core): ring rolled back");
    await using run = await followRollouts();
    await using rollbacks = await followRollbacks();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    const started = await rollbackRing(env, staff, rolloutId, 0);
    await rollbacks.settle();

    expect({
      refused: started.map(({ refused }) => refused),
      releases: [
        await releasesOf(one.clientId),
        await releasesOf(two.clientId),
      ],
    }).toStrictEqual({
      refused: [null, null],
      releases: [on(before), on(before)],
    });
  });

  it("applies a client's settings by running its release again", async () => {
    const release = await placedRelease("feat(core): runs");
    const client = await live(0, release);
    const runs = await introspectWorkflow(env.APPLY_CLIENT);
    try {
      await runs.modifyAll(async (modifier) => {
        await modifier.disableRetryDelays();
      });
      const uploads = uploadsOf(client);
      await applySettings(env, staff, client.clientId);
      const [only] = await runs.get();
      await only?.waitForStatus("complete");
      expect({
        uploadedAgain: uploadsOf(client) > uploads,
        releases: await releasesOf(client.clientId),
        runner: await runnerOf(client.clientId),
      }).toStrictEqual({
        uploadedAgain: true,
        releases: on(release),
        runner: null,
      });
    } finally {
      await runs.dispose();
    }
  });

  it("reads a client's drift live: in sync once its operation is done, off its pin, and drifted once changed outside the admin", async () => {
    const before = await placedRelease("feat(core): before");
    const client = await live(0, before);
    const api = cloudflareApi({ token, retryDelayMs: 0 });
    const synced = await driftOf(api, db, client.clientId);
    const other = await placedRelease("feat(core): pinned to");
    await pinClient(env, staff, {
      clientId: client.clientId,
      releaseId: other,
    });
    const pinned = await driftOf(api, db, client.clientId);
    await pinClient(env, staff, { clientId: client.clientId, releaseId: null });
    // Someone sends connect back to its first version from the dashboard:
    // its upload's, before its secrets' versions.
    const connect = await db
      .select({ scriptName: clientWorkers.scriptName })
      .from(clientWorkers)
      .where(
        and(
          eq(clientWorkers.clientId, client.clientId),
          eq(clientWorkers.worker, "connect")
        )
      )
      .get();
    const scriptName = connect?.scriptName ?? "";
    const [first] = client.account.scripts.get(scriptName)?.versions ?? [];
    await deployVersion(api, client.account.id, scriptName, first?.id ?? "", {
      message: "by hand",
      force: true,
    });
    const changed = await driftOf(api, db, client.clientId);

    expect({
      synced: synced?.state,
      pinned: pinned?.state,
      changed: changed?.state,
      nobody: await driftOf(api, db, "nobody"),
    }).toStrictEqual({
      synced: "in_sync",
      pinned: "off_pin",
      changed: "drifted",
      nobody: null,
    });
  });
});

/** Where a rollout's run on a client stops for good, as a crash leaves it. */
interface RolloutCrash {
  at: "claimed" | "started" | "mid-run" | "ran";
  /** Whether it started its change on the client. */
  started: boolean;
}

const rolloutCrashes: RolloutCrash[] = [
  { at: "claimed", started: false },
  { at: "started", started: true },
  { at: "mid-run", started: true },
  { at: "ran", started: true },
];

type StaffAction = "release" | "apply" | "rollback" | "another rollout";
const staffActions: StaffAction[] = [
  "release",
  "apply",
  "rollback",
  "another rollout",
];

/**
 * What staff's `action` after a rollout died at `crash` comes to: what
 * the action answers; the releases the client runs then; whether the dead
 * rollout's rollback goes after (only while its change is the client's
 * latest); the releases it ends on; and its runner then.
 */
const rolloutWalkExpected = (
  crash: RolloutCrash,
  action: StaffAction,
  ids: { before: string; release: string; later: string }
) => {
  const split = { connect: ids.release, core: ids.before };
  if (action === "rollback") {
    return crash.started
      ? {
          acted: "resolved",
          releases: on(ids.before),
          rollbackAfter: "taken",
          endsOn: on(ids.before),
          runner: null,
        }
      : {
          acted: "nothing_to_roll_back",
          releases: on(ids.before),
          rollbackAfter: "taken",
          endsOn: on(ids.before),
          // Nothing replaced the dead rollout's claim, which has ended.
          runner: "rollout",
        };
  }
  const rollbackAfter = crash.started ? "superseded" : "nothing_to_roll_back";
  if (action === "apply") {
    if (crash.at === "mid-run") {
      // Split between releases: nothing to apply settings on, so the
      // rollout's change stays the latest, and its rollback mends it.
      return {
        acted: "nothing_deployed",
        releases: split,
        rollbackAfter: "resolved",
        endsOn: on(ids.before),
        runner: null,
      };
    }
    const runs = on(crash.at === "ran" ? ids.release : ids.before);
    return {
      acted: "resolved",
      releases: runs,
      rollbackAfter,
      endsOn: runs,
      runner: null,
    };
  }
  return {
    acted: "resolved",
    releases: on(ids.later),
    rollbackAfter,
    endsOn: on(ids.later),
    runner: null,
  };
};

/** A minute and more ago: past the window a claim or run counts as starting in. */
const longAgo = (): Date => new Date(Date.now() - 2 * 60_000);

/**
 * A client live on `before` and a rollout of `release` to it whose run
 * died at `crash.at`, as the run leaves the admin's records: the rollout
 * running, the client claimed by it (claimed, started, mid-run) or
 * released (ran, as the operation's end releases it), its target pending
 * or deploying, and its operation as far as the run took it. The run's
 * instance is gone, as long ago.
 */
const crashedRollout = async (
  crash: RolloutCrash,
  before: string,
  release: string
) => {
  const client = await live(0, before);
  const { clientId } = client;
  const rolloutId = crypto.randomUUID();
  const at = longAgo();
  await db.insert(rollouts).values({
    id: rolloutId,
    kind: "release",
    releaseId: release,
    status: "running",
    ring: 0,
    startedBy: staff.email,
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(rolloutTargets).values({
    rolloutId,
    clientId,
    ring: 0,
    status: "pending",
    updatedAt: at,
  });
  const before_ = await db
    .select({ runId: clientRuns.runId })
    .from(clientRuns)
    .where(eq(clientRuns.clientId, clientId))
    .get();
  if (before_ !== undefined) {
    await db.delete(clientRuns).where(eq(clientRuns.clientId, clientId));
  }
  await db
    .insert(clientRuns)
    .values({ clientId, runId: rolloutId, kind: "rollout", claimedAt: at });
  const holder = { clientId, runId: rolloutId };
  if (crash.started) {
    await db
      .update(rolloutTargets)
      .set({
        previous: JSON.stringify({
          release: before,
          generation: 1,
          versions: {},
          shared: {},
        }),
        status: "deploying",
      })
      .where(eq(rolloutTargets.rolloutId, rolloutId));
    const { operationId, change } = await startClientRelease(
      db,
      staff,
      holder,
      {
        releaseId: release,
      }
    );
    await db
      .update(rolloutTargets)
      .set({ deployId: operationId, change })
      .where(eq(rolloutTargets.rolloutId, rolloutId));
  }
  if (crash.at === "mid-run") {
    cloudflare.failNext(
      (call) =>
        call.method === "PUT" &&
        call.path.startsWith(`/accounts/${client.account.id}/`) &&
        call.path.endsWith("-grasp-os-core"),
      400
    );
    await runClientProvision(await deployContext(env), holder).catch(() => {
      /* the run's failure, as the crash left it */
    });
    await db
      .update(clientProvisions)
      .set({ status: "running", error: null })
      .where(eq(clientProvisions.clientId, clientId));
  }
  if (crash.at === "ran") {
    await runClientProvision(await deployContext(env), holder);
  }
  return { client, rolloutId };
};

/** Client `clientId`'s core script, as its operation recorded it. */
const coreScriptOf = async (clientId: string): Promise<string> => {
  const row = await db
    .select({ scriptName: clientWorkers.scriptName })
    .from(clientWorkers)
    .where(
      and(
        eq(clientWorkers.clientId, clientId),
        eq(clientWorkers.worker, "core")
      )
    )
    .get();
  return row?.scriptName ?? "";
};

/** The `PLATFORM_CHANGE` core's live version in `account` runs with. */
const platformChangeOf = (account: PlacedClient["account"], script: string) => {
  const state = account.scripts.get(script);
  const [only] = state?.deployments[0]?.versions ?? [];
  const version = state?.versions.find(({ id }) => id === only?.version_id);
  const bindings = z
    .array(z.looseObject({ name: z.string(), json: z.unknown().optional() }))
    .parse(version?.metadata.bindings ?? []);
  return bindings.find(({ name }) => name === "PLATFORM_CHANGE")?.json;
};

describe("a client's changes, counted", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  beforeEach(setAsideEarlierTests);

  it("refuses a rollout's rollback once anything changed the client since, even back to the rollout's release", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    const release = await placedRelease("feat(core): rolled out");
    const later = await placedRelease("feat(core): later");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    // Staff take it to a later release, then back to the rollout's.
    await deployPlaced(internal.clientId, later);
    await deployPlaced(internal.clientId, release);

    const refused = await codeOf(
      rollbackClient(env, staff, rolloutId, internal.clientId)
    );

    expect({
      refused,
      releases: await releasesOf(internal.clientId),
    }).toStrictEqual({
      refused: "superseded",
      releases: on(release),
    });
  });

  it("starts a fleet client afresh on retry once its release rolled itself back, and takes it to the release", async () => {
    const before = await placedRelease("feat(core): before");
    await live(0, before);
    const acme = await live(1, before);
    const release = await placedRelease("feat(core): broken, then fixed");
    const isConnectUpload = (call: { method: string; path: string }) =>
      call.method === "PUT" &&
      call.path.startsWith(`/accounts/${acme.account.id}/`) &&
      call.path.endsWith("-grasp-os-connect");
    // Its first try's core answers the probe as another client; the
    // rollback's upload finds it answering as it should again.
    acme.account.coreProbe = { asClient: "someone-else" };
    // oxlint-disable require-await -- the fake waits on these; nothing to wait for
    cloudflare.beforeAnswering(isConnectUpload, async () => {
      cloudflare.beforeAnswering(isConnectUpload, async () => {
        delete acme.account.coreProbe;
      });
    });
    // oxlint-enable require-await
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStepResult({ name: "ring 1 approved" });
    await approveRollout(env, staff, rolloutId, ringChecked);
    await run.waitForStepResult({ name: "retry 1 asked" });
    const failed = await targetOf(rolloutId, acme.clientId);

    await retryRollout(env, staff, rolloutId);
    await run.waitForStatus("complete");

    expect({
      failed,
      retried: await targetOf(rolloutId, acme.clientId),
      releases: await releasesOf(acme.clientId),
    }).toMatchObject({
      failed: { status: "failed", error: "release_rolled_back" },
      retried: { status: "done" },
      releases: on(release),
    });
  });

  it("rolls a retried fleet client back to what staff took it to after its first try failed, never past it", async () => {
    // Built in order: P, M, R; M isn't newer than the rollout's R.
    const p = await placedRelease("feat(core): p");
    const m = await placedRelease("feat(core): m");
    const r = await placedRelease("feat(core): r");
    await live(0, p);
    const acme = await live(1, p);
    // Its first try's core upload is refused.
    cloudflare.failNext(
      (call) =>
        call.method === "PUT" &&
        call.path.startsWith(`/accounts/${acme.account.id}/`) &&
        call.path.endsWith("-grasp-os-core"),
      400
    );
    await using run = await followRollouts();
    await using rollbacks = await followRollbacks();
    const rolloutId = await rollOut(r, { scope: "all" });
    await run.waitForStepResult({ name: "ring 1 approved" });
    await approveRollout(env, staff, rolloutId, ringChecked);
    await run.waitForStepResult({ name: "retry 1 asked" });
    // Staff take it to M, then the rollout retries it.
    await deployPlaced(acme.clientId, m);
    await retryRollout(env, staff, rolloutId);
    await run.waitForStatus("complete");
    const retried = await releasesOf(acme.clientId);

    await rollbackClient(env, staff, rolloutId, acme.clientId);
    await rollbacks.settle();

    expect({
      retried,
      back: await releasesOf(acme.clientId),
    }).toStrictEqual({
      retried: on(r),
      // Back to M, what it ran before the retry reached it: never P.
      back: on(m),
    });
  });

  it("finishes a rollback whose run step ran already when it runs again, recording it, never refusing what it did", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    const release = await placedRelease("feat(core): rolled out");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    // The rollback's run step did its work, and its result was lost: what
    // it did is on record, and the step runs again.
    const runId = `rollback-${crypto.randomUUID().slice(0, 8)}`;
    const held = { clientId: internal.clientId, runId };
    await db.insert(clientRuns).values({
      clientId: internal.clientId,
      runId,
      kind: "rollback",
      claimedAt: new Date(),
    });
    await startClientRelease(db, staff, held, {
      releaseId: before,
      rollback: true,
    });
    await runClientProvision(await deployContext(env), held);
    const rollbacks = await introspectWorkflow(env.ROLLBACK_CLIENT);
    try {
      await rollbacks.modifyAll(async (modifier) => {
        await modifier.disableRetryDelays();
        await modifier.mockStepResult({ name: "plan" }, before);
      });
      await db.insert(clientRuns).values({
        clientId: internal.clientId,
        runId,
        kind: "rollback",
        claimedAt: new Date(),
      });
      await env.ROLLBACK_CLIENT.create({
        id: runId,
        params: {
          rolloutId,
          clientId: internal.clientId,
          startedBy: staff,
        },
      });
      const [again] = await rollbacks.get();
      await again?.waitForStatus("complete");
    } finally {
      await rollbacks.dispose();
    }

    expect({
      target: await targetOf(rolloutId, internal.clientId),
      rollout: await rolloutRow(rolloutId),
      releases: await releasesOf(internal.clientId),
    }).toMatchObject({
      target: { status: "rolled_back" },
      // It had finished: a rollback stops only a rollout still going.
      rollout: { status: "done" },
      releases: on(before),
    });
  });

  it("counts settings live once core runs them, however often their run was resumed, and tells core what changed", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    const core = await coreScriptOf(internal.clientId);
    const runId = `apply-${crypto.randomUUID().slice(0, 8)}`;
    await db
      .delete(clientRuns)
      .where(eq(clientRuns.clientId, internal.clientId));
    await db.insert(clientRuns).values({
      clientId: internal.clientId,
      runId,
      kind: "apply",
      claimedAt: new Date(),
    });
    const held = { clientId: internal.clientId, runId };
    await startClientRelease(db, staff, held, {
      releaseId: before,
      again: true,
      what: "settings",
    });
    // Its core upload refused once; a setting changes before it's resumed.
    cloudflare.failNext(
      (call) => call.method === "PUT" && call.path.endsWith(`/scripts/${core}`),
      400
    );
    await runClientProvision(await deployContext(env), held).catch(() => {
      /* stopped, to resume */
    });
    await db
      .update(clients)
      .set({ configChangedAt: new Date() })
      .where(eq(clients.id, internal.clientId));
    await startClientRelease(db, staff, held, { releaseId: before });
    await runClientProvision(await deployContext(env), held);

    const client = await db
      .select({ configChangedAt: clients.configChangedAt })
      .from(clients)
      .where(eq(clients.id, internal.clientId))
      .get();
    expect({
      pending: await isConfigPending(
        db,
        internal.clientId,
        client?.configChangedAt ?? null
      ),
      what: z
        .looseObject({ what: z.string() })
        .safeParse(platformChangeOf(internal.account, core)).data?.what,
    }).toStrictEqual({ pending: false, what: "settings" });
  });

  it("leaves a sign-in changed while a run goes on waiting, though core went live after the change", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    const runId = `apply-${crypto.randomUUID().slice(0, 8)}`;
    await db
      .delete(clientRuns)
      .where(eq(clientRuns.clientId, internal.clientId));
    await db.insert(clientRuns).values({
      clientId: internal.clientId,
      runId,
      kind: "apply",
      claimedAt: new Date(),
    });
    const held = { clientId: internal.clientId, runId };
    await startClientRelease(db, staff, held, {
      releaseId: before,
      again: true,
      what: "settings",
    });
    // Staff change the sign-in once the run read the client, as its first
    // call reaches the client's account; nothing refuses a claimed client.
    cloudflare.beforeAnswering(
      (call) => call.path.startsWith(`/accounts/${internal.account.id}/`),
      async () => {
        await setSignIn(env, staff, {
          clientId: internal.clientId,
          signIn: {
            domains: ["globex.test"],
            admins: ["ada@globex.test"],
            googleHostedDomain: "globex.test",
          },
        });
      }
    );
    await runClientProvision(await deployContext(env), held);

    const client = await db
      .select({ configChangedAt: clients.configChangedAt })
      .from(clients)
      .where(eq(clients.id, internal.clientId))
      .get();
    expect({
      changed: client?.configChangedAt !== null,
      pending: await isConfigPending(
        db,
        internal.clientId,
        client?.configChangedAt ?? null
      ),
    }).toStrictEqual({ changed: true, pending: true });
  });

  it("rolls a client back only once the rollout's upload already sent has answered, so it can't land after the rollback's", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    const release = await placedRelease("feat(core): rolled out");
    const core = await coreScriptOf(internal.clientId);
    await using rollbacks = await followRollbacks();
    await using _rollouts = await followRollouts();
    // Whether the rollback has put core back.
    const coreBack = async (): Promise<boolean> => {
      const operation = await db
        .select({
          releaseId: clientProvisions.releaseId,
          step: clientProvisions.step,
          status: clientProvisions.status,
        })
        .from(clientProvisions)
        .where(eq(clientProvisions.clientId, internal.clientId))
        .get();
      return (
        operation?.releaseId === before &&
        (operation.status === "done" || operation.step === "core")
      );
    };
    const isCoreUpload = (call: { method: string; path: string }) =>
      call.method === "PUT" && call.path.endsWith(`/scripts/${core}`);
    // The rollout's core upload is on its way when staff roll the client
    // back, and answers only once the test lets it; the rollback's own
    // core upload, the next, notes whether that one was still on its way.
    // Cloudflare would still apply an upload whose sender then stopped; the
    // fake applies it only if its sender lives on, so the order is what's
    // asserted.
    const held = Promise.withResolvers<boolean>();
    let answered = false;
    let rolledBack = false;
    let sentBeforeIt: boolean | undefined;
    cloudflare.beforeAnswering(isCoreUpload, async () => {
      await rollbackClient(env, staff, await openRollout(), internal.clientId);
      rolledBack = true;
      // oxlint-disable-next-line require-await -- the fake waits on it
      cloudflare.beforeAnswering(isCoreUpload, async () => {
        sentBeforeIt = !answered;
      });
      await held.promise;
    });

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await vi.waitUntil(() => rolledBack, { timeout: 20_000 });
    // The rollback puts core back, or waits for the upload, for a while.
    await vi.waitUntil(coreBack, { timeout: 3000 }).catch(() => false);
    answered = true;
    held.resolve(true);
    await vi.waitUntil(() => sentBeforeIt !== undefined, { timeout: 20_000 });
    await rollbacks.settle();

    expect({
      target: await targetOf(rolloutId, internal.clientId),
      releases: await releasesOf(internal.clientId),
      // What Cloudflare runs, not only what the admin recorded.
      live: z
        .looseObject({ release: z.string() })
        .safeParse(platformChangeOf(internal.account, core)).data?.release,
      sentBeforeIt,
    }).toStrictEqual({
      target: { ring: 0, status: "rolled_back", error: null },
      releases: on(before),
      live: before,
      sentBeforeIt: false,
    });
  });

  it("starts a rollout's change afresh once it holds the client, when another runner changed it after the rollout read it", async () => {
    const release = await placedRelease("feat(core): runs");
    const internal = await live(0, release);
    const { clientId } = internal;
    const rolloutId = crypto.randomUUID();
    const at = longAgo();
    await db.insert(rollouts).values({
      id: rolloutId,
      kind: "secrets",
      releaseId: null,
      status: "running",
      ring: 0,
      startedBy: staff.email,
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(rolloutTargets).values({
      rolloutId,
      clientId,
      ring: 0,
      status: "pending",
      updatedAt: at,
    });
    // An earlier run of it started its change, then lost the client.
    await db.delete(clientRuns).where(eq(clientRuns.clientId, clientId));
    await db
      .insert(clientRuns)
      .values({ clientId, runId: rolloutId, kind: "rollout", claimedAt: at });
    const { operationId, change } = await startClientRelease(
      db,
      staff,
      { clientId, runId: rolloutId },
      { releaseId: release, again: true, what: "secrets" }
    );
    await db
      .update(rolloutTargets)
      .set({
        status: "deploying",
        deployId: operationId,
        change,
        previous: JSON.stringify({
          release,
          generation: 1,
          versions: {},
          shared: {},
        }),
      })
      .where(eq(rolloutTargets.rolloutId, rolloutId));
    await db.delete(clientRuns).where(eq(clientRuns.clientId, clientId));
    // Its run reads the client, then claims it; an apply that ran start to
    // finish lands just before the claim, as its operation leaves the
    // record: a change after the rollout's, done.
    const prepare = env.DB.prepare.bind(env.DB);
    const batch = env.DB.batch.bind(env.DB);
    let claiming = false;
    let raced = false;
    const preparing = vi
      .spyOn(env.DB, "prepare")
      .mockImplementation((query) => {
        if (query.startsWith('insert into "client_runs"')) {
          claiming = true;
        }
        return prepare(query);
      });
    const batching = vi
      .spyOn(env.DB, "batch")
      .mockImplementation(async (statements) => {
        if (claiming && !raced) {
          raced = true;
          await prepare(
            "update client_provisions set change = change + 1, status = 'done', what = 'settings' where client_id = ?"
          )
            .bind(clientId)
            .run();
        }
        return await batch(statements);
      });
    await using run = await followRollouts();
    try {
      await env.ROLLOUT.create({
        id: rolloutId,
        params: {
          rolloutId,
          releaseId: null,
          startedBy: { email: staff.email, sub: staff.sub },
        },
      });
      await run.waitForStatus("complete");
    } finally {
      preparing.mockRestore();
      batching.mockRestore();
    }
    const target = await db
      .select({ status: rolloutTargets.status, change: rolloutTargets.change })
      .from(rolloutTargets)
      .where(eq(rolloutTargets.rolloutId, rolloutId))
      .get();
    const operation = await db
      .select({ change: clientProvisions.change })
      .from(clientProvisions)
      .where(eq(clientProvisions.clientId, clientId))
      .get();

    expect({
      raced,
      status: target?.status,
      // Done by a change of its own, the client's latest, not the one the
      // apply moved on from.
      ranItsOwn: target?.change === operation?.change,
      afterTheApply: (target?.change ?? 0) > change + 1,
    }).toStrictEqual({
      raced: true,
      status: "done",
      ranItsOwn: true,
      afterTheApply: true,
    });
  });

  it("holds a shared secret's revocation while a Worker holding it isn't read, whatever its operation delivered", async () => {
    const release = await placedRelease("feat(core): runs");
    const internal = await live(0, release);
    const { clientId } = internal;
    const operation = await db
      .select({ progress: clientProvisions.progress })
      .from(clientProvisions)
      .where(eq(clientProvisions.clientId, clientId))
      .get();
    const { shared } = z
      .object({
        shared: z.record(z.string(), z.record(z.string(), z.string())),
      })
      .parse(JSON.parse(operation?.progress ?? "{}"));
    // Its connect in a namespace: drift reads only its core, through core's
    // health, never connect's live version.
    const placement = await db
      .select({ destinationId: clientPlacements.destinationId })
      .from(clientPlacements)
      .where(eq(clientPlacements.clientId, clientId))
      .get();
    await db
      .update(hostingDestinations)
      .set({ kind: "workers_for_platforms", namespace: "production" })
      .where(eq(hostingDestinations.id, placement?.destinationId ?? ""));
    // A secrets rollout that rotated connect's Composio key: its operation
    // delivered the store's value, as on record.
    const rolloutId = crypto.randomUUID();
    const at = longAgo();
    await db.insert(rollouts).values({
      id: rolloutId,
      kind: "secrets",
      releaseId: null,
      status: "done",
      ring: 0,
      startedBy: staff.email,
      sharedSecrets: JSON.stringify({ ...shared.core, ...shared.connect }),
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(rolloutTargets).values({
      rolloutId,
      clientId,
      ring: 0,
      status: "done",
      previous: JSON.stringify({
        release,
        generation: 1,
        versions: {},
        shared: { connect: { ...shared.connect, COMPOSIO_API_KEY: "before" } },
      }),
      updatedAt: at,
    });

    await expect(checkRevocation(env, rolloutId)).resolves.toMatchObject({
      rotated: ["COMPOSIO_API_KEY"],
      revocable: [],
      behind: { COMPOSIO_API_KEY: [clientId] },
    });
  });

  it("rolls a client back past a call marked sent long ago by a run that died with it", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    await live(1, before);
    const release = await placedRelease("feat(core): rolled out");
    await using run = await followRollouts();
    await using rollbacks = await followRollbacks();
    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStepResult({ name: "ring 1 approved" });
    // Marked sent ten minutes ago, by a run that never cleared it.
    const sentAt = Date.now() - 10 * 60_000;
    await db
      .update(clientProvisions)
      .set({
        progress: sql`json_set(${clientProvisions.progress}, '$.sending', ${sentAt})`,
      })
      .where(eq(clientProvisions.clientId, internal.clientId));

    await rollbackClient(env, staff, rolloutId, internal.clientId);
    await rollbacks.settle();

    expect({
      target: await targetOf(rolloutId, internal.clientId),
      releases: await releasesOf(internal.clientId),
    }).toStrictEqual({
      target: { ring: 0, status: "rolled_back", error: null },
      releases: on(before),
    });
  });
});

describe("a rollout's run dying on a client, and staff acting on the client after", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  beforeEach(setAsideEarlierTests);

  it.each(
    rolloutCrashes.flatMap((crash) =>
      staffActions.map((action) => ({ ...crash, action }))
    )
  )(
    "dies $at, then staff $action: the client ends on one release, and the dead rollout's rollback goes only while its change is the latest",
    async ({ action, ...crash }) => {
      const before = await placedRelease("feat(core): before");
      const release = await placedRelease("feat(core): rolled out");
      const later = await placedRelease("feat(core): later");
      const { client, rolloutId } = await crashedRollout(
        crash,
        before,
        release
      );
      const { clientId } = client;
      await using rollouts_ = await followRollouts();
      await using rollbacks = await followRollbacks();
      const applies = await introspectWorkflow(env.APPLY_CLIENT);
      const attempts = await introspectWorkflow(env.PROVISION_PLACED_CLIENT);
      try {
        for (const each of [applies, attempts]) {
          // oxlint-disable-next-line no-await-in-loop -- set up before any run
          await each.modifyAll(async (modifier) => {
            await modifier.disableRetryDelays();
          });
        }
        let acted: unknown;
        if (action === "release") {
          acted = await codeOf(
            releasePlacedClient(env, staff, clientId, { releaseId: later })
          );
          const [only] = await attempts.get();
          await only?.waitForStatus("complete");
        } else if (action === "apply") {
          acted = await codeOf(applySettings(env, staff, clientId));
          const [only] = await applies.get();
          await only?.waitForStatus("complete");
        } else if (action === "rollback") {
          acted = await codeOf(rollbackClient(env, staff, rolloutId, clientId));
          await rollbacks.settle();
        } else {
          acted = await codeOf(rollOut(later, { scope: "ring", ring: 0 }));
          await rollouts_.waitForStatus("complete");
        }
        const releases = await releasesOf(clientId);
        // The dead rollout's rollback, after: only while its change is the
        // client's latest.
        const rollbackAfter =
          action === "rollback"
            ? "taken"
            : await codeOf(rollbackClient(env, staff, rolloutId, clientId));
        await rollbacks.settle();
        const expected = rolloutWalkExpected(crash, action, {
          before,
          release,
          later,
        });

        expect({
          acted,
          releases,
          rollbackAfter,
          endsOn: await releasesOf(clientId),
          runner: await runnerOf(clientId),
        }).toMatchObject({
          ...expected,
          runner: expected.runner === "rollout" ? { runId: rolloutId } : null,
        });
      } finally {
        await applies.dispose();
        await attempts.dispose();
      }
    }
  );
});

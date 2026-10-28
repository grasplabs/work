import type { WorkerEntry } from "@grasp-os/shared/release";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { applySettings } from "../src/clients/apply.ts";
import { setSignIn } from "../src/clients/settings.ts";
import { cloudflareApi } from "../src/cloudflare/api.ts";
import { deployVersion } from "../src/cloudflare/workers.ts";
import {
  auditEvents,
  clientProvisions,
  clientRuns,
  clients,
  clientWorkers,
  rollouts,
  rolloutTargets,
} from "../src/db/schema.ts";
import { rotateClientSecrets } from "../src/deploy/rotation.ts";
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

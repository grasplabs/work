import { clientsNamespace } from "@grasp-os/shared/names";
import type { WorkerEntry } from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { applySettings } from "../src/clients/apply.ts";
import { setSignIn } from "../src/clients/settings.ts";
import { cloudflareApi } from "../src/cloudflare/api.ts";
import { deployVersion } from "../src/cloudflare/workers.ts";
import {
  alerts,
  auditEvents,
  clientPlacements,
  clientProvisions,
  clientRuns,
  clients,
  clientWorkers,
  hostingDestinations,
  releases as releaseRows,
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
import {
  isConfigPending,
  skipReason,
  targetClient,
  targetClients,
} from "../src/rollout/targets.ts";
import { clientEndedEvent, fleetConcurrency } from "../src/rollout/workflow.ts";
import { adminWorkflow, adminWorkflows } from "../src/workflow-runs.ts";
import type { AdminWorkflow } from "../src/workflow-runs.ts";
import type { ApiCall } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, destination, staff } from "./hosting.ts";
import { deployPlaced, livePlacedClient, placedRelease } from "./placed.ts";
import type { PlacedClient } from "./placed.ts";
import { evidenceFor, testLimits } from "./releases.ts";
import {
  deliverAlarm,
  followAdminRuns,
  holdBatchOf,
  reached,
  ended as runEnded,
  startsOf,
  stepResult,
  timeOutAttempt,
} from "./runs.ts";
import type { FollowedRuns, LostWrite } from "./runs.ts";
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
const cloudflare = mockCloudflareApi(token);

/** A script's own path, below an account or a dispatch namespace. */
const scriptPath = /\/scripts\/[^/]+$/u;

/**
 * Holds the caller of the next Cloudflare call `matches` picks out, once
 * it has its answer, until released: `read` waits until it is held there.
 */
const heldAfter = (matches: (call: ApiCall) => boolean) => {
  let answered = false;
  const released = Promise.withResolvers<unknown>();
  cloudflare.afterAnswering(matches, async () => {
    answered = true;
    await released.promise;
  });
  return {
    read: async () => {
      await vi.waitFor(() => {
        if (!answered) {
          throw new Error("The call hasn't been answered yet");
        }
      });
    },
    release: () => {
      released.resolve(true);
    },
  };
};
/** What staff confirm of a ring before approving the next (src/rollout/control.ts). */
const ringChecked = { evalPassed: true, demoSent: true };

/** A live client in `ring` on release `releaseId`. */
/** The account a call to the API is about, from its path. */
const accountPath = /^\/accounts\/(?<id>[^/]+)\//u;

/** The account `path`, a call to the API, is about. */
const accountOf = (path: string): string | undefined =>
  accountPath.exec(path)?.groups?.id;

/**
 * How long a held call waits for another client's to arrive before it
 * goes on alone, as it would if clients were deployed one at a time.
 */
const serialGraceMs = 2000;

const live = async (ring: number, releaseId: string): Promise<PlacedClient> =>
  await livePlacedClient(cloudflare, ring, releaseId);

/** The runs the test's followers share (`followAdminRuns`), while one follows. */
let sharedRuns: { runs: FollowedRuns; users: number } | null = null;

/** The runs every follower of the test reads, recorded once. */
const joinRuns = (): FollowedRuns => {
  sharedRuns ??= { runs: followAdminRuns(), users: 0 };
  sharedRuns.users += 1;
  return sharedRuns.runs;
};

/** Stops recording the test's runs once no follower reads them. */
const leaveRuns = async (): Promise<void> => {
  if (sharedRuns === null) {
    return;
  }
  sharedRuns.users -= 1;
  if (sharedRuns.users === 0) {
    const { runs } = sharedRuns;
    sharedRuns = null;
    await runs[Symbol.asyncDispose]();
  }
};

/**
 * The rollouts the test starts, on Workerflow, with the runs that deploy
 * their fleet clients: retries and sleeps going at once (`hurry`). Each
 * wait is on the latest rollout started.
 */
const followRollouts = async () => {
  const runs = joinRuns();
  const latest = (): string => {
    const last = runs.of(adminWorkflows.rollout).at(-1);
    if (last === undefined) {
      throw new Error("No rollout was started");
    }
    return last;
  };
  await Promise.resolve();
  return {
    waitForStepResult: async (step: { name: string }) => {
      await vi.waitFor(latest, { timeout: 10_000 });
      return await stepResult(adminWorkflows.rollout, latest(), step.name);
    },
    waitForStatus: async (
      status: "complete" | "errored" | "terminated" | "paused"
    ) => {
      await vi.waitFor(latest, { timeout: 10_000 });
      await reached(adminWorkflows.rollout, latest(), status);
    },
    /** The runs started so far for fleet clients: one per client and round. */
    childRuns: () => runs.of(adminWorkflows.rolloutClient),
    /** The runs of `workflow` started so far, while it follows. */
    runsOf: (workflow: AdminWorkflow) => runs.of(workflow),
    [Symbol.asyncDispose]: async () => {
      await leaveRuns();
    },
  };
};

/** The rollbacks the test starts, retries and sleeps going at once. */
const followRollbacks = async () => {
  const runs = joinRuns();
  await Promise.resolve();
  return {
    /** Waits until every rollback started has ended, done or not. */
    settle: async (): Promise<void> => {
      await Promise.all(
        runs
          .of(adminWorkflows.rollbackClient)
          .map(async (id) => await runEnded(adminWorkflows.rollbackClient, id))
      );
    },
    [Symbol.asyncDispose]: async () => {
      await leaveRuns();
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

/**
 * The open staff alerts of `kind` (src/alerts.ts) about `about`, a client
 * or what a platform alert's subject names (a rollout), as the inbox
 * reads them.
 */
const openAlertsOf = async (kind: string, about: string) =>
  await db
    .select({
      clientId: alerts.clientId,
      subject: alerts.subject,
      numbers: alerts.numbers,
    })
    .from(alerts)
    .where(
      and(
        eq(alerts.kind, kind),
        isNull(alerts.resolvedAt),
        or(eq(alerts.clientId, about), eq(alerts.subject, about))
      )
    );

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
  useStoreSecrets({ deployer: token });
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
        call.path.endsWith("-connect"),
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
      alerted: await openAlertsOf("rollout_failed", rolloutId),
    }).toStrictEqual({
      rollout: { status: "failed", ring: 0 },
      internal: { ring: 0, status: "failed", error: "cloudflare_400_10000" },
      acme: on(before),
      runner: null,
      alerted: [{ clientId: null, subject: rolloutId, numbers: "{}" }],
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
      call.path.endsWith("-connect");
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
        call.path.endsWith("-connect"),
      400
    );
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStepResult({ name: "ring 1 approved" });
    await approveRollout(env, staff, rolloutId, ringChecked);
    await run.waitForStepResult({ name: "retry 1 asked" });
    const failed = await targetsOf(rolloutId);
    const alerted = await openAlertsOf("rollout_failed", rolloutId);
    const betaUploads = uploadsOf(beta);
    await retryRollout(env, staff, rolloutId);
    await run.waitForStatus("complete");

    expect({
      failed: [failed[acme.clientId], failed[beta.clientId]],
      alerted,
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
      // Waiting for staff to retry it is told, whatever the channel.
      alerted: [
        {
          clientId: null,
          subject: rolloutId,
          numbers: JSON.stringify({ failed: 1 }),
        },
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
    // The fake answers every call at once, so two clients' deploys overlap
    // only if one is held open: the first call to a fleet client's account
    // waits until another fleet client's call has arrived. Side by side,
    // that comes at once; one at a time, it never does, and the held call
    // goes on after `serialGraceMs`, alone.
    const fleetAccounts = new Set(fleet.map(({ account }) => account.id));
    let firstClient: string | undefined;
    const secondArrived = Promise.withResolvers<boolean>();
    cloudflare.beforeAnswering(
      ({ path }) => {
        firstClient = accountOf(path);
        return firstClient !== undefined && fleetAccounts.has(firstClient);
      },
      async () => {
        await Promise.race([
          secondArrived.promise,
          scheduler.wait(serialGraceMs),
        ]);
      }
    );
    cloudflare.beforeAnswering(
      ({ path }) => {
        const account = accountOf(path);
        return (
          account !== undefined &&
          fleetAccounts.has(account) &&
          account !== firstClient
        );
      },
      async () => {
        secondArrived.resolve(true);
        await secondArrived.promise;
      }
    );
    await approveRollout(env, staff, rolloutId, ringChecked);
    await run.waitForStatus("complete");
    // Each client's account its own: how many had a call being answered at
    // once is how many ran side by side (ring 0's alone, before).
    const peak = cloudflare.peakAccounts();
    const children = run.childRuns();

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
    const child = await adminWorkflow(env, adminWorkflows.rolloutClient).get(
      `${rolloutId}-${acme.clientId}-0`
    );
    await child.terminate();
    held.resolve(true);
    const parent = await adminWorkflow(env, adminWorkflows.rollout).get(
      rolloutId
    );
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
    // The claim step dies once as it starts the operation: the start and
    // what it records go in one batch, so neither landed, and its retry
    // starts it.
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
    const uploads = uploadsOf(client);
    const runId = await applySettings(env, staff, client.clientId);
    const ended = await runEnded(adminWorkflows.applyClient, runId);
    expect({
      status: ended.status,
      uploadedAgain: uploadsOf(client) > uploads,
      releases: await releasesOf(client.clientId),
      runner: await runnerOf(client.clientId),
    }).toStrictEqual({
      status: "complete",
      uploadedAgain: true,
      releases: on(release),
      runner: null,
    });
  });

  it("tells staff when applying a client's settings stops, and gives the client back", async () => {
    const release = await placedRelease("feat(core): won't apply");
    const client = await live(0, release);
    // Its Workers' first upload is refused: no retry fixes that.
    cloudflare.failNext(
      (call) =>
        call.method === "PUT" &&
        call.path.startsWith(`/accounts/${client.account.id}/`) &&
        scriptPath.test(call.path),
      400
    );

    const runId = await applySettings(env, staff, client.clientId);
    const ended = await runEnded(adminWorkflows.applyClient, runId);

    expect({
      status: ended.status,
      runner: await runnerOf(client.clientId),
      alerted: await openAlertsOf("apply_failed", client.clientId),
    }).toStrictEqual({
      status: "errored",
      runner: null,
      alerted: [{ clientId: client.clientId, subject: null, numbers: "{}" }],
    });
  });

  it("applies a client's settings once when its operation's attempt times out and its retry runs, the attempt that timed out acting no more", async () => {
    const release = await placedRelease("feat(core): applied on a retry");
    const client = await live(0, release);
    // Each attempt is held once a script of the client was uploaded: the
    // first times out there, and its retry starts.
    const uploaded = (call: ApiCall): boolean =>
      call.method === "PUT" &&
      call.path.startsWith(`/accounts/${client.account.id}/`) &&
      scriptPath.test(call.path);
    const first = heldAfter(uploaded);
    const retry = heldAfter(uploaded);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let ended: Awaited<ReturnType<typeof runEnded>>;
    try {
      const runId = await applySettings(env, staff, client.clientId);
      await first.read();
      const { retried } = await timeOutAttempt(
        adminWorkflows.applyClient,
        runId
      );
      // The retry takes the client, then waits, before it sends, for the
      // call the one that timed out still has on its way. That one goes on
      // and is refused at its next check.
      await vi.waitFor(async () => {
        const claim = await db
          .select({ attempt: clientRuns.attempt })
          .from(clientRuns)
          .where(eq(clientRuns.clientId, client.clientId))
          .get();
        if ((claim?.attempt ?? 0) < 2) {
          throw new Error("The retry hasn't taken the client yet");
        }
      });
      first.release();
      await vi.waitFor(() => {
        const stopped = errors.mock.calls.some((logged) =>
          JSON.stringify(logged).includes("runner_replaced")
        );
        if (!stopped) {
          throw new Error("The attempt that timed out hasn't stopped yet");
        }
      });
      await retry.read();
      retry.release();
      await retried;
      ended = await runEnded(adminWorkflows.applyClient, runId);
    } finally {
      // Whatever failed, no run is left held, and console is itself again.
      first.release();
      retry.release();
      errors.mockRestore();
    }

    expect({
      status: ended.status,
      releases: await releasesOf(client.clientId),
      runner: await runnerOf(client.clientId),
    }).toStrictEqual({
      status: "complete",
      releases: on(release),
      runner: null,
    });
  });

  it("reports a client's settings applied when its attempt loses the step's result after the operation completed", async () => {
    const release = await placedRelease("feat(core): applied, result lost");
    const client = await live(0, release);
    let held: LostWrite | undefined;
    // Held once the apply's operation is done: its last write, which also
    // gave the client's claim back.
    using attempts = startsOf(adminWorkflows.applyClient, async (stub) => {
      held = await holdBatchOf(stub, async (database) => {
        const row = await database
          .prepare(
            "SELECT status, run_id AS runId FROM client_provisions WHERE client_id = ?"
          )
          .bind(client.clientId)
          .first<{ status: string; runId: string }>();
        return row?.status === "done" && row.runId.startsWith("apply-");
      });
    });
    try {
      await applySettings(env, staff, client.clientId);
      const [finished] = attempts.started;
      if (finished === undefined || held === undefined) {
        throw new Error("No attempt was started");
      }
      await held.committed;
      // The activation is lost before the step's result is kept: the step
      // runs again, finds the operation done, and the run succeeds.
      await deliverAlarm(adminWorkflows.applyClient, finished);
      const ended = await runEnded(adminWorkflows.applyClient, finished);

      expect({
        status: ended.status,
        releases: await releasesOf(client.clientId),
        runner: await runnerOf(client.clientId),
      }).toStrictEqual({
        status: "complete",
        releases: on(release),
        runner: null,
      });
    } finally {
      held?.lose();
    }
  });

  it("counts a rollout's client done when its attempt loses the step's result after the operation completed", async () => {
    const before = await placedRelease("feat(core): before");
    const client = await live(0, before);
    const release = await placedRelease("feat(core): deployed, result lost");
    let held: LostWrite | undefined;
    // Held once the rollout's operation on the client is done: its last
    // write, which also gave the client's claim back.
    using rollouts_ = startsOf(adminWorkflows.rollout, async (stub) => {
      held = await holdBatchOf(stub, async (database) => {
        const row = await database
          .prepare(
            "SELECT status, release_id AS releaseId FROM client_provisions WHERE client_id = ?"
          )
          .bind(client.clientId)
          .first<{ status: string; releaseId: string }>();
        return row?.status === "done" && row.releaseId === release;
      });
    });
    try {
      const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
      const [started] = rollouts_.started;
      if (started !== rolloutId || held === undefined) {
        throw new Error("The rollout's run wasn't started");
      }
      await held.committed;
      // The activation is lost before the step's result is kept: the step
      // runs again, finds the rollout's operation done, and goes on.
      await deliverAlarm(adminWorkflows.rollout, rolloutId);
      const ended = await runEnded(adminWorkflows.rollout, rolloutId);

      expect({
        status: ended.status,
        target: await targetOf(rolloutId, client.clientId),
        releases: await releasesOf(client.clientId),
        runner: await runnerOf(client.clientId),
      }).toStrictEqual({
        status: "complete",
        target: { ring: 0, status: "done", error: null },
        releases: on(release),
        runner: null,
      });
    } finally {
      held?.lose();
    }
  });

  it("counts a rollback done when its attempt loses the step's result after the operation completed", async () => {
    const before = await placedRelease("feat(core): before");
    const client = await live(0, before);
    const release = await placedRelease("feat(core): rolled back, result lost");
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await reached(adminWorkflows.rollout, rolloutId, "complete");
    let held: LostWrite | undefined;
    // Held once the rollback's operation is done: its last write, which
    // also gave the client's claim back.
    using rollbacks_ = startsOf(adminWorkflows.rollbackClient, async (stub) => {
      held = await holdBatchOf(stub, async (database) => {
        const row = await database
          .prepare(
            "SELECT status, release_id AS releaseId FROM client_provisions WHERE client_id = ?"
          )
          .bind(client.clientId)
          .first<{ status: string; releaseId: string }>();
        return row?.status === "done" && row.releaseId === before;
      });
    });
    try {
      const runId = await rollbackClient(
        env,
        staff,
        rolloutId,
        client.clientId
      );
      if (held === undefined || !rollbacks_.started.includes(runId)) {
        throw new Error("The rollback's run wasn't started");
      }
      await held.committed;
      // The activation is lost before the step's result is kept: the step
      // runs again, finds its operation done, and records the rollback.
      await deliverAlarm(adminWorkflows.rollbackClient, runId);
      const ended = await runEnded(adminWorkflows.rollbackClient, runId);

      expect({
        status: ended.status,
        target: await targetOf(rolloutId, client.clientId),
        releases: await releasesOf(client.clientId),
        runner: await runnerOf(client.clientId),
      }).toStrictEqual({
        status: "complete",
        target: { ring: 0, status: "rolled_back", error: null },
        releases: on(before),
        runner: null,
      });
    } finally {
      held?.lose();
    }
  });

  it("runs a rollout's client once when its operation's attempt times out and its retry runs, the attempt that timed out acting no more", async () => {
    const before = await placedRelease("feat(core): before");
    const client = await live(0, before);
    const release = await placedRelease("feat(core): on a retry");
    // Each attempt is held once a script of the client was uploaded: the
    // first times out there, and its retry starts.
    const uploaded = (call: ApiCall): boolean =>
      call.method === "PUT" &&
      call.path.startsWith(`/accounts/${client.account.id}/`) &&
      scriptPath.test(call.path);
    const first = heldAfter(uploaded);
    const retry = heldAfter(uploaded);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await using run = await followRollouts();
    let rolloutId = "";
    try {
      rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
      await first.read();
      const { retried } = await timeOutAttempt(
        adminWorkflows.rollout,
        rolloutId
      );
      // The retry takes the client, then waits, before it sends, for the
      // call the one that timed out still has on its way. That one goes on
      // and is refused at its next check.
      await vi.waitFor(async () => {
        const claim = await db
          .select({ attempt: clientRuns.attempt })
          .from(clientRuns)
          .where(eq(clientRuns.clientId, client.clientId))
          .get();
        if ((claim?.attempt ?? 0) < 2) {
          throw new Error("The retry hasn't taken the client yet");
        }
      });
      first.release();
      await vi.waitFor(() => {
        const stopped = errors.mock.calls.some((logged) =>
          JSON.stringify(logged).includes("runner_replaced")
        );
        if (!stopped) {
          throw new Error("The attempt that timed out hasn't stopped yet");
        }
      });
      await retry.read();
      retry.release();
      await retried;
      await run.waitForStatus("complete");
    } finally {
      // Whatever failed, no run is left held, and console is itself again.
      first.release();
      retry.release();
      errors.mockRestore();
    }

    expect({
      target: await targetOf(rolloutId, client.clientId),
      releases: await releasesOf(client.clientId),
      runner: await runnerOf(client.clientId),
    }).toStrictEqual({
      target: { ring: 0, status: "done", error: null },
      releases: on(release),
      runner: null,
    });
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
        call.path.endsWith("-core"),
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
  useStoreSecrets({ deployer: token });
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
      call.path.endsWith("-connect");
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
        call.path.endsWith("-core"),
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
    // Its change recorded on the target, as its start records it.
    const { change } = await startClientRelease(db, staff, held, {
      releaseId: before,
      rollback: true,
    });
    await db
      .update(rolloutTargets)
      .set({ rollbackChange: change })
      .where(eq(rolloutTargets.rolloutId, rolloutId));
    await runClientProvision(await deployContext(env), held);
    // Its run again, from its plan: what it did is its own change.
    await db.insert(clientRuns).values({
      clientId: internal.clientId,
      runId,
      kind: "rollback",
      claimedAt: new Date(),
    });
    await adminWorkflow(env, adminWorkflows.rollbackClient).create({
      id: runId,
      params: {
        rolloutId,
        clientId: internal.clientId,
        startedBy: staff,
      },
    });
    await reached(adminWorkflows.rollbackClient, runId, "complete");

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
    let uploading = false;
    let sentBeforeIt: boolean | undefined;
    cloudflare.beforeAnswering(isCoreUpload, async () => {
      uploading = true;
      await held.promise;
    });

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await vi.waitUntil(() => uploading, { timeout: 20_000 });
    await rollbackClient(env, staff, rolloutId, internal.clientId);
    // oxlint-disable-next-line require-await -- the fake waits on it
    cloudflare.beforeAnswering(isCoreUpload, async () => {
      sentBeforeIt = !answered;
    });
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
      await adminWorkflow(env, adminWorkflows.rollout).create({
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

  it("skips a retried client a newer release reached between the rollout's read and its claim, never taking it back", async () => {
    const before = await placedRelease("feat(core): before");
    await live(0, before);
    const acme = await live(1, before);
    const release = await placedRelease("feat(core): fails once");
    const later = await placedRelease("feat(core): later");
    cloudflare.failNext(
      (call) =>
        call.method === "PUT" &&
        call.path.startsWith(`/accounts/${acme.account.id}/`) &&
        call.path.endsWith("-connect"),
      400
    );
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStepResult({ name: "ring 1 approved" });
    await approveRollout(env, staff, rolloutId, ringChecked);
    await run.waitForStepResult({ name: "retry 1 asked" });
    // The retry reads the client, its change still the rollout's, then
    // claims it; staff's release of a newer one finishes just before.
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
          await deployPlaced(acme.clientId, later);
        }
        return await batch(statements);
      });
    try {
      await retryRollout(env, staff, rolloutId);
      await run.waitForStatus("complete");
    } finally {
      preparing.mockRestore();
      batching.mockRestore();
    }

    expect({
      raced,
      target: await targetOf(rolloutId, acme.clientId),
      releases: await releasesOf(acme.clientId),
      runner: await runnerOf(acme.clientId),
    }).toStrictEqual({
      raced: true,
      target: { ring: 1, status: "skipped", error: "newer" },
      releases: on(later),
      runner: null,
    });
  });

  it("takes a retried client back to what staff took it to after its claim died, never what it ran before that", async () => {
    const before = await placedRelease("feat(core): before");
    const staffs = await placedRelease("feat(core): staff's");
    const release = await placedRelease("feat(core): rolled out");
    await live(0, before);
    const acme = await live(1, before);
    await using run = await followRollouts();
    await using rollbacks = await followRollbacks();
    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStepResult({ name: "ring 1 approved" });
    // Its claim step dies on every try as it starts the client's change,
    // after reading what the client runs: the client ends failed.
    const prepare = env.DB.prepare.bind(env.DB);
    let dying = true;
    const starting = vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
      if (
        dying &&
        query.startsWith('update "client_provisions" set "release_id"')
      ) {
        throw new Error("the step died");
      }
      return prepare(query);
    });
    try {
      await approveRollout(env, staff, rolloutId, ringChecked);
      await run.waitForStepResult({ name: "retry 1 asked" });
    } finally {
      dying = false;
      starting.mockRestore();
    }
    const failed = await targetOf(rolloutId, acme.clientId);
    // Staff take it to another release, then retry it.
    await deployPlaced(acme.clientId, staffs);
    await retryRollout(env, staff, rolloutId);
    await run.waitForStatus("complete");

    await rollbackClient(env, staff, rolloutId, acme.clientId);
    await rollbacks.settle();

    expect({
      failed: failed?.status,
      target: await targetOf(rolloutId, acme.clientId),
      releases: await releasesOf(acme.clientId),
    }).toStrictEqual({
      failed: "failed",
      target: { ring: 1, status: "rolled_back", error: null },
      releases: on(staffs),
    });
  });

  it("takes a retried client back to what it ran before a change someone else started on the release, which the retry takes over", async () => {
    const before = await placedRelease("feat(core): before");
    const staffs = await placedRelease("feat(core): staff's");
    const release = await placedRelease("feat(core): rolled out");
    await live(0, before);
    const acme = await live(1, before);
    const isConnectUpload = (call: { method: string; path: string }) =>
      call.method === "PUT" &&
      call.path.startsWith(`/accounts/${acme.account.id}/`) &&
      call.path.endsWith("-connect");
    await using run = await followRollouts();
    await using rollbacks = await followRollbacks();
    // The rollout's change fails on its first upload.
    cloudflare.failNext(isConnectUpload, 400);
    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStepResult({ name: "ring 1 approved" });
    await approveRollout(env, staff, rolloutId, ringChecked);
    await run.waitForStepResult({ name: "retry 1 asked" });
    // Staff take it to their release, then start the rollout's, which
    // fails part way; that run is long gone when the rollout is retried.
    await deployPlaced(acme.clientId, staffs);
    cloudflare.failNext(isConnectUpload, 400);
    await deployPlaced(acme.clientId, release).catch(() => {
      /* failed part way, as staff left it */
    });
    await db
      .update(clientRuns)
      .set({ claimedAt: longAgo() })
      .where(eq(clientRuns.clientId, acme.clientId));
    await retryRollout(env, staff, rolloutId);
    await run.waitForStatus("complete");

    await rollbackClient(env, staff, rolloutId, acme.clientId);
    await rollbacks.settle();

    expect({
      target: await targetOf(rolloutId, acme.clientId),
      releases: await releasesOf(acme.clientId),
    }).toStrictEqual({
      target: { ring: 1, status: "rolled_back", error: null },
      releases: on(staffs),
    });
  });

  it("retries a rollback that failed, going on with its own change", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    const release = await placedRelease("feat(core): rolled out");
    await using run = await followRollouts();
    await using rollbacks = await followRollbacks();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    // The rollback's connect upload refused: it fails, its change started.
    cloudflare.failNext(
      (call) =>
        call.method === "PUT" &&
        call.path.startsWith(`/accounts/${internal.account.id}/`) &&
        call.path.endsWith("-connect"),
      400
    );
    await rollbackClient(env, staff, rolloutId, internal.clientId);
    await rollbacks.settle();
    const failed = await releasesOf(internal.clientId);

    const again = await codeOf(
      rollbackClient(env, staff, rolloutId, internal.clientId)
    );
    await rollbacks.settle();

    expect({
      failed,
      again,
      target: await targetOf(rolloutId, internal.clientId),
      releases: await releasesOf(internal.clientId),
    }).toStrictEqual({
      failed: on(release),
      again: "resolved",
      target: { ring: 0, status: "rolled_back", error: null },
      releases: on(before),
    });
  });

  it.each([
    {
      connect: "names the version its operation recorded",
      answering: "recorded" as const,
      held: false,
    },
    {
      connect: "answers as an earlier version, its upload's",
      answering: "earlier" as const,
      held: true,
    },
    {
      // What the probe recorded was an isolate of a version made before
      // the run's last secret: a later read names the newest.
      connect: "names a newer version than its operation recorded",
      answering: "newer" as const,
      held: true,
    },
    {
      connect: "names no version (down, or no version metadata)",
      answering: null,
      held: true,
    },
  ])(
    "revokes a namespace connect's rotated secret only while core's health says connect $connect",
    async ({ answering, held }) => {
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
      // Its connect in a namespace: drift reads it, as its core, through
      // core's health, which names the version connect answers as.
      const placement = await db
        .select({ destinationId: clientPlacements.destinationId })
        .from(clientPlacements)
        .where(eq(clientPlacements.clientId, clientId))
        .get();
      await db
        .update(hostingDestinations)
        .set({
          kind: "workers_for_platforms",
          namespace: clientsNamespace("production"),
        })
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
          shared: {
            connect: { ...shared.connect, COMPOSIO_API_KEY: "before" },
          },
        }),
        updatedAt: at,
      });

      if (answering === "earlier" || answering === "newer") {
        const connect = await db
          .select({ scriptName: clientWorkers.scriptName })
          .from(clientWorkers)
          .where(
            and(
              eq(clientWorkers.clientId, clientId),
              eq(clientWorkers.worker, "connect")
            )
          )
          .get();
        const [first] =
          internal.account.scripts.get(connect?.scriptName ?? "")?.versions ??
          [];
        if (answering === "earlier") {
          internal.account.connectAnswering = first?.id ?? null;
        } else {
          await db
            .update(clientWorkers)
            .set({ versionId: first?.id ?? null })
            .where(
              and(
                eq(clientWorkers.clientId, clientId),
                eq(clientWorkers.worker, "connect")
              )
            );
        }
      } else if (answering === null) {
        internal.account.connectAnswering = null;
      }

      await expect(checkRevocation(env, rolloutId)).resolves.toMatchObject({
        rotated: ["COMPOSIO_API_KEY"],
        revocable: held ? [] : ["COMPOSIO_API_KEY"],
        behind: { COMPOSIO_API_KEY: held ? [clientId] : [] },
      });
    }
  );

  it("rolls a client back only once an upload a timed-out attempt still has on its way has answered, however its retry goes", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    const release = await placedRelease("feat(core): rolled out");
    const core = await coreScriptOf(internal.clientId);
    await using rollbacks = await followRollbacks();
    await using _rollouts = await followRollouts();
    const isCoreUpload = (call: { method: string; path: string }) =>
      call.method === "PUT" && call.path.endsWith(`/scripts/${core}`);
    // The rollout's first attempt has core's upload on its way, held
    // unanswered, when the attempt times out and its retry starts.
    const held = Promise.withResolvers<boolean>();
    let answered = false;
    let uploading = false;
    let sentBeforeIt: boolean | undefined;
    cloudflare.beforeAnswering(isCoreUpload, async () => {
      uploading = true;
      await held.promise;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let rolloutId = "";
    try {
      rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
      await vi.waitUntil(() => uploading, { timeout: 20_000 });
      const { retried } = await timeOutAttempt(
        adminWorkflows.rollout,
        rolloutId
      );
      await vi.waitFor(async () => {
        const claim = await db
          .select({ attempt: clientRuns.attempt })
          .from(clientRuns)
          .where(eq(clientRuns.clientId, internal.clientId))
          .get();
        if ((claim?.attempt ?? 0) < 2) {
          throw new Error("The retry hasn't taken the client yet");
        }
      });
      // Staff roll the client back; the next core upload, the rollback's,
      // notes whether the held one was still on its way.
      await rollbackClient(env, staff, rolloutId, internal.clientId);
      // oxlint-disable-next-line require-await -- the fake waits on it
      cloudflare.beforeAnswering(isCoreUpload, async () => {
        sentBeforeIt = !answered;
      });
      // A while for the rollback to upload, were it to go on regardless.
      await scheduler.wait(3000);
      answered = true;
      held.resolve(true);
      await vi.waitUntil(() => sentBeforeIt !== undefined, {
        timeout: 20_000,
      });
      await rollbacks.settle();
      await retried.catch(() => {});
    } finally {
      held.resolve(true);
      errors.mockRestore();
    }

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

  it("rolls a client back past a call marked sent long ago by a run that died with it", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(0, before);
    await live(1, before);
    const release = await placedRelease("feat(core): rolled out");
    await using run = await followRollouts();
    await using rollbacks = await followRollbacks();
    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStepResult({ name: "ring 1 approved" });
    // Marked sent ten minutes ago, for the rollout's change, by a run that
    // never cleared it.
    const operation = await db
      .select({ change: clientProvisions.change })
      .from(clientProvisions)
      .where(eq(clientProvisions.clientId, internal.clientId))
      .get();
    await db
      .update(clientProvisions)
      .set({
        sending: JSON.stringify({
          "a-dead-run#1": {
            change: operation?.change ?? 0,
            at: Date.now() - 10 * 60_000,
          },
        }),
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
  useStoreSecrets({ deployer: token });
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
      let acted: unknown;
      // How the run staff started ended, when one started: done, never
      // errored or terminated.
      let endedAs: string | null = null;
      if (action === "release") {
        acted = await codeOf(
          releasePlacedClient(env, staff, clientId, { releaseId: later })
        );
        const [only] = rollouts_.runsOf(adminWorkflows.provisionPlacedClient);
        if (only !== undefined) {
          const ended = await runEnded(
            adminWorkflows.provisionPlacedClient,
            only
          );
          endedAs = ended.status;
        }
      } else if (action === "apply") {
        let runId: string | undefined;
        acted = await codeOf(
          (async () => {
            runId = await applySettings(env, staff, clientId);
          })()
        );
        if (runId !== undefined) {
          const ended = await runEnded(adminWorkflows.applyClient, runId);
          endedAs = ended.status;
        }
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
        // A run staff started ended done, if one started at all.
        endedAs: endedAs ?? "complete",
      }).toMatchObject({
        ...expected,
        runner: expected.runner === "rollout" ? { runId: rolloutId } : null,
        endedAs: "complete",
      });
    }
  );
});

/** How many rollouts were ever started. */
const rolloutCount = async (): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(rollouts);
  return row?.count ?? 0;
};

/** The ring of the `index`th of 200 clients: one in ring 0, the last alone in ring 3. */
const fleetRingOf = (index: number): number => {
  if (index === 0) {
    return 0;
  }
  return index === 199 ? 3 : 1 + (index % 2);
};

describe("rolling out a release that raises a platform limit", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(setAsideEarlierTests);

  const raised = { ...testLimits, workflowSteps: 2000 };

  /** A release raising `workflowSteps` over `previous`, with evidence on `profiles`. */
  const raising = async (
    previous: string,
    profiles: ("cloudflare" | "workerd")[]
  ): Promise<string> =>
    await placedRelease("feat(core): more workflow steps", {
      platformLimits: raised,
      previousRelease: { releaseId: previous, platformLimits: testLimits },
      limitEvidence: (release) =>
        profiles.map((profile) =>
          evidenceFor(release, "workflowSteps", 2000, profile)
        ),
    });

  /** A release after `previous` that keeps its limits. */
  const keeping = async (previous: string): Promise<string> =>
    await placedRelease("feat(core): keeps the limits", {
      platformLimits: raised,
      previousRelease: { releaseId: previous, platformLimits: raised },
    });

  it("refuses to start one whose raise has evidence only for another profile than its clients', starting nothing", async () => {
    const before = await placedRelease("feat(core): the release before");
    await live(0, before);
    const onPremOnly = await raising(before, ["workerd"]);
    const created = await rolloutCount();

    const refused = await codeOf(rollOut(onPremOnly, { scope: "all" }));

    expect({
      refused,
      created: (await rolloutCount()) - created,
    }).toStrictEqual({ refused: "limit_evidence_missing", created: 0 });
  });

  it("refuses one that skips the release whose raise has no evidence for the client's profile", async () => {
    const before = await placedRelease("feat(core): the release before");
    await live(0, before);
    const skipped = await raising(before, ["workerd"]);
    const later = await keeping(skipped);

    await expect(codeOf(rollOut(later, { scope: "all" }))).resolves.toBe(
      "limit_evidence_missing"
    );
  });

  it("rolls out a release past a raise it skips when the skipped release's evidence covers the client's profile", async () => {
    const before = await placedRelease("feat(core): the release before");
    const { clientId } = await live(0, before);
    const covered = await raising(before, ["cloudflare", "workerd"]);
    const later = await keeping(covered);
    await using run = await followRollouts();

    const rolloutId = await rollOut(later, { scope: "all" });
    await run.waitForStatus("complete");

    expect({
      target: await targetOf(rolloutId, clientId),
      releases: await releasesOf(clientId),
    }).toStrictEqual({
      target: { ring: 0, status: "done", error: null },
      releases: on(later),
    });
  });

  it("refuses nothing of a release it skips every client of, as it checks only the clients it reaches", async () => {
    const before = await placedRelease("feat(core): the release before");
    const { clientId } = await live(0, before);
    await pinClient(env, staff, { clientId, releaseId: before });
    // Recorded before platform limits were: refused for a client it reaches.
    const preLimits = await placedRelease("feat(core): no limits recorded", {
      platformLimits: null,
    });
    await using run = await followRollouts();

    const started = await codeOf(
      rollOut(preLimits, { scope: "ring", ring: 0 })
    );
    await run.waitForStatus("complete");

    expect({
      started,
      releases: await releasesOf(clientId),
    }).toStrictEqual({ started: "resolved", releases: on(before) });
  });

  it("refuses one past a release on the way the admin hasn't imported, whatever older evidence there is", async () => {
    const before = await placedRelease("feat(core): the release before");
    await live(0, before);
    // Raised with evidence for Cloudflare, then lowered again.
    const covered = await raising(before, ["cloudflare"]);
    await placedRelease("feat(core): fewer workflow steps", {
      platformLimits: testLimits,
      previousRelease: { releaseId: covered, platformLimits: raised },
    });
    // Raised again by a release the admin never imported, then kept.
    const later = await placedRelease("feat(core): keeps a raise", {
      platformLimits: raised,
      previousRelease: {
        releaseId: "r999999999-abcdef0",
        platformLimits: raised,
      },
    });

    await expect(codeOf(rollOut(later, { scope: "all" }))).resolves.toBe(
      "release_history_incomplete"
    );
  });

  it("refuses a rollback to a release from before platform limits were recorded, and changes nothing", async () => {
    const before = await placedRelease("feat(core): the release before");
    const { clientId } = await live(0, before);
    const preLimits = await placedRelease("feat(core): no limits recorded", {
      platformLimits: null,
    });
    const release = await placedRelease("feat(core): records limits");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    // What it ran before, as the rollout recorded it, made the release
    // that records no limits.
    const [target] = await db
      .select({ previous: rolloutTargets.previous })
      .from(rolloutTargets)
      .where(
        and(
          eq(rolloutTargets.rolloutId, rolloutId),
          eq(rolloutTargets.clientId, clientId)
        )
      );
    const previous = z
      .looseObject({})
      .parse(JSON.parse(target?.previous ?? "{}"));
    await db
      .update(rolloutTargets)
      .set({ previous: JSON.stringify({ ...previous, release: preLimits }) })
      .where(
        and(
          eq(rolloutTargets.rolloutId, rolloutId),
          eq(rolloutTargets.clientId, clientId)
        )
      );

    expect({
      refused: await codeOf(rollbackClient(env, staff, rolloutId, clientId)),
      releases: await releasesOf(clientId),
      runner: await runnerOf(clientId),
    }).toStrictEqual({
      refused: "release_without_limits",
      releases: on(release),
      runner: null,
    });
  });

  it("checks a rollout to hundreds of clients within the reads one request may make, refusing the last one's raise", async () => {
    const before = await placedRelease("feat(core): the release before");
    // Raised with evidence for on-premises only: a client on it already
    // goes on, one from before it can't go past it.
    const onPremOnly = await raising(before, ["workerd"]);
    const later = await keeping(onPremOnly);
    // 199 clients on the raise, one of them in ring 0, and one, in the
    // last ring, from before it: only that one is refused, after every
    // other is checked. As many as the rollout's step budget takes.
    const destinationId = await destination({ kind: "dedicated" });
    const now = new Date();
    const fleet = Array.from({ length: 200 }, (_, index) => ({
      id: `fleet-${crypto.randomUUID().slice(0, 8)}`,
      ring: fleetRingOf(index),
      runs: index === 199 ? before : onPremOnly,
    }));
    for (const { id, ring, runs } of fleet) {
      // oxlint-disable-next-line no-await-in-loop -- one client at a time
      await db.batch([
        db.insert(clients).values({
          id,
          name: id,
          ring,
          status: "active",
          createdAt: now,
          updatedAt: now,
        }),
        db.insert(clientPlacements).values({
          clientId: id,
          deploymentId: id.replace("fleet-", "d"),
          destinationId,
          policyId: "eu-storage",
          placedBy: staff.email,
          placedAt: now,
        }),
        ...(["core", "connect"] as const).map((worker) =>
          db.insert(clientWorkers).values({
            clientId: id,
            worker,
            scriptName: `${id}-grasp-os-${worker}`,
            releaseId: runs,
            versionId: crypto.randomUUID(),
            deployedAt: now,
          })
        ),
      ]);
    }
    // D1 counts every statement a request prepares against its limit.
    let reads = 0;
    const counted = new Proxy(env.DB, {
      get: (target, property) => {
        if (property === "prepare") {
          return (query: string) => {
            reads += 1;
            return target.prepare(query);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });

    const refused = await codeOf(
      startRollout({ ...env, DB: counted }, staff, {
        kind: "release",
        releaseId: later,
        scope: { scope: "all" },
      })
    );

    expect({ refused, withinLimit: reads < 1000 }).toStrictEqual({
      refused: "limit_evidence_missing",
      withinLimit: true,
    });
  });
});

describe("reading every client at once, as a rollout checks them", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(setAsideEarlierTests);

  it("reads each client as reading it alone does, so both skip alike", async () => {
    const before = await placedRelease("feat(core): before");
    const release = await placedRelease("feat(core): rolled out");
    const settled = await live(0, before);
    const changed = await live(1, before);
    const pinned = await live(1, before);
    const running = await live(1, before);
    // Its sign-in changed since core went live; another pinned; another
    // mid-change on the release, its operation not done.
    await db
      .update(clients)
      .set({ configChangedAt: new Date() })
      .where(eq(clients.id, changed.clientId));
    await pinClient(env, staff, {
      clientId: pinned.clientId,
      releaseId: before,
    });
    await db
      .update(clientProvisions)
      .set({ status: "running", releaseId: release })
      .where(eq(clientProvisions.clientId, running.clientId));
    const [row] = await db
      .select({ id: releaseRows.id, builtAt: releaseRows.builtAt })
      .from(releaseRows)
      .where(eq(releaseRows.id, release));
    if (row === undefined) {
      throw new Error("The release was imported");
    }
    const all = await targetClients(db);

    const read = await Promise.all(
      [settled, changed, pinned, running].map(async ({ clientId }) => {
        const alone = await targetClient(db, clientId);
        const together = all.get(clientId);
        return {
          equal: together,
          alone,
          skips: [
            alone === undefined ? null : skipReason(alone, row),
            together === undefined ? null : skipReason(together, row),
          ],
        };
      })
    );

    for (const { alone, equal } of read) {
      expect(equal).toStrictEqual(alone);
    }
    expect(read.map(({ skips }) => skips)).toStrictEqual([
      [null, null],
      [null, null],
      ["pinned", "pinned"],
      [null, null],
    ]);
    expect(
      read.map(({ alone }) => ({
        configPending: alone?.configPending,
        operation: alone?.operation?.status,
      }))
    ).toStrictEqual([
      { configPending: false, operation: "done" },
      { configPending: true, operation: "done" },
      { configPending: false, operation: "done" },
      { configPending: false, operation: "running" },
    ]);
  });
});

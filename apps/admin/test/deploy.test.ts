import { env } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  channels,
  clientDeploys,
  clientRuns,
  clients,
  clientWorkers,
} from "../src/db/schema.ts";
import { releaseToEdge, retryChannel } from "../src/rollout/channels.ts";
import { reconcile } from "../src/rollout/reconciler.ts";
import { adminWorkflow, adminWorkflows } from "../src/workflow-runs.ts";
import type { ApiCall } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, staff } from "./hosting.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import type { PlacedClient } from "./placed.ts";
import {
  deliverAlarm,
  ended,
  followAdminRuns,
  holdBatchOf,
  reached,
  startsOf,
  timeOutAttempt,
} from "./runs.ts";
import type { LostWrite } from "./runs.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// One client's deploy, as the reconciler starts it (src/rollout/deploy.ts,
// src/rollout/reconciler.ts), broken where it can break. How it can fail,
// each tried below:
// - a release that fails its probe once live left on the client;
// - a client deployed while another runner (an apply, provisioning) has it;
// - an attempt that timed out, or lost its step's result, acting twice or
//   counted failed;
// - a deploy whose run was terminated left deploying for good.

const token = "test-deployer-token-deploy-8c4e1b";
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

/** A live client on `releaseId`, following Edge. */
const live = async (releaseId: string): Promise<PlacedClient> =>
  await livePlacedClient(cloudflare, 1, releaseId, { channel: "edge" });

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

/** The runner client `clientId` has, if any. */
const runnerOf = async (clientId: string) => {
  const [row] = await db
    .select({ runId: clientRuns.runId, kind: clientRuns.kind })
    .from(clientRuns)
    .where(eq(clientRuns.clientId, clientId));
  return row ?? null;
};

/** Whether `call` uploads a script of client `client`'s account. */
const uploadOf =
  (client: PlacedClient) =>
  (call: ApiCall): boolean =>
    call.method === "PUT" &&
    call.path.startsWith(`/accounts/${client.account.id}/`) &&
    scriptPath.test(call.path);

/**
 * The admin's runs as the test starts them, retries and sleeps going at
 * once: `tick` is the cron's reconciler, `settle` waits for every deploy
 * started so far to end, `converge` ticks until nothing is left to do, and
 * `latest` is the newest deploy's run, once there is one.
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
    latest: async (): Promise<string> =>
      await vi.waitFor(() => {
        const last = runs.of(adminWorkflows.deploy).at(-1);
        if (last === undefined) {
          throw new Error("No deploy was started");
        }
        return last;
      }),
    [Symbol.asyncDispose]: async () => {
      await runs[Symbol.asyncDispose]();
    },
  };
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

describe("a client's deploy", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(setAsideEarlierTests);

  it("rolls a client back when the release fails its probe once live, and records the deploy failed", async () => {
    const before = await placedRelease("feat(core): before");
    await releaseToEdge(env, [before]);
    const client = await live(before);
    const release = await placedRelease("feat(core): broken once live");
    const isConnectUpload = (call: { method: string; path: string }) =>
      call.method === "PUT" &&
      call.path.startsWith(`/accounts/${client.account.id}/`) &&
      call.path.endsWith("-connect");
    // The release's core answers the probe as another client; the
    // rollback's connect upload finds it answering as it should again.
    client.account.coreProbe = { asClient: "someone-else" };
    // oxlint-disable require-await -- the fake waits on these; nothing to wait for
    cloudflare.beforeAnswering(isConnectUpload, async () => {
      cloudflare.beforeAnswering(isConnectUpload, async () => {
        delete client.account.coreProbe;
      });
    });
    // oxlint-enable require-await
    await using runs = followRuns();

    await releaseToEdge(env, [release]);
    await runs.converge();

    expect({
      deploy: await deployOf(client.clientId),
      runs: await releasesOf(client.clientId),
      runner: await runnerOf(client.clientId),
    }).toStrictEqual({
      deploy: {
        releaseId: release,
        status: "failed",
        error: "release_rolled_back",
      },
      runs: on(before),
      runner: null,
    });
  });

  it("never deploys a client while another runner has it, and deploys it once that run has ended", async () => {
    const before = await placedRelease("feat(core): before");
    const client = await live(before);
    const release = await placedRelease("feat(core): wait your turn");
    const runId = `${client.clientId}-pheld`;
    await db.insert(clientRuns).values({
      clientId: client.clientId,
      runId,
      kind: "provision_placed",
      claimedAt: new Date(),
    });
    await using runs = followRuns();
    await releaseToEdge(env, [release]);

    await runs.converge();
    const whileHeld = {
      deploy: await deployOf(client.clientId),
      releases: await releasesOf(client.clientId),
      runner: await runnerOf(client.clientId),
    };
    // An hour on, the attempt never started: it has ended.
    await db
      .update(clientRuns)
      .set({ claimedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(clientRuns.clientId, client.clientId));
    await runs.converge();

    expect({
      whileHeld,
      releases: await releasesOf(client.clientId),
    }).toStrictEqual({
      whileHeld: {
        deploy: null,
        releases: on(before),
        runner: { runId, kind: "provision_placed" },
      },
      releases: on(release),
    });
  });

  it("deploys a client once when its deploy's attempt times out and its retry runs, the attempt that timed out acting no more", async () => {
    const before = await placedRelease("feat(core): before");
    const client = await live(before);
    const release = await placedRelease("feat(core): on a retry");
    // Each attempt is held once a script of the client was uploaded: the
    // first times out there, and its retry starts.
    const first = heldAfter(uploadOf(client));
    const retry = heldAfter(uploadOf(client));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await using runs = followRuns();
    try {
      await releaseToEdge(env, [release]);
      await runs.tick();
      const runId = await runs.latest();
      await first.read();
      const { retried } = await timeOutAttempt(adminWorkflows.deploy, runId);
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
      await runs.settle();
    } finally {
      // Whatever failed, no run is left held, and console is itself again.
      first.release();
      retry.release();
      errors.mockRestore();
    }

    expect({
      deploy: await deployOf(client.clientId),
      releases: await releasesOf(client.clientId),
      runner: await runnerOf(client.clientId),
    }).toStrictEqual({
      deploy: { releaseId: release, status: "done", error: null },
      releases: on(release),
      runner: null,
    });
  });

  it("counts a deploy done when its attempt loses the step's result after the operation completed", async () => {
    const before = await placedRelease("feat(core): before");
    const client = await live(before);
    const release = await placedRelease("feat(core): deployed, result lost");
    let held: LostWrite | undefined;
    // Held once the deploy's operation on the client is done: its last
    // write, which also gave the client's attempt back.
    using deploys = startsOf(adminWorkflows.deploy, async (stub) => {
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
      await releaseToEdge(env, [release]);
      await reconcile(env);
      const [started] = deploys.started;
      if (started === undefined || held === undefined) {
        throw new Error("The deploy's run wasn't started");
      }
      await held.committed;
      // The activation is lost before the step's result is kept: the step
      // runs again, finds the deploy's operation done, and goes on.
      await deliverAlarm(adminWorkflows.deploy, started);
      const run = await ended(adminWorkflows.deploy, started);

      expect({
        status: run.status,
        deploy: await deployOf(client.clientId),
        releases: await releasesOf(client.clientId),
        runner: await runnerOf(client.clientId),
      }).toStrictEqual({
        status: "complete",
        deploy: { releaseId: release, status: "done", error: null },
        releases: on(release),
        runner: null,
      });
    } finally {
      held?.lose();
    }
  });

  it("settles a deploy whose run was terminated mid-way as failed on the next tick, and deploys the client again once staff retry", async () => {
    const before = await placedRelease("feat(core): before");
    const client = await live(before);
    const release = await placedRelease("feat(core): terminated");
    const held = heldAfter(uploadOf(client));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await using runs = followRuns();
    let settled: Awaited<ReturnType<typeof deployOf>> = null;
    try {
      await releaseToEdge(env, [release]);
      await runs.tick();
      const runId = await runs.latest();
      await held.read();
      const instance = await adminWorkflow(env, adminWorkflows.deploy).get(
        runId
      );
      await instance.terminate();
      await reached(adminWorkflows.deploy, runId, "terminated");
      held.release();
      await runs.tick();
      settled = await deployOf(client.clientId);
    } finally {
      held.release();
      errors.mockRestore();
    }
    await retryChannel(env, staff, { channel: "edge" });
    await runs.converge();

    expect({
      settled,
      releases: await releasesOf(client.clientId),
    }).toStrictEqual({
      settled: { releaseId: release, status: "failed", error: "run_ended" },
      releases: on(release),
    });
  });
});

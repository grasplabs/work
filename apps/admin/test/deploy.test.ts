import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  auditEvents,
  channels,
  clientDeploys,
  clientProvisions,
  clientRuns,
  clients,
  clientWorkers,
} from "../src/db/schema.ts";
import { retryChannel } from "../src/rollout/channels.ts";
import { reconcile } from "../src/rollout/reconciler.ts";
import { checkRevocation } from "../src/rollout/shared-secrets.ts";
import { deliveredShared } from "../src/rollout/targets.ts";
import { adminWorkflow, adminWorkflows } from "../src/workflow-runs.ts";
import type { ApiCall } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { releaseToEdge } from "./edge.ts";
import { db, staff } from "./hosting.ts";
import { livePlacedClient, placedRelease, scriptsOf } from "./placed.ts";
import type { PlacedClient } from "./placed.ts";
import {
  deliverAlarm,
  ended,
  followAdminRuns,
  holdBatchOf,
  holdSecretReadsOf,
  reached,
  startsOf,
  timeOutAttempt,
} from "./runs.ts";
import type { HeldReads, LostWrite } from "./runs.ts";
import {
  emptyStoreSecret,
  setStoreSecret,
  useStoreSecrets,
} from "./secrets-store.ts";

// One client's deploy, as the reconciler starts it (src/rollout/deploy.ts,
// src/rollout/reconciler.ts), broken where it can break. How it can fail,
// each tried below:
// - a release that fails its probe once live left on the client;
// - a client deployed while another runner (an apply, provisioning) has it;
// - an attempt that timed out, or lost its step's result, acting twice or
//   counted failed;
// - an attempt killed mid-step (its isolate past its memory limit) failing
//   the deploy with the engine's words, not the step it stopped in;
// - a deploy whose run was terminated left deploying for good;
// - a change in Secrets Store (a value changed, put back, added or
//   removed) never reaching a client, or reaching it again and again;
// - a secrets deploy that failed never tried again once staff retry;
// - an old secret called revocable while a client still runs it.

const token = "test-deployer-token-deploy-8c4e1b";
const cloudflare = mockCloudflareApi(token);

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
  await livePlacedClient(cloudflare, releaseId, { channel: "edge" });

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

/** How many deploys of client `clientId` started, as the audit log keeps them. */
const startedOf = async (clientId: string): Promise<number> =>
  await db.$count(
    auditEvents,
    and(
      eq(auditEvents.clientId, clientId),
      eq(auditEvents.action, "deploy.start")
    )
  );

/** The shared secrets client `clientId`'s operation last delivered, by name, whatever Worker holds them. */
const deliveredNames = async (clientId: string): Promise<string[]> => {
  const row = await db
    .select({ progress: clientProvisions.progress })
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId))
    .get();
  const delivered = deliveredShared(row?.progress ?? null);
  return [
    ...new Set(
      Object.values(delivered).flatMap((prints) => Object.keys(prints))
    ),
  ].toSorted();
};

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

/** Whether `call` uploads one of client `client`'s scripts. */
const uploadOf = async (
  client: PlacedClient
): Promise<(call: ApiCall) => boolean> => {
  const { core, connect } = await scriptsOf(client.clientId);
  return (call) =>
    call.method === "PUT" &&
    (call.path.endsWith(`/scripts/${core}`) ||
      call.path.endsWith(`/scripts/${connect}`));
};

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
    client.core.coreProbe = { asClient: "someone-else" };
    // oxlint-disable require-await -- the fake waits on these; nothing to wait for
    cloudflare.beforeAnswering(isConnectUpload, async () => {
      cloudflare.beforeAnswering(isConnectUpload, async () => {
        delete client.core.coreProbe;
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
    const first = heldAfter(await uploadOf(client));
    const retry = heldAfter(await uploadOf(client));
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

  it("records the step each attempt killed mid-step reached, and fails the deploy there once none is left, not with the engine's words", async () => {
    const before = await placedRelease("feat(core): before");
    const client = await live(before);
    const release = await placedRelease("feat(core): too big to upload");
    const { core } = await scriptsOf(client.clientId);
    // Each attempt is held in core's step, once it read core's script:
    // there its isolate dies, as one past its memory limit does.
    const coreRead = (call: ApiCall) =>
      call.method === "GET" && call.path.endsWith(`/scripts/${core}`);
    const attempts = [
      heldAfter(coreRead),
      heldAfter(coreRead),
      heldAfter(coreRead),
    ];
    const takeovers: Promise<void>[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await using runs = followRuns();
    try {
      await releaseToEdge(env, [release]);
      await runs.tick();
      const runId = await runs.latest();
      for (const attempt of attempts) {
        // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
        await attempt.read();
        // Another activation takes the run over: the engine finds the
        // attempt ended without an outcome, as after its isolate died.
        // It settles only once the retry it starts is done, so it isn't
        // waited for here.
        takeovers.push(deliverAlarm(adminWorkflows.deploy, runId));
      }
      const run = await ended(adminWorkflows.deploy, runId);
      const lost = await db
        .select({ detail: auditEvents.detail })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.clientId, client.clientId),
            eq(auditEvents.action, "provision.attempt_lost")
          )
        );

      expect({
        status: run.status,
        deploy: await deployOf(client.clientId),
        lost: lost.map(({ detail }) =>
          z
            .object({ attempt: z.number(), step: z.string() })
            .parse(JSON.parse(detail ?? "{}"))
        ),
        releases: await releasesOf(client.clientId),
      }).toStrictEqual({
        status: "errored",
        deploy: {
          releaseId: release,
          status: "failed",
          error: "attempt_lost: core",
        },
        lost: [
          { attempt: 1, step: "core" },
          { attempt: 2, step: "core" },
        ],
        releases: { connect: release, core: before },
      });
    } finally {
      for (const attempt of attempts) {
        attempt.release();
      }
      await Promise.allSettled(takeovers);
      errors.mockRestore();
    }
  });

  it("records only the lost attempt when its retry fails its probe and rolls back, never the rollback as another loss", async () => {
    const before = await placedRelease("feat(core): before");
    await releaseToEdge(env, [before]);
    const client = await live(before);
    const release = await placedRelease("feat(core): lost, then broken");
    const { core } = await scriptsOf(client.clientId);
    // The first attempt dies in core's step; its retry goes live and fails
    // its probe, and its rollback finds core answering as it should again.
    const first = heldAfter(
      (call: ApiCall) =>
        call.method === "GET" && call.path.endsWith(`/scripts/${core}`)
    );
    const isConnectUpload = (call: { method: string; path: string }) =>
      call.method === "PUT" &&
      call.path.startsWith(`/accounts/${client.account.id}/`) &&
      call.path.endsWith("-connect");
    client.core.coreProbe = { asClient: "someone-else" };
    // oxlint-disable require-await -- the fake waits on these; nothing to wait for
    cloudflare.beforeAnswering(isConnectUpload, async () => {
      cloudflare.beforeAnswering(isConnectUpload, async () => {
        delete client.core.coreProbe;
      });
    });
    // oxlint-enable require-await
    const takeovers: Promise<void>[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await using runs = followRuns();
    try {
      await releaseToEdge(env, [release]);
      await runs.tick();
      const runId = await runs.latest();
      await first.read();
      takeovers.push(deliverAlarm(adminWorkflows.deploy, runId));
      await ended(adminWorkflows.deploy, runId);
      const lost = await db
        .select({ detail: auditEvents.detail })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.clientId, client.clientId),
            eq(auditEvents.action, "provision.attempt_lost")
          )
        );

      expect({
        deploy: await deployOf(client.clientId),
        lost: lost.map(({ detail }) =>
          z
            .object({ attempt: z.number(), step: z.string() })
            .parse(JSON.parse(detail ?? "{}"))
        ),
        releases: await releasesOf(client.clientId),
      }).toStrictEqual({
        deploy: {
          releaseId: release,
          status: "failed",
          error: "release_rolled_back",
        },
        lost: [{ attempt: 1, step: "core" }],
        releases: on(before),
      });
    } finally {
      first.release();
      await Promise.allSettled(takeovers);
      errors.mockRestore();
    }
  });

  it("fails a deploy whose every attempt is killed before its first step there, as the operation it started is its own", async () => {
    const before = await placedRelease("feat(core): before");
    const client = await live(before);
    const release = await placedRelease("feat(core): lost before validating");
    // Each attempt is held reading its secrets, before its operation's
    // first step: there its isolate dies.
    let reads: HeldReads | undefined;
    using deploys = startsOf(adminWorkflows.deploy, async (stub) => {
      reads = await holdSecretReadsOf(stub, "CLIENT_KEY");
    });
    const takeovers: Promise<void>[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await releaseToEdge(env, [release]);
      await reconcile(env);
      const [runId] = deploys.started;
      if (runId === undefined || reads === undefined) {
        throw new Error("The deploy's run wasn't started");
      }
      for (const attempt of [1, 2, 3]) {
        // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
        await reads.reached(attempt);
        takeovers.push(deliverAlarm(adminWorkflows.deploy, runId));
      }
      const run = await ended(adminWorkflows.deploy, runId);

      expect({
        status: run.status,
        deploy: await deployOf(client.clientId),
        releases: await releasesOf(client.clientId),
      }).toStrictEqual({
        status: "errored",
        deploy: {
          releaseId: release,
          status: "failed",
          error: "attempt_lost: validated",
        },
        releases: on(before),
      });
    } finally {
      reads?.release();
      await Promise.allSettled(takeovers);
      errors.mockRestore();
    }
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
    const held = heldAfter(await uploadOf(client));
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

/** The shared-secret fingerprints client `clientId`'s operation last delivered, by Worker. */
const printsOf = async (clientId: string) => {
  const row = await db
    .select({ progress: clientProvisions.progress })
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId))
    .get();
  return deliveredShared(row?.progress ?? null);
};

describe("shared secrets as desired state", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(setAsideEarlierTests);

  it("deploys each client once when Secrets Store changes, then calls the changed secret revocable", async () => {
    const release = await placedRelease("feat(core): runs");
    await releaseToEdge(env, [release]);
    const first = await live(release);
    const second = await live(release);
    await using runs = followRuns();
    // Given what the store holds by their deploys: nothing to do.
    await runs.converge();
    const before = [
      await startedOf(first.clientId),
      await startedOf(second.clientId),
    ];
    // Deploy platform copied a new Composio key into the store.
    await setStoreSecret(
      env.COMPOSIO_API_KEY,
      "COMPOSIO_API_KEY",
      "composio-key-rotated"
    );

    await runs.converge();
    // Settled: further ticks start nothing more.
    await runs.converge();
    const revocation = await checkRevocation(env);

    expect({
      before,
      started: [
        await startedOf(first.clientId),
        await startedOf(second.clientId),
      ],
      deploys: [
        await deployOf(first.clientId),
        await deployOf(second.clientId),
      ],
      revocable:
        typeof revocation === "string"
          ? revocation
          : revocation.revocable.includes("COMPOSIO_API_KEY"),
      behind:
        typeof revocation === "string"
          ? revocation
          : revocation.behind.COMPOSIO_API_KEY,
    }).toStrictEqual({
      before: [0, 0],
      started: [1, 1],
      deploys: [
        { releaseId: release, status: "done", error: null },
        { releaseId: release, status: "done", error: null },
      ],
      revocable: true,
      behind: [],
    });
  });

  it("deploys a client again when the store's earlier value is put back", async () => {
    const release = await placedRelease("feat(core): runs");
    await releaseToEdge(env, [release]);
    const client = await live(release);
    const original = await printsOf(client.clientId);
    await using runs = followRuns();
    await setStoreSecret(
      env.COMPOSIO_API_KEY,
      "COMPOSIO_API_KEY",
      "composio-key-new"
    );
    await runs.converge();
    const changed = await printsOf(client.clientId);

    // Put back as it was.
    await setStoreSecret(
      env.COMPOSIO_API_KEY,
      "COMPOSIO_API_KEY",
      "composio-key"
    );
    await runs.converge();
    await runs.converge();

    expect({
      changedAway:
        changed.connect?.COMPOSIO_API_KEY !==
        original.connect?.COMPOSIO_API_KEY,
      restored: await printsOf(client.clientId),
      started: await startedOf(client.clientId),
    }).toStrictEqual({ changedAway: true, restored: original, started: 2 });
  });

  it("delivers a provider key added to the store to a client that didn't have it", async () => {
    const release = await placedRelease("feat(core): runs");
    await releaseToEdge(env, [release]);
    const client = await live(release);
    await using runs = followRuns();
    const before = await deliveredNames(client.clientId);
    await setStoreSecret(
      env.ANTHROPIC_API_KEY,
      "ANTHROPIC_API_KEY",
      "anthropic-key"
    );

    await runs.converge();
    await runs.converge();
    const after = await deliveredNames(client.clientId);

    expect({
      before: before.includes("ANTHROPIC_API_KEY"),
      after: after.includes("ANTHROPIC_API_KEY"),
      started: await startedOf(client.clientId),
      deploy: await deployOf(client.clientId),
    }).toStrictEqual({
      before: false,
      after: true,
      started: 1,
      deploy: { releaseId: release, status: "done", error: null },
    });
  });

  it("takes a provider key removed from the store off a client that had it", async () => {
    const release = await placedRelease("feat(core): runs");
    await releaseToEdge(env, [release]);
    await setStoreSecret(
      env.ANTHROPIC_API_KEY,
      "ANTHROPIC_API_KEY",
      "anthropic-key"
    );
    const client = await live(release);
    await using runs = followRuns();
    const before = await deliveredNames(client.clientId);
    // Staff take the key out of the store.
    await emptyStoreSecret(env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY");

    await runs.converge();
    await runs.converge();
    const after = await deliveredNames(client.clientId);

    expect({
      before: before.includes("ANTHROPIC_API_KEY"),
      after: after.includes("ANTHROPIC_API_KEY"),
      started: await startedOf(client.clientId),
      deploy: await deployOf(client.clientId),
    }).toStrictEqual({
      before: true,
      after: false,
      started: 1,
      deploy: { releaseId: release, status: "done", error: null },
    });
  });

  it("leaves a client whose secrets deploy failed until staff retry, then deploys it again", async () => {
    const release = await placedRelease("feat(core): runs");
    await releaseToEdge(env, [release]);
    const client = await live(release);
    await using runs = followRuns();
    await setStoreSecret(
      env.COMPOSIO_API_KEY,
      "COMPOSIO_API_KEY",
      "composio-key-rotated"
    );
    // The secrets deploy's first upload is refused: nothing is delivered.
    cloudflare.failNext(await uploadOf(client), 400);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let failed: Awaited<ReturnType<typeof deployOf>> = null;
    let whileFailed = 0;
    try {
      await runs.converge();
      failed = await deployOf(client.clientId);
      // Failed: ticks leave it for staff.
      await runs.converge();
      whileFailed = await startedOf(client.clientId);
    } finally {
      errors.mockRestore();
    }

    await retryChannel(env, staff, { channel: "edge" });
    await runs.converge();

    expect({
      failed: failed?.status,
      whileFailed,
      started: await startedOf(client.clientId),
      deploy: await deployOf(client.clientId),
    }).toStrictEqual({
      failed: "failed",
      whileFailed: 1,
      started: 2,
      deploy: { releaseId: release, status: "done", error: null },
    });
  });

  it.each([
    {
      connect: "names the version its operation recorded",
      answering: "recorded" as const,
      held: false,
    },
    {
      connect: "answers as an earlier version",
      answering: "earlier" as const,
      held: true,
    },
    {
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
    "calls a namespace connect's secret revocable only while core's health says connect $connect",
    async ({ answering, held }) => {
      const release = await placedRelease("feat(core): runs");
      const internal = await live(release);
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
      // Its connect in the namespace: drift reads it, as its core, through
      // core's health, which names the version connect answers as. Its
      // operation delivered the store's Composio key, as on record.
      expect(shared.connect).toHaveProperty("COMPOSIO_API_KEY");

      // A version of connect's other than the one its operation recorded.
      const earlier = "an-earlier-version";
      if (answering === "earlier") {
        internal.core.connectAnswering = earlier;
      } else if (answering === "newer") {
        await db
          .update(clientWorkers)
          .set({ versionId: earlier })
          .where(
            and(
              eq(clientWorkers.clientId, clientId),
              eq(clientWorkers.worker, "connect")
            )
          );
      } else if (answering === null) {
        internal.core.connectAnswering = null;
      }

      const revocation = await checkRevocation(env);
      expect(
        typeof revocation === "string"
          ? revocation
          : {
              revocable: revocation.revocable.includes("COMPOSIO_API_KEY"),
              behind: revocation.behind.COMPOSIO_API_KEY,
            }
      ).toStrictEqual({ revocable: !held, behind: held ? [clientId] : [] });
    }
  );
});

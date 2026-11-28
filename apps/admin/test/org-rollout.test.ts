import { releaseSteps, restoresFrom } from "@grasp-os/shared/release-apply";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq, inArray, like } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  alerts,
  apiBudget,
  auditEvents,
  channels,
  clientDeploys,
  clientRuns,
  clients,
  clientWorkers,
  rollouts as rolloutRows,
} from "../src/db/schema.ts";
import { operationPhases } from "../src/hosting/operation.ts";
import { rolloutPass } from "../src/rollout/scheduler.ts";
import { claimRun, currentRun, hasEnded, takeAttempt } from "../src/runners.ts";
import { adminWorkflow, adminWorkflows } from "../src/workflow-runs.ts";
import type { ApiCall } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { releaseToEdge } from "./edge.ts";
import { db } from "./hosting.ts";
import { livePlacedClient, placedRelease, scriptsOf } from "./placed.ts";
import type { PlacedClient } from "./placed.ts";
import { onPi } from "./releases.ts";
import {
  deliverAlarm,
  ended,
  followAdminRuns,
  holdBatchOf,
  hurry,
  journalOf,
  reached,
  runObject,
  wrapBindingOf,
} from "./runs.ts";
import type { LostWrite } from "./runs.ts";
import { emptyStoreSecret, useStoreSecrets } from "./secrets-store.ts";

// One organization's rollout of a release, as the fleet's pass starts it
// (src/rollout/org-rollout.ts): a step a phase, restored once install
// started, broken where it can break. Each test starts the run as the pass
// will (`startRollout`): the client claimed, its deploy recorded, the run
// created.

const token = "test-deployer-token-org-rollout-5d2a9c";

/** How long a test waits for a run to get somewhere: long, as a loaded machine is slow. */
const patiently = { timeout: 20_000, interval: 50 } as const;
const cloudflare = mockCloudflareApi(token);
const rollouts = adminWorkflows.orgRollout;

/** A live client on `releaseId`, following Edge. */
const live = async (releaseId: string): Promise<PlacedClient> =>
  await livePlacedClient(cloudflare, releaseId, { channel: "edge" });

/**
 * Starts client `clientId`'s rollout of `releaseId`, as the pass does:
 * claimed in place of a run that ended (none while one goes, as for any
 * runner), its deploy recorded as the release's running rollout's, then
 * the run created. Its id; undefined
 * when another runner has the client.
 */
const startRollout = async (
  clientId: string,
  releaseId: string
): Promise<string | undefined> => {
  const current = await currentRun(env, clientId);
  if (current !== null && !hasEnded(current.status)) {
    return undefined;
  }
  const runId = await claimRun(
    db,
    "system",
    clientId,
    current?.runId ?? null,
    { action: "deploy.start", clientId, target: releaseId },
    { kind: "rollout", runId: `rollout-${crypto.randomUUID().slice(0, 12)}` }
  );
  if (runId === undefined) {
    return undefined;
  }
  // Edge's rollout of the release, as the pass admits it to, when there's one.
  const rollout = await db
    .select({ id: rolloutRows.id })
    .from(rolloutRows)
    .where(
      and(
        eq(rolloutRows.releaseId, releaseId),
        eq(rolloutRows.status, "running")
      )
    )
    .get();
  const deploy = {
    releaseId,
    runId,
    status: "deploying" as const,
    error: null,
    startedAt: new Date(),
    endedAt: null,
    rolloutId: rollout?.id ?? null,
  };
  await db
    .insert(clientDeploys)
    .values({ clientId, ...deploy })
    .onConflictDoUpdate({ target: clientDeploys.clientId, set: deploy });
  await adminWorkflow(env, rollouts).create({
    id: runId,
    params: { clientId, releaseId },
  });
  return runId;
};

/** `startRollout`, which must start. */
const rollOut = async (clientId: string, releaseId: string) => {
  const runId = await startRollout(clientId, releaseId);
  if (runId === undefined) {
    throw new Error(`${clientId}'s rollout didn't start`);
  }
  return runId;
};

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

/** Client `clientId`'s deploy, and the runner it has. */
const deployOf = async (clientId: string) => ({
  deploy:
    (await db
      .select({
        releaseId: clientDeploys.releaseId,
        status: clientDeploys.status,
        error: clientDeploys.error,
      })
      .from(clientDeploys)
      .where(eq(clientDeploys.clientId, clientId))
      .get()) ?? null,
  runner:
    (await db
      .select({ runId: clientRuns.runId })
      .from(clientRuns)
      .where(eq(clientRuns.clientId, clientId))
      .get()) ?? null,
});

/** Fields `keys` of the details of client `clientId`'s audit events `action`, in order. */
const auditedOf = async (
  clientId: string,
  action: string,
  keys: readonly string[] = []
): Promise<Record<string, unknown>[]> => {
  const rows = await db
    .select({ detail: auditEvents.detail })
    .from(auditEvents)
    .where(
      and(eq(auditEvents.clientId, clientId), eq(auditEvents.action, action))
    )
    .orderBy(auditEvents.at);
  return rows.map(({ detail }) => {
    const parsed = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(detail ?? "{}"));
    return Object.fromEntries(keys.map((key) => [key, parsed[key]]));
  });
};

/** What client `clientId`'s alert says now, if it has one. */
const alertOf = async (clientId: string) => {
  const row = await db
    .select({ failing: alerts.failing, event: alerts.event })
    .from(alerts)
    .where(eq(alerts.key, `deploy:${clientId}`))
    .get();
  return row === undefined
    ? null
    : {
        failing: row.failing,
        kind: z.object({ kind: z.string() }).parse(JSON.parse(row.event)).kind,
      };
};

/** Uploads of client `client`'s scripts, by Worker, as the fake got them. */
const uploadsOf = async (client: PlacedClient) => {
  const scripts = await scriptsOf(client.clientId);
  const count = (script: string) =>
    cloudflare.calls.filter(
      ({ method, path }) =>
        method === "PUT" &&
        path.startsWith(`/accounts/${client.account.id}/`) &&
        path.endsWith(`/scripts/${script}`)
    ).length;
  return { connect: count(scripts.connect), core: count(scripts.core) };
};

/** Whether `call` uploads the Worker `script` names. */
const uploading =
  (script: string) =>
  (call: { method: string; path: string }): boolean =>
    call.method === "PUT" && call.path.endsWith(`/scripts/${script}`);

/** Run `id`'s attempts at its step `name`, as its journal keeps them. */
const attemptsAt = async (id: string, name: string) => {
  const { steps, attempts } = await journalOf(rollouts, id);
  const step = steps.find((row) => row.name === name && row.type === "do");
  return attempts
    .filter((row) => row.ordinal === step?.ordinal)
    .map(({ ended: how, error, retry_at: retryAt, ended_at: endedAt }) => ({
      ended: how,
      error,
      waited: retryAt === null || endedAt === null ? null : retryAt - endedAt,
    }));
};

/** How run `id`'s attempts at its step `name` ended. */
const endsAt = async (id: string, name: string) => {
  const attempts = await attemptsAt(id, name);
  return attempts.map(({ ended: how }) => how);
};

/**
 * Times out run `id`'s attempt that's out, as its timeout passing would,
 * once `count` attempts timed out in all, and makes its retry due: the
 * retry's activation, delivered, which settles once that attempt does.
 */
const timeOut = async (
  id: string,
  count: number
): Promise<{ delivered: Promise<void> }> => {
  const stub = runObject(rollouts, id);
  await runInDurableObject(stub, (_object, state) => {
    state.storage.sql.exec(
      "UPDATE attempts SET deadline = ?1, ended_at = ?1, ended = 'superseded' WHERE ended_at IS NULL",
      Date.now()
    );
  });
  await deliverAlarm(rollouts, id);
  await vi.waitFor(async () => {
    const { attempts } = await journalOf(rollouts, id);
    if (attempts.filter((row) => row.ended === "timed_out").length < count) {
      throw new Error(`Run ${id}'s attempt hasn't timed out yet`);
    }
  }, patiently);
  await runInDurableObject(stub, (_object, state) => {
    state.storage.sql.exec(
      "UPDATE attempts SET retry_at = ? WHERE ended = 'timed_out' AND retry_at IS NOT NULL",
      Date.now()
    );
  });
  // Delivered here: the host holds the run's own alarm back while the
  // activation the attempt that timed out is in still runs.
  return { delivered: deliverAlarm(rollouts, id) };
};

/** Once run `id` ended, its retries made due until then: how it ended. */
const hurriedToEnd = async (id: string) =>
  await vi.waitFor(
    async () => {
      await hurry(rollouts, id);
      return await ended(rollouts, id, 200);
    },
    { timeout: 20_000, interval: 50 }
  );

/** Every attempt of run `id` that failed with a 429, and how long its retry waited. */
const rateLimitedOf = async (id: string) => {
  const { attempts } = await journalOf(rollouts, id);
  return attempts
    .filter(({ error }) => error?.includes("cloudflare_429") === true)
    .map(({ retry_at: retryAt, ended_at: endedAt }) =>
      retryAt === null || endedAt === null ? null : retryAt - endedAt
    );
};

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
      }, patiently);
    },
    release: () => {
      released.resolve(true);
    },
  };
};

/** A release whose core has one migration more than `migrations` before it. */
const withMigration = {
  migrations: {
    "0000_init.sql": "CREATE TABLE a (id TEXT);",
    "0001_more.sql": "CREATE TABLE b (id TEXT);",
  },
};

/** Its connect changed too, so a release and its restore upload it. */
const connectChanged = { connect: "export default { changed: true };" };

/** Sets aside what earlier tests left: their clients offboarded, and no release on any channel. */
const setAsideEarlierTests = async (): Promise<void> => {
  await db
    .update(clients)
    .set({ status: "offboarded" })
    .where(inArray(clients.status, ["active", "provisioning"]));
  await db.delete(channels);
  await db.delete(apiBudget);
};

/** A live client on a release, and a release after it on Edge, which the rollout takes it to. */
const clientAndRelease = async (
  spec: Parameters<typeof placedRelease>[1] = {},
  before: Parameters<typeof placedRelease>[1] = {}
) => {
  const from = await placedRelease("feat(core): before", before);
  const client = await live(from);
  const to = await placedRelease("feat(core): the release", spec);
  await releaseToEdge(env, [to]);
  // What the fake got from here on is the rollout's.
  cloudflare.calls.length = 0;
  return { client, from, to };
};

describe("an organization's rollout", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(setAsideEarlierTests);

  it("takes an organization to a release, a step a phase, records it done, and keeps what it saw of the API's limit", async () => {
    const { client, to } = await clientAndRelease(withMigration);
    await using runs = followAdminRuns();
    const runId = await rollOut(client.clientId, to);
    const run = await ended(rollouts, runId);
    const { steps } = await journalOf(rollouts, runId);
    const budget = await db.select().from(apiBudget).get();

    expect({
      status: run.status,
      ...(await deployOf(client.clientId)),
      releases: await releasesOf(client.clientId),
      steps: steps.filter(({ type }) => type === "do").map(({ name }) => name),
      remaining: budget?.remaining === cloudflare.rateLimit.remaining,
      blocked: budget?.blockedUntil ?? null,
      deploys: runs.of(adminWorkflows.deploy),
    }).toStrictEqual({
      status: "complete",
      deploy: { releaseId: to, status: "done", error: null },
      runner: null,
      releases: on(to),
      steps: ["start", ...operationPhases],
      remaining: true,
      blocked: null,
      deploys: [],
    });
  });

  // Each step's own last write lands, and its activation is lost before
  // the step's result is kept: another activation takes the run over and
  // runs the step again, which finds what it did.
  const afterEffect: Record<string, string> = {
    start:
      "SELECT 1 FROM client_provisions WHERE client_id = ?1 AND release_id = ?2 AND step IS NULL",
    preflight:
      "SELECT 1 FROM client_provisions WHERE client_id = ?1 AND release_id = ?2 AND step = 'resources'",
    snapshot:
      "SELECT 1 FROM client_provisions WHERE client_id = ?1 AND release_id = ?2 AND step = 'snapshot'",
    migrate:
      "SELECT 1 FROM client_provisions WHERE client_id = ?1 AND release_id = ?2 AND step = 'migrations'",
    install:
      "SELECT 1 FROM client_provisions WHERE client_id = ?1 AND release_id = ?2 AND step = 'core'",
    probe:
      "SELECT 1 FROM client_provisions WHERE client_id = ?1 AND release_id = ?2 AND step = 'probe'",
    route:
      "SELECT 1 FROM client_provisions WHERE client_id = ?1 AND release_id = ?2 AND step = 'route'",
    record:
      "SELECT 1 FROM client_provisions WHERE client_id = ?1 AND release_id = ?2 AND status = 'done'",
  };

  it.each(Object.keys(afterEffect))(
    "runs its %s step again once its activation is lost after the step's effect, doing nothing twice",
    async (name) => {
      const { client, to } = await clientAndRelease(withMigration);
      let held: LostWrite | undefined;
      const query = afterEffect[name] ?? "";
      await using runs = followAdminRuns(async (stub, workflow) => {
        if (workflow !== rollouts) {
          return;
        }
        held = await holdBatchOf(
          stub,
          async (database) =>
            (await database
              .prepare(query)
              .bind(client.clientId, to)
              .first()) !== null
        );
      });
      try {
        await rollOut(client.clientId, to);
        const [runId] = runs.of(rollouts);
        if (runId === undefined || held === undefined) {
          throw new Error("The rollout's run wasn't started");
        }
        await held.committed;
        await deliverAlarm(rollouts, runId);
        const run = await ended(rollouts, runId);

        expect({
          status: run.status,
          ...(await deployOf(client.clientId)),
          releases: await releasesOf(client.clientId),
          uploads: await uploadsOf(client),
          migrated: cloudflare.calls.filter(
            ({ path, body }) =>
              path.endsWith("/query") &&
              JSON.stringify(body).includes("INSERT INTO d1_migrations") &&
              JSON.stringify(body).includes("0001_more")
          ).length,
          bookmarks: cloudflare.calls.filter(({ path }) =>
            path.endsWith("/time_travel/bookmark")
          ).length,
          restored: await auditedOf(client.clientId, "release.rollback"),
          deploys: runs.of(adminWorkflows.deploy),
        }).toStrictEqual({
          status: "complete",
          deploy: { releaseId: to, status: "done", error: null },
          runner: null,
          releases: on(to),
          // A step run again after its upload went out reads it back, and
          // sends no more; connect, the same as the release before's, is
          // skipped.
          uploads: { connect: 0, core: 1 },
          migrated: 1,
          bookmarks: 1,
          restored: [],
          deploys: [],
        });
      } finally {
        held?.lose();
      }
    }
  );

  it("finishes a step the admin's redeploys cut off more often than its retries, as a cut-off spends none", async () => {
    const { client, to } = await clientAndRelease();
    const { core } = await scriptsOf(client.clientId);
    // Each try of the install is held as it reads core's script: there the
    // admin's redeploy cuts it off. One more than its retries.
    const coreRead = (call: ApiCall) =>
      call.method === "GET" && call.path.endsWith(`/scripts/${core}`);
    const cuts = Array.from({ length: 4 }, () => heldAfter(coreRead));
    const takeovers: Promise<void>[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await using runs = followAdminRuns();
    try {
      const runId = await rollOut(client.clientId, to);
      for (const cut of cuts) {
        // oxlint-disable-next-line no-await-in-loop -- one try at a time
        await cut.read();
        takeovers.push(deliverAlarm(rollouts, runId));
      }
      const run = await ended(rollouts, runId);
      const install = await attemptsAt(runId, "install");

      expect({
        status: run.status,
        ...(await deployOf(client.clientId)),
        releases: await releasesOf(client.clientId),
        install: install.map(({ ended: how }) => how),
        deploys: runs.of(adminWorkflows.deploy),
      }).toStrictEqual({
        status: "complete",
        deploy: { releaseId: to, status: "done", error: null },
        runner: null,
        releases: on(to),
        install: [
          "superseded",
          "superseded",
          "superseded",
          "superseded",
          "succeeded",
        ],
        deploys: [],
      });
    } finally {
      for (const cut of cuts) {
        cut.release();
      }
      await Promise.allSettled(takeovers);
      errors.mockRestore();
    }
  });

  it("restores nothing when the router's map takes the hostname and every route step loses the answer: reconciled, it's done", async () => {
    const { client, to } = await clientAndRelease();
    let lost = 0;
    await using runs = followAdminRuns(async (stub, workflow) => {
      if (workflow !== rollouts) {
        return;
      }
      await wrapBindingOf(stub, "ROUTER_HOSTS", (hosts) =>
        // SAFETY: an object whose prototype is `hosts` is a namespace: it
        // has every member, and the ones the route calls are set below.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        Object.assign(Object.create(hosts) as KVNamespace, {
          get: hosts.get.bind(hosts),
          put: async (...args: Parameters<KVNamespace["put"]>) => {
            await hosts.put(...args);
            // Every try of the route step: written, its answer lost.
            if (lost < 4) {
              lost += 1;
              throw new TypeError("Network connection lost.");
            }
          },
        })
      );
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await rollOut(client.clientId, to);
      const [runId] = runs.of(rollouts);
      if (runId === undefined) {
        throw new Error("The rollout's run wasn't started");
      }
      const run = await ended(rollouts, runId);

      expect({
        status: run.status,
        lost,
        route: await endsAt(runId, "route"),
        ...(await deployOf(client.clientId)),
        releases: await releasesOf(client.clientId),
        restored: await auditedOf(client.clientId, "release.rollback"),
        alert: await alertOf(client.clientId),
        deploys: runs.of(adminWorkflows.deploy),
      }).toStrictEqual({
        // The run's steps failed, so it did; its deploy is done.
        status: "errored",
        lost: 4,
        route: ["failed", "failed", "failed", "failed"],
        deploy: { releaseId: to, status: "done", error: null },
        runner: null,
        releases: on(to),
        restored: [],
        alert: null,
        deploys: [],
      });
    } finally {
      errors.mockRestore();
    }
  });

  it("restores the release before when core's upload is refused once connect went live", async () => {
    const { client, from, to } = await clientAndRelease(connectChanged);
    const { core } = await scriptsOf(client.clientId);
    cloudflare.failNext(uploading(core), 400);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await using runs = followAdminRuns();
    try {
      const runId = await rollOut(client.clientId, to);
      const run = await ended(rollouts, runId);

      expect({
        status: run.status,
        ...(await deployOf(client.clientId)),
        releases: await releasesOf(client.clientId),
        // Each the release's, then the restore's: core's whole, as what
        // it ran was forgotten before the release's upload was sent.
        uploads: await uploadsOf(client),
        failed: await auditedOf(client.clientId, "deploy.fail", [
          "error",
          "restored",
        ]),
        // Restored: the rollout counts it, and nobody is told of it alone.
        alert: await alertOf(client.clientId),
        deploys: runs.of(adminWorkflows.deploy),
      }).toStrictEqual({
        status: "errored",
        deploy: {
          releaseId: to,
          status: "failed",
          error: "cloudflare_400_10000",
        },
        runner: null,
        releases: on(from),
        uploads: { connect: 2, core: 2 },
        failed: [{ error: "cloudflare_400_10000", restored: true }],
        alert: null,
        deploys: [],
      });
    } finally {
      errors.mockRestore();
    }
  });

  it("restores onto the release before a database its migration left ahead, at a name that release lists for another Worker", async () => {
    // Core's new migration shares its name with connect's own.
    const { client, from, to } = await clientAndRelease({
      migrations: {
        "0000_init.sql": "CREATE TABLE a (id TEXT);",
        "0000_connect.sql": "CREATE TABLE d (id TEXT);",
      },
    });
    const { core } = await scriptsOf(client.clientId);
    cloudflare.failNext(uploading(core), 400);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await using _runs = followAdminRuns();
    try {
      const runId = await rollOut(client.clientId, to);
      await ended(rollouts, runId);

      expect({
        ...(await deployOf(client.clientId)),
        releases: await releasesOf(client.clientId),
        failed: await auditedOf(client.clientId, "deploy.fail", [
          "error",
          "restored",
        ]),
      }).toStrictEqual({
        deploy: {
          releaseId: to,
          status: "failed",
          error: "cloudflare_400_10000",
        },
        runner: null,
        releases: on(from),
        failed: [{ error: "cloudflare_400_10000", restored: true }],
      });
    } finally {
      errors.mockRestore();
    }
  });

  it("restores at once when the probe gets a definite wrong answer, every Worker uploaded whole again", async () => {
    const { client, from, to } = await clientAndRelease(connectChanged);
    const { connect } = await scriptsOf(client.clientId);
    // The release's core answers as another release; the restore's
    // connect upload finds it answering as it should again.
    client.core.coreProbe = { asRelease: "26.01.1" };
    // oxlint-disable require-await -- the fake waits on these; nothing to wait for
    cloudflare.beforeAnswering(uploading(connect), async () => {
      cloudflare.beforeAnswering(uploading(connect), async () => {
        delete client.core.coreProbe;
      });
    });
    // oxlint-enable require-await
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await using runs = followAdminRuns();
    try {
      const runId = await rollOut(client.clientId, to);
      const run = await ended(rollouts, runId);

      expect({
        status: run.status,
        probe: await endsAt(runId, "probe"),
        ...(await deployOf(client.clientId)),
        releases: await releasesOf(client.clientId),
        uploads: await uploadsOf(client),
        restoredTo: await auditedOf(client.clientId, "release.rollback", [
          "cause",
        ]),
        deploys: runs.of(adminWorkflows.deploy),
      }).toStrictEqual({
        status: "errored",
        // Not tried again: it answered, wrongly.
        probe: ["failed"],
        deploy: {
          releaseId: to,
          status: "failed",
          error: "probe_release_mismatch",
        },
        runner: null,
        releases: on(from),
        uploads: { connect: 2, core: 2 },
        restoredTo: [{ cause: "probe_release_mismatch" }],
        deploys: [],
      });
    } finally {
      errors.mockRestore();
    }
  });

  it("tries a probe again that got no answer, and calls the release done once it passes", async () => {
    const { client, to } = await clientAndRelease();
    // Core doesn't answer the signed probe until the step's first try
    // failed; then it does.
    client.core.coreProbe = "absent";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const runId = await rollOut(client.clientId, to);
      await vi.waitFor(
        async () => {
          const ends = await endsAt(runId, "probe");
          if (ends[0] !== "failed") {
            throw new Error("The probe step's first try hasn't failed yet");
          }
        },
        { timeout: 20_000, interval: 50 }
      );
      delete client.core.coreProbe;
      await using runs = followAdminRuns();
      const run = await hurriedToEnd(runId);

      expect({
        status: run.status,
        probe: await endsAt(runId, "probe"),
        ...(await deployOf(client.clientId)),
        restored: await auditedOf(client.clientId, "release.rollback"),
        deploys: runs.of(adminWorkflows.deploy),
      }).toStrictEqual({
        status: "complete",
        probe: ["failed", "succeeded"],
        deploy: { releaseId: to, status: "done", error: null },
        runner: null,
        restored: [],
        deploys: [],
      });
    } finally {
      errors.mockRestore();
    }
  });

  it("goes on with a restore an earlier try started, never rolling it back again onto the release that failed", async () => {
    const { client, from, to } = await clientAndRelease(connectChanged);
    const { connect } = await scriptsOf(client.clientId);
    // The release's core answers as another release. The restore's first
    // try puts the release before back, and its core doesn't answer the
    // probe; the next try's does.
    client.core.coreProbe = { asRelease: "26.01.1" };
    // oxlint-disable require-await -- the fake waits on these; nothing to wait for
    cloudflare.beforeAnswering(uploading(connect), async () => {
      cloudflare.beforeAnswering(uploading(connect), async () => {
        client.core.coreProbe = "absent";
      });
    });
    // oxlint-enable require-await
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const runId = await rollOut(client.clientId, to);
      await vi.waitFor(async () => {
        const { attempts, steps } = await journalOf(rollouts, runId);
        const restore = steps.find(({ type }) => type === "rollback");
        const failed = attempts.some(
          ({ ordinal, ended: how }) =>
            ordinal === restore?.ordinal && how === "failed"
        );
        if (!failed) {
          throw new Error("The restore's first try hasn't failed yet");
        }
      }, patiently);
      delete client.core.coreProbe;
      await using runs = followAdminRuns();
      await hurriedToEnd(runId);

      expect({
        ...(await deployOf(client.clientId)),
        releases: await releasesOf(client.clientId),
        rollbacks: await auditedOf(client.clientId, "release.rollback", [
          "from",
        ]),
        failed: await auditedOf(client.clientId, "deploy.fail", [
          "error",
          "restored",
        ]),
        deploys: runs.of(adminWorkflows.deploy),
      }).toStrictEqual({
        deploy: {
          releaseId: to,
          status: "failed",
          error: "probe_release_mismatch",
        },
        runner: null,
        releases: on(from),
        // Started once, from the release that failed.
        rollbacks: [{ from: to }],
        failed: [{ error: "probe_release_mismatch", restored: true }],
        deploys: [],
      });
    } finally {
      errors.mockRestore();
    }
  });

  it("records a restore that can't read what it deploys with as failed, and tells staff at once", async () => {
    const { client, to } = await clientAndRelease();
    const { core } = await scriptsOf(client.clientId);
    // Once core went live, the deployer's token is gone from Secrets Store.
    cloudflare.afterAnswering(uploading(core), async () => {
      await emptyStoreSecret(env.DEPLOYER_API_TOKEN, "DEPLOYER_API_TOKEN");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await using runs = followAdminRuns();
    try {
      const runId = await rollOut(client.clientId, to);
      await ended(rollouts, runId);

      expect({
        ...(await deployOf(client.clientId)),
        failed: await auditedOf(client.clientId, "deploy.fail", [
          "error",
          "cause",
        ]),
        alert: await alertOf(client.clientId),
        deploys: runs.of(adminWorkflows.deploy),
      }).toStrictEqual({
        deploy: { releaseId: to, status: "failed", error: "restore_failed" },
        runner: null,
        failed: [{ error: "restore_failed", cause: "store_secret_missing" }],
        alert: { failing: true, kind: "restore_failed" },
        deploys: [],
      });
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps a release whose restore is refused, as the release before can't open the chats it stores, and tells staff at once", async () => {
    const { client, to } = await clientAndRelease(onPi("1.6.1"), onPi("1.4.2"));
    client.core.coreProbe = { asClient: "someone-else" };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await using runs = followAdminRuns();
    try {
      const runId = await rollOut(client.clientId, to);
      await ended(rollouts, runId);

      expect({
        ...(await deployOf(client.clientId)),
        releases: await releasesOf(client.clientId),
        failed: await auditedOf(client.clientId, "deploy.fail", [
          "error",
          "cause",
        ]),
        alert: await alertOf(client.clientId),
        deploys: runs.of(adminWorkflows.deploy),
      }).toStrictEqual({
        deploy: { releaseId: to, status: "failed", error: "restore_refused" },
        runner: null,
        releases: on(to),
        failed: [
          { error: "restore_refused", cause: "probe_identity_mismatch" },
        ],
        alert: { failing: true, kind: "restore_refused" },
        deploys: [],
      });
    } finally {
      errors.mockRestore();
    }
  });

  it("records a restore whose own probe fails too, and tells staff at once", async () => {
    const { client, to } = await clientAndRelease(connectChanged);
    // Whatever runs, its core answers as another client.
    client.core.coreProbe = { asClient: "someone-else" };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await using runs = followAdminRuns();
    try {
      const runId = await rollOut(client.clientId, to);
      await ended(rollouts, runId);

      expect({
        ...(await deployOf(client.clientId)),
        failed: await auditedOf(client.clientId, "deploy.fail", [
          "error",
          "cause",
        ]),
        alert: await alertOf(client.clientId),
        deploys: runs.of(adminWorkflows.deploy),
      }).toStrictEqual({
        deploy: { releaseId: to, status: "failed", error: "restore_failed" },
        runner: null,
        failed: [{ error: "restore_failed", cause: "probe_identity_mismatch" }],
        alert: { failing: true, kind: "restore_failed" },
        deploys: [],
      });
    } finally {
      errors.mockRestore();
    }
  });

  it("ends a probe step that never got to its own work in a probe all the same, and restores what fails it", async () => {
    const { client, from, to } = await clientAndRelease(connectChanged);
    const { connect, core } = await scriptsOf(client.clientId);
    // From core's upload on, every read of the client key hangs: each try
    // of the probe step stops there, before probing, and times out.
    const holding = { on: false, released: Promise.withResolvers<unknown>() };
    let reads = 0;
    await using runs = followAdminRuns(async (stub, workflow) => {
      if (workflow !== rollouts) {
        return;
      }
      await wrapBindingOf(stub, "CLIENT_KEY", (secret) => ({
        get: async () => {
          if (holding.on) {
            reads += 1;
            await holding.released.promise;
          }
          return await secret.get();
        },
      }));
    });
    // oxlint-disable require-await -- the fake waits on these; nothing to wait for
    cloudflare.afterAnswering(uploading(core), async () => {
      holding.on = true;
    });
    // oxlint-enable require-await
    const deliveries: Promise<void>[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await rollOut(client.clientId, to);
      const [runId] = runs.of(rollouts);
      if (runId === undefined) {
        throw new Error("The rollout's run wasn't started");
      }
      const readsReached = async (count: number) => {
        await vi.waitFor(() => {
          if (reads < count) {
            throw new Error(`The client key was read ${reads} times`);
          }
        }, patiently);
      };
      // Each of its four tries times out where it's held.
      for (let tries = 1; tries <= 4; tries += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one try at a time
        await readsReached(tries);
        // oxlint-disable-next-line no-await-in-loop -- one try at a time
        const { delivered } = await timeOut(runId, tries);
        deliveries.push(delivered);
      }
      // The restore reads the key too; its probe of the release finds core
      // answering as another release, and the release before goes back.
      await readsReached(5);
      client.core.coreProbe = { asRelease: "26.01.1" };
      // oxlint-disable require-await -- the fake waits on these; nothing to wait for
      cloudflare.beforeAnswering(uploading(connect), async () => {
        delete client.core.coreProbe;
      });
      // oxlint-enable require-await
      holding.released.resolve(true);
      const run = await ended(rollouts, runId);

      expect({
        status: run.status,
        probe: await endsAt(runId, "probe"),
        ...(await deployOf(client.clientId)),
        releases: await releasesOf(client.clientId),
        failed: await auditedOf(client.clientId, "deploy.fail", [
          "error",
          "restored",
        ]),
        deploys: runs.of(adminWorkflows.deploy),
      }).toStrictEqual({
        status: "errored",
        probe: ["timed_out", "timed_out", "timed_out", "timed_out"],
        deploy: {
          releaseId: to,
          status: "failed",
          error: "attempt_lost: probe",
        },
        runner: null,
        releases: on(from),
        failed: [{ error: "attempt_lost: probe", restored: true }],
        deploys: [],
      });
    } finally {
      holding.released.resolve(true);
      await Promise.allSettled(deliveries);
      errors.mockRestore();
    }
  });

  it("restores the release before when staff terminate the run with rollback, never reconciling onto the one they stopped", async () => {
    const { client, from, to } = await clientAndRelease(connectChanged);
    let held: LostWrite | undefined;
    // Held at the probe step's record: the release is live and probed.
    await using runs = followAdminRuns(async (stub, workflow) => {
      if (workflow !== rollouts) {
        return;
      }
      held = await holdBatchOf(
        stub,
        async (database) =>
          (await database
            .prepare(afterEffect.probe ?? "")
            .bind(client.clientId, to)
            .first()) !== null
      );
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await rollOut(client.clientId, to);
      const [runId] = runs.of(rollouts);
      if (runId === undefined || held === undefined) {
        throw new Error("The rollout's run wasn't started");
      }
      await held.committed;
      const instance = await adminWorkflow(env, rollouts).get(runId);
      await instance.terminate({ rollback: true });
      // The attempt held answers late, ignored: its activation ends.
      held.lose();
      await reached(rollouts, runId, "terminated");

      expect({
        ...(await deployOf(client.clientId)),
        releases: await releasesOf(client.clientId),
        failed: await auditedOf(client.clientId, "deploy.fail", [
          "error",
          "restored",
        ]),
        deploys: runs.of(adminWorkflows.deploy),
      }).toStrictEqual({
        deploy: { releaseId: to, status: "failed", error: "run_terminated" },
        runner: null,
        releases: on(from),
        failed: [{ error: "run_terminated", restored: true }],
        deploys: [],
      });
    } finally {
      held?.lose();
      errors.mockRestore();
    }
  });

  it("restores the release before when staff terminate the run with rollback just after it finished, taking the client back", async () => {
    const { client, from, to } = await clientAndRelease(connectChanged);
    let held: LostWrite | undefined;
    // Held at the record step's write: the operation done, the client given back.
    await using runs = followAdminRuns(async (stub, workflow) => {
      if (workflow !== rollouts) {
        return;
      }
      held = await holdBatchOf(
        stub,
        async (database) =>
          (await database
            .prepare(afterEffect.record ?? "")
            .bind(client.clientId, to)
            .first()) !== null
      );
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await rollOut(client.clientId, to);
      const [runId] = runs.of(rollouts);
      if (runId === undefined || held === undefined) {
        throw new Error("The rollout's run wasn't started");
      }
      await held.committed;
      const instance = await adminWorkflow(env, rollouts).get(runId);
      await instance.terminate({ rollback: true });
      // The attempt held answers late, ignored: its activation ends.
      held.lose();
      await reached(rollouts, runId, "terminated");

      expect({
        ...(await deployOf(client.clientId)),
        releases: await releasesOf(client.clientId),
        failed: await auditedOf(client.clientId, "deploy.fail", [
          "error",
          "restored",
        ]),
        deploys: runs.of(adminWorkflows.deploy),
      }).toStrictEqual({
        deploy: { releaseId: to, status: "failed", error: "run_terminated" },
        runner: null,
        releases: on(from),
        failed: [{ error: "run_terminated", restored: true }],
        deploys: [],
      });
    } finally {
      held?.lose();
      errors.mockRestore();
    }
  });

  it("keeps an attempt that timed out and goes on beside the steps after it from acting", async () => {
    const { client, to } = await clientAndRelease();
    // The first try of the preflight is held once it read the client's
    // databases; it times out there, its retry and the steps after it go
    // on, and only then does it.
    const first = heldAfter(
      (call) => call.method === "GET" && call.path.endsWith("/d1/database")
    );
    const deliveries: Promise<void>[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const runId = await rollOut(client.clientId, to);
      await first.read();
      const { delivered } = await timeOut(runId, 1);
      deliveries.push(delivered);
      await vi.waitFor(async () => {
        const claim = await db
          .select({ step: clientRuns.step })
          .from(clientRuns)
          .where(eq(clientRuns.clientId, client.clientId))
          .get();
        // The install's, or later: two steps on.
        if ((claim?.step ?? 99) < 5) {
          throw new Error("The steps after the preflight haven't taken it");
        }
      }, patiently);
      const resources = await auditedOf(client.clientId, "provision.resources");
      first.release();
      await vi.waitFor(() => {
        const stopped = errors.mock.calls.some((logged) =>
          JSON.stringify(logged).includes("runner_replaced")
        );
        if (!stopped) {
          throw new Error("The attempt that timed out hasn't stopped yet");
        }
      }, patiently);
      await using runs = followAdminRuns();
      const run = await ended(rollouts, runId);

      expect({
        status: run.status,
        ...(await deployOf(client.clientId)),
        releases: await releasesOf(client.clientId),
        // Only the retry recorded the resources.
        resources: await auditedOf(client.clientId, "provision.resources"),
        deploys: runs.of(adminWorkflows.deploy),
      }).toStrictEqual({
        status: "complete",
        deploy: { releaseId: to, status: "done", error: null },
        runner: null,
        releases: on(to),
        resources,
        deploys: [],
      });
    } finally {
      first.release();
      await Promise.allSettled(deliveries);
      errors.mockRestore();
    }
  });

  it("lets an old admin's deploy run and the pass's rollouts claim organizations one at a time, and settles both", async () => {
    const before = await placedRelease("feat(core): before");
    const old = await live(before);
    const fresh = await live(before);
    const release = await placedRelease("feat(core): both runs");
    const { core } = await scriptsOf(old.clientId);
    const held = heldAfter(
      (call) => call.method === "GET" && call.path.endsWith(`/scripts/${core}`)
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await using runs = followAdminRuns();
    try {
      // An older admin, mid-deploy of this one, starts a deploy run for one
      // organization, as its reconciler did; the release is on Edge.
      const oldRun = `deploy-${crypto.randomUUID().slice(0, 12)}`;
      const claimed = await claimRun(
        db,
        "system",
        old.clientId,
        null,
        { action: "deploy.start", clientId: old.clientId, target: release },
        { kind: "deploy", runId: oldRun }
      );
      await db.insert(clientDeploys).values({
        clientId: old.clientId,
        releaseId: release,
        runId: oldRun,
        status: "deploying",
        startedAt: new Date(),
      });
      await adminWorkflow(env, adminWorkflows.deploy).create({
        id: oldRun,
        params: { clientId: old.clientId, releaseId: release },
      });
      await held.read();
      // Claimed long enough ago that the pass would settle a run it can't
      // find as gone.
      await db
        .update(clientDeploys)
        .set({ startedAt: new Date(Date.now() - 10 * 60 * 1000) })
        .where(eq(clientDeploys.clientId, old.clientId));
      await releaseToEdge(env, [release]);
      await rolloutPass(env);
      const { deploy, runner } = await deployOf(old.clientId);
      const whileOut = {
        claimed: claimed === oldRun,
        rollouts: runs.of(rollouts).length,
        oldRunner: runner?.runId,
        oldDeploy: deploy?.status,
      };
      held.release();
      await ended(adminWorkflows.deploy, oldRun);
      await Promise.all(
        runs.of(rollouts).map(async (id) => await hurriedToEnd(id))
      );
      // The pass settles nothing more: each recorded its own end.
      await rolloutPass(env);

      expect({
        whileOut,
        old: await deployOf(old.clientId),
        fresh: await deployOf(fresh.clientId),
        releases: {
          old: await releasesOf(old.clientId),
          fresh: await releasesOf(fresh.clientId),
        },
        rollouts: runs.of(rollouts).length,
      }).toStrictEqual({
        // The pass started a rollout only for the organization the old
        // run didn't have, and found the old run out.
        whileOut: {
          claimed: true,
          rollouts: 1,
          oldRunner: oldRun,
          oldDeploy: "deploying",
        },
        old: {
          deploy: { releaseId: release, status: "done", error: null },
          runner: null,
        },
        fresh: {
          deploy: { releaseId: release, status: "done", error: null },
          runner: null,
        },
        releases: { old: on(release), fresh: on(release) },
        rollouts: 1,
      });
    } finally {
      held.release();
      errors.mockRestore();
    }
  });
});

describe("a 429 storm across organizations' rollouts", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(setAsideEarlierTests);

  it("parks each step it refuses past the block, sends nothing again at once, and tells staff of the block once", async () => {
    const release = await placedRelease("feat(core): before");
    const clientsOut = await Promise.all([
      live(release),
      live(release),
      live(release),
    ]);
    const to = await placedRelease("feat(core): through the storm");
    await releaseToEdge(env, [to]);
    // The first calls of every run are refused: the token is blocked.
    const refused = 6;
    for (let n = 1; n <= refused; n += 1) {
      cloudflare.failCall(n, { retryAfter: "300" });
    }
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const runIds = await Promise.all(
        clientsOut.map(async ({ clientId }) => await rollOut(clientId, to))
      );
      // Each run's step that met the block waits past it; then each is
      // hurried along, and the next refused ones wait again.
      const parked = await Promise.all(
        runIds.map(async (id) => {
          const refusedOf = async () => await rateLimitedOf(id);
          return await vi.waitFor(async () => {
            const waits = await refusedOf();
            if (waits.length === 0) {
              throw new Error(`Run ${id} hasn't met the block yet`);
            }
            return waits;
          }, patiently);
        })
      );
      await using runs = followAdminRuns();
      await Promise.all(runIds.map(async (id) => await hurriedToEnd(id)));
      const blocked = await db
        .select({ key: alerts.key })
        .from(alerts)
        .where(like(alerts.key, "blocked:%"));
      const audited = await db.$count(
        auditEvents,
        eq(auditEvents.action, "rollout.blocked")
      );
      const deploys = await Promise.all(
        clientsOut.map(async ({ clientId }) => {
          const { deploy } = await deployOf(clientId);
          return deploy;
        })
      );

      expect({
        // Past Cloudflare's five-minute block, from when each failed.
        parked: parked.map((waits) => waits[0]),
        // Each refused call failed at once: none sent again in place.
        refused: cloudflare.calls.length >= refused,
        alerts: blocked.length,
        audited,
        deploys,
        oldRuns: runs.of(adminWorkflows.deploy),
      }).toStrictEqual({
        parked: runIds.map(() => 300_000),
        refused: true,
        alerts: 1,
        audited: 1,
        deploys: clientsOut.map(() => ({
          releaseId: to,
          status: "done",
          error: null,
        })),
        oldRuns: [],
      });
    } finally {
      errors.mockRestore();
    }
  });
});

describe("the step fence", () => {
  it("lets a later step of the run take the client from any attempt of an earlier one, and nothing take it back", async () => {
    const clientId = `fence-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date();
    await db.insert(clients).values({
      id: clientId,
      name: "Fence",
      channel: "edge",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(clientRuns).values({
      clientId,
      runId: "rollout-fence",
      kind: "rollout",
      claimedAt: now,
    });
    const held = (step: number, attempt: number) => ({
      clientId,
      runId: "rollout-fence",
      attempt,
      attemptKey: `key-${step}`,
      step,
    });

    expect({
      first: await takeAttempt(db, held(2, 1)),
      retry: await takeAttempt(db, held(2, 2)),
      olderAttempt: await takeAttempt(db, held(2, 1)),
      laterStep: await takeAttempt(db, held(3, 1)),
      earlierStep: await takeAttempt(db, held(2, 3)),
      otherRun: await takeAttempt(db, { ...held(4, 1), runId: "rollout-x" }),
      unstepped: await takeAttempt(db, {
        clientId,
        runId: "rollout-fence",
        attempt: 9,
        attemptKey: "key-3",
      }),
    }).toStrictEqual({
      first: true,
      retry: true,
      olderAttempt: false,
      laterStep: true,
      earlierStep: false,
      otherRun: false,
      unstepped: false,
    });
  });
});

describe("the steps an install on its own premises shares", () => {
  it("runs the release's steps in their order, and restores from the one the rules say", () => {
    expect({
      first: operationPhases.slice(0, releaseSteps.length),
      restoresFrom,
    }).toStrictEqual({ first: [...releaseSteps], restoresFrom: "install" });
  });
});

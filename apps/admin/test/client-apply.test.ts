import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { applySettings } from "../src/clients/apply.ts";
import { setSignIn } from "../src/clients/settings.ts";
import { cloudflareApi } from "../src/cloudflare/api.ts";
import {
  clientProvisions,
  clientRuns,
  clients,
  clientWorkers,
} from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import {
  runClientProvision,
  startClientRelease,
} from "../src/hosting/operation.ts";
import { driftOf } from "../src/rollout/drift.ts";
import { isConfigPending } from "../src/rollout/targets.ts";
import { adminWorkflows } from "../src/workflow-runs.ts";
import type { ApiCall } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, staff } from "./hosting.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import type { PlacedClient } from "./placed.ts";
import {
  deliverAlarm,
  holdBatchOf,
  ended as runEnded,
  startsOf,
  timeOutAttempt,
} from "./runs.ts";
import type { LostWrite } from "./runs.ts";
import { emptyStoreSecret, useStoreSecrets } from "./secrets-store.ts";

// Applying a client's settings: its release run again, as a run of its
// own (src/clients/apply.ts), and what a client's changes count as once
// its core runs them. How it can fail, each tried below:
// - a run that stops before it could run, leaving the client held;
// - an attempt that timed out, or lost its step's result, acting twice;
// - a change made while a run goes on counted as live;
// - drift read as in sync once the client was changed outside the admin.

const token = "test-deployer-token-apply-5d1e7a";
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

/** A live client on `releaseId`. */
const live = async (releaseId: string): Promise<PlacedClient> =>
  await livePlacedClient(cloudflare, releaseId);

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

/** Pins client `clientId` to `releaseId` (or none) as its record alone: no deploy of it. */
const pinTo = async (clientId: string, releaseId: string | null) => {
  await db
    .update(clients)
    .set({ pinnedReleaseId: releaseId })
    .where(eq(clients.id, clientId));
};

/** Both Workers on `releaseId`. */
const on = (releaseId: string) => ({ connect: releaseId, core: releaseId });

/** The runner client `clientId` has, if any. */
const runnerOf = async (clientId: string) => {
  const [row] = await db
    .select({ runId: clientRuns.runId, kind: clientRuns.kind })
    .from(clientRuns)
    .where(eq(clientRuns.clientId, clientId));
  return row ?? null;
};

/** How many uploads each of `client`'s scripts has had. */
const uploadsOf = (client: PlacedClient): number =>
  client.account.scriptUploads.length;

describe("applying a client's settings", () => {
  useStoreSecrets({ deployer: token });

  it("applies a client's settings by running its release again", async () => {
    const release = await placedRelease("feat(core): runs");
    const client = await live(release);
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

  it("records on its operation why applying stopped before it could run, a secret missing from Secrets Store by name, and gives the client back", async () => {
    const release = await placedRelease("feat(core): runs");
    const client = await live(release);
    await emptyStoreSecret(env.ROUTER_KEY, "ROUTER_KEY");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const runId = await applySettings(env, staff, client.clientId);
    const ended = await runEnded(adminWorkflows.applyClient, runId);
    errors.mockRestore();
    expect({
      status: ended.status,
      operation: await db
        .select({
          status: clientProvisions.status,
          error: clientProvisions.error,
        })
        .from(clientProvisions)
        .where(eq(clientProvisions.clientId, client.clientId))
        .get(),
      runner: await runnerOf(client.clientId),
    }).toStrictEqual({
      status: "errored",
      operation: {
        status: "failed",
        error: "store_secret_missing: ROUTER_KEY",
      },
      runner: null,
    });
  });

  it("applies a client's settings once when its operation's attempt times out and its retry runs, the attempt that timed out acting no more", async () => {
    const release = await placedRelease("feat(core): applied on a retry");
    const client = await live(release);
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
    const client = await live(release);
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

  it("reads a client's drift live: in sync once its operation is done, off its pin, and drifted once changed outside the admin", async () => {
    const before = await placedRelease("feat(core): before");
    const client = await live(before);
    const api = cloudflareApi({ token, retryDelayMs: 0 });
    const synced = await driftOf(api, db, client.clientId);
    const other = await placedRelease("feat(core): pinned to");
    await pinTo(client.clientId, other);
    const pinned = await driftOf(api, db, client.clientId);
    await pinTo(client.clientId, null);
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
    await api.call(
      {
        method: "POST",
        path: `/accounts/${client.account.id}/workers/scripts/${scriptName}/deployments`,
        query: { force: "true" },
        json: {
          strategy: "percentage",
          versions: [{ version_id: first?.id ?? "", percentage: 100 }],
        },
      },
      z.unknown()
    );
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

/** Claims client `clientId` for a new apply run, as an apply holds it. */
const heldForApply = async (clientId: string) => {
  const runId = `apply-${crypto.randomUUID().slice(0, 8)}`;
  await db.delete(clientRuns).where(eq(clientRuns.clientId, clientId));
  await db.insert(clientRuns).values({
    clientId,
    runId,
    kind: "apply",
    claimedAt: new Date(),
  });
  return { clientId, runId };
};

describe("a client's changes, counted", () => {
  useStoreSecrets({ deployer: token });

  it("counts settings live once core runs them, however often their run was resumed, and tells core what changed", async () => {
    const before = await placedRelease("feat(core): before");
    const internal = await live(before);
    const core = await coreScriptOf(internal.clientId);
    const held = await heldForApply(internal.clientId);
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
    const internal = await live(before);
    const held = await heldForApply(internal.clientId);
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
});

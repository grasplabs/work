import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { clientQuotaPolicy } from "../src/clients/quota-policy.ts";
import { act, consoleDatabase } from "../src/db/act.ts";
import { clients, settings } from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { importReleases } from "../src/releases/import.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// A client's quota policy on its page: the generation the console sets
// beside the one its core applies, read from its core through the
// router's route, and drift when core refused the console's.

const token = "test-deployer-token-quota-7d2e41";
const tenantToken = "test-tenant-admin-token-quota-3b9f06";
const cloudflare = mockCloudflareApi(token, tenantToken);
mockAccess();

const db = consoleDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** A release, published and imported. */
const importedRelease = async (notes: string): Promise<string> => {
  const release = await publishRelease({ notes });
  await importReleases(env.RELEASES, db);
  return release.id;
};

/** A client recorded as active, on a new account in the fake. */
const recordClient = async () => {
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const account = cloudflare.addAccount(`Acme ${clientId}`);
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name: `Acme ${clientId}`,
        accountId: account.id,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  return { clientId, account };
};

/** Sets client `clientId`'s `QUOTA_LIMITS` to `generation`, lowering its steps. */
const setQuota = async (
  clientId: string,
  generation: number,
  workflowSteps: number
): Promise<void> => {
  const value = JSON.stringify({ generation, limits: { workflowSteps } });
  await db
    .insert(settings)
    .values({
      clientId,
      key: "QUOTA_LIMITS",
      value,
      updatedBy: staff.email,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [settings.clientId, settings.key],
      set: { value, updatedAt: new Date() },
    });
};

/** Deploys `releaseId` to client `clientId`, settings and all. */
const deploy = async (clientId: string, releaseId: string): Promise<void> => {
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, staff, clientId, releaseId)
  );
};

describe("a client's quota policy", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });

  it("is in sync while core applies the generation the console deployed, and drifted once core refuses a lower one, whatever else waits", async () => {
    const release = await importedRelease("feat(core): quota policy report");
    const { clientId } = await recordClient();
    await setQuota(clientId, 3, 100);
    await deploy(clientId, release);
    const inSync = await clientQuotaPolicy(env, clientId);
    // A lower generation deployed: core keeps the one it recorded.
    await setQuota(clientId, 2, 50);
    await deploy(clientId, release);
    const drifted = await clientQuotaPolicy(env, clientId);
    // Another setting's change waiting for its deploy hides no drift.
    await db
      .update(clients)
      .set({ configChangedAt: new Date() })
      .where(eq(clients.id, clientId));
    const stillDrifted = await clientQuotaPolicy(env, clientId);

    expect({
      inSync,
      drifted,
      stillDrifted: stillDrifted?.state,
    }).toMatchObject({
      inSync: {
        set: { generation: 3, lowered: { workflowSteps: 100 } },
        inForce: { generation: 3, lowered: { workflowSteps: 100 } },
        state: "in_sync",
      },
      drifted: {
        set: { generation: 2, lowered: { workflowSteps: 50 } },
        inForce: { generation: 3, lowered: { workflowSteps: 100 } },
        state: "drifted",
      },
      stillDrifted: "drifted",
    });
  });

  it("waits for the next deploy while the console's change hasn't reached core, and reads in sync with none set, whatever else waits", async () => {
    const release = await importedRelease("feat(core): quota policy pending");
    const { clientId } = await recordClient();
    await deploy(clientId, release);
    const none = await clientQuotaPolicy(env, clientId);
    // Another setting changed since the deploy: the policy is still in sync.
    await db
      .update(clients)
      .set({ configChangedAt: new Date() })
      .where(eq(clients.id, clientId));
    const otherPending = await clientQuotaPolicy(env, clientId);
    await setQuota(clientId, 1, 10);
    const pending = await clientQuotaPolicy(env, clientId);

    expect({ none, otherPending, pending }).toMatchObject({
      none: {
        set: { generation: 0, lowered: {} },
        inForce: { generation: 0, lowered: {}, recordedAt: null },
        state: "in_sync",
      },
      otherPending: { set: { generation: 0 }, state: "in_sync" },
      pending: {
        set: { generation: 1 },
        inForce: { generation: 0 },
        state: "pending",
      },
    });
  });

  it("is unknown, never in sync, when core can't answer: a core from before the report, one that fails, one not deployed", async () => {
    const release = await importedRelease("feat(core): quota policy unknown");
    const old = await recordClient();
    await deploy(old.clientId, release);
    old.account.quotaPolicy = "absent";
    const failing = await recordClient();
    await deploy(failing.clientId, release);
    failing.account.unhealthy = 1000;
    const undeployed = await recordClient();

    expect({
      old: await clientQuotaPolicy(env, old.clientId),
      failing: await clientQuotaPolicy(env, failing.clientId),
      undeployed: await clientQuotaPolicy(env, undeployed.clientId),
      missing: await clientQuotaPolicy(env, "client-nonesuch"),
    }).toStrictEqual({
      old: {
        set: { generation: 0, lowered: {} },
        inForce: null,
        state: "unknown",
      },
      failing: {
        set: { generation: 0, lowered: {} },
        inForce: null,
        state: "unknown",
      },
      undeployed: {
        set: { generation: 0, lowered: {} },
        inForce: null,
        state: "unknown",
      },
      missing: null,
    });
  });
});

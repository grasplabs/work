import { clientsNamespace } from "@grasp-os/shared/names";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { cloudflareApi } from "../src/cloudflare/api.ts";
import {
  clientPlacements,
  clientProvisions,
  clientResources,
  clients,
} from "../src/db/schema.ts";
import { signInApps } from "../src/deploy/context.ts";
import type { DeploySecrets } from "../src/deploy/secrets.ts";
import {
  fetchClientHosting,
  placeAndProvisionFn,
} from "../src/hosting/functions.ts";
import {
  runClientProvision,
  startClientProvision,
} from "../src/hosting/operation.ts";
import type { Jurisdiction } from "../src/hosting/organization.ts";
import { startClient } from "../src/provision/functions.ts";
import { claimRun } from "../src/runners.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, destination, placedClient, staff } from "./hosting.ts";
import { namespaceRelease } from "./namespace-release.ts";
import { callServerFn } from "./pages.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Every resource an organization gets is created where it keeps its data
// (src/hosting/organization.ts): in the EU, or in no jurisdiction. How it
// can fail, each tried below:
// - A database, bucket or Durable Object created somewhere else than the
//   organization's jurisdiction, or bound as if it were.
// - An on-premises organization given anything in Grasp's cloud.

const token = "test-deployer-token-org-jurisdiction-61b0";
const cloudflare = mockCloudflareApi(token);
mockAccess();

const namespace = clientsNamespace("production");
const secrets: DeploySecrets = {
  routerKey: "test-router-key",
  clientKey: "test-client-key",
  shared: { connect: { COMPOSIO_API_KEY: "composio" } },
};

const bindingsSchema = z.array(
  z.looseObject({
    name: z.string(),
    type: z.string(),
    text: z.unknown().optional(),
    jurisdiction: z.unknown().optional(),
  })
);

/** Where Workers with `bindings` make their Durable Objects. */
const durableObjectsIn = (bindings: z.infer<typeof bindingsSchema>): unknown =>
  bindings.find(({ name }) => name === "DURABLE_OBJECT_JURISDICTION")?.text ??
  "eu";

/** Provisions a new client keeping its data in `jurisdiction`, in a namespace on a new account, to its end. */
const provisioned = async (jurisdiction: Jurisdiction) => {
  const manifest = await namespaceRelease();
  const account = cloudflare.addAccount();
  account.namespaces.set(namespace, new Map());
  const destinationId = await destination({
    kind: "workers_for_platforms",
    accountId: account.id,
    namespace,
  });
  const { clientId } = await placedClient(destinationId);
  await db
    .update(clients)
    .set({ jurisdiction })
    .where(eq(clients.id, clientId));
  const runId = await claimRun(
    db,
    staff,
    clientId,
    null,
    { action: "client.provision_placed", clientId },
    { kind: "provision_placed", runId: `${clientId}-p1` }
  );
  const held = { clientId, runId: runId ?? "" };
  const calls = cloudflare.calls.length;
  await startClientProvision(db, staff, held, manifest.releaseId);
  await runClientProvision(
    {
      api: cloudflareApi({ token, retryDelayMs: 0 }),
      db,
      store: env.RELEASES,
      secrets,
      signInApps: signInApps(env),
      router: {
        hosts: env.ROUTER_HOSTS,
        domain: "grasp.test",
        smoke: { retryDelayMs: 0 },
        namespace,
        dispatcher: cloudflare.dispatcher(account.id, namespace),
      },
      observe: { retryDelayMs: 0 },
    },
    held
  );
  const made = cloudflare.calls
    .slice(calls)
    .filter(({ method }) => method === "POST");
  const resources = await db
    .select({
      kind: clientResources.kind,
      jurisdiction: clientResources.jurisdiction,
      physicalName: clientResources.physicalName,
      role: clientResources.role,
    })
    .from(clientResources)
    .where(eq(clientResources.clientId, clientId));
  const scriptOf = (role: string) =>
    resources.find((resource) => resource.role === role)?.physicalName ?? "";
  const bindingsOf = (script: string) =>
    bindingsSchema.parse(
      account.namespaces.get(namespace)?.get(script)?.versions.at(-1)?.metadata
        .bindings ?? []
    );
  const core = bindingsOf(scriptOf("worker:grasp-os-core"));
  const connect = bindingsOf(scriptOf("worker:grasp-os-connect"));
  const operation = await db
    .select({ status: clientProvisions.status })
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId))
    .get();
  return {
    operation: operation?.status,
    storage: [
      ...new Set(
        resources
          .filter(({ kind }) => kind === "d1_database" || kind === "r2_bucket")
          .map((resource) => resource.jurisdiction)
      ),
    ],
    databases: [
      ...new Set(
        made
          .filter(({ path }) => path.endsWith("/d1/database"))
          .map(
            ({ body }) =>
              z.object({ jurisdiction: z.string().optional() }).parse(body)
                .jurisdiction ?? "none named"
          )
      ),
    ],
    buckets: [
      ...new Set(
        made
          .filter(({ path }) => path.endsWith("/r2/buckets"))
          .map(({ headers }) => headers.get("cf-r2-jurisdiction"))
      ),
    ],
    boundBuckets: [
      ...new Set(
        core
          .filter(({ type }) => type === "r2_bucket")
          .map(({ jurisdiction: bound }) => bound ?? "none named")
      ),
    ],
    durableObjects: [durableObjectsIn(core), durableObjectsIn(connect)],
  };
};

describe("an organization's jurisdiction", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(() => {
    // A run that stops logs why.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("puts every database, bucket and Durable Object of an EU organization in the EU", async () => {
    await expect(provisioned("eu")).resolves.toStrictEqual({
      operation: "done",
      storage: ["eu"],
      databases: ["eu"],
      buckets: ["eu"],
      boundBuckets: ["eu"],
      durableObjects: ["eu", "eu"],
    });
  });

  it("puts every database, bucket and Durable Object of a Global organization in no jurisdiction", async () => {
    await expect(provisioned("none")).resolves.toStrictEqual({
      operation: "done",
      storage: ["default"],
      databases: ["none named"],
      buckets: ["default"],
      boundBuckets: ["none named"],
      durableObjects: ["none", "none"],
    });
  });

  it("gives an on-premises organization nothing in Grasp's cloud, and says why", async () => {
    await destination();
    const clientId = `own-${crypto.randomUUID().slice(0, 8)}`;
    const calls = cloudflare.calls.length;

    const created = await callServerFn(
      startClient,
      {
        clientId,
        name: "Own Servers",
        ring: 1,
        hosting: "on_prem",
        signIn: {
          domains: ["acme.test"],
          admins: ["ada@acme.test"],
          googleHostedDomain: "acme.test",
        },
      },
      { email: staff.email }
    );
    const placed = await callServerFn(
      placeAndProvisionFn,
      { clientId, releaseId: null, destinationId: null },
      { email: staff.email }
    );
    const hosting = await callServerFn(
      fetchClientHosting,
      { clientId },
      { email: staff.email }
    );

    expect({
      created: created.refused,
      placed: placed.refused,
      hosting: hosting?.hosting,
      notStarted: hosting?.notStarted,
      placement: await db
        .select()
        .from(clientPlacements)
        .where(eq(clientPlacements.clientId, clientId))
        .get(),
      cloudflare: cloudflare.calls.length - calls,
    }).toStrictEqual({
      created: null,
      placed: "hosted_on_prem",
      hosting: { hosting: "on_prem", jurisdiction: "eu" },
      notStarted: "on_prem",
      placement: undefined,
      cloudflare: 0,
    });
  });
});

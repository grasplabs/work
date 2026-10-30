/**
 * Placed clients as the admin's tests start from them: a release a placed
 * client runs, imported, and a client provisioned on it in a dedicated
 * destination of its own on the fake Cloudflare API, live, as staff leave
 * it once its operation is done (src/hosting/operation.ts).
 */
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { act } from "../src/db/act.ts";
import {
  clientRuns,
  clients,
  clientWorkers,
  releases,
} from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { placeClient } from "../src/hosting/inventory.ts";
import {
  runClientProvision,
  startClientProvision,
  startClientRelease,
} from "../src/hosting/operation.ts";
import { claimRun } from "../src/runners.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import type { fakeCloudflareApi } from "./cloudflare-api.ts";
import { db, destination, staff } from "./hosting.ts";
import { buildRelease, putBlobs } from "./releases.ts";
import type { ReleaseSpec } from "./releases.ts";

/**
 * When the last release was built: each later one is newer, and newer than
 * any built before this module was evaluated again (as the browser
 * journeys' admin may, test/e2e-worker.ts).
 */
let built = 0;

/**
 * A release a placed client runs, imported as the admin imports one: core
 * binds its own Durable Object classes, and none of the Workflows binding
 * a placed client has no resource for. `adjust` changes core.
 */
export const placedRelease = async (
  notes: string,
  spec: Omit<ReleaseSpec, "notes"> = {},
  adjust: (core: WorkerEntry) => WorkerEntry = (core) => core
): Promise<string> => {
  const release = await buildRelease({ notes, ...spec });
  const { core } = release.manifest.workers;
  if (core === undefined) {
    throw new Error("The test release has no core");
  }
  const manifest: ReleaseManifest = {
    ...release.manifest,
    workers: {
      ...release.manifest.workers,
      core: adjust({
        ...core,
        durableObjectMigrations: [
          { tag: "v1", new_sqlite_classes: ["Workspace", "AuditLog"] },
        ],
        bindings: core.bindings.filter(({ type }) => type !== "workflow"),
      }),
    },
  };
  await putBlobs(release);
  built = Math.max(built + 1000, Date.now());
  await db.insert(releases).values({
    id: manifest.releaseId,
    commitSha: manifest.commit,
    manifest: JSON.stringify(manifest),
    manifestSha256: "0".repeat(64),
    limitEvidence: release.limitEvidenceText ?? null,
    builtAt: new Date(built),
    importedAt: new Date(built),
  });
  return manifest.releaseId;
};

/** What a placed client is recorded as, beyond its ring. */
export interface PlacedClientOptions {
  /** Its id; a new one when not given. */
  id?: string;
  /** Its name; `Acme <id>` when not given. */
  name?: string;
  /** How its people sign in, as staff give it; Acme's when not given, none for null. */
  signIn?: Record<string, unknown> | null;
}

/** A live placed client, and the account its dedicated destination is on. */
export interface PlacedClient {
  clientId: string;
  account: AccountState;
  destinationId: string;
}

/**
 * A client in `ring`, placed in a dedicated destination of its own on a
 * new account in `cloudflare`, and not provisioned yet: as staff leave it
 * once they've added and placed it.
 */
export const placedClientRecord = async (
  cloudflare: ReturnType<typeof fakeCloudflareApi>,
  ring: number,
  {
    id = `client-${crypto.randomUUID().slice(0, 8)}`,
    name = `Acme ${id}`,
    signIn = {
      domains: ["acme.test"],
      admins: ["ada@acme.test"],
      googleHostedDomain: "acme.test",
    },
  }: PlacedClientOptions = {}
): Promise<PlacedClient> => {
  const account = cloudflare.addAccount(name);
  const destinationId = await destination({
    kind: "dedicated",
    accountId: account.id,
    namespace: null,
  });
  const clientId = id;
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name,
        ring,
        signIn: signIn === null ? null : JSON.stringify(signIn),
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  await placeClient(db, staff, {
    clientId,
    destinationId,
  });
  return { clientId, account, destinationId };
};

/**
 * Runs placed client `clientId`'s operation for `releaseId`, as a new
 * attempt holding it, until it's done: provisioning it the first time,
 * then releasing it, or running the release it runs again (its settings
 * and secrets as they are now). Throws what the operation stopped with.
 */
export const deployPlaced = async (
  clientId: string,
  releaseId: string
): Promise<void> => {
  // Claimed first: only the holder starts the operation.
  const before = await db
    .select({ runId: clientRuns.runId })
    .from(clientRuns)
    .where(eq(clientRuns.clientId, clientId))
    .get();
  const runId = await claimRun(
    db,
    staff,
    clientId,
    before?.runId ?? null,
    { action: "client.provision_placed", clientId },
    {
      kind: "provision_placed",
      runId: `${clientId}-p${crypto.randomUUID().slice(0, 8)}`,
    }
  );
  if (runId === undefined) {
    throw new Error(`${clientId} wasn't claimed`);
  }
  const held = { clientId, runId };
  const [client] = await db
    .select({ status: clients.status })
    .from(clients)
    .where(eq(clients.id, clientId));
  await (client?.status === "active"
    ? startClientRelease(db, staff, held, { releaseId, again: true })
    : startClientProvision(db, staff, held, releaseId));
  await runClientProvision(await deployContext(env), held);
};

/**
 * A client in `ring` on `releaseId`, placed in a dedicated destination of
 * its own on a new account in `cloudflare`, and provisioned there: live,
 * its operation done and its runner released.
 */
export const livePlacedClient = async (
  cloudflare: ReturnType<typeof fakeCloudflareApi>,
  ring: number,
  releaseId: string,
  options?: PlacedClientOptions
): Promise<PlacedClient> => {
  const client = await placedClientRecord(cloudflare, ring, options);
  await deployPlaced(client.clientId, releaseId);
  const [row] = await db
    .select({ status: clients.status })
    .from(clients)
    .where(eq(clients.id, client.clientId));
  if (row?.status !== "active") {
    throw new Error(`${client.clientId} isn't live after provisioning`);
  }
  return client;
};

/** Client `clientId`'s scripts in its destination, by Worker, as its operation recorded them. */
export const scriptsOf = async (
  clientId: string
): Promise<{ core: string; connect: string }> => {
  const rows = await db
    .select({ worker: clientWorkers.worker, script: clientWorkers.scriptName })
    .from(clientWorkers)
    .where(eq(clientWorkers.clientId, clientId));
  const core = rows.find(({ worker }) => worker === "core")?.script;
  const connect = rows.find(({ worker }) => worker === "connect")?.script;
  if (core === undefined || connect === undefined) {
    throw new Error(`${clientId} has no scripts recorded`);
  }
  return { core, connect };
};

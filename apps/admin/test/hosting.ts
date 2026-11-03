import { clientsNamespace } from "@grasp-os/shared/names";
import type { Stage } from "@grasp-os/shared/names";
/**
 * Hosting test setup: destinations, client
 * records as provisioning makes them, and releases whose core binds as the
 * real one does.
 */
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";

import { adminDatabase } from "../src/db/act.ts";
import { channels, clients, hostingDestinations } from "../src/db/schema.ts";
import type { Channel } from "../src/db/schema.ts";
import { placeClient } from "../src/hosting/inventory.ts";
import { buildRelease } from "./releases.ts";

export const db = adminDatabase(env.DB);
export const staff = { email: "staff@grasp.test", sub: "sub-staff" };

let destinations = 0;
/**
 * A destination recorded as the admin records its stage's, on an account
 * of its own and in `stage`'s namespace unless said: for a test of what the
 * admin does with whatever destination a client is placed in.
 */
export const destination = async (
  input: { accountId?: string | null; namespace?: string | null } = {},
  stage: Stage = "production"
): Promise<string> => {
  destinations += 1;
  const id = `eu-${crypto.randomUUID().slice(0, 8)}-${destinations}`;
  const now = new Date();
  await db.insert(hostingDestinations).values({
    id,
    accountId: crypto.randomUUID().replaceAll("-", ""),
    namespace: clientsNamespace(stage),
    ...input,
    createdAt: now,
    updatedAt: now,
  });
  return id;
};

/** A new client record, as provisioning makes one. */
export const client = async (): Promise<string> => {
  const id = `acme-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await db.insert(clients).values({
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
  });
  return id;
};

/** A release whose core binds as the real one does, with `classes` migrations. */
export const release = async (
  durableObjectMigrations: ReleaseManifest["workers"][string]["durableObjectMigrations"] = [
    { tag: "v1", new_sqlite_classes: ["Workspace", "AuditLog"] },
  ]
): Promise<ReleaseManifest> => {
  const { manifest } = await buildRelease({ notes: "feat(core): test" });
  const { core } = manifest.workers;
  if (core === undefined) {
    throw new Error("The test release has no core");
  }
  return {
    ...manifest,
    workers: {
      ...manifest.workers,
      core: {
        ...core,
        durableObjectMigrations,
        bindings: [
          ...core.bindings.filter((binding) => binding.type !== "workflow"),
          { type: "worker_loader", name: "LOADER" },
          { type: "send_email", name: "EMAIL" },
        ],
      },
    },
  };
};

export const placedClient = async (destinationId: string) => {
  const clientId = await client();
  const placement = await placeClient(db, staff, {
    clientId,
    destinationId,
  });
  return { clientId, placement };
};

/**
 * Points `channel` at release `releaseId`, as promoting it there leaves
 * it: what a client following the channel is provisioned on. Stable by
 * default, which a new client follows.
 */
export const onChannel = async (
  releaseId: string,
  channel: Channel = "stable"
): Promise<void> => {
  await db
    .insert(channels)
    .values({ id: channel, releaseId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: channels.id,
      set: { releaseId, updatedAt: new Date() },
    });
};

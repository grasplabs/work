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
import { channels, clients } from "../src/db/schema.ts";
import type { Channel } from "../src/db/schema.ts";
import { placeClient, saveDestination } from "../src/hosting/inventory.ts";
import type { DestinationInput } from "../src/hosting/inventory.ts";
import { buildRelease } from "./releases.ts";

export const db = adminDatabase(env.DB);
export const staff = { email: "staff@grasp.test", sub: "sub-staff" };

let destinations = 0;
/** A new destination, in this admin's stage's namespace unless said. */
export const destination = async (
  input: Partial<DestinationInput> = {},
  /** The stage of the admin that records it. */
  stage: Stage = "production"
): Promise<string> => {
  destinations += 1;
  const id = `eu-${crypto.randomUUID().slice(0, 8)}-${destinations}`;
  await saveDestination(
    db,
    staff,
    {
      id,
      kind: "workers_for_platforms",
      accountId: crypto.randomUUID().replaceAll("-", ""),
      // The namespace of the stage of the admin that records it.
      namespace: clientsNamespace(stage),
      ...input,
    },
    stage
  );
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

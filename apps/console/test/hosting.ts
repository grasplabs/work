/**
 * Hosting test setup: destinations with verified capabilities, client
 * records as provisioning makes them, and releases whose core binds as the
 * real one does.
 */
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";

import { consoleDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { placeClient, saveDestination } from "../src/hosting/inventory.ts";
import type { DestinationInput } from "../src/hosting/inventory.ts";
import { hostingPolicies } from "../src/hosting/policy.ts";
import type {
  Capability,
  DestinationCapabilities,
} from "../src/hosting/policy.ts";
import { buildRelease } from "./releases.ts";

export const db = consoleDatabase(env.DB);
export const staff = { email: "staff@grasp.test", sub: "sub-staff" };

export const evidence = {
  procedure:
    "Created a D1 database, R2 bucket and Durable Object in the EU and read back their jurisdiction",
  subject: { kind: "release", id: "r000000001-abcdef0" },
  observedAt: "2026-10-20T10:00:00.000Z",
  recordedBy: "staff@grasp.test",
  record: "https://linear.app/grasp-os/issue/GRA-430",
} as const;

export const verified = (
  except: Partial<Record<Capability, "unsupported" | "unknown">> = {}
): DestinationCapabilities =>
  Object.fromEntries(
    hostingPolicies["eu-storage"].requires
      .filter((capability) => except[capability] !== "unknown")
      .map((capability) => [
        capability,
        { status: except[capability] ?? "verified", evidence },
      ])
  );

let destinations = 0;
/** A new destination serving `eu-storage`, with every requirement verified unless said. */
export const destination = async (
  input: Partial<DestinationInput> = {}
): Promise<string> => {
  destinations += 1;
  const id = `eu-${crypto.randomUUID().slice(0, 8)}-${destinations}`;
  await saveDestination(db, staff, {
    id,
    kind: "workers_for_platforms",
    accountId: crypto.randomUUID().replaceAll("-", ""),
    namespace: "production",
    policies: ["eu-storage"],
    capabilities: verified(),
    ...input,
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
    accountId: crypto.randomUUID(),
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
          { type: "ai", name: "AI" },
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
    policyId: "eu-storage",
  });
  return { clientId, placement };
};

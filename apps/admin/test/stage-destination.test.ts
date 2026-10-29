import { clientsNamespace, platformAccountId } from "@grasp-os/shared/names";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import {
  auditEvents,
  clientPlacements,
  hostingDestinations,
  releases,
} from "../src/db/schema.ts";
import {
  fetchClientHosting,
  placeAndProvisionFn,
} from "../src/hosting/functions.ts";
import { saveDestination } from "../src/hosting/inventory.ts";
import {
  ensureStageDestination,
  stageDestinationId,
} from "../src/hosting/placement.ts";
import { startClient } from "../src/provision/functions.ts";
import { adminWorkflows } from "../src/workflow-runs.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, release, staff, verified } from "./hosting.ts";
import { callServerFn } from "./pages.ts";
import { startsOf } from "./runs.ts";

// A new admin's own shared destination (src/hosting/placement.ts,
// `ensureStageDestination`). How it can fail, each tried below:
// - Nothing records it, so a new admin places no one (staging's first
//   organization had nowhere to go).
// - It is recorded with capabilities nobody verified, so a client is
//   placed on the admin's word alone.
// - It is recorded again on every read, or in the other stage's namespace,
//   or by an admin whose STAGE names no stage.

const token = "test-deployer-token-stage-destination-7d41c0";
mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

/** This admin's stage, as its wrangler.jsonc sets it for the tests. */
const stage = "production";
const ownId = stageDestinationId(stage);

/** A release imported to provision with, as the real one binds. */
const importedRelease = async (): Promise<string> => {
  const manifest = await release();
  const now = new Date();
  await db.insert(releases).values({
    id: manifest.releaseId,
    commitSha: manifest.commit,
    manifest: JSON.stringify(manifest),
    manifestSha256: "0".repeat(64),
    builtAt: now,
    importedAt: now,
  });
  return manifest.releaseId;
};

const destinationsNow = async () =>
  await db
    .select({
      id: hostingDestinations.id,
      kind: hostingDestinations.kind,
      accountId: hostingDestinations.accountId,
      namespace: hostingDestinations.namespace,
    })
    .from(hostingDestinations);

const view = async (clientId: string) =>
  await callServerFn(
    fetchClientHosting,
    { clientId, policyId: "eu-storage" },
    { email: staff.email }
  );

const place = async (clientId: string, releaseId: string) =>
  await callServerFn(
    placeAndProvisionFn,
    { clientId, releaseId, policyId: "eu-storage", destinationId: null },
    { email: staff.email }
  );

describe("a new admin's own shared destination", () => {
  it("is recorded on its own stage's namespace, claiming nothing, and takes the first client once staff verified it", async () => {
    const fresh = await destinationsNow();
    const releaseId = await importedRelease();
    const clientId = `acme-${crypto.randomUUID().slice(0, 8)}`;
    const added = await callServerFn(
      startClient,
      {
        clientId,
        name: "Acme",
        ring: 1,
        signIn: {
          domains: ["acme.test"],
          admins: ["ada@acme.test"],
          entraTenantId: "8f3c9a52-1d4e-4b6f-9a2c-3e5d7f9b1c2a",
        },
      },
      { email: staff.email }
    );

    const first = await view(clientId);
    await view(clientId);
    const unverified = await place(clientId, releaseId);

    // What staff observed of the destination, recorded as theirs.
    await saveDestination(
      db,
      staff,
      {
        id: ownId,
        kind: "workers_for_platforms",
        accountId: platformAccountId,
        namespace: clientsNamespace(stage),
        policies: ["eu-storage"],
        capabilities: verified(),
      },
      stage
    );
    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    const placed = await place(clientId, releaseId);
    const placement = await db
      .select({ destinationId: clientPlacements.destinationId })
      .from(clientPlacements)
      .where(eq(clientPlacements.clientId, clientId))
      .get();
    const recorded = await db
      .select({ actor: auditEvents.actor })
      .from(auditEvents)
      .where(eq(auditEvents.action, "destination.save"));

    expect({
      fresh,
      added: added.refused,
      destinations: await destinationsNow(),
      problems: first?.destinations.find(({ id }) => id === ownId)?.problems
        .length,
      automatic: first?.automatic,
      unverified: unverified.refused,
      placed: placed.refused,
      placement,
      attempts: attempts.started.length,
      recordedBy: recorded.map(({ actor }) => actor),
    }).toStrictEqual({
      fresh: [],
      added: null,
      destinations: [
        {
          id: ownId,
          kind: "workers_for_platforms",
          accountId: platformAccountId,
          namespace: "grasp-clients",
        },
      ],
      // Every requirement of the policy unknown until staff verify it.
      problems: 6,
      automatic: { destinationId: null, reason: "none" },
      unverified: "no_automatic_destination",
      placed: null,
      placement: { destinationId: ownId },
      attempts: 1,
      // Recorded once by the admin, however often it was read, then by staff.
      recordedBy: ["system", staff.email],
    });
  });

  it("is recorded in staging's namespace by a staging admin, and by no admin whose STAGE names no stage", async () => {
    const earlier = await destinationsNow();
    const before = new Set(earlier.map(({ id }) => id));
    await ensureStageDestination({ ...env, STAGE: "staging" }, db);
    await ensureStageDestination({ ...env, STAGE: "prod" }, db);
    const now = await destinationsNow();
    const added = now.filter(({ id }) => !before.has(id));

    const staging = await db
      .select({ namespace: hostingDestinations.namespace })
      .from(hostingDestinations)
      .where(eq(hostingDestinations.id, stageDestinationId("staging")))
      .get();
    expect({
      staging,
      added: added.map(({ namespace }) => namespace),
    }).toStrictEqual({
      staging: { namespace: "grasp-clients-staging" },
      added: ["grasp-clients-staging"],
    });
  });
});

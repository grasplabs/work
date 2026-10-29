import { clientsNamespace, platformAccountId } from "@grasp-os/shared/names";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  auditEvents,
  clientPlacements,
  clientProvisions,
  hostingDestinations,
} from "../src/db/schema.ts";
import {
  fetchClientHosting,
  fetchDestinations,
  placeAndProvisionFn,
  recordCapabilityCheckFn,
} from "../src/hosting/functions.ts";
import { destinationOf } from "../src/hosting/inventory.ts";
import {
  ensureStageDestination,
  stageDestinationId,
} from "../src/hosting/placement.ts";
import type { Capability } from "../src/hosting/policy.ts";
import { startClient } from "../src/provision/functions.ts";
import { adminWorkflow, adminWorkflows } from "../src/workflow-runs.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, staff } from "./hosting.ts";
import { callServerFn, page } from "./pages.ts";
import { placedRelease } from "./placed.ts";
import { ended, startsOf } from "./runs.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// A new admin's own shared destination (src/hosting/placement.ts,
// `ensureStageDestination`), and how it comes to take clients. How it
// can fail, each tried below:
// - Nothing records it, so a new admin places no one (staging's first
//   organization had nowhere to go).
// - It is taken on the admin's word: a capability counted as checked
//   that nobody, and no check, observed.
// - Its first client waits for a check only its own provisioning runs.
// - Provisioning finds a database outside the EU and carries on, or
//   records nothing, so the next client is placed there too.
// - A person's check recorded as someone else's, or unaudited.
// - It is recorded again on every read, in the other stage's namespace,
//   or by an admin whose STAGE names no stage.

const token = "test-deployer-token-stage-destination-7d41c0";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

/** This admin's stage, as its wrangler.jsonc sets it for the tests. */
const stage = "production";
const ownId = stageDestinationId(stage);

/** The binding kinds Workers for Platforms documents for user Workers. */
const documented = new Set([
  "d1",
  "r2_bucket",
  "durable_object_namespace",
  "assets",
]);

/** A release a client in a Workers for Platforms namespace runs: documented bindings, no cron triggers. */
const sharedRelease = async (): Promise<string> =>
  await placedRelease("feat(core): the first", { crons: [] }, (core) => ({
    ...core,
    bindings: core.bindings.filter(({ type }) => documented.has(type)),
  }));

/** What no provisioning observes, so a person vouches for each. */
const vouched: readonly Capability[] = [
  "durable_objects.eu_jurisdiction",
  "logs.payload_free",
  "models.approved_transport",
  "secrets.replication_recorded",
];

/** Staff recording, through the form, that they checked `capability`. */
const vouch = async (capability: Capability, email = staff.email) =>
  await callServerFn(
    recordCapabilityCheckFn,
    {
      destinationId: ownId,
      capability,
      holds: true,
      procedure: `Read ${capability} back on a test client`,
      record: "https://linear.app/grasp-os/issue/GRA-430",
      observedAt: "2026-10-29T09:00:00.000Z",
    },
    { email }
  );

/** A client staff add, as the new-organization form does. */
const added = async (): Promise<string> => {
  const clientId = `acme-${crypto.randomUUID().slice(0, 8)}`;
  const result = await callServerFn(
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
  if (result.clientId === null) {
    throw new Error(`Adding ${clientId} was refused: ${result.refused}`);
  }
  return clientId;
};

const place = async (clientId: string, releaseId: string) =>
  await callServerFn(
    placeAndProvisionFn,
    { clientId, releaseId, policyId: "eu-storage", destinationId: null },
    { email: staff.email }
  );

/** What the destination's record says of each capability: its status and who observed it. */
const recordedOf = async () => {
  const { capabilities } = await destinationOf(db, ownId);
  return Object.fromEntries(
    Object.entries(capabilities).map(([capability, entry]) => [
      capability,
      `${entry?.status ?? "unknown"} by ${entry?.evidence.recordedBy ?? "nobody"}`,
    ])
  );
};

// In order, as one new admin's life: its own destination recorded and a
// check made on the Destinations page, its first client provisioned there,
// then a provisioning that finds a database outside the EU.
describe("a new admin's own shared destination", () => {
  useStoreSecrets({ deployer: token });
  // Grasp's own account, with the stage's clients' namespace in it.
  beforeEach(() => {
    const account = cloudflare.addAccount(
      "Grasp",
      undefined,
      platformAccountId
    );
    account.namespaces.set(clientsNamespace(stage), new Map());
    // Attempts log why they stopped.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("is recorded on its own stage's namespace claiming nothing, and Platform's Destinations page shows its checklist and records a check as the one who made it", async () => {
    const fresh = await db.select().from(hostingDestinations);

    const before = await page("/platform/destinations", staff.email);
    await callServerFn(fetchDestinations, undefined, { email: staff.email });
    await vouch("logs.payload_free", "ops@grasp.test");
    const after = await page("/platform/destinations", staff.email);
    const audited = await db
      .select({ actor: auditEvents.actor, action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.target, ownId));

    expect({
      fresh,
      destination: await db
        .select({
          kind: hostingDestinations.kind,
          accountId: hostingDestinations.accountId,
          namespace: hostingDestinations.namespace,
        })
        .from(hostingDestinations),
      status: before.status,
      firstTime: before.html.includes(
        "Grasp&#x27;s own hosting checks itself when you provision the first client"
      ),
      needsChecking: before.html.includes("Needs checking"),
      form: before.html.includes("Record a check"),
      byWhom: after.html.includes("By ops@grasp.test"),
      recorded: await recordedOf(),
      // Recorded once by the admin however often it was read, the check as
      // the one who made it.
      audited: audited.map(({ actor, action }) => `${action} by ${actor}`),
    }).toStrictEqual({
      fresh: [],
      destination: [
        {
          kind: "workers_for_platforms",
          accountId: platformAccountId,
          namespace: "grasp-clients",
        },
      ],
      status: 200,
      firstTime: true,
      needsChecking: true,
      form: true,
      byWhom: true,
      recorded: { "logs.payload_free": "verified by ops@grasp.test" },
      audited: [
        "destination.save by system",
        "destination.evidence by ops@grasp.test",
      ],
    });
  });

  it("places the first client once a person vouched for what no check observes, and its provisioning records its own check", async () => {
    const releaseId = await sharedRelease();
    const clientId = await added();

    const first = await callServerFn(
      fetchClientHosting,
      { clientId, policyId: "eu-storage" },
      { email: staff.email }
    );
    const unvouched = await place(clientId, releaseId);
    for (const capability of vouched.filter(
      (each) => each !== "logs.payload_free"
    )) {
      // oxlint-disable-next-line no-await-in-loop -- one form after another
      await vouch(capability);
    }

    // Its first migration fails, so the attempt waits to try again after
    // the resources, and is ended there: what comes after needs
    // Cloudflare's own dispatch namespace.
    cloudflare.failNext(
      (call) => call.path.endsWith("/query"),
      "statement-failed"
    );
    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    const placed = await place(clientId, releaseId);
    const runId = attempts.started.at(-1) ?? "";
    await vi.waitFor(async () => {
      const { capabilities: now } = await destinationOf(db, ownId);
      if (now["r2.eu_jurisdiction"]?.status !== "verified") {
        throw new Error("Provisioning hasn't recorded its check yet");
      }
    });
    const run = await adminWorkflow(
      env,
      adminWorkflows.provisionPlacedClient
    ).get(runId);
    await run.terminate();
    const { capabilities } = await destinationOf(db, ownId);

    expect({
      states: Object.fromEntries(
        (first?.destinations.find(({ id }) => id === ownId)?.checks ?? []).map(
          ({ capability, state }) => [capability, state]
        )
      ),
      unvouched: unvouched.refused,
      placed: placed.refused,
      placement: await db
        .select({ destinationId: clientPlacements.destinationId })
        .from(clientPlacements)
        .where(eq(clientPlacements.clientId, clientId))
        .get(),
      recorded: await recordedOf(),
      automatic: capabilities[
        "d1.eu_jurisdiction"
      ]?.evidence.procedure.startsWith(
        `Automatic check during provisioning, run ${runId}:`
      ),
    }).toStrictEqual({
      // Before it: two its first provisioning checks, four a person does.
      states: {
        "d1.eu_jurisdiction": "checked_on_provision",
        "r2.eu_jurisdiction": "checked_on_provision",
        "durable_objects.eu_jurisdiction": "needs_checking",
        "logs.payload_free": "verified",
        "models.approved_transport": "needs_checking",
        "secrets.replication_recorded": "needs_checking",
      },
      unvouched: "no_automatic_destination",
      placed: null,
      placement: { destinationId: ownId },
      recorded: {
        "logs.payload_free": "verified by ops@grasp.test",
        "durable_objects.eu_jurisdiction": `verified by ${staff.email}`,
        "models.approved_transport": `verified by ${staff.email}`,
        "secrets.replication_recorded": `verified by ${staff.email}`,
        "d1.eu_jurisdiction": "verified by system",
        "r2.eu_jurisdiction": "verified by system",
      },
      automatic: true,
    });
  });

  it("stops provisioning when it reads back a database outside the EU, tells staff, and places no one there after", async () => {
    const releaseId = await sharedRelease();
    const clientId = await added();
    // Cloudflare puts the database somewhere other than asked.
    const account = cloudflare.addAccount(
      "Grasp",
      undefined,
      platformAccountId
    );
    account.namespaces.set(clientsNamespace(stage), new Map());
    account.d1Reports = "default";
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    await place(clientId, releaseId);
    await ended(
      adminWorkflows.provisionPlacedClient,
      attempts.started.at(-1) ?? ""
    );
    const recorded = await recordedOf();
    const next = await added();
    const refused = await place(next, releaseId);

    expect({
      operation: await db
        .select({
          step: clientProvisions.step,
          error: clientProvisions.error,
        })
        .from(clientProvisions)
        .where(eq(clientProvisions.clientId, clientId))
        .get(),
      d1: recorded["d1.eu_jurisdiction"],
      told: warned.mock.calls.some(([fields]) =>
        JSON.stringify(fields).includes("hosting_check_failed")
      ),
      next: refused.refused,
      nextPlaced: await db
        .select()
        .from(clientPlacements)
        .where(eq(clientPlacements.clientId, next))
        .get(),
    }).toStrictEqual({
      operation: { step: "validated", error: "resource_outside_jurisdiction" },
      d1: "unsupported by system",
      told: true,
      next: "no_automatic_destination",
      nextPlaced: undefined,
    });
  });

  it("is recorded in staging's namespace by a staging admin, and by no admin whose STAGE names no stage", async () => {
    const earlier = await db.select().from(hostingDestinations);
    const before = new Set(earlier.map(({ id }) => id));
    await ensureStageDestination({ ...env, STAGE: "staging" }, db);
    await ensureStageDestination({ ...env, STAGE: "prod" }, db);
    const now = await db.select().from(hostingDestinations);

    expect(
      now
        .filter(({ id }) => !before.has(id))
        .map(({ id, namespace }) => ({ id, namespace }))
    ).toStrictEqual([
      { id: stageDestinationId("staging"), namespace: "grasp-clients-staging" },
    ]);
  });
});

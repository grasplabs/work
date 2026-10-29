import { platformAccountId } from "@grasp-os/shared/names";
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
} from "../src/hosting/functions.ts";
import { destinationOf } from "../src/hosting/inventory.ts";
import {
  ensureStageDestination,
  stageDestinationId,
} from "../src/hosting/placement.ts";
import { adminWorkflow, adminWorkflows } from "../src/workflow-runs.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, staff } from "./hosting.ts";
import {
  added,
  graspAccount,
  ownId,
  place,
  recordedOf,
  sharedRelease,
  vouch,
} from "./own-destination.ts";
import { callServerFn, page } from "./pages.ts";
import { ended, startsOf } from "./runs.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// A new admin's own shared destination (src/hosting/placement.ts,
// `ensureStageDestination`), and how it comes to take clients. How it
// can fail, each tried below:
// - Nothing records it, so a new admin places no one (staging's first
//   organization had nowhere to go).
// - It is taken on the admin's word: a capability counted as checked
//   that no check observed and the platform doesn't record.
// - Its first client waits for a person, or for a check only its own
//   provisioning runs.
// - Provisioning finds a database outside the EU and carries on, or
//   records nothing, so the next client is placed there too.
// - A person recording a check it makes itself.
// - It is recorded again on every read, in the other stage's namespace,
//   or by an admin whose STAGE names no stage.

const token = "test-deployer-token-stage-destination-7d41c0";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

// In order, as one new admin's life: its own destination recorded and a
// check made on the Destinations page, its first client provisioned there,
// then a provisioning that finds a database outside the EU.
describe("a new admin's own shared destination", () => {
  useStoreSecrets({ deployer: token });
  // Grasp's own account, with the stage's clients' namespace in it.
  beforeEach(() => {
    graspAccount(cloudflare);
    // Attempts log why they stopped.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("is recorded on its own stage's namespace claiming nothing, and Platform's Destinations page shows a checklist nobody has to fill in", async () => {
    const fresh = await db.select().from(hostingDestinations);

    const before = await page("/platform/destinations", staff.email);
    await callServerFn(fetchDestinations, undefined, { email: staff.email });
    const refused = await vouch("logs.payload_free", "ops@grasp.test");
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
          policies: hostingDestinations.policies,
        })
        .from(hostingDestinations),
      status: before.status,
      itself: before.html.includes(
        "Grasp&#x27;s own hosting checks itself when it provisions a client"
      ),
      platform: before.html.includes("By platform (reviewed in code)"),
      needsChecking: before.html.includes("Needs checking"),
      form: before.html.includes("Record a check"),
      refused: refused.refused,
      recorded: await recordedOf(),
      // Recorded once by the admin however often it was read.
      audited: audited.map(({ actor, action }) => `${action} by ${actor}`),
    }).toStrictEqual({
      fresh: [],
      destination: [
        {
          kind: "workers_for_platforms",
          accountId: platformAccountId,
          namespace: "grasp-clients",
          policies: JSON.stringify(["eu-storage"]),
        },
      ],
      status: 200,
      itself: true,
      platform: true,
      needsChecking: false,
      form: false,
      refused: "checks_itself",
      recorded: {},
      audited: ["destination.create by system"],
    });
  });

  it("places the first client with no person's check, and its provisioning records its own", async () => {
    const releaseId = await sharedRelease();
    const clientId = await added();

    const first = await callServerFn(
      fetchClientHosting,
      { clientId, policyId: "eu-storage" },
      { email: staff.email }
    );
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
      // Before it: five its provisioning checks, one the platform records.
      states: {
        "d1.eu_jurisdiction": "checked_on_provision",
        "r2.eu_jurisdiction": "checked_on_provision",
        "durable_objects.eu_jurisdiction": "checked_on_provision",
        "logs.payload_free": "checked_on_provision",
        "models.approved_transport": "checked_on_provision",
        "secrets.replication_recorded": "verified",
      },
      placed: null,
      placement: { destinationId: ownId },
      // Durable Objects once core answers its probe, past where this ends.
      recorded: {
        "logs.payload_free": "verified by system",
        "models.approved_transport": "verified by system",
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
    const account = graspAccount(cloudflare);
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

import { platformAccountId } from "@grasp-os/shared/names";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  auditEvents,
  destinationCapabilityEvidence,
  hostingDestinations,
} from "../src/db/schema.ts";
import { destinationOf } from "../src/hosting/inventory.ts";
import { ensureStageDestination } from "../src/hosting/placement.ts";
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
  vouched,
} from "./own-destination.ts";
import { page } from "./pages.ts";
import { startsOf } from "./runs.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// A new admin's own destination under writes that land at once, and a
// check put right after it was recorded. How it can fail, each tried
// below:
// - Two reads creating it twice, auditing it twice, or one overwriting
//   what staff recorded of it since.
// - Two checks recorded at once, each writing back the capabilities it
//   read, so one of them is lost.
// - Provisioning's own success replacing a check that found the
//   capability doesn't hold, recorded while it ran.
// - A recorded check that can't be put right or withdrawn.

const token = "test-deployer-token-stage-destination-races-2b9e11";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const created = async () =>
  await db
    .select({ actor: auditEvents.actor })
    .from(auditEvents)
    .where(eq(auditEvents.action, "destination.create"));

// In order, on one admin's database.
describe("a new admin's own destination, written at once", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(() => {
    graspAccount(cloudflare);
    // Attempts log why they stopped.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("is created once however many reads race to, and never overwritten after", async () => {
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        await ensureStageDestination(env, db);
      })
    );
    await vouch("logs.payload_free");
    await ensureStageDestination(env, db);
    const rows = await db.select().from(hostingDestinations);
    const creations = await created();
    const kept = await recordedOf();
    const { accountId } = await destinationOf(db, ownId);

    expect({
      rows: rows.map(({ id }) => id),
      created: creations.map(({ actor }) => actor),
      kept,
      account: accountId,
    }).toStrictEqual({
      rows: [ownId],
      created: ["system"],
      kept: { "logs.payload_free": `verified by ${staff.email}` },
      account: platformAccountId,
    });
  });

  it("keeps every check two people record at once", async () => {
    await Promise.all(
      vouched
        .filter((capability) => capability !== "logs.payload_free")
        .map(async (capability, at) => {
          await vouch(capability, `ops${at}@grasp.test`);
        })
    );

    await expect(recordedOf()).resolves.toStrictEqual({
      "logs.payload_free": `verified by ${staff.email}`,
      "durable_objects.eu_jurisdiction": "verified by ops0@grasp.test",
      "models.approved_transport": "verified by ops1@grasp.test",
      "secrets.replication_recorded": "verified by ops2@grasp.test",
    });
  });

  it("never replaces with its own success a check found not to hold while provisioning ran", async () => {
    const releaseId = await sharedRelease();
    const clientId = await added();
    // While its database is being created, staff find D1 doesn't hold.
    cloudflare.beforeAnswering(
      (call) => call.method === "POST" && call.path.endsWith("/d1/database"),
      async () => {
        await vouch("d1.eu_jurisdiction", "ops@grasp.test", false);
      }
    );
    // Its first migration fails, so the attempt waits after the resources,
    // and is ended there: what comes after needs Cloudflare's own dispatch
    // namespace.
    cloudflare.failNext(
      (call) => call.path.endsWith("/query"),
      "statement-failed"
    );

    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    const placed = await place(clientId, releaseId);
    const runId = attempts.started.at(-1) ?? "";
    await vi.waitFor(async () => {
      const { capabilities } = await destinationOf(db, ownId);
      if (capabilities["r2.eu_jurisdiction"] === undefined) {
        throw new Error("Provisioning hasn't recorded its check yet");
      }
    });
    const run = await adminWorkflow(
      env,
      adminWorkflows.provisionPlacedClient
    ).get(runId);
    await run.terminate();
    const recorded = await recordedOf();

    expect({
      placed: placed.refused,
      d1: recorded["d1.eu_jurisdiction"],
      r2: recorded["r2.eu_jurisdiction"],
    }).toStrictEqual({
      placed: null,
      d1: "unsupported by ops@grasp.test",
      r2: "verified by system",
    });
  });

  it("lets staff put a recorded check right with a new one, kept in its history and audited", async () => {
    const before = await page("/platform/destinations", staff.email);
    await vouch("d1.eu_jurisdiction", "ops@grasp.test", true);
    const history = await db
      .select({
        status: destinationCapabilityEvidence.status,
        recordedBy: destinationCapabilityEvidence.recordedBy,
      })
      .from(destinationCapabilityEvidence)
      .where(eq(destinationCapabilityEvidence.capability, "d1.eu_jurisdiction"))
      .orderBy(destinationCapabilityEvidence.id);
    const audited = await db
      .select({ actor: auditEvents.actor, detail: auditEvents.detail })
      .from(auditEvents)
      .where(eq(auditEvents.action, "destination.evidence"));

    const recorded = await recordedOf();

    expect({
      offered: before.html.includes("Record a new check"),
      now: recorded["d1.eu_jurisdiction"],
      history,
      audited: audited.filter(({ detail }) =>
        (detail ?? "").includes("evidence.d1.eu_jurisdiction")
      ).length,
    }).toStrictEqual({
      offered: true,
      now: "verified by ops@grasp.test",
      history: [
        { status: "unsupported", recordedBy: "ops@grasp.test" },
        { status: "verified", recordedBy: "ops@grasp.test" },
      ],
      audited: 2,
    });
  });
});

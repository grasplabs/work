import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";

import { auditEvents, clientProvisions } from "../src/db/schema.ts";
import { destinationOf } from "../src/hosting/inventory.ts";
import { ensureStageDestination } from "../src/hosting/placement.ts";
import { adminWorkflow, adminWorkflows } from "../src/workflow-runs.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db } from "./hosting.ts";
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
import { ended, startsOf } from "./runs.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Provisioning's own check (src/hosting/provision.ts) on a fresh admin's
// own destination, when an attempt stops partway through its resources
// and staff start it again. How it can fail: the attempt that made the
// database stops before recording it, and the one after skips it as
// made, so D1's check is never recorded; or a retry records it twice.

const token = "test-deployer-token-stage-destination-retry-4c7a18";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

describe("provisioning's own check, tried again", () => {
  useStoreSecrets({ deployer: token });

  it("records every resource's check once, those an earlier try made included, after a bucket failed", async () => {
    graspAccount(cloudflare);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await ensureStageDestination(env, db);
    for (const capability of vouched) {
      // oxlint-disable-next-line no-await-in-loop -- one form after another
      await vouch(capability);
    }
    const releaseId = await sharedRelease();
    const clientId = await added();
    // The bucket's create is refused once, after the database was made:
    // the first attempt stops there, and staff start it again.
    cloudflare.failNext(
      (call) => call.method === "POST" && call.path.endsWith("/r2/buckets"),
      "400-uncoded"
    );

    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    await place(clientId, releaseId);
    await ended(
      adminWorkflows.provisionPlacedClient,
      attempts.started.at(-1) ?? ""
    );
    const afterFirst = await recordedOf();
    // Its first migration fails, so the next attempt waits after the
    // resources, and is ended there: what comes after needs Cloudflare's
    // own dispatch namespace.
    cloudflare.failNext(
      (call) => call.path.endsWith("/query"),
      "statement-failed"
    );
    const resumed = await place(clientId, releaseId);
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
    const evidence = await db
      .select({ actor: auditEvents.actor })
      .from(auditEvents)
      .where(eq(auditEvents.action, "destination.evidence"));

    expect({
      afterFirst: afterFirst["d1.eu_jurisdiction"],
      resumed: resumed.refused,
      attempts: attempts.started.length,
      d1: recorded["d1.eu_jurisdiction"],
      r2: recorded["r2.eu_jurisdiction"],
      // One record each, however many tries and resources of each kind.
      written: evidence.filter(({ actor }) => actor === "system").length,
    }).toStrictEqual({
      // Recorded by the try that made it, before the bucket failed.
      afterFirst: "verified by system",
      resumed: null,
      attempts: 2,
      d1: "verified by system",
      r2: "verified by system",
      written: 2,
    });
  });

  it("judges nothing of the destination by a database replaced under the client's name since, and refuses it as foreign", async () => {
    const account = graspAccount(cloudflare);
    const releaseId = await sharedRelease();
    const clientId = await added();
    cloudflare.failNext(
      (call) => call.method === "POST" && call.path.endsWith("/r2/buckets"),
      "400-uncoded"
    );

    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    await place(clientId, releaseId);
    await ended(
      adminWorkflows.provisionPlacedClient,
      attempts.started.at(-1) ?? ""
    );
    // Someone replaces the client's database with one of the same name,
    // outside the EU.
    for (const database of account.d1) {
      database.uuid = crypto.randomUUID();
      database.jurisdiction = undefined;
    }
    await place(clientId, releaseId);
    await ended(
      adminWorkflows.provisionPlacedClient,
      attempts.started.at(-1) ?? ""
    );
    const recorded = await recordedOf();
    const operation = await db
      .select({ error: clientProvisions.error })
      .from(clientProvisions)
      .where(eq(clientProvisions.clientId, clientId))
      .get();

    expect({
      d1: recorded["d1.eu_jurisdiction"],
      operation,
    }).toStrictEqual({
      d1: "verified by system",
      operation: { error: "foreign_resource" },
    });
  });
});

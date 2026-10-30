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
  ensureStageDestination,
  stageDestinationId,
} from "../src/hosting/placement.ts";
import { adminWorkflow, adminWorkflows } from "../src/workflow-runs.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db } from "./hosting.ts";
import {
  added,
  graspAccount,
  ownId,
  sharedRelease,
} from "./own-destination.ts";
import { ended, startsOf } from "./runs.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// A new admin's own shared destination (src/hosting/placement.ts,
// `ensureStageDestination`), and its first clients going there by
// themselves. How it can fail, each tried below:
// - Nothing records it, so a new admin places no one.
// - It is recorded again on every read, by reads at once, in the other
//   stage's namespace, or by an admin whose STAGE names no stage.
// - A client added waits for a click before it is provisioned there.
// - Cloudflare puts a database outside the organization's jurisdiction,
//   and provisioning carries on with it.

const token = "test-deployer-token-stage-destination-7d41c0";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

// In order, as one new admin's life.
describe("a new admin's own shared destination", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(() => {
    graspAccount(cloudflare);
    // Attempts log why they stopped.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("is recorded once on its own stage's namespace, however many reads race to", async () => {
    const fresh = await db.select().from(hostingDestinations);

    await Promise.all(
      Array.from({ length: 5 }, async () => {
        await ensureStageDestination(env, db);
      })
    );
    const audited = await db
      .select({ actor: auditEvents.actor, action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.target, ownId));

    expect({
      fresh,
      destination: await db
        .select({
          id: hostingDestinations.id,
          kind: hostingDestinations.kind,
          accountId: hostingDestinations.accountId,
          namespace: hostingDestinations.namespace,
        })
        .from(hostingDestinations),
      audited: audited.map(({ actor, action }) => `${action} by ${actor}`),
    }).toStrictEqual({
      fresh: [],
      destination: [
        {
          id: ownId,
          kind: "workers_for_platforms",
          accountId: platformAccountId,
          namespace: "grasp-clients",
        },
      ],
      audited: ["destination.create by system"],
    });
  });

  it("takes a client as it is added, its databases created in the EU, with no click", async () => {
    await sharedRelease();
    // Its first migration fails, so the attempt waits to try again after
    // its resources, and is ended there: what comes after needs
    // Cloudflare's own dispatch namespace.
    cloudflare.failNext(
      (call) => call.path.endsWith("/query"),
      "statement-failed"
    );
    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    const clientId = await added();
    const runId = attempts.started.at(-1) ?? "";
    await vi.waitFor(async () => {
      const operation = await db
        .select({ step: clientProvisions.step })
        .from(clientProvisions)
        .where(eq(clientProvisions.clientId, clientId))
        .get();
      if (operation?.step !== "resources") {
        throw new Error("Its attempt hasn't made its resources yet");
      }
    });
    const run = await adminWorkflow(
      env,
      adminWorkflows.provisionPlacedClient
    ).get(runId);
    await run.terminate();
    const created = cloudflare.calls
      .filter(
        ({ method, path }) => method === "POST" && path.endsWith("/d1/database")
      )
      .map(({ body }) => body);

    expect({
      started: attempts.started.length,
      placement: await db
        .select({ destinationId: clientPlacements.destinationId })
        .from(clientPlacements)
        .where(eq(clientPlacements.clientId, clientId))
        .get(),
      created: created.length > 0,
      inEu: created.every((body) =>
        JSON.stringify(body).includes('"jurisdiction":"eu"')
      ),
    }).toStrictEqual({
      started: 1,
      placement: { destinationId: ownId },
      created: true,
      inEu: true,
    });
  });

  it("stops provisioning when Cloudflare reports a database outside the organization's jurisdiction", async () => {
    await sharedRelease();
    // Cloudflare puts the database somewhere other than asked.
    const account = graspAccount(cloudflare);
    account.d1Reports = "default";

    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    const clientId = await added();
    await ended(
      adminWorkflows.provisionPlacedClient,
      attempts.started.at(-1) ?? ""
    );

    await expect(
      db
        .select({ error: clientProvisions.error })
        .from(clientProvisions)
        .where(eq(clientProvisions.clientId, clientId))
        .get()
    ).resolves.toStrictEqual({ error: "resource_outside_jurisdiction" });
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

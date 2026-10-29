import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  auditEvents,
  clientPlacements,
  clientProvisions,
  clients,
  clientRuns,
  hostingDestinations,
  releases,
} from "../src/db/schema.ts";
import {
  deletePlacedClientFn,
  fetchClientHosting,
  offboardPlacedClientFn,
  placeAndProvisionFn,
  releasePlacedClientFn,
  rollbackPlacedClientFn,
} from "../src/hosting/functions.ts";
import {
  allocateClientResources,
  placeClient,
} from "../src/hosting/inventory.ts";
import { getClientHosting } from "../src/hosting/placement.ts";
import { adminWorkflows } from "../src/workflow-runs.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import {
  client,
  db,
  destination,
  release,
  staff,
  verified,
} from "./hosting.ts";
import { callServerFn, page } from "./pages.ts";
import { ended, startsOf } from "./runs.ts";
import type { Starts } from "./runs.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-hosting-3c81d2";
mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

/** Who places and provisions, through the admin's entry: the staff member Access vouches for. */
const caller = "ops@grasp.test";

const policyId = "eu-storage";

/**
 * A release imported for a placed client. Its core has a cron trigger,
 * which Workers for Platforms doesn't document for user Workers, so an
 * attempt in a shared destination stops at validation
 * (`wfp_schedule_unqualified`) before it reaches Cloudflare.
 */
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

/** Client `clientId`'s hosting, as its page reads it. */
const hostingOf = async (clientId: string) => {
  const view = await getClientHosting(env, clientId, policyId);
  if (view === null) {
    throw new Error(`No client ${clientId}`);
  }
  return view;
};

const place = async (
  clientId: string,
  releaseId: string,
  destinationId: string | null,
  email: string | null = caller
) =>
  await callServerFn(
    placeAndProvisionFn,
    { clientId, releaseId, policyId, destinationId },
    { email }
  );

const placementOf = async (clientId: string) =>
  await db
    .select({ destinationId: clientPlacements.destinationId })
    .from(clientPlacements)
    .where(eq(clientPlacements.clientId, clientId))
    .get();

const operationOf = async (clientId: string) =>
  await db
    .select({
      id: clientProvisions.id,
      releaseId: clientProvisions.releaseId,
      status: clientProvisions.status,
      error: clientProvisions.error,
      startedBy: clientProvisions.startedBy,
    })
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId))
    .get();

/** Who `action` about client `clientId` is audited as, in order. */
const actorsOf = async (clientId: string, action: string) => {
  const events = await db
    .select({ actor: auditEvents.actor })
    .from(auditEvents)
    .where(
      and(eq(auditEvents.clientId, clientId), eq(auditEvents.action, action))
    );
  return events.map(({ actor }) => actor);
};

/** The attempts a test starts. */
const followAttempts = () => startsOf(adminWorkflows.provisionPlacedClient);

/** Waits until the latest attempt stopped, which it does at validation. */
const latestStopped = async ({ started }: Starts): Promise<void> => {
  const latest = started.at(-1);
  if (latest === undefined) {
    throw new Error("No attempt was started");
  }
  await expect(
    ended(adminWorkflows.provisionPlacedClient, latest)
  ).resolves.toMatchObject({ status: "errored" });
};

describe("placing a client and provisioning it, through the admin's entry", () => {
  useStoreSecrets({ deployer: token });
  // The database outlives each test: earlier tests' destinations stop
  // serving the policy, so each test chooses among its own alone.
  beforeEach(async () => {
    await db.update(hostingDestinations).set({ policies: "[]" });
    // Attempts log why they stopped.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("picks the one shared destination that meets the policy, lists what blocks every other, and places the client there", async () => {
    const shared = await destination();
    const blocked = await destination({
      capabilities: verified({ "logs.payload_free": "unknown" }),
    });
    const dedicated = await destination({
      kind: "dedicated",
      namespace: null,
    });
    const workerd = await destination({
      kind: "workerd",
      accountId: null,
      namespace: null,
    });
    const clientId = await client();
    const releaseId = await importedRelease();

    const view = await hostingOf(clientId);
    const mine = new Set([shared, blocked, dedicated, workerd]);
    const offered = view.destinations.filter(({ id }) => mine.has(id));
    expect({
      automatic: view.automatic,
      kinds: offered.map(({ kind }) => kind),
      problems: Object.fromEntries(
        offered.map(({ id, problems }) => [id, problems])
      ),
    }).toStrictEqual({
      automatic: { destinationId: shared, reason: null },
      // Shared first, then dedicated, then workerd.
      kinds: [
        "workers_for_platforms",
        "workers_for_platforms",
        "dedicated",
        "workerd",
      ],
      problems: {
        [shared]: [],
        [blocked]: [
          { kind: "capability_unknown", capability: "logs.payload_free" },
        ],
        [dedicated]: [],
        [workerd]: [{ kind: "not_provisionable" }],
      },
    });

    using attempts = followAttempts();
    const result = await place(clientId, releaseId, null);
    await latestStopped(attempts);

    expect({
      result,
      placement: await placementOf(clientId),
      operation: await operationOf(clientId),
      placedBy: await actorsOf(clientId, "client.place"),
      startedBy: await actorsOf(clientId, "client.provision_placed"),
    }).toMatchObject({
      result: { refused: null, problems: [] },
      placement: { destinationId: shared },
      operation: {
        releaseId,
        status: "failed",
        error: "wfp_schedule_unqualified",
        startedBy: caller,
      },
      placedBy: [caller],
      startedBy: [caller],
    });
    expect(result.runId).toBeTypeOf("string");
  });

  it("shows staff in the company's Setup the destination it would go in, and the requirement that blocks another", async () => {
    const shared = await destination();
    const blocked = await destination({
      capabilities: verified({ "logs.payload_free": "unsupported" }),
    });
    const clientId = await client();

    const { status, html } = await page(
      `/organizations/${clientId}/setup`,
      caller
    );

    expect(status).toBe(200);
    expect(html).toContain(
      `Automatic: ${shared}, the one shared destination that meets every requirement of ${policyId}.`
    );
    expect(html).toContain(blocked);
    expect(html).toContain(
      "Found unsupported: Logs and analytics hold no payloads or secret values (logs.payload_free)."
    );
    expect(html).toContain("Place and start provisioning");
  });

  it("refuses a destination that misses a requirement, naming it, and places nothing", async () => {
    await destination();
    const blocked = await destination({
      capabilities: verified({
        "d1.eu_jurisdiction": "unsupported",
        "models.approved_transport": "unknown",
      }),
    });
    const clientId = await client();
    const releaseId = await importedRelease();

    await expect(place(clientId, releaseId, blocked)).resolves.toStrictEqual({
      runId: null,
      refused: "placement_refused",
      problems: [
        { kind: "capability_unsupported", capability: "d1.eu_jurisdiction" },
        { kind: "capability_unknown", capability: "models.approved_transport" },
      ],
    });
    expect({
      placement: await placementOf(clientId),
      operation: await operationOf(clientId),
    }).toStrictEqual({ placement: undefined, operation: undefined });
  });

  it("never falls back to a dedicated destination when no shared one qualifies", async () => {
    const blocked = await destination({ policies: [] });
    await destination({ kind: "dedicated", namespace: null });
    const clientId = await client();
    const releaseId = await importedRelease();

    const view = await hostingOf(clientId);
    expect({
      automatic: view.automatic,
      blocking: view.destinations.find(({ id }) => id === blocked)?.problems,
      refused: await place(clientId, releaseId, null),
      placement: await placementOf(clientId),
    }).toStrictEqual({
      automatic: { destinationId: null, reason: "none" },
      blocking: [{ kind: "policy_not_allowed" }],
      refused: {
        runId: null,
        refused: "no_automatic_destination",
        problems: [],
      },
      placement: undefined,
    });
  });

  it("leaves a client whose last run was another kind's unplaced, for that run's own path", async () => {
    await destination();
    const clientId = await client();
    const releaseId = await importedRelease();
    // Another kind's run ended without saying so, long enough ago that
    // it's no longer starting.
    await db.insert(clientRuns).values({
      clientId,
      runId: `${clientId}-apply`,
      kind: "apply",
      claimedAt: new Date(Date.now() - 3_600_000),
    });

    expect({
      refused: await place(clientId, releaseId, null),
      placement: await placementOf(clientId),
      operation: await operationOf(clientId),
      run: await db
        .select({ runId: clientRuns.runId, kind: clientRuns.kind })
        .from(clientRuns)
        .where(eq(clientRuns.clientId, clientId)),
    }).toStrictEqual({
      refused: { runId: null, refused: "other_run_held", problems: [] },
      placement: undefined,
      operation: undefined,
      run: [{ runId: `${clientId}-apply`, kind: "apply" }],
    });
  });

  it("picks nothing when several shared destinations qualify, for staff to choose", async () => {
    await destination();
    const second = await destination();
    const clientId = await client();
    const releaseId = await importedRelease();

    const view = await hostingOf(clientId);
    expect(view.automatic).toStrictEqual({
      destinationId: null,
      reason: "several",
    });
    await expect(place(clientId, releaseId, null)).resolves.toMatchObject({
      refused: "no_automatic_destination",
    });

    using attempts = followAttempts();
    await expect(place(clientId, releaseId, second)).resolves.toMatchObject({
      refused: null,
    });
    await latestStopped(attempts);
    await expect(placementOf(clientId)).resolves.toStrictEqual({
      destinationId: second,
    });
  });

  it("places the client in a dedicated destination staff choose", async () => {
    await destination();
    const dedicated = await destination({
      kind: "dedicated",
      namespace: null,
    });
    const clientId = await client();
    const releaseId = await importedRelease();

    using attempts = followAttempts();
    await expect(place(clientId, releaseId, dedicated)).resolves.toMatchObject({
      refused: null,
    });
    await latestStopped(attempts);

    await expect(placementOf(clientId)).resolves.toStrictEqual({
      destinationId: dedicated,
    });
    const { placement } = await hostingOf(clientId);
    expect(placement).toMatchObject({
      destinationId: dedicated,
      policyId,
      placedBy: caller,
    });
  });

  it("resumes the client's one operation where it stopped, keeps it where it's placed, and refuses another release", async () => {
    const shared = await destination();
    const other = await destination({ kind: "dedicated", namespace: null });
    const clientId = await client();
    const releaseId = await importedRelease();
    using attempts = followAttempts();
    await place(clientId, releaseId, null);
    await latestStopped(attempts);
    const first = await operationOf(clientId);

    const stopped = await hostingOf(clientId);
    expect({
      operation: stopped.operation,
      run: stopped.run,
      going: stopped.going,
    }).toMatchObject({
      operation: {
        releaseId,
        status: "failed",
        error: "wfp_schedule_unqualified",
      },
      run: "errored",
      going: false,
    });

    const resumed = await place(clientId, releaseId, null);
    await latestStopped(attempts);
    const again = await operationOf(clientId);
    const { started } = attempts;
    expect({
      resumed,
      operation: again?.id,
      attempts: started.length,
      placement: await placementOf(clientId),
    }).toMatchObject({
      resumed: { refused: null },
      operation: first?.id,
      attempts: 2,
      placement: { destinationId: shared },
    });

    expect({
      moved: await place(clientId, releaseId, other),
      anotherRelease: await place(clientId, await importedRelease(), null),
    }).toMatchObject({
      moved: { refused: "placement_changed" },
      anotherRelease: { refused: "operation_release_changed" },
    });
  });

  it("refuses anyone Access doesn't vouch for, placing and reading nothing", async () => {
    await destination();
    const clientId = await client();
    const releaseId = await importedRelease();

    await expect(place(clientId, releaseId, null, null)).rejects.toThrow(
      "The server function answered 403"
    );
    await expect(
      callServerFn(fetchClientHosting, { clientId, policyId }, { email: null })
    ).rejects.toThrow("The server function answered 403");
    await expect(
      callServerFn(
        placeAndProvisionFn,
        { clientId, releaseId, policyId, destinationId: null },
        { email: caller, from: "https://elsewhere.test" }
      )
    ).rejects.toThrow("The server function answered 403");

    expect({
      placement: await placementOf(clientId),
      operation: await operationOf(clientId),
      audited: await actorsOf(clientId, "client.place"),
    }).toStrictEqual({
      placement: undefined,
      operation: undefined,
      audited: [],
    });
  });

  it("offers staff a live placed client's later release, and the rollback to the one before, and refuses both to anyone Access doesn't vouch for", async () => {
    const destinationId = await destination();
    const clientId = await client();
    const [before, current, later] = [
      await importedRelease(),
      await importedRelease(),
      await importedRelease(),
    ];
    await placeClient(db, staff, { clientId, destinationId, policyId });
    const now = new Date();
    await db.insert(clientProvisions).values({
      id: crypto.randomUUID(),
      clientId,
      releaseId: current,
      previousReleaseId: before,
      status: "done",
      step: "route",
      startedBy: caller,
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(clients)
      .set({ status: "active" })
      .where(eq(clients.id, clientId));

    const { status, html } = await page(
      `/organizations/${clientId}/setup`,
      caller
    );
    // Its release left running by a runner that has ended: resumed from
    // here, the release it was of offered first.
    await db
      .update(clientProvisions)
      .set({ status: "running", step: "core" })
      .where(eq(clientProvisions.clientId, clientId));
    const stopped = await page(`/organizations/${clientId}/setup`, caller);
    await db
      .update(clientProvisions)
      .set({ status: "done", step: "route" })
      .where(eq(clientProvisions.clientId, clientId));
    const refused = await Promise.all([
      callServerFn(
        releasePlacedClientFn,
        { clientId, releaseId: later },
        { email: null }
      ).then(() => "answered", String),
      callServerFn(rollbackPlacedClientFn, { clientId }, { email: null }).then(
        () => "answered",
        String
      ),
    ]);

    expect({
      status,
      release: html.includes("Release it"),
      rollBack: html.includes(`Roll back to ${before}`),
      resume: stopped.html.includes("Resume the release"),
      place: html.includes("Place and start provisioning"),
      refused: refused.map((answer) => answer.includes("answered 403")),
      operation: await operationOf(clientId),
    }).toMatchObject({
      status: 200,
      release: true,
      rollBack: true,
      resume: true,
      place: false,
      refused: [true, true],
      operation: { releaseId: current, status: "done" },
    });
  });

  it("offers to offboard a placed client, then to delete its resources with no export confirmed, and refuses both to anyone Access doesn't vouch for", async () => {
    const destinationId = await destination();
    const clientId = await client();
    await placeClient(db, staff, { clientId, destinationId, policyId });
    // Its resources, as provisioning records them before it makes them.
    await allocateClientResources(db, staff, {
      clientId,
      manifest: await release(),
      operationId: "op",
    });
    await db
      .update(clients)
      .set({ status: "active" })
      .where(eq(clients.id, clientId));

    const live = await page(`/organizations/${clientId}/setup`, caller);
    const refused = await Promise.all([
      callServerFn(offboardPlacedClientFn, { clientId }, { email: null }).then(
        () => "answered",
        String
      ),
      callServerFn(
        deletePlacedClientFn,
        { clientId, exportConfirmed: true },
        { email: null }
      ).then(() => "answered", String),
    ]);
    const offboarded = await callServerFn(
      offboardPlacedClientFn,
      { clientId },
      { email: caller }
    );
    const early = await callServerFn(
      deletePlacedClientFn,
      { clientId, exportConfirmed: true },
      { email: caller }
    );
    // Offboarded, it has no page among the organizations: its deletion is
    // on Platform's Offboarded page.
    const gone = await page(`/organizations/${clientId}/setup`, caller);
    const after = await page("/platform/offboarded", caller);

    expect({
      offer: live.html.includes("Offboard it"),
      refused: refused.map((answer) => answer.includes("answered 403")),
      offboarded,
      early,
      gone: gone.status,
      deleteOffer: after.html.includes("Delete its resources"),
      kept: after.html.includes(`${clientId})`),
    }).toStrictEqual({
      offer: true,
      refused: [true, true],
      offboarded: { refused: null, deletion: null },
      early: { refused: "retention_running", deletion: null },
      gone: 404,
      deleteOffer: true,
      kept: true,
    });
  });
});

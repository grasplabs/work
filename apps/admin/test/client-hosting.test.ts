import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  auditEvents,
  channels,
  clientAdminReads,
  clientPlacements,
  clientResources,
  clientProvisions,
  clients,
  clientRuns,
  releases,
} from "../src/db/schema.ts";
import { DiscardError, discardClient } from "../src/hosting/discard.ts";
import {
  deletePlacedClientFn,
  discardClientFn,
  fetchClientHosting,
  offboardPlacedClientFn,
  placeAndProvisionFn,
} from "../src/hosting/functions.ts";
import {
  allocateClientResources,
  placeClient,
} from "../src/hosting/inventory.ts";
import { getClientHosting } from "../src/hosting/placement.ts";
import { pinClient } from "../src/rollout/channels.ts";
import { pinClientFn } from "../src/rollout/functions.ts";
import { claimRun } from "../src/runners.ts";
import { adminWorkflows } from "../src/workflow-runs.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { client, db, destination, release, staff } from "./hosting.ts";
import { ownId } from "./own-destination.ts";
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

/** What Platform's Offboarded page `html` shows of client `clientId` alone. */
const offboardedOf = (html: string, clientId: string): string => {
  const at = html.indexOf(`(${clientId})`);
  if (at === -1) {
    return "";
  }
  // Up to the next client's item.
  const next = html.indexOf("rounded-xl", at);
  return html.slice(at, next === -1 ? undefined : next);
};

/** Whether the button saying `label` in `html` is off. */
const buttonOff = (html: string, label: string): boolean | null => {
  const at = html.indexOf(`${label}</button>`);
  if (at === -1) {
    return null;
  }
  const tag = html.slice(html.lastIndexOf("<button", at), at);
  return tag.includes("disabled");
};

/** Whether the box confirming no export was made, in `html`, is off. */
const confirmOff = (html: string): boolean | null => {
  const at = html.indexOf('id="no-export-');
  if (at === -1) {
    return null;
  }
  const tag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at));
  return tag.includes("disabled");
};

/** Client `clientId`'s hosting, as its page reads it. */
const hostingOf = async (clientId: string) => {
  const view = await getClientHosting(env, clientId);
  if (view === null) {
    throw new Error(`No client ${clientId}`);
  }
  return view;
};

/**
 * Places and provisions client `clientId` on `releaseId`, in its stage's
 * destination, as `email` through the admin's entry: staff pin it to the
 * release first, as provisioning starts a client on the release it
 * should run.
 */
const place = async (
  clientId: string,
  releaseId: string,
  email: string | null = caller
) => {
  await pinClient(env, staff, { clientId, releaseId });
  return await callServerFn(placeAndProvisionFn, { clientId }, { email });
};

/** Trying it again, as its Setup's button does. */
const retry = async (clientId: string) =>
  await callServerFn(placeAndProvisionFn, { clientId }, { email: caller });

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
  beforeEach(() => {
    // Attempts log why they stopped.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("places the client in its stage's destination", async () => {
    const clientId = await client();
    const releaseId = await importedRelease();

    const view = await hostingOf(clientId);
    expect(view.destinationId).toBe(ownId);

    using attempts = followAttempts();
    const result = await place(clientId, releaseId);
    await latestStopped(attempts);

    expect({
      result,
      placement: await placementOf(clientId),
      operation: await operationOf(clientId),
      placedBy: await actorsOf(clientId, "client.place"),
      startedBy: await actorsOf(clientId, "client.provision_placed"),
    }).toMatchObject({
      result: { refused: null },
      placement: { destinationId: ownId },
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

  it("places nothing on an admin whose STAGE names no stage", async () => {
    const clientId = await client();
    const releaseId = await importedRelease();
    const stage = env.STAGE;
    env.STAGE = "";
    try {
      const view = await hostingOf(clientId);
      expect({
        destinationId: view.destinationId,
        notStarted: view.notStarted,
        refused: await place(clientId, releaseId),
        placement: await placementOf(clientId),
      }).toStrictEqual({
        destinationId: null,
        notStarted: "no_destination",
        refused: { runId: null, refused: "no_destination" },
        placement: undefined,
      });
    } finally {
      env.STAGE = stage;
    }
  });

  it("leaves a client whose last run was another kind's unplaced, for that run's own path", async () => {
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
      refused: await place(clientId, releaseId),
      placement: await placementOf(clientId),
      operation: await operationOf(clientId),
      run: await db
        .select({ runId: clientRuns.runId, kind: clientRuns.kind })
        .from(clientRuns)
        .where(eq(clientRuns.clientId, clientId)),
    }).toStrictEqual({
      refused: { runId: null, refused: "other_run_held" },
      placement: undefined,
      operation: undefined,
      run: [{ runId: `${clientId}-apply`, kind: "apply" }],
    });
  });

  it("tries a stopped provisioning again on the release it should run now, a fix it was pinned to since included", async () => {
    const clientId = await client();
    const own = await importedRelease();
    using attempts = followAttempts();
    await place(clientId, own);
    await latestStopped(attempts);
    const fixed = await importedRelease();
    await pinClient(env, staff, { clientId, releaseId: fixed });

    // Retry, as its Setup's button asks: no release named.
    const retried = await retry(clientId);
    await latestStopped(attempts);
    const operation = await operationOf(clientId);

    expect({
      retried: retried.refused,
      operation: operation?.releaseId,
      switched: await actorsOf(clientId, "provision.switch_release"),
    }).toStrictEqual({ retried: null, operation: fixed, switched: [caller] });
  });

  it("provisions a new client with its channel's release, not a newer one only Edge has", async () => {
    const clientId = await client();
    const stable = await importedRelease();
    await db
      .insert(channels)
      .values({ id: "stable", releaseId: stable, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: channels.id,
        set: { releaseId: stable },
      });
    // Newer, on Edge alone.
    await importedRelease();
    using attempts = followAttempts();

    try {
      // Started as the cron and Setup start it: no release named.
      const started = await retry(clientId);
      await latestStopped(attempts);
      const hosting = await hostingOf(clientId);
      const operation = await operationOf(clientId);
      expect({
        started: started.refused,
        suggested: hosting.suggestedReleaseId,
        operation: operation?.releaseId,
      }).toStrictEqual({ started: null, suggested: stable, operation: stable });
    } finally {
      await db.delete(channels);
    }
  });

  it("tries a stopped provisioning again on its own release while it should still run it, a newer import notwithstanding", async () => {
    const clientId = await client();
    const own = await importedRelease();
    using attempts = followAttempts();
    await place(clientId, own);
    await latestStopped(attempts);
    await importedRelease();

    const retried = await retry(clientId);
    await latestStopped(attempts);
    const operation = await operationOf(clientId);

    expect({
      retried: retried.refused,
      operation: operation?.releaseId,
      switched: await actorsOf(clientId, "provision.switch_release"),
    }).toStrictEqual({ retried: null, operation: own, switched: [] });
  });

  it("resumes the client's one operation where it stopped, keeps it where it's placed, and takes an older release back", async () => {
    const clientId = await client();
    const releaseId = await importedRelease();
    using attempts = followAttempts();
    await place(clientId, releaseId);
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

    const resumed = await place(clientId, releaseId);
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
      placement: { destinationId: ownId },
    });

    // Stopped with nothing live: resuming offers the release it should
    // run, a newer one only once staff pin it, which then takes its
    // operation over, as an older one pinned again does.
    const newer = await importedRelease();
    const offered = await hostingOf(clientId);
    const switched = await place(clientId, newer);
    const offeredOnceSwitched = await hostingOf(clientId);
    await latestStopped(attempts);
    expect({
      offered: offered.suggestedReleaseId,
      offeredOnceSwitched: offeredOnceSwitched.suggestedReleaseId,
      switched,
      operation: await operationOf(clientId),
      switchedBy: await actorsOf(clientId, "provision.switch_release"),
      older: await place(clientId, releaseId),
      after: await operationOf(clientId),
    }).toMatchObject({
      offered: releaseId,
      offeredOnceSwitched: newer,
      switched: { refused: null },
      operation: {
        id: first?.id,
        releaseId: newer,
        status: "failed",
        error: "wfp_schedule_unqualified",
      },
      switchedBy: [caller],
      older: { refused: null },
      after: { releaseId },
    });
    await latestStopped(attempts);
  });

  it("says an operation left running with no attempt at all is gone, for staff to resume", async () => {
    const clientId = await client();
    const releaseId = await importedRelease();
    using attempts = followAttempts();
    await place(clientId, releaseId);
    await latestStopped(attempts);
    // Running, as an attempt that never recorded its end leaves it, and
    // no runner holds it any more.
    await db
      .update(clientProvisions)
      .set({ status: "running", error: null })
      .where(eq(clientProvisions.clientId, clientId));
    await db.delete(clientRuns).where(eq(clientRuns.clientId, clientId));

    const view = await hostingOf(clientId);
    const { html } = await page(`/organizations/${clientId}/setup`, caller);

    expect({
      run: view.run,
      going: view.going,
      said: html.includes("run_gone"),
      words: html.includes("Its attempt is gone, or never started"),
    }).toStrictEqual({ run: "gone", going: false, said: true, words: true });
  });

  it("discards nothing of a client that went live between the check and the discard, and audits no discard", async () => {
    const clientId = await client();
    await db.insert(clientAdminReads).values({ clientId, askedAt: new Date() });
    // The client goes live just before the discard's batch runs.
    const racing = new Proxy(env.DB, {
      get: (target, name): unknown => {
        if (name === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await target
              .prepare("UPDATE clients SET status = 'active' WHERE id = ?")
              .bind(clientId)
              .run();
            return await target.batch(statements);
          };
        }
        const value: unknown = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const refusal = await discardClient(
      { ...env, DB: racing },
      staff,
      clientId
    ).then(
      () => null,
      (error: unknown) =>
        error instanceof DiscardError ? error.code : "thrown"
    );

    expect({
      refusal,
      client: await db
        .select({ status: clients.status })
        .from(clients)
        .where(eq(clients.id, clientId))
        .get(),
      reads: await db
        .select({ clientId: clientAdminReads.clientId })
        .from(clientAdminReads)
        .where(eq(clientAdminReads.clientId, clientId)),
      audited: await actorsOf(clientId, "client.discard"),
    }).toStrictEqual({
      refusal: "not_provisioning",
      client: { status: "active" },
      reads: [{ clientId }],
      audited: [],
    });
  });

  it("discards a client never placed, audited, freeing its id, and refuses one placed, unknown or being worked on", async () => {
    const shared = await destination();
    const mistaken = await client();
    await db
      .insert(clientAdminReads)
      .values({ clientId: mistaken, askedAt: new Date() });
    const placed = await client();
    await placeClient(db, staff, {
      clientId: placed,
      destinationId: shared,
    });
    const busy = await client();
    await claimRun(
      db,
      staff,
      busy,
      null,
      { action: "client.provision_placed", clientId: busy },
      { kind: "provision_placed", runId: `${busy}-p1` }
    );
    const discard = async (clientId: string) =>
      await callServerFn(discardClientFn, { clientId }, { email: caller });

    const discarded = await discard(mistaken);
    const left = {
      client: await db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.id, mistaken)),
      reads: await db
        .select({ clientId: clientAdminReads.clientId })
        .from(clientAdminReads)
        .where(eq(clientAdminReads.clientId, mistaken)),
    };

    expect({
      discarded,
      left,
      discardedBy: await actorsOf(mistaken, "client.discard"),
      placed: await discard(placed),
      unknown: await discard("nobody-here"),
      busy: await discard(busy),
      kept: await placementOf(placed),
    }).toStrictEqual({
      discarded: { refused: null },
      left: { client: [], reads: [] },
      discardedBy: [caller],
      placed: { refused: "placed" },
      unknown: { refused: "client_unknown" },
      busy: { refused: "client_busy" },
      kept: { destinationId: shared },
    });

    // Its id is free for the next client.
    const now = new Date();
    await expect(
      db.insert(clients).values({
        id: mistaken,
        name: mistaken,
        createdAt: now,
        updatedAt: now,
      })
    ).resolves.toBeDefined();
  });

  it("refuses anyone Access doesn't vouch for, placing and reading nothing", async () => {
    const clientId = await client();
    const releaseId = await importedRelease();

    await expect(place(clientId, releaseId, null)).rejects.toThrow(
      "The server function answered 403"
    );
    await expect(
      callServerFn(fetchClientHosting, { clientId }, { email: null })
    ).rejects.toThrow("The server function answered 403");
    await expect(
      callServerFn(
        placeAndProvisionFn,
        { clientId },
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

  it("offers staff to pin a live placed client to a release, and refuses pinning to anyone Access doesn't vouch for", async () => {
    const destinationId = await destination();
    const clientId = await client();
    const later = await importedRelease();
    await placeClient(db, staff, { clientId, destinationId });
    await db
      .update(clients)
      .set({ status: "active" })
      .where(eq(clients.id, clientId));

    const { status, html } = await page(
      `/organizations/${clientId}/setup?tab=releases`,
      caller
    );
    const refused = await callServerFn(
      pinClientFn,
      { clientId, releaseId: later },
      { email: null }
    ).then(() => "answered", String);
    const pinned = await db
      .select({ pinnedReleaseId: clients.pinnedReleaseId })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();

    expect({
      status,
      offer: html.includes("Pin it to"),
      refused: refused.includes("answered 403"),
      pinned,
    }).toStrictEqual({
      status: 200,
      offer: true,
      refused: true,
      pinned: { pinnedReleaseId: null },
    });
  });

  it("offers to offboard a placed client, then to delete its resources with no export confirmed, and refuses both to anyone Access doesn't vouch for", async () => {
    const destinationId = await destination();
    const clientId = await client();
    await placeClient(db, staff, { clientId, destinationId });
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
    // Offboarded, its page says so and nothing more, pointing to Platform's
    // Offboarded page, where its deletion is.
    const gone = await page(`/organizations/${clientId}/setup`, caller);
    const after = await page("/platform/offboarded", caller);
    const listed = offboardedOf(after.html, clientId);

    expect({
      offer: live.html.includes("Offboard it"),
      refused: refused.map((answer) => answer.includes("answered 403")),
      offboarded,
      early,
      gone: {
        status: gone.status,
        said: gone.html.includes("was offboarded"),
        toOffboarded: gone.html.includes('href="/platform/offboarded"'),
        offer: gone.html.includes("Offboard it"),
      },
      // Offered, but off until its retention is over, saying from when.
      deleteOff: buttonOff(listed, "Delete its resources"),
      confirm: confirmOff(listed),
      from: listed.includes("It can be deleted from"),
      kept: listed !== "",
    }).toStrictEqual({
      offer: true,
      refused: [true, true],
      offboarded: { refused: null, deletion: null },
      early: { refused: "retention_running", deletion: null },
      gone: { status: 200, said: true, toOffboarded: true, offer: false },
      deleteOff: true,
      confirm: true,
      from: true,
      kept: true,
    });
  });

  it("lists every offboarded client, however many there are", async () => {
    const destinationId = await destination();
    const offboardedAt = new Date(Date.now() - 86_400_000);
    // More than D1 binds in one statement (100).
    const ids = await Promise.all(
      Array.from({ length: 101 }, async () => {
        const clientId = await client();
        await placeClient(db, staff, { clientId, destinationId });
        await db
          .update(clients)
          .set({ status: "offboarded", offboardedAt })
          .where(eq(clients.id, clientId));
        return clientId;
      })
    );

    const { status, html } = await page("/platform/offboarded", caller);

    expect({
      status,
      listed: ids.filter((id) => offboardedOf(html, id) !== "").length,
    }).toStrictEqual({ status: 200, listed: 101 });
  });

  it("offers deleting an offboarded client's resources once its retention is over, and says on every read which bucket is still emptying", async () => {
    const destinationId = await destination();
    const clientId = await client();
    await placeClient(db, staff, { clientId, destinationId });
    await allocateClientResources(db, staff, {
      clientId,
      manifest: await release(),
      operationId: "op",
    });
    const offboardedAt = new Date(Date.now() - 31 * 86_400_000);
    await db
      .update(clients)
      .set({ status: "offboarded", offboardedAt })
      .where(eq(clients.id, clientId));
    const [bucket] = await db
      .select({
        role: clientResources.role,
        name: clientResources.physicalName,
      })
      .from(clientResources)
      .where(
        and(
          eq(clientResources.clientId, clientId),
          eq(clientResources.kind, "r2_bucket")
        )
      );
    if (bucket === undefined) {
      throw new Error("The release has no bucket");
    }
    // As a deletion that found it holding objects records it, two hours ago.
    const emptiedAt = new Date(Date.now() - 2 * 3_600_000);
    await db.insert(auditEvents).values({
      id: crypto.randomUUID(),
      at: emptiedAt,
      actor: caller,
      action: "client.empty_bucket",
      clientId,
      target: destinationId,
      detail: JSON.stringify({ role: bucket.role, physicalName: bucket.name }),
    });

    const whileEmptying = await page("/platform/offboarded", caller);
    const emptying = offboardedOf(whileEmptying.html, clientId);
    // Its objects expired, and a later deletion deleted it.
    await db
      .update(clientResources)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(clientResources.clientId, clientId),
          eq(clientResources.role, bucket.role)
        )
      );
    const onceDeleted = await page("/platform/offboarded", caller);
    const deleted = offboardedOf(onceDeleted.html, clientId);
    const note = `${bucket.name} still held objects`;

    expect({
      // Its button waits only for staff to confirm no export was made.
      confirm: confirmOff(emptying),
      waits: emptying.includes("It can be deleted from"),
      emptying: emptying.includes(note),
      deleted: deleted.includes(note),
    }).toStrictEqual({
      confirm: false,
      waits: false,
      emptying: true,
      deleted: false,
    });
  });
});

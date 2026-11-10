import { moduleKey } from "@grasp-os/shared/release";
import { routerHostKey } from "@grasp-os/shared/router";
import { env } from "cloudflare:workers";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  auditEvents,
  clientProvisions,
  clientResources,
  clients,
} from "../src/db/schema.ts";
import { mappedRoute } from "../src/deploy/router.ts";
import { clientInventory } from "../src/hosting/inventory.ts";
import {
  deletePlacedClient,
  offboardPlacedClient,
} from "../src/hosting/offboarding.ts";
import {
  runClientProvision,
  startClientRelease,
} from "../src/hosting/operation.ts";
import {
  token,
  cloudflare,
  domain,
  context,
  importRelease,
  setUp,
  operationOf,
  failing,
  appliedMigrations,
  resourceOf,
  scriptsOf,
  holdings,
  holdingsOf,
  isUpload,
  liveClient,
  attempt,
  runs,
  codeOf,
  offboardedDaysAgo,
} from "./client-provision-harness.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { clientScripts } from "./grasp-account.ts";
import { db, staff } from "./hosting.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Here: releasing a live client, rolling it back, and offboarding it; the
// rest in the other client-provision-*.test.ts files.

mockCloudflareApi(token, cloudflare);

describe("provisioning a placed client", () => {
  useStoreSecrets({ deployer: token });

  it("releases a live client to a later release on its stable scripts, migrating its databases and probing it before it's done", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    const scripts = await scriptsOf(clientId);
    const uploadsBefore = account.scriptUploads.length;
    const later = await importRelease({
      notes: "feat(core): later",
      migrations: {
        "0000_init.sql": "CREATE TABLE a (id TEXT);",
        "0001_more.sql": "CREATE TABLE b (id TEXT);",
      },
    });

    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: later.releaseId,
    });
    await runClientProvision(context, await attempt(clientId));

    expect({
      operation: await operationOf(clientId),
      runs: await runs(clientId),
      // The same two scripts, each uploaded once more: connect, then core.
      uploads: account.scriptUploads
        .slice(uploadsBefore)
        .map(({ script }) => script),
      scripts: holdings(account).scripts,
      applied: Object.values(await appliedMigrations(account)).some(
        (names) => names.join(",") === "0000_init.sql,0001_more.sql"
      ),
      route: await mappedRoute(env.ROUTER_HOSTS, `${clientId}.${domain}`),
    }).toMatchObject({
      operation: {
        releaseId: later.releaseId,
        previousReleaseId: first.releaseId,
        status: "done",
        error: null,
      },
      runs: { core: later.releaseId, connect: later.releaseId },
      uploads: [scripts.connect, scripts.core],
      scripts: [scripts.connect, scripts.core].toSorted(),
      applied: true,
      route: { clientId, generation: 1 },
    });
  });

  it("rolls a live client back to the release it ran before, and refuses past a Durable Object migration or with nothing before", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    const nothing = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), { rollback: true })
    );
    const second = await importRelease({
      notes: "feat(core): second",
    });
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: second.releaseId,
    });
    await runClientProvision(context, await attempt(clientId));

    await startClientRelease(db, staff, await attempt(clientId), {
      rollback: true,
    });
    await runClientProvision(context, await attempt(clientId));
    const back = {
      operation: await operationOf(clientId),
      runs: await runs(clientId),
    };

    // A release that adds a Durable Object migration can't be rolled back.
    const third = await importRelease(
      { notes: "feat(core): new class" },
      (core) => ({
        ...core,
        durableObjectMigrations: [
          ...core.durableObjectMigrations,
          { tag: "v2", new_sqlite_classes: ["Extra"] },
        ],
      })
    );
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: third.releaseId,
    });
    await runClientProvision(context, await attempt(clientId));
    const past = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), { rollback: true })
    );
    // Nor released to an older one without it, before anything uploads.
    const uploads = account.scriptUploads.length;
    const behind = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), {
        releaseId: second.releaseId,
      })
    );

    expect({
      nothing,
      back,
      past,
      behind,
      uploaded: account.scriptUploads.length - uploads,
    }).toMatchObject({
      nothing: "nothing_to_roll_back",
      back: {
        operation: {
          releaseId: first.releaseId,
          previousReleaseId: second.releaseId,
          status: "done",
        },
        runs: { core: first.releaseId, connect: first.releaseId },
      },
      past: "rollback_past_migration",
      behind: "release_behind_migration",
      uploaded: 0,
    });
  });

  it("rolls back a release that stopped before any script ran its new Durable Object migration", async () => {
    const first = await importRelease();
    const { clientId } = await liveClient(first);
    const { connect } = await scriptsOf(clientId);
    // Declares a new class; stops at connect's upload, before any script
    // ran the class's migration.
    const later = await importRelease(
      {
        notes: "feat(core): new class, new table",
        migrations: {
          "0000_init.sql": "CREATE TABLE a (id TEXT);",
          "0001_more.sql": "CREATE TABLE b (id TEXT);",
        },
      },
      (core) => ({
        ...core,
        durableObjectMigrations: [
          ...core.durableObjectMigrations,
          { tag: "v2", new_sqlite_classes: ["Extra"] },
        ],
      })
    );
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: later.releaseId,
    });
    cloudflare.failNext(isUpload(connect), 400);
    await failing(await attempt(clientId));

    const back = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), { rollback: true })
    );

    expect(back).toBe("started");
  });

  it("never lowers what a script ran on a stale read: an upload whose answer was lost still keeps a rollback from going back past its migration", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    const { core } = await scriptsOf(clientId);
    const later = await importRelease(
      { notes: "feat(core): new class", core: "export default { core: 9 };" },
      (entry) => ({
        ...entry,
        durableObjectMigrations: [
          ...entry.durableObjectMigrations,
          { tag: "v2", new_sqlite_classes: ["Extra"] },
        ],
      })
    );
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: later.releaseId,
    });
    // Core's upload runs its migration, and the answer never arrives.
    cloudflare.failNext(isUpload(core), "lost");
    await failing(await attempt(clientId));
    // An upload with no answer may still land: its mark keeps the next
    // attempt from sending until it ages out, as it has by now.
    await db
      .update(clientProvisions)
      .set({
        sending: sql`(SELECT json_group_object(key, json_set(value, '$.at', 0)) FROM json_each(${clientProvisions.sending}))`,
      })
      .where(eq(clientProvisions.clientId, clientId));
    // Resumed: core reads at the migration before, as a stale read would,
    // and the upload stops before it's sent (its module gone from the store).
    const script = clientScripts(account).get(core);
    if (script === undefined) {
      throw new Error("core isn't in the fake");
    }
    script.migrationTag = "v1";
    const [module] = later.workers.core?.modules ?? [];
    await env.RELEASES.delete(moduleKey(module?.sha256 ?? ""));
    await failing(await attempt(clientId));
    script.migrationTag = "v2";

    const back = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), { rollback: true })
    );

    expect(back).toBe("rollback_past_migration");
  });

  it("refuses a release of a client not live yet, and a start by a runner that lost the client, changing nothing; the holder takes an operation left running", async () => {
    const first = await importRelease();
    const pending = await setUp(first);
    const later = await importRelease({
      notes: "feat(core): later",
    });

    const notLive = await codeOf(
      startClientRelease(db, staff, await attempt(pending.clientId), {
        releaseId: later.releaseId,
      })
    );
    const { clientId } = await liveClient(first);
    // Two starts: the first claims, the second claims in its place; the
    // first, no longer holding the client, writes nothing.
    const lost = await attempt(clientId);
    const holder = await attempt(clientId);
    const lostStart = await codeOf(
      startClientRelease(db, staff, lost, { releaseId: later.releaseId })
    );
    const untouched = await operationOf(clientId);
    const started = await codeOf(
      startClientRelease(db, staff, holder, { releaseId: later.releaseId })
    );
    // Its runner ended, the release still running: the next holder takes
    // the client back to the release it ran, or resumes it.
    const takenBack = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), {
        releaseId: first.releaseId,
      })
    );
    const resumed = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), {
        releaseId: first.releaseId,
      })
    );

    expect({
      notLive,
      lostStart,
      untouched,
      started,
      takenBack,
      resumed,
      operation: await operationOf(clientId),
    }).toMatchObject({
      notLive: "client_not_active",
      lostStart: "operation_running",
      untouched: { releaseId: first.releaseId, status: "done" },
      started: "started",
      takenBack: "started",
      resumed: "started",
      operation: { releaseId: first.releaseId, status: "running" },
    });
  });

  it("resumes a release that stopped part way, leaving its hostname where it was until it passes its probe", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    const later = await importRelease({
      notes: "feat(core): later",
    });
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: later.releaseId,
    });
    // Core's upload is refused: connect runs the later release already.
    cloudflare.failNext(
      (call) => call.method === "PUT" && call.path.endsWith("-core"),
      400
    );
    await expect(failing(await attempt(clientId))).resolves.toMatchObject({
      status: 400,
    });
    const stopped = {
      operation: await operationOf(clientId),
      route: await mappedRoute(env.ROUTER_HOSTS, `${clientId}.${domain}`),
    };

    // Started again, it resumes: connect isn't uploaded twice.
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: later.releaseId,
    });
    const uploadsBefore = account.scriptUploads.length;
    await runClientProvision(context, await attempt(clientId));
    const { core } = await scriptsOf(clientId);

    expect({
      stopped,
      resumed: account.scriptUploads
        .slice(uploadsBefore)
        .map(({ script }) => script),
      operation: await operationOf(clientId),
    }).toMatchObject({
      stopped: {
        operation: {
          releaseId: later.releaseId,
          status: "failed",
          error: "cloudflare_400_10000",
        },
        route: { clientId, generation: 1 },
      },
      resumed: [core],
      operation: { releaseId: later.releaseId, status: "done" },
    });
  });

  it("rolls a release that fails its probe once live back to the release before on its own, audited, and records a rollback that fails too", async () => {
    const first = await importRelease();
    const { clientId } = await liveClient(first);
    const later = await importRelease({
      notes: "feat(core): broken once live",
    });
    const { connect } = await scriptsOf(clientId);
    // The release's core answers as another client; once the release's
    // connect went, the next upload of connect (the rollback's) finds core
    // answering as it should again.
    cloudflare.coreOf(clientId).coreProbe = { asClient: "someone-else" };
    // oxlint-disable require-await -- the fake waits on these; nothing to wait for
    cloudflare.beforeAnswering(isUpload(connect), async () => {
      cloudflare.beforeAnswering(isUpload(connect), async () => {
        delete cloudflare.coreOf(clientId).coreProbe;
      });
    });
    // oxlint-enable require-await

    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: later.releaseId,
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runClientProvision(context, await attempt(clientId));
    } finally {
      errors.mockRestore();
    }
    const [rolledBack] = await db
      .select({ actor: auditEvents.actor, detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "release.rollback")
        )
      );

    // A rollback that fails its probe too: thrown, and recorded on the
    // operation, where its Setup says so.
    const stuck = await liveClient(first);
    await startClientRelease(db, staff, await attempt(stuck.clientId), {
      releaseId: later.releaseId,
    });
    cloudflare.coreOf(stuck.clientId).coreProbe = { asClient: "someone-else" };
    const stuckErrors = vi.spyOn(console, "error").mockImplementation(() => {});
    const stuckError = await runClientProvision(
      context,
      await attempt(stuck.clientId)
    ).then(
      () => null,
      (error: unknown) => error
    );
    stuckErrors.mockRestore();

    expect({
      operation: await operationOf(clientId),
      runs: await runs(clientId),
      rolledBack: {
        actor: rolledBack?.actor,
        detail: z.unknown().parse(JSON.parse(rolledBack?.detail ?? "null")),
      },
      stuck: {
        error: stuckError,
        operation: await operationOf(stuck.clientId),
      },
    }).toMatchObject({
      operation: { releaseId: first.releaseId, status: "done" },
      runs: { core: first.releaseId, connect: first.releaseId },
      rolledBack: {
        actor: "system",
        detail: { from: later.releaseId, cause: "probe_identity_mismatch" },
      },
      stuck: {
        error: { code: "probe_identity_mismatch" },
        operation: { releaseId: first.releaseId, status: "failed" },
      },
    });
  });

  // Offboarding, then deleting its resources (src/hosting/offboarding.ts):
  // the threat model is in its header.

  it("offboards a live client at once, unrouting it and deleting nothing, and no later release routes it again", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    const before = holdings(account);
    const later = await importRelease({
      notes: "feat(core): later",
    });

    await offboardPlacedClient(env, staff, clientId);
    // Again: it's offboarded already, and its hostname stays out.
    await offboardPlacedClient(env, staff, clientId);
    const refused = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), {
        releaseId: later.releaseId,
      })
    );
    const client = await db
      .select({ status: clients.status, offboardedAt: clients.offboardedAt })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();

    expect({
      status: client?.status,
      offboarded: client?.offboardedAt instanceof Date,
      route: await mappedRoute(env.ROUTER_HOSTS, `${clientId}.${domain}`),
      holdings: holdings(account),
      refused,
    }).toStrictEqual({
      status: "offboarded",
      offboarded: true,
      route: null,
      holdings: before,
      refused: "client_not_active",
    });
  });

  it("deletes an offboarded client's resources only after its retention, with staff confirming no export, and only its own", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    const other = await liveClient(first);
    const others = await holdingsOf(other.account, other.clientId);
    await offboardPlacedClient(env, staff, clientId);

    const early = await codeOf(
      deletePlacedClient(env, staff, clientId, { exportConfirmed: true })
    );
    await offboardedDaysAgo(clientId, 31);
    const unconfirmed = await codeOf(
      deletePlacedClient(env, staff, clientId, { exportConfirmed: false })
    );
    const live = await codeOf(
      deletePlacedClient(env, staff, other.clientId, { exportConfirmed: true })
    );
    const kept = await holdingsOf(account, clientId);
    const deletion = await deletePlacedClient(env, staff, clientId, {
      exportConfirmed: true,
    });
    const inventory = await clientInventory(db, clientId);
    const events = await db
      .select({ action: auditEvents.action, detail: auditEvents.detail })
      .from(auditEvents)
      .where(eq(auditEvents.clientId, clientId));
    const deletedEvents = events.filter(
      ({ action }) => action === "client.delete_resource"
    );
    const summary = events.find(
      ({ action }) => action === "client.delete_resources"
    );

    expect({
      early,
      unconfirmed,
      live,
      kept: kept.d1.length > 0 && kept.scripts.length > 0,
      deletion: deletion.emptying,
      gone: await holdingsOf(account, clientId),
      recorded: inventory.every((row) => row.deletedAt !== null),
      // Each resource audited as it went, then the whole, with what staff
      // confirmed.
      audited: deletedEvents.length,
      summary: z.unknown().parse(JSON.parse(summary?.detail ?? "null")),
      others: await holdingsOf(other.account, other.clientId),
    }).toMatchObject({
      early: "retention_running",
      unconfirmed: "export_unconfirmed",
      live: "not_offboarded",
      kept: true,
      deletion: [],
      gone: { d1: [], buckets: [], scripts: [] },
      recorded: true,
      audited: inventory.length,
      summary: { deleted: inventory.length, exportConfirmed: true },
      others,
    });
  });

  it("empties a bucket that still holds objects and deletes it on a later run, and keeps a database whose name another id has", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    await offboardPlacedClient(env, staff, clientId);
    await offboardedDaysAgo(clientId, 31);
    const files = await resourceOf(clientId, "r2:grasp-os-files");
    account.fullBuckets.add(files.physicalName);

    const firstRun = await deletePlacedClient(env, staff, clientId, {
      exportConfirmed: true,
    });
    const [emptied] = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "client.empty_bucket")
        )
      );
    const emptying = {
      emptying: firstRun.emptying,
      rule: account.lifecycles.has(files.physicalName),
      kept: account.buckets.some(({ name }) => name === files.physicalName),
      audited: z.unknown().parse(JSON.parse(emptied?.detail ?? "null")),
    };
    // Its objects expired since: the next run deletes it.
    account.fullBuckets.delete(files.physicalName);
    const secondRun = await deletePlacedClient(env, staff, clientId, {
      exportConfirmed: true,
    });

    // Another client's database under the recorded name: kept.
    const next = await liveClient(first);
    await offboardPlacedClient(env, staff, next.clientId);
    await offboardedDaysAgo(next.clientId, 31);
    const database = await resourceOf(next.clientId, "d1:grasp-os-core");
    const swapped = next.account.d1.find(
      ({ uuid }) => uuid === database.providerId
    );
    if (swapped !== undefined) {
      swapped.uuid = crypto.randomUUID();
    }
    const before = await holdingsOf(next.account, next.clientId);
    const notOwned = await codeOf(
      deletePlacedClient(env, staff, next.clientId, { exportConfirmed: true })
    );
    const left = await holdingsOf(account, clientId);

    expect({
      emptying,
      second: secondRun.emptying,
      bucketGone: left.buckets.length,
      notOwned,
      // Refused before anything went: its scripts and their objects too.
      untouched: await holdingsOf(next.account, next.clientId),
    }).toStrictEqual({
      emptying: {
        emptying: [files.physicalName],
        rule: true,
        kept: true,
        audited: { role: files.role, physicalName: files.physicalName },
      },
      second: [],
      bucketGone: 0,
      notOwned: "resource_not_owned",
      untouched: before,
    });
  });

  it("refuses deleting a row not named for its deployment, or a database whose id was never recorded, before anything goes", async () => {
    const first = await importRelease();
    const misnamed = await liveClient(first);
    const unrecorded = await liveClient(first);
    for (const { clientId } of [misnamed, unrecorded]) {
      // oxlint-disable-next-line no-await-in-loop -- two, in order
      await offboardPlacedClient(env, staff, clientId);
      // oxlint-disable-next-line no-await-in-loop -- two, in order
      await offboardedDaysAgo(clientId, 31);
    }
    const files = await resourceOf(misnamed.clientId, "r2:grasp-os-files");
    await db
      .update(clientResources)
      .set({ physicalName: "gsomeone-else-files" })
      .where(
        and(
          eq(clientResources.clientId, misnamed.clientId),
          eq(clientResources.role, files.role)
        )
      );
    await db
      .update(clientResources)
      .set({ providerId: null })
      .where(
        and(
          eq(clientResources.clientId, unrecorded.clientId),
          eq(clientResources.role, "d1:grasp-os-core")
        )
      );
    const before = {
      misnamed: await holdingsOf(misnamed.account, misnamed.clientId),
      unrecorded: await holdingsOf(unrecorded.account, unrecorded.clientId),
    };

    const refused = {
      misnamed: await codeOf(
        deletePlacedClient(env, staff, misnamed.clientId, {
          exportConfirmed: true,
        })
      ),
      unrecorded: await codeOf(
        deletePlacedClient(env, staff, unrecorded.clientId, {
          exportConfirmed: true,
        })
      ),
    };

    expect({
      refused,
      untouched: {
        misnamed: await holdingsOf(misnamed.account, misnamed.clientId),
        unrecorded: await holdingsOf(unrecorded.account, unrecorded.clientId),
      },
    }).toStrictEqual({
      refused: {
        misnamed: "resource_not_owned",
        unrecorded: "resource_not_owned",
      },
      untouched: before,
    });
  });

  it("refuses offboarding with no client domain set, or a hostname the router gives another client, and leaves the route", async () => {
    const first = await importRelease();
    const { clientId } = await liveClient(first);
    const other = await liveClient(first);
    const hostname = `${clientId}.${domain}`;

    const unconfigured = await codeOf(
      offboardPlacedClient({ ...env, CLIENT_DOMAIN: "" }, staff, clientId)
    );
    const status = await db
      .select({ status: clients.status })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();
    // The map gives its hostname the other client's entry.
    const otherEntry = await env.ROUTER_HOSTS.get(
      routerHostKey(`${other.clientId}.${domain}`)
    );
    await env.ROUTER_HOSTS.put(routerHostKey(hostname), otherEntry ?? "");
    const notOurs = await codeOf(offboardPlacedClient(env, staff, clientId));

    expect({
      unconfigured,
      status: status?.status,
      notOurs,
      route: await mappedRoute(env.ROUTER_HOSTS, hostname),
    }).toMatchObject({
      unconfigured: "routing_unconfigured",
      status: "active",
      notOurs: "hostname_not_ours",
      route: { clientId: other.clientId },
    });
  });
});

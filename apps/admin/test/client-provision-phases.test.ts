import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { auditEvents, clientProvisions, clients } from "../src/db/schema.ts";
import { rotateClientSecrets } from "../src/deploy/rotation.ts";
import { mappedRoute } from "../src/deploy/router.ts";
import {
  operationPhases,
  runClientProvision,
  runOperationPhase,
  startClientRelease,
} from "../src/hosting/operation.ts";
import {
  appliedMigrations,
  attempt,
  cloudflare,
  context,
  domain,
  failing,
  importRelease,
  isMigration,
  isUpload,
  liveClient,
  operationOf,
  routed,
  runs,
  scriptsOf,
  setUp,
  token,
} from "./client-provision-harness.ts";
import type { ApiCall } from "./cloudflare-api-kit.ts";
import { envelope } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, staff } from "./hosting.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// The operation's phases one at a time (src/hosting/operation.ts,
// `runOperationPhase`), the restore point it keeps before migrating, and
// the probe's checks of the release, the schema and the static files.
// How they can fail, each tried below:
// - a phase run again after it landed (its result lost) doing its work
//   twice: a second bookmark, a migration sent again, an upload again;
// - a phase run before the one it follows: code uploaded onto a schema
//   not migrated, or a hostname routed to a core never probed;
// - a migration run without a restore point, when the bookmark call
//   fails or Cloudflare gives none;
// - a bookmark taken where there is nothing to keep (a first deploy);
// - a core that answers another release, a database behind the release,
//   or Cloudflare's stub for static files, published or kept live;
// - a core from before the probe named its release and schema refused;
// - a rotation landing between the upload and the route: the probe and
//   the router's map taking the new generation core doesn't have;
// - a resumed release going past a Durable Object migration observed
//   since it started.

mockCloudflareApi(token, cloudflare);

/** Each call for a database's Time Travel bookmark. */
const bookmarkCalls = (): ApiCall[] =>
  cloudflare.calls.filter(({ path }) => path.endsWith("/time_travel/bookmark"));

/** The migrations sent of `name`, each with its record. */
const sentOf = (name: string): number =>
  cloudflare.calls.filter(
    (call) => isMigration(call) && JSON.stringify(call.body).includes(name)
  ).length;

/** Core's migrations on release A, and on B, which adds one. */
const onA = { "0000_init.sql": "CREATE TABLE a (id TEXT);" };
const onB = { ...onA, "0001_more.sql": "CREATE TABLE b (id TEXT);" };

/** The restore points the operation of client `clientId` keeps, by database. */
const bookmarksOf = async (clientId: string) => {
  const operation = await operationOf(clientId);
  return z
    .object({
      bookmarks: z
        .record(
          z.string(),
          z.object({
            bookmark: z.string(),
            change: z.number(),
            release: z.string(),
          })
        )
        .default({}),
    })
    .loose()
    .parse(JSON.parse(operation?.progress ?? "{}")).bookmarks;
};

/** A live client on A, and B imported: a new migration, and new code for both Workers. */
const liveOnA = async () => {
  const a = await importRelease({ migrations: onA });
  const set = await liveClient(a);
  const b = await importRelease({
    notes: "feat(core): b",
    core: "export default { core: 'b' };",
    connect: "export default { connect: 'b' };",
    migrations: onB,
  });
  return { ...set, a, b };
};

describe("an operation's phases, its restore point and its probe", () => {
  useStoreSecrets({ deployer: token });

  it("keeps a restore point of the database a release migrates before migrating it, and none on a first deploy", async () => {
    const { clientId, b } = await liveOnA();
    const provisioned = bookmarkCalls().length;
    const firstPoints = await bookmarksOf(clientId);
    const held = await attempt(clientId);
    const { change } = await startClientRelease(db, staff, held, {
      releaseId: b.releaseId,
    });
    await runClientProvision(context, held);
    const [snapshotted] = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "provision.snapshot"),
          eq(auditEvents.target, b.releaseId)
        )
      );
    const points = await bookmarksOf(clientId);
    const bookmark = points["grasp-os-core"]?.bookmark;
    const bookmarkAt = cloudflare.calls.findIndex(({ path }) =>
      path.endsWith("/time_travel/bookmark")
    );
    const migratedAt = cloudflare.calls.findIndex(
      (call) =>
        isMigration(call) && JSON.stringify(call.body).includes("0001_more")
    );

    expect({
      // Provisioning found every database new: nothing to keep.
      provisioned,
      firstPoints,
      // Connect's database has nothing new: only core's is kept.
      points,
      audited: z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(snapshotted?.detail ?? "{}")),
      beforeMigrating: bookmarkAt !== -1 && bookmarkAt < migratedAt,
      operation: await operationOf(clientId),
    }).toMatchObject({
      provisioned: 0,
      firstPoints: {},
      points: {
        "grasp-os-core": { bookmark, change, release: b.releaseId },
      },
      audited: { bookmarks: 1, "bookmark:grasp-os-core": bookmark },
      beforeMigrating: true,
      operation: { status: "done", releaseId: b.releaseId },
    });
    expect({
      databases: Object.keys(points),
      bookmark: typeof bookmark === "string" && bookmark.length > 0,
    }).toStrictEqual({ databases: ["grasp-os-core"], bookmark: true });
  });

  it.each([
    {
      name: "the bookmark call is refused",
      code: "cloudflare_400_10000",
      fail: () => {
        cloudflare.failNext(
          ({ path }) => path.endsWith("/time_travel/bookmark"),
          400
        );
        return () => {
          /* the failure is spent */
        };
      },
    },
    {
      name: "Cloudflare answers no bookmark",
      code: "snapshot_unavailable",
      fail: () => {
        const answers = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input, init) =>
            new Request(input, init).url.endsWith("/time_travel/bookmark")
              ? envelope({})
              : await cloudflare.fetch(input, init)
          );
        return () => {
          // Back to the fake as it answers every call.
          answers.mockImplementation(cloudflare.fetch);
        };
      },
    },
  ])(
    "migrates nothing when $name, leaving the client live as it was, and migrates once a bookmark is kept",
    async ({ code, fail }) => {
      const { account, clientId, a, b } = await liveOnA();
      const held = await attempt(clientId);
      await startClientRelease(db, staff, held, { releaseId: b.releaseId });
      const restore = fail();
      await failing(held);
      restore();
      const whileStopped = {
        operation: await operationOf(clientId),
        sent: sentOf("0001_more"),
        applied: await appliedMigrations(account),
        runs: await runs(clientId),
        routed: await routed(clientId),
      };
      await runClientProvision(context, held);

      expect({
        whileStopped,
        after: {
          applied: await appliedMigrations(account),
          runs: await runs(clientId),
        },
      }).toMatchObject({
        whileStopped: {
          // It stopped at the restore point, past its resources.
          operation: { status: "failed", step: "resources", error: code },
          sent: 0,
          runs: { core: a.releaseId, connect: a.releaseId },
          routed: true,
        },
        after: {
          runs: { core: b.releaseId, connect: b.releaseId },
        },
      });
      expect(Object.values(whileStopped.applied)).toContainEqual([
        "0000_init.sql",
      ]);
      expect(Object.values(await appliedMigrations(account))).toContainEqual([
        "0000_init.sql",
        "0001_more.sql",
      ]);
    }
  );

  it("runs each phase alone, and again after it landed as a retry whose result was lost would, doing nothing twice", async () => {
    const { clientId, b } = await liveOnA();
    const { core, connect } = await scriptsOf(clientId);
    const held = await attempt(clientId);
    await startClientRelease(db, staff, held, { releaseId: b.releaseId });
    const uploads = () => ({
      core: cloudflare.calls.filter(isUpload(core)).length,
      connect: cloudflare.calls.filter(isUpload(connect)).length,
    });
    const before = { bookmarks: bookmarkCalls().length, uploads: uploads() };
    const outcomes: unknown[] = [];
    for (const phase of operationPhases) {
      // oxlint-disable no-await-in-loop -- each phase, then itself again
      outcomes.push(
        await runOperationPhase(context, held, phase),
        await runOperationPhase(context, held, phase)
      );
      // oxlint-enable no-await-in-loop
    }

    // Each run of the snapshot step names the restore point kept for the
    // change, the one after an earlier run's too.
    const snapshots = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "provision.snapshot"),
          eq(auditEvents.target, b.releaseId)
        )
      );
    const named = snapshots.map(
      ({ detail }) =>
        z
          .object({ bookmarks: z.number() })
          .loose()
          .parse(JSON.parse(detail ?? "{}")).bookmarks
    );

    expect({
      outcomes,
      named,
      bookmarks: bookmarkCalls().length - before.bookmarks,
      sent: sentOf("0001_more"),
      uploads: {
        core: uploads().core - before.uploads.core,
        connect: uploads().connect - before.uploads.connect,
      },
      operation: await operationOf(clientId),
      runs: await runs(clientId),
      routed: await routed(clientId),
    }).toMatchObject({
      outcomes: operationPhases.flatMap(() => [undefined, undefined]),
      named: [1, 1],
      bookmarks: 1,
      sent: 1,
      uploads: { core: 1, connect: 1 },
      operation: { status: "done", releaseId: b.releaseId },
      runs: { core: b.releaseId, connect: b.releaseId },
      routed: true,
    });
  });

  it("runs a phase again after its effect landed and its answer was lost: a migration, and the router's write", async () => {
    const { clientId, b } = await liveOnA();
    const held = await attempt(clientId);
    await startClientRelease(db, staff, held, { releaseId: b.releaseId });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcomes: Record<string, unknown> = {};
    try {
      for (const phase of ["preflight", "snapshot"] as const) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        await runOperationPhase(context, held, phase);
      }
      // The migration lands; its answer never arrives.
      cloudflare.failNext(
        (call) =>
          isMigration(call) && JSON.stringify(call.body).includes("0001_more"),
        "lost"
      );
      outcomes.migrateLost = await runOperationPhase(context, held, "migrate");
      outcomes.migrate = await runOperationPhase(context, held, "migrate");
      for (const phase of ["install", "probe"] as const) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        outcomes[phase] = await runOperationPhase(context, held, phase);
      }
      // The router's map takes the write; the runner dies before it reads
      // it back.
      const put = env.ROUTER_HOSTS.put.bind(env.ROUTER_HOSTS);
      const lost = vi
        .spyOn(env.ROUTER_HOSTS, "put")
        .mockImplementationOnce(async (key, value) => {
          await put(key, value);
          throw new Error("the runner died");
        });
      outcomes.routeLost = await runOperationPhase(context, held, "route");
      lost.mockRestore();
      outcomes.route = await runOperationPhase(context, held, "route");
      outcomes.record = await runOperationPhase(context, held, "record");
    } finally {
      errors.mockRestore();
    }

    expect({
      outcomes,
      sent: sentOf("0001_more"),
      operation: await operationOf(clientId),
      route: await mappedRoute(env.ROUTER_HOSTS, `${clientId}.${domain}`),
    }).toMatchObject({
      outcomes: {
        migrateLost: { step: "migrations", code: "cloudflare_0" },
        migrate: undefined,
        install: undefined,
        probe: undefined,
        routeLost: { step: "route", code: "unexpected" },
        route: undefined,
        record: undefined,
      },
      // Read as recorded, never sent again.
      sent: 1,
      operation: { status: "done", releaseId: b.releaseId },
      route: { clientId },
    });
  });

  it("refuses a phase whose phase before hasn't finished in this change, uploading and routing nothing", async () => {
    const { clientId, a, b } = await liveOnA();
    const { core, connect } = await scriptsOf(clientId);
    const held = await attempt(clientId);
    const routeBefore = await mappedRoute(
      env.ROUTER_HOSTS,
      `${clientId}.${domain}`
    );
    await startClientRelease(db, staff, held, { releaseId: b.releaseId });
    const uploaded = () =>
      cloudflare.calls.filter(
        (call) => isUpload(core)(call) || isUpload(connect)(call)
      ).length;
    const uploadsBefore = uploaded();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused: Record<string, unknown> = {};
    try {
      // Nothing of the change ran yet.
      refused.install = await runOperationPhase(context, held, "install");
      refused.route = await runOperationPhase(context, held, "route");
      // Migrated, but never installed nor probed.
      for (const phase of ["preflight", "snapshot", "migrate"] as const) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        await runOperationPhase(context, held, phase);
      }
      refused.routeUnprobed = await runOperationPhase(context, held, "route");
      refused.record = await runOperationPhase(context, held, "record");
    } finally {
      errors.mockRestore();
    }
    const whileRefused = {
      uploads: uploaded() - uploadsBefore,
      route: await mappedRoute(env.ROUTER_HOSTS, `${clientId}.${domain}`),
      runs: await runs(clientId),
    };
    await runClientProvision(context, held);

    const outOfOrder = { code: "phase_out_of_order" };
    expect({
      refused,
      whileRefused,
      runs: await runs(clientId),
    }).toMatchObject({
      refused: {
        install: { step: "connect", ...outOfOrder },
        route: { step: "route", ...outOfOrder },
        routeUnprobed: outOfOrder,
        record: outOfOrder,
      },
      whileRefused: {
        uploads: 0,
        route: routeBefore,
        runs: { core: a.releaseId, connect: a.releaseId },
      },
      runs: { core: b.releaseId, connect: b.releaseId },
    });
  });

  it("holds the probe, the route and the record to the generation core went live with, when a rotation lands after its upload", async () => {
    const { clientId, b } = await liveOnA();
    const held = await attempt(clientId);
    await startClientRelease(db, staff, held, { releaseId: b.releaseId });
    const outcomes: unknown[] = [];
    for (const phase of [
      "preflight",
      "snapshot",
      "migrate",
      "install",
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      outcomes.push(await runOperationPhase(context, held, phase));
    }
    // Staff rotate the client's secrets once core went live: nothing
    // refuses a claimed client.
    const rotated = await rotateClientSecrets(db, staff, clientId, new Date());
    for (const phase of ["probe", "route", "record"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      outcomes.push(await runOperationPhase(context, held, phase));
    }
    const client = await db
      .select({
        generation: clients.generation,
        rotationLiveAt: clients.rotationLiveAt,
      })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();

    expect({
      rotated,
      outcomes: {
        phases: outcomes.length,
        passed: outcomes.filter((outcome) => outcome === undefined).length,
      },
      route: await mappedRoute(env.ROUTER_HOSTS, `${clientId}.${domain}`),
      // The rotation waits for the next change, its window not started.
      client,
      operation: await operationOf(clientId),
    }).toMatchObject({
      rotated: true,
      outcomes: { phases: 7, passed: 7 },
      route: { clientId, generation: 1 },
      client: { generation: 2, rotationLiveAt: null },
      operation: { status: "done", releaseId: b.releaseId },
    });
  });

  it("refuses a resumed release at its first step once a script was observed at a Durable Object migration the release lacks", async () => {
    const { clientId, a, b } = await liveOnA();
    const { core, connect } = await scriptsOf(clientId);
    const held = await attempt(clientId);
    await startClientRelease(db, staff, held, { releaseId: b.releaseId });
    // Since it started, core's script was observed at a later release's
    // migration, as an upload counted as run records it.
    const operation = await operationOf(clientId);
    const progress = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(operation?.progress ?? "{}"));
    await db
      .update(clientProvisions)
      .set({
        progress: JSON.stringify({ ...progress, migrated: { core: "v9" } }),
      })
      .where(eq(clientProvisions.clientId, clientId));
    const uploads = () =>
      cloudflare.calls.filter(
        (call) => isUpload(core)(call) || isUpload(connect)(call)
      ).length;
    const before = { uploads: uploads(), sent: sentOf("0001_more") };
    await failing(held);

    expect({
      operation: await operationOf(clientId),
      uploads: uploads() - before.uploads,
      sent: sentOf("0001_more") - before.sent,
      runs: await runs(clientId),
    }).toMatchObject({
      operation: {
        status: "failed",
        error: "release_behind_migration",
        step: null,
      },
      uploads: 0,
      sent: 0,
      runs: { core: a.releaseId, connect: a.releaseId },
    });
  });

  it("refuses the route once a probe run again fails, until a probe passes again", async () => {
    const { clientId, b } = await liveOnA();
    const held = await attempt(clientId);
    await startClientRelease(db, staff, held, { releaseId: b.releaseId });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcomes: Record<string, unknown> = {};
    try {
      for (const phase of operationPhases.slice(0, 5)) {
        // oxlint-disable-next-line no-await-in-loop -- in order, through the probe
        await runOperationPhase(context, held, phase);
      }
      // Run again, the probe finds core answering as another client.
      cloudflare.coreOf(clientId).coreProbe = { asClient: "someone-else" };
      outcomes.probe = await runOperationPhase(context, held, "probe");
      outcomes.route = await runOperationPhase(context, held, "route");
      delete cloudflare.coreOf(clientId).coreProbe;
      outcomes.probeAgain = await runOperationPhase(context, held, "probe");
      outcomes.routeAgain = await runOperationPhase(context, held, "route");
      outcomes.record = await runOperationPhase(context, held, "record");
    } finally {
      errors.mockRestore();
    }

    expect({
      outcomes,
      operation: await operationOf(clientId),
    }).toMatchObject({
      outcomes: {
        probe: { code: "probe_identity_mismatch" },
        route: { code: "phase_out_of_order", unstarted: true },
        probeAgain: undefined,
        routeAgain: undefined,
        record: undefined,
      },
      operation: { status: "done", releaseId: b.releaseId },
    });
  });

  it("publishes a core from before the probe named its release and schema, as it is", async () => {
    const manifest = await importRelease();
    const { clientId, held } = await setUp(manifest);
    cloudflare.coreOf(clientId).coreProbe = { beforeRelease: true };
    await runClientProvision(context, held);
    expect({
      operation: await operationOf(clientId),
      routed: await routed(clientId),
    }).toMatchObject({
      operation: { status: "done", error: null },
      routed: true,
    });
  });

  it("waits out Cloudflare's stub for a new core's static files, and leaves the hostname unpublished while it lasts", async () => {
    const manifest = await importRelease();
    const ready = await setUp(manifest);
    // A moment's stub, as files just uploaded can give: tried again.
    cloudflare.coreOf(ready.clientId).assetsStub = 2;
    await runClientProvision(context, ready.held);
    const lasting = await setUp(manifest);
    // Longer than the probe tries.
    cloudflare.coreOf(lasting.clientId).assetsStub = 100;
    const { code } = z
      .object({ code: z.string() })
      .parse(await failing(lasting.held));

    expect({
      ready: await routed(ready.clientId),
      lasting: {
        code,
        operation: await operationOf(lasting.clientId),
        routed: await routed(lasting.clientId),
      },
    }).toMatchObject({
      ready: true,
      lasting: {
        code: "probe_assets_not_ready",
        operation: { status: "failed", step: "core" },
        routed: false,
      },
    });
  });

  it.each([
    {
      name: "the release before",
      probe: (a: string) => ({ asRelease: a }),
      code: "probe_release_mismatch",
    },
    {
      name: "a database behind the release's last migration",
      probe: () => ({ schemaAt: { DB: "0000_init.sql" } }),
      code: "probe_schema_mismatch",
    },
  ])(
    "rolls a live client back on its own when its release's core answers $name, the release before passing on the newer schema",
    async ({ probe, code }) => {
      const { clientId, a, b } = await liveOnA();
      cloudflare.coreOf(clientId).coreProbe = probe(a.releaseId);
      const held = await attempt(clientId);
      await startClientRelease(db, staff, held, { releaseId: b.releaseId });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await runClientProvision(context, held);
      } finally {
        errors.mockRestore();
      }
      const [rolledBack] = await db
        .select({ detail: auditEvents.detail })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.clientId, clientId),
            eq(auditEvents.action, "release.rollback")
          )
        );

      expect({
        operation: await operationOf(clientId),
        runs: await runs(clientId),
        cause: z
          .object({ cause: z.string() })
          .loose()
          .parse(JSON.parse(rolledBack?.detail ?? "{}")).cause,
      }).toMatchObject({
        operation: { status: "done", releaseId: a.releaseId },
        runs: { core: a.releaseId, connect: a.releaseId },
        cause: code,
      });
    }
  );

  it("rolls a live client back on its own when its release's core serves Cloudflare's stub for its static files", async () => {
    const { clientId, a, b } = await liveOnA();
    const { connect } = await scriptsOf(clientId);
    cloudflare.coreOf(clientId).assetsStub = 100;
    // Once the rollback's connect goes, core serves its files again.
    // oxlint-disable require-await -- the fake waits on these; nothing to wait for
    cloudflare.beforeAnswering(isUpload(connect), async () => {
      cloudflare.beforeAnswering(isUpload(connect), async () => {
        cloudflare.coreOf(clientId).assetsStub = 0;
      });
    });
    // oxlint-enable require-await
    const held = await attempt(clientId);
    await startClientRelease(db, staff, held, { releaseId: b.releaseId });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runClientProvision(context, held);
    } finally {
      errors.mockRestore();
    }
    expect({
      operation: await operationOf(clientId),
      runs: await runs(clientId),
    }).toMatchObject({
      operation: { status: "done", releaseId: a.releaseId },
      runs: { core: a.releaseId, connect: a.releaseId },
    });
  });
});

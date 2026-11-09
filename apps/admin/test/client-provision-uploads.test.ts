import { clientsNamespace, platformWorkerName } from "@grasp-os/shared/names";
import type { Stage } from "@grasp-os/shared/names";
import {
  connectVersionPath,
  provisionProbePath,
} from "@grasp-os/shared/provision-probe";
import { env } from "cloudflare:workers";
import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  auditEvents,
  clientWorkers,
  clientProvisions,
  clientResources,
  clients,
} from "../src/db/schema.ts";
import { rotationWindowMs } from "../src/deploy/secrets.ts";
import {
  allocateClientResources,
  clientInventory,
} from "../src/hosting/inventory.ts";
import {
  ProvisionOperationError,
  runClientProvision,
  startClientRelease,
} from "../src/hosting/operation.ts";
import { takeAttempt } from "../src/runners.ts";
import type { HeldClient } from "../src/runners.ts";
import {
  token,
  cloudflare,
  secrets,
  domain,
  context,
  namespace,
  unbound,
  clientDispatchNamespace,
  bindsConnect,
  importRelease,
  importRealRelease,
  placedOperation,
  setUp,
  operationOf,
  previousKeys,
  currentKeys,
  laggingUploads,
  revokedNamesOf,
  failing,
  isScriptUpload,
  isCoreUpload,
  codeFrom,
  appliedMigrations,
  resourceOf,
  scriptsOf,
  liveBindings,
  isUpload,
  routed,
  liveClient,
  attempt,
} from "./client-provision-harness.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { clientScripts } from "./grasp-account.ts";
import { db, staff } from "./hosting.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Here: namespaces and Workers for Platforms, uploads that lag or never
// answer, and the secrets each upload gives; the rest in the other
// client-provision-*.test.ts files.

mockCloudflareApi(token, cloudflare);

describe("provisioning a placed client", () => {
  useStoreSecrets({ deployer: token });

  it("probes a core in the namespace the router binds through that binding, its connect through the gateway, and routes its hostname to its script", async () => {
    // Core binds its connect, as the real one does: through the gateway.
    const manifest = await importRelease({}, bindsConnect);
    const { account, clientId, held } = await setUp(
      manifest,
      clientDispatchNamespace
    );
    const outbound = cloudflare.calls.length;

    await runClientProvision(
      {
        ...context,
        router: {
          ...context.router,
          namespace: clientDispatchNamespace,
          dispatcher: cloudflare.dispatcher(
            account.id,
            clientDispatchNamespace
          ),
        },
      },
      held
    );

    const { core, connect } = await scriptsOf(clientId);
    const bindings = z
      .array(z.object({ name: z.string() }).loose())
      .parse(
        account.namespaces
          .get(clientDispatchNamespace)
          ?.get(core)
          ?.versions.at(-1)?.metadata.bindings ?? []
      );
    // The version each runs, as the namespace has it live: connect's
    // after its secrets were delivered.
    const liveIn = (script: string) =>
      account.namespaces.get(clientDispatchNamespace)?.get(script)
        ?.deployments[0]?.versions[0]?.version_id;
    const recorded = await db
      .select({
        worker: clientWorkers.worker,
        versionId: clientWorkers.versionId,
      })
      .from(clientWorkers)
      .where(eq(clientWorkers.clientId, clientId))
      .orderBy(clientWorkers.worker);
    const [probed] = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "provision.probe")
        )
      );
    expect({
      operation: await operationOf(clientId),
      // Nothing left unrecorded: connect's settled.
      unrecorded: z
        .object({ connectUnrecorded: z.number().optional() })
        .parse(JSON.parse(probed?.detail ?? "{}")).connectUnrecorded,
      // What drift compares against: core's as it answered, and its
      // connect's as connect named it to core in the probe.
      recorded,
      entry: await env.ROUTER_HOSTS.get(`${clientId}.${domain}`, "json"),
      // Its connect, as core binds it: the gateway, naming its own script.
      connectBinding: bindings.find(({ name }) => name === "CONNECT"),
      // Its health and the admin's probe, through the namespace, at the
      // hostname the router will reach it at: never over workers.dev.
      dispatched: cloudflare.dispatched().map(({ script, url }) => ({
        script,
        path: new URL(url).pathname,
        host: new URL(url).host,
      })),
      workersDev: cloudflare.calls
        .slice(outbound)
        .filter(({ path }) => path.includes("workers.dev")).length,
    }).toMatchObject({
      operation: { status: "done" },
      unrecorded: undefined,
      recorded: [
        { worker: "connect", versionId: liveIn(connect) ?? "none" },
        { worker: "core", versionId: liveIn(core) ?? "none" },
      ],
      entry: { clientId, script: core, generation: 1 },
      connectBinding: {
        type: "service",
        name: "CONNECT",
        service: platformWorkerName("connect-gateway", "production"),
        props: { script: connect },
      },
      dispatched: [
        { script: core, path: "/health", host: `${clientId}.${domain}` },
        {
          script: core,
          path: provisionProbePath,
          host: `${clientId}.${domain}`,
        },
        // Connect's version read again, signed: the same twice apart.
        {
          script: core,
          path: connectVersionPath,
          host: `${clientId}.${domain}`,
        },
      ],
      workersDev: 0,
    });
  });

  it.each(
    (["release", "secrets"] as const).flatMap((change) => [
      {
        change,
        isolates:
          "answer as the version recorded before it twice, then the new one",
        stale: 2,
        recordsNew: true,
      },
      {
        change,
        isolates: "never answer as anything but the version recorded before it",
        stale: "always" as const,
        recordsNew: false,
      },
    ])
  )(
    "never records a namespace connect as the version it ran before a $change change when its old isolates $isolates",
    async ({ change, stale, recordsNew }) => {
      const manifest = await importRelease({}, bindsConnect);
      const { account, clientId, held } = await setUp(
        manifest,
        clientDispatchNamespace
      );
      const namespaced = {
        ...context,
        router: {
          ...context.router,
          dispatcher: cloudflare.dispatcher(
            account.id,
            clientDispatchNamespace
          ),
        },
      };
      await runClientProvision(namespaced, held);
      const recordedConnect = async (): Promise<string | null> => {
        const row = await db
          .select({ versionId: clientWorkers.versionId })
          .from(clientWorkers)
          .where(
            and(
              eq(clientWorkers.clientId, clientId),
              eq(clientWorkers.worker, "connect")
            )
          )
          .get();
        return row?.versionId ?? null;
      };
      const before = await recordedConnect();
      // A second release, or the same release run again with its secrets
      // rotated: connect uploaded again, a new version; isolates of the
      // one before still answering core for a moment.
      if (change === "release") {
        const second = await importRelease(
          { notes: "feat(core): second" },
          bindsConnect
        );
        await startClientRelease(db, staff, await attempt(clientId), {
          releaseId: second.releaseId,
        });
      } else {
        await db
          .update(clients)
          .set({ generation: 2, rotatedAt: new Date() })
          .where(eq(clients.id, clientId));
        await startClientRelease(db, staff, await attempt(clientId), {
          again: true,
          what: "secrets",
        });
      }
      if (stale === "always") {
        cloudflare.coreOf(clientId).connectAnswering = before;
      } else {
        cloudflare.coreOf(clientId).connectAnswersFirst = Array.from(
          { length: stale },
          () => before
        );
      }
      const rerun = await attempt(clientId);
      await runClientProvision(namespaced, rerun);
      const { connect } = await scriptsOf(clientId);
      const live = account.namespaces.get(clientDispatchNamespace)?.get(connect)
        ?.deployments[0]?.versions[0]?.version_id;
      const probes = await db
        .select({ detail: auditEvents.detail })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.clientId, clientId),
            eq(auditEvents.action, "provision.probe")
          )
        );

      const operation = await operationOf(clientId);
      expect({
        before: typeof before,
        changed: live !== before,
        status: operation?.status,
        recorded: await recordedConnect(),
        unrecorded: probes
          .map(({ detail }) =>
            z
              .object({
                run: z.string(),
                connectUnrecorded: z.number().optional(),
              })
              .parse(JSON.parse(detail ?? "{}"))
          )
          .find(({ run }) => run === rerun.runId)?.connectUnrecorded,
      }).toStrictEqual({
        before: "string",
        changed: true,
        status: "done",
        recorded: recordsNew ? (live ?? "none") : null,
        unrecorded: recordsNew ? undefined : 1,
      });
    }
  );

  it.each([
    {
      worker: "core" as const,
      answers: "the version recorded before the run, until they stop",
    },
  ])(
    "records a namespace $worker only as its latest version when its isolates answer $answers",
    async ({ worker }) => {
      const manifest = await importRelease({}, bindsConnect);
      const { account, clientId, held } = await setUp(
        manifest,
        clientDispatchNamespace
      );
      const namespaced = {
        ...context,
        router: {
          ...context.router,
          dispatcher: cloudflare.dispatcher(
            account.id,
            clientDispatchNamespace
          ),
        },
      };
      await runClientProvision(namespaced, held);
      const recordedOf = async (): Promise<Record<string, string | null>> => {
        const rows = await db
          .select({
            worker: clientWorkers.worker,
            versionId: clientWorkers.versionId,
          })
          .from(clientWorkers)
          .where(eq(clientWorkers.clientId, clientId));
        return Object.fromEntries(
          rows.map(({ worker: name, versionId }) => [name, versionId])
        );
      };
      const before = await recordedOf();
      const second = await importRelease(
        { notes: "feat(core): second" },
        bindsConnect
      );
      await startClientRelease(db, staff, await attempt(clientId), {
        releaseId: second.releaseId,
      });
      const rerun = await attempt(clientId);
      let stopped: unknown = null;
      let whileOld: string | null = null;
      // Its old isolates answer its health and its probe alike: the run
      // stops rather than record what it superseded, and goes on once
      // they're gone.
      cloudflare.coreOf(clientId).answeringVersion = before.core ?? "none";
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      stopped = await runClientProvision(namespaced, rerun).then(
        () => null,
        (error: unknown) => error
      );
      errors.mockRestore();
      const meanwhile = await recordedOf();
      whileOld = meanwhile.core ?? null;
      delete cloudflare.coreOf(clientId).answeringVersion;
      await runClientProvision(namespaced, rerun);
      const scripts = await scriptsOf(clientId);
      const live = account.namespaces
        .get(clientDispatchNamespace)
        ?.get(scripts[worker])?.deployments[0]?.versions[0]?.version_id;
      const operation = await operationOf(clientId);
      const recorded = await recordedOf();

      expect({
        stopped: worker === "core" ? stopped instanceof Error : null,
        whileOld,
        status: operation?.status,
        changed: live !== before[worker],
        recorded: recorded[worker],
      }).toStrictEqual({
        stopped: worker === "core" ? true : null,
        whileOld: null,
        status: "done",
        changed: true,
        recorded: live ?? "none",
      });
    }
  );

  it("still refuses what a run superseded on its retry, after its probe recorded none of connect's and a later step failed", async () => {
    const manifest = await importRelease({}, bindsConnect);
    const { account, clientId, held } = await setUp(
      manifest,
      clientDispatchNamespace
    );
    const namespaced = {
      ...context,
      router: {
        ...context.router,
        dispatcher: cloudflare.dispatcher(account.id, clientDispatchNamespace),
      },
    };
    await runClientProvision(namespaced, held);
    const recordedConnect = async (): Promise<string | null> => {
      const row = await db
        .select({ versionId: clientWorkers.versionId })
        .from(clientWorkers)
        .where(
          and(
            eq(clientWorkers.clientId, clientId),
            eq(clientWorkers.worker, "connect")
          )
        )
        .get();
      return row?.versionId ?? null;
    };
    const before = await recordedConnect();
    const second = await importRelease(
      { notes: "feat(core): second" },
      bindsConnect
    );
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: second.releaseId,
    });
    const rerun = await attempt(clientId);
    // Its probe: only the old isolates answer, so none is recorded; then
    // publishing its hostname fails.
    cloudflare.coreOf(clientId).connectAnswering = before;
    const put = vi
      .spyOn(env.ROUTER_HOSTS, "put")
      .mockRejectedValueOnce(new Error("the router's map is down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await runClientProvision(namespaced, rerun).then(
      () => null,
      (error: unknown) => error
    );
    errors.mockRestore();
    put.mockRestore();
    const afterFailure = await recordedConnect();
    // Retried: nothing uploaded or delivered again, and an old isolate
    // answers first, twice.
    delete cloudflare.coreOf(clientId).connectAnswering;
    cloudflare.coreOf(clientId).connectAnswersFirst = [before, before];
    await runClientProvision(namespaced, rerun);
    const { connect } = await scriptsOf(clientId);
    const live = account.namespaces.get(clientDispatchNamespace)?.get(connect)
      ?.deployments[0]?.versions[0]?.version_id;
    const operation = await operationOf(clientId);

    expect({
      failed: failed instanceof Error,
      afterFailure,
      changed: live !== before,
      status: operation?.status,
      recorded: await recordedConnect(),
    }).toStrictEqual({
      failed: true,
      afterFailure: null,
      changed: true,
      status: "done",
      recorded: live ?? "none",
    });
  });

  it("records a namespace connect as its retry's upload, not an earlier attempt's still answering, when the retry changed its shared secrets", async () => {
    const manifest = await importRelease({}, bindsConnect);
    const { account, clientId, held } = await setUp(
      manifest,
      clientDispatchNamespace
    );
    const namespaced = {
      ...context,
      router: {
        ...context.router,
        dispatcher: cloudflare.dispatcher(account.id, clientDispatchNamespace),
      },
    };
    await runClientProvision(namespaced, held);
    const { connect } = await scriptsOf(clientId);
    const liveConnect = () =>
      account.namespaces.get(clientDispatchNamespace)?.get(connect)
        ?.deployments[0]?.versions[0]?.version_id;
    const recordedVersions = async () => {
      const rows = await db
        .select({
          worker: clientWorkers.worker,
          versionId: clientWorkers.versionId,
        })
        .from(clientWorkers)
        .where(eq(clientWorkers.clientId, clientId));
      return Object.fromEntries(
        rows.map(({ worker, versionId }) => [worker, versionId])
      );
    };
    const before = await recordedVersions();
    const second = await importRelease(
      { notes: "feat(core): second" },
      bindsConnect
    );
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: second.releaseId,
    });
    const rerun = await attempt(clientId);
    // The first attempt uploads connect, then stops before its probe
    // passes: only core's old isolates answer.
    cloudflare.coreOf(clientId).answeringVersion = before.core ?? "none";
    const stopped = await failing(rerun, namespaced);
    delete cloudflare.coreOf(clientId).answeringVersion;
    const firstUpload = liveConnect();
    // Retried with connect's shared secret rotated, so connect is uploaded
    // again; an isolate of the first attempt's upload answers first.
    cloudflare.coreOf(clientId).connectAnswersFirst = [firstUpload ?? null];
    await runClientProvision(
      {
        ...namespaced,
        secrets: {
          ...secrets,
          shared: {
            connect: { ...secrets.shared.connect, COMPOSIO_API_KEY: "rotated" },
          },
        },
      },
      rerun
    );
    const retryUpload = liveConnect();
    const operation = await operationOf(clientId);
    const recorded = await recordedVersions();

    expect({
      stopped: stopped instanceof Error,
      uploadedAgain: retryUpload !== firstUpload,
      status: operation?.status,
      recorded: recorded.connect,
    }).toStrictEqual({
      stopped: true,
      uploadedAgain: true,
      status: "done",
      recorded: retryUpload ?? "none",
    });
  });

  it("goes live on a core of a release from before connect's version, recording none of connect's", async () => {
    const manifest = await importRelease({}, bindsConnect);
    const { account, clientId, held } = await setUp(
      manifest,
      clientDispatchNamespace
    );
    // Its core names no version of connect's: not in its probe, nor asked.
    cloudflare.coreOf(clientId).coreProbe = { noConnectVersion: true };

    await runClientProvision(
      {
        ...context,
        router: {
          ...context.router,
          dispatcher: cloudflare.dispatcher(
            account.id,
            clientDispatchNamespace
          ),
        },
      },
      held
    );
    const recorded = await db
      .select({
        worker: clientWorkers.worker,
        versionId: clientWorkers.versionId,
      })
      .from(clientWorkers)
      .where(eq(clientWorkers.clientId, clientId))
      .orderBy(clientWorkers.worker);
    const [probed] = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "provision.probe")
        )
      );
    const operation = await operationOf(clientId);

    expect({
      status: operation?.status,
      connect: recorded.find(({ worker }) => worker === "connect")?.versionId,
      core: typeof recorded.find(({ worker }) => worker === "core")?.versionId,
      unrecorded: z
        .object({ connectUnrecorded: z.number().optional() })
        .parse(JSON.parse(probed?.detail ?? "{}")).connectUnrecorded,
    }).toStrictEqual({
      status: "done",
      connect: null,
      core: "string",
      unrecorded: 1,
    });
  });

  it("can't reach a core uploaded to the same namespace in another account, its hostname unpublished", async () => {
    const manifest = await importRelease();
    const { clientId, held } = await setUp(manifest, clientDispatchNamespace);
    // The router's own account, whose namespace of that name lacks the core.
    const routers = cloudflare.addAccount("Router");
    routers.namespaces.set(clientDispatchNamespace, new Map());

    const outcome = await runClientProvision(
      {
        ...context,
        router: {
          ...context.router,
          namespace: clientDispatchNamespace,
          dispatcher: cloudflare.dispatcher(
            routers.id,
            clientDispatchNamespace
          ),
        },
      },
      held
    ).then(
      () => "done",
      (error: unknown) => (error instanceof Error ? error.message : "")
    );

    expect({
      outcome: outcome === "done" ? outcome : "stopped",
      operation: await operationOf(clientId),
      dispatched: cloudflare.dispatched().length,
      routed: await routed(clientId),
    }).toMatchObject({
      outcome: "stopped",
      operation: { status: "failed" },
      dispatched: 0,
      routed: false,
    });
  });

  it("places a client only in its own stage's namespace, in either direction, before anything is created or uploaded", async () => {
    const manifest = await importRelease();
    // A production destination, run by a staging admin...
    const production = await setUp(manifest);
    // ...and a staging one, recorded by a staging admin, run by production's.
    const staging = await setUp(manifest, clientsNamespace("staging"));
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- the test's own, kept beside it; it reads the shared harness
    const runAs = async (held: HeldClient, stage: Stage): Promise<unknown> => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        return await runClientProvision(
          {
            ...context,
            router: { ...context.router, namespace: clientsNamespace(stage) },
          },
          held
        ).then(
          () => null,
          (error: unknown) => error
        );
      } finally {
        errors.mockRestore();
      }
    };

    const refused = [
      await runAs(production.held, "staging"),
      await runAs(staging.held, "production"),
    ];
    expect({
      refused: refused.map((error) =>
        error instanceof ProvisionOperationError ? error.code : error
      ),
      created: [production.account, staging.account].map(
        (account) => account.d1.length + account.scriptUploads.length
      ),
      inventory: [
        await clientInventory(db, production.clientId),
        await clientInventory(db, staging.clientId),
      ],
      routed: [
        await routed(production.clientId),
        await routed(staging.clientId),
      ],
    }).toStrictEqual({
      refused: ["destination_other_stage", "destination_other_stage"],
      created: [0, 0],
      inventory: [[], []],
      routed: [false, false],
    });
  });

  it("builds a retry's Durable Object migrations from what an earlier attempt's upload left, once that upload landed", async () => {
    const manifest = await importRelease();
    const { held: claim } = await setUp(manifest);
    // The first attempt's core upload, carrying core's migration, is held
    // on its way when the step's retry takes the client.
    const held = Promise.withResolvers<boolean>();
    let uploading = false;
    cloudflare.beforeAnswering(isCoreUpload, async () => {
      uploading = true;
      await held.promise;
    });
    const step = { attemptKey: "provision-step" };
    const first = { ...claim, ...step, attempt: 1 };
    await takeAttempt(db, first);
    const firstRun = failing(first);
    await vi.waitUntil(() => uploading, { timeout: 10_000 });
    const retry = { ...claim, ...step, attempt: 2 };
    await takeAttempt(db, retry);
    const retryRun = failing(retry);
    // A while for the retry to read what core runs, were it to read
    // before the held upload landed; then that upload lands.
    await scheduler.wait(1000);
    held.resolve(true);
    const [firstOutcome, retryOutcome] = await Promise.all([
      firstRun,
      retryRun,
    ]);

    expect({
      // The one that timed out is refused once its upload answered.
      first: codeFrom(firstOutcome),
      // The retry's upload goes on from the migration that landed, and the
      // client goes live.
      retry: codeFrom(retryOutcome),
    }).toStrictEqual({
      first: "runner_replaced",
      retry: null,
    });
  });

  it.each([
    { upload: "the same upload", waits: false },
    { upload: "another upload (read with other settings)", waits: true },
  ])(
    "after a dead attempt's core upload landed, marked, the next attempt waits for it only when it was $upload",
    async ({ waits }) => {
      const manifest = await importRelease();
      const { clientId, held } = await setUp(manifest);
      // Core's upload lands, with its migration, and its answer never
      // arrives: its attempt's mark stays, as a dead isolate's would.
      cloudflare.failNext(isCoreUpload, "lost");
      await expect(failing(held)).resolves.toMatchObject({ status: 0 });
      if (waits) {
        await db
          .update(clientProvisions)
          .set({
            sending: sql`(SELECT json_group_object(key, json_set(value, '$.fingerprint', 'another')) FROM json_each(${clientProvisions.sending}))`,
          })
          .where(eq(clientProvisions.clientId, clientId));
      }
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- the test's own, kept beside it; it reads the shared harness
      const uploads = () => cloudflare.calls.filter(isCoreUpload).length;
      const sentBefore = uploads();
      // Time under the test's control: the retry waits this long between
      // reads of a mark it holds on to (`othersSettled`), and between
      // reads back of what it wrote (`observed`). Before core's upload went
      // out, such a wait is the retry holding on to the mark: held until
      // the test lets it go. After, it passes at once.
      const markWaitMs = 60_000;
      const waiting = Promise.withResolvers<"waiting">();
      const letGo = Promise.withResolvers<null>();
      const wait = scheduler.wait.bind(scheduler);
      const waitSpy = vi
        .spyOn(scheduler, "wait")
        .mockImplementation(async (ms, options) => {
          if (ms % markWaitMs !== 0) {
            await wait(ms, options);
          } else if (uploads() > sentBefore) {
            await wait(0, options);
          } else {
            waiting.resolve("waiting");
            await letGo.promise;
          }
        });

      try {
        const run = runClientProvision(
          { ...context, observe: { retryDelayMs: markWaitMs } },
          await attempt(clientId)
        );
        // Whichever comes first: the retry finishing, or waiting for the mark.
        const first = await Promise.race([
          run.then(() => "finished" as const),
          waiting.promise,
        ]);
        const meanwhile = await operationOf(clientId);
        const whileMarked = {
          first,
          uploads: uploads() - sentBefore,
          status: meanwhile?.status,
        };
        // Aged out: no call of it can land any more.
        await db
          .update(clientProvisions)
          .set({
            sending: sql`(SELECT json_group_object(key, json_set(value, '$.at', 0)) FROM json_each(${clientProvisions.sending}))`,
          })
          .where(eq(clientProvisions.clientId, clientId));
        letGo.resolve(null);
        await run;
        const after = await operationOf(clientId);

        expect({ whileMarked, status: after?.status }).toStrictEqual({
          // The same upload: it goes on without waiting. Another: nothing
          // goes out while the mark is fresh.
          whileMarked: waits
            ? { first: "waiting", uploads: 0, status: "running" }
            : { first: "finished", uploads: 1, status: "done" },
          status: "done",
        });
      } finally {
        waitSpy.mockRestore();
      }
    }
  );

  it("takes the real release live in Workers for Platforms with no AI Gateway or AI binding, Grasp's AI key on its connect alone, and without mail", async () => {
    const real = await importRealRelease();
    const { account, clientId, held } = await setUp(
      real,
      clientDispatchNamespace
    );

    await runClientProvision(
      {
        ...context,
        router: {
          ...context.router,
          namespace: clientDispatchNamespace,
          dispatcher: cloudflare.dispatcher(
            account.id,
            clientDispatchNamespace
          ),
        },
      },
      held
    );

    const { core, connect } = await scriptsOf(clientId);
    const scripts = account.namespaces.get(clientDispatchNamespace);
    const coreBindings = z
      .array(z.object({ type: z.string(), name: z.string() }).loose())
      .parse(scripts?.get(core)?.versions.at(-1)?.metadata.bindings ?? []);
    const aiKeys = (script: string) =>
      [...(scripts?.get(script)?.versions.at(-1)?.secrets.keys() ?? [])]
        .filter(
          (name) => name.endsWith("_API_KEY") && name !== "COMPOSIO_API_KEY"
        )
        .toSorted();
    expect({
      operation: await operationOf(clientId),
      // No AI binding: the real core reaches models through connect only.
      ai: coreBindings
        .filter(({ type }) => type === "ai")
        .map(({ name }) => name),
      // No AI Gateway is made or read, and core is given no model allowlist.
      gatewayCalls: cloudflare.calls.filter(({ path }) =>
        path.includes("/gateways")
      ).length,
      modelGateway: coreBindings.some(({ name }) => name === "MODEL_GATEWAY"),
      // Grasp's key goes to connect, which makes every provider call, never core.
      keys: { core: aiKeys(core), connect: aiKeys(connect) },
      // Its core goes live without `EMAIL`, so it sends nothing and says so.
      mail: coreBindings.filter(
        ({ type, name }) => type === "send_email" || name === "EMAIL"
      ),
      routed: await routed(clientId),
    }).toMatchObject({
      operation: { status: "done" },
      ai: [],
      gatewayCalls: 0,
      modelGateway: false,
      keys: { core: [], connect: ["OPENAI_API_KEY"] },
      mail: [],
      routed: true,
    });
  });

  it("takes the real release live with no AI provider key of Grasp's at all, its connect given none", async () => {
    const real = await importRealRelease();
    const { account, clientId, held } = await setUp(
      real,
      clientDispatchNamespace
    );

    // Secrets Store holds no provider key: the platform AI's defaults name
    // OpenAI all the same, and only those features wait for the key.
    await runClientProvision(
      {
        ...context,
        secrets: {
          ...secrets,
          shared: { connect: { COMPOSIO_API_KEY: "composio" } },
        },
        router: {
          ...context.router,
          namespace: clientDispatchNamespace,
          dispatcher: cloudflare.dispatcher(
            account.id,
            clientDispatchNamespace
          ),
        },
      },
      held
    );

    const { core, connect } = await scriptsOf(clientId);
    const scripts = account.namespaces.get(clientDispatchNamespace);
    const aiKeys = (script: string) =>
      [...(scripts?.get(script)?.versions.at(-1)?.secrets.keys() ?? [])].filter(
        (name) => name.endsWith("_API_KEY") && name !== "COMPOSIO_API_KEY"
      );
    expect({
      operation: await operationOf(clientId),
      gatewayCalls: cloudflare.calls.filter(({ path }) =>
        path.includes("/gateways")
      ).length,
      keys: { core: aiKeys(core), connect: aiKeys(connect) },
      routed: await routed(clientId),
    }).toMatchObject({
      operation: { status: "done" },
      gatewayCalls: 0,
      keys: { core: [], connect: [] },
      routed: true,
    });
  });

  it("uploads into a Workers for Platforms namespace, and stops at the probe it can't qualify", async () => {
    const manifest = await importRelease();
    const { account, clientId, held } = await setUp(manifest);

    await expect(failing(held, unbound)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    const { core, connect } = await scriptsOf(clientId);
    const scripts = account.namespaces.get(namespace);
    expect({
      operation: await operationOf(clientId),
      inNamespace: [...(scripts?.keys() ?? [])].toSorted(),
      // Nothing outside the namespace.
      outside: account.scripts.size,
      tag: scripts?.get(core)?.migrationTag,
      routerSecret: scripts
        ?.get(core)
        ?.versions.at(-1)
        ?.secrets.has("ROUTER_SECRET"),
      routed: await routed(clientId),
    }).toMatchObject({
      operation: {
        status: "failed",
        step: "core",
        error: "probe_unqualified",
      },
      inNamespace: [connect, core].toSorted(),
      outside: 0,
      tag: "v1",
      routerSecret: true,
      routed: false,
    });

    // Run again, it uploads and delivers nothing again.
    const before = cloudflare.calls.length;
    await expect(failing(held, unbound)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    expect(
      cloudflare.calls
        .slice(before)
        // Reading what each database applied is a POST of its own.
        .filter(
          (call) =>
            (call.method === "PUT" || call.method === "POST") &&
            !call.path.endsWith("/query")
        )
        .map(({ path }) => path)
    ).toStrictEqual([]);
  });

  it.each([
    {
      marks: "an earlier change's call, still on its way",
      sending: (change: number) =>
        JSON.stringify({ "dead-run#1": { change, at: Date.now() } }),
    },
    { marks: "it can't read", sending: () => "not json" },
  ])(
    "holds a release that took the client over while marks $marks are fresh, and lets it go once they age out",
    async ({ sending }) => {
      const first = await importRelease();
      const { clientId } = await liveClient(first);
      const before = await operationOf(clientId);
      const second = await importRelease({ notes: "feat(core): second" });
      await startClientRelease(db, staff, await attempt(clientId), {
        releaseId: second.releaseId,
      });
      // What the change before it sent, as a run that died left it marked.
      await db
        .update(clientProvisions)
        .set({ sending: sending(before?.change ?? 0), updatedAt: new Date() })
        .where(eq(clientProvisions.clientId, clientId));
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- the test's own, kept beside it; it reads the shared harness
      const uploads = () => cloudflare.calls.filter(isScriptUpload).length;
      const sentBefore = uploads();

      const run = runClientProvision(context, await attempt(clientId));
      await scheduler.wait(500);
      const whileMarked = uploads() - sentBefore;
      // Aged out: no call of it can land any more.
      await db
        .update(clientProvisions)
        .set({
          sending: JSON.stringify({ "dead-run#1": { change: 0, at: 0 } }),
          updatedAt: new Date(0),
        })
        .where(eq(clientProvisions.clientId, clientId));
      await run;
      const after = await operationOf(clientId);

      expect({ whileMarked, status: after?.status }).toStrictEqual({
        whileMarked: 0,
        status: "done",
      });
    }
  );

  it("aborts an upload left unanswered past its limit, and keeps it marked sent, as it may still land", async () => {
    const manifest = await importRelease();
    const { clientId, held } = await setUp(manifest);
    // Connect's upload goes unanswered until the test ends.
    const answered = Promise.withResolvers<boolean>();
    cloudflare.beforeAnswering(
      (call) => call.method === "PUT" && call.path.endsWith("-connect"),
      async () => {
        await answered.promise;
      }
    );
    const abortedBefore = cloudflare.abortedCalls();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let outcome: string;
    try {
      outcome = await runClientProvision(
        { ...context, sendTimeoutMs: 50 },
        held
      ).then(
        () => "done",
        (error: unknown) => (error instanceof Error ? error.name : "thrown")
      );
    } finally {
      errors.mockRestore();
      answered.resolve(true);
    }
    const row = await db
      .select({
        status: clientProvisions.status,
        sending: clientProvisions.sending,
      })
      .from(clientProvisions)
      .where(eq(clientProvisions.clientId, clientId))
      .get();

    expect({
      outcome,
      aborted: cloudflare.abortedCalls() - abortedBefore,
      status: row?.status,
      // Marked still: a release or rollback after it waits it out.
      marked:
        Object.keys(
          z
            .record(z.string(), z.unknown())
            .parse(JSON.parse(row?.sending ?? "{}"))
        ).length > 0,
    }).toStrictEqual({
      outcome: "TimeoutError",
      aborted: 1,
      status: "failed",
      marked: true,
    });
  });

  it("reads an upload back through Cloudflare's lag, and goes on", async () => {
    const manifest = await importRelease();
    const { held, clientId } = await setUp(manifest);
    const stale = laggingUploads(3);

    await runClientProvision(context, held);
    expect({
      operation: await operationOf(clientId),
      staleReads: [...stale.values()],
    }).toMatchObject({
      operation: { status: "done" },
      // Each Worker's upload read back once the lag passed.
      staleReads: [3, 3],
    });
  });

  it("stops at an upload that never reads back, after a bounded number of tries", async () => {
    const manifest = await importRelease();
    const { held, clientId } = await setUp(manifest);
    const stale = laggingUploads(Number.POSITIVE_INFINITY);

    await expect(failing(held)).resolves.toMatchObject({
      code: "upload_unobserved",
    });
    expect({
      operation: await operationOf(clientId),
      staleReads: [...stale.values()],
    }).toMatchObject({
      operation: { status: "failed", error: "upload_unobserved" },
      // Connect's, read six times, then the run stopped.
      staleReads: [6],
    });
  });

  it("gives each script exactly its secrets in its upload, and records by name each one the upload no longer gives", async () => {
    const manifest = await importRelease();
    const { account, clientId, held } = await setUp(manifest);
    // Rotated, and not live yet: each key that rotates goes with its
    // previous value too.
    await db
      .update(clients)
      .set({ generation: 2, rotatedAt: new Date() })
      .where(eq(clients.id, clientId));
    await expect(failing(held, unbound)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    const { core, connect } = await scriptsOf(clientId);
    const scripts = account.namespaces.get(namespace);
    const secretsOn = (script: string): Map<string, string> =>
      scripts?.get(script)?.versions.at(-1)?.secrets ??
      new Map<string, string>();
    const namesOn = (script: string): string[] =>
      [...secretsOn(script).keys()].toSorted((a, b) => a.localeCompare(b));
    const rotating = { core: namesOn(core), connect: namesOn(connect) };

    // The window has closed since, and something set a secret the admin
    // doesn't give.
    await db
      .update(clients)
      .set({ rotationLiveAt: new Date(Date.now() - rotationWindowMs - 1000) })
      .where(eq(clients.id, clientId));
    secretsOn(core).set("STRAY_KEY", "stray-value");
    const before = cloudflare.calls.length;
    await expect(failing(held, unbound)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    // No call writes a secret on its own: each goes with its script.
    const secretWrites = cloudflare.calls
      .slice(before)
      .filter(
        ({ method, path }) => path.includes("/secrets") && method !== "GET"
      );

    expect({
      rotating: {
        core: previousKeys(rotating.core),
        connect: previousKeys(rotating.connect),
      },
      after: { core: namesOn(core), connect: namesOn(connect) },
      secretWrites: secretWrites.length,
    }).toStrictEqual({
      rotating: {
        core: ["ROUTER_SECRET_PREVIOUS"],
        connect: [
          "CAPABILITY_SIGNING_KEY_PREVIOUS",
          "TOKEN_ENCRYPTION_KEY_PREVIOUS",
        ],
      },
      after: {
        core: currentKeys(rotating.core),
        // Its previous vault key stays: tokens may still be sealed under it.
        connect: [
          ...currentKeys(rotating.connect),
          "TOKEN_ENCRYPTION_KEY_PREVIOUS",
        ].toSorted((a, b) => a.localeCompare(b)),
      },
      secretWrites: 0,
    });

    // The step names what it removed, never a value.
    const steps = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          inArray(auditEvents.action, ["provision.connect", "provision.core"])
        )
      );
    const removed = steps
      .map(({ detail }) =>
        z
          .object({ revokedNames: z.string().optional() })
          .loose()
          .safeParse(JSON.parse(detail ?? "{}"))
      )
      .flatMap((parsed) =>
        parsed.success
          ? (parsed.data.revokedNames ?? "").split(",").filter(Boolean)
          : []
      )
      .toSorted((a, b) => a.localeCompare(b));
    expect(removed).toStrictEqual([
      "CAPABILITY_SIGNING_KEY_PREVIOUS",
      "ROUTER_SECRET_PREVIOUS",
      "STRAY_KEY",
    ]);

    // No value the scripts ran with is in what the admin recorded.
    const values = [
      ...secretsOn(core).values(),
      ...secretsOn(connect).values(),
    ].filter((value): value is string => typeof value === "string");
    const recorded = JSON.stringify({
      audit: await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.clientId, clientId)),
      operation: await operationOf(clientId),
    });
    expect(values.filter((value) => recorded.includes(value))).toStrictEqual(
      []
    );
  });

  it("uploads a script again that holds a secret it doesn't give, while a rotation keeps connect's previous vault key", async () => {
    const manifest = await importRelease();
    const { account, clientId, held } = await setUp(manifest);
    // Rotating: connect is given TOKEN_ENCRYPTION_KEY_PREVIOUS, the key
    // it would keep anyway.
    await db
      .update(clients)
      .set({ generation: 2, rotatedAt: new Date() })
      .where(eq(clients.id, clientId));
    await expect(failing(held, unbound)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    const { connect } = await scriptsOf(clientId);
    const secretsOn = (script: string): Map<string, string> =>
      account.namespaces.get(namespace)?.get(script)?.versions.at(-1)
        ?.secrets ?? new Map<string, string>();

    // Uploaded already, and recorded so: one secret more on connect.
    secretsOn(connect).set("STRAY_KEY", "stray-value");
    await expect(failing(held, unbound)).resolves.toMatchObject({
      code: "probe_unqualified",
    });

    expect(secretsOn(connect).has("STRAY_KEY")).toBeFalsy();
  });

  it("records no secret as removed while the upload that would drop it hasn't landed, and both once it has", async () => {
    const manifest = await importRelease();
    const { account, clientId, held } = await setUp(manifest);
    await expect(failing(held, unbound)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    const { core } = await scriptsOf(clientId);
    const onCore = (): Map<string, string> =>
      account.namespaces.get(namespace)?.get(core)?.versions.at(-1)?.secrets ??
      new Map<string, string>();
    onCore().set("STRAY_A", "a-value");
    onCore().set("STRAY_B", "b-value");
    const revokedNames = async () => await revokedNamesOf(clientId);

    // Core's upload is refused: its script keeps what it held.
    cloudflare.failNext(isUpload(core), 400);
    await expect(failing(held)).resolves.toBeDefined();
    const whileRefused = {
      recorded: await revokedNames(),
      strays: ["STRAY_A", "STRAY_B"].filter((name) => onCore().has(name)),
    };
    await expect(failing(held, unbound)).resolves.toMatchObject({
      code: "probe_unqualified",
    });

    expect({
      whileRefused,
      recorded: await revokedNames(),
      strays: ["STRAY_A", "STRAY_B"].filter((name) => onCore().has(name)),
    }).toStrictEqual({
      whileRefused: { recorded: [], strays: ["STRAY_A", "STRAY_B"] },
      recorded: ["STRAY_A", "STRAY_B"],
      strays: [],
    });
  });

  it("records the secrets an upload dropped when its run dies after it landed, on the next run", async () => {
    const manifest = await importRelease();
    const { account, clientId, held } = await setUp(manifest);
    await expect(failing(held, unbound)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    const { core } = await scriptsOf(clientId);
    const onCore = (): Map<string, string> =>
      account.namespaces.get(namespace)?.get(core)?.versions.at(-1)?.secrets ??
      new Map<string, string>();
    onCore().set("STRAY_KEY", "stray-value");

    // Core's upload lands, without the stray; its run dies reading it back.
    let reads = 0;
    cloudflare.failNext((call) => {
      if (call.method === "GET" && call.path.endsWith(`/scripts/${core}`)) {
        reads += 1;
      }
      return reads === 2;
    }, 400);
    await expect(failing(held)).resolves.toBeDefined();
    const afterDeath = {
      onCore: onCore().has("STRAY_KEY"),
      recorded: await revokedNamesOf(clientId),
    };
    await expect(failing(held, unbound)).resolves.toMatchObject({
      code: "probe_unqualified",
    });

    expect({
      afterDeath,
      recorded: await revokedNamesOf(clientId),
    }).toStrictEqual({
      afterDeath: { onCore: false, recorded: [] },
      recorded: ["STRAY_KEY"],
    });
  });

  it("records a shared secret an upload dropped when its run died after it landed, though it is given again by the next run", async () => {
    const manifest = await importRelease();
    const { account, clientId, held } = await setUp(manifest);
    await expect(failing(held, unbound)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    const { connect } = await scriptsOf(clientId);
    const onConnect = (): Map<string, string> =>
      account.namespaces.get(namespace)?.get(connect)?.versions.at(-1)
        ?.secrets ?? new Map<string, string>();
    const { COMPOSIO_API_KEY: _dropped, ...rest } =
      secrets.shared.connect ?? {};

    // Composio's key is no longer given: connect's upload lands without
    // it, and its run dies reading it back.
    let reads = 0;
    cloudflare.failNext((call) => {
      if (call.method === "GET" && call.path.endsWith(`/scripts/${connect}`)) {
        reads += 1;
      }
      return reads === 2;
    }, 400);
    await expect(
      failing(held, {
        ...unbound,
        secrets: { ...secrets, shared: { connect: rest } },
      })
    ).resolves.toBeDefined();
    const afterDeath = {
      onConnect: onConnect().has("COMPOSIO_API_KEY"),
      recorded: await revokedNamesOf(clientId),
    };
    // Given again before the retry: its upload gives the key back.
    await expect(failing(held, unbound)).resolves.toMatchObject({
      code: "probe_unqualified",
    });

    expect({
      afterDeath,
      onConnect: onConnect().has("COMPOSIO_API_KEY"),
      recorded: await revokedNamesOf(clientId),
    }).toStrictEqual({
      afterDeath: { onConnect: false, recorded: [] },
      onConnect: true,
      recorded: ["COMPOSIO_API_KEY"],
    });
  });

  it("keeps what Cloudflare's answer to a refused upload says out of its error, as it may quote the upload's secrets", async () => {
    const manifest = await importRelease();
    const { clientId, held } = await setUp(manifest);
    const quoted = "the-value-it-was-sent";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "PUT" && request.url.endsWith("-core")) {
        return Response.json(
          {
            success: false,
            errors: [{ code: 10_021, message: `binding text ${quoted}` }],
            messages: [],
            result: null,
          },
          { status: 400 }
        );
      }
      return await cloudflare.fetch(input, init);
    });

    const error = await failing(held);
    const operation = await operationOf(clientId);
    const recorded = JSON.stringify([
      await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.clientId, clientId)),
      operation,
    ]);

    expect({
      code: operation?.error,
      inError: error instanceof Error && error.message.includes(quoted),
      inRecords: recorded.includes(quoted),
    }).toStrictEqual({
      code: "cloudflare_400_10021",
      inError: false,
      inRecords: false,
    });
  });

  it("marks a rotated client's generation live once its hostname is published, and audits it", async () => {
    const manifest = await importRelease();
    const { clientId, held } = await setUp(manifest);
    await db
      .update(clients)
      .set({ generation: 2, rotatedAt: new Date() })
      .where(eq(clients.id, clientId));

    await runClientProvision(context, held);

    const client = await db
      .select({ rotationLiveAt: clients.rotationLiveAt })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();
    const live = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "client.rotation_live")
        )
      );
    expect({
      live: client?.rotationLiveAt instanceof Date,
      audited: live.map(
        ({ detail }) =>
          z.object({ generation: z.number() }).parse(JSON.parse(detail ?? "{}"))
            .generation
      ),
    }).toStrictEqual({ live: true, audited: [2] });
  });

  it("keeps two clients in one destination to their own resources", async () => {
    const manifest = await importRelease();
    const { account, destinationId, held: firstRun } = await setUp(manifest);
    await runClientProvision(context, firstRun);
    const firstVersions = Object.fromEntries(
      [...clientScripts(account)].map(([name, script]) => [
        name,
        script.versions.length,
      ])
    );
    const firstMigrations = await appliedMigrations(account);

    const second = await placedOperation(destinationId, manifest);
    await runClientProvision(context, second.held);

    const { core, connect } = await scriptsOf(second.clientId);
    const database = await resourceOf(second.clientId, "d1:grasp-os-core");
    expect({
      // The first client's scripts and databases are as it left them.
      versions: Object.fromEntries(
        Object.keys(firstVersions).map((name) => [
          name,
          clientScripts(account).get(name)?.versions.length,
        ])
      ),
      migrations: await appliedMigrations(account),
      // The second's core binds only its own.
      bindings: liveBindings(account, core),
      databases: account.d1.length,
    }).toMatchObject({
      versions: firstVersions,
      migrations: firstMigrations,
      bindings: {
        DB: { id: database.providerId },
        CONNECT: {
          service: platformWorkerName("connect-gateway", "production"),
          props: { script: connect },
        },
      },
      databases: 6,
    });
  });

  it("refuses an inventory id that is another client's database, before migrating or binding it", async () => {
    const manifest = await importRelease();
    const {
      account,
      clientId: first,
      destinationId,
      held: firstRun,
    } = await setUp(manifest);
    await runClientProvision(context, firstRun);
    const firstMigrations = await appliedMigrations(account);
    const victim = await resourceOf(first, "d1:grasp-os-core");

    const second = await placedOperation(destinationId, manifest);
    await allocateClientResources(db, "system", {
      clientId: second.clientId,
      manifest,
      operationId: "test",
    });
    // Its row names the first client's database's id.
    await db
      .update(clientResources)
      .set({
        providerId: victim.providerId,
        createRequestedBy: second.held.runId,
      })
      .where(
        and(
          eq(clientResources.clientId, second.clientId),
          eq(clientResources.role, "d1:grasp-os-core")
        )
      );
    const uploads = account.scriptUploads.length;

    await expect(failing(second.held)).resolves.toMatchObject({
      code: "foreign_resource",
    });
    expect({
      migrations: await appliedMigrations(account),
      uploads: account.scriptUploads.length,
    }).toMatchObject({ migrations: firstMigrations, uploads });
  });
});

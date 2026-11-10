import { platformAccountId, platformWorkerName } from "@grasp-os/shared/names";
import { assetKey } from "@grasp-os/shared/release";
import { deriveRouterSecret } from "@grasp-os/shared/router";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { auditEvents, clientProvisions, clients } from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import {
  allocateClientResources,
  clientInventory,
} from "../src/hosting/inventory.ts";
import {
  ProvisionOperationError,
  runClientProvision,
  startClientProvision,
  startClientRelease,
} from "../src/hosting/operation.ts";
import type { ReleaseStore } from "../src/releases/import.ts";
import { claimRun } from "../src/runners.ts";
import {
  token,
  cloudflare,
  secrets,
  context,
  importRelease,
  setUp,
  operationOf,
  failing,
  codeFrom,
  resourceOf,
  filesSent,
  withBody,
  scriptsOf,
  liveBindings,
  holdings,
  isUpload,
  actionsOf,
  routed,
  provisioned,
  once,
  stops,
  probeFailures,
  refusals,
  liveClient,
  attempt,
  codeOf,
} from "./client-provision-harness.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { clientScripts } from "./grasp-account.ts";
import { db, staff } from "./hosting.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Here: a fresh client provisioned end to end, its uploads, resumes, probes
// and refusals; namespaces, uploads and secrets in
// client-provision-uploads.test.ts, attempts that die or time out in
// client-provision-attempts.test.ts, releases, rollbacks and offboarding in
// client-provision-releases.test.ts, a release's runner crashing in
// client-provision-crashes.test.ts.

mockCloudflareApi(token, cloudflare);

describe("provisioning a placed client", () => {
  useStoreSecrets({ deployer: token });

  it.each(["", "Production", "prod", "staging "])(
    "runs no operation for an admin whose STAGE is %j, before any Cloudflare call",
    async (stage) => {
      const manifest = await importRelease();
      const { clientId, held } = await setUp(manifest);
      const before = cloudflare.calls.length;

      // The admin as its deploy left it, its STAGE misconfigured: never
      // taken for production. Set as a deploy could, past what the
      // generated types allow.
      const deployed = { ...env };
      Reflect.set(deployed, "STAGE", stage);
      const misconfigured = await deployContext(deployed);
      const refused = await runClientProvision(misconfigured, held).then(
        () => null,
        (error: unknown) => error
      );

      expect({
        refused: refused instanceof ProvisionOperationError && refused.code,
        operation: await operationOf(clientId),
        calls: cloudflare.calls.length - before,
      }).toMatchObject({
        refused: "stage_unset",
        operation: { status: "failed", step: null, error: "stage_unset" },
        calls: 0,
      });
    }
  );

  it("provisions a fresh client end to end, its hostname published last", async () => {
    const manifest = await importRelease();
    const { account, clientId, held } = await setUp(manifest);

    await runClientProvision(context, held);

    const { core, connect } = await scriptsOf(clientId);
    // Connect before core, which binds it; each uploaded once.
    await expect(provisioned(account, clientId)).resolves.toMatchObject({
      ...once(clientId),
      uploads: [connect, core],
    });
    // Core binds the client's own database, connect and bucket, and runs
    // as the client, with the router secret the router will send.
    const [database, bucket] = await Promise.all([
      resourceOf(clientId, "d1:grasp-os-core"),
      resourceOf(clientId, "r2:grasp-os-files"),
    ]);
    const live = clientScripts(account).get(core)?.versions.at(-1);
    expect({
      bindings: liveBindings(account, core),
      routerSecret: live?.secrets.get("ROUTER_SECRET"),
    }).toMatchObject({
      bindings: {
        DB: { id: database.providerId },
        CONNECT: {
          service: platformWorkerName("connect-gateway", "production"),
        },
        FILES: { bucket_name: bucket.physicalName },
        CLIENT_ID: { type: "json", json: clientId },
      },
      routerSecret: await deriveRouterSecret(secrets.routerKey, clientId, 1),
    });
    await expect(actionsOf(clientId)).resolves.toStrictEqual([
      "provision.start",
      "provision.validated",
      "provision.resources",
      "provision.migrations",
      "provision.worker_live",
      "provision.connect",
      "provision.worker_live",
      "provision.core",
      "provision.probe",
      "provision.route",
      "provision.done",
    ]);
    // No secret value reaches an audit event or the operation's row.
    const recorded = JSON.stringify([
      await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.clientId, clientId)),
      await operationOf(clientId),
    ]);
    expect(
      [live?.secrets.get("ROUTER_SECRET") ?? "", "composio"].filter((value) =>
        recorded.includes(value)
      )
    ).toStrictEqual([]);
  });

  it("uploads each of core's static files with the type Wrangler gives it, so core serves the compiler's wasm as wasm", async () => {
    // One file of each kind core's built assets hold (apps/web/dist, with
    // the compiler and extractor built into it).
    const types = {
      "/index.html": "text/html; charset=utf-8",
      "/assets/index.js": "text/javascript; charset=utf-8",
      "/assets/index.css": "text/css; charset=utf-8",
      "/assets/tide.avif": "image/avif",
      "/assets/geist.woff2": "font/woff2",
      "/favicon.svg": "image/svg+xml",
      "/_compiler/v1/kit.json": "application/json",
      "/_compiler/v1/esbuild.wasm": "application/wasm",
    };
    const manifest = await importRelease({
      assets: Object.fromEntries(
        Object.keys(types).map((path) => [
          path,
          `${path} ${crypto.randomUUID()}`,
        ])
      ),
    });
    const { account, clientId, held } = await setUp(manifest);

    await runClientProvision(context, held);

    const { core } = await scriptsOf(clientId);
    const session = cloudflare.calls.findLast(
      ({ path }) =>
        path.includes(`/scripts/${core}/`) &&
        path.endsWith("/assets-upload-session")
    );
    const served = z
      .object({
        manifest: z.record(z.string(), z.object({ hash: z.string() })),
      })
      .parse(session?.body).manifest;
    expect(
      Object.fromEntries(
        Object.entries(served).map(([path, { hash }]) => [
          path,
          account.assets.get(hash),
        ])
      )
    ).toStrictEqual(types);
  });

  it("reads core's files from the release only for the request that sends them, never the whole release at once", async () => {
    // Core's release is over 100 MB in memory (its modules, and its static
    // files as base64), past what a Worker may hold: read whole, its
    // deploy's isolate was killed before core went up.
    const manifest = await importRelease({
      assets: Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `/assets/chunk-${index}.js`,
          `export default "${crypto.randomUUID()}";`,
        ])
      ),
    });
    const { core: coreWorker } = manifest.workers;
    const coreFiles = new Set([
      ...(coreWorker?.modules ?? []).map(({ r2Key }) => r2Key),
      ...Object.values(coreWorker?.assets?.manifest ?? {}).map(({ hash }) =>
        assetKey(hash)
      ),
    ]);
    const modules = new Set(coreWorker?.modules.map(({ r2Key }) => r2Key));
    // When each of core's files is read: as the count of calls sent.
    const readAt: number[] = [];
    // Modules read whole rather than streamed.
    const readWhole: string[] = [];
    const store: ReleaseStore = {
      get: async (...args: Parameters<R2Bucket["get"]>) => {
        const [key] = args;
        if (coreFiles.has(key)) {
          readAt.push(cloudflare.calls.length);
        }
        const object = await env.RELEASES.get(...args);
        return object === null || !modules.has(key)
          ? object
          : withBody(object, object.body, () => {
              readWhole.push(key);
            });
      },
      list: async (...args: Parameters<R2Bucket["list"]>) =>
        await env.RELEASES.list(...args),
    };
    const { clientId, held } = await setUp(manifest);

    await runClientProvision({ ...context, store }, held);

    const { core } = await scriptsOf(clientId);
    // Each file is read once, right before the request that carries it:
    // a static files upload, or the script's upload with its modules,
    // each module streamed into it.
    const carriers = [...Map.groupBy(readAt, (at) => at)].map(([at, reads]) => {
      const path = cloudflare.calls[at]?.path ?? "";
      return {
        to: path.endsWith(`/scripts/${core}`) ? "script" : path,
        read: reads.length,
        sent: filesSent(cloudflare.calls[at]),
      };
    });
    const script = carriers.pop();
    expect(readWhole).toStrictEqual([]);
    expect(readAt).toHaveLength(coreFiles.size);
    expect(carriers).toStrictEqual(
      carriers.map(({ sent }) => ({
        to: `/accounts/${platformAccountId}/workers/assets/upload`,
        read: sent,
        sent,
      }))
    );
    expect(script).toStrictEqual({
      to: "script",
      read: modules.size,
      sent: modules.size,
    });
  });

  it("uploads a first deploy's static files before core's script, so they don't spend its send limit", async () => {
    // Forty static files, each upload answered after 50 ms: one file a
    // request in the script's window would take 2 s of its 500 ms.
    const manifest = await importRelease({
      assets: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `/assets/chunk-${index}.js`,
          `export default "${crypto.randomUUID()}";`,
        ])
      ),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("/workers/assets/upload")) {
        await scheduler.wait(50);
      }
      return await cloudflare.fetch(request);
    });
    const { clientId, held } = await setUp(manifest);

    await runClientProvision({ ...context, sendTimeoutMs: 500 }, held);

    await expect(operationOf(clientId)).resolves.toMatchObject({
      status: "done",
      error: null,
    });
  });

  it("stops core's upload before the last chunk of a module whose bytes aren't the release's, doesn't retry it, and still lets the client roll back past the migration it never ran", async () => {
    const live = await importRelease();
    const { account, clientId } = await liveClient(live);
    // A release with a new Durable Object migration, which core never runs.
    const manifest = await importRelease(
      { notes: "feat(core): new class", core: "export default { core: 9 };" },
      (entry) => ({
        ...entry,
        durableObjectMigrations: [
          ...entry.durableObjectMigrations,
          { tag: "v2", new_sqlite_classes: ["Extra"] },
        ],
      })
    );
    const [module] = manifest.workers.core?.modules ?? [];
    if (module === undefined) {
      throw new Error("The test release's core has no module");
    }
    // The module in R2 changed since the import: its size the same, its
    // bytes reversed, read in three chunks.
    const stored = await env.RELEASES.get(module.r2Key);
    const bytes = new Uint8Array(
      (await stored?.arrayBuffer()) ?? []
    ).toReversed();
    const third = Math.ceil(bytes.length / 3);
    const chunks = [0, 1, 2].map((index) =>
      bytes.slice(index * third, (index + 1) * third)
    );
    const store: ReleaseStore = {
      get: async (...args: Parameters<R2Bucket["get"]>) => {
        const object = await env.RELEASES.get(...args);
        if (object === null || args[0] !== module.r2Key) {
          return object;
        }
        await object.body.cancel();
        return withBody(
          object,
          new ReadableStream({
            start: (controller) => {
              for (const chunk of chunks) {
                controller.enqueue(chunk);
              }
              controller.close();
            },
          }),
          () => {
            throw new Error("Read whole");
          }
        );
      },
      list: async (...args: Parameters<R2Bucket["list"]>) =>
        await env.RELEASES.list(...args),
    };
    // What core's upload sent before it stopped.
    const sent: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "PUT" || !request.url.endsWith("-core")) {
        return await cloudflare.fetch(request);
      }
      let text = "";
      try {
        for await (const chunk of request.body?.pipeThrough(
          new TextDecoderStream()
        ) ?? []) {
          text += chunk;
        }
      } finally {
        sent.push(text);
      }
      return await cloudflare.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: text,
      });
    });
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: manifest.releaseId,
    });

    const failure = await failing(await attempt(clientId), {
      ...context,
      store,
    });

    const decoder = new TextDecoder();
    const [first = "", second = "", last = ""] = chunks.map((chunk) =>
      decoder.decode(chunk)
    );
    const { progress } = (await operationOf(clientId)) ?? {};
    expect({
      code: codeFrom(failure),
      // Sent once.
      sends: sent.length,
      // What core ran is recorded as it was: v1, never v2.
      migrated: z
        .object({ migrated: z.record(z.string(), z.string().nullable()) })
        .parse(JSON.parse(progress ?? "{}")).migrated.core,
      ran: [...clientScripts(account)]
        .filter(([name]) => name.endsWith("-core"))
        .map(([, script]) => script.migrationTag),
      rollback: await codeOf(
        startClientRelease(db, staff, await attempt(clientId), {
          rollback: true,
        })
      ),
    }).toStrictEqual({
      code: "release_blob_mismatch",
      sends: 1,
      migrated: "v1",
      ran: ["v1"],
      rollback: "started",
    });
    // Up to the module's last chunk, and never whole.
    expect(sent[0]).toContain(`${first}${second}`);
    expect(sent[0]).not.toContain(`${first}${second}${last}`);
  });

  it("does nothing once done", async () => {
    const manifest = await importRelease();
    const { clientId, held } = await setUp(manifest);
    await runClientProvision(context, held);

    const before = cloudflare.calls.length;
    await runClientProvision(context, held);
    expect(cloudflare.calls).toHaveLength(before);
    await expect(operationOf(clientId)).resolves.toMatchObject({
      status: "done",
    });
  });

  it("starting it again resumes the client's one operation, switched to a newer or an older release while nothing is live", async () => {
    const older = await importRelease();
    const manifest = await importRelease();
    const { clientId, operationId, held } = await setUp(manifest);
    await expect(
      startClientProvision(db, staff, held, manifest.releaseId)
    ).resolves.toBe(operationId);
    await expect(
      startClientProvision(db, staff, held, older.releaseId)
    ).resolves.toBe(operationId);
    const newer = await importRelease();
    await expect(
      startClientProvision(db, staff, held, newer.releaseId)
    ).resolves.toBe(operationId);
    await expect(
      db
        .select({
          id: clientProvisions.id,
          releaseId: clientProvisions.releaseId,
        })
        .from(clientProvisions)
        .where(eq(clientProvisions.clientId, clientId))
    ).resolves.toStrictEqual([{ id: operationId, releaseId: newer.releaseId }]);
  });

  it("keeps a live client's operation on its release: provisioning never switches what runs", async () => {
    const manifest = await importRelease();
    const { clientId, held } = await setUp(manifest);
    await runClientProvision(context, held);
    const newer = await importRelease();

    await expect(
      startClientProvision(db, staff, held, newer.releaseId)
    ).rejects.toMatchObject({ code: "operation_release_changed" });
    await expect(operationOf(clientId)).resolves.toMatchObject({
      releaseId: manifest.releaseId,
      status: "done",
    });
  });

  it.each(stops)(
    "resumes after stopping at $step, creating nothing twice",
    async ({ stopped, code, plan }) => {
      const manifest = await importRelease();
      const { account, clientId, held } = await setUp(manifest);
      // Allocated first, so a plan can name the client's scripts: the
      // operation's own allocation finds it.
      await allocateClientResources(db, "system", {
        clientId,
        manifest,
        operationId: "test",
      });
      await plan(account, clientId);

      await failing(held);
      await expect(operationOf(clientId)).resolves.toMatchObject({
        status: "failed",
        step: stopped,
        error: code,
      });
      await expect(routed(clientId)).resolves.toBeFalsy();

      cloudflare.coreOf(clientId).unhealthy = 0;
      await runClientProvision(context, held);

      const state = await provisioned(account, clientId);
      expect(state).toMatchObject(once(clientId));
      expect({
        d1: new Set(state.holdings.d1).size,
        buckets: new Set(state.holdings.buckets).size,
        scripts: state.holdings.scripts.length,
        // Neither the failed run nor its retry removes anything.
        deleted: cloudflare.calls
          .filter((call) => call.method === "DELETE")
          .map(({ path }) => path),
      }).toStrictEqual({ d1: 3, buckets: 2, scripts: 2, deleted: [] });
    }
  );

  it("stops a runner that lost the client, which writes nothing more, and its successor finishes", async () => {
    const manifest = await importRelease();
    const { account, clientId, held: stale } = await setUp(manifest);
    await allocateClientResources(db, "system", {
      clientId,
      manifest,
      operationId: "test",
    });
    const { core } = await scriptsOf(clientId);
    let successor = "";
    // A new attempt takes the client over while the stale one's core upload is in flight.
    cloudflare.beforeAnswering(isUpload(core), async () => {
      successor =
        (await claimRun(
          db,
          staff,
          clientId,
          stale.runId,
          { action: "client.provision_placed", clientId },
          { kind: "provision_placed", runId: `${clientId}-p2` }
        )) ?? "";
    });

    await expect(failing(stale)).resolves.toMatchObject({
      code: "runner_replaced",
    });
    // Neither its upload nor its failure is recorded; run again, it calls nothing.
    const before = cloudflare.calls.length;
    await expect(failing(stale)).resolves.toMatchObject({
      code: "runner_replaced",
    });
    await expect(operationOf(clientId)).resolves.toMatchObject({
      status: "running",
      step: "connect",
      error: null,
    });
    expect(cloudflare.calls).toHaveLength(before);

    await runClientProvision(context, { clientId, runId: successor });
    await expect(provisioned(account, clientId)).resolves.toMatchObject({
      ...once(clientId),
      operation: { status: "done", runId: successor },
    });
  });

  it("leaves the hostname unpublished while core fails its probe", async () => {
    const manifest = await importRelease();
    const { account, clientId, held } = await setUp(manifest);
    cloudflare.coreOf(clientId).unhealthy = 1000;

    await expect(failing(held)).resolves.toMatchObject({
      code: "smoke_check_failed",
    });
    const [client] = await db
      .select({ status: clients.status })
      .from(clients)
      .where(eq(clients.id, clientId));
    expect({
      operation: await operationOf(clientId),
      routed: await routed(clientId),
      status: client?.status,
      // Its inventory stays, for the retry.
      scripts: holdings(account).scripts.length,
    }).toMatchObject({
      operation: {
        status: "failed",
        step: "core",
        error: "smoke_check_failed",
      },
      routed: false,
      status: "provisioning",
      scripts: 2,
    });
  });

  it.each(probeFailures)(
    "leaves the hostname unpublished while core's signed probe finds $name, and resumes once it checks out",
    async ({ probe, code }) => {
      const manifest = await importRelease();
      const { account, clientId, held } = await setUp(manifest);
      cloudflare.coreOf(clientId).coreProbe = probe;

      await expect(failing(held)).resolves.toMatchObject({ code });
      expect({
        operation: await operationOf(clientId),
        routed: await routed(clientId),
      }).toMatchObject({
        operation: { status: "failed", step: "core", error: code },
        routed: false,
      });

      delete cloudflare.coreOf(clientId).coreProbe;
      await runClientProvision(context, held);
      await expect(provisioned(account, clientId)).resolves.toMatchObject(
        once(clientId)
      );
    }
  );

  it("delivers a secret again on retry when it was deleted after its delivery", async () => {
    const manifest = await importRelease();
    const { account, clientId, held } = await setUp(manifest);
    cloudflare.coreOf(clientId).unhealthy = 1000;
    await expect(failing(held)).resolves.toMatchObject({
      code: "smoke_check_failed",
    });
    const { core } = await scriptsOf(clientId);
    clientScripts(account)
      .get(core)
      ?.versions.at(-1)
      ?.secrets.delete("ROUTER_SECRET");

    cloudflare.coreOf(clientId).unhealthy = 0;
    await runClientProvision(context, held);
    await expect(
      Promise.all([operationOf(clientId), routed(clientId)])
    ).resolves.toMatchObject([{ status: "done" }, true]);
    expect(
      clientScripts(account)
        .get(core)
        ?.versions.at(-1)
        ?.secrets.get("ROUTER_SECRET")
    ).toBe(await deriveRouterSecret(secrets.routerKey, clientId, 1));
  });

  it.each(refusals)(
    "refuses $name before anything is created or uploaded",
    async ({ adjust, code }) => {
      const manifest = await importRelease({}, adjust);
      const { account, clientId, held } = await setUp(manifest);

      await expect(failing(held)).resolves.toMatchObject({ code });
      expect({
        operation: await operationOf(clientId),
        databases: account.d1.length,
        uploads: account.scriptUploads.length,
        inventory: await clientInventory(db, clientId),
      }).toMatchObject({
        operation: { status: "failed", step: null, error: code },
        databases: 0,
        uploads: 0,
        inventory: [],
      });
    }
  );
});

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";

import { clientDeploys, clients } from "../src/db/schema.ts";
import { mappedRoute } from "../src/deploy/router.ts";
import { offboardPlacedClient } from "../src/hosting/offboarding.ts";
import {
  runClientProvision,
  startClientRelease,
} from "../src/hosting/operation.ts";
import { pinClient } from "../src/rollout/channels.ts";
import { reconcile } from "../src/rollout/reconciler.ts";
import { currentRun } from "../src/runners.ts";
import { adminWorkflows } from "../src/workflow-runs.ts";
import {
  token,
  cloudflare,
  domain,
  context,
  importRelease,
  operationOf,
  failing,
  scriptsOf,
  isUpload,
  liveClient,
  attempt,
  runs,
  codeOf,
  crashPoints,
  walk,
  expectedOf,
  crashedAt,
} from "./client-provision-harness.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, staff } from "./hosting.ts";
import { ended, startsOf } from "./runs.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Here: a release's runner crashing, and another action on the client
// after; the rest in the other client-provision-*.test.ts files.

mockCloudflareApi(token, cloudflare);

describe("a release's runner crashing, and another action on the client after", () => {
  useStoreSecrets({ deployer: token });

  it("keeps the worst case when core's upload gets a 4xx Cloudflare didn't write: a rollback past its new migration stays refused", async () => {
    const point = crashPoints.find(({ at }) => at === "after connect's upload");
    if (point === undefined) {
      throw new Error("No such crash point");
    }
    const { clientId } = await crashedAt({
      ...point,
      plan: ({ core }) => {
        // Refused, by its status, but by no answer of Cloudflare's: what
        // reached it may have run.
        cloudflare.failNext(isUpload(core), "400-uncoded");
      },
    });

    const back = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), {
        rollback: true,
      })
    );

    expect(back).toBe("rollback_past_migration");
  });

  it("keeps the way back across two forward moves that each stop part way, so a rollback takes it back to the last whole release", async () => {
    const a = await importRelease();
    const { clientId } = await liveClient(a);
    const { core } = await scriptsOf(clientId);
    const b = await importRelease({
      notes: "feat(core): b",
      core: "export default { core: 'b2' };",
    });
    const l = await importRelease({
      notes: "feat(core): l",
      core: "export default { core: 'l' };",
    });
    // B stops after connect's upload, core's refused: split, B and A.
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: b.releaseId,
    });
    cloudflare.failNext(isUpload(core), 400);
    await failing(await attempt(clientId));
    const afterB = await runs(clientId);
    // L, from that split, stops the same way: split, L and A.
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: l.releaseId,
    });
    cloudflare.failNext(isUpload(core), 400);
    await failing(await attempt(clientId));
    const afterL = await runs(clientId);
    const operation = await operationOf(clientId);
    const carried = operation?.previousReleaseId;

    const holder = await attempt(clientId);
    const back = await codeOf(
      startClientRelease(db, staff, holder, { rollback: true })
    );
    await runClientProvision(context, holder);

    expect({
      afterB,
      afterL,
      carried,
      back,
      endsOn: await runs(clientId),
    }).toStrictEqual({
      afterB: { connect: b.releaseId, core: a.releaseId },
      afterL: { connect: l.releaseId, core: a.releaseId },
      // A, the last whole release, carried forward across both.
      carried: a.releaseId,
      back: "started",
      endsOn: { connect: a.releaseId, core: a.releaseId },
    });
  });

  it.each(walk)(
    "$at, then $action: ends coherent, by what its Workers ran, and the dead runner writes nothing",
    async ({ action, ...point }) => {
      const { clientId, dead, a, b, c } = await crashedAt(point);

      // The next action, as a new holder.
      const holder = await attempt(clientId);
      const to =
        action === "rollback"
          ? { rollback: true as const }
          : { releaseId: action === "resume" ? b.releaseId : c.releaseId };
      const startedAs = await codeOf(startClientRelease(db, staff, holder, to));
      if (startedAs === "started") {
        await runClientProvision(context, holder);
      }
      const settled = await operationOf(clientId);
      // The dead runner, waking: writes nothing.
      const staleWrote =
        dead === undefined
          ? false
          : await failing(dead).then(
              async () =>
                JSON.stringify(await operationOf(clientId)) !==
                JSON.stringify(settled)
            );

      const expected = expectedOf(point, action, {
        a: a.releaseId,
        b: b.releaseId,
        c: c.releaseId,
      });

      expect({
        startedAs,
        operation: settled,
        runs: await runs(clientId),
        staleWrote,
      }).toMatchObject({
        startedAs: expected.startedAs,
        ...(expected.releaseId === undefined
          ? {}
          : {
              operation: {
                releaseId: expected.releaseId,
                status: "done",
                ...(expected.previousReleaseId === undefined
                  ? {}
                  : { previousReleaseId: expected.previousReleaseId }),
              },
              runs: { core: expected.releaseId, connect: expected.releaseId },
            }),
        staleWrote: false,
      });
    }
  );

  it("offboards or deploys a client asked for both at once, never both: the loser changes nothing", async () => {
    const first = await importRelease();
    const { clientId } = await liveClient(first);
    const later = await importRelease({
      notes: "feat(core): later",
    });
    const hostname = `${clientId}.${domain}`;
    // Pinned to a later release: the reconciler's next tick deploys it.
    await pinClient(env, staff, { clientId, releaseId: later.releaseId });
    using deploys = startsOf(adminWorkflows.deploy);
    const [offboarded] = await Promise.all([
      codeOf(offboardPlacedClient(env, staff, clientId)),
      reconcile(env),
    ]);
    const { started } = deploys;
    await Promise.all(
      started.map(async (id) => {
        await ended(adminWorkflows.deploy, id);
      })
    );
    const client = await db
      .select({ status: clients.status })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();
    const route = await mappedRoute(env.ROUTER_HOSTS, hostname);
    const offboardWon = offboarded === "started";

    expect({
      oneWon: offboardWon !== started.length > 0,
      status: client?.status,
      routed: route !== null,
    }).toStrictEqual({
      oneWon: true,
      status: offboardWon ? "offboarded" : "active",
      // Offboarded: never routed again; deployed: still served.
      routed: !offboardWon,
    });
  });

  it("holds the client while it offboards: a reconciler tick as its hostname is deleted can't claim it, and deploys nothing", async () => {
    const first = await importRelease();
    const { clientId } = await liveClient(first);
    const later = await importRelease({
      notes: "feat(core): later",
    });
    await pinClient(env, staff, { clientId, releaseId: later.releaseId });
    using deploys = startsOf(adminWorkflows.deploy);
    let ticked = false;
    const remove = env.ROUTER_HOSTS.delete.bind(env.ROUTER_HOSTS);
    const deleting = vi
      .spyOn(env.ROUTER_HOSTS, "delete")
      .mockImplementationOnce(async (key: string) => {
        // The cron's tick while offboarding deletes the route.
        await reconcile(env);
        ticked = true;
        await remove(key);
      });

    const offboarded = await codeOf(offboardPlacedClient(env, staff, clientId));
    deleting.mockRestore();
    const deploy = await db
      .select({ clientId: clientDeploys.clientId })
      .from(clientDeploys)
      .where(eq(clientDeploys.clientId, clientId))
      .get();

    expect({
      offboarded,
      ticked,
      started: deploys.started.length,
      deploy,
      route: await mappedRoute(env.ROUTER_HOSTS, `${clientId}.${domain}`),
    }).toStrictEqual({
      offboarded: "started",
      ticked: true,
      started: 0,
      deploy: undefined,
      route: null,
    });
  });

  it("keeps a client it couldn't unroute as it was, the route and its claim given back, and offboards it when tried again", async () => {
    const first = await importRelease();
    const { clientId } = await liveClient(first);
    const hostname = `${clientId}.${domain}`;
    const deleting = vi
      .spyOn(env.ROUTER_HOSTS, "delete")
      .mockRejectedValueOnce(new Error("KV unavailable"));

    const failed = await codeOf(offboardPlacedClient(env, staff, clientId));
    deleting.mockRestore();
    const row = await db
      .select({ status: clients.status })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();
    const stillRouted = await mappedRoute(env.ROUTER_HOSTS, hostname);
    const afterFailure = {
      status: row?.status,
      routed: stillRouted !== null,
      claimed: await currentRun(env, clientId),
    };
    const retried = await codeOf(offboardPlacedClient(env, staff, clientId));

    expect({
      failed,
      afterFailure,
      retried,
      route: await mappedRoute(env.ROUTER_HOSTS, hostname),
    }).toMatchObject({
      failed: "thrown",
      afterFailure: { status: "active", routed: true, claimed: null },
      retried: "started",
      route: null,
    });
  });

  it.each(crashPoints)(
    "$at, then offboarding: unrouted at once, and neither the dead runner nor a later start serves it again",
    async (point) => {
      const { clientId, dead, b } = await crashedAt(point);
      const hostname = `${clientId}.${domain}`;

      const offboarded = await codeOf(
        offboardPlacedClient(env, staff, clientId)
      );
      const routeAfter = await mappedRoute(env.ROUTER_HOSTS, hostname);
      const settled = await operationOf(clientId);
      // The dead runner, waking: holds nothing, writes and routes nothing.
      const stale =
        dead === undefined
          ? "none"
          : String(
              await failing(dead).then((error) =>
                error instanceof Error && "code" in error ? error.code : error
              )
            );
      const later = await codeOf(
        startClientRelease(db, staff, await attempt(clientId), {
          releaseId: b.releaseId,
        })
      );
      let staleExpected = "none";
      if (point.started) {
        staleExpected = "runner_replaced";
      } else if (dead !== undefined) {
        staleExpected = "null";
      }

      expect({
        offboarded,
        routeAfter,
        stale: dead === undefined ? "none" : stale,
        unchanged:
          JSON.stringify(await operationOf(clientId)) ===
          JSON.stringify(settled),
        routeAtEnd: await mappedRoute(env.ROUTER_HOSTS, hostname),
        later,
      }).toStrictEqual({
        offboarded: "started",
        routeAfter: null,
        // It lost its claim with the offboarding; one that never started
        // finds its operation done, and runs nothing.
        stale: staleExpected,
        unchanged: true,
        routeAtEnd: null,
        later: "client_not_active",
      });
    }
  );
});

/**
 * Sessions on the on-prem sandbox, on plain workerd: a stand-in core
 * (apps/core/test/workerd/session-worker.ts) runs the same `runInSession`
 * core runs, with `SANDBOX_HOST` bound to the supervisor
 * (workerd-sandbox.ts). No Wrangler dev server, no Miniflare.
 *
 * Each owner's share of the pool, and the sessions that wait for their
 * owner's room; workerd-sandbox-session-pool.test.ts has the rest of the
 * pool, apart so each owner's waits run on a worker of their own.
 */
import { connect } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  callIdHeader,
  cpuHeader,
  deadlineHeader,
  nativeWorkerd,
  ownerHeader,
  startSandboxSupervisor,
  waitHeader,
} from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import { runIn } from "./workerd-session-cases.ts";
import { serveStandIn } from "./workerd-stand-in.ts";
import { cleanUp } from "./workerd-test-server.ts";

describe("a session on the on-prem sandbox", () => {
  let supervisor: SandboxSupervisor;
  let coreUrl: string;

  beforeAll(async () => {
    supervisor = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 2,
      log: () => {},
    });
    coreUrl = await serveStandIn("session-worker.ts", supervisor.socket);
  }, 120_000);

  afterAll(async () => {
    await supervisor.stop();
    cleanUp();
  });

  const run = runIn(() => coreUrl);

  it(
    "lets one owner hold only its share of the pool",
    { timeout: 30_000 },
    async () => {
      const holding = run("holds", "app-one");
      await expect
        .poll(() => supervisor.stats().inFlight, { timeout: 3000 })
        .toBe(1);
      // Half of two processes: app-one holds as many as it may, past the
      // time a session waits for its owner's room.
      await expect(run("capabilities", "app-one")).resolves.toMatchObject({
        status: "refused",
        verdict: "busy",
      });
      await expect(run("capabilities", "app-two")).resolves.toMatchObject({
        status: "ok",
      });
      await expect(holding).resolves.toMatchObject({ status: "ok" });
    }
  );

  it(
    "refuses an owner's session at once while as many of its sessions wait as it may hold",
    { timeout: 30_000 },
    async () => {
      const holding = run("holds", "app-one");
      await expect
        .poll(() => supervisor.stats().inFlight, { timeout: 3000 })
        .toBe(1);
      // app-one may hold one: one more may wait for it, a third may not.
      const waiting = run("capabilities", "app-one");
      await expect
        .poll(() => supervisor.stats().waitingForOwners, { timeout: 2000 })
        .toBe(1);
      const third = await run("capabilities", "app-one");
      expect(third).toMatchObject({ status: "refused", verdict: "busy" });
      expect(third.ms).toBeLessThan(1000);
      await expect(waiting).resolves.toMatchObject({ verdict: "busy" });
      await expect(holding).resolves.toMatchObject({ status: "ok" });
    }
  );

  it(
    "counts the sessions waiting for their owner's room toward what the pool takes",
    { timeout: 60_000 },
    async () => {
      // Two processes and one more call waiting: three in all.
      const small = await startSandboxSupervisor({
        workerd: nativeWorkerd,
        processes: 2,
        maxWaiting: 1,
        log: () => {},
      });
      try {
        const url = await serveStandIn("session-worker.ts", small.socket);
        const holdingOne = run("holds", "app-one", url);
        const holdingTwo = run("holds", "app-two", url);
        await expect
          .poll(() => small.stats().inFlight, { timeout: 3000 })
          .toBe(2);
        // Waits for app-one's room: the third of three.
        const waiting = run("capabilities", "app-one", url);
        await expect
          .poll(() => small.stats().waitingForOwners, { timeout: 2000 })
          .toBe(1);
        const fourth = await run("capabilities", "app-three", url);
        expect(fourth).toMatchObject({
          status: "unavailable",
          refusedStatus: 503,
        });
        expect(fourth.ms).toBeLessThan(1000);
        await Promise.all([holdingOne, holdingTwo, waiting]);
      } finally {
        await small.stop();
      }
    }
  );

  it(
    "keeps serving once core leaves a session that waits for its owner's room",
    { timeout: 30_000 },
    async () => {
      const holding = run("holds", "app-one");
      await expect
        .poll(() => supervisor.stats().inFlight, { timeout: 3000 })
        .toBe(1);
      // A session of app-one's, opened as core opens one, waiting for its
      // room; core gives up on it (a run cancelled meanwhile) before its
      // wait is over, so its refusal finds core's end of the socket gone.
      const left = connect(supervisor.socket);
      left.on("error", () => {});
      left.write(
        [
          "GET /session HTTP/1.1",
          "host: sandbox",
          "connection: upgrade",
          "upgrade: websocket",
          "sec-websocket-version: 13",
          "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==",
          `${deadlineHeader}: 20000`,
          `${cpuHeader}: 5000`,
          `${waitHeader}: 500`,
          `${callIdHeader}: ${crypto.randomUUID()}`,
          `${ownerHeader}: app-one`,
          "\r\n",
        ].join("\r\n")
      );
      await expect
        .poll(() => supervisor.stats().waitingForOwners, { timeout: 2000 })
        .toBe(1);
      left.destroy();
      await expect
        .poll(() => supervisor.stats().waitingForOwners, { timeout: 2000 })
        .toBe(0);
      await expect(run("capabilities", "app-two")).resolves.toMatchObject({
        status: "ok",
      });
      await expect(holding).resolves.toMatchObject({ status: "ok" });
    }
  );
});

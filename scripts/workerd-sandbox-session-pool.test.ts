/**
 * Sessions on the on-prem sandbox, on plain workerd: a stand-in core
 * (apps/core/test/workerd/session-worker.ts) runs the same `runInSession`
 * core runs, with `SANDBOX_HOST` bound to the supervisor
 * (workerd-sandbox.ts), and passes capabilities of its own into isolates
 * that reach back through them. No Wrangler dev server, no Miniflare.
 *
 * Cancelled and crowded calls, each owner's share of the pool, a sandbox
 * that never answers or doesn't bound CPU time, and one that is gone;
 * workerd-sandbox-session.test.ts has the rest.
 */
import { once } from "node:events";
import type { Socket } from "node:net";
import { connect, createServer } from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { nativeWorkerd, startSandboxSupervisor } from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import { runIn } from "./workerd-session-cases.ts";
import { serveStandIn } from "./workerd-stand-in.ts";
import { cleanUp, tempDir } from "./workerd-test-server.ts";

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
    "frees a cancelled call's process while core's end of its socket is still open",
    { timeout: 20_000 },
    async () => {
      const lingering = run("cancelledLingering");
      // Core holds its socket for 5 s past the cancel: only the supervisor's
      // own cancel frees the process before then.
      await expect
        .poll(() => supervisor.stats().inFlight, {
          timeout: 2500,
          interval: 50,
        })
        .toBe(1);
      await expect
        .poll(() => supervisor.stats().inFlight, {
          timeout: 2500,
          interval: 50,
        })
        .toBe(0);
      const outcome = await lingering;
      expect(outcome.message).toContain("cancelled");
    }
  );

  it(
    "runs no more calls in a session than core lets one call run",
    { timeout: 30_000 },
    async () => {
      const outcome = await run("manyRuns");
      expect(outcome.status).toBe("ok");
      // The call itself, and 64 nested, each run up to four times.
      expect(outcome).toMatchObject({
        nestedRan: 259,
        nestedRefused: 1,
        refusedVerdict: "call_limit",
      });
    }
  );

  it(
    "refuses its capabilities the moment core gives up on the call",
    { timeout: 20_000 },
    async () => {
      const outcome = await run("keepsCalling");
      expect(outcome.message).toContain("didn't end the call in time");
      expect(outcome.pinged).toBeGreaterThan(0);
      expect(outcome.reachedAfterGivingUp).toBe(0);
    }
  );

  it("keeps an error the App's code threw its own, whatever it says of itself", async () => {
    const outcome = await run("forgesVerdict");
    expect(outcome).toMatchObject({ status: "refused", verdict: null });
    expect(outcome.message).toContain("forged");
  });

  it(
    "ends a call as the sandbox unavailable, never the App's fault, when the isolate's sessions hold their pool",
    { timeout: 30_000 },
    async () => {
      const outcome = await run("crowded");
      expect(outcome).toMatchObject({ status: "unavailable", verdict: null });
      expect(outcome.message).toContain("Core holds as much");
    }
  );

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

  /**
   * A proxy in front of the supervisor that passes a session's upgrade on,
   * but never its answer, and never either end's close to the other: the
   * supervisor holds a process for a session core never hears of.
   */
  const unansweringProxy = (): {
    socket: string;
    close: () => Promise<void>;
  } => {
    const proxy = path.join(tempDir(), "unanswering.sock");
    // Every socket it holds, both ends, closed with it.
    const held = new Set<Socket>();
    const hold = (socket: Socket): void => {
      held.add(socket);
      socket.once("close", () => {
        held.delete(socket);
      });
    };
    const server = createServer((client: Socket) => {
      const upstream = connect(supervisor.socket);
      hold(client);
      hold(upstream);
      upstream.on("error", () => {});
      client.on("error", () => {});
      client.once("data", (first: Buffer) => {
        upstream.write(first);
        if (first.toString("latin1").startsWith("GET /session")) {
          client.on("data", (chunk: Buffer) => {
            upstream.write(chunk);
          });
          return;
        }
        client.pipe(upstream);
        upstream.pipe(client);
      });
    }).listen(proxy);
    return {
      socket: proxy,
      close: async () => {
        for (const socket of held) {
          socket.destroy();
        }
        server.close();
        if (server.listening) {
          await once(server, "close");
        }
      },
    };
  };

  it(
    "ends a session whose upgrade is never answered as unavailable, and frees its process",
    { timeout: 30_000 },
    async () => {
      const proxy = unansweringProxy();
      try {
        const behindProxy = await serveStandIn(
          "session-worker.ts",
          proxy.socket
        );
        const outcome = await run("waitsLong", "app-unanswered", behindProxy);
        expect(outcome.status).toBe("unavailable");
        // Its waits for a process and its owner's room, and a little more.
        expect(outcome.ms).toBeLessThan(12_000);
        await expect
          .poll(() => supervisor.stats().inFlight, {
            timeout: 1500,
            interval: 50,
          })
          .toBe(0);
      } finally {
        await proxy.close();
      }
    }
  );

  it(
    "frees the process of a session core cancels before its upgrade is answered",
    { timeout: 30_000 },
    async () => {
      const proxy = unansweringProxy();
      try {
        const behindProxy = await serveStandIn(
          "session-worker.ts",
          proxy.socket
        );
        const outcome = await run("cancelled", "app-unanswered", behindProxy);
        expect(outcome.message).toContain("cancelled");
        await expect
          .poll(() => supervisor.stats().inFlight, {
            timeout: 1500,
            interval: 50,
          })
          .toBe(0);
      } finally {
        await proxy.close();
      }
    }
  );

  it("refuses to run on a sandbox that doesn't say it bounds the call's CPU time", async () => {
    // A proxy in front of the supervisor that drops what it says.
    const proxy = path.join(tempDir(), "proxy.sock");
    const server = createServer((client: Socket) => {
      const upstream = connect(supervisor.socket);
      let head = true;
      upstream.on("data", (chunk: Buffer) => {
        client.write(
          head
            ? chunk
                .toString("latin1")
                .replace(/\r\nx-grasp-sandbox-cpu-ms: \d+/iu, "")
            : chunk
        );
        head = false;
      });
      client.pipe(upstream);
      upstream.on("close", () => {
        client.destroy();
      });
      client.on("close", () => {
        upstream.destroy();
      });
    }).listen(proxy);
    try {
      const behindProxy = await serveStandIn("session-worker.ts", proxy);
      const outcome = await run("capabilities", "app-stand-in", behindProxy);
      expect(outcome.status).toBe("unavailable");
      expect(outcome.message).toContain("doesn't bound");
    } finally {
      server.close();
    }
  });

  it("says the sandbox is unavailable, not the App's fault, when the supervisor is gone", async () => {
    await supervisor.stop();
    await expect(run("capabilities")).resolves.toMatchObject({
      status: "unavailable",
    });
  });
});

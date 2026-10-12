/**
 * Sessions on the on-prem sandbox, on plain workerd: a stand-in core
 * (apps/core/test/workerd/session-worker.ts) runs the same `runInSession`
 * core runs, with `SANDBOX_HOST` bound to the supervisor
 * (workerd-sandbox.ts), and passes capabilities of its own into isolates
 * that reach back through them. No Wrangler dev server, no Miniflare.
 */
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { nativeWorkerd, startSandboxSupervisor } from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import { serveStandIn } from "./workerd-stand-in.ts";
import { cleanUp, tempDir } from "./workerd-test-server.ts";

/** How long core may take to answer another request meanwhile. */
const ANSWER_MS = 500;

const outcomeSchema = z.object({
  status: z.enum(["ok", "refused", "unavailable"]),
  value: z.unknown().optional(),
  message: z.string().optional(),
  ms: z.number(),
  reachedAfter: z.number(),
  reachedInternal: z.number(),
  reachedAfterGivingUp: z.number(),
  pinged: z.number(),
  verdict: z.string().nullable().optional(),
  logged: z.array(z.unknown()),
});

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

  const run = async (name: string, owner = "app-stand-in", url = coreUrl) => {
    const response = await fetch(`${url}run?case=${name}&owner=${owner}`);
    return outcomeSchema.parse(await response.json());
  };

  /** How long core takes to answer a request that runs no App code. */
  const answerTime = async (): Promise<number> => {
    const started = Date.now();
    const response = await fetch(coreUrl, {
      signal: AbortSignal.timeout(2000),
    });
    await response.text();
    return Date.now() - started;
  };

  it("hands the isolate core's capabilities, as objects and functions, with callbacks both ways and an empty env", async () => {
    const outcome = await run("capabilities");
    expect(outcome).toMatchObject({
      status: "ok",
      value: { a: 101, b: 41, c: 102, env: [] },
      logged: ["started"],
    });
  });

  it("ends a busy loop on its CPU-time budget while core keeps answering", async () => {
    const busy = run("busy");
    const answers: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, during the loop
      answers.push(await answerTime());
    }
    const outcome = await busy;
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("CPU time");
    // Its 500 ms of CPU, read every 100 ms, well before its wall-clock cap.
    expect(outcome.ms).toBeLessThan(3000);
    expect(Math.max(...answers)).toBeLessThan(ANSWER_MS);
    expect(supervisor.stats().cpu).toBeGreaterThanOrEqual(1);
  });

  it("doesn't count time spent waiting on core against the CPU budget", async () => {
    await expect(run("waits")).resolves.toMatchObject({
      status: "ok",
      value: "slow",
    });
  });

  it("ends a call past its wall-clock cap", async () => {
    const outcome = await run("wallClock");
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("ran past its time");
  });

  it("refuses a capability used after its call is over", async () => {
    const outcome = await run("replay");
    expect(outcome).toMatchObject({ status: "ok", value: "returned" });
    expect(outcome.reachedAfter).toBe(0);
  });

  it("gives the isolate only the methods core named", async () => {
    const outcome = await run("undeclared");
    expect(outcome.status).toBe("refused");
    // Refused in the isolate: its capability has no such method at all.
    expect(outcome.message).toContain(
      'does not implement the method "internal"'
    );
    expect(outcome.reachedInternal).toBe(0);
  });

  it("passes on what the isolate threw, as the App's", async () => {
    await expect(run("throws")).resolves.toMatchObject({
      status: "refused",
      message: "an App error",
    });
  });

  it("gives the isolate no network", async () => {
    const outcome = await run("network");
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("not permitted to access the internet");
  });

  it("refuses a capability used once the call is over, even with its session still open", async () => {
    const outcome = await run("lingers");
    expect(outcome).toMatchObject({ status: "ok", value: "returned" });
    expect(outcome.reachedAfter).toBe(0);
  });

  it("makes what the App's code sends that a session doesn't take its own failure, not an outage", async () => {
    await expect(run("stream")).resolves.toMatchObject({
      status: "refused",
      verdict: "refused",
    });
    await expect(run("tooLarge")).resolves.toMatchObject({
      status: "refused",
      verdict: "refused",
    });
  });

  it.each(["reservedMethod", "reservedObjectMethod", "reservedLocaleMethod"])(
    "refuses a capability named with a method a stub or any object answers itself (%s)",
    async (name) => {
      const outcome = await run(name);
      expect(outcome.status).toBe("refused");
      expect(outcome.message).toContain("expected shape");
    }
  );

  it("frees the process of a call its caller cancelled", async () => {
    const outcome = await run("cancelled");
    expect(outcome.message).toContain("cancelled");
    expect(outcome.ms).toBeLessThan(2000);
    await expect
      .poll(() => supervisor.stats().inFlight, { timeout: 3000 })
      .toBe(0);
  });

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
    "ends a call as busy, never the App's fault, when the isolate's sessions hold their pool",
    { timeout: 30_000 },
    async () => {
      const outcome = await run("crowded");
      expect(outcome).toMatchObject({ status: "refused", verdict: "busy" });
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
        expect(fourth.status).toBe("unavailable");
        expect(fourth.message).toContain("503");
        expect(fourth.ms).toBeLessThan(1000);
        await Promise.all([holdingOne, holdingTwo, waiting]);
      } finally {
        await small.stop();
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

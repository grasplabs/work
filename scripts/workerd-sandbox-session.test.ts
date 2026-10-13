/**
 * Sessions on the on-prem sandbox, on plain workerd: a stand-in core
 * (apps/core/test/workerd/session-worker.ts) runs the same `runInSession`
 * core runs, with `SANDBOX_HOST` bound to the supervisor
 * (workerd-sandbox.ts), and passes capabilities of its own into isolates
 * that reach back through them. No Wrangler dev server, no Miniflare.
 */
import { once } from "node:events";
import { chmodSync, writeFileSync } from "node:fs";
import { IncomingMessage, request as httpRequest } from "node:http";
import { Socket, connect, createServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  callIdHeader,
  cpuHeader,
  deadlineHeader,
  nativeWorkerd,
  ownerHeader,
  parentHeader,
  startSandboxSupervisor,
  waitHeader,
} from "./workerd-sandbox.ts";
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
  nestedRan: z.number(),
  nestedRefused: z.number(),
  refusedVerdict: z.string().nullable(),
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
    // At once, not at its 10 s wall-clock cap.
    await expect
      .poll(() => supervisor.stats().inFlight, { timeout: 1000, interval: 50 })
      .toBe(0);
  });

  /**
   * A session opened as core opens one, as `owner`, a child of `parent`
   * if given: its socket left to the test, or the status it was refused.
   */
  const rawOpen = async (
    id: string,
    {
      owner = "app-raw",
      parent,
      socket,
    }: { owner?: string; parent?: string; socket?: string } = {}
  ): Promise<{ status: number; socket?: Socket }> => {
    const upgrade = httpRequest({
      socketPath: socket ?? supervisor.socket,
      path: "/session",
      headers: {
        connection: "upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        [deadlineHeader]: "10000",
        [cpuHeader]: "5000",
        [waitHeader]: "3000",
        [callIdHeader]: id,
        [ownerHeader]: owner,
        ...(parent === undefined ? {} : { [parentHeader]: parent }),
      },
    });
    upgrade.end();
    const answered = await Promise.race([
      once(upgrade, "upgrade").then((args: unknown[]) => ({
        args,
        upgraded: true,
      })),
      once(upgrade, "response").then((args: unknown[]) => ({
        args,
        upgraded: false,
      })),
    ]);
    const [first, second] = answered.args;
    if (answered.upgraded && second instanceof Socket) {
      return { status: 101, socket: second };
    }
    if (first instanceof IncomingMessage) {
      first.resume();
      return { status: first.statusCode ?? 0 };
    }
    throw new TypeError("The session got no answer");
  };

  /** A session opened as core opens one, its socket left to the test. */
  const rawSession = async (id: string): Promise<Socket> => {
    const upgrade = httpRequest({
      socketPath: supervisor.socket,
      path: "/session",
      headers: {
        connection: "upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        [deadlineHeader]: "10000",
        [cpuHeader]: "5000",
        [waitHeader]: "3000",
        [callIdHeader]: id,
        [ownerHeader]: "app-raw",
      },
    });
    upgrade.end();
    const upgraded: unknown[] = await once(upgrade, "upgrade");
    const socket = upgraded.at(1);
    if (!(socket instanceof Socket)) {
      throw new TypeError("The upgrade gave no socket");
    }
    return socket;
  };

  /** Says core is done with session `id`, as `POST /end/<id>`. */
  const endRaw = async (id: string, socket?: string): Promise<void> => {
    const end = httpRequest({
      socketPath: socket ?? supervisor.socket,
      path: `/end/${id}`,
      method: "POST",
    });
    end.end();
    const answered: unknown[] = await once(end, "response");
    const response = answered.at(0);
    if (response instanceof IncomingMessage) {
      response.resume();
    }
  };

  it("cancels a parent's child as the parent ends, and frees its process", async () => {
    const parent = crypto.randomUUID();
    const child = crypto.randomUUID();
    const opened = await rawOpen(parent, { owner: "run-parent" });
    const kid = await rawOpen(child, { owner: "app-child", parent });
    try {
      expect([opened.status, kid.status]).toStrictEqual([101, 101]);
      expect(supervisor.stats()).toMatchObject({ inFlight: 2, children: 1 });
      await endRaw(parent);
      await expect
        .poll(() => supervisor.stats().inFlight, {
          timeout: 1500,
          interval: 50,
        })
        .toBe(0);
      expect(supervisor.stats().children).toBe(0);
    } finally {
      opened.socket?.destroy();
      kid.socket?.destroy();
    }
  });

  it("lets one child of a parent wait for its place, and refuses another at once", async () => {
    const parent = crypto.randomUUID();
    const opened = await rawOpen(parent, { owner: "run-parent" });
    const first = await rawOpen(crypto.randomUUID(), {
      owner: "app-a",
      parent,
    });
    const waiting = rawOpen(crypto.randomUUID(), { owner: "app-b", parent });
    try {
      await expect
        .poll(() => supervisor.stats().waitingForParents, {
          timeout: 1500,
          interval: 50,
        })
        .toBe(1);
      const started = Date.now();
      const third = await rawOpen(crypto.randomUUID(), {
        owner: "app-c",
        parent,
      });
      expect(third.status).toBe(429);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      await endRaw(parent);
      opened.socket?.destroy();
      first.socket?.destroy();
      const second = await waiting;
      second.socket?.destroy();
    }
    await expect
      .poll(() => supervisor.stats().inFlight, { timeout: 3000, interval: 50 })
      .toBe(0);
  });

  it("refuses a child still waiting for its owner's place as its parent ends, and runs nothing", async () => {
    // app-held holds its owner's one place: the child waits for it.
    const holder = await rawOpen(crypto.randomUUID(), { owner: "app-held" });
    const parent = crypto.randomUUID();
    const opened = await rawOpen(parent, { owner: "run-parent" });
    try {
      const child = rawOpen(crypto.randomUUID(), {
        owner: "app-held",
        parent,
      });
      await expect
        .poll(() => supervisor.stats().waitingForOwners, {
          timeout: 1500,
          interval: 50,
        })
        .toBe(1);
      const ended = Date.now();
      await endRaw(parent);
      const refused = await child;
      expect(refused.status).toBe(409);
      expect(Date.now() - ended).toBeLessThan(1000);
      await expect
        .poll(() => supervisor.stats().inFlight, {
          timeout: 1500,
          interval: 50,
        })
        .toBe(1);
    } finally {
      opened.socket?.destroy();
      holder.socket?.destroy();
    }
    await expect
      .poll(() => supervisor.stats().inFlight, { timeout: 3000, interval: 50 })
      .toBe(0);
  });

  it(
    "refuses a child still waiting for a process as its parent ends, and runs nothing",
    { timeout: 60_000 },
    async () => {
      // workerd behind a shell that starts it two seconds late: a pool of
      // one has no process to give the child until its spare is up.
      const slow = path.join(tempDir(), "slow-to-start.sh");
      writeFileSync(slow, `#!/bin/sh\nsleep 2\nexec "${nativeWorkerd}" "$@"\n`);
      chmodSync(slow, 0o755);
      const small = await startSandboxSupervisor({
        workerd: slow,
        processes: 1,
        log: () => {},
      });
      try {
        const parent = crypto.randomUUID();
        const opened = await rawOpen(parent, {
          owner: "run-parent",
          socket: small.socket,
        });
        const child = rawOpen(crypto.randomUUID(), {
          owner: "app-child",
          parent,
          socket: small.socket,
        });
        await expect
          .poll(() => small.stats().waiting, { timeout: 1500, interval: 20 })
          .toBe(1);
        const ended = Date.now();
        await endRaw(parent, small.socket);
        const refused = await child;
        expect(refused.status).toBe(409);
        expect(Date.now() - ended).toBeLessThan(1000);
        opened.socket?.destroy();
        // Its spare up, nothing runs on it.
        await sleep(2500);
        expect(small.stats().inFlight).toBe(0);
      } finally {
        await small.stop();
      }
    }
  );

  it("refuses a child named after a parent that has ended", async () => {
    const parent = crypto.randomUUID();
    const opened = await rawOpen(parent, { owner: "run-parent" });
    await endRaw(parent);
    opened.socket?.destroy();
    await expect
      .poll(() => supervisor.stats().inFlight, { timeout: 1500, interval: 50 })
      .toBe(0);
    const late = await rawOpen(crypto.randomUUID(), {
      owner: "app-late",
      parent,
    });
    expect(late.status).toBe(409);
  });

  it("refuses a child's own child: only a session core opened at the top may be a parent", async () => {
    const parent = crypto.randomUUID();
    const child = crypto.randomUUID();
    const opened = await rawOpen(parent, { owner: "run-parent" });
    const kid = await rawOpen(child, { owner: "app-child", parent });
    try {
      const grandchild = await rawOpen(crypto.randomUUID(), {
        owner: "app-grandchild",
        parent: child,
      });
      expect(grandchild.status).toBe(400);
    } finally {
      await endRaw(parent);
      opened.socket?.destroy();
      kid.socket?.destroy();
    }
    await expect
      .poll(() => supervisor.stats().inFlight, { timeout: 3000, interval: 50 })
      .toBe(0);
  });

  it.each([0, 1, 2, 5, 10])(
    "frees the process and owner's place of a session core leaves while it starts (%d ms in)",
    async (afterMs) => {
      const socket = connect(supervisor.socket);
      await once(socket, "connect");
      socket.write(
        [
          "GET /session HTTP/1.1",
          "host: sandbox",
          "connection: upgrade",
          "upgrade: websocket",
          "sec-websocket-version: 13",
          "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==",
          `${deadlineHeader}: 600000`,
          `${cpuHeader}: 5000`,
          `${waitHeader}: 3000`,
          `${callIdHeader}: ${crypto.randomUUID()}`,
          `${ownerHeader}: app-gone`,
          "",
          "",
        ].join("\r\n")
      );
      await sleep(afterMs);
      socket.destroy();
      await expect
        .poll(() => supervisor.stats().inFlight, {
          timeout: 1500,
          interval: 50,
        })
        .toBe(0);
      // Its place is free: one more of its sessions runs at once.
      const outcome = await run("capabilities", "app-gone");
      expect(outcome.status).toBe("ok");
      expect(outcome.ms).toBeLessThan(2000);
    }
  );

  it("frees a session's process when core says it's over, its socket still open", async () => {
    const id = crypto.randomUUID();
    // Its socket then stays open, unused.
    const socket = await rawSession(id);
    try {
      expect(supervisor.stats().inFlight).toBe(1);
      const end = httpRequest({
        socketPath: supervisor.socket,
        path: `/end/${id}`,
        method: "POST",
      });
      end.end();
      const answered: unknown[] = await once(end, "response");
      const response = answered.at(0);
      if (!(response instanceof IncomingMessage)) {
        throw new TypeError("The end gave no response");
      }
      response.resume();
      const ended = response.statusCode;
      expect(ended).toBe(200);
      await expect
        .poll(() => supervisor.stats().inFlight, {
          timeout: 1000,
          interval: 50,
        })
        .toBe(0);
    } finally {
      socket.destroy();
    }
  });

  it("frees a session's process as core's close frame passes, its word that the call is over lost", async () => {
    const id = crypto.randomUUID();
    const socket = await rawSession(id);
    try {
      expect(supervisor.stats().inFlight).toBe(1);
      // A masked close frame (status 1000), its header split as TCP may.
      socket.write(Buffer.from([0x88]));
      socket.write(Buffer.from([0x82, 0, 0, 0, 0, 0x03, 0xe8]));
      await expect
        .poll(() => supervisor.stats().inFlight, {
          timeout: 1000,
          interval: 50,
        })
        .toBe(0);
    } finally {
      socket.destroy();
    }
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

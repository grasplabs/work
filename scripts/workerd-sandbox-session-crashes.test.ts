/**
 * Sessions on the on-prem sandbox, on plain workerd: a stand-in core
 * (apps/core/test/workerd/session-worker.ts) runs the same `runInSession`
 * core runs, with `SANDBOX_HOST` bound to the supervisor
 * (workerd-sandbox.ts), and passes capabilities of its own into isolates
 * that reach back through them. No Wrangler dev server, no Miniflare.
 *
 * Sessions whose process is slow to start or to exit, crashes, resets its
 * connection or runs out of memory; workerd-sandbox-session.test.ts has
 * the rest of a session's life, apart so the two can run on different
 * workers and shards.
 */
import { once } from "node:events";
import { chmodSync, writeFileSync } from "node:fs";
import { IncomingMessage, request as httpRequest } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

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
import { outcomeSchema, runIn } from "./workerd-session-cases.ts";
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

  /** What `GET /verdict/<id>` answers: its status and body. */
  const verdictAnswer = async (
    id: string,
    socket?: string
  ): Promise<{ status: number; body: unknown }> => {
    const asked = httpRequest({
      socketPath: socket ?? supervisor.socket,
      path: `/verdict/${id}`,
    });
    asked.end();
    const answered: unknown[] = await once(asked, "response");
    const response = answered.at(0);
    if (!(response instanceof IncomingMessage)) {
      throw new TypeError("The verdict got no answer");
    }
    let text = "";
    for await (const chunk of response) {
      text += String(chunk);
    }
    return { status: response.statusCode ?? 0, body: JSON.parse(text) };
  };

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

  it(
    "gives a crashed child's places back as its process dies, not once it's gone",
    { timeout: 60_000 },
    async () => {
      // workerd behind a shell that goes two seconds after it: a process
      // slow to exit after V8 aborted it.
      const slow = path.join(tempDir(), "slow-to-exit.sh");
      writeFileSync(
        slow,
        `#!/bin/sh\n"${nativeWorkerd}" "$@"\ncode=$?\nsleep 2\nexit $code\n`
      );
      chmodSync(slow, 0o755);
      const small = await startSandboxSupervisor({
        workerd: slow,
        processes: 2,
        memoryLimitBytes: 64 * 1024 ** 3,
        log: () => {},
      });
      try {
        const url = await serveStandIn("session-worker.ts", small.socket);
        const parent = crypto.randomUUID();
        const opened = await rawOpen(parent, {
          owner: "run-parent",
          socket: small.socket,
        });
        const crashing = run("crashes", "app-crash", url, parent);
        await expect
          .poll(() => small.stats().children, { timeout: 3000, interval: 20 })
          .toBe(1);
        await expect
          .poll(() => small.stats().children, { timeout: 15_000, interval: 20 })
          .toBe(0);
        // Its places came back while its verdict (V8 ended it at its heap
        // limit: its memory) still waits on its exit.
        expect(small.stats().memory).toBe(0);
        await expect(crashing).resolves.toMatchObject({ verdict: "memory" });
        opened.socket?.destroy();
      } finally {
        await small.stop();
      }
    }
  );

  it(
    "holds a crashed session's owner place until its process is gone",
    { timeout: 60_000 },
    async () => {
      // A process slow to exit after V8 aborted it, as above.
      const slow = path.join(tempDir(), "slow-to-exit-owner.sh");
      writeFileSync(
        slow,
        `#!/bin/sh\n"${nativeWorkerd}" "$@"\ncode=$?\nsleep 2\nexit $code\n`
      );
      chmodSync(slow, 0o755);
      const small = await startSandboxSupervisor({
        workerd: slow,
        processes: 2,
        memoryLimitBytes: 64 * 1024 ** 3,
        log: () => {},
      });
      try {
        const url = await serveStandIn("session-worker.ts", small.socket);
        const state = { settled: false };
        const crashing = run("crashes", "app-dying", url).finally(() => {
          state.settled = true;
        });
        // Every moment its process lives, its owner holds its place.
        const placeless: number[] = [];
        while (!state.settled) {
          const { inFlight, ownerPlaces } = small.stats();
          if (inFlight > 0 && ownerPlaces === 0) {
            placeless.push(inFlight);
          }
          // oxlint-disable-next-line no-await-in-loop -- sampled until it settles
          await sleep(20);
        }
        await expect(crashing).resolves.toMatchObject({ verdict: "memory" });
        expect(placeless).toStrictEqual([]);
      } finally {
        await small.stop();
      }
    }
  );

  it(
    "judges a session whose process reset its connection as it died, as a dying process with unread bytes does on Linux",
    { timeout: 60_000 },
    async () => {
      // A stand-in host: it answers the session, then ends itself (V8's
      // heap limit line and status 1, as workerd does) on the first read of core's
      // next frame, far larger than one read takes: the rest still unread,
      // which Linux answers with a reset, whatever the timing.
      const host = path.join(tempDir(), "resetting-host.mjs");
      writeFileSync(
        host,
        `#!${process.execPath}
import { createServer } from "node:net";
import { createWriteStream } from "node:fs";
const addr = process.argv.find((arg) => arg.startsWith("--socket-addr=http=unix:"));
const socket = addr.slice("--socket-addr=http=unix:".length);
const server = createServer((connection) => {
  let head = "";
  let upgraded = false;
  connection.on("data", (chunk) => {
    if (upgraded) {
      connection.pause();
      process.stderr.write("workerd/jsg/setup.c++:38: fatal: V8 fatal error; location = Reached heap limit; message = : allocation failed: JavaScript heap out of memory\\n");
      process.exit(1);
    }
    head += chunk.toString("latin1");
    if (!head.includes("\\r\\n\\r\\n")) return;
    upgraded = true;
    connection.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
  });
});
server.listen(socket, () => {
  createWriteStream(null, { fd: 3 }).write(JSON.stringify({ event: "listen", socket: "http" }) + "\\n");
});
`
      );
      chmodSync(host, 0o755);
      const small = await startSandboxSupervisor({
        workerd: host,
        processes: 1,
        log: () => {},
      });
      try {
        const id = crypto.randomUUID();
        const opened = await rawOpen(id, {
          owner: "app-reset",
          socket: small.socket,
        });
        expect(opened.status).toBe(101);
        const { socket } = opened;
        if (socket === undefined) {
          throw new TypeError("The session gave no socket");
        }
        // The supervisor closes it while the frame may still be going out:
        // the write's EPIPE then is no fault of the session.
        socket.on("error", () => {});
        const closed = new AbortController();
        socket.once("close", () => {
          closed.abort();
        });
        // A binary frame of a MiB, masked as a client's are (with a zero
        // key): the host reads only the start of it.
        const frameBytes = 1024 * 1024;
        const frame = Buffer.alloc(14 + frameBytes);
        frame[0] = 0x82;
        frame[1] = 0xff;
        frame.writeBigUInt64BE(BigInt(frameBytes), 2);
        socket.write(frame);
        // The supervisor closes core's end once it has judged the session.
        if (!closed.signal.aborted) {
          await once(closed.signal, "abort");
        }
        await expect(verdictAnswer(id, small.socket)).resolves.toMatchObject({
          status: 200,
          body: { verdict: "memory" },
        });
      } finally {
        await small.stop();
      }
    }
  );

  /** How a session of `owner` that asks for `memory` MiB and allocates without end was ended. */
  const hogEnding = async (owner: string, memory: number) => {
    const response = await fetch(
      `${coreUrl}run?case=hogs&owner=${owner}&memory=${memory}`
    );
    const { verdict, message } = outcomeSchema.parse(await response.json());
    return { verdict, message };
  };

  it("gives more memory only to the platform's own sessions that ask, at most its most", async () => {
    // An App's session that asks for more stays at what App code gets.
    await expect(hogEnding("app-stand-in", 512)).resolves.toStrictEqual({
      verdict: "memory",
      message: "The App's code used more than 256 MiB of memory.",
    });
    await expect(hogEnding("platform:builder", 512)).resolves.toStrictEqual({
      verdict: "memory",
      message: "The App's code used more than 512 MiB of memory.",
    });
    // Asked for past the supervisor's most: held to it.
    await expect(hogEnding("platform:builder", 4096)).resolves.toStrictEqual({
      verdict: "memory",
      message: "The App's code used more than 1024 MiB of memory.",
    });
  }, 90_000);
});

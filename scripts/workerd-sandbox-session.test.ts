/**
 * Sessions on the on-prem sandbox, on plain workerd: a stand-in core
 * (apps/core/test/workerd/session-worker.ts) runs the same `runInSession`
 * core runs, with `SANDBOX_HOST` bound to the supervisor
 * (workerd-sandbox.ts), and passes capabilities of its own into isolates
 * that reach back through them. No Wrangler dev server, no Miniflare.
 *
 * Parents and their children, what a session's isolate may reach, and its
 * bounds; workerd-sandbox-session-crashes.test.ts has sessions whose
 * process is slow, crashes or runs out of memory, and
 * workerd-sandbox-session-pool.test.ts the pool, apart so they can run on
 * different workers and shards.
 */
import { once } from "node:events";
import { IncomingMessage, request as httpRequest } from "node:http";
import { Socket, connect } from "node:net";
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
import { runIn } from "./workerd-session-cases.ts";
import { serveStandIn } from "./workerd-stand-in.ts";
import { cleanUp } from "./workerd-test-server.ts";

/** How long core may take to answer another request meanwhile. */
const ANSWER_MS = 500;

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

  /** The verdict the supervisor keeps on session `id`, as core asks for it. */
  const fetchVerdict = async (id: string): Promise<unknown> => {
    const asked = httpRequest({
      socketPath: supervisor.socket,
      path: `/verdict/${id}`,
    });
    asked.end();
    const answered: unknown[] = await once(asked, "response");
    const response = answered.at(0);
    if (!(response instanceof IncomingMessage)) {
      throw new TypeError("No answer");
    }
    let text = "";
    for await (const chunk of response) {
      text += String(chunk);
    }
    return JSON.parse(text);
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

  it("says a live session with no verdict is running, so core takes its error as the App's at once, and knows no other", async () => {
    const id = crypto.randomUUID();
    const opened = await rawOpen(id);
    try {
      expect(opened.status).toBe(101);
      await expect(verdictAnswer(id)).resolves.toStrictEqual({
        status: 200,
        body: { verdict: null, state: "running" },
      });
      await expect(verdictAnswer(crypto.randomUUID())).resolves.toStrictEqual({
        status: 404,
        body: { verdict: null },
      });
    } finally {
      await endRaw(id);
      opened.socket?.destroy();
    }
  });

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
      // Not the App's fault, nor an outage: its call has ended.
      await expect(fetchVerdict(child)).resolves.toMatchObject({
        verdict: "ended",
      });
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

  it("tells core a child named after a parent that has ended is over, as its call has ended", async () => {
    const parent = crypto.randomUUID();
    const opened = await rawOpen(parent, { owner: "run-parent" });
    await endRaw(parent);
    opened.socket?.destroy();
    await expect
      .poll(() => supervisor.stats().inFlight, { timeout: 1500, interval: 50 })
      .toBe(0);
    const outcome = await run("capabilities", "app-late", coreUrl, parent);
    expect(outcome).toMatchObject({ status: "refused", verdict: "ended" });
  });

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

  it("gives a capability core passes during a call only its methods, and only while its callback runs", async () => {
    const outcome = await run("passed");
    expect(outcome).toMatchObject({
      status: "ok",
      value: { inside: { ping: 103, internal: "refused" }, after: "refused" },
    });
    expect([outcome.reachedInternal, outcome.reachedAfter]).toStrictEqual([
      0, 0,
    ]);
  });

  /** What a workflow run's host case did (session-worker.ts, `/run-host`). */
  const runHost = async (name: string) => {
    const response = await fetch(`${coreUrl}run-host?case=${name}`);
    return z
      .object({
        status: z.string(),
        value: z.unknown().optional(),
        verdict: z.string().nullable().optional(),
        message: z.string().optional(),
        reached: z.array(z.string()),
        stepErrors: z.array(z.string()),
      })
      .parse(await response.json());
  };

  it("gives a run's step exactly its attempt's calls, and refuses its attempt's host once the step is over", async () => {
    const outcome = await runHost("attempts");
    const names = ["callConnection", "openDecision", "askDecision"];
    expect(outcome).toMatchObject({
      status: "ok",
      value: {
        inside: {
          ok: true,
          value: {
            ...Object.fromEntries(names.map((name) => [name, "reached"])),
            revokeAll: "refused",
          },
        },
        late: { ok: true, value: "refused" },
      },
    });
    // Attempt A's late call never reached core: only step A's own did.
    expect(outcome.reached.toSorted()).toStrictEqual(names.toSorted());
  });

  it("refuses, in core, an attempt host's call once its step is over or its session given up on", async () => {
    const response = await fetch(`${coreUrl}attempt-liveness`);
    await expect(response.json()).resolves.toStrictEqual({
      own: { ok: true, value: "reached" },
      lateFromA: { ok: true, value: "refused" },
      givenUp: { ok: true, value: "refused" },
      reached: ["callConnection"],
    });
  });

  it("refuses a running step's attempt call once core gave up on the session", async () => {
    const outcome = await runHost("givenUp");
    expect(outcome.reached).toStrictEqual([]);
  });

  it("fails a step as the Loader's CPU kill when the sandbox stopped its code past its CPU time, for good past its memory, and as the platform's when core's own answer was too big", async () => {
    const [spins, fills, bigAnswer] = [
      await runHost("spins"),
      await runHost("fills"),
      await runHost("bigAnswer"),
    ];
    expect({ spins, fills, bigAnswer }).toMatchObject({
      // Retried in a fresh session, as on Cloudflare (attempt-calls.ts).
      spins: { verdict: "cpu", stepErrors: ["CPU limit kill"] },
      fills: { verdict: "memory", stepErrors: ["NonRetryableError"] },
      bigAnswer: {
        status: "unavailable",
        verdict: null,
        stepErrors: ["SandboxUnavailableError"],
      },
    });
  }, 30_000);

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
});

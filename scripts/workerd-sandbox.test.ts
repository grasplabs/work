/**
 * The on-prem sandbox's supervisor (workerd-sandbox.ts) on plain workerd,
 * called directly on its socket, as core calls it: its own bounds. No
 * Wrangler dev server, no Miniflare: plain workerd enforces no CPU limit,
 * so only the supervisor bounds a busy loop. A seal's inspection and a
 * migration's transform through it, in a stand-in core, are
 * workerd-sandbox-inspection.test.ts, apart so the two can run on
 * different workers and shards.
 */
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { IncomingMessage, request } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { isolateSettings } from "../apps/core/src/on-prem/sandbox-settings.ts";
import { platformLimits } from "../packages/shared/src/platform-limits.ts";
import { isolateBase } from "../packages/shared/src/runtime.ts";
import {
  deadlineHeader,
  nativeWorkerd,
  startSandboxSupervisor,
  verdictHeader,
  waitHeader,
} from "./workerd-sandbox.ts";
import type {
  SandboxSupervisor,
  SandboxSupervisorOptions,
} from "./workerd-sandbox.ts";
import { smokeConfig } from "./workerd-smoke-config.ts";
import { cleanUp, tempDir } from "./workerd-test-server.ts";

const quiet: SandboxSupervisorOptions["log"] = () => {};

/** Whether a process with this ID is running. */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The TCP sockets `pid` holds, as lsof lists them: empty if none. */
const tcpSockets = (pid: number): string => {
  try {
    return execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP"], {
      encoding: "utf-8",
    });
  } catch (error) {
    // lsof exits 1 when it finds none; a missing lsof proves nothing.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw error;
    }
    return "";
  }
};

/** The workerd processes still running from a supervisor's directory. */
const workerdIn = (dir: string): string[] => {
  try {
    return execFileSync("pgrep", ["-f", dir], { encoding: "utf-8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    // pgrep exits 1 when nothing matches.
    return [];
  }
};

/** The Node scripts a test started, stopped after it whatever its outcome. */
const scripts: ChildProcess[] = [];

/** `child`, stopped after its test (`stopStarted`). */
const tracked = <Child extends ChildProcess>(child: Child): Child => {
  scripts.push(child);
  return child;
};

/**
 * Stops every script a test started and left running (its assertions
 * failed, or it timed out): SIGTERM first, so a supervisor stops its
 * workerd, which are detached and would outlive a SIGKILL of their parent;
 * then SIGKILL for one that ignores it.
 */
const stopStarted = async (): Promise<void> => {
  await Promise.all(
    scripts.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(3000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    })
  );
};

/** A module whose `E.go()` runs `body`. */
const moduleOf = (body: string): string =>
  `import { WorkerEntrypoint } from "cloudflare:workers";
export class E extends WorkerEntrypoint { async go() { ${body} } }`;

interface DirectCall {
  body: string;
  deadlineMs: number;
  waitMs?: number;
  signal?: AbortSignal;
  /** More in the call's `worker`, which the sandbox host must ignore. */
  worker?: Record<string, unknown>;
}

const answerSchema = z.object({
  ok: z.boolean(),
  value: z.unknown().optional(),
  message: z.string().optional(),
});

/** A response's body, as text. */
const textOf = async (response: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    const piece: unknown = chunk;
    if (Buffer.isBuffer(piece)) {
      chunks.push(piece);
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
};

/** A call straight to the supervisor's socket, as core makes it. */
const callSupervisor = async (
  socket: string,
  { body, deadlineMs, waitMs, signal, worker = {} }: DirectCall
) => {
  const started = Date.now();
  const payload = JSON.stringify({
    worker: {
      ...worker,
      mainModule: "m.js",
      modules: { "m.js": moduleOf(body) },
    },
    entrypoint: "E",
    method: "go",
    args: [],
  });
  const sent = request({
    socketPath: socket,
    path: "/call",
    method: "POST",
    headers: {
      "content-type": "application/json",
      [deadlineHeader]: String(deadlineMs),
      ...(waitMs === undefined ? {} : { [waitHeader]: String(waitMs) }),
    },
    ...(signal === undefined ? {} : { signal }),
  });
  sent.end(payload);
  const responded: unknown[] = await once(sent, "response");
  const [response] = responded;
  if (!(response instanceof IncomingMessage)) {
    throw new TypeError("no response");
  }
  const text = await textOf(response);
  return {
    status: response.statusCode,
    verdict: response.headers[verdictHeader],
    answer:
      response.statusCode === 200
        ? answerSchema.parse(JSON.parse(text))
        : undefined,
    ms: Date.now() - started,
  };
};

/** The supervisor's health, from its socket. */
const healthOf = async (socket: string): Promise<string> => {
  const sent = request({ socketPath: socket, path: "/health", method: "GET" });
  sent.end();
  const responded: unknown[] = await once(sent, "response");
  const [response] = responded;
  if (!(response instanceof IncomingMessage)) {
    throw new TypeError("no response");
  }
  return z
    .object({ status: z.string() })
    .parse(JSON.parse(await textOf(response))).status;
};

/**
 * A stand-in for workerd that listens as workerd does, then drops every
 * call's connection and keeps running: a host that failed, not a crash.
 */
const droppingHost = (): string => {
  const script = path.join(tempDir(), "dropping-host.mjs");
  writeFileSync(
    script,
    `#!${process.execPath}
import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
const addr = process.argv.find((arg) => arg.startsWith("--socket-addr=http=unix:"));
const socket = addr.slice("--socket-addr=http=unix:".length);
const server = createServer((request) => {
  request.socket.destroy();
  // Then, a little later, past any memory limit a test sets.
  setTimeout(() => { globalThis.held = Buffer.alloc(400 * 1024 * 1024, 1); }, 500);
});
server.listen(socket, () => {
createWriteStream(null, { fd: 3 }).write(JSON.stringify({ event: "listen", socket: "http" }) + "\\n");
});
setInterval(() => {}, 1 << 30);
`
  );
  chmodSync(script, 0o755);
  return script;
};

/** A supervisor for one test, stopped after it. */
const withSupervisor = async (
  options: Partial<SandboxSupervisorOptions>,
  test: (supervisor: SandboxSupervisor) => Promise<void> | void
): Promise<void> => {
  const supervisor = await startSandboxSupervisor({
    workerd: nativeWorkerd,
    processes: 1,
    log: quiet,
    ...options,
  });
  try {
    await test(supervisor);
  } finally {
    await supervisor.stop();
  }
};

describe("the sandbox supervisor", () => {
  afterEach(async () => {
    await stopStarted();
  });

  afterAll(() => {
    cleanUp();
  });

  it("listens only on Unix sockets in a directory of its own, mode 0700", async () => {
    await withSupervisor({}, (supervisor) => {
      expect(statSync(supervisor.dir).mode.toString(8).slice(-3)).toBe("700");
      expect(statSync(supervisor.socket).isSocket()).toBeTruthy();
      expect(path.dirname(supervisor.socket)).toBe(supervisor.dir);
      // No sandbox process holds a TCP socket to be reached on.
      expect(supervisor.pids().map(tcpSockets)).toStrictEqual([""]);
    });
  });

  it("refuses App code the network, whatever the call says", async () => {
    await withSupervisor({}, async ({ socket }) => {
      const { answer } = await callSupervisor(socket, {
        body: "return (await fetch('http://127.0.0.1:9/')).status;",
        deadlineMs: 5000,
        worker: { globalOutbound: "internet" },
      });
      expect(answer?.ok).toBeFalsy();
      expect(answer?.message).toContain(
        "not permitted to access the internet via global functions like fetch()"
      );
    });
  });

  it("gives App code no env and none of the flags the call carries", async () => {
    await withSupervisor({}, async ({ socket }) => {
      const { answer } = await callSupervisor(socket, {
        body: "return { env: Object.keys(this.env), navigator: typeof navigator };",
        deadlineMs: 5000,
        worker: {
          env: { SECRET: "leaked" },
          bindings: [{ name: "SECRET", text: "leaked" }],
          compatibilityFlags: ["no_global_navigator"],
          limits: { cpuMs: 1_000_000 },
        },
      });
      // Nor the flags it asks for: `navigator` stays, as the host's flags have it.
      expect(answer).toStrictEqual({
        ok: true,
        value: { env: [], navigator: "object" },
      });
    });
  });

  it("runs every isolate as core's sandbox does, set by the sandbox host itself", () => {
    expect(isolateSettings).toStrictEqual({
      ...isolateBase,
      limits: { cpuMs: platformLimits.serverInvocationCpuMs },
    });
  });

  it("answers a value of nothing as null, so it reads as the App's answer", async () => {
    await withSupervisor({}, async ({ socket }) => {
      const { answer } = await callSupervisor(socket, {
        body: "return undefined;",
        deadlineMs: 5000,
      });
      expect(answer).toStrictEqual({ ok: true, value: null });
    });
  });

  it("refuses an answer past its limit as the App's", async () => {
    await withSupervisor({ maxAnswerBytes: 1024 }, async ({ socket }) => {
      const result = await callSupervisor(socket, {
        body: "return 'x'.repeat(5000);",
        deadlineMs: 5000,
      });
      expect(result).toMatchObject({
        status: 200,
        verdict: "too_large",
        answer: { ok: false },
      });
    });
  });

  it("ends a call that uses too much memory, before its deadline", async () => {
    await withSupervisor(
      { memoryLimitBytes: 192 * 1024 * 1024 },
      async (supervisor) => {
        const result = await callSupervisor(supervisor.socket, {
          body: "const a = []; for (;;) a.push(new Array(1e5).fill(1));",
          deadlineMs: 20_000,
        });
        expect(result).toMatchObject({
          status: 200,
          verdict: "memory",
          answer: { ok: false },
        });
        expect(result.ms).toBeLessThan(20_000);
        expect(supervisor.stats().memory).toBe(1);
      }
    );
  }, 30_000);

  it("refuses as its memory a call V8 aborted at its heap limit", async () => {
    // Past V8's own heap limit, which aborts workerd, before this one.
    await withSupervisor(
      { memoryLimitBytes: 64 * 1024 ** 3 },
      async (supervisor) => {
        const result = await callSupervisor(supervisor.socket, {
          body: "const a = []; for (;;) a.push(new Array(1e5).fill(1));",
          deadlineMs: 20_000,
        });
        expect(result).toMatchObject({
          status: 200,
          verdict: "memory",
          answer: { ok: false },
        });
        expect({
          memory: supervisor.stats().memory,
          crashed: supervisor.stats().crashed,
        }).toStrictEqual({ memory: 1, crashed: 0 });
      }
    );
  }, 30_000);

  it("refuses as its memory a call V8 aborted, however slowly the process goes", async () => {
    // workerd behind a shell that goes two seconds after it does: a process
    // V8 aborted, slow to exit on a loaded machine (a core to write, say).
    const slow = path.join(tempDir(), "slow-to-exit.sh");
    writeFileSync(
      slow,
      `#!/bin/sh\n"${nativeWorkerd}" "$@"\ncode=$?\nsleep 2\nexit $code\n`
    );
    chmodSync(slow, 0o755);
    await withSupervisor(
      { workerd: slow, memoryLimitBytes: 64 * 1024 ** 3 },
      async (supervisor) => {
        const result = await callSupervisor(supervisor.socket, {
          body: "const a = []; for (;;) a.push(new Array(1e5).fill(1));",
          deadlineMs: 20_000,
        });
        expect(result).toMatchObject({
          status: 200,
          verdict: "memory",
          answer: { ok: false },
        });
      }
    );
  }, 30_000);

  it("says a call whose process was killed from outside crashed, as the kernel's OOM killer kills one", async () => {
    // workerd behind a shell that SIGKILLs it three seconds in, mid-call:
    // what a full cgroup does to whichever process it picks.
    const killed = path.join(tempDir(), "killed-from-outside.sh");
    writeFileSync(
      killed,
      `#!/bin/sh\n"${nativeWorkerd}" "$@" &\nchild=$!\nsleep 3\nkill -9 $child\nwait $child\nexit $?\n`
    );
    chmodSync(killed, 0o755);
    await withSupervisor({ workerd: killed }, async (supervisor) => {
      const result = await callSupervisor(supervisor.socket, {
        body: "for (;;) {}",
        deadlineMs: 20_000,
      });
      expect(result).toMatchObject({
        status: 200,
        verdict: "crashed",
        answer: { ok: false },
      });
      expect(supervisor.stats().crashed).toBe(1);
    });
  }, 30_000);

  it.each([
    [
      "aborts without V8's heap limit line, as one refused memory under strict overcommit does",
      "kill -ABRT $child\nwait $child\nexit $?",
    ],
    [
      "exits with a status of its own without V8's heap limit line, as one out of file descriptors does",
      "kill -9 $child\nwait $child\nexit 1",
    ],
  ])(
    "says a call crashed, never its memory, when its process %s",
    async (_how, end) => {
      // workerd behind a shell that ends it three seconds in, mid-call, as
      // the host's own trouble would: never through the call's heap.
      const ended = path.join(tempDir(), "ended-by-the-host.sh");
      writeFileSync(
        ended,
        `#!/bin/sh\n"${nativeWorkerd}" "$@" &\nchild=$!\nsleep 3\n${end}\n`
      );
      chmodSync(ended, 0o755);
      await withSupervisor({ workerd: ended }, async (supervisor) => {
        const result = await callSupervisor(supervisor.socket, {
          body: "for (;;) {}",
          deadlineMs: 20_000,
        });
        expect({
          result: { status: result.status, verdict: result.verdict },
          crashed: supervisor.stats().crashed,
          memory: supervisor.stats().memory,
        }).toStrictEqual({
          result: { status: 200, verdict: "crashed" },
          crashed: 1,
          memory: 0,
        });
      });
    },
    30_000
  );

  it("ends at once, as its bound, a call whose host dropped it and still runs", async () => {
    // Its memory past its limit half a second after the drop: the
    // supervisor doesn't wait out a process that won't go.
    await withSupervisor(
      {
        workerd: droppingHost(),
        memoryLimitBytes: 256 * 1024 * 1024,
      },
      async (supervisor) => {
        const result = await callSupervisor(supervisor.socket, {
          body: "return 1;",
          deadlineMs: 20_000,
        });
        expect(result).toMatchObject({ status: 200, verdict: "memory" });
        expect(result.ms).toBeLessThan(3000);
      }
    );
  });

  it("frees the process of a call whose host dropped it as soon as its caller leaves", async () => {
    await withSupervisor({ workerd: droppingHost() }, async (supervisor) => {
      const leave = new AbortController();
      const call = callSupervisor(supervisor.socket, {
        body: "return 1;",
        deadlineMs: 20_000,
        signal: leave.signal,
      });
      await sleep(300);
      leave.abort();
      await expect(call).rejects.toThrow("aborted");
      const left = Date.now();
      await expect
        .poll(() => supervisor.stats().abandoned, {
          timeout: 3000,
          interval: 50,
        })
        .toBe(1);
      expect(Date.now() - left).toBeLessThan(3000);
    });
  });

  it("refuses a call unread when the pool and its queue are full", async () => {
    await withSupervisor({ maxWaiting: 1 }, async ({ socket }) => {
      const busy = callSupervisor(socket, {
        body: "for (;;) {}",
        deadlineMs: 2000,
      });
      await sleep(200);
      const waiting = callSupervisor(socket, {
        body: "return 1;",
        deadlineMs: 2000,
      });
      await sleep(200);
      const refused = await callSupervisor(socket, {
        body: "return 1;",
        deadlineMs: 2000,
      });
      expect(refused.status).toBe(503);
      expect(refused.ms).toBeLessThan(500);
      await Promise.all([busy, waiting]);
    });
  });

  it("refuses a call that waits past its wait for a free process", async () => {
    await withSupervisor({}, async ({ socket }) => {
      const busy = callSupervisor(socket, {
        body: "for (;;) {}",
        deadlineMs: 4000,
      });
      await sleep(200);
      const waited = await callSupervisor(socket, {
        body: "return 1;",
        deadlineMs: 2000,
        waitMs: 500,
      });
      expect(waited.status).toBe(503);
      expect(waited.ms).toBeLessThan(1500);
      await busy;
    });
  });

  it("kills the process of a call its caller abandoned, and serves the next at once", async () => {
    await withSupervisor({}, async (supervisor) => {
      const abandoned = callSupervisor(supervisor.socket, {
        body: "for (;;) {}",
        deadlineMs: 20_000,
        signal: AbortSignal.timeout(300),
      });
      await expect(abandoned).rejects.toThrow("aborted");
      const next = await callSupervisor(supervisor.socket, {
        body: "return 'next';",
        deadlineMs: 5000,
      });
      expect(next.answer).toStrictEqual({ ok: true, value: "next" });
      expect(next.ms).toBeLessThan(3000);
      expect(supervisor.stats().abandoned).toBe(1);
    });
  }, 30_000);

  it("drops a waiting call its caller abandoned", async () => {
    await withSupervisor({}, async (supervisor) => {
      const busy = callSupervisor(supervisor.socket, {
        body: "for (;;) {}",
        deadlineMs: 3000,
      });
      await sleep(200);
      const waiting = callSupervisor(supervisor.socket, {
        body: "return 1;",
        deadlineMs: 2000,
        signal: AbortSignal.timeout(300),
      });
      await expect(waiting).rejects.toThrow("aborted");
      await expect
        .poll(() => supervisor.stats().waiting, { timeout: 1000 })
        .toBe(0);
      await busy;
    });
  });

  it("fails to start without killing anything when workerd can't be started", async () => {
    await expect(
      startSandboxSupervisor({
        workerd: path.join(tempDir(), "no-workerd"),
        log: quiet,
      })
    ).rejects.toThrow("workerd didn't start");
    // Still here: nothing killed this process's group.
    expect(isRunning(process.pid)).toBeTruthy();
  });

  it("keeps running, and says it's down, when workerd can't be started again", async () => {
    const workerd = path.join(tempDir(), "workerd");
    symlinkSync(nativeWorkerd, workerd);
    await withSupervisor({ workerd }, async (supervisor) => {
      rmSync(workerd);
      const result = await callSupervisor(supervisor.socket, {
        body: "for (;;) {}",
        deadlineMs: 300,
      });
      expect(result.verdict).toBe("deadline");
      await expect
        .poll(async () => await healthOf(supervisor.socket))
        .toBe("down");
      expect(isRunning(process.pid)).toBeTruthy();
    });
  });

  /** A running task's flags in its `stat`, as Linux writes them. */
  const runningFlags = 4_194_560;
  /** `PF_EXITING`: set in a task's flags as it starts to exit. */
  const exitingFlag = 0x4;

  /**
   * A supervisor reading memory as Linux does, from a procfs of the test's
   * own: this process's status for the check at start, and each test's
   * status for its sandbox process once it knows its ID (or none).
   */
  const withFakeProc = async (
    status: string | undefined,
    test: (
      supervisor: SandboxSupervisor,
      events: Record<string, unknown>[]
    ) => Promise<void>,
    { flags = runningFlags }: { flags?: number } = {}
  ): Promise<void> => {
    const procRoot = tempDir();
    // Its `stat` as Linux writes it, in the state its status says.
    const statusOf = (pid: number, text: string, taskFlags: number): void => {
      const state = /^State:\s+(?<state>\S)/mu.exec(text)?.groups?.state ?? "R";
      mkdirSync(path.join(procRoot, String(pid)), { recursive: true });
      writeFileSync(path.join(procRoot, String(pid), "status"), text);
      writeFileSync(
        path.join(procRoot, String(pid), "stat"),
        `${pid} (work erd) ${state} 1 1 1 0 -1 ${taskFlags} 0 0 0 0 5 3 0 0 20 0 1 0 100 0 0\n`
      );
    };
    statusOf(
      process.pid,
      "Name:\tnode\nState:\tR (running)\nVmRSS:\t1000 kB\n",
      runningFlags
    );
    const events: Record<string, unknown>[] = [];
    await withSupervisor(
      {
        usageProbe: { procRoot, ps: "/nonexistent/ps", platform: "linux" },
        log: (event) => {
          events.push(event);
        },
      },
      async (supervisor) => {
        if (status !== undefined) {
          for (const pid of supervisor.pids()) {
            statusOf(pid, status, flags);
          }
        }
        await test(supervisor, events);
      }
    );
  };

  /** A call that runs a while, so its memory is read. */
  const slowCall = {
    body: "await scheduler.wait(1000); return 'unbounded';",
    deadlineMs: 5000,
  };

  it.each([
    ["has no VmRSS in its status", "Name:\tworkerd\nState:\tR (running)\n"],
    ["has no status at all", undefined],
  ])(
    "fails a call loudly, as unavailable, when a running process %s (Linux)",
    async (_, status) => {
      await withFakeProc(status, async ({ socket }, events) => {
        const result = await callSupervisor(socket, slowCall);
        expect(result.status).toBe(503);
        expect(events).toContainEqual(
          expect.objectContaining({
            event: "sandbox.memory_unreadable",
            level: "error",
          })
        );
      });
    }
  );

  it.each([
    [
      "no procfs",
      { procRoot: "/nonexistent/proc", ps: "/bin/ps", platform: "linux" },
    ],
    ["no ps", { procRoot: "/proc", ps: "/nonexistent/ps", platform: "darwin" }],
    ["no reader at all", { procRoot: "/proc", ps: "/bin/ps", platform: "aix" }],
  ] as const)(
    "refuses to start where it can't read memory (%s)",
    async (_, usageProbe) => {
      await expect(
        startSandboxSupervisor({
          workerd: nativeWorkerd,
          usageProbe,
          log: quiet,
        })
      ).rejects.toThrow("can't read processes' memory");
    }
  );

  it.each([
    ["memoryLimitBytes", Number.NaN],
    ["memoryPollMs", 0],
    ["maxDeadlineMs", -1],
  ] as const)(
    "refuses a %s of %s, which would bound nothing",
    async (name, value) => {
      await expect(
        startSandboxSupervisor({
          workerd: nativeWorkerd,
          [name]: value,
          log: quiet,
        })
      ).rejects.toThrow(`${name} must be a positive number`);
    }
  );

  it.each([
    ["an exited", "Name:\tworkerd\nState:\tZ (zombie)\n", runningFlags],
    // Exiting, its memory let go of, though not yet a zombie: what a
    // process killed mid-call shows for a moment, longer on a loaded
    // machine.
    [
      "an exiting",
      "Name:\tworkerd\nState:\tR (running)\n",
      runningFlags + exitingFlag,
    ],
  ])(
    "reads %s process as gone, not unreadable, as Linux shows it until it's reaped",
    async (_, status, flags) => {
      await withFakeProc(
        status,
        async ({ socket }) => {
          const result = await callSupervisor(socket, slowCall);
          expect(result.answer).toStrictEqual({
            ok: true,
            value: "unbounded",
          });
        },
        { flags }
      );
    }
  );

  it("bounds memory from Linux's VmRSS", async () => {
    await withFakeProc(
      "Name:\tworkerd\nState:\tS (sleeping)\nVmRSS:\t999999999 kB\n",
      async ({ socket }) => {
        const result = await callSupervisor(socket, slowCall);
        expect(result).toMatchObject({ status: 200, verdict: "memory" });
      }
    );
  });

  it("answers a call cut short by its own stop as failed, blaming no App", async () => {
    const supervisor = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 1,
      log: quiet,
    });
    const call = callSupervisor(supervisor.socket, {
      body: "await scheduler.wait(10_000); return 1;",
      deadlineMs: 20_000,
    });
    await sleep(300);
    await supervisor.stop();
    const result = await call;
    expect(result.status).toBe(503);
    expect(supervisor.stats().crashed).toBe(0);
  });

  it("leaves no workerd behind when it stops while starting a replacement", async () => {
    const supervisor = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 1,
      log: quiet,
    });
    // Its process dies idle, so a replacement starts at once; stopped while
    // that one is still starting (workerd takes a few hundred ms).
    process.kill(supervisor.pids()[0] ?? 0, "SIGKILL");
    await sleep(50);
    await supervisor.stop();
    expect(workerdIn(supervisor.dir)).toStrictEqual([]);
  });

  it("refuses up front a socket path longer than a Unix socket allows", async () => {
    await expect(
      startSandboxSupervisor({
        workerd: nativeWorkerd,
        parent: path.join(tempDir(), "x".repeat(120)),
        log: quiet,
      })
    ).rejects.toThrow("socket path is too long");
  });

  it.each([
    ["SIGINT", false],
    ["SIGTERM", false],
    ["SIGHUP", false],
    ["SIGTERM", true],
  ] as const)(
    "leaves no workerd behind when its host process gets %s (its own handler: %s)",
    async (signal, ownHandler) => {
      const parent = path.join(tempDir(), "parent.mjs");
      writeFileSync(
        parent,
        `import { nativeWorkerd, startSandboxSupervisor } from ${JSON.stringify(path.join(import.meta.dirname, "workerd-sandbox.ts"))};
${ownHandler ? `process.on(${JSON.stringify(signal)}, () => { setTimeout(() => process.exit(7), 100); });` : ""}
const supervisor = await startSandboxSupervisor({ workerd: nativeWorkerd, processes: 1, log: () => undefined });
process.stdout.write(JSON.stringify({ pids: supervisor.pids() }) + "\\n");
setInterval(() => undefined, 1000);
`
      );
      const host = tracked(
        spawn(process.execPath, [parent], {
          stdio: ["ignore", "pipe", "inherit"],
        })
      );
      const first: unknown[] = await once(
        createInterface({ input: host.stdout }),
        "line"
      );
      const [line] = first;
      const { pids } = z
        .object({ pids: z.array(z.number()) })
        .parse(JSON.parse(String(line)));
      expect(pids.every(isRunning)).toBeTruthy();
      host.kill(signal);
      const exit: unknown[] = await once(host, "exit");
      const [code, killedBy] = exit;
      // Its own handler decides how it ends; without one, the signal does.
      expect(ownHandler ? code : killedBy).toBe(ownHandler ? 7 : signal);
      await expect.poll(() => pids.some(isRunning)).toBe(false);
    }
  );

  it("lets its host process exit promptly once stopped while waiting for a process to go", async () => {
    const parent = path.join(tempDir(), "stops.mjs");
    writeFileSync(
      parent,
      `import { request } from "node:http";
import { startSandboxSupervisor } from ${JSON.stringify(path.join(import.meta.dirname, "workerd-sandbox.ts"))};
const supervisor = await startSandboxSupervisor({ workerd: ${JSON.stringify(droppingHost())}, processes: 1, log: () => undefined });
// A call its host drops: the supervisor waits for that process to go.
const call = request({ socketPath: supervisor.socket, path: "/call", method: "POST", headers: { ${JSON.stringify(deadlineHeader)}: "20000" } });
call.on("error", () => undefined);
call.end("{}");
await new Promise((resolve) => setTimeout(resolve, 300));
await supervisor.stop();
process.stdout.write("stopped\\n");
`
    );
    const host = tracked(
      spawn(process.execPath, [parent], {
        stdio: ["ignore", "pipe", "inherit"],
      })
    );
    await once(createInterface({ input: host.stdout }), "line");
    const stopped = Date.now();
    await once(host, "exit");
    // Nothing of the supervisor's keeps it running: not a wait's timer.
    expect(Date.now() - stopped).toBeLessThan(2000);
  });

  it("runs each call in a process of its own, so work an App leaves behind never reaches the next", async () => {
    await withSupervisor({}, async (supervisor) => {
      const [first] = supervisor.pids();
      // Answers at once, and leaves a busy loop to start after its answer.
      const leaving = await callSupervisor(supervisor.socket, {
        body: "this.ctx.waitUntil(scheduler.wait(300).then(() => { for (;;) {} })); setTimeout(() => { for (;;) {} }, 300); return 'answered';",
        deadlineMs: 5000,
      });
      expect(leaving.answer).toStrictEqual({ ok: true, value: "answered" });
      await expect.poll(() => isRunning(first ?? 0)).toBe(false);
      await sleep(600);
      const next = await callSupervisor(supervisor.socket, {
        body: "return 'innocent';",
        deadlineMs: 2000,
      });
      expect(next.answer).toStrictEqual({ ok: true, value: "innocent" });
      expect(next.ms).toBeLessThan(2000);
    });
  });

  it.each([0, -1, Number.NaN, 65, 1.5])(
    "refuses a pool of %s processes",
    async (processes) => {
      await expect(
        startSandboxSupervisor({
          workerd: nativeWorkerd,
          processes,
          log: quiet,
        })
      ).rejects.toThrow("whole number from 1 to 64");
    }
  );

  it.each(["0", "two", "-1"])(
    "refuses --processes=%s when run on its own",
    async (processes) => {
      const supervisor = tracked(
        spawn(
          process.execPath,
          [
            path.join(import.meta.dirname, "workerd-sandbox.ts"),
            `--processes=${processes}`,
          ],
          { stdio: ["ignore", "ignore", "pipe"] }
        )
      );
      let stderr = "";
      supervisor.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exit: unknown[] = await once(supervisor, "exit");
      expect(exit[0]).toBe(1);
      expect(stderr).toContain("whole number from 1 to 64");
    }
  );

  it("stops its processes on SIGTERM when run on its own", async () => {
    const supervisor = tracked(
      spawn(
        process.execPath,
        [
          path.join(import.meta.dirname, "workerd-sandbox.ts"),
          "--processes",
          "1",
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      )
    );
    const events = z.object({ event: z.string(), pid: z.number().optional() });
    let pid = 0;
    for await (const line of createInterface({ input: supervisor.stderr })) {
      // Node's own warnings come on stderr too.
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const event = events.safeParse(parsed);
      if (event.success && event.data.event === "sandbox.process_started") {
        pid = event.data.pid ?? 0;
      }
      if (event.success && event.data.event === "sandbox.listening") {
        break;
      }
    }
    expect(isRunning(pid)).toBeTruthy();
    supervisor.kill("SIGTERM");
    await once(supervisor, "exit");
    expect(isRunning(pid)).toBeFalsy();
  });
});

describe("the on-prem config", () => {
  it("binds core's SANDBOX_HOST to the sandbox supervisor's socket, so no untrusted code runs in core's process", () => {
    const config = smokeConfig({
      port: 8790,
      sandboxSocket: "/run/grasp-sandbox/supervisor.sock",
      routerSecret: "s",
      modules: [],
      storage: "/tmp/storage",
      files: "/tmp/files",
    });
    const service = /name = "SANDBOX_HOST", service = "(?<name>[^"]+)"/u.exec(
      config
    )?.groups?.name;
    expect(config).toContain(
      `(name = "${service}", external = (address = "unix:/run/grasp-sandbox/supervisor.sock", http = ()))`
    );
  });
});

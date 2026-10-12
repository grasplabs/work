/**
 * The on-prem sandbox on plain workerd. First a seal's inspection, the same
 * `inspected` a seal runs (apps/core/test/workerd/inspection-worker.ts), in
 * a workerd of its own standing in for core, with `SANDBOX_HOST` bound to
 * the supervisor (workerd-sandbox.ts) as on-prem binds it; then the
 * supervisor's own bounds, called directly on its socket. No Wrangler dev
 * server, no Miniflare: plain workerd enforces no CPU limit, so only the
 * supervisor bounds a busy loop.
 */
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, IncomingMessage, request } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { isolateSettings } from "../apps/core/src/on-prem/sandbox-host.ts";
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
import { cleanUp, serveOnWorkerd, tempDir } from "./workerd-test-server.ts";

const repo = path.join(import.meta.dirname, "..");
const core = path.join(repo, "apps/core");

/** The deadline the stand-in core gives each call: short, so the test is. */
const DEADLINE_MS = 2000;
/**
 * How long past the deadline a refusal may come: the supervisor answers at
 * the deadline, so this is only the trip back.
 */
const SLACK_MS = 1500;
/** How long core may take to answer another request meanwhile. */
const ANSWER_MS = 500;

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

/**
 * The stand-in core bundled into `out` as core's own deploy bundles, by
 * Wrangler's dry run, as capnp module entries for a config in `out`.
 */
const bundle = (out: string): string[] => {
  // The compiler's version is generated by its build; inspection doesn't read it.
  writeFileSync(
    path.join(out, "version.js"),
    'export const version = "sandbox-test";'
  );
  const config = path.join(out, "wrangler.jsonc");
  writeFileSync(
    config,
    JSON.stringify({
      name: "sandbox-test",
      main: path.join(core, "test/workerd/inspection-worker.ts"),
      compatibility_date: "2026-09-15",
      compatibility_flags: ["nodejs_compat"],
      alias: { "#version": path.join(out, "version.js") },
    })
  );
  const bundled = path.join(out, "bundle");
  execFileSync(
    path.join(repo, "node_modules/.bin/wrangler"),
    ["deploy", "--dry-run", "--outdir", bundled, "--config", config],
    { cwd: core, stdio: "ignore" }
  );
  // Durable Object migrations come along as text modules.
  return [
    `(name = "worker.js", esModule = embed "bundle/inspection-worker.js")`,
    ...readdirSync(bundled)
      .filter((file) => file.endsWith(".sql"))
      .map((file) => `(name = "${file}", text = embed "bundle/${file}")`),
  ];
};

/** The stand-in core's config, its `SANDBOX_HOST` at `sandbox` (a Unix socket). */
const standInConfig = (
  address: string,
  modules: readonly string[],
  sandbox: string
): string => `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "core", worker = .core),
    (name = "sandbox", external = (address = "unix:${sandbox}", http = ())),
  ],
  sockets = [(name = "http", address = "${address}", http = (), service = "core")],
);

const core :Workerd.Worker = (
  modules = [${modules.join(", ")}],
  compatibilityDate = "2026-09-15",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [
    (name = "RUNTIME_PROFILE", text = "workerd"),
    (name = "SANDBOX_HOST", service = "sandbox"),
    (name = "SANDBOX_DEADLINE_MS", text = "${DEADLINE_MS}"),
  ],
);
`;

const outcomeSchema = z.object({
  status: z.enum(["inspected", "refused", "unavailable"]),
  text: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  ms: z.number(),
});

describe("a seal's inspection on plain workerd", () => {
  let supervisor: SandboxSupervisor;
  let modules: string[];
  /** Where the bundle is, and each config of the stand-in core. */
  let out: string;
  let coreUrl: string;

  beforeAll(async () => {
    supervisor = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 2,
      log: quiet,
    });
    out = tempDir();
    modules = bundle(out);
    const served = await serveOnWorkerd(out, (address) =>
      standInConfig(address, modules, supervisor.socket)
    );
    coreUrl = served.url;
  }, 120_000);

  afterAll(async () => {
    await supervisor.stop();
    cleanUp();
  });

  const inspect = async (app: string, url = coreUrl, query = "") => {
    const response = await fetch(`${url}inspect?app=${app}${query}`);
    return outcomeSchema.parse(await response.json());
  };

  /** How long core takes to answer a request that runs no App code. */
  const answerTime = async (): Promise<number> => {
    const started = Date.now();
    const response = await fetch(coreUrl, {
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    await response.text();
    return Date.now() - started;
  };

  it("inspects an App on the sandbox host", async () => {
    await expect(inspect("good")).resolves.toMatchObject({
      status: "inspected",
      text: '{"name":"good"}',
    });
  });

  it("refuses a seal whose manifest() never returns within the deadline, while core keeps answering", async () => {
    const busy = inspect("busyManifest");
    // Core answers other requests all the while: the loop spins elsewhere.
    const answers: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, during the loop
      answers.push(await answerTime());
      // oxlint-disable-next-line no-await-in-loop -- spread over the deadline
      await sleep(200);
    }
    const outcome = await busy;
    expect(outcome).toMatchObject({
      status: "refused",
      code: "version.inspection_failed",
    });
    expect(outcome.message).toContain("ran past its time");
    expect(outcome.ms).toBeGreaterThanOrEqual(DEADLINE_MS);
    expect(outcome.ms).toBeLessThan(DEADLINE_MS + SLACK_MS);
    expect(Math.max(...answers)).toBeLessThan(ANSWER_MS);
  });

  it("kills the process that spun, and serves on with a new one", async () => {
    await expect.poll(() => supervisor.pids().length).toBe(2);
    const pids = supervisor.pids();
    const { deadlines } = supervisor.stats();
    await inspect("busyManifest");
    expect(supervisor.stats().deadlines).toBe(deadlines + 1);
    const gone = pids.filter((pid) => !supervisor.pids().includes(pid));
    expect(gone).toHaveLength(1);
    await expect.poll(() => isRunning(gone[0] ?? 0)).toBe(false);
    await expect.poll(() => supervisor.pids().length).toBe(2);
  });

  it("refuses an App whose module startup never ends", async () => {
    const outcome = await inspect("busyStartup");
    expect(outcome).toMatchObject({
      status: "refused",
      code: "version.inspection_failed",
    });
    expect(outcome.ms).toBeLessThan(DEADLINE_MS + SLACK_MS);
  });

  it("blames only the App that ran past its time", async () => {
    await expect.poll(() => supervisor.pids().length).toBe(2);
    const busy = inspect("busyManifest");
    const good = await inspect("good");
    expect(good).toMatchObject({ status: "inspected" });
    expect(good.ms).toBeLessThan(DEADLINE_MS);
    await expect(busy).resolves.toMatchObject({ status: "refused" });
  });

  it("refuses an App whose code throws, with what it threw", async () => {
    const outcome = await inspect("throws");
    expect(outcome).toMatchObject({
      status: "refused",
      code: "version.inspection_failed",
    });
    expect(outcome.message).toContain("a broken registration");
  });

  it("refuses an App whose inspection answers nothing, as the App's failure and not an outage", async () => {
    const outcome = await inspect("notText");
    expect(outcome).toMatchObject({
      status: "refused",
      code: "version.inspection_failed",
    });
    expect(outcome.message).toContain("isn't text");
  });

  it("refuses to inspect off Cloudflare when no sandbox is bound", async () => {
    await expect(inspect("good", coreUrl, "&unbound")).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("blames no App for a 504 that isn't the supervisor's own verdict", async () => {
    // A proxy in front of the supervisor gives up with a 504 of its own.
    const proxy = path.join(tempDir(), "proxy.sock");
    const server = createServer((_, response) => {
      response.writeHead(504, { "content-type": "application/json" });
      response.end('{"ok":false,"message":"Gateway Timeout"}');
    }).listen(proxy);
    await once(server, "listening");
    try {
      const served = await serveOnWorkerd(out, (address) =>
        standInConfig(address, modules, proxy)
      );
      await expect(inspect("good", served.url)).resolves.toMatchObject({
        status: "unavailable",
      });
    } finally {
      server.close();
    }
  });

  it("says the sandbox is unavailable, not the App's fault, when the supervisor is gone", async () => {
    await supervisor.stop();
    await expect(inspect("good")).resolves.toMatchObject({
      status: "unavailable",
    });
  });
});

describe("the sandbox supervisor", () => {
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
      limits: { cpuMs: 10_000 },
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

  it("blames the App whose call crashed its process", async () => {
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
          verdict: "crashed",
          answer: { ok: false },
        });
        expect(supervisor.stats().crashed).toBe(1);
      }
    );
  }, 30_000);

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

  /**
   * A supervisor reading memory as Linux does, from a procfs of the test's
   * own: each test writes its process's `status` once it knows its ID.
   */
  const withFakeProc = async (
    status: string,
    test: (
      supervisor: SandboxSupervisor,
      events: Record<string, unknown>[]
    ) => Promise<void>
  ): Promise<void> => {
    const procRoot = tempDir();
    const events: Record<string, unknown>[] = [];
    await withSupervisor(
      {
        memoryProbe: { procRoot, ps: "/nonexistent/ps", platform: "linux" },
        log: (event) => {
          events.push(event);
        },
      },
      async (supervisor) => {
        for (const pid of supervisor.pids()) {
          mkdirSync(path.join(procRoot, String(pid)));
          writeFileSync(path.join(procRoot, String(pid), "status"), status);
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

  it("fails a call loudly, as unavailable, when a running process's memory can't be read (Linux)", async () => {
    await withFakeProc(
      "Name:\tworkerd\nState:\tR (running)\n",
      async ({ socket }, events) => {
        const result = await callSupervisor(socket, slowCall);
        expect(result.status).toBe(503);
        expect(events).toContainEqual(
          expect.objectContaining({
            event: "sandbox.memory_unreadable",
            level: "error",
          })
        );
      }
    );
  });

  it("fails a call loudly, as unavailable, when it has no ps to read memory with (macOS)", async () => {
    const events: Record<string, unknown>[] = [];
    await withSupervisor(
      {
        memoryProbe: {
          procRoot: tempDir(),
          ps: "/nonexistent/ps",
          platform: "darwin",
        },
        log: (event) => {
          events.push(event);
        },
      },
      async ({ socket }) => {
        const result = await callSupervisor(socket, slowCall);
        expect(result.status).toBe(503);
        expect(events).toContainEqual(
          expect.objectContaining({ event: "sandbox.memory_unreadable" })
        );
      }
    );
  });

  it("reads an exited process as gone, not unreadable, as Linux shows it until it's reaped", async () => {
    await withFakeProc(
      "Name:\tworkerd\nState:\tZ (zombie)\n",
      async ({ socket }) => {
        const result = await callSupervisor(socket, slowCall);
        expect(result.answer).toStrictEqual({ ok: true, value: "unbounded" });
      }
    );
  });

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
      const host = spawn(process.execPath, [parent], {
        stdio: ["ignore", "pipe", "inherit"],
      });
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
      const supervisor = spawn(
        process.execPath,
        [
          path.join(import.meta.dirname, "workerd-sandbox.ts"),
          `--processes=${processes}`,
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
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
    const supervisor = spawn(
      process.execPath,
      [
        path.join(import.meta.dirname, "workerd-sandbox.ts"),
        "--processes",
        "1",
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
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

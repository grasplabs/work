/**
 * The on-prem profile's sandbox: the supervisor core's `SANDBOX_HOST`
 * binding reaches, which runs untrusted isolates in workerd processes of
 * their own and kills the one whose call runs past its deadline.
 *
 * Plain workerd enforces no Loader `limits.cpuMs`, has no watchdog, and
 * runs a process's requests on one thread: a busy loop in an isolate holds
 * every Worker in its process, timers included, until it ends. So the bound
 * comes from outside: this supervisor serves the sandbox host
 * (apps/core/src/on-prem/sandbox-host.ts) in a pool of workerd processes,
 * hands each call to an idle one (one call per process, so a kill ends
 * only the call that ran past its time), and on the deadline answers 504,
 * kills the process (its whole group, as an npm shim may stand in front of
 * workerd) and starts another. Core gives up on its own clock a little
 * later still (apps/core/src/sandboxed.ts), should the supervisor itself
 * be gone.
 *
 * It listens on 127.0.0.1 only. Whoever reaches it can run code with no
 * env and no network: CPU, nothing more. The deployment's private network
 * is the on-prem packaging's (GRA-367).
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { on, once, setMaxListeners } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

const hostSource = path.join(
  import.meta.dirname,
  "../apps/core/src/on-prem/sandbox-host.ts"
);

/** The header core gives a call's deadline in (apps/core/src/sandboxed.ts). */
export const deadlineHeader = "x-grasp-sandbox-deadline-ms";

/** What the supervisor is told; every field but `workerd` and `out` has a default. */
export interface SandboxSupervisorOptions {
  /** The workerd binary. */
  workerd: string;
  /** A directory to write the sandbox host's module and config into. */
  out: string;
  /** The port to listen on, on 127.0.0.1: any free one when 0 (the default). */
  port?: number;
  /** How many workerd processes serve calls, one call each at a time. */
  processes?: number;
  /** The longest deadline a call may ask for. */
  maxDeadlineMs?: number;
  /** How many calls may wait for a free process before more are refused. */
  maxWaiting?: number;
  /** The largest call accepted, in bytes. */
  maxCallBytes?: number;
  /** The largest answer passed on, in bytes; past it, the call is refused. */
  maxAnswerBytes?: number;
  /** How long a process may take to start. */
  startupMs?: number;
  /** Where the supervisor says what it did: one JSON line each, by default to stderr. */
  log?: (event: Record<string, unknown>) => void;
}

/** A running supervisor. */
export interface SandboxSupervisor {
  /** Where it answers: `POST /call`, `GET /health`. */
  url: string;
  port: number;
  /** The process IDs serving calls now. */
  pids: () => number[];
  /** How many calls it has ended at their deadline. */
  deadlines: () => number;
  stop: () => Promise<void>;
}

const MIB = 1024 * 1024;
const defaults = {
  port: 0,
  processes: 2,
  maxDeadlineMs: 30_000,
  maxWaiting: 32,
  maxCallBytes: 32 * MIB,
  maxAnswerBytes: 32 * MIB,
  startupMs: 10_000,
};

type Settings = typeof defaults &
  Pick<SandboxSupervisorOptions, "workerd" | "out"> & {
    log: (event: Record<string, unknown>) => void;
  };

/** How long to wait before starting a process again after one failed to. */
const RESTART_DELAY_MS = 1000;

/** The sandbox host's config: one Worker with a Loader, on a port of workerd's choosing. */
const hostConfig = `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "sandbox", worker = .sandbox)],
  # Port 0: workerd picks one and reports it on its control descriptor.
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "sandbox")],
);

const sandbox :Workerd.Worker = (
  modules = [(name = "sandbox-host.js", esModule = embed "sandbox-host.js")],
  compatibilityDate = "2026-09-15",
  # Its only binding: no storage, no secrets, nothing for escaped code.
  bindings = [(name = "LOADER", workerLoader = ())],
);
`;

/**
 * Writes the sandbox host's module and config into `out` and answers the
 * config's path. The module imports nothing, so stripping its types is all
 * the build it needs.
 */
export const writeSandboxHost = (out: string): string => {
  writeFileSync(
    path.join(out, "sandbox-host.js"),
    stripTypeScriptTypes(readFileSync(hostSource, "utf-8"))
  );
  const config = path.join(out, "sandbox-host.capnp");
  writeFileSync(config, hostConfig);
  return config;
};

/** What workerd reports on its control descriptor once a socket listens. */
const listenEvent = z.object({
  event: z.literal("listen"),
  socket: z.literal("http"),
  port: z.number().int().positive(),
});

/** The port workerd reports on `control`, or undefined if it never does. */
const reportedPort = async (
  control: Readable,
  signal: AbortSignal
): Promise<number | undefined> => {
  const lines = createInterface({ input: control });
  try {
    for await (const [line] of on(lines, "line", {
      signal,
      close: ["close"],
    })) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(line));
      } catch {
        continue;
      }
      const event = listenEvent.safeParse(parsed);
      if (event.success) {
        return event.data.port;
      }
    }
  } catch {
    // Aborted: it took too long.
  } finally {
    lines.close();
  }
  return undefined;
};

/** One workerd process serving the sandbox host. */
interface HostProcess {
  child: ChildProcess;
  pid: number;
  port: number;
  exited: Promise<unknown>;
}

/** Kills `pid`'s whole process group at once. */
const killGroup = (pid: number): void => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Gone already.
  }
};

/** The JSON a refusal answers, as the sandbox host answers a failed call. */
const refusal = (message: string): string =>
  JSON.stringify({ ok: false, message });

const send = (
  response: ServerResponse,
  status: number,
  body: string,
  type = "application/json"
): void => {
  response.writeHead(status, { "content-type": type });
  response.end(body);
};

/** The request's body, or undefined past `limit` bytes. */
const readCall = async (
  request: IncomingMessage,
  limit: number
): Promise<Buffer | undefined> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece: unknown = chunk;
    if (!Buffer.isBuffer(piece)) {
      throw new TypeError("The call's body isn't bytes.");
    }
    size += piece.length;
    if (size > limit) {
      return undefined;
    }
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
};

/**
 * The answer's text, or undefined past `limit` bytes. The sandbox host
 * answers with its length (Response.json), so that is read first: an
 * answer without one, or past the limit, is never read at all.
 */
const readAnswer = async (
  answer: Response,
  limit: number
): Promise<string | undefined> => {
  const length = Number(answer.headers.get("content-length") ?? Number.NaN);
  if (!Number.isInteger(length) || length > limit) {
    await answer.body?.cancel();
    return undefined;
  }
  return await answer.text();
};

/** A call's deadline from its header, at most `max`; undefined if it gives none. */
const deadlineOf = (
  request: IncomingMessage,
  max: number
): number | undefined => {
  const value = Number(request.headers[deadlineHeader]);
  return Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : undefined;
};

/** The pool of sandbox processes, and the calls it serves. */
class SandboxPool {
  readonly #settings: Settings;
  readonly #config: string;
  readonly #live = new Set<HostProcess>();
  readonly #idle: HostProcess[] = [];
  /** Says a process went idle, to the calls waiting for one. */
  readonly #released = new EventTarget();
  #waiting = 0;
  #deadlines = 0;
  #stopping = false;

  constructor(settings: Settings) {
    this.#settings = settings;
    this.#config = writeSandboxHost(settings.out);
    // Every waiting call listens; there may be many.
    setMaxListeners(0, this.#released);
  }

  get pids(): number[] {
    return [...this.#live].map(({ pid }) => pid);
  }

  get deadlines(): number {
    return this.#deadlines;
  }

  get serving(): boolean {
    return this.#live.size > 0;
  }

  /** Starts the pool's processes, all of them. */
  async start(): Promise<void> {
    const started = await Promise.all(
      Array.from(
        { length: this.#settings.processes },
        async () => await this.#startProcess()
      )
    );
    for (const host of started) {
      this.#release(host);
    }
  }

  /** Kills every process; no call is served after. */
  async stop(): Promise<void> {
    this.#stopping = true;
    const live = [...this.#live];
    this.#live.clear();
    this.#idle.length = 0;
    this.#released.dispatchEvent(new Event("released"));
    await Promise.all(
      live.map(async ({ pid, exited }) => {
        killGroup(pid);
        await exited;
      })
    );
  }

  /** One call, on a process of its own, within its deadline. */
  async call(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const { maxDeadlineMs, maxCallBytes, maxAnswerBytes } = this.#settings;
    const deadlineMs = deadlineOf(request, maxDeadlineMs);
    if (deadlineMs === undefined) {
      send(response, 400, refusal(`A call needs ${deadlineHeader}.`));
      return;
    }
    const body = await readCall(request, maxCallBytes);
    if (body === undefined) {
      send(response, 413, refusal("The call is too large."));
      return;
    }
    const host = await this.#acquire();
    if (host === undefined) {
      send(response, 503, refusal("No sandbox process is free."));
      return;
    }
    const deadline = AbortSignal.timeout(deadlineMs);
    try {
      const answer = await fetch(`http://127.0.0.1:${host.port}/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: deadline,
      });
      const text = await readAnswer(answer, maxAnswerBytes);
      this.#release(host);
      if (text === undefined) {
        send(response, 200, refusal("The answer is too large."));
        return;
      }
      send(
        response,
        answer.status,
        text,
        answer.headers.get("content-type") ?? "text/plain"
      );
    } catch (error) {
      if (deadline.aborted) {
        this.#deadlines += 1;
        this.#settings.log({
          event: "sandbox.deadline",
          pid: host.pid,
          deadlineMs,
        });
        send(response, 504, refusal(`The call ran past its ${deadlineMs} ms.`));
      } else {
        this.#settings.log({
          event: "sandbox.call_failed",
          pid: host.pid,
          error: String(error),
        });
        send(response, 503, refusal("The sandbox process failed."));
      }
      // Busy or broken, the process may still be spinning: never reused.
      await this.#retire(host);
    }
  }

  /** A new workerd process, once it reports its port. */
  async #startProcess(): Promise<HostProcess> {
    const child = spawn(
      this.#settings.workerd,
      ["serve", "--experimental", "--control-fd=3", this.#config],
      // Its own process group, killed whole (`killGroup`).
      { detached: true, stdio: ["ignore", "inherit", "inherit", "pipe"] }
    );
    const exited = once(child, "exit");
    const { pid } = child;
    const { 3: control } = child.stdio;
    if (pid === undefined || !(control instanceof Readable)) {
      child.kill("SIGKILL");
      throw new Error("workerd didn't start");
    }
    const port = await reportedPort(
      control,
      AbortSignal.timeout(this.#settings.startupMs)
    );
    if (port === undefined) {
      killGroup(pid);
      await exited;
      throw new Error(
        `workerd didn't listen within ${this.#settings.startupMs} ms`
      );
    }
    const host: HostProcess = { child, pid, port, exited };
    this.#live.add(host);
    this.#settings.log({ event: "sandbox.process_started", pid, port });
    void this.#watch(host);
    return host;
  }

  /** Replaces `host` if it dies on its own while idle. */
  async #watch(host: HostProcess): Promise<void> {
    await host.exited;
    const at = this.#idle.indexOf(host);
    if (!this.#live.delete(host) || at === -1) {
      // Retired, or busy: its call retires it.
      return;
    }
    this.#idle.splice(at, 1);
    this.#settings.log({
      event: "sandbox.process_exited",
      pid: host.pid,
      code: host.child.exitCode,
    });
    await this.#replace();
  }

  /** Makes `host` idle, for the next call waiting or to come. */
  #release(host: HostProcess): void {
    if (!this.#live.has(host)) {
      return;
    }
    this.#idle.push(host);
    this.#released.dispatchEvent(new Event("released"));
  }

  /** An idle process for one call, or undefined when too many wait already. */
  async #acquire(): Promise<HostProcess | undefined> {
    if (this.#idle.length === 0 && this.#waiting >= this.#settings.maxWaiting) {
      return undefined;
    }
    this.#waiting += 1;
    try {
      let host = this.#idle.shift();
      while (host === undefined && !this.#stopping) {
        // oxlint-disable-next-line no-await-in-loop -- until a process is free
        await once(this.#released, "released");
        host = this.#idle.shift();
      }
      return host;
    } finally {
      this.#waiting -= 1;
    }
  }

  /** Kills `host`, which ran a call past its deadline or broke, and replaces it. */
  async #retire(host: HostProcess): Promise<void> {
    this.#live.delete(host);
    killGroup(host.pid);
    await host.exited;
    await this.#replace();
  }

  /** Starts a process in place of one that's gone, until one starts. */
  async #replace(): Promise<void> {
    if (this.#stopping) {
      return;
    }
    try {
      this.#release(await this.#startProcess());
    } catch (error) {
      this.#settings.log({
        event: "sandbox.process_failed",
        error: String(error),
      });
      await sleep(RESTART_DELAY_MS);
      await this.#replace();
    }
  }
}

/** Answers one request to the supervisor. */
const answer = async (
  pool: SandboxPool,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const { pathname } = new URL(request.url ?? "/", "http://sandbox");
  if (pathname === "/health" && request.method === "GET") {
    send(response, pool.serving ? 200 : 503, "ok", "text/plain");
    return;
  }
  if (pathname !== "/call" || request.method !== "POST") {
    send(response, 404, "Not found", "text/plain");
    return;
  }
  try {
    await pool.call(request, response);
  } catch {
    if (!response.headersSent) {
      send(response, 500, refusal("The supervisor failed."));
    }
  }
};

/** Starts the supervisor, once its processes all serve. */
export const startSandboxSupervisor = async (
  options: SandboxSupervisorOptions
): Promise<SandboxSupervisor> => {
  const settings: Settings = {
    ...defaults,
    ...options,
    log:
      options.log ??
      ((event) => {
        process.stderr.write(`${JSON.stringify(event)}\n`);
      }),
  };
  const pool = new SandboxPool(settings);
  const server: Server = createServer((request, response) => {
    void answer(pool, request, response);
  });
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (server.listening) {
      server.close();
    }
    await pool.stop();
  };
  try {
    await pool.start();
    server.listen(settings.port, "127.0.0.1");
    await once(server, "listening");
  } catch (error) {
    await stop();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await stop();
    throw new Error("the supervisor isn't listening on a port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    pids: () => pool.pids,
    deadlines: () => pool.deadlines,
    stop,
  };
};

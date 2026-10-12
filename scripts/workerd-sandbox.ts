/**
 * The on-prem profile's sandbox: the supervisor core's `SANDBOX_HOST`
 * binding reaches, which runs untrusted isolates in workerd processes of
 * their own and kills the one whose call runs too long, uses too much
 * memory, or is abandoned.
 *
 * Plain workerd enforces no Loader `limits.cpuMs`, has no watchdog, and
 * runs a process's requests on one thread: a busy loop in an isolate holds
 * every Worker in its process, timers included, until it ends. So the bound
 * comes from outside: this supervisor serves the sandbox host
 * (apps/core/src/on-prem/sandbox-host.ts) in a pool of workerd processes
 * and hands each call to an idle one, one call per process, so a kill ends
 * only that call. Threat model, and how each is closed:
 *
 * - A call never returns (a busy loop). At its deadline the supervisor
 *   answers for the App's code ("ran past its time"), kills the process's
 *   whole group (`SIGKILL`) and starts another.
 * - A call allocates without end. Its process's resident memory is read
 *   while it runs; past `memoryLimitBytes` it's killed and the App refused.
 *   Should V8 reach its own heap limit first, it aborts the process: a
 *   process that dies during its one call is that call's doing, refused as
 *   the App's too, never an outage it could fake.
 * - Someone local bypasses the supervisor, or floods it. The supervisor and
 *   every process listen only on Unix sockets in a directory it creates
 *   with mode 0700: no TCP port, nothing another user can reach. Calls in
 *   flight, connections, waiting, bodies and answers are all bounded.
 * - The caller gives up (core's own backstop, or it went away). The call's
 *   process is killed as at a deadline, and a call still waiting for one is
 *   dropped; a call waits at most the time core gives it, then is refused.
 * - Starting workerd fails (missing, not executable, out of processes or
 *   descriptors). The failure is logged and retried with growing delays;
 *   nothing is killed without the process's own positive ID.
 * - The supervisor goes away. Its processes are killed on its exit, and on
 *   SIGTERM or SIGINT when run on its own (`node scripts/workerd-sandbox.ts`).
 *   A SIGKILL can't be caught: the on-prem packaging runs the supervisor
 *   and its processes in one cgroup, which also bounds their memory
 *   together (GRA-367). `RLIMIT_AS` can't stand in for it: V8 reserves far
 *   more address space than it uses, and macOS doesn't enforce it.
 *
 * Every answer meant for the App's code is a 200 with a well-formed body:
 * any other status (its own refusals, a proxy's 504) is the sandbox being
 * unavailable to core (apps/core/src/sandboxed.ts), never the App's fault.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { on, once, setMaxListeners } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  IncomingMessage,
  request as httpRequest,
} from "node:http";
import type { Server, ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { z } from "zod";

const repo = path.join(import.meta.dirname, "..");
const hostSource = path.join(repo, "apps/core/src/on-prem/sandbox-host.ts");

/**
 * The workerd binary itself, not the npm shim in front of it, so killing a
 * process's group kills workerd and nothing is left behind.
 */
export const nativeWorkerd = path.join(
  repo,
  "node_modules/workerd/bin/workerd"
);

/** The headers core gives a call's deadline and wait in (apps/core/src/sandboxed.ts). */
export const deadlineHeader = "x-grasp-sandbox-deadline-ms";
export const waitHeader = "x-grasp-sandbox-wait-ms";

/** The header that marks an answer as the supervisor's verdict on the App's code. */
export const verdictHeader = "x-grasp-sandbox-verdict";

/** What the supervisor is told; every field but `workerd` has a default. */
export interface SandboxSupervisorOptions {
  /** The workerd binary: {@link nativeWorkerd} for this repo's. */
  workerd: string;
  /** Where to make the supervisor's private directory; the OS's temporary one by default. */
  parent?: string;
  /** How many workerd processes serve calls, one call each at a time. */
  processes?: number;
  /** The longest deadline a call may ask for. */
  maxDeadlineMs?: number;
  /** The longest a call may wait for a free process, whatever it asks for. */
  maxWaitMs?: number;
  /** How many calls may wait for a free process; more are refused unread. */
  maxWaiting?: number;
  /** The largest call accepted, in bytes. */
  maxCallBytes?: number;
  /** The largest answer passed on, in bytes; past it, the App's code is refused. */
  maxAnswerBytes?: number;
  /** The most resident memory a process may use during a call. */
  memoryLimitBytes?: number;
  /** How often a busy process's memory is read. */
  memoryPollMs?: number;
  /** How long a process may take to start. */
  startupMs?: number;
  /** Where the supervisor says what it did: one JSON line each, by default to stderr. */
  log?: (event: Record<string, unknown>) => void;
}

/** What the supervisor has done, for its tests and logs. */
export interface SandboxStats {
  deadlines: number;
  memory: number;
  crashed: number;
  abandoned: number;
  waiting: number;
  inFlight: number;
}

/** A running supervisor. */
export interface SandboxSupervisor {
  /** Its private directory, mode 0700. */
  dir: string;
  /** The Unix socket it answers on: `POST /call`, `GET /health`. */
  socket: string;
  /** The process IDs serving calls now. */
  pids: () => number[];
  stats: () => SandboxStats;
  stop: () => Promise<void>;
}

const MIB = 1024 * 1024;

/**
 * The largest App manifest's text, in UTF-8 bytes (`appManifestMaxBytes`
 * in @grasp-os/shared/app-limits). In the answer's JSON a manifest's text
 * is a string, where escaping at most doubles a byte (`"` and `\`): a valid
 * manifest's JSON text has no raw control characters.
 */
const manifestMaxBytes = 4 * MIB;

const defaults = {
  processes: 2,
  maxDeadlineMs: 30_000,
  maxWaitMs: 5000,
  maxWaiting: 32,
  // An App's source is at most a million characters (`appLimits`), built
  // with its generated modules and the SDK's (half a megabyte): well under.
  maxCallBytes: 16 * MIB,
  maxAnswerBytes: 2 * manifestMaxBytes + 64 * 1024,
  // A Cloudflare isolate may use 128 MB; workerd itself takes about 40.
  memoryLimitBytes: 256 * MIB,
  memoryPollMs: 100,
  startupMs: 10_000,
};

type Settings = typeof defaults & {
  workerd: string;
  parent: string;
  log: (event: Record<string, unknown>) => void;
};

/** The first and the longest wait before starting a process again after one failed to. */
const RESTART_DELAY_MS = 500;
const MAX_RESTART_DELAY_MS = 30_000;

/** How long a client may take to send a call's headers, and all of it. */
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** The sandbox host's config: one Worker with a Loader, its socket given at start. */
const hostConfig = `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "sandbox", worker = .sandbox)],
  # Each process's own Unix socket is given at start (--socket-addr).
  sockets = [(name = "http", address = "unix:sandbox.sock", http = (), service = "sandbox")],
);

const sandbox :Workerd.Worker = (
  modules = [(name = "sandbox-host.js", esModule = embed "sandbox-host.js")],
  compatibilityDate = "2026-09-15",
  # Its only binding: no storage, no secrets, nothing for escaped code.
  bindings = [(name = "LOADER", workerLoader = ())],
);
`;

/**
 * Writes the sandbox host's module and config into `dir` and answers the
 * config's path. The module imports nothing, so stripping its types is all
 * the build it needs.
 */
const writeSandboxHost = (dir: string): string => {
  writeFileSync(
    path.join(dir, "sandbox-host.js"),
    stripTypeScriptTypes(readFileSync(hostSource, "utf-8"))
  );
  const config = path.join(dir, "sandbox-host.capnp");
  writeFileSync(config, hostConfig);
  return config;
};

/** What workerd reports on its control descriptor once its socket listens. */
const listenEvent = z.object({
  event: z.literal("listen"),
  socket: z.literal("http"),
});

/** Whether workerd reports its socket listening on `control` before `signal`. */
const listens = async (
  control: Readable,
  signal: AbortSignal
): Promise<boolean> => {
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
      if (listenEvent.safeParse(parsed).success) {
        return true;
      }
    }
  } catch {
    // Aborted: it took too long.
  } finally {
    lines.close();
  }
  return false;
};

/** One workerd process serving the sandbox host. */
interface HostProcess {
  child: ChildProcess;
  pid: number;
  socket: string;
  /** Settles once it's gone, however it went. */
  exited: Promise<void>;
  gone: boolean;
}

/** Kills `pid`'s whole process group at once; never without a positive ID. */
const killGroup = (pid: number): void => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Gone already.
  }
};

/** Settles once `child` is gone, whether it exited or never started. */
const exitOf = async (child: ChildProcess): Promise<void> => {
  try {
    await once(child, "exit");
  } catch {
    // It never started: `error` instead of `exit`.
  }
};

/** `pid`'s resident memory in bytes, as `ps` says, or undefined once it's gone. */
const residentBytes = async (pid: number): Promise<number | undefined> => {
  const ps = spawn("ps", ["-o", "rss=", "-p", String(pid)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = exitOf(ps);
  let output = "";
  for await (const chunk of ps.stdout) {
    output += String(chunk);
  }
  await exited;
  const kib = Number(output.trim());
  return output.trim() !== "" && Number.isFinite(kib) ? kib * 1024 : undefined;
};

/** Whether `pid` passes `limit` bytes before `signal` aborts. */
const passesMemory = async (
  pid: number,
  limit: number,
  pollMs: number,
  signal: AbortSignal
): Promise<boolean> => {
  while (!signal.aborted) {
    // oxlint-disable-next-line no-await-in-loop -- read once per poll
    const bytes = await residentBytes(pid);
    if (bytes !== undefined && bytes > limit) {
      return true;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one poll at a time
      await sleep(pollMs, undefined, { signal });
    } catch {
      return false;
    }
  }
  return false;
};

/** For errors already handled where they're awaited. */
const ignore = (): undefined => undefined;

/** The JSON of a refusal, as the sandbox host answers a failed call. */
const refusal = (message: string): string =>
  JSON.stringify({ ok: false, message });

const send = (
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {}
): void => {
  if (response.headersSent || response.destroyed) {
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(body);
};

/** Bytes of a stream, or undefined past `limit` (the rest unread). */
const readBytes = async (
  stream: Readable,
  limit: number
): Promise<Buffer | undefined> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const piece: unknown = chunk;
    if (!Buffer.isBuffer(piece)) {
      throw new TypeError("The body isn't bytes.");
    }
    size += piece.length;
    if (size > limit) {
      stream.destroy();
      return undefined;
    }
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
};

/** A header's milliseconds, at most `max`; undefined if it gives none. */
const millisOf = (
  request: IncomingMessage,
  header: string,
  max: number
): number | undefined => {
  const value = Number(request.headers[header]);
  return Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : undefined;
};

/** How a call on a process ended. */
type Ending =
  | { kind: "answered"; status: number; body: Buffer }
  | { kind: "too_large" }
  | { kind: "deadline" | "memory" | "abandoned" | "crashed" }
  | { kind: "failed"; error: unknown };

/** Why a call's run was aborted, set before it is. */
type AbortReason = "deadline" | "memory" | "abandoned";

/** The pool of sandbox processes, and the calls it serves. */
class SandboxPool {
  readonly #settings: Settings;
  readonly #dir: string;
  readonly #config: string;
  readonly #live = new Set<HostProcess>();
  readonly #idle: HostProcess[] = [];
  /** Says a process went idle, to the calls waiting for one. */
  readonly #released = new EventTarget();
  #next = 0;
  #waiting = 0;
  #inFlight = 0;
  #stopping = false;
  readonly #counts = { deadlines: 0, memory: 0, crashed: 0, abandoned: 0 };

  constructor(settings: Settings, dir: string) {
    this.#settings = settings;
    this.#dir = dir;
    this.#config = writeSandboxHost(dir);
    // Every waiting call listens; there may be many.
    setMaxListeners(0, this.#released);
  }

  get pids(): number[] {
    return [...this.#live].map(({ pid }) => pid);
  }

  get stats(): SandboxStats {
    return {
      ...this.#counts,
      waiting: this.#waiting,
      inFlight: this.#inFlight,
    };
  }

  /** How the pool is: every process serving, some, or none. */
  get health(): {
    status: "ok" | "degraded" | "down";
    live: number;
    processes: number;
  } {
    const live = this.#live.size;
    const { processes } = this.#settings;
    let status: "ok" | "degraded" | "down" = "degraded";
    if (live >= processes) {
      status = "ok";
    } else if (live === 0) {
      status = "down";
    }
    return { status, live, processes };
  }

  /** Starts the pool's processes, all of them. */
  async start(): Promise<void> {
    const starting: Promise<HostProcess>[] = [];
    for (let i = 0; i < this.#settings.processes; i += 1) {
      starting.push(this.#startProcess());
    }
    const started = await Promise.allSettled(starting);
    const failed = started.find((result) => result.status === "rejected");
    for (const result of started) {
      if (result.status === "fulfilled") {
        this.#release(result.value);
      }
    }
    if (failed !== undefined) {
      throw failed.reason;
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
      live.map(async (host) => {
        killGroup(host.pid);
        await host.exited;
      })
    );
  }

  /** Kills every process at once, without waiting: for the process's exit. */
  killAll(): void {
    for (const { pid } of this.#live) {
      killGroup(pid);
    }
  }

  /** One call, on a process of its own, within its deadline and wait. */
  async call(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const settings = this.#settings;
    // Refused unread past what the pool serves and lets wait.
    if (this.#inFlight >= settings.processes + settings.maxWaiting) {
      send(response, 503, refusal("The sandbox is full."));
      request.resume();
      return;
    }
    this.#inFlight += 1;
    try {
      await this.#serve(request, response);
    } finally {
      this.#inFlight -= 1;
    }
  }

  async #serve(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const settings = this.#settings;
    const deadlineMs = millisOf(
      request,
      deadlineHeader,
      settings.maxDeadlineMs
    );
    const waitMs =
      millisOf(request, waitHeader, settings.maxWaitMs) ?? settings.maxWaitMs;
    if (deadlineMs === undefined) {
      send(response, 400, refusal(`A call needs ${deadlineHeader}.`));
      request.resume();
      return;
    }
    // Gone: the caller closed before its answer was sent.
    const caller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) {
        caller.abort();
      }
    });
    const body = await readBytes(request, settings.maxCallBytes);
    if (body === undefined) {
      send(response, 413, refusal("The call is too large."));
      return;
    }
    const host = await this.#acquire(
      AbortSignal.any([caller.signal, AbortSignal.timeout(waitMs)])
    );
    if (host === undefined) {
      if (caller.signal.aborted) {
        this.#counts.abandoned += 1;
        return;
      }
      send(response, 503, refusal("No sandbox process came free in time."));
      return;
    }
    const ending = await this.#run(host, body, deadlineMs, caller.signal);
    this.#answer(response, host, ending, deadlineMs);
    if (ending.kind === "answered" || ending.kind === "too_large") {
      this.#release(host);
    } else {
      // Busy, broken or abandoned, the process may still be spinning:
      // never reused.
      await this.#retire(host);
    }
  }

  /** Runs the call on `host`, until it answers, or why it ended. */
  async #run(
    host: HostProcess,
    body: Buffer,
    deadlineMs: number,
    caller: AbortSignal
  ): Promise<Ending> {
    const run = new AbortController();
    let reason: AbortReason | undefined;
    const end = (why: AbortReason): void => {
      reason ??= why;
      run.abort();
    };
    const timer = setTimeout(() => {
      end("deadline");
    }, deadlineMs);
    const onCaller = (): void => {
      end("abandoned");
    };
    caller.addEventListener("abort", onCaller);
    void this.#watchMemory(host, run.signal, () => {
      end("memory");
    });
    try {
      const forwarded = httpRequest({
        socketPath: host.socket,
        path: "/call",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
        },
        signal: run.signal,
      });
      // Once aborted after its answer, the request still says so: heard here.
      forwarded.on("error", ignore);
      forwarded.end(body);
      const responded: unknown[] = await once(forwarded, "response");
      const [answer] = responded;
      if (!(answer instanceof IncomingMessage)) {
        throw new TypeError("The sandbox process answered nothing.");
      }
      answer.on("error", ignore);
      const text = await readBytes(answer, this.#settings.maxAnswerBytes);
      if (text === undefined) {
        return { kind: "too_large" };
      }
      return { kind: "answered", status: answer.statusCode ?? 500, body: text };
    } catch (error) {
      if (reason !== undefined) {
        return { kind: reason };
      }
      // Its one call is all that ran in it: a process gone mid-call is
      // that call's doing (V8 aborts at its heap limit), not an outage.
      await Promise.race([host.exited, sleep(100)]);
      return host.gone ? { kind: "crashed" } : { kind: "failed", error };
    } finally {
      clearTimeout(timer);
      caller.removeEventListener("abort", onCaller);
      run.abort();
    }
  }

  /** Calls `over` if `host` passes the memory limit before `signal` aborts. */
  async #watchMemory(
    host: HostProcess,
    signal: AbortSignal,
    over: () => void
  ): Promise<void> {
    const { memoryLimitBytes, memoryPollMs } = this.#settings;
    if (await passesMemory(host.pid, memoryLimitBytes, memoryPollMs, signal)) {
      over();
    }
  }

  /** Answers the caller how its call ended. */
  #answer(
    response: ServerResponse,
    host: HostProcess,
    ending: Ending,
    deadlineMs: number
  ): void {
    const { log } = this.#settings;
    const verdict = (kind: string, message: string): void => {
      log({ event: `sandbox.${kind}`, pid: host.pid });
      send(response, 200, refusal(message), { [verdictHeader]: kind });
    };
    switch (ending.kind) {
      case "answered": {
        // The sandbox host's own answer, a 200 with its JSON; anything else
        // from it is no answer for the App.
        if (ending.status === 200) {
          send(response, 200, ending.body.toString("utf-8"));
        } else {
          send(
            response,
            502,
            refusal(`The sandbox process answered ${ending.status}.`)
          );
        }
        return;
      }
      case "too_large": {
        verdict("too_large", "The App's code answered too much.");
        return;
      }
      case "deadline": {
        this.#counts.deadlines += 1;
        verdict(
          "deadline",
          `The App's code ran past its time (${deadlineMs} ms).`
        );
        return;
      }
      case "memory": {
        this.#counts.memory += 1;
        verdict(
          "memory",
          `The App's code used more than ${Math.round(this.#settings.memoryLimitBytes / MIB)} MiB of memory.`
        );
        return;
      }
      case "crashed": {
        this.#counts.crashed += 1;
        verdict("crashed", "The App's code crashed its sandbox.");
        return;
      }
      case "abandoned": {
        this.#counts.abandoned += 1;
        log({ event: "sandbox.abandoned", pid: host.pid });
        return;
      }
      case "failed": {
        log({
          event: "sandbox.call_failed",
          pid: host.pid,
          error: String(ending.error),
        });
        send(response, 503, refusal("The sandbox process failed."));
        return;
      }
      default: {
        send(response, 500, refusal("The supervisor failed."));
      }
    }
  }

  /** A new workerd process, once it listens; throws if it can't start. */
  async #startProcess(): Promise<HostProcess> {
    this.#next += 1;
    const socket = path.join(this.#dir, `p${this.#next}.sock`);
    rmSync(socket, { force: true });
    const child = spawn(
      this.#settings.workerd,
      [
        "serve",
        "--experimental",
        "--control-fd=3",
        `--socket-addr=http=unix:${socket}`,
        this.#config,
      ],
      // Its own process group, killed whole (`killGroup`).
      { detached: true, stdio: ["ignore", "inherit", "inherit", "pipe"] }
    );
    // Errors after it started (a failed signal) are only logged.
    child.on("error", (error) => {
      this.#settings.log({
        event: "sandbox.process_error",
        error: String(error),
      });
    });
    const exited = exitOf(child);
    try {
      // `spawn` or `error` (ENOENT, EACCES, EAGAIN, EMFILE): nothing to kill then.
      await once(child, "spawn");
    } catch (error) {
      await exited;
      throw new Error(`workerd didn't start: ${String(error)}`, {
        cause: error,
      });
    }
    const { pid } = child;
    const { 3: control } = child.stdio;
    if (pid === undefined || pid <= 0 || !(control instanceof Readable)) {
      if (pid !== undefined) {
        killGroup(pid);
      }
      await exited;
      throw new Error(
        "workerd started without a process ID or control descriptor"
      );
    }
    const ready = await listens(
      control,
      AbortSignal.timeout(this.#settings.startupMs)
    );
    if (!ready) {
      killGroup(pid);
      await exited;
      throw new Error(
        `workerd didn't listen within ${this.#settings.startupMs} ms`
      );
    }
    const host: HostProcess = { child, pid, socket, exited, gone: false };
    this.#live.add(host);
    this.#settings.log({ event: "sandbox.process_started", pid });
    void this.#watch(host);
    return host;
  }

  /** Marks `host` gone once it is, and replaces it if it died idle. */
  async #watch(host: HostProcess): Promise<void> {
    await host.exited;
    host.gone = true;
    rmSync(host.socket, { force: true });
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

  /** An idle process for one call, or undefined once `signal` aborts first. */
  async #acquire(signal: AbortSignal): Promise<HostProcess | undefined> {
    this.#waiting += 1;
    try {
      let host = this.#idle.shift();
      while (host === undefined && !this.#stopping && !signal.aborted) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- until a process is free
          await once(this.#released, "released", { signal });
        } catch {
          return undefined;
        }
        host = this.#idle.shift();
      }
      return host;
    } finally {
      this.#waiting -= 1;
    }
  }

  /** Kills `host`, which ran a call past its bounds or broke, and replaces it. */
  async #retire(host: HostProcess): Promise<void> {
    this.#live.delete(host);
    killGroup(host.pid);
    await host.exited;
    await this.#replace();
  }

  /** Starts a process in place of one that's gone, waiting longer after each failure. */
  async #replace(): Promise<void> {
    let delay = RESTART_DELAY_MS;
    while (!this.#stopping) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- tried until one starts
        this.#release(await this.#startProcess());
        return;
      } catch (error) {
        this.#settings.log({
          event: "sandbox.process_failed",
          error: String(error),
          retryInMs: delay,
        });
        // oxlint-disable-next-line no-await-in-loop -- waits between tries
        await sleep(delay);
        delay = Math.min(delay * 2, MAX_RESTART_DELAY_MS);
      }
    }
  }
}

/** Answers one request to the supervisor. */
const answerRequest = async (
  pool: SandboxPool,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const { pathname } = new URL(request.url ?? "/", "http://sandbox");
  if (pathname === "/health" && request.method === "GET") {
    const { health } = pool;
    send(
      response,
      health.status === "down" ? 503 : 200,
      JSON.stringify(health)
    );
    return;
  }
  if (pathname !== "/call" || request.method !== "POST") {
    send(response, 404, refusal("Not found."));
    request.resume();
    return;
  }
  try {
    await pool.call(request, response);
  } catch {
    send(response, 500, refusal("The supervisor failed."));
  }
};

/** Starts the supervisor, once its processes all serve. */
export const startSandboxSupervisor = async (
  options: SandboxSupervisorOptions
): Promise<SandboxSupervisor> => {
  const settings: Settings = {
    ...defaults,
    parent: tmpdir(),
    ...options,
    log:
      options.log ??
      ((event) => {
        process.stderr.write(`${JSON.stringify(event)}\n`);
      }),
  };
  // Its own directory, for its sockets and the host's files: no other user
  // may reach a socket in it.
  const dir = mkdtempSync(path.join(settings.parent, "grasp-sandbox-"));
  chmodSync(dir, 0o700);
  const socket = path.join(dir, "supervisor.sock");
  const pool = new SandboxPool(settings, dir);
  const server: Server = createServer((request, response) => {
    void answerRequest(pool, request, response);
  });
  server.maxConnections = 2 * (settings.processes + settings.maxWaiting) + 4;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  const killAll = (): void => {
    pool.killAll();
  };
  process.on("exit", killAll);
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    process.off("exit", killAll);
    if (server.listening) {
      server.close();
    }
    await pool.stop();
    rmSync(dir, { force: true, recursive: true });
  };
  try {
    await pool.start();
    server.listen(socket);
    await once(server, "listening");
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    dir,
    socket,
    pids: () => pool.pids,
    stats: () => pool.stats,
    stop,
  };
};

// Run on its own, as on-prem runs it beside core: says where it listens,
// and stops its processes on SIGTERM and SIGINT.
if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      workerd: { type: "string", default: nativeWorkerd },
      parent: { type: "string" },
      processes: { type: "string" },
    },
  });
  const supervisor = await startSandboxSupervisor({
    workerd: values.workerd,
    ...(values.parent === undefined ? {} : { parent: values.parent }),
    ...(values.processes === undefined
      ? {}
      : { processes: Number(values.processes) }),
  });
  process.stderr.write(
    `${JSON.stringify({ event: "sandbox.listening", socket: supervisor.socket })}\n`
  );
  const shutdown = async (signal: string): Promise<void> => {
    await supervisor.stop();
    process.stderr.write(
      `${JSON.stringify({ event: "sandbox.stopped", signal })}\n`
    );
    process.exit(0);
  };
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

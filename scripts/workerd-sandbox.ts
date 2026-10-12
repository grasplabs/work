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
import { connect } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { z } from "zod";

import {
  checkUsageProbe,
  defaultUsageProbe,
  watchUsage,
} from "./workerd-sandbox-usage.ts";
import type { UsageProbe } from "./workerd-sandbox-usage.ts";

const repo = path.join(import.meta.dirname, "..");
const hostSource = path.join(repo, "apps/core/src/on-prem/sandbox-host.ts");
const sessionSource = path.join(
  repo,
  "apps/core/src/on-prem/sandbox-session.ts"
);
const settingsSource = path.join(
  repo,
  "apps/core/src/on-prem/sandbox-settings.ts"
);
const capabilitySource = path.join(
  repo,
  "apps/core/src/on-prem/sandbox-capability.ts"
);
/** capnweb, as workerd loads it: one module importing only the runtime's. */
const capnwebSource = path.join(
  repo,
  "node_modules/capnweb/dist/index-workers.js"
);

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
/** A session's CPU-time budget, and the ID core asks its verdict by. */
export const cpuHeader = "x-grasp-sandbox-cpu-ms";
export const callIdHeader = "x-grasp-sandbox-call";
/** Whose session it is, for the per-owner cap. */
export const ownerHeader = "x-grasp-sandbox-owner";

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
  /**
   * How many sessions one owner (an App, a person's Code Mode) may hold at
   * once: half the pool, rounded up, by default, so no one owner can take
   * every process while it waits.
   */
  maxPerOwner?: number;
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
  /** Where processes' memory and CPU time are read: `/proc` on Linux, `/bin/ps` on macOS. */
  usageProbe?: UsageProbe;
  /** How long a process may take to start. */
  startupMs?: number;
  /** Where the supervisor says what it did: one JSON line each, by default to stderr. */
  log?: (event: Record<string, unknown>) => void;
}

/** What the supervisor has done, for its tests and logs. */
export interface SandboxStats {
  deadlines: number;
  memory: number;
  cpu: number;
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
  // One call per process: a session waiting on core holds its process,
  // which costs no CPU, so the pool is sized for the sessions that may
  // wait at once, not for the CPU (GRA-367 sizes it per deployment).
  processes: 4,
  maxDeadlineMs: 30_000,
  /**
   * The longest a session may last in wall-clock time, whatever it asks
   * for: a workflow activation waits on model and connector calls, which
   * cost the App no CPU time.
   */
  maxSessionMs: 15 * 60_000,
  /** The most CPU time a session may ask for: a workflow step's 30 s. */
  maxCpuMs: 30_000,
  maxWaitMs: 5000,
  maxWaiting: 32,
  // An App's source is at most a million characters (`appLimits`), built
  // with its generated modules and the SDK's (half a megabyte): well under.
  maxCallBytes: 16 * MIB,
  maxAnswerBytes: 2 * manifestMaxBytes + 64 * 1024,
  // A Cloudflare isolate may use 128 MB; workerd itself takes about 40.
  memoryLimitBytes: 256 * MIB,
  memoryPollMs: 100,
  usageProbe: defaultUsageProbe,
  startupMs: 10_000,
};

type Settings = typeof defaults & {
  workerd: string;
  parent: string;
  maxPerOwner?: number;
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
  modules = [
    (name = "sandbox-host.js", esModule = embed "sandbox-host.js"),
    (name = "sandbox-session.ts", esModule = embed "sandbox-session.js"),
    (name = "sandbox-capability.ts", esModule = embed "sandbox-capability.js"),
    (name = "sandbox-settings.ts", esModule = embed "sandbox-settings.js"),
    (name = "capnweb", esModule = embed "capnweb.js"),
  ],
  compatibilityDate = "2026-09-15",
  # Its only binding: no storage, no secrets, nothing for escaped code.
  bindings = [(name = "LOADER", workerLoader = ())],
);
`;

/**
 * Writes the sandbox host's modules and config into `dir` and answers the
 * config's path. Its modules import only each other, capnweb and the
 * runtime's own, so stripping their types is all the build they need.
 */
const writeSandboxHost = (dir: string): string => {
  writeFileSync(
    path.join(dir, "sandbox-host.js"),
    stripTypeScriptTypes(readFileSync(hostSource, "utf-8"))
  );
  writeFileSync(
    path.join(dir, "sandbox-session.js"),
    stripTypeScriptTypes(readFileSync(sessionSource, "utf-8"))
  );
  writeFileSync(
    path.join(dir, "sandbox-capability.js"),
    stripTypeScriptTypes(readFileSync(capabilitySource, "utf-8"))
  );
  writeFileSync(
    path.join(dir, "sandbox-settings.js"),
    stripTypeScriptTypes(readFileSync(settingsSource, "utf-8"))
  );
  writeFileSync(path.join(dir, "capnweb.js"), readFileSync(capnwebSource));
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

/** The most an HTTP answer's head may take, in bytes. */
const MAX_HEAD_BYTES = 16 * 1024;

/**
 * The head of the HTTP answer arriving on `socket` (up to its blank line)
 * and what came after it; undefined if it closes, `signal` aborts or the
 * head is too long first.
 */
const answerHead = async (
  socket: Socket,
  signal: AbortSignal
): Promise<{ head: string; rest: Buffer } | undefined> => {
  let received = Buffer.alloc(0);
  try {
    for await (const [chunk] of on(socket, "data", {
      signal,
      close: ["close", "end"],
    })) {
      const piece: unknown = chunk;
      if (!Buffer.isBuffer(piece)) {
        return undefined;
      }
      received = Buffer.concat([received, piece]);
      const end = received.indexOf("\r\n\r\n");
      if (end !== -1) {
        socket.pause();
        return {
          head: received.subarray(0, end).toString("latin1"),
          rest: received.subarray(end + 4),
        };
      }
      if (received.length > MAX_HEAD_BYTES) {
        return undefined;
      }
    }
  } catch {
    // Aborted: the session's bounds ended it first.
  }
  return undefined;
};

/** `head` with `name: value` added as its last header, and its blank line. */
const withHeader = (head: string, name: string, value: string): string =>
  `${head}\r\n${name}: ${value}\r\n\r\n`;

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
  | { kind: "deadline" | "memory" | "cpu" | "abandoned" | "crashed" }
  | { kind: "failed"; error: unknown }
  | { kind: "unreadable"; why: string };

/** Why a call's run was aborted, set before it is. */
type AbortReason = "deadline" | "memory" | "cpu" | "abandoned" | "unreadable";

/** A call's watch: aborted once a bound is passed or its caller left. */
interface Guard {
  signal: AbortSignal;
  /** Why it was aborted, if it was. */
  reason: () => AbortReason | undefined;
  /** What couldn't be read, when the reason is `unreadable`. */
  unreadable: () => string;
  stop: () => void;
}

/** A session's ending the App is blamed for, kept for core to ask. */
interface Verdict {
  verdict: "deadline" | "memory" | "cpu" | "crashed";
  message: string;
  at: number;
}

/** How long a verdict is kept, and how many at most. */
const VERDICT_TTL_MS = 60_000;
const MAX_VERDICTS = 1024;

/** An owner as core names one: an App's ID, or `person:` and a person's. */
const ownerPattern = /^[A-Za-z0-9:_.-]{1,200}$/u;

/** A call ID as core makes them: a random UUID. */
const callIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

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
  /**
   * Calls running now: at most `processes`. With the successor each starts,
   * the pool never holds more than twice `processes` workerd at once.
   */
  #busy = 0;
  /** Replacements being started, toward `processes` idle at all times. */
  #pending = 0;
  #inFlight = 0;
  #stopping = false;
  /** Every workerd started and not yet gone, serving or still starting. */
  readonly #spawned = new Set<number>();
  /** Starts under way, which `stop` waits for. */
  readonly #starts = new Set<Promise<HostProcess>>();
  readonly #counts = {
    deadlines: 0,
    memory: 0,
    cpu: 0,
    crashed: 0,
    abandoned: 0,
  };
  /** How to end each session running now, by its call ID. */
  readonly #running = new Map<string, () => void>();
  /** Sessions each owner holds now, waiting or running. */
  readonly #owners = new Map<string, number>();
  readonly #maxPerOwner: number;
  /** Verdicts on sessions, by call ID, oldest first. */
  readonly #verdicts = new Map<string, Verdict>();

  constructor(settings: Settings, dir: string) {
    this.#settings = settings;
    this.#dir = dir;
    this.#config = writeSandboxHost(dir);
    this.#maxPerOwner =
      settings.maxPerOwner ?? Math.ceil(settings.processes / 2);
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
    if (live === 0) {
      status = "down";
    } else if (live >= processes) {
      status = "ok";
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
    // Serving or still starting: every one is killed, and a start under
    // way kills its own once it sees the pool stopping.
    this.killAll();
    await Promise.allSettled(this.#starts);
    await Promise.all(
      live.map(async (host) => {
        await host.exited;
      })
    );
  }

  /** Kills every process at once, without waiting: for the process's exit. */
  killAll(): void {
    for (const pid of this.#spawned) {
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
    // Gone while a process came free: its call never starts.
    if (caller.signal.aborted) {
      this.#counts.abandoned += 1;
      this.#busy -= 1;
      this.#release(host);
      return;
    }
    // A process serves one call, then goes: whatever the App's code left
    // running (a timer, `waitUntil`, a loop it scheduled for later) dies
    // with it, and the next App starts in a process no App has touched.
    // Its successor starts now, while this call runs, so the pool stays
    // warm.
    this.#topUp();
    try {
      const ending = await this.#run(host, body, deadlineMs, caller.signal);
      this.#answer(response, host, ending, deadlineMs);
      await this.#retire(host);
    } finally {
      this.#busy -= 1;
      this.#released.dispatchEvent(new Event("released"));
    }
  }

  /** Runs the call on `host`, until it answers, or why it ended. */
  async #run(
    host: HostProcess,
    body: Buffer,
    deadlineMs: number,
    caller: AbortSignal
  ): Promise<Ending> {
    const guard = this.#guard(host, { deadlineMs }, caller);
    try {
      const forwarded = httpRequest({
        socketPath: host.socket,
        path: "/call",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
        },
        signal: guard.signal,
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
      return await this.#cutShort(host, guard, error);
    } finally {
      guard.stop();
    }
  }

  /**
   * How a call cut short ended: the bound it passed, its caller leaving, or
   * its process dying. Its one call is all that ran in it, so a process
   * gone mid-call is that call's doing (V8 aborts at its heap limit), not
   * an outage; unless the supervisor is stopping, which kills it.
   */
  async #cutShort(
    host: HostProcess,
    guard: Guard,
    error?: unknown
  ): Promise<Ending> {
    const reason = guard.reason();
    if (reason !== undefined && reason !== "unreadable") {
      return { kind: reason };
    }
    await Promise.race([host.exited, sleep(100)]);
    if (host.gone && !this.#stopping) {
      return { kind: "crashed" };
    }
    if (reason === "unreadable") {
      return { kind: "unreadable", why: guard.unreadable() };
    }
    return { kind: "failed", error };
  }

  /**
   * Watches a call on `host`: its wall-clock deadline, its memory and,
   * when given, its CPU time, and its caller. The returned signal aborts
   * at the first of them, with the reason kept.
   */
  #guard(
    host: HostProcess,
    { deadlineMs, cpuLimitMs }: { deadlineMs: number; cpuLimitMs?: number },
    caller: AbortSignal
  ): Guard {
    const run = new AbortController();
    let reason: AbortReason | undefined;
    let unreadable = "";
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
    if (caller.aborted) {
      onCaller();
    }
    caller.addEventListener("abort", onCaller);
    void this.#watchUsage(host, run.signal, cpuLimitMs, (why, detail) => {
      unreadable = detail;
      end(why);
    });
    return {
      signal: run.signal,
      reason: () => reason,
      unreadable: () => unreadable,
      stop: () => {
        clearTimeout(timer);
        caller.removeEventListener("abort", onCaller);
        run.abort();
      },
    };
  }

  /**
   * Calls `over` once `host` passes its memory limit or CPU-time budget, or
   * its usage can't be read: never left unbounded.
   */
  async #watchUsage(
    host: HostProcess,
    signal: AbortSignal,
    cpuLimitMs: number | undefined,
    over: (why: "memory" | "cpu" | "unreadable", detail: string) => void
  ): Promise<void> {
    const { memoryLimitBytes, memoryPollMs, usageProbe } = this.#settings;
    const watched = await watchUsage(
      usageProbe,
      host.pid,
      () => host.gone,
      {
        memoryLimitBytes,
        ...(cpuLimitMs === undefined ? {} : { cpuLimitMs }),
        pollMs: memoryPollMs,
      },
      signal
    );
    if (watched.kind === "unreadable") {
      over("unreadable", watched.why);
    } else if (watched.kind !== "ended") {
      over(watched.kind, "");
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
      case "cpu": {
        this.#counts.cpu += 1;
        verdict("cpu", "The App's code used more than its CPU time.");
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
      case "unreadable": {
        // Loud: every call fails until the supervisor can read memory.
        log({
          event: "sandbox.memory_unreadable",
          level: "error",
          pid: host.pid,
          why: ending.why,
        });
        send(
          response,
          503,
          refusal("The sandbox can't read its processes' memory or CPU time.")
        );
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

  /**
   * One session, on a process of its own: core's WebSocket to the sandbox
   * host, for a call whose isolate reaches back into core through the
   * capabilities core passes in it (apps/core/src/sandboxed.ts). The
   * supervisor relays its bytes and watches it as any call: its deadline,
   * memory and CPU-time budget. A session the App is blamed for leaves a
   * verdict under its call ID for core to ask.
   */
  async session(
    request: IncomingMessage,
    client: Socket,
    head: Buffer
  ): Promise<void> {
    const settings = this.#settings;
    const refuse = (status: number, message: string): void => {
      if (!client.destroyed) {
        client.end(
          `HTTP/1.1 ${status} Refused\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${refusal(message)}`
        );
      }
    };
    if (this.#inFlight >= settings.processes + settings.maxWaiting) {
      refuse(503, "The sandbox is full.");
      return;
    }
    const deadlineMs = millisOf(request, deadlineHeader, settings.maxSessionMs);
    const cpuLimitMs = millisOf(request, cpuHeader, settings.maxCpuMs);
    const waitMs =
      millisOf(request, waitHeader, settings.maxWaitMs) ?? settings.maxWaitMs;
    const callId = request.headers[callIdHeader];
    const owner = request.headers[ownerHeader];
    if (
      deadlineMs === undefined ||
      cpuLimitMs === undefined ||
      typeof callId !== "string" ||
      !callIdPattern.test(callId) ||
      typeof owner !== "string" ||
      !ownerPattern.test(owner)
    ) {
      refuse(
        400,
        `A session needs ${deadlineHeader}, ${cpuHeader}, ${callIdHeader} and ${ownerHeader}.`
      );
      return;
    }
    // One owner holds at most its share of the pool, waiting or running.
    const held = this.#owners.get(owner) ?? 0;
    if (held >= this.#maxPerOwner) {
      refuse(429, "This owner already holds as many sessions as it may.");
      return;
    }
    this.#owners.set(owner, held + 1);
    this.#inFlight += 1;
    try {
      await this.#relay(request, client, head, {
        deadlineMs,
        cpuLimitMs,
        waitMs,
        callId,
        refuse,
      });
    } finally {
      this.#inFlight -= 1;
      const left = (this.#owners.get(owner) ?? 1) - 1;
      if (left <= 0) {
        this.#owners.delete(owner);
      } else {
        this.#owners.set(owner, left);
      }
    }
  }

  async #relay(
    request: IncomingMessage,
    client: Socket,
    head: Buffer,
    session: {
      deadlineMs: number;
      cpuLimitMs: number;
      waitMs: number;
      callId: string;
      refuse: (status: number, message: string) => void;
    }
  ): Promise<void> {
    const { deadlineMs, cpuLimitMs, waitMs, callId, refuse } = session;
    // Gone: core closed its end, done or giving up.
    const caller = new AbortController();
    client.on("close", () => {
      caller.abort();
    });
    client.on("error", ignore);
    const host = await this.#acquire(
      AbortSignal.any([caller.signal, AbortSignal.timeout(waitMs)])
    );
    if (host === undefined) {
      if (!caller.signal.aborted) {
        refuse(503, "No sandbox process came free in time.");
      }
      return;
    }
    if (caller.signal.aborted) {
      this.#busy -= 1;
      this.#release(host);
      return;
    }
    this.#topUp();
    // Core closing its end is how a session ends, not an abandoned call:
    // the guard watches only the bounds, and the session ends either way.
    // Core ends one it gave up on (`POST /cancel/<id>`) as abandoned.
    const cancelled = new AbortController();
    this.#running.set(callId, () => {
      cancelled.abort();
    });
    const guard = this.#guard(
      host,
      { deadlineMs, cpuLimitMs },
      cancelled.signal
    );
    const upstream = connect(host.socket);
    upstream.on("error", ignore);
    try {
      // The upgrade as core sent it, then the bytes both ways.
      let raw = `${request.method} ${request.url} HTTP/1.1\r\n`;
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        raw += `${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`;
      }
      upstream.write(`${raw}\r\n`);
      upstream.write(head);
      // The sandbox host's answer to the upgrade, with the CPU time this
      // supervisor bounds the session to: core runs nothing without it.
      const answered = await answerHead(upstream, guard.signal);
      if (answered === undefined) {
        throw new Error("The sandbox process didn't answer the session.");
      }
      client.write(withHeader(answered.head, cpuHeader, String(cpuLimitMs)));
      client.write(answered.rest);
      // Neither end is closed for the other: core's end stays open until
      // the session's verdict is kept, so core finds it when it asks.
      client.pipe(upstream, { end: false });
      upstream.pipe(client, { end: false });
      await Promise.race([
        once(upstream, "close"),
        once(guard.signal, "abort"),
        once(caller.signal, "abort"),
      ]);
      const ending = guard.signal.aborted
        ? await this.#cutShort(host, guard)
        : await this.#sessionEnded(host, caller.signal);
      this.#judge(host, callId, ending, deadlineMs);
    } finally {
      this.#running.delete(callId);
      guard.stop();
      upstream.destroy();
      client.destroy();
      try {
        await this.#retire(host);
      } finally {
        this.#busy -= 1;
        this.#released.dispatchEvent(new Event("released"));
      }
    }
  }

  /**
   * How a session ended once the sandbox host closed it: a crash if its
   * process died (the App's), otherwise as the host closed it.
   */
  async #sessionEnded(host: HostProcess, caller: AbortSignal): Promise<Ending> {
    if (caller.aborted) {
      // Core closed it: the call is over, however it went.
      return { kind: "answered", status: 101, body: Buffer.alloc(0) };
    }
    await Promise.race([host.exited, sleep(100)]);
    if (host.gone && !this.#stopping) {
      return { kind: "crashed" };
    }
    return { kind: "answered", status: 101, body: Buffer.alloc(0) };
  }

  /** Records how a session ended: a verdict when the App is to blame. */
  #judge(
    host: HostProcess,
    callId: string,
    ending: Ending,
    deadlineMs: number
  ): void {
    const { log } = this.#settings;
    const blame = (verdict: Verdict["verdict"], message: string): void => {
      log({ event: `sandbox.${verdict}`, pid: host.pid, callId });
      this.#keepVerdict(callId, { verdict, message, at: Date.now() });
    };
    switch (ending.kind) {
      case "deadline": {
        this.#counts.deadlines += 1;
        blame(
          "deadline",
          `The App's code ran past its time (${deadlineMs} ms).`
        );
        return;
      }
      case "cpu": {
        this.#counts.cpu += 1;
        blame("cpu", "The App's code used more than its CPU time.");
        return;
      }
      case "memory": {
        this.#counts.memory += 1;
        blame(
          "memory",
          `The App's code used more than ${Math.round(this.#settings.memoryLimitBytes / MIB)} MiB of memory.`
        );
        return;
      }
      case "crashed": {
        this.#counts.crashed += 1;
        blame("crashed", "The App's code crashed its sandbox.");
        return;
      }
      case "abandoned": {
        this.#counts.abandoned += 1;
        return;
      }
      case "unreadable": {
        log({
          event: "sandbox.memory_unreadable",
          level: "error",
          pid: host.pid,
          callId,
          why: ending.why,
        });
        return;
      }
      case "failed": {
        log({ event: "sandbox.call_failed", pid: host.pid, callId });
        break;
      }
      case "answered":
      case "too_large": {
        // Closed by the sandbox host as a session ends: nothing to blame.
        break;
      }
      default: {
        break;
      }
    }
  }

  /** Keeps `verdict` for `callId`, dropping expired and the oldest past the bound. */
  #keepVerdict(callId: string, verdict: Verdict): void {
    const now = Date.now();
    for (const [id, kept] of this.#verdicts) {
      if (
        now - kept.at <= VERDICT_TTL_MS &&
        this.#verdicts.size < MAX_VERDICTS
      ) {
        break;
      }
      this.#verdicts.delete(id);
    }
    this.#verdicts.set(callId, verdict);
  }

  /** Ends session `callId` as its caller gave up on it; false if none runs. */
  cancel(callId: string): boolean {
    const end = this.#running.get(callId);
    end?.();
    return end !== undefined;
  }

  /** The verdict on session `callId`, if the App was blamed for it lately. */
  verdict(callId: string): Verdict | undefined {
    const kept = this.#verdicts.get(callId);
    return kept !== undefined && Date.now() - kept.at <= VERDICT_TTL_MS
      ? kept
      : undefined;
  }

  /** A new workerd process, once it listens; throws if it can't start. */
  async #startProcess(): Promise<HostProcess> {
    const start = this.#spawnProcess();
    this.#starts.add(start);
    try {
      return await start;
    } finally {
      this.#starts.delete(start);
    }
  }

  /** Forgets `pid` once it's gone. */
  async #reap(pid: number, exited: Promise<void>): Promise<void> {
    await exited;
    this.#spawned.delete(pid);
  }

  async #spawnProcess(): Promise<HostProcess> {
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
    if (pid !== undefined && pid > 0) {
      this.#spawned.add(pid);
      void this.#reap(pid, exited);
    }
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
    // Stopped while it started: never served, never left behind.
    if (this.#stopping) {
      killGroup(pid);
      await exited;
      throw new Error("The supervisor stopped while workerd started.");
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
    this.#topUp();
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
    // Gone already: nothing to wait for, no process to take.
    if (signal.aborted) {
      return undefined;
    }
    // An idle process, while fewer calls run than the pool's size.
    const take = (): HostProcess | undefined =>
      this.#busy < this.#settings.processes ? this.#idle.shift() : undefined;
    this.#waiting += 1;
    try {
      let host = take();
      while (host === undefined && !this.#stopping && !signal.aborted) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- until a process is free
          await once(this.#released, "released", { signal });
        } catch {
          return undefined;
        }
        host = take();
      }
      if (host !== undefined) {
        this.#busy += 1;
      }
      return host;
    } finally {
      this.#waiting -= 1;
    }
  }

  /** Kills `host` once its one call is over, however it ended. */
  async #retire(host: HostProcess): Promise<void> {
    this.#live.delete(host);
    killGroup(host.pid);
    await host.exited;
  }

  /** Starts replacements until idle and starting processes fill the pool. */
  #topUp(): void {
    while (
      !this.#stopping &&
      this.#idle.length + this.#pending < this.#settings.processes
    ) {
      this.#pending += 1;
      void this.#replace();
    }
  }

  /** Starts one process, waiting longer after each failure, until it's in the pool. */
  async #replace(): Promise<void> {
    let delay = RESTART_DELAY_MS;
    try {
      while (!this.#stopping) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- tried until one starts
          this.#release(await this.#startProcess());
          return;
        } catch (error) {
          if (this.#stopping) {
            return;
          }
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
    } finally {
      this.#pending -= 1;
    }
  }
}

/** Relays one session; a failure of the supervisor closes it. */
const relaySession = async (
  pool: SandboxPool,
  request: IncomingMessage,
  client: Socket,
  head: Buffer
): Promise<void> => {
  try {
    await pool.session(request, client, head);
  } catch {
    client.destroy();
  }
};

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
  const verdictOf = /^\/verdict\/(?<id>[^/]+)$/u.exec(pathname)?.groups?.id;
  if (verdictOf !== undefined && request.method === "GET") {
    const kept = pool.verdict(verdictOf);
    send(
      response,
      kept === undefined ? 404 : 200,
      JSON.stringify(
        kept === undefined
          ? { verdict: null }
          : { verdict: kept.verdict, message: kept.message }
      )
    );
    return;
  }
  const cancelOf = /^\/cancel\/(?<id>[^/]+)$/u.exec(pathname)?.groups?.id;
  if (cancelOf !== undefined && request.method === "POST") {
    send(response, pool.cancel(cancelOf) ? 200 : 404, "{}");
    request.resume();
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

/** The most processes a pool may have: each is a workerd of its own. */
export const maxProcesses = 64;

/** The supervisor's directory's prefix, and its socket's name in it. */
const dirPrefix = "grasp-sandbox-";
const supervisorSocket = "supervisor.sock";

/**
 * The longest path a Unix socket may have, in bytes: `sun_path` less its
 * NUL, 108 on Linux and 104 on macOS and the BSDs. Every process's socket
 * (`pN.sock`) is shorter than the supervisor's.
 */
const maxSocketPathBytes = process.platform === "linux" ? 107 : 103;

const wholeNumber = /^\d+$/u;

/** The pools running in this process, whose workerd dies with it. */
const runningPools = new Set<SandboxPool>();
const fatalSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const killRunning = (): void => {
  for (const pool of runningPools) {
    pool.killAll();
  }
};

/**
 * On a signal that would end this process: kill every pool's workerd (they
 * are detached, so nothing else would). Handlers this process set itself
 * still run, ours beside them, and decide what follows; with none, the
 * signal is raised again to end the process as it would have.
 */
const onFatalSignal = (signal: NodeJS.Signals): void => {
  killRunning();
  const others = process
    .listeners(signal)
    .filter((listener) => listener !== onFatalSignal);
  if (others.length === 0) {
    for (const fatal of fatalSignals) {
      process.off(fatal, onFatalSignal);
    }
    process.off("exit", killRunning);
    process.kill(process.pid, signal);
  }
};

/** Kills `pool`'s workerd when this process exits or is signalled to end. */
const watchProcess = (pool: SandboxPool): void => {
  if (runningPools.size === 0) {
    process.on("exit", killRunning);
    for (const signal of fatalSignals) {
      process.on(signal, onFatalSignal);
    }
  }
  runningPools.add(pool);
};

const unwatchProcess = (pool: SandboxPool): void => {
  runningPools.delete(pool);
  if (runningPools.size === 0) {
    process.off("exit", killRunning);
    for (const signal of fatalSignals) {
      process.off(signal, onFatalSignal);
    }
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
  // A pool of none would serve nothing and still look started.
  if (
    !Number.isInteger(settings.processes) ||
    settings.processes < 1 ||
    settings.processes > maxProcesses
  ) {
    throw new Error(
      `The sandbox's processes must be a whole number from 1 to ${maxProcesses}, not ${String(settings.processes)}.`
    );
  }
  // An owner's share is at least one process and at most the whole pool.
  if (
    settings.maxPerOwner !== undefined &&
    (!Number.isInteger(settings.maxPerOwner) ||
      settings.maxPerOwner < 1 ||
      settings.maxPerOwner > settings.processes)
  ) {
    throw new Error(
      `The sandbox's maxPerOwner must be a whole number from 1 to its processes, not ${String(settings.maxPerOwner)}.`
    );
  }
  // A bound that isn't a positive number (NaN, say) would bound nothing.
  for (const name of [
    "memoryLimitBytes",
    "memoryPollMs",
    "maxDeadlineMs",
    "maxWaitMs",
    "maxCallBytes",
    "maxAnswerBytes",
    "startupMs",
  ] as const) {
    const value = settings[name];
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `The sandbox's ${name} must be a positive number, not ${String(value)}.`
      );
    }
  }
  // No App code runs where memory can't be bounded.
  await checkUsageProbe(settings.usageProbe);
  // Checked before anything starts: past the limit, workerd would only say
  // it didn't listen.
  const longest = path.join(
    settings.parent,
    `${dirPrefix}XXXXXX`,
    supervisorSocket
  );
  if (Buffer.byteLength(longest) > maxSocketPathBytes) {
    throw new Error(
      `The sandbox's socket path is too long: ${longest} is ${Buffer.byteLength(longest)} bytes, and a Unix socket's path may be at most ${maxSocketPathBytes} on ${process.platform}. Give it a shorter parent directory.`
    );
  }
  // Its own directory, for its sockets and the host's files: no other user
  // may reach a socket in it.
  const dir = mkdtempSync(path.join(settings.parent, dirPrefix));
  chmodSync(dir, 0o700);
  const socket = path.join(dir, supervisorSocket);
  const pool = new SandboxPool(settings, dir);
  const server: Server = createServer((request, response) => {
    void answerRequest(pool, request, response);
  });
  // A session is a WebSocket, upgraded at `/session`.
  server.on(
    "upgrade",
    (request: IncomingMessage, client: Socket, head: Buffer) => {
      const { pathname } = new URL(request.url ?? "/", "http://sandbox");
      if (pathname !== "/session") {
        client.destroy();
        return;
      }
      void relaySession(pool, request, client, head);
    }
  );
  server.maxConnections = 2 * (settings.processes + settings.maxWaiting) + 4;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  watchProcess(pool);
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    unwatchProcess(pool);
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
  // Digits only: "1e1", "0x2" or " 2" are refused, not read as numbers.
  const given = values.processes;
  let processes: number | undefined;
  if (given !== undefined) {
    processes = wholeNumber.test(given) ? Number(given) : Number.NaN;
  }
  let supervisor: SandboxSupervisor;
  try {
    supervisor = await startSandboxSupervisor({
      workerd: values.workerd,
      ...(values.parent === undefined ? {} : { parent: values.parent }),
      ...(processes === undefined ? {} : { processes }),
    });
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ event: "sandbox.failed_to_start", error: String(error) })}\n`
    );
    process.exit(1);
  }
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

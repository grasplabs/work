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
 *   Core's own platform code (the screen compiler, the package builder)
 *   may ask for more, up to `maxMemoryLimitBytes`, never App code: only
 *   a top-level session of an owner in `platformOwners` may ask, and only
 *   core reaches this supervisor.
 *   Should V8 reach its own heap limit first, it aborts the process: a
 *   process that dies during its one call is that call's doing, refused as
 *   the App's too, never an outage it could fake. Ended by itself (its exit
 *   status or V8's abort says so) it is the call's memory, which only the
 *   call reaches; killed from outside (SIGKILL from the kernel's OOM killer, which a
 *   full cgroup sends to whichever process it picks) it is `crashed`,
 *   which load can cause, so core doesn't keep it as the input's verdict.
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
 * - An isolate prints what it holds (a record, a caller's input) to the
 *   deployment's logs, which its processes' output shares. The sandbox
 *   host silences every isolate it loads (apps/core/src/on-prem/
 *   quiet-isolate.ts), as Cloudflare drops their output; and this
 *   supervisor starts workerd one way only, never `--verbose`, refusing
 *   any option of its own it doesn't know.
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
  sandboxCallIdHeader,
  sandboxCpuHeader,
  sandboxDeadlineHeader,
  sandboxMemoryHeader,
  sandboxOwnerHeader,
  sandboxParentHeader,
  sandboxSubOwnerHeader,
  sandboxVerdictHeader,
  sandboxWaitHeader,
} from "../apps/core/src/sandbox-headers.ts";
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
const quietSource = path.join(repo, "apps/core/src/on-prem/quiet-isolate.ts");
const callLimitsSource = path.join(repo, "apps/core/src/call-limits.ts");
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

// The headers core speaks in, as core names them (apps/core/src/sandbox-headers.ts).
export const deadlineHeader = sandboxDeadlineHeader;
export const waitHeader = sandboxWaitHeader;
export const cpuHeader = sandboxCpuHeader;
export const memoryHeader = sandboxMemoryHeader;
export const callIdHeader = sandboxCallIdHeader;
export const ownerHeader = sandboxOwnerHeader;
export const subOwnerHeader = sandboxSubOwnerHeader;
export const parentHeader = sandboxParentHeader;
export const verdictHeader = sandboxVerdictHeader;

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
  /**
   * How many of an owner's places one of its sub-owners (an App, for the
   * builder's owner) may hold at once, and how many of its sessions may
   * wait: half the owner's share, rounded down, at least one, by default,
   * so one App's builds leave the rest of the builder's share to others.
   */
  maxPerSubOwner?: number;
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
  /**
   * The most a session may ask for (`memoryHeader`): core's platform code
   * (the screen compiler, the package builder) needs more than App code.
   */
  maxMemoryLimitBytes?: number;
  /**
   * The owners whose sessions may ask for more memory: core's platform
   * code, `platform:builder` by default. Any other owner's ask, or a child
   * session's, is ignored: it gets `memoryLimitBytes`.
   */
  platformOwners?: readonly string[];
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
  /** Sessions waiting for their owner's room. */
  waitingForOwners: number;
  /** Owners' places held now, by sessions waiting, running or dying. */
  ownerPlaces: number;
  /** Of those, the places held by sessions of a sub-owner. */
  subOwnerPlaces: number;
  /** Child sessions running, and those waiting for their parent's place. */
  children: number;
  waitingForParents: number;
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

/** The owners whose sessions may ask for more memory: core's builds. */
const defaultPlatformOwners: readonly string[] = ["platform:builder"];

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
  /**
   * The screen compiler type-checks with TypeScript, which on plain
   * workerd (no heap limit to collect against) grows well past what
   * Cloudflare's 128 MB isolate holds it to: about 400 MB for one screen.
   * The builder's owner holds half the pool by default, so with four
   * processes, builds may hold up to 2 GiB together, beside App code's
   * 256 MiB each: what GRA-367's cgroup must leave room for.
   */
  maxMemoryLimitBytes: 1024 * MIB,
  platformOwners: defaultPlatformOwners,
  memoryPollMs: 100,
  usageProbe: defaultUsageProbe,
  startupMs: 10_000,
};

type Settings = typeof defaults & {
  workerd: string;
  parent: string;
  maxPerOwner?: number;
  maxPerSubOwner?: number;
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
    # Named by their paths in apps/core/src, as they import each other.
    (name = "on-prem/sandbox-host.js", esModule = embed "sandbox-host.js"),
    (name = "on-prem/sandbox-session.ts", esModule = embed "sandbox-session.js"),
    (name = "on-prem/sandbox-capability.ts", esModule = embed "sandbox-capability.js"),
    (name = "on-prem/sandbox-settings.ts", esModule = embed "sandbox-settings.js"),
    (name = "on-prem/quiet-isolate.ts", esModule = embed "quiet-isolate.js"),
    (name = "call-limits.ts", esModule = embed "call-limits.js"),
    # workerd resolves a bare specifier beside its importer.
    (name = "on-prem/capnweb", esModule = embed "capnweb.js"),
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
  writeFileSync(
    path.join(dir, "quiet-isolate.js"),
    stripTypeScriptTypes(readFileSync(quietSource, "utf-8"))
  );
  writeFileSync(
    path.join(dir, "call-limits.js"),
    stripTypeScriptTypes(readFileSync(callLimitsSource, "utf-8"))
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

/**
 * The signals a process ends itself with: V8's abort (SIGABRT), or its
 * fatal error as a trap instruction (SIGTRAP, SIGILL).
 */
const ownSignals = new Set(["SIGABRT", "SIGTRAP", "SIGILL"]);

/** A shell's exit status for a child a signal ended: 128 + its number. */
const signalStatus = 128;
const ownSignalStatuses = new Set([
  signalStatus + 6,
  signalStatus + 5,
  signalStatus + 4,
]);

/**
 * What a process that died during its one call says of it. `exited` when
 * it ended itself: workerd exits with a status of its own when V8 reaches
 * its heap limit (status 1 on the workerd built here), or V8 aborts it,
 * either way through nothing but the call it ran, so the input's doing
 * whatever the load. `crashed` when a signal from outside killed it,
 * above all SIGKILL from the kernel's OOM killer, which a full cgroup
 * sends to whichever process it picks: the load's doing.
 */
const deathOf = (child: ChildProcess): "exited" | "crashed" => {
  const { signalCode, exitCode } = child;
  if (signalCode !== null) {
    return ownSignals.has(signalCode) ? "exited" : "crashed";
  }
  if (exitCode === null || exitCode === 0) {
    return "crashed";
  }
  return exitCode < signalStatus || ownSignalStatuses.has(exitCode)
    ? "exited"
    : "crashed";
};

/**
 * What the App is told when its call ended its own process: as for its
 * memory, which is what V8 ends one for.
 */
const endedMessage =
  "The App's code ended its sandbox's process, as V8 does at its heap limit.";

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
/** Settles once `signal` aborts, at once if it has already. */
const abortOf = async (signal: AbortSignal): Promise<void> => {
  if (!signal.aborted) {
    await once(signal, "abort");
  }
};

/**
 * Settles once `socket` has closed, however it closed: never rejects, as
 * `once(socket, "close")` does on the `error` before it. On Linux a
 * process that dies with bytes it never read resets its connection
 * (ECONNRESET), as a session's process V8 aborted mid-call does when core
 * sent it more meanwhile: still the session's end, to be judged as one.
 */
const closeOf = async (socket: Socket): Promise<void> => {
  const closed = new AbortController();
  socket.once("close", () => {
    closed.abort();
  });
  if (socket.closed) {
    closed.abort();
  }
  await abortOf(closed.signal);
};

/** A WebSocket frame's opcode for a close. */
const closeOpcode = 0x8;

/**
 * Watches the frames core sends on a session, as they pass, and says when
 * one is a close: core is done with the session, whether or not the sandbox
 * host ever answers the close (RFC 6455 section 5.2). Only each frame's
 * header is held; its payload is counted past.
 */
const closeFrameWatcher = (onClose: () => void) => {
  let header = Buffer.alloc(0);
  let skip = 0;
  let closed = false;
  return (chunk: Buffer): void => {
    let rest = chunk;
    while (!closed && rest.length > 0) {
      if (skip > 0) {
        const skipped = Math.min(skip, rest.length);
        skip -= skipped;
        rest = rest.subarray(skipped);
        continue;
      }
      header = Buffer.concat([header, rest]);
      rest = Buffer.alloc(0);
      if (header.length < 2) {
        return;
      }
      // oxlint-disable-next-line no-bitwise -- a frame header's bit fields
      const opcode = (header[0] ?? 0) & 0x0f;
      const second = header[1] ?? 0;
      // oxlint-disable-next-line no-bitwise -- a frame header's bit fields
      const short = second & 0x7f;
      let lengthBytes = 0;
      if (short === 126) {
        lengthBytes = 2;
      } else if (short === 127) {
        lengthBytes = 8;
      }
      // oxlint-disable-next-line no-bitwise -- a frame header's bit fields
      const maskBytes = (second & 0x80) === 0 ? 0 : 4;
      const headerBytes = 2 + lengthBytes + maskBytes;
      if (header.length < headerBytes) {
        return;
      }
      if (opcode === closeOpcode) {
        closed = true;
        onClose();
        return;
      }
      let length = short;
      if (lengthBytes === 2) {
        length = header.readUInt16BE(2);
      } else if (lengthBytes === 8) {
        length = Number(header.readBigUInt64BE(2));
      }
      // What came after this header in the same chunk is its payload, then
      // the next frame.
      rest = header.subarray(headerBytes);
      header = Buffer.alloc(0);
      skip = length;
    }
  };
};

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
  | {
      kind: "deadline" | "memory" | "exited" | "cpu" | "abandoned" | "crashed";
    }
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
  verdict: "deadline" | "memory" | "cpu" | "crashed" | "ended";
  message: string;
  at: number;
}

/** How long a verdict is kept, and how many at most. */
const VERDICT_TTL_MS = 60_000;
const MAX_VERDICTS = 1024;

/** An owner as core names one: an App's ID, or `person:` and a person's. */
const ownerPattern = /^[A-Za-z0-9:_.-]{1,200}$/u;

/**
 * A sub-owner's key, under its owner: the same App's builds and its own
 * code are two owners' sub-owners, never one. The separator is outside
 * `ownerPattern`, so no two pairs share a key.
 */
const placeOf = (owner: string, subOwner: string): string =>
  `${owner} ${subOwner}`;

/**
 * The sub-owner a session names (`subOwnerHeader`): undefined for none,
 * null for one that is no owner's name.
 */
const subOwnerOf = (request: IncomingMessage): string | undefined | null => {
  const named = request.headers[subOwnerHeader];
  if (named === undefined) {
    return undefined;
  }
  return typeof named === "string" && ownerPattern.test(named) ? named : null;
};

/** One less of `key` in `counts`, forgotten at none. */
const countDown = (counts: Map<string, number>, key: string): void => {
  const left = (counts.get(key) ?? 1) - 1;
  if (left <= 0) {
    counts.delete(key);
  } else {
    counts.set(key, left);
  }
};

/** A call ID as core makes them: a random UUID. */
const callIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The least, and the most, a process whose call broke off gets to go. */
const minExitWaitMs = 1000;
const maxExitWaitMs = 10_000;

/**
 * How long a process whose call broke off, or whose session its host
 * closed, gets to exit before it's taken as still running: what's left of
 * the call's deadline, which its caller waits for anyway, within
 * `minExitWaitMs` and `maxExitWaitMs`. A process V8 aborted at its heap
 * limit can take seconds to go (writing a core of gigabytes, on a loaded
 * machine): it's the App's crash all the same, never the sandbox failing.
 * Only a process still running past that, its connection broken, is.
 */
const exitWaitMs = (endsAt: number): number =>
  Math.min(Math.max(endsAt - Date.now(), minExitWaitMs), maxExitWaitMs);

/**
 * Waits for `host` to exit, `ms` at most, or until `until` aborts (a bound
 * of its call that ends it first). Its timer never keeps the supervisor's
 * own process running once it's stopped.
 */
const waitForExit = async (
  host: HostProcess,
  ms: number,
  until?: AbortSignal
): Promise<void> => {
  await Promise.race([
    host.exited,
    sleep(ms, undefined, { ref: false }),
    ...(until === undefined ? [] : [abortOf(until)]),
  ]);
};

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
  /**
   * How to end each session running now, by its call ID, and whether it is
   * ending: its process gone or going, its verdict not yet kept.
   */
  readonly #running = new Map<
    string,
    { cancel: () => void; finish: () => void; ending: () => boolean }
  >();
  /** Sessions each owner holds now, waiting or running. */
  readonly #owners = new Map<string, number>();
  /** The child each parent runs now, by the parent's call ID: one each. */
  readonly #children = new Map<string, string>();
  /** Every child's call ID while it runs or waits: never a parent itself. */
  readonly #childIds = new Set<string>();
  /** Each parent's children being admitted, as how to refuse each. */
  readonly #admissions = new Map<string, Set<AbortController>>();
  /** Parents with a child waiting for their one child place, at most one each. */
  readonly #childWaiting = new Set<string>();
  /** Sessions each owner has waiting for its room, and all of them. */
  readonly #ownerWaiters = new Map<string, number>();
  #waitingForOwners = 0;
  readonly #maxPerOwner: number;
  /** Places each sub-owner holds, and its sessions waiting, by `placeOf`. */
  readonly #subOwners = new Map<string, number>();
  readonly #subOwnerWaiters = new Map<string, number>();
  readonly #maxPerSubOwner: number;
  /** Verdicts on sessions, by call ID, oldest first. */
  readonly #verdicts = new Map<string, Verdict>();

  constructor(settings: Settings, dir: string) {
    this.#settings = settings;
    this.#dir = dir;
    this.#config = writeSandboxHost(dir);
    this.#maxPerOwner =
      settings.maxPerOwner ?? Math.ceil(settings.processes / 2);
    this.#maxPerSubOwner =
      settings.maxPerSubOwner ?? Math.max(1, Math.floor(this.#maxPerOwner / 2));
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
      waitingForOwners: this.#waitingForOwners,
      ownerPlaces: [...this.#owners.values()].reduce(
        (sum, held) => sum + held,
        0
      ),
      subOwnerPlaces: [...this.#subOwners.values()].reduce(
        (sum, held) => sum + held,
        0
      ),
      children: this.#children.size,
      waitingForParents: this.#childWaiting.size,
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
    // Refused unread past what the pool serves and lets wait.
    if (this.#full()) {
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
    const endsAt = Date.now() + deadlineMs;
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
      return await this.#cutShort(host, guard, endsAt, error);
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
    endsAt: number,
    error?: unknown
  ): Promise<Ending> {
    const first = guard.reason();
    if (first !== undefined && first !== "unreadable") {
      return { kind: first };
    }
    // Unreadable, the process still runs as far as anyone can tell: no
    // longer a wait for it to go than the least. Otherwise its bounds still
    // hold while it may go: its caller leaving, its memory, its deadline.
    await waitForExit(
      host,
      first === "unreadable" ? minExitWaitMs : exitWaitMs(endsAt),
      first === undefined ? guard.signal : undefined
    );
    const reason = guard.reason();
    if (reason !== undefined && reason !== "unreadable") {
      return { kind: reason };
    }
    if (host.gone && !this.#stopping) {
      return { kind: deathOf(host.child) };
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
    {
      deadlineMs,
      cpuLimitMs,
      memoryLimitBytes = this.#settings.memoryLimitBytes,
    }: { deadlineMs: number; cpuLimitMs?: number; memoryLimitBytes?: number },
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
    void this.#watchUsage(
      host,
      run.signal,
      { cpuLimitMs, memoryLimitBytes },
      (why, detail) => {
        unreadable = detail;
        end(why);
      }
    );
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
    {
      cpuLimitMs,
      memoryLimitBytes,
    }: { cpuLimitMs: number | undefined; memoryLimitBytes: number },
    over: (why: "memory" | "cpu" | "unreadable", detail: string) => void
  ): Promise<void> {
    const { memoryPollMs, usageProbe } = this.#settings;
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
      case "exited": {
        this.#counts.memory += 1;
        verdict("memory", endedMessage);
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
    if (this.#full()) {
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

    // A child of a session running now (an App function a Code Mode run
    // calls, which the run waits for): one at a time for each parent, on a
    // process past the pool's size, so it never waits for the process its
    // own parent holds. Only a top-level session may be a parent: a child's
    // child is refused, so the pool runs at most twice its size. A parent
    // that isn't running gives nothing.
    const parentOf = request.headers[parentHeader];
    if (typeof parentOf === "string" && this.#childIds.has(parentOf)) {
      refuse(400, "A child session can't be a parent.");
      return;
    }
    if (typeof parentOf === "string" && !this.#running.has(parentOf)) {
      refuse(409, "This session's parent has ended.");
      return;
    }
    const parent = typeof parentOf === "string" ? parentOf : undefined;
    // A child is tracked under its parent from now, through every wait of
    // its admission (its owner's place, its parent's child place, a
    // process): its parent ending stops it there (`#endChildOf`), and it
    // never takes the pool's own capacity after.
    const orphaned = new AbortController();
    const admissions =
      parent === undefined ? undefined : this.#admissionsOf(parent);
    admissions?.add(orphaned);
    try {
      await this.#admitted(request, client, head, {
        owner,
        callId,
        deadlineMs,
        cpuLimitMs,
        memoryLimitBytes: this.#memoryOf(request, owner, parent),
        waitMs,
        refuse,
        parent,
        orphaned: orphaned.signal,
      });
    } finally {
      admissions?.delete(orphaned);
      if (parent !== undefined && admissions?.size === 0) {
        this.#admissions.delete(parent);
      }
    }
  }

  /**
   * The resident memory a session may use: what it asks for in MiB
   * (`memoryHeader`), at most `maxMemoryLimitBytes`, for a top-level
   * session of a platform owner; `memoryLimitBytes` for any other, or when
   * it asks for nothing.
   */
  #memoryOf(
    request: IncomingMessage,
    owner: string,
    parent: string | undefined
  ): number {
    const { memoryLimitBytes, maxMemoryLimitBytes, platformOwners } =
      this.#settings;
    const mib = Number(request.headers[memoryHeader]);
    return parent === undefined &&
      platformOwners.includes(owner) &&
      Number.isInteger(mib) &&
      mib > 0
      ? Math.min(mib * MIB, maxMemoryLimitBytes)
      : memoryLimitBytes;
  }

  /** A session past its checks: its places, then its relay. */
  async #admitted(
    request: IncomingMessage,
    client: Socket,
    head: Buffer,
    {
      owner,
      callId,
      deadlineMs,
      cpuLimitMs,
      memoryLimitBytes,
      waitMs,
      refuse,
      parent,
      orphaned,
    }: {
      owner: string;
      callId: string;
      deadlineMs: number;
      cpuLimitMs: number;
      memoryLimitBytes: number;
      waitMs: number;
      refuse: (status: number, message: string) => void;
      parent: string | undefined;
      orphaned: AbortSignal;
    }
  ): Promise<void> {
    const settings = this.#settings;
    const subOwner = subOwnerOf(request);
    if (subOwner === null) {
      refuse(400, `A session's ${subOwnerHeader} names no sub-owner.`);
      return;
    }
    const parentEnded = (): boolean =>
      parent !== undefined && (orphaned.aborted || !this.#running.has(parent));
    // One owner holds at most its share of the pool, waiting or running: a
    // session past it waits, as for a process, then is refused. Its place
    // first, then its parent's child place.
    const ownerRoom = await this.#ownerRoom(
      owner,
      subOwner,
      waitMs,
      client,
      orphaned
    );
    if (!ownerRoom || parentEnded()) {
      if (ownerRoom) {
        this.#giveOwnerBack(owner, subOwner);
      }
      if (parentEnded()) {
        refuse(409, "This session's parent has ended.");
      } else {
        refuse(429, "This owner already holds as many sessions as it may.");
      }
      return;
    }
    // Given back once the session's process is gone, not as the session
    // ends for core: a process dying (a crash judged on its exit, a kill
    // still going through) holds its owner's place, so no owner holds more
    // processes than its share, however fast it starts its next call.
    let ownerHeld = true;
    const giveBack = (): void => {
      if (ownerHeld) {
        ownerHeld = false;
        this.#giveOwnerBack(owner, subOwner);
      }
    };
    if (
      parent !== undefined &&
      !(await this.#childRoom(parent, callId, waitMs, client, orphaned))
    ) {
      giveBack();
      if (parentEnded()) {
        refuse(409, "This session's parent has ended.");
      } else {
        refuse(429, "This session's parent already runs a child.");
      }
      return;
    }
    let childHeld = parent !== undefined;
    const letGoOfChild = (): void => {
      if (childHeld && parent !== undefined) {
        childHeld = false;
        this.#children.delete(parent);
        this.#childIds.delete(callId);
        this.#released.dispatchEvent(new Event("released"));
      }
    };
    // Counted as it waited, so never past: checked again all the same, as
    // nothing else may take its place meanwhile.
    if (this.#inFlight >= settings.processes + settings.maxWaiting) {
      giveBack();
      letGoOfChild();
      refuse(503, "The sandbox is full.");
      return;
    }
    this.#inFlight += 1;
    try {
      await this.#relay(request, client, head, {
        deadlineMs,
        cpuLimitMs,
        memoryLimitBytes,
        waitMs,
        callId,
        refuse,
        // A child keeps its place past the pool's size only while its
        // parent runs.
        reserved:
          parent === undefined ? undefined : () => this.#running.has(parent),
        orphaned: parent === undefined ? undefined : orphaned,
        ended: () => {
          letGoOfChild();
          this.#endChildOf(callId);
        },
      });
    } finally {
      this.#inFlight -= 1;
      giveBack();
      letGoOfChild();
      this.#endChildOf(callId);
    }
  }

  async #relay(
    request: IncomingMessage,
    client: Socket,
    head: Buffer,
    session: {
      deadlineMs: number;
      cpuLimitMs: number;
      memoryLimitBytes: number;
      waitMs: number;
      callId: string;
      refuse: (status: number, message: string) => void;
      /** For a parent's child: whether it may take a process past the pool's size now. */
      reserved: (() => boolean) | undefined;
      /** For a parent's child: aborts as its parent ends, refusing it. */
      orphaned: AbortSignal | undefined;
      /** Called once the session is over for core. */
      ended: () => void;
    }
  ): Promise<void> {
    const {
      deadlineMs,
      cpuLimitMs,
      memoryLimitBytes,
      waitMs,
      callId,
      refuse,
      reserved,
      orphaned,
      ended,
    } = session;
    // Gone: core closed its end, done or giving up.
    const caller = new AbortController();
    client.on("close", () => {
      caller.abort();
    });
    // Gone before it was listened for: its close came and went.
    if (client.destroyed) {
      caller.abort();
    }
    client.on("error", ignore);
    const host = await this.#acquire(
      AbortSignal.any([
        caller.signal,
        AbortSignal.timeout(waitMs),
        ...(orphaned === undefined ? [] : [orphaned]),
      ]),
      reserved
    );
    if (host === undefined) {
      if (orphaned?.aborted === true) {
        refuse(409, "This session's parent has ended.");
      } else if (!caller.signal.aborted) {
        refuse(503, "No sandbox process came free in time.");
      }
      return;
    }
    if (caller.signal.aborted || orphaned?.aborted === true) {
      this.#busy -= 1;
      this.#release(host);
      if (orphaned?.aborted === true) {
        refuse(409, "This session's parent has ended.");
      }
      return;
    }
    this.#topUp();
    // Core says when a session is over (`POST /end/<id>`): closing its end
    // of the socket alone may not reach here, as the close handshake waits
    // on the sandbox host. Core ends one it gave up on (`POST /cancel/<id>`)
    // as abandoned. The guard watches only the bounds.
    const cancelled = new AbortController();
    const finished = new AbortController();
    // Set once the session's end is seen, until its verdict is kept.
    let ending = false;
    this.#running.set(callId, {
      cancel: () => {
        cancelled.abort();
      },
      finish: () => {
        finished.abort();
      },
      ending: () => ending || host.gone,
    });
    const endsAt = Date.now() + deadlineMs;
    const guard = this.#guard(
      host,
      { deadlineMs, cpuLimitMs, memoryLimitBytes },
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
      // Core may leave while the host answers: then nothing waits for it.
      const answered = await answerHead(
        upstream,
        AbortSignal.any([guard.signal, caller.signal])
      );
      if (caller.signal.aborted && !guard.signal.aborted) {
        return;
      }
      if (answered === undefined) {
        throw new Error("The sandbox process didn't answer the session.");
      }
      client.write(withHeader(answered.head, cpuHeader, String(cpuLimitMs)));
      client.write(answered.rest);
      // Neither end is closed for the other: core's end stays open until
      // the session's verdict is kept, so core finds it when it asks.
      // Core's close frame, or its end of the connection shut for writing
      // (as workerd does when it closes a socket the host never answered),
      // ends the session as core done with it, if its `POST /end/<id>`
      // never comes; the host needn't answer either.
      const coreDone = (): void => {
        finished.abort();
      };
      client.on("data", closeFrameWatcher(coreDone));
      client.once("end", coreDone);
      if (client.readableEnded) {
        coreDone();
      }
      client.pipe(upstream, { end: false });
      upstream.pipe(client, { end: false });
      // A signal aborted already settles this at once: its event has fired.
      await Promise.race([
        closeOf(upstream),
        abortOf(guard.signal),
        abortOf(caller.signal),
        abortOf(finished.signal),
      ]);
      ending = true;
      // Over for core, whatever its process does now: its parent's child
      // place comes back at once, not after the wait for a dying process
      // to go, which only its verdict needs. Its owner's place comes back
      // once the process is gone.
      ended();
      const endedAs = guard.signal.aborted
        ? await this.#cutShort(host, guard, endsAt)
        : await this.#sessionEnded(
            host,
            AbortSignal.any([caller.signal, finished.signal]),
            endsAt
          );
      this.#judge(host, callId, endedAs, { deadlineMs, memoryLimitBytes });
    } finally {
      this.#running.delete(callId);
      guard.stop();
      upstream.destroy();
      client.destroy();
      ended();
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
  async #sessionEnded(
    host: HostProcess,
    caller: AbortSignal,
    endsAt: number
  ): Promise<Ending> {
    if (caller.aborted) {
      // Core closed it: the call is over, however it went.
      return { kind: "answered", status: 101, body: Buffer.alloc(0) };
    }
    // The host closes a session itself only as its process dies, mostly:
    // a process slow to go is still the crash it is (`exitWaitMs`).
    await waitForExit(host, exitWaitMs(endsAt));
    if (host.gone && !this.#stopping) {
      return { kind: deathOf(host.child) };
    }
    return { kind: "answered", status: 101, body: Buffer.alloc(0) };
  }

  /** Records how a session ended: a verdict when the App is to blame. */
  #judge(
    host: HostProcess,
    callId: string,
    ending: Ending,
    {
      deadlineMs,
      memoryLimitBytes,
    }: { deadlineMs: number; memoryLimitBytes: number }
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
          `The App's code used more than ${Math.round(memoryLimitBytes / MIB)} MiB of memory.`
        );
        return;
      }
      case "exited": {
        this.#counts.memory += 1;
        blame("memory", endedMessage);
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

  /**
   * Whether the pool takes no more calls or sessions: those running and
   * waiting for a process, and the sessions waiting for their owner's room,
   * which hold a connection each just the same.
   */
  #full(): boolean {
    const { processes, maxWaiting } = this.#settings;
    return (
      this.#inFlight + this.#waitingForOwners + this.#childWaiting.size >=
      processes + maxWaiting
    );
  }

  /**
   * Takes a place for one more session of `owner` (and of its `subOwner`,
   * if it names one), waiting up to `waitMs` (or until the caller leaves)
   * for one of its sessions to end; false if none comes. At most as many
   * of an owner's sessions wait as it may hold: one past that is refused
   * at once. A sub-owner holds at most `maxPerSubOwner` of its owner's
   * places, and has at most as many sessions waiting: one App's builds
   * never take the whole builder's share, nor its whole waiting room, so
   * another App's build finds a place or a turn to wait for one.
   */
  async #ownerRoom(
    owner: string,
    subOwner: string | undefined,
    waitMs: number,
    client: Socket,
    stop?: AbortSignal
  ): Promise<boolean> {
    const sub = subOwner === undefined ? undefined : placeOf(owner, subOwner);
    const hasRoom = (): boolean =>
      (this.#owners.get(owner) ?? 0) < this.#maxPerOwner &&
      (sub === undefined ||
        (this.#subOwners.get(sub) ?? 0) < this.#maxPerSubOwner);
    if (!hasRoom()) {
      const waiters = this.#ownerWaiters.get(owner) ?? 0;
      const subWaiters =
        sub === undefined ? 0 : (this.#subOwnerWaiters.get(sub) ?? 0);
      if (
        waiters >= this.#maxPerOwner ||
        (sub !== undefined && subWaiters >= this.#maxPerSubOwner)
      ) {
        return false;
      }
      this.#ownerWaiters.set(owner, waiters + 1);
      if (sub !== undefined) {
        this.#subOwnerWaiters.set(sub, subWaiters + 1);
      }
      this.#waitingForOwners += 1;
      const gone = new AbortController();
      const leave = (): void => {
        gone.abort();
      };
      client.once("close", leave);
      const signal = AbortSignal.any([
        gone.signal,
        AbortSignal.timeout(waitMs),
        ...(stop === undefined ? [] : [stop]),
      ]);
      try {
        while (!hasRoom()) {
          // oxlint-disable-next-line no-await-in-loop -- until one of its sessions ends
          await once(this.#released, "released", { signal });
        }
      } catch {
        return false;
      } finally {
        client.off("close", leave);
        this.#waitingForOwners -= 1;
        countDown(this.#ownerWaiters, owner);
        if (sub !== undefined) {
          countDown(this.#subOwnerWaiters, sub);
        }
      }
    }
    // Taken at once, in the same turn as the check: two waiters woken by
    // one session's end never both take its place.
    this.#owners.set(owner, (this.#owners.get(owner) ?? 0) + 1);
    if (sub !== undefined) {
      this.#subOwners.set(sub, (this.#subOwners.get(sub) ?? 0) + 1);
    }
    return true;
  }

  /**
   * Takes `parent`'s one child place for `child`, waiting up to `waitMs`
   * (or until the caller leaves) for its child running now to end; false
   * if it doesn't, or if another of its children waits already: at most
   * one waits, counted as the pool takes it (`#full`).
   */
  async #childRoom(
    parent: string,
    child: string,
    waitMs: number,
    client: Socket,
    stop: AbortSignal
  ): Promise<boolean> {
    if (this.#children.has(parent)) {
      if (this.#childWaiting.has(parent)) {
        return false;
      }
      this.#childWaiting.add(parent);
      const gone = new AbortController();
      const leave = (): void => {
        gone.abort();
      };
      client.once("close", leave);
      const signal = AbortSignal.any([
        gone.signal,
        AbortSignal.timeout(waitMs),
        stop,
      ]);
      try {
        while (this.#children.has(parent)) {
          // oxlint-disable-next-line no-await-in-loop -- until its child ends
          await once(this.#released, "released", { signal });
        }
      } catch {
        return false;
      } finally {
        client.off("close", leave);
        this.#childWaiting.delete(parent);
      }
      // Its parent ended while it waited: it's no child of anything now.
      if (stop.aborted || !this.#running.has(parent)) {
        return false;
      }
    }
    // Taken in the same turn as the check, as an owner's place is.
    this.#children.set(parent, child);
    this.#childIds.add(child);
    return true;
  }

  /**
   * Ends every child of `parent` as it ends: the one it runs, cancelled,
   * and any still being admitted, refused wherever they wait.
   */
  #endChildOf(parent: string): void {
    for (const orphaned of this.#admissions.get(parent) ?? []) {
      orphaned.abort();
    }
    const child = this.#children.get(parent);
    if (child !== undefined) {
      // Not the App's fault, nor given up on by core: the call it was made
      // in has ended, which is what core hears of it.
      this.#keepVerdict(child, {
        verdict: "ended",
        message: "The call this function was called in has ended.",
        at: Date.now(),
      });
      this.cancel(child);
    }
  }

  /** The children `parent` is admitting, each as how to refuse it. */
  #admissionsOf(parent: string): Set<AbortController> {
    let admitting = this.#admissions.get(parent);
    if (admitting === undefined) {
      admitting = new Set();
      this.#admissions.set(parent, admitting);
    }
    return admitting;
  }

  /** Gives one of `owner`'s places back, for a session that ended or never ran. */
  #giveOwnerBack(owner: string, subOwner: string | undefined): void {
    countDown(this.#owners, owner);
    if (subOwner !== undefined) {
      countDown(this.#subOwners, placeOf(owner, subOwner));
    }
    this.#released.dispatchEvent(new Event("released"));
  }

  /** Ends session `callId` as its caller gave up on it; false if none runs. */
  cancel(callId: string): boolean {
    const running = this.#running.get(callId);
    running?.cancel();
    return running !== undefined;
  }

  /** Ends session `callId` as core is done with it; false if none runs. */
  finish(callId: string): boolean {
    const running = this.#running.get(callId);
    running?.finish();
    return running !== undefined;
  }

  /**
   * What `GET /verdict/<id>` answers for session `callId`: its verdict if
   * kept; else, while it runs, `state` `ending` once its end is seen but
   * not yet judged (a verdict may follow: core waits a moment only then)
   * or `running`; 404 for a session it doesn't know.
   */
  verdictAnswer(callId: string): {
    status: number;
    body: Record<string, unknown>;
  } {
    const kept = this.verdict(callId);
    if (kept !== undefined) {
      return {
        status: 200,
        body: { verdict: kept.verdict, message: kept.message },
      };
    }
    const running = this.#running.get(callId);
    if (running === undefined) {
      return { status: 404, body: { verdict: null } };
    }
    return {
      status: 200,
      body: { verdict: null, state: running.ending() ? "ending" : "running" },
    };
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
  async #acquire(
    signal: AbortSignal,
    reserved?: () => boolean
  ): Promise<HostProcess | undefined> {
    // Gone already: nothing to wait for, no process to take.
    if (signal.aborted) {
      return undefined;
    }
    // An idle process, while fewer calls run than the pool's size; for a
    // child, past it: each running parent has at most one, so the pool
    // never runs more than twice its size.
    const take = (): HostProcess | undefined =>
      reserved?.() === true || this.#busy < this.#settings.processes
        ? this.#idle.shift()
        : undefined;
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

/** Where core says a session is over: `/cancel/<id>` or `/end/<id>`. */
const sessionEnding = /^\/(?<how>cancel|end)\/(?<id>[^/]+)$/u;

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
    const { status, body } = pool.verdictAnswer(verdictOf);
    send(response, status, JSON.stringify(body));
    return;
  }
  // Core gave up on a session (`cancel`), or is done with it (`end`).
  const ending = sessionEnding.exec(pathname)?.groups;
  if (ending?.id !== undefined && request.method === "POST") {
    const found =
      ending.how === "cancel" ? pool.cancel(ending.id) : pool.finish(ending.id);
    send(response, found ? 200 : 404, "{}");
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

/** How long a connection idle between requests is kept: about a second. */
const KEEP_ALIVE_MS = 1000;

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
  // A sub-owner's share is at least one place and at most its owner's.
  const ownerShare = settings.maxPerOwner ?? Math.ceil(settings.processes / 2);
  if (
    settings.maxPerSubOwner !== undefined &&
    (!Number.isInteger(settings.maxPerSubOwner) ||
      settings.maxPerSubOwner < 1 ||
      settings.maxPerSubOwner > ownerShare)
  ) {
    throw new Error(
      `The sandbox's maxPerSubOwner must be a whole number from 1 to its maxPerOwner, not ${String(settings.maxPerSubOwner)}.`
    );
  }
  // A bound that isn't a positive number (NaN, say) would bound nothing.
  for (const name of [
    "memoryLimitBytes",
    "maxMemoryLimitBytes",
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
  // A session that asks for more never gets less than App code does.
  settings.maxMemoryLimitBytes = Math.max(
    settings.maxMemoryLimitBytes,
    settings.memoryLimitBytes
  );
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
  // What may hold a connection at once, with C = processes + maxWaiting:
  // - calls and sessions, running or waiting for a process, their owner's
  //   room or their parent's child place: at most C (`#full`), one
  //   connection each;
  // - core's word on each of them: one `/end`, `/cancel` or `/verdict` (the
  //   last after a kill, once the session's own is gone) at a time, as
  //   core asks one after the other for a call: at most C more;
  // - refusals on their way out, closed as written, and connections idle
  //   between requests, closed after `keepAliveTimeout`: a burst of up to C
  //   more within that second;
  // - `/health` and slack: 8.
  // The control endpoints then always find room. A lost `/end` costs
  // nothing either: core's close frame ends the session as well.
  server.maxConnections = 3 * (settings.processes + settings.maxWaiting) + 8;
  server.keepAliveTimeout = KEEP_ALIVE_MS;
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
  // Only these options, refused otherwise by name: its workerd command line
  // is fixed, so nothing (`--verbose` included, which makes workerd print
  // an isolate's uncaught errors) brings an isolate's output to its logs.
  let parsed;
  try {
    parsed = parseArgs({
      strict: true,
      allowPositionals: false,
      options: {
        workerd: { type: "string", default: nativeWorkerd },
        parent: { type: "string" },
        processes: { type: "string" },
      },
    });
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: "sandbox.failed_to_start",
        error: `${String(error)} The supervisor takes only --workerd, --parent and --processes: its workerd command line is fixed.`,
      })}\n`
    );
    process.exit(1);
  }
  const { values } = parsed;
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
